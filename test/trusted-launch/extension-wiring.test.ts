import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resetSubagentBatchStopRequest, runningSubagents } from "../../src/runtime/state.ts";
import {
	resolveTrustedSubagents,
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedSubagentsDescriptor,
} from "../../src/trusted-launch/public.ts";
import { probeProcessGroup } from "../../src/trusted-launch/terminator.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	clearIsolatedSubagentEnv,
	createTestDir,
	describe,
	it,
	join,
	requestSubagentBatchStopForTest,
	subagentsExtension,
} from "../support/index.ts";
import { trustedSessionFixture } from "../support/trusted-sessions.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function loadExtension() {
	const root = createTestDir();
	const agentDir = join(root, "agent-root");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\n\nWork.");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const session = SessionManager.inMemory(root);
	const handlers = new Map<string, Handler[]>();
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		appendEntry() {},
		getActiveTools: () => [],
		setActiveTools() {},
		getAllTools: () => [],
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getThinkingLevel: () => "medium",
	};
	const context = {
		cwd: root,
		mode: "print" as const,
		hasUI: false,
		ui: { notify() {}, setWidget() {} },
		sessionManager: session,
		modelRegistry: { getAvailable: () => [] },
		model: undefined,
		// SAFETY: only the lifecycle handlers below run against this fixture.
	} as unknown as ExtensionContext;
	subagentsExtension(api as unknown as ExtensionAPI);
	const fire = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, context);
	};
	return { fire };
}

function current(): TrustedSubagentsDescriptor | undefined {
	const resolved = resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION);
	return resolved.status === "ok" ? resolved.descriptor : undefined;
}

function launchRequest() {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_01",
		agent: "worker",
		name: "trusted-worker",
		title: "Trusted worker",
		task: "Work",
		effectiveCwd: realpathSync(createTestDir()),
		mode: "background",
	};
}

describe("trusted launch descriptor lifecycle", () => {
	// Earlier suites start extension sessions that publish a descriptor.
	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	});
	afterEach(() => {
		clearIsolatedSubagentEnv();
		resetSubagentBatchStopRequest();
		delete process.env.PI_DENY_TOOLS;
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	});

	it("publishes at session start and retracts on a real shutdown", async () => {
		const extension = loadExtension();
		assert.equal(current(), undefined);

		await extension.fire("session_start", { reason: "startup" });
		const descriptor = current();
		assert.ok(descriptor);
		assert.equal(descriptor.isLive(), true);

		await extension.fire("session_shutdown", { reason: "quit" });
		assert.equal(current(), undefined);
		assert.equal(descriptor.isLive(), false);
		const result = await descriptor.launch(launchRequest());
		assert.equal(result.outcome === "not_started" && result.reason, "descriptor_disposed");
	});

	it("publishes a resume that refuses once the session retires the descriptor", async () => {
		const extension = loadExtension();
		await extension.fire("session_start", { reason: "startup" });
		const descriptor = current();
		assert.ok(descriptor);
		const fixture = trustedSessionFixture();
		const resume = {
			requestVersion: TRUSTED_LAUNCH_VERSION,
			requestId: "op_resume_01",
			sessionFile: fixture.sessionFile,
			effectiveCwd: createTestDir(),
			launchRequestId: fixture.provenance.requestId,
		};
		const live = await descriptor.resume(resume);
		assert.equal(live.outcome, "not_started");

		await extension.fire("session_shutdown", { reason: "quit" });
		const retired = await descriptor.resume(resume);
		assert.equal(retired.outcome === "not_started" && retired.reason, "descriptor_disposed");
	});

	it("publishes a terminate that stops only runs this session owns, through its own stop path", async () => {
		const extension = loadExtension();
		await extension.fire("session_start", { reason: "startup" });
		const descriptor = current();
		assert.ok(descriptor);
		const fixture = trustedSessionFixture();
		// One process, so its exit is its whole group's end.
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		const running: RunningSubagent = {
			id: "run-wired",
			name: "task-worker",
			task: "Work",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile: fixture.sessionFile,
			childProcess: child,
			completionPromise: new Promise((resolve) =>
				child.once("exit", (code) => resolve({ name: "task-worker", task: "Work", summary: "", exitCode: code ?? 1, elapsed: 0 })),
			),
			launchMetadata: { cwd: fixture.cwd, trustedLaunch: fixture.provenance } as RunningSubagent["launchMetadata"],
		};
		runningSubagents.set(running.id, running);
		// A detached child becomes its group's leader only after the fork returns.
		for (let attempt = 0; probeProcessGroup(child.pid!) !== "present"; attempt++) {
			assert.ok(attempt < 200, "the child's process group never appeared");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const terminate = {
			requestVersion: TRUSTED_LAUNCH_VERSION,
			requestId: "op_stop_01",
			runId: "run-wired",
			sessionFile: fixture.sessionFile,
			launchRequestId: fixture.provenance.requestId,
		};
		try {
			const notOwned = await descriptor.terminate({ ...terminate, runId: "run-elsewhere" });
			assert.equal(notOwned.outcome === "unknown" && notOwned.reason, "ownership_unavailable");
			assert.deepEqual(await descriptor.terminate(terminate), {
				outcome: "terminated",
				requestId: "op_stop_01",
				runId: "run-wired",
				sessionFile: fixture.sessionFile,
			});

			await extension.fire("session_shutdown", { reason: "quit" });
			const retired = await descriptor.terminate(terminate);
			assert.equal(retired.outcome === "unknown" && retired.reason, "descriptor_disposed");
		} finally {
			runningSubagents.delete(running.id);
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		}
	});

	it("keeps the descriptor through the coordinator-only turn stop", async () => {
		const extension = loadExtension();
		await extension.fire("session_start", { reason: "startup" });
		const descriptor = current();

		requestSubagentBatchStopForTest();
		await extension.fire("session_shutdown");

		assert.equal(current(), descriptor);
		assert.equal(descriptor?.isLive(), true);
		await extension.fire("session_shutdown", { reason: "quit" });
	});

	it("publishes nothing when the subagent tool is denied", async () => {
		process.env.PI_DENY_TOOLS = "subagent";
		const extension = loadExtension();
		await extension.fire("session_start", { reason: "startup" });
		assert.equal(current(), undefined);
	});

	it("a reload replaces the descriptor and the stale one cannot launch or retract it", async () => {
		const first = loadExtension();
		await first.fire("session_start", { reason: "startup" });
		const stale = current();
		await first.fire("session_shutdown", { reason: "reload" });

		const second = loadExtension();
		await second.fire("session_start", { reason: "reload" });
		const replacement = current();
		assert.ok(stale && replacement);
		assert.notEqual(replacement.generation, stale.generation);

		await first.fire("session_shutdown", { reason: "quit" });
		assert.equal(current(), replacement);
		const result = await stale.launch(launchRequest());
		assert.equal(result.outcome, "not_started");
		await second.fire("session_shutdown", { reason: "quit" });
	});

	it("a second extension instance cannot publish over a live descriptor", async () => {
		const first = loadExtension();
		await first.fire("session_start", { reason: "startup" });
		const owner = current();

		const duplicate = loadExtension();
		await duplicate.fire("session_start", { reason: "startup" });

		assert.equal(current(), owner);
		await duplicate.fire("session_shutdown", { reason: "quit" });
		assert.equal(current(), owner, "the refused instance cannot retract the owner");
		await first.fire("session_shutdown", { reason: "quit" });
	});
});
