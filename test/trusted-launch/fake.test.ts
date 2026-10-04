import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import type { SubagentToolRuntime } from "../../src/tools/subagent-launch.ts";
import { createFakeTrustedSubagents } from "../../src/trusted-launch/fake.ts";
import { createTrustedLauncher } from "../../src/trusted-launch/launcher.ts";
import { publishTrustedSubagents } from "../../src/trusted-launch/registry.ts";
import {
	resolveTrustedSubagents,
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedSubagentsDescriptor,
} from "../../src/trusted-launch/public.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import { assert, createTestDir } from "../support/index.ts";
import { emptyAgentDir } from "../support/routing-policy.ts";

const disposers: (() => void)[] = [];

/** Earlier suites start extension sessions that publish a descriptor. */
function clearRegistrySlot() {
	delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
}

function realDescriptor(): TrustedSubagentsDescriptor {
	process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
	resetSpawnWidthForTest();
	let count = 0;
	const launch = async (params: SubagentParamsInput): Promise<RunningSubagent> => ({
		id: `child-${++count}`,
		name: params.name,
		task: params.task,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: `/sessions/child-${count}.jsonl`,
		launchMetadata: { cwd: params.forcedCwd } as RunningSubagent["launchMetadata"],
	});
	const runtime = {
		loadAgentDefaults: (agent: string | undefined) => (agent === "worker" ? { mode: "background" } : null),
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: () => new Promise<SubagentResult>(() => {}),
		getWatcherSignal: (_running: RunningSubagent, controller: AbortController) => controller.signal,
		wireSubagentSteerBack() {},
		startWidgetRefresh() {},
	} as unknown as SubagentToolRuntime;
	const publication = publishTrustedSubagents(
		createTrustedLauncher({
			pi: { getThinkingLevel: () => "medium" } as never,
			runtime,
			ctx: { hasUI: false, cwd: createTestDir(), sessionManager: {} } as never,
			forceSynchronous: () => false,
		}),
	);
	disposers.push(() => publication.dispose());
	return publication.descriptor;
}

function fakeDescriptor(): TrustedSubagentsDescriptor {
	const fake = createFakeTrustedSubagents({ agents: { worker: "background" } });
	disposers.push(() => fake.dispose());
	return fake.descriptor;
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_01",
		agent: "worker",
		name: "trusted-worker",
		title: "Trusted worker",
		task: "Work",
		effectiveCwd: realpathSync(createTestDir()),
		mode: "background",
		...overrides,
	};
}

for (const [label, create] of [
	["the real descriptor", realDescriptor],
	["the package fake", fakeDescriptor],
] as const) {
	describe(`trusted launch contract: ${label}`, () => {
		beforeEach(clearRegistrySlot);
		afterEach(() => {
			for (const dispose of disposers.splice(0)) dispose();
		});

		it("is resolvable by version and launches into the requested directory", async () => {
			const descriptor = create();
			const resolved = resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION);
			assert.equal(resolved.status === "ok" && resolved.descriptor, descriptor);
			const req = request();
			const result = await descriptor.launch(req);
			assert.equal(result.outcome, "launched");
			if (result.outcome !== "launched") return;
			assert.equal(result.requestId, "op_01");
			assert.equal(result.mode, "background");
			assert.equal(result.effectiveCwd, req.effectiveCwd);
			assert.equal(typeof result.runId, "string");
			assert.equal(typeof result.sessionFile, "string");
		});

		it("refuses invalid requests, unknown agents, and mode mismatches before any child", async () => {
			const descriptor = create();
			const outcomes = await Promise.all([
				descriptor.launch(request({ requestVersion: "pi-subagents.trusted-launch/v9" })),
				descriptor.launch(request({ effectiveCwd: "relative" })),
				descriptor.launch(request({ forcedCwd: "/tmp" })),
				descriptor.launch(request({ agent: "nobody" })),
				descriptor.launch(request({ mode: "interactive" })),
			]);
			assert.deepEqual(
				outcomes.map((outcome) => (outcome.outcome === "not_started" ? outcome.reason : outcome.outcome)),
				["unsupported_version", "effective_cwd_invalid", "invalid_request", "agent_not_found", "mode_mismatch"],
			);
		});

		it("cannot launch after disposal", async () => {
			const descriptor = create();
			for (const dispose of disposers.splice(0)) dispose();
			const result = await descriptor.launch(request());
			assert.equal(result.outcome === "not_started" && result.reason, "descriptor_disposed");
			assert.deepEqual(resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION), { status: "missing" });
		});
	});
}

describe("package fake scripting", () => {
	beforeEach(clearRegistrySlot);
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});

	it("records validated requests and returns scripted outcomes", async () => {
		const fake = createFakeTrustedSubagents({
			agents: { worker: "interactive" },
			respond: (req, index) =>
				index === 0
					? { outcome: "unknown", reason: "scripted", message: `lost ${req.requestId}` }
					: { outcome: "not_started", reason: "spawn_width", message: "busy" },
		});
		disposers.push(() => fake.dispose());

		const first = await fake.descriptor.launch(request({ mode: "interactive" }));
		const second = await fake.descriptor.launch(request({ requestId: "op_02", mode: "interactive" }));

		assert.deepEqual(first, { outcome: "unknown", reason: "scripted", message: "lost op_01" });
		assert.equal(second.outcome === "not_started" && second.reason, "spawn_width");
		assert.deepEqual(
			fake.requests.map((req) => req.requestId),
			["op_01", "op_02"],
		);
	});

	it("gives interactive launches a deterministic surface", async () => {
		const fake = createFakeTrustedSubagents({ agents: { worker: "interactive" } });
		disposers.push(() => fake.dispose());
		const req = request({ mode: "interactive" });
		assert.deepEqual(await fake.descriptor.launch(req), {
			outcome: "launched",
			requestId: "op_01",
			runId: "fake-run-1",
			sessionFile: "/fake-pi-subagents/sessions/fake-run-1.jsonl",
			mode: "interactive",
			surfaceId: "fake-surface-1",
			effectiveCwd: req.effectiveCwd,
		});
	});
});

describe("package entrypoints", () => {
	it("a linked downstream install imports the seam and the fake by package subpath", () => {
		const consumer = createTestDir();
		mkdirSync(join(consumer, "node_modules"));
		symlinkSync(process.cwd(), join(consumer, "node_modules", "pi-subagents"));
		const script = [
			'const seam = await import("pi-subagents/trusted-launch");',
			'const fake = await import("pi-subagents/trusted-launch/fake");',
			"console.log(JSON.stringify([seam.TRUSTED_LAUNCH_VERSION, typeof seam.resolveTrustedSubagents, typeof seam.publishTrustedSubagents, typeof fake.createFakeTrustedSubagents]));",
		].join("\n");
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" });
		assert.deepEqual(JSON.parse(output), [TRUSTED_LAUNCH_VERSION, "function", "undefined", "function"]);
	});
});
