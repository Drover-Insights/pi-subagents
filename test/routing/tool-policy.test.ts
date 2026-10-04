import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import type { PilotAttemptLedger } from "../../src/routing/launch-authorization.ts";
import { getLiveSlotCount } from "../../src/runtime/spawn-width.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import "../support/env.ts";
import {
	canonicalPolicyDocument,
	emptyAgentDir,
	type PolicyDocument,
	writeCanonicalPolicy,
} from "../support/routing-policy.ts";

type ToolResult = { content: { type: string; text: string }[]; details: Record<string, unknown> };

let agentDir: string;


function usePolicy(edit: (policy: PolicyDocument) => void): void {
	const document = canonicalPolicyDocument();
	edit(document);
	agentDir = writeCanonicalPolicy(document);
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

/** A ledger that grants every attempt and records reservations and releases. */
function recordingLedger() {
	const reserved: string[][] = [];
	const released: string[][] = [];
	const ledger: PilotAttemptLedger = {
		reserve(caseId, launchId) {
			reserved.push([caseId, launchId]);
			return { status: "reserved" };
		},
		release(caseId, launchId) {
			released.push([caseId, launchId]);
		},
	};
	return { ledger, reserved, released };
}

function harness(
	options: {
		agentDefs?: AgentDefaults;
		pilotAttempts?: PilotAttemptLedger;
		launchError?: Error;
		/** 1-based launch attempt that throws "spawn failed". */
		failOnLaunch?: number;
	} = {},
) {
	const launched: SubagentParamsInput[] = [];
	const runs: RunningSubagent[] = [];
	const launch: SubagentToolRuntime["launchBackgroundSubagent"] = async (params) => {
		if (options.launchError) throw options.launchError;
		if (options.failOnLaunch === launched.length + 1) throw new Error("spawn failed");
		launched.push(params);
		const running: RunningSubagent = {
			id: `child-${launched.length}`,
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile: `/tmp/child-${launched.length}.jsonl`,
		};
		runs.push(running);
		return running;
	};
	const watch = async (): Promise<SubagentResult> => ({
		name: "route-scout",
		task: "Map the route",
		summary: "done",
		exitCode: 0,
		elapsed: 0,
	});
	const runtime: SubagentToolRuntime = {
		loadAgentDefaults: () => ({ spawning: false, mode: "background", async: false, ...options.agentDefs }),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: watch,
		watchSubagent: watch,
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: { status: "started" } }),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [], details: {} }),
		...(options.pilotAttempts ? { pilotAttempts: options.pilotAttempts } : {}),
	};
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	registerSubagentCoreTools(
		{
			registerTool(definition: { name: string }) {
				tools.set(definition.name, definition as never);
				return definition;
			},
			getThinkingLevel: () => "medium",
		} as never,
		() => true,
		runtime,
	);
	const tool = tools.get("subagent");
	if (!tool) throw new Error("subagent tool was not registered");
	const run = async (params: Record<string, unknown>, hasUI = false) =>
		(await tool.execute("dispatch-1", params, undefined, undefined, {
			hasUI,
			cwd: process.cwd(),
			sessionManager: {},
		})) as ToolResult;
	return { run, launched, runs };
}

function request(agent: string, extra: Record<string, unknown> = {}) {
	return { name: "route-scout", title: "Route map", task: "Map the route", agent, ...extra };
}

async function rejection(
	params: Record<string, unknown>,
	options: Parameters<typeof harness>[0] = {},
	hasUI = false,
) {
	const { run, launched } = harness(options);
	const result = await run(params, hasUI);
	return { reason: result.details.reason, status: result.details.status, launches: launched.length };
}

