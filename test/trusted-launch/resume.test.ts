import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import {
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedResumeResultV1,
} from "../../src/trusted-launch/public.ts";
import { publishTrustedSubagents, type TrustedSubagentsPublication } from "../../src/trusted-launch/registry.ts";
import { createTrustedResumer, type TrustedResumeRuntime } from "../../src/trusted-launch/resumer.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, writeExecutable } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { emptyAgentDir } from "../support/routing-policy.ts";
import { type TrustedSessionFixture, trustedSessionFixture } from "../support/trusted-sessions.ts";

const publications: TrustedSubagentsPublication[] = [];

function harness(options: { forceSynchronous?: boolean; onWire?: () => void } = {}) {
	const dir = createTestDir();
	const capture = join(dir, "child-cwd.txt");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
		dir,
		"fake-pi",
		`#!/bin/sh\npwd > ${JSON.stringify(capture)}\ncat > /dev/null\n`,
	);
	process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
	resetSpawnWidthForTest();
	const wired: RunningSubagent[] = [];
	const stopped: RunningSubagent[] = [];
	const result = { name: "", task: "", summary: "", exitCode: 0, elapsed: 0 };
	const runtime: TrustedResumeRuntime = {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: async () => result,
		watchSubagent: async () => result,
		getWatcherSignal: (_running, controller) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map(),
		wireSubagentSteerBack: (_pi, running) => {
			wired.push(running);
			options.onWire?.();
		},
		stopRunningSubagent: async (running) => {
			stopped.push(running);
		},
	};
	const publication = publishTrustedSubagents({
		launch: async () => {
			throw new Error("launch is not under test");
		},
		resume: createTrustedResumer({
			pi: {} as never,
			runtime,
			forceSynchronous: () => options.forceSynchronous ?? false,
		}),
	});
	publications.push(publication);
	return { publication, descriptor: publication.descriptor, capture, wired, stopped, runtime };
}

function resumeRequest(fixture: TrustedSessionFixture, overrides: Record<string, unknown> = {}) {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_resume_01",
		sessionFile: fixture.sessionFile,
		effectiveCwd: fixture.cwd,
		launchRequestId: fixture.provenance.requestId,
		task: "Continue the work",
		...overrides,
	};
}

function assertNotStarted(result: TrustedResumeResultV1, reason: string): void {
	assert.equal(result.outcome, "not_started", JSON.stringify(result));
	assert.equal(result.outcome === "not_started" && result.reason, reason, JSON.stringify(result));
}

async function assertNoChild(h: ReturnType<typeof harness>): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(existsSync(h.capture), false, "no child process may start");
	assert.equal(h.runtime.runningSubagents.size, 0);
	assert.equal(h.wired.length, 0);
}

