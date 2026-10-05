import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";
import { acquireWriterLease, type WriterLease } from "../../src/broker/writer-lease.ts";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { launchSubagentEntries } from "../../src/tools/subagent-launch.ts";
import { checkWriter } from "../../src/tools/subagent-routing.ts";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import "../support/env.ts";
import { type PolicyDocument, canonicalPolicyDocument, writeCanonicalPolicy } from "../support/routing-policy.ts";
import { repoGit, writerRepo } from "../support/writer-repo.ts";

const execFileAsync = promisify(execFile);

type ToolResult = { content: { type: string; text: string }[]; details: Record<string, unknown> };

let agentDir: string;

function usePolicy(edit?: (policy: PolicyDocument) => void): void {
	const document = canonicalPolicyDocument();
	edit?.(document);
	agentDir = writeCanonicalPolicy(document);
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

/** Every lease record and marker in the store, by name. */
function leaseFiles(): string[] {
	const root = join(agentDir, "writer-leases");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((key) =>
		readdirSync(join(root, key))
			.filter((name) => name !== "tmp")
			.map((name) => `${key.slice(0, 8)}/${name}`),
	);
}

function harness(
	options: {
		cwd: string;
		agentDefs?: AgentDefaults;
		confinement?: SubagentToolRuntime["probeWriterConfinement"];
		acquireWriterLease?: SubagentToolRuntime["acquireWriterLease"];
		failOnLaunch?: number;
	},
) {
	const launched: SubagentParamsInput[] = [];
	const launch: SubagentToolRuntime["launchBackgroundSubagent"] = async (params) => {
		if (options.failOnLaunch === launched.length + 1) throw new Error("spawn failed");
		launched.push(params);
		return {
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
		} satisfies RunningSubagent;
	};
	const watch = async (): Promise<SubagentResult> => ({ name: "w", task: "t", summary: "done", exitCode: 0, elapsed: 0 });
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
		probeSandbox: () => ({ status: "available" }),
		probeWriterConfinement: options.confinement ?? (() => ({ status: "available" })),
		...(options.acquireWriterLease ? { acquireWriterLease: options.acquireWriterLease } : {}),
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
	const runTool = async (params: Record<string, unknown>, hasUI = false) =>
		(await tool.execute("dispatch-1", params, undefined, undefined, {
			hasUI,
			cwd: options.cwd,
			sessionManager: {},
		})) as ToolResult;
	// The launch phase, as a trusted launch reaches it: only it can name a child's working directory.
	const run = async (params: Record<string, unknown>): Promise<ToolResult> => {
		const children = (Array.isArray(params.children) ? params.children : [params]) as SubagentParamsInput[];
		const phase = await launchSubagentEntries(
			children.map((child) => ({ child, agentDefs: runtime.loadAgentDefaults(child.agent, options.cwd) })),
			{
				launchId: "dispatch-1",
				ctx: { hasUI: false, cwd: options.cwd, sessionManager: {} } as never,
				pi: { getThinkingLevel: () => "medium" } as never,
				runtime,
				forceSynchronous: false,
			},
		);
		return phase.status === "rejected" ? (phase.result as ToolResult) : { content: [], details: { status: "launched" } };
	};
	return { run, runTool, launched };
}

function writer(cwd: string, extra: Record<string, unknown> = {}) {
	return {
		name: "task-worker",
		title: "Task work",
		task: "Do the task",
		agent: "pilot-worker",
		capabilityClass: "implementation",
		forcedCwd: cwd,
		...extra,
	};
}

function outcome(result: ToolResult, launched: SubagentParamsInput[]) {
	return { status: result.details.status, reason: result.details.reason, launches: launched.length };
}

describe("managed writer launches", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		usePolicy();
	});

	test("a writer launches into its own linked worktree holding the worktree's lease", async () => {
		const repo = writerRepo();
		const { run, launched } = harness({ cwd: repo.main });

		const result = await run(writer(repo.linked));

		assert.equal(launched.length, 1, JSON.stringify(result));
		assert.deepEqual(launched[0]?.policyLaunch?.toolBroker, { mode: "writer" });
		const lease = launched[0]?.writerLease as WriterLease;
		assert.ok(lease);
		const record = JSON.parse(readFileSync(join(lease.dir, "lease-1.json"), "utf8"));
		assert.deepEqual(
			{ worktree: record.worktree, branch: record.branch, head: record.head, launchId: record.launchId, generation: record.policyGeneration },
			{ worktree: repo.linked, branch: "task", head: repo.head, launchId: "dispatch-1", generation: "test-generation-v1" },
		);
	});

	test("rejects a writer outside a valid worktree before any child or lease exists", async () => {
		const repo = writerRepo();
		mkdirSync(join(repo.linked, "sub"));
		for (const cwd of [repo.main, join(repo.linked, "sub")]) {
			const { run, launched } = harness({ cwd: repo.main });

			const result = await run(writer(cwd));

			assert.deepEqual(outcome(result, launched), { status: "policy_rejected", reason: "writer_worktree_invalid", launches: 0 }, cwd);
		}
		assert.deepEqual(leaseFiles(), []);
	});

	test("a writer called through the subagent tool cannot name a worktree, so it is rejected before any lease exists", async () => {
		const repo = writerRepo();
		const { runTool, launched } = harness({ cwd: repo.main });
		const { forcedCwd: _forced, ...call } = writer(repo.linked);

		// The tool schema has no working directory; a smuggled one never reaches the launch.
		const result = await runTool({ ...call, cwd: repo.linked });

		assert.deepEqual(outcome(result, launched), { status: "policy_rejected", reason: "writer_worktree_invalid", launches: 0 });
		assert.deepEqual(leaseFiles(), []);
	});

	test("a read-only managed child does not need a worktree", async () => {
		const repo = writerRepo();
		const { run, launched } = harness({ cwd: repo.main, agentDefs: { tools: "read,grep,find,ls" } });

		await run(writer(repo.main));

		assert.equal(launched.length, 1);
		assert.equal(launched[0]?.writerLease, undefined);
	});

	test("a pane writer or a verified fan-out writer has no supervised group and is rejected", () => {
		// The canonical policy cannot grant either to a managed child today; this
		// guard keeps a writer out of them if that ever changes.
		const repo = writerRepo();
		const child = writer(repo.linked) as unknown as SubagentParamsInput;
		const options = { launchId: "l", hasUI: true, forceSynchronous: false, cwd: repo.main, probeWriterConfinement: () => ({ status: "available" as const }) };

		for (const [mode, agentDefs] of [
			["interactive", null],
			["background", { llmAsVerifier: true }],
		] as const) {
			const result = checkWriter(child, agentDefs as AgentDefaults | null, mode, options);
			assert.equal(result.status === "rejected" && result.reason, "writer_requires_supervised_group", mode);
		}
		assert.equal(checkWriter(child, null, "background", options).status, "valid");
	});

	test("a host that cannot confine a writer rejects it before any child or lease exists", async () => {
		const repo = writerRepo();
		const { run, launched } = harness({
			cwd: repo.main,
			confinement: () => ({ status: "unavailable", message: "no PID namespaces here" }),
		});

		const result = await run(writer(repo.linked));

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "writer_confinement_unavailable",
			launches: 0,
		});
		assert.match(result.content[0]?.text ?? "", /no PID namespaces here/);
		assert.deepEqual(leaseFiles(), []);
	});

	test("a held lease rejects a second writer into the same worktree, creating no new record", async () => {
		const repo = writerRepo();
		const first = harness({ cwd: repo.main });
		await first.run(writer(repo.linked));
		const before = leaseFiles();

		const second = harness({ cwd: repo.main });
		const result = await second.run(writer(repo.linked));

		assert.deepEqual(outcome(result, second.launched), { status: "policy_rejected", reason: "writer_lease_held", launches: 0 });
		assert.deepEqual(leaseFiles(), before);
	});

	test("two writers of one call naming the same worktree are rejected before any lease exists", async () => {
		const repo = writerRepo();
		const { run, launched } = harness({ cwd: repo.main });

		const result = await run({ children: [writer(repo.linked), writer(repo.linked, { name: "task-worker-two" })] });

		assert.deepEqual(outcome(result, launched), { status: "policy_rejected", reason: "writer_lease_held", launches: 0 });
		assert.deepEqual(leaseFiles(), []);
	});

	test("leases are all or nothing: one held lease releases the others and launches nothing", async () => {
		const repo = writerRepo();
		const other = join(repo.root, "other");
		repoGit(repo.main, "worktree", "add", "-q", "-b", "other", other);
		await harness({ cwd: repo.main }).run(writer(other));
		const { run, launched } = harness({ cwd: repo.main });

		const result = await run({ children: [writer(repo.linked), writer(other, { name: "other-worker" })] });

		assert.deepEqual(outcome(result, launched), { status: "policy_rejected", reason: "writer_lease_held", launches: 0 });
		const linkedLease = leaseFiles().filter((name) => name.endsWith("lease-1.end.json"));
		assert.equal(linkedLease.length, 1, JSON.stringify(leaseFiles()));
		assert.equal(await harness({ cwd: repo.main }).run(writer(repo.linked)).then((r) => r.details.reason), undefined);
	});

	test("a worktree that changes between acquiring the lease and revalidating releases the lease and rejects", async () => {
		const repo = writerRepo();
		const { run, launched } = harness({
			cwd: repo.main,
			acquireWriterLease: (root, request, options) => {
				const result = acquireWriterLease(root, request, options);
				writeFileSync(join(repo.gitDir, "HEAD"), `${repo.head}\n`);
				return result;
			},
		});

		const result = await run(writer(repo.linked));

		assert.deepEqual(outcome(result, launched), { status: "policy_rejected", reason: "writer_worktree_invalid", launches: 0 });
		assert.ok(leaseFiles().some((name) => name.endsWith("lease-1.end.json")), JSON.stringify(leaseFiles()));
	});

	test("a spawn that throws releases the lease", async () => {
		const repo = writerRepo();
		const { run } = harness({ cwd: repo.main, failOnLaunch: 1 });

		await assert.rejects(run(writer(repo.linked)), /spawn failed/);

		const retry = harness({ cwd: repo.main });
		await retry.run(writer(repo.linked));
		assert.equal(retry.launched.length, 1);
	});

	test("two parents in separate processes racing for one worktree: one holds the lease, the other is rejected as held", async () => {
		const repo = writerRepo();
		const script = `
			import { acquireWriterLeases } from ${JSON.stringify(new URL("../../src/tools/writer-leases.ts", import.meta.url).href)};
			import { validateWriterWorktree } from ${JSON.stringify(new URL("../../src/broker/writer-worktree.ts", import.meta.url).href)};
			const [linked, main, startAt, launchId] = process.argv.slice(1);
			const check = validateWriterWorktree(linked, main);
			const routing = [{ launchId, evidence: { status: "managed", generation: "g" }, writerWorktree: check.worktree }];
			while (Date.now() < Number(startAt)) {}
			const result = acquireWriterLeases(routing, main);
			console.log(Array.isArray(result) ? "acquired" : result.details.reason);
		`;
		const startAt = String(Date.now() + 1500);
		const racers = ["parent-a", "parent-b"].map((launchId) =>
			execFileAsync(process.execPath, ["--input-type=module", "-e", script, repo.linked, repo.main, startAt, launchId], {
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			}),
		);

		const outcomes = (await Promise.all(racers)).map((result) => result.stdout.trim()).sort();

		assert.deepEqual(outcomes, ["acquired", "writer_lease_held"]);
		assert.deepEqual(leaseFiles().filter((name) => /lease-\d+\.json$/.test(name)).length, 1);
	});
});
