import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import type { PilotAttemptLedger } from "../../src/routing/launch-authorization.ts";
import { getLiveSlotCount, resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import type { SubagentToolRuntime } from "../../src/tools/subagent-launch.ts";
import { createTrustedLauncher } from "../../src/trusted-launch/launcher.ts";
import { publishTrustedSubagents, type TrustedSubagentsPublication } from "../../src/trusted-launch/registry.ts";
import {
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
} from "../../src/trusted-launch/public.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import { assert, createTestDir, writeExecutable } from "../support/index.ts";
import { emptyAgentDir, writeCanonicalPolicy } from "../support/routing-policy.ts";

function harness(
	options: {
		agentDefs?: AgentDefaults | null;
		hasUI?: boolean;
		forceSynchronous?: boolean;
		launchError?: Error;
		reportedCwd?: string;
		pilotAttempts?: PilotAttemptLedger;
		definitionError?: Error;
		stopError?: Error;
		/** Resolves the launch only once this promise settles. */
		launchGate?: Promise<void>;
	} = {},
) {
	const stopped: RunningSubagent[] = [];
	const launched: { params: SubagentParamsInput; mode: "background" | "interactive" }[] = [];
	const wired: RunningSubagent[] = [];
	let widgetRefreshes = 0;
	const launch =
		(mode: "background" | "interactive") =>
		async (params: SubagentParamsInput): Promise<RunningSubagent> => {
			if (options.launchError) throw options.launchError;
			await options.launchGate;
			launched.push({ params, mode });
			return {
				id: `child-${launched.length}`,
				name: params.name,
				task: params.task,
				title: params.title,
				agent: params.agent,
				mode,
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: `/sessions/child-${launched.length}.jsonl`,
				...(mode === "interactive" ? { surface: "pane-7" } : {}),
				launchMetadata: { cwd: options.reportedCwd ?? params.forcedCwd } as RunningSubagent["launchMetadata"],
			};
		};
	const watch = () => new Promise<SubagentResult>(() => {});
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => {
			if (options.definitionError) throw options.definitionError;
			return options.agentDefs === undefined ? { spawning: false, mode: "background" } : options.agentDefs;
		},
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch("background"),
		launchSubagent: launch("interactive"),
		watchBackgroundSubagent: watch,
		watchSubagent: watch,
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: (_pi, running) => {
			wired.push(running);
		},
		startWidgetRefresh: () => {
			widgetRefreshes++;
		},
		getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
		stopRunningSubagent: async (running) => {
			if (options.stopError) throw options.stopError;
			stopped.push(running);
		},
		muxUnavailableResult: () => ({ content: [], details: {} }),
		...(options.pilotAttempts ? { pilotAttempts: options.pilotAttempts } : {}),
	};
	const publication = publishTrustedSubagents({
		launch: createTrustedLauncher({
			pi: { getThinkingLevel: () => "medium" } as never,
			runtime,
			ctx: { hasUI: options.hasUI ?? false, cwd: createTestDir(), sessionManager: {} } as never,
			forceSynchronous: () => options.forceSynchronous ?? false,
		}),
		resume: async () => {
			throw new Error("resume is not under test");
		},
		terminate: async () => {
			throw new Error("terminate is not under test");
		},
	});
	publications.push(publication);
	return { publication, descriptor: publication.descriptor, launched, wired, stopped, widgetRefreshes: () => widgetRefreshes };
}

const publications: TrustedSubagentsPublication[] = [];

function request(overrides: Record<string, unknown> = {}) {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_01",
		agent: "worker",
		name: "trusted-worker",
		title: "Trusted worker",
		task: "Do the work",
		effectiveCwd: realpathSync(createTestDir()),
		mode: "background",
		...overrides,
	};
}

