import type { ManagedRoutingEvidence } from "../../src/routing/launch-authorization.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	assert,
	beforeEach,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import { canonicalPolicyDocument, type PolicyDocument, writeCanonicalPolicy } from "../support/routing-policy.ts";

const EVIDENCE: ManagedRoutingEvidence = Object.freeze({
	status: "managed",
	generation: "test-generation-v1",
	agent: "pilot-worker",
	role: "worker",
	state: "selective",
	capabilityClass: "implementation",
	interactionMode: "background",
	pilotCase: null,
	route: Object.freeze({ provider: "openai-codex", model: "gpt-6-sol", effort: "medium" }),
	extensions: Object.freeze(["subagent-completion", "workspace-boundary", "drover-model-routing"]),
	skills: Object.freeze([]),
	projectResources: false,
	spawning: false,
	tools: null,
});

function usePolicy(edit: (policy: PolicyDocument) => void = () => {}): void {
	const document = canonicalPolicyDocument();
	edit(document);
	process.env.PI_CODING_AGENT_DIR = writeCanonicalPolicy(document);
}

function sessionIn(dir: string): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

/** A fake `pi` that records that it ran; the gate must stop requests before it. */
function capturePi(dir: string): string {
	const marker = join(dir, "pi-ran");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\ntouch '${marker}'\ncat >/dev/null\n`);
	return marker;
}

function managedRunning(dir: string, sessionFile: string): RunningSubagent {
	return {
		id: "managed-child",
		name: "slice-worker",
		task: "Implement the slice",
		agent: "pilot-worker",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: true,
		noSession: true,
		startTime: Date.now() - 8_000,
		sessionFile,
		timeoutBudget: { timeoutSeconds: 10 },
		timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
		modelRef: "openai-codex/gpt-6-sol:medium",
		routing: EVIDENCE,
		launchMetadata: {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "slice-worker",
			agent: "pilot-worker",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			modelRef: "openai-codex/gpt-6-sol:medium",
			denyTools: [],
			noContextFiles: true,
			noSession: true,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
		},
	};
}

describe("parent-authorized requests to managed children", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		usePolicy();
	});

	it("refuses to resume a managed child until authority-preserving resume exists", async () => {
		const dir = createTestDir();
		const marker = capturePi(dir);
		const sessionFile = sessionIn(dir);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "slice-worker",
			agent: "pilot-worker",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			denyTools: [],
			noContextFiles: true,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		await assert.rejects(
			() =>
				resumeSubagentSession({ sessionFile, task: "Continue." }, {
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					runningSubagents: new Map(),
				} as never),
			/pilot-worker is policy-managed.*cannot be resumed/,
		);
		assert.equal(existsSync(marker), false);
	});

	it("blocks a timeout wrap-up request after the policy generation changed", async () => {
		usePolicy((policy) => {
			policy.generation = "test-generation-v2";
		});
		const dir = createTestDir();
		const marker = capturePi(dir);

		await assert.rejects(
			() => restartSubagentForTimeoutWrapUp(managedRunning(dir, sessionIn(dir)), { getShellReadyDelayMs: () => 0 }),
			/Routing policy blocked the request.*generation/,
		);
		assert.equal(existsSync(marker), false);
	});

	it("blocks a timeout wrap-up request after the role's route or state changed", async () => {
		for (const edit of [
			(policy: PolicyDocument) => {
				policy.roles.worker.routes.implementation.model = "gpt-5.6-terra";
			},
			(policy: PolicyDocument) => {
				policy.roles.worker.state = "disabled";
			},
		]) {
			usePolicy(edit);
			const dir = createTestDir();
			const marker = capturePi(dir);

			await assert.rejects(
				() => restartSubagentForTimeoutWrapUp(managedRunning(dir, sessionIn(dir)), { getShellReadyDelayMs: () => 0 }),
				/Routing policy blocked the request/,
			);
			assert.equal(existsSync(marker), false);
		}
	});

	it("blocks a timeout wrap-up request after the role's grants or interaction modes changed", async () => {
		for (const edit of [
			(policy: PolicyDocument) => {
				policy.resourceGrants["isolated-child"].projectResources = true;
			},
			(policy: PolicyDocument) => {
				policy.roles.worker.allowedInteractionModes = ["synchronous"];
			},
		]) {
			usePolicy(edit);
			const dir = createTestDir();
			const marker = capturePi(dir);

			await assert.rejects(
				() => restartSubagentForTimeoutWrapUp(managedRunning(dir, sessionIn(dir)), { getShellReadyDelayMs: () => 0 }),
				/Routing policy blocked the request/,
			);
			assert.equal(existsSync(marker), false);
		}
	});

	it("blocks a timeout wrap-up request after the pilot case expired", async () => {
		usePolicy((policy) => {
			policy.pilotCases["scout-literal-1"].expires = "2000-01-01T00:00:00Z";
		});
		const dir = createTestDir();
		const marker = capturePi(dir);
		const running = managedRunning(dir, sessionIn(dir));
		running.routing = Object.freeze({
			...EVIDENCE,
			agent: "pilot-scout",
			role: "scout",
			state: "pilot",
			capabilityClass: "literal",
			pilotCase: "scout-literal-1",
			route: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-luna", effort: "low" }),
		});

		await assert.rejects(
			() => restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }),
			/Routing policy blocked the request.*expired/,
		);
		assert.equal(existsSync(marker), false);
	});

	it("lets a timeout wrap-up request through for a managed child with a tool allowlist", async () => {
		const dir = createTestDir();
		const running = managedRunning(dir, sessionIn(dir));
		running.routing = Object.freeze({ ...EVIDENCE, tools: "read,grep" });
		capturePi(dir);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });

		assert.ok(running.childProcess);
	});

	it("lets a timeout wrap-up request through while the launch authority still holds", async () => {
		const dir = createTestDir();
		const running = managedRunning(dir, sessionIn(dir));
		capturePi(dir);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });

		assert.ok(running.childProcess);
	});
});