describe("launch authorization through the subagent tool", () => {
	beforeEach(() => {
		// A parent Pi session's spawn grant must not leak into these launches.
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		agentDir = writeCanonicalPolicy();
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	test("an invalid canonical policy rejects every child launch before any launch", async () => {
		usePolicy((policy) => {
			policy.fallbackProviders = [];
		});
		const { run, launched } = harness();

		const result = await run(request("implementer"));

		assert.deepEqual(
			{ status: result.details.status, reason: result.details.reason, launches: launched.length },
			{ status: "policy_rejected", reason: "policy_invalid", launches: 0 },
		);
		assert.match(result.content[0]?.text ?? "", /unknown field fallbackProviders/);
	});

	test("without a canonical policy file, launches proceed and are marked unmanaged", async () => {
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
		const { run, launched } = harness();

		const result = await run(request("pilot-scout"));

		assert.deepEqual(result.details.routing, { status: "unmanaged", reason: "policy_absent" });
		assert.equal(launched[0]?.policyLaunch, undefined);
	});

	test("agent names outside the alias map launch unmanaged, including names equal to canonical role IDs", async () => {
		for (const agent of ["implementer", "scout", "reviewer"]) {
			const { run, launched } = harness();

			const result = await run(request(agent));

			assert.deepEqual(
				{ routing: result.details.routing, policyLaunch: launched[0]?.policyLaunch },
				{ routing: { status: "unmanaged", reason: "not_a_policy_role" }, policyLaunch: undefined },
				agent,
			);
		}
	});

	test("rejects Controller children and disabled roles", async () => {
		assert.deepEqual(await rejection(request("pilot-controller", { capabilityClass: "controller" })), {
			status: "policy_rejected",
			reason: "controller_child_forbidden",
			launches: 0,
		});
		assert.deepEqual(await rejection(request("pilot-frontier-critic", { capabilityClass: "architecture" })), {
			status: "policy_rejected",
			reason: "role_disabled",
			launches: 0,
		});
	});

	test("rejects caller model and thinking overrides for managed roles", async () => {
		for (const override of [{ model: "openai-codex/gpt-6-sol" }, { thinking: "high" }]) {
			assert.deepEqual(
				await rejection(request("pilot-worker", { capabilityClass: "implementation", ...override })),
				{ status: "policy_rejected", reason: "prohibited_override", launches: 0 },
			);
		}
	});

	test("requires a capability class the role grants, without normalization", async () => {
		assert.equal((await rejection(request("pilot-worker"))).reason, "missing_capability_class");
		assert.equal(
			(await rejection(request("pilot-worker", { capabilityClass: "review" }))).reason,
			"capability_not_granted",
		);
		assert.equal(
			(await rejection(request("pilot-worker", { capabilityClass: " implementation" }))).reason,
			"capability_not_granted",
		);
	});

	test("rejects interaction modes the role does not permit, judged on the effective launch mode", async () => {
		// The fixture's automated Reviewer permits only synchronous launches.
		assert.equal(
			(await rejection(request("pilot-reviewer", { capabilityClass: "review" }), { agentDefs: { async: true } }, true))
				.reason,
			"interaction_mode_forbidden",
		);
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux";
		assert.equal(
			(
				await rejection(
					request("pilot-worker", { capabilityClass: "implementation" }),
					{ agentDefs: { mode: "interactive" } },
					true,
				)
			).reason,
			"interaction_mode_forbidden",
		);
	});

	test("rejects managed definitions that grant recursive spawning or freeform flags", async () => {
		assert.equal(
			(await rejection(request("pilot-worker", { capabilityClass: "implementation" }), { agentDefs: { spawning: true } }))
				.reason,
			"recursive_spawning_forbidden",
		);
		assert.equal(
			(
				await rejection(request("pilot-worker", { capabilityClass: "implementation" }), {
					agentDefs: { flags: "--model openai-codex/gpt-6-astra" },
				})
			).reason,
			"freeform_flags_forbidden",
		);
	});

	test("rejects managed definitions that run parent shell expansion or verifier model calls", async () => {
		assert.equal(
			(
				await rejection(request("pilot-worker", { capabilityClass: "implementation" }), {
					agentDefs: { taskExpansion: "shell" },
				})
			).reason,
			"task_expansion_forbidden",
		);
		assert.equal(
			(
				await rejection(request("pilot-worker", { capabilityClass: "implementation" }), {
					agentDefs: { llmAsVerifier: true },
				})
			).reason,
			"verifier_forbidden",
		);
	});

	test("a pilot role launches only for a named, matching, unexpired pilot case", async () => {
		const { ledger } = recordingLedger();
		assert.equal(
			(await rejection(request("pilot-scout", { capabilityClass: "literal" }), { pilotAttempts: ledger })).reason,
			"pilot_case_required",
		);
		assert.equal(
			(
				await rejection(request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-9" }), {
					pilotAttempts: ledger,
				})
			).reason,
			"unknown_pilot_case",
		);
		assert.equal(
			(
				await rejection(request("pilot-scout", { capabilityClass: "code-graph", pilotCase: "scout-literal-1" }), {
					pilotAttempts: ledger,
				})
			).reason,
			"pilot_case_mismatch",
		);
		usePolicy((policy) => {
			policy.pilotCases["scout-literal-1"].expires = "2000-01-01T00:00:00Z";
		});
		assert.equal(
			(
				await rejection(request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }), {
					pilotAttempts: ledger,
				})
			).reason,
			"pilot_case_expired",
		);
	});

	test("pilot launches fail closed until durable attempt accounting exists", async () => {
		assert.deepEqual(
			await rejection(request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" })),
			{ status: "policy_rejected", reason: "pilot_attempts_unavailable", launches: 0 },
		);
	});

	test("an authorized pilot launch reserves its attempt and carries the policy launch and route evidence", async () => {
		const { ledger, reserved: reservations } = recordingLedger();
		const { run, launched, runs } = harness({ pilotAttempts: ledger, agentDefs: { tools: "read,grep" } });

		const result = await run(request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }));

		assert.deepEqual(reservations, [["scout-literal-1", "dispatch-1"]]);
		assert.deepEqual(launched[0]?.policyLaunch, {
			model: "openai-codex/gpt-5.6-luna",
			thinking: "low",
			extensions: [
				join(agentDir, "extensions/workspace-boundary/index.ts"),
				join(agentDir, "extensions/drover-model-routing/index.ts"),
			],
			skills: "none",
			noContextFiles: true,
		});
		assert.deepEqual(result.details.routing, {
			status: "managed",
			generation: "test-generation-v1",
			agent: "pilot-scout",
			role: "scout",
			state: "pilot",
			capabilityClass: "literal",
			interactionMode: "synchronous",
			pilotCase: "scout-literal-1",
			route: { provider: "openai-codex", model: "gpt-5.6-luna", effort: "low" },
			extensions: ["subagent-completion", "workspace-boundary", "drover-model-routing"],
			skills: [],
			projectResources: false,
			spawning: false,
			tools: "read,grep",
		});
		assert.equal(Object.isFrozen(result.details.routing), true);
		assert.equal(runs[0]?.routing, result.details.routing, "later parent requests are gated against this evidence");
	});

	test("selective and automated roles launch for granted classes without a pilot case", async () => {
		const { run, launched } = harness();

		const worker = await run(request("pilot-worker", { capabilityClass: "implementation" }));
		const reviewer = await run(request("pilot-reviewer", { capabilityClass: "review" }));

		assert.deepEqual(
			[worker.details.routing, reviewer.details.routing].map((routing) => (routing as { role: string }).role),
			["worker", "reviewer"],
		);
		assert.deepEqual(
			launched.map((params) => params.policyLaunch?.model),
			["openai-codex/gpt-6-sol", "claude-primary/opus"],
		);
	});

	test("one rejected child rejects the whole batch before any child launches", async () => {
		const { run, launched } = harness();

		const result = await run({
			children: [
				request("pilot-worker", { capabilityClass: "implementation" }),
				request("pilot-frontier-engineer", { name: "debug-engineer", capabilityClass: "frontier-engineering" }),
			],
		});

		assert.deepEqual(
			{ reason: result.details.reason, launches: launched.length },
			{ reason: "role_disabled", launches: 0 },
		);
	});

	test("strips a smuggled policy launch from model-callable input", async () => {
		const { run, launched } = harness();

		await run(
			request("implementer", {
				policyLaunch: { model: "caller/smuggled", thinking: "xhigh", extensions: [], skills: "all", noContextFiles: false },
			}),
		);

		assert.equal(launched[0]?.policyLaunch, undefined);
	});

	test("strips a smuggled effective cwd and trusted provenance from model-callable input", async () => {
		const { run, launched } = harness();

		await run(
			request("implementer", {
				forcedCwd: "/tmp/smuggled",
				trustedLaunch: { version: "pi-subagents.trusted-launch/v1", generation: "g", requestId: "op" },
			}),
		);
		await run({ children: [request("implementer", { forcedCwd: "/tmp/smuggled-child" })] });

		assert.equal(launched.length, 2);
		for (const params of launched) {
			assert.equal(params.forcedCwd, undefined);
			assert.equal(params.trustedLaunch, undefined);
		}
	});

	test("authorizes the mode the child launches in, not a smuggled background field", async () => {
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux";
		assert.equal(
			(
				await rejection(
					request("pilot-worker", { capabilityClass: "implementation", background: true }),
					{ agentDefs: { mode: undefined } },
					true,
				)
			).reason,
			"interaction_mode_forbidden",
		);
	});

	test("authorizes a background launch for a role that permits it", async () => {
		const { run } = harness({ agentDefs: { async: true } });

		const result = await run(request("pilot-worker", { capabilityClass: "implementation" }), true);

		assert.equal((result.details.routing as { interactionMode: string }).interactionMode, "background");
	});

	test("routes each capability class of a multi-route role to its own fixed route", async () => {
		const { ledger } = recordingLedger();
		const { run, launched } = harness({ pilotAttempts: ledger });

		await run(request("pilot-scout", { capabilityClass: "code-graph", pilotCase: "scout-code-graph-1" }));

		assert.deepEqual(
			{ model: launched[0]?.policyLaunch?.model, thinking: launched[0]?.policyLaunch?.thinking },
			{ model: "openai-codex/gpt-5.6-terra", thinking: "low" },
		);
	});

	test("rejects managed definitions that redirect the child runtime through env or cwd", async () => {
		assert.equal(
			(
				await rejection(request("pilot-worker", { capabilityClass: "implementation" }), {
					agentDefs: { env: "PI_CODING_AGENT_DIR=/elsewhere" },
				})
			).reason,
			"definition_env_forbidden",
		);
		assert.equal(
			(
				await rejection(request("pilot-worker", { capabilityClass: "implementation" }), {
					agentDefs: { cwd: "/elsewhere" },
				})
			).reason,
			"definition_cwd_forbidden",
		);
	});

	test("reserves pilot attempts only after every child of the call is authorized", async () => {
		const rejected = recordingLedger();
		await harness({ pilotAttempts: rejected.ledger }).run({
			children: [
				request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }),
				request("pilot-worker", { name: "slice-worker", capabilityClass: "implementation", thinking: "high" }),
			],
		});
		const accepted = recordingLedger();
		await harness({ pilotAttempts: accepted.ledger }).run({
			children: [
				request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }),
				request("pilot-worker", { name: "slice-worker", capabilityClass: "implementation" }),
			],
		});

		assert.deepEqual(
			{ rejectedCall: rejected.reserved, acceptedCall: accepted.reserved },
			{ rejectedCall: [], acceptedCall: [["scout-literal-1", "dispatch-1:0"]] },
		);
	});

	test("releases a reserved pilot attempt when the launch fails", async () => {
		const { ledger, reserved, released } = recordingLedger();
		const { run } = harness({ pilotAttempts: ledger, launchError: new Error("spawn failed") });

		await assert.rejects(
			() => run(request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" })),
			/spawn failed/,
		);

		assert.deepEqual({ reserved, released }, {
			reserved: [["scout-literal-1", "dispatch-1"]],
			released: [["scout-literal-1", "dispatch-1"]],
		});
	});

	test("a refused pilot reservation releases the call's earlier reservations and its spawn slots", async () => {
		const reserved: string[][] = [];
		const released: string[][] = [];
		const ledger: PilotAttemptLedger = {
			reserve(caseId, launchId) {
				reserved.push([caseId, launchId]);
				return caseId === "scout-literal-1" ? { status: "reserved" } : { status: "unavailable", reason: "exhausted" };
			},
			release(caseId, launchId) {
				released.push([caseId, launchId]);
			},
		};
		const { run, launched } = harness({ pilotAttempts: ledger });
		const pilotBatch = {
			children: [
				request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }),
				request("pilot-scout", { name: "graph-scout", capabilityClass: "code-graph", pilotCase: "scout-code-graph-1" }),
			],
		};

		const slotsBefore = getLiveSlotCount();
		const result = await run(pilotBatch);

		assert.deepEqual(
			{ reason: result.details.reason, released, launches: launched.length, slots: getLiveSlotCount() },
			{
				reason: "pilot_attempts_unavailable",
				released: [["scout-literal-1", "dispatch-1:0"]],
				launches: 0,
				slots: slotsBefore,
			},
		);
	});

	test("a launch failure mid-batch releases only the children that never launched", async () => {
		const { ledger, released } = recordingLedger();
		const { run } = harness({ pilotAttempts: ledger, failOnLaunch: 2 });
		const slotsBefore = getLiveSlotCount();

		await assert.rejects(
			() =>
				run({
					children: [
						request("pilot-scout", { capabilityClass: "literal", pilotCase: "scout-literal-1" }),
						request("pilot-scout", {
							name: "graph-scout",
							capabilityClass: "code-graph",
							pilotCase: "scout-code-graph-1",
						}),
					],
				}),
			/spawn failed/,
		);

		// The launched child's slot is freed when its watch settles.
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(
			{ released, slots: getLiveSlotCount() },
			{ released: [["scout-code-graph-1", "dispatch-1:1"]], slots: slotsBefore },
		);
	});
});