describe("trusted launch through the normal coordinator", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
		resetSpawnWidthForTest();
		// Earlier suites start extension sessions that publish a descriptor.
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	});
	afterEach(() => {
		for (const publication of publications.splice(0)) publication.dispose();
	});

	it("launches a background child in the effective cwd with trusted provenance", async () => {
		const { descriptor, launched, wired, widgetRefreshes } = harness();
		const req = request({ labels: { runId: "run_01" } });

		const result = await descriptor.launch(req);

		assert.deepEqual(result, {
			outcome: "launched",
			requestId: "op_01",
			runId: "child-1",
			sessionFile: "/sessions/child-1.jsonl",
			mode: "background",
			effectiveCwd: req.effectiveCwd,
		});
		assert.equal(launched.length, 1);
		assert.equal(launched[0].mode, "background");
		assert.equal(launched[0].params.forcedCwd, req.effectiveCwd);
		assert.deepEqual(launched[0].params.trustedLaunch, {
			version: TRUSTED_LAUNCH_VERSION,
			generation: descriptor.generation,
			requestId: "op_01",
			labels: { runId: "run_01" },
		});
		assert.equal(launched[0].params.async, true);
		assert.equal(wired.length, 1, "completion is routed back like any launch");
		assert.equal(widgetRefreshes(), 1);
		assert.equal(getLiveSlotCount(), 1);
	});

	it("launches an interactive child in the effective cwd and reports its surface", async () => {
		const binDir = createTestDir();
		writeExecutable(binDir, "tmux", "#!/bin/sh\nexit 0\n");
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		const { descriptor, launched } = harness({ hasUI: true, agentDefs: { spawning: false, mode: "interactive" } });
		const req = request({ mode: "interactive" });

		const result = await descriptor.launch(req);

		assert.equal(result.outcome, "launched");
		assert.equal(result.outcome === "launched" && result.surfaceId, "pane-7");
		assert.equal(launched[0].mode, "interactive");
		assert.equal(launched[0].params.forcedCwd, req.effectiveCwd);
	});

	const refusals: [string, Parameters<typeof harness>[0], Record<string, unknown>, string][] = [
		["an unknown agent", { agentDefs: null }, {}, "agent_not_found"],
		["a mode the definition does not produce", {}, { mode: "interactive" }, "mode_mismatch"],
		["a blocking agent", { agentDefs: { spawning: false, mode: "background", async: false } }, {}, "synchronous_launch"],
		["a session that forces synchronous launches", { forceSynchronous: true }, {}, "synchronous_launch"],
		["a verified fan-out agent", { agentDefs: { mode: "background", llmAsVerifier: true } }, {}, "agent_unsupported"],
		["an agent with its own cwd", { agentDefs: { mode: "background", cwd: "/elsewhere" } }, {}, "agent_unsupported"],
		["an agent with shell task expansion", { agentDefs: { mode: "background", taskExpansion: "shell" } }, {}, "agent_unsupported"],
		["an agent without a session", { agentDefs: { mode: "background", noSession: true } }, {}, "agent_unsupported"],
	];
	for (const [label, options, overrides, reason] of refusals) {
		it(`refuses ${label} before creating a child`, async () => {
			const { descriptor, launched } = harness(options);
			const result = await descriptor.launch(request(overrides));
			assert.equal(result.outcome, "not_started");
			assert.equal(result.outcome === "not_started" && result.reason, reason);
			assert.equal(launched.length, 0);
			assert.equal(getLiveSlotCount(), 0);
		});
	}

	it("refuses a spawn-policy denial before creating a child", async () => {
		process.env.PI_SUBAGENT_AGENT = "worker";
		const { descriptor, launched } = harness();
		const result = await descriptor.launch(request());
		assert.equal(result.outcome === "not_started" && result.reason, "launch_denied");
		assert.equal(launched.length, 0);
	});

	it("composes with policy-bound authorization", async () => {
		process.env.PI_CODING_AGENT_DIR = writeCanonicalPolicy();
		// Read-only, so the managed child needs no writer worktree; writers are covered in test/routing.
		const { descriptor, launched } = harness({
			agentDefs: { spawning: false, mode: "background", tools: "read,grep,find,ls" },
		});

		const missingClass = await descriptor.launch(request({ agent: "pilot-worker" }));
		assert.equal(missingClass.outcome === "not_started" && missingClass.reason, "policy_rejected");
		assert.match(missingClass.outcome === "not_started" ? missingClass.message : "", /Routing policy rejected/);
		const pilot = await descriptor.launch(
			request({ agent: "pilot-scout", capabilityClass: "literal", pilotCase: "scout-literal-1" }),
		);
		assert.equal(pilot.outcome === "not_started" && pilot.reason, "pilot_attempts_unavailable");
		assert.equal(launched.length, 0);
		assert.equal(getLiveSlotCount(), 0);

		const managed = await descriptor.launch(request({ agent: "pilot-worker", capabilityClass: "implementation" }));
		assert.equal(managed.outcome, "launched");
		assert.equal(launched[0].params.policyLaunch?.model, "openai-codex/gpt-6-sol");
	});

	it("refuses when spawn width is exhausted", async () => {
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "1";
		const { descriptor, launched } = harness();
		assert.equal((await descriptor.launch(request({ requestId: "op_01" }))).outcome, "launched");
		const second = await descriptor.launch(request({ requestId: "op_02" }));
		assert.equal(second.outcome === "not_started" && second.reason, "spawn_width");
		assert.equal(launched.length, 1);
	});

	it("reports an unknown outcome when the launch itself fails, and returns its slot", async () => {
		const { descriptor } = harness({ launchError: new Error("pane vanished") });
		const result = await descriptor.launch(request());
		assert.equal(result.outcome, "unknown");
		assert.match(result.outcome === "unknown" ? result.message : "", /pane vanished/);
		assert.equal(getLiveSlotCount(), 0);
	});

	it("reports an unknown outcome when the child's recorded cwd differs from the request", async () => {
		const { descriptor, stopped } = harness({ reportedCwd: "/somewhere/else" });
		const result = await descriptor.launch(request());
		assert.deepEqual(
			stopped.map((running) => running.id),
			["child-1"],
			"a child in the wrong directory is stopped, never left active",
		);
		// A resolved stop is a request, not proof: closing a pane can fail silently.
		const message = result.outcome === "unknown" ? result.message : "";
		assert.doesNotMatch(message, /was stopped/);
		assert.match(message, /stop was requested; its termination is not confirmed/);
		assert.equal(result.outcome, "unknown");
		assert.equal(result.outcome === "unknown" && result.reason, "effective_cwd_mismatch");
		assert.deepEqual(result.outcome === "unknown" && result.partial, {
			runId: "child-1",
			sessionFile: "/sessions/child-1.jsonl",
		});
	});
	it("stops a child whose launch finished after the descriptor was retired", async () => {
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const { publication, descriptor, stopped } = harness({ launchGate: gate });
		const pending = descriptor.launch(request());
		await new Promise((resolve) => setImmediate(resolve));
		publication.dispose();
		open();

		const result = await pending;
		assert.equal(result.outcome, "unknown");
		assert.equal(result.outcome === "unknown" && result.reason, "descriptor_retired");
		assert.deepEqual(
			stopped.map((running) => running.id),
			["child-1"],
		);
	});

	it("reports nothing started when the agent definition cannot be read", async () => {
		const { descriptor, launched } = harness({ definitionError: new Error("bad frontmatter") });
		const result = await descriptor.launch(request());
		assert.equal(result.outcome, "not_started");
		assert.equal(result.outcome === "not_started" && result.reason, "preparation_failed");
		assert.match(result.outcome === "not_started" ? result.message : "", /bad frontmatter/);
		assert.equal(launched.length, 0);
		assert.equal(getLiveSlotCount(), 0);
	});
	it("does not claim a child was stopped when stopping it failed", async () => {
		const { descriptor } = harness({ reportedCwd: "/somewhere/else", stopError: new Error("pane gone") });
		const result = await descriptor.launch(request());
		assert.equal(result.outcome, "unknown");
		const message = result.outcome === "unknown" ? result.message : "";
		assert.doesNotMatch(message, /was stopped/);
		assert.match(message, /may still be running.*pane gone/);
	});
});