async function readEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(path) && readFileSync(path, "utf8")) return readFileSync(path, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

describe("trusted resume through the descriptor", () => {
	const clear = () => {
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	};
	beforeEach(clear);
	afterEach(() => {
		for (const publication of publications.splice(0)) publication.dispose();
		clear();
	});

	it("resumes after a restart from the persisted directory and keeps the original launch identity", async () => {
		// The session was launched by a descriptor generation that no longer exists.
		const fixture = trustedSessionFixture({ generation: "generation-before-restart" });
		const h = harness();
		assert.notEqual(h.descriptor.generation, "generation-before-restart");
		const result = await h.descriptor.resume(resumeRequest(fixture));
		assert.equal(result.outcome, "resumed", JSON.stringify(result));
		if (result.outcome !== "resumed") return;
		assert.equal(result.requestId, "op_resume_01");
		assert.equal(result.sessionFile, fixture.sessionFile);
		assert.equal(result.mode, "background");
		assert.equal(result.effectiveCwd, fixture.cwd);
		assert.deepEqual(result.launch, fixture.provenance);
		assert.equal(Object.isFrozen(result.launch), true);
		assert.equal(Object.isFrozen(result.launch.labels), true);
		assert.notEqual(result.launch, h.wired[0]?.launchMetadata?.trustedLaunch, "the result must not expose live state");
		assert.equal(result.runId, h.wired[0]?.id);
		assert.equal((await readEventually(h.capture)).trim(), fixture.cwd);
	});

	it("a disposed descriptor refuses to resume", async () => {
		const fixture = trustedSessionFixture();
		const h = harness();
		h.publication.dispose();
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "descriptor_disposed");
		await assertNoChild(h);
	});

	it("a replaced descriptor refuses to resume", async () => {
		const fixture = trustedSessionFixture();
		const h = harness();
		(globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY] = { descriptor: {} };
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "descriptor_replaced");
		await assertNoChild(h);
	});

	it("refuses a session launched through an unsupported descriptor version", async () => {
		const fixture = trustedSessionFixture({ version: "pi-subagents.trusted-launch/v0" });
		const h = harness();
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "unsupported_provenance");
		await assertNoChild(h);
	});

	it("refuses a directory whose access was revoked", { skip: process.getuid?.() === 0 }, async () => {
		const fixture = trustedSessionFixture();
		const h = harness();
		chmodSync(fixture.cwd, 0o000);
		try {
			assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "effective_cwd_revoked");
		} finally {
			chmodSync(fixture.cwd, 0o755);
		}
		await assertNoChild(h);
	});

	it("refuses a mismatched directory without falling back to an ordinary resume", async () => {
		const fixture = trustedSessionFixture();
		const h = harness();
		assertNotStarted(
			await h.descriptor.resume(resumeRequest(fixture, { effectiveCwd: createTestDir() })),
			"effective_cwd_mismatch",
		);
		assertNotStarted(
			await h.descriptor.resume(resumeRequest(fixture, { launchRequestId: "op_other" })),
			"launch_request_mismatch",
		);
		await assertNoChild(h);
	});

	it("refuses a session no trusted extension launched", async () => {
		const fixture = trustedSessionFixture({ trusted: false });
		const h = harness();
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "not_trusted");
		await assertNoChild(h);
	});

	it("reports a resume the service refuses before any child as not started", async () => {
		const fixture = trustedSessionFixture();
		const h = harness();
		h.runtime.runningSubagents.set("already", { name: "task-worker", sessionFile: fixture.sessionFile } as RunningSubagent);
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "resume_denied");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(h.capture), false);
		assert.equal(h.wired.length, 0);
	});

	it("refuses a resume the session would have to await", async () => {
		const fixture = trustedSessionFixture();
		const h = harness({ forceSynchronous: true });
		assertNotStarted(await h.descriptor.resume(resumeRequest(fixture)), "synchronous_launch");
		await assertNoChild(h);
	});

	const invalid: [string, Record<string, unknown>, string][] = [
		["an unknown request version", { requestVersion: "pi-subagents.trusted-launch/v0" }, "unsupported_version"],
		["a model override", { model: "provider/model" }, "invalid_request"],
		["a mode override", { mode: "interactive" }, "invalid_request"],
		["a relative session file", { sessionFile: "child.jsonl" }, "invalid_request"],
		["a missing launch request id", { launchRequestId: undefined }, "invalid_request"],
		["a malformed request id", { requestId: "op 01" }, "invalid_request"],
		["an empty task", { task: "" }, "invalid_request"],
	];
	for (const [label, overrides, reason] of invalid) {
		it(`rejects ${label}`, async () => {
			const fixture = trustedSessionFixture();
			const h = harness();
			const request: Record<string, unknown> = resumeRequest(fixture, overrides);
			for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete request[key];
			assertNotStarted(await h.descriptor.resume(request), reason);
			await assertNoChild(h);
		});
	}

	it("stops a child resumed after its descriptor was retired and reports it unknown", async () => {
		const fixture = trustedSessionFixture();
		let publication: TrustedSubagentsPublication | undefined;
		const h = harness({ onWire: () => publication?.dispose() });
		publication = h.publication;
		const result = await h.descriptor.resume(resumeRequest(fixture));
		assert.equal(result.outcome, "unknown", JSON.stringify(result));
		assert.equal(h.stopped.length, 1);
		assert.equal(result.outcome === "unknown" && result.partial?.sessionFile, fixture.sessionFile);
	});
});
