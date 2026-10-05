import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { acquireWriterLease } from "../../src/broker/writer-lease.ts";
import { protectedBrokerPaths } from "../../src/broker/preflight.ts";
import { buildSandboxPlan } from "../../src/broker/sandbox-plan.ts";
import { probeSandbox, runInSandbox } from "../../src/broker/sandbox-run.ts";
import { WriterSpawnError } from "../../src/broker/writer-spawn.ts";
import { readPilotCase, reservePilotAttempt } from "../../src/routing/pilot-attempt-store.ts";
import { getLiveSlotCount } from "../../src/runtime/spawn-width.ts";
import { settleFailedPilotAttempt } from "../../src/tools/pilot-attempts.ts";
import { launchSubagentEntries } from "../../src/tools/subagent-launch.ts";
import type { SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import "../support/env.ts";
import { type PolicyDocument, canonicalPolicyDocument, writeCanonicalPolicy } from "../support/routing-policy.ts";
import { writerRepo } from "../support/writer-repo.ts";

type ToolResult = { content: { type: string; text: string }[]; details: Record<string, unknown> };

let agentDir: string;
let policy: PolicyDocument;
let fakePi: string;

function usePolicy(edit?: (document: PolicyDocument) => void): void {
	policy = canonicalPolicyDocument();
	edit?.(policy);
	agentDir = writeCanonicalPolicy(policy);
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function caseDigest(caseId: string): string {
	return `sha256:${sha256(canonicalJson(policy.pilotCases[caseId]))}`;
}

/** Write the current policy again into the same agent directory, keeping its store. */
function usePolicyKeepingStore(): void {
	writeFileSync(join(agentDir, "drover-model-routing.json"), JSON.stringify(policy));
}

/** Define extension providers in the agent directory's models.json, as Pi would see them. */
function defineProviders(...ids: string[]): void {
	const providers = Object.fromEntries(ids.map((id) => [id, { baseUrl: "http://127.0.0.1:9", api: "anthropic-messages" }]));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
}

function store() {
	return join(agentDir, "pilot-attempts");
}

function attempts(caseId: string) {
	return readPilotCase(store(), caseId)?.reservations.map((entry) => ({
		launchId: entry.launchId,
		outcome: entry.outcome,
		recovery: entry.recovery,
	}));
}

function executable(name: string, body: string | Buffer): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pilot-bin-")));
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

const controllerModel = { provider: "openai-codex", id: "gpt-6-sol" };

function harness(
	options: {
		cwd?: string;
		agentDefs?: AgentDefaults;
		/** 1-based launch that throws this error. */
		failOnLaunch?: { at: number; error: Error };
		model?: { provider: string; id: string } | undefined;
		thinking?: string;
		/** 1-based launched child whose steer-back wiring throws this error. */
		failOnWire?: { at: number; error: Error };
	} = {},
) {
	const cwd = options.cwd ?? process.cwd();
	const launched: SubagentParamsInput[] = [];
	let wired = 0;
	const launch: SubagentToolRuntime["launchBackgroundSubagent"] = async (params) => {
		if (options.failOnLaunch?.at === launched.length + 1) throw options.failOnLaunch.error;
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
		loadAgentDefaults: () => ({
			spawning: false,
			mode: "background",
			async: false,
			tools: "read,grep,find,ls",
			...options.agentDefs,
		}),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: watch,
		watchSubagent: watch,
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {
			wired++;
			if (options.failOnWire?.at === wired) throw options.failOnWire.error;
		},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: { status: "started" } }),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [], details: {} }),
		probeSandbox: () => ({ status: "available" }),
		probeWriterConfinement: () => ({ status: "available" }),
	};
	const model = "model" in options ? options.model : controllerModel;
	const run = async (children: Record<string, unknown>[], launchId = "dispatch-1"): Promise<ToolResult> => {
		const phase = await launchSubagentEntries(
			children.map((child) => ({
				child: child as unknown as SubagentParamsInput,
				agentDefs: runtime.loadAgentDefaults(child.agent as string, cwd),
			})),
			{
				launchId,
				ctx: { hasUI: false, cwd, sessionManager: {}, ...(model ? { model } : {}) } as never,
				pi: { getThinkingLevel: () => options.thinking ?? "medium" } as never,
				runtime,
				forceSynchronous: false,
			},
		);
		return phase.status === "rejected" ? (phase.result as ToolResult) : { content: [], details: { status: "launched" } };
	};
	return { run, launched };
}

function scout(pilotCase = "scout-literal-1", extra: Record<string, unknown> = {}) {
	return {
		name: "route-scout",
		title: "Route map",
		task: "Map the route",
		agent: "pilot-scout",
		capabilityClass: pilotCase === "scout-literal-1" ? "literal" : "code-graph",
		pilotCase,
		...extra,
	};
}

function outcome(result: ToolResult, launched: SubagentParamsInput[]) {
	return { status: result.details.status, reason: result.details.reason, launches: launched.length };
}

describe("durable pilot attempts through the launch phase", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
		delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
		usePolicy();
		// A standalone Pi build is a binary; a script must belong to the Pi package.
		fakePi = executable("fake-pi", readFileSync("/usr/bin/true"));
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
	});

	test("a pilot launch reserves its attempt with a write-once receipt, then commits it", async () => {
		const { run, launched } = harness();

		const result = await run([scout()]);

		assert.equal(launched.length, 1, JSON.stringify(result));
		const state = readPilotCase(store(), "scout-literal-1");
		assert.equal(state?.caseDigest, caseDigest("scout-literal-1"));
		assert.deepEqual(state?.reservations.map((entry) => [entry.launchId, entry.outcome]), [["dispatch-1", "committed"]]);
		assert.deepEqual(state?.reservations[0]?.receipt, {
			generation: "test-generation-v1",
			caseDigest: caseDigest("scout-literal-1"),
			controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
			runtime: { pi: { command: fakePi, commandSha256: sha256(readFileSync(fakePi)), entry: null, package: null } },
		});
	});

	test("an exhausted case rejects the launch and consumes nothing more", async () => {
		await harness().run([scout()]);
		const { run, launched } = harness();

		const result = await run([scout()], "dispatch-2");

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "pilot_attempts_unavailable",
			launches: 0,
		});
		assert.deepEqual(attempts("scout-literal-1")?.length, 1);
	});

	test("a replayed launch id launches nothing and is counted once, even when attempts remain", async () => {
		usePolicy((document) => {
			document.pilotCases["scout-literal-1"].attempts.allowed = 5;
		});
		await harness().run([scout()]);
		const { run, launched } = harness();

		const result = await run([scout()]);

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "pilot_attempts_unavailable",
			launches: 0,
		});
		assert.match(result.content[0]?.text ?? "", /dispatch-1/);
		assert.deepEqual(attempts("scout-literal-1"), [{ launchId: "dispatch-1", outcome: "committed", recovery: null }]);
	});

	test("consumption survives a generation change and a rollback to the earlier generation", async () => {
		await harness().run([scout()]);
		const rewrite = (generation: string) =>
			writeFileSync(join(agentDir, "drover-model-routing.json"), JSON.stringify({ ...policy, generation }));

		rewrite("test-generation-v2");
		const changed = harness();
		const afterChange = await changed.run([scout()], "dispatch-2");
		rewrite("test-generation-v1");
		const rolledBack = harness();
		const afterRollback = await rolledBack.run([scout()], "dispatch-3");

		assert.deepEqual(
			[outcome(afterChange, changed.launched), outcome(afterRollback, rolledBack.launched)],
			[
				{ status: "policy_rejected", reason: "pilot_attempts_unavailable", launches: 0 },
				{ status: "policy_rejected", reason: "pilot_attempts_unavailable", launches: 0 },
			],
		);
		assert.deepEqual(attempts("scout-literal-1"), [{ launchId: "dispatch-1", outcome: "committed", recovery: null }]);
	});

	test("a missing Controller model is a preflight rejection that writes nothing", async () => {
		const { run, launched } = harness({ model: undefined });

		const result = await run([scout()]);

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "pilot_receipt_unavailable",
			launches: 0,
		});
		assert.equal(readPilotCase(store(), "scout-literal-1"), null);
	});

	test("a route provider with no runtime identity is a preflight rejection that writes nothing", async () => {
		usePolicy((document) => {
			const route = { provider: "custom-proxy", model: "luna", effort: "low" };
			document.roles.scout.routes.literal = route;
			document.pilotCases["scout-literal-1"].route = route;
		});
		defineProviders("custom-proxy");
		const { run, launched } = harness();

		const result = await run([scout()]);

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "pilot_receipt_unavailable",
			launches: 0,
		});
		assert.match(result.content[0]?.text ?? "", /custom-proxy/);
		assert.equal(readPilotCase(store(), "scout-literal-1"), null);
	});

	test("a Claude route records the Claude CLI and the non-secret instance identity in the receipt", async () => {
		const claude = executable("claude", "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.1.300 (Claude Code)'\n");
		const configDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-config-")));
		const primaryRoot = join(configDir, "primary");
		const secondaryRoot = join(configDir, "secondary");
		mkdirSync(primaryRoot);
		mkdirSync(secondaryRoot);
		const config = join(configDir, "instances.json");
		const primary = `sha256:${"1".repeat(64)}`;
		const secondary = `sha256:${"2".repeat(64)}`;
		writeFileSync(
			config,
			JSON.stringify({
				instances: [
					{ providerId: "claude-primary", label: "primary", configRoot: primaryRoot, expectedIdentityFingerprint: primary },
					{ providerId: "claude-secondary", label: "secondary", configRoot: secondaryRoot, expectedIdentityFingerprint: secondary },
				],
				failover: { providerId: "claude-auto", label: "automatic", order: ["claude-primary", "claude-secondary"] },
			}),
			{ mode: 0o600 },
		);
		process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = config;
		process.env.PI_CLAUDE_CODE_PROVIDER_PATH = claude;
		const reviewCase = (provider: string) => ({
			role: "reviewer",
			capabilityClass: "review",
			artifact: "artifacts/review-1.md",
			route: { provider, model: "opus", effort: "medium" },
			resourceGrant: "isolated-child",
			attempts: { allowed: 1 },
			retry: "none",
			expires: "2999-01-01T00:00:00Z",
			acceptance: ["names each finding"],
		});
		const reviewer = (provider: string) => {
			usePolicy((document) => {
				document.roles.reviewer.state = "pilot";
				document.roles.reviewer.routes.review = { provider, model: "opus", effort: "medium" };
				document.pilotCases[`review-${provider}`] = reviewCase(provider);
			});
			defineProviders("claude-primary", "claude-secondary", "claude-auto");
			return {
				name: "diff-reviewer",
				title: "Diff review",
				task: "Review the diff",
				agent: "pilot-reviewer",
				capabilityClass: "review",
				pilotCase: `review-${provider}`,
			};
		};

		const viaFailover = harness();
		await viaFailover.run([reviewer("claude-auto")]);
		const failoverReceipt = readPilotCase(store(), "review-claude-auto")?.reservations[0]?.receipt;
		const direct = harness();
		await direct.run([reviewer("claude-primary")]);
		const directReceipt = readPilotCase(store(), "review-claude-primary")?.reservations[0]?.receipt;

		assert.equal(viaFailover.launched.length, 1);
		assert.deepEqual(failoverReceipt?.runtime.claude, {
			version: "2.1.300 (Claude Code)",
			path: claude,
			sha256: sha256(readFileSync(claude)),
			instances: [
				{ providerId: "claude-primary", label: "primary", expectedIdentityFingerprint: primary },
				{ providerId: "claude-secondary", label: "secondary", expectedIdentityFingerprint: secondary },
			],
			failover: { providerId: "claude-auto", label: "automatic", order: ["claude-primary", "claude-secondary"] },
		});
		assert.deepEqual(directReceipt?.runtime.claude, {
			version: "2.1.300 (Claude Code)",
			path: claude,
			sha256: sha256(readFileSync(claude)),
			instances: [{ providerId: "claude-primary", label: "primary", expectedIdentityFingerprint: primary }],
		});
		assert.ok(!JSON.stringify(failoverReceipt).includes(configDir), "the receipt never records configuration paths");
	});

	test("a Claude route whose CLI cannot report its version is a preflight rejection", async () => {
		const configDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-config-")));
		const config = join(configDir, "instances.json");
		writeFileSync(
			config,
			JSON.stringify({
				instances: [
					{
						providerId: "claude-primary",
						label: "primary",
						configRoot: configDir,
						expectedIdentityFingerprint: `sha256:${"1".repeat(64)}`,
					},
				],
			}),
			{ mode: 0o600 },
		);
		process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = config;
		process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable("claude", "#!/bin/sh\nexit 3\n");
		usePolicy((document) => {
			const route = { provider: "claude-primary", model: "opus", effort: "low" };
			document.roles.scout.routes.literal = route;
			document.pilotCases["scout-literal-1"].route = route;
		});
		const { run, launched } = harness();

		const result = await run([scout()]);

		assert.deepEqual(outcome(result, launched), {
			status: "policy_rejected",
			reason: "pilot_receipt_unavailable",
			launches: 0,
		});
		assert.equal(readPilotCase(store(), "scout-literal-1"), null);
	});

	test("a refused reservation refunds the call's earlier reservations and frees its spawn slots", async () => {
		const exhausted = reservePilotAttempt(store(), {
			caseId: "scout-code-graph-1",
			caseDigest: caseDigest("scout-code-graph-1"),
			allowed: 1,
			launchId: "elsewhere",
			receipt: {
				generation: "test-generation-v1",
				caseDigest: caseDigest("scout-code-graph-1"),
				controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
				runtime: {},
			},
		});
		assert.equal(exhausted.status, "reserved");
		const { run, launched } = harness();
		const slotsBefore = getLiveSlotCount();

		const result = await run([scout(), scout("scout-code-graph-1", { name: "graph-scout" })]);

		assert.deepEqual(
			{ ...outcome(result, launched), slots: getLiveSlotCount() },
			{ status: "policy_rejected", reason: "pilot_attempts_unavailable", launches: 0, slots: slotsBefore },
		);
		assert.deepEqual(attempts("scout-literal-1"), [{ launchId: "dispatch-1:0", outcome: "refunded", recovery: null }]);
	});

	test("a failed launch without proof it never started stays consumed for recovery; later siblings are refunded", async () => {
		const { run, launched } = harness({ failOnLaunch: { at: 1, error: new Error("spawn failed") } });
		const slotsBefore = getLiveSlotCount();

		await assert.rejects(run([scout(), scout("scout-code-graph-1", { name: "graph-scout" })]), /spawn failed/);

		assert.equal(launched.length, 0);
		assert.equal(getLiveSlotCount(), slotsBefore);
		const literal = attempts("scout-literal-1");
		assert.equal(literal?.[0]?.outcome, "pending");
		assert.match(literal?.[0]?.recovery ?? "", /spawn failed/);
		assert.deepEqual(attempts("scout-code-graph-1"), [{ launchId: "dispatch-1:1", outcome: "refunded", recovery: null }]);
	});

	test("a launched sibling is committed even when a later sibling fails", async () => {
		const { run } = harness({ failOnLaunch: { at: 2, error: new Error("spawn failed") } });

		await assert.rejects(run([scout(), scout("scout-code-graph-1", { name: "graph-scout" })]), /spawn failed/);

		assert.equal(attempts("scout-literal-1")?.[0]?.outcome, "committed");
		assert.equal(attempts("scout-code-graph-1")?.[0]?.outcome, "pending");
	});

	test("no tool sandbox can be rooted in the store, and no sandboxed tool can write its records", async (t) => {
		await harness().run([scout()]);
		const caseDir = join(store(), sha256("scout-literal-1"));
		for (const mode of ["read-only", "writer"] as const) {
			assert.equal(buildSandboxPlan({ mode, cwd: caseDir, ...protectedBrokerPaths() }).status, "rejected", mode);
		}
		if (probeSandbox().status !== "available") {
			t.skip("bubblewrap is not available on this host");
			return;
		}
		const receiptFile = join(caseDir, "reservation-1.json");
		const receiptBefore = readFileSync(receiptFile, "utf8");
		const launchKey = sha256("dispatch-1");
		const targets = [
			receiptFile,
			join(caseDir, "case.json"),
			join(caseDir, "reservation-1.outcome.json"),
			...["resume", "block", "verdict"].map((kind) => join(caseDir, `${kind}-${launchKey}-1.json`)),
		];
		const script = targets.map((target) => `if echo '{}' > ${JSON.stringify(target)}; then echo WROTE; fi`).join("; ");
		for (const mode of ["read-only", "writer"] as const) {
			const repo = writerRepo();
			const plan = buildSandboxPlan({ mode, cwd: repo.linked, ...protectedBrokerPaths() });
			assert.equal(plan.status, "ready", plan.status === "rejected" ? plan.message : "");
			if (plan.status !== "ready") return;

			const result = await runInSandbox(plan.args, ["/usr/bin/bash", "-c", script], { timeoutMs: 20_000 });

			assert.equal(result.stdout.toString().includes("WROTE"), false, `${mode}: ${result.stdout.toString()}`);
		}
		assert.equal(readFileSync(receiptFile, "utf8"), receiptBefore);
		assert.deepEqual(attempts("scout-literal-1"), [{ launchId: "dispatch-1", outcome: "committed", recovery: null }]);
		assert.equal(readPilotCase(store(), "scout-literal-1")?.reservations[0]?.records.length, 0);
	});

	test("a sibling refund is followed by a fresh Controller snapshot under the new launch id", async () => {
		const failing = harness({ failOnLaunch: { at: 1, error: new Error("spawn failed") } });
		await assert.rejects(failing.run([scout("scout-code-graph-1", { name: "graph-scout" }), scout()]), /spawn failed/);
		const refunded = readPilotCase(store(), "scout-literal-1")?.reservations[0];
		assert.equal(refunded?.outcome, "refunded");

		const retry = harness({ model: { provider: "openai-codex", id: "gpt-5.6-terra" }, thinking: "high" });
		await retry.run([scout()], "dispatch-2");

		const reservations = readPilotCase(store(), "scout-literal-1")?.reservations ?? [];
		assert.deepEqual(
			reservations.map((entry) => [entry.launchId, entry.outcome, entry.receipt.controller]),
			[
				["dispatch-1:1", "refunded", { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" }],
				["dispatch-2", "committed", { provider: "openai-codex", model: "gpt-5.6-terra", effort: "high" }],
			],
		);
		assert.deepEqual(reservations[0]?.receipt, refunded?.receipt);
	});

	test("a child whose steer-back wiring throws keeps its committed attempt; the next, never started, is refunded", async () => {
		const { run, launched } = harness({ failOnWire: { at: 1, error: new Error("wiring failed") } });
		const slotsBefore = getLiveSlotCount();

		await assert.rejects(run([scout(), scout("scout-code-graph-1", { name: "graph-scout" })]), /wiring failed/);

		assert.equal(launched.length, 1);
		assert.deepEqual(attempts("scout-literal-1"), [{ launchId: "dispatch-1:0", outcome: "committed", recovery: null }]);
		assert.deepEqual(attempts("scout-code-graph-1"), [{ launchId: "dispatch-1:1", outcome: "refunded", recovery: null }]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(getLiveSlotCount(), slotsBefore);
	});

	test("a Pi run by a generic runtime records the Pi package it runs, and an unknown entry fails closed", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-")));
		const pkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(pkg, "dist", "bundle", "chunks"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
		writeFileSync(join(pkg, "dist", "bundle", "cli.js"), "import './cli-runtime.js';\n");
		writeFileSync(join(pkg, "dist", "bundle", "cli-runtime.js"), "import './chunks/a.js';\n");
		writeFileSync(join(pkg, "dist", "bundle", "chunks", "a.js"), "export const a = 1;\n");
		const entry = join(pkg, "dist", "bundle", "cli.js");
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${entry}`;
		const files = ["bundle/chunks/a.js", "bundle/cli-runtime.js", "bundle/cli.js"];
		const distSha256 = sha256(files.map((file) => `${file}\0${sha256(readFileSync(join(pkg, "dist", file)))}\n`).join(""));

		await harness().run([scout()]);
		const before = readPilotCase(store(), "scout-literal-1")?.reservations[0]?.receipt.runtime.pi;
		writeFileSync(join(pkg, "dist", "bundle", "chunks", "a.js"), "export const a = 2;\n");
		usePolicyKeepingStore();
		await harness().run([scout("scout-code-graph-1")]);
		const after = readPilotCase(store(), "scout-code-graph-1")?.reservations[0]?.receipt.runtime.pi;
		// `pi` on PATH links straight to the package's CLI script.
		chmodSync(entry, 0o755);
		process.env.PI_SUBAGENT_PI_COMMAND = entry;
		usePolicy();
		await harness().run([scout()]);
		const direct = readPilotCase(store(), "scout-literal-1")?.reservations[0]?.receipt.runtime.pi as {
			entry: unknown;
			package: { version: string } | null;
		};
		const other = join(root, "not-pi.js");
		writeFileSync(other, "\n");
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${other}`;
		usePolicy();
		const unknown = harness();
		const rejected = await unknown.run([scout()]);

		assert.deepEqual(before, {
			command: realpathSync(process.execPath),
			commandSha256: sha256(readFileSync(process.execPath)),
			entry: { path: entry, sha256: sha256(readFileSync(entry)) },
			package: { name: "@earendil-works/pi-coding-agent", version: "9.9.9", distSha256 },
		});
		assert.notEqual(
			(after as { package: { distSha256: string } }).package.distSha256,
			distSha256,
			"a changed Pi chunk changes the recorded identity",
		);
		assert.deepEqual({ entry: direct?.entry, version: direct?.package?.version }, { entry: null, version: "9.9.9" });
		const rejectedWith = async (command: string) => {
			process.env.PI_SUBAGENT_PI_COMMAND = command;
			usePolicy();
			const attempt = harness();
			return outcome(await attempt.run([scout()]), attempt.launched);
		};
		const refused = { status: "policy_rejected", reason: "pilot_receipt_unavailable", launches: 0 };
		// A shell shim or `env` launcher hides which Pi it runs.
		assert.deepEqual(await rejectedWith(executable("pi-shim", "#!/bin/sh\nexec pi \"$@\"\n")), refused);
		assert.deepEqual(await rejectedWith(`/usr/bin/env node ${entry}`), refused);
		// A relative entry resolves against whichever directory the child starts in.
		const savedCwd = process.cwd();
		process.chdir(pkg);
		try {
			assert.deepEqual(await rejectedWith(`${process.execPath} dist/bundle/cli.js`), refused);
		} finally {
			process.chdir(savedCwd);
		}
		// A script of the package that is not in its digested dist tree.
		mkdirSync(join(pkg, "src"));
		writeFileSync(join(pkg, "src", "cli.js"), "\n");
		assert.deepEqual(await rejectedWith(`${process.execPath} ${join(pkg, "src", "cli.js")}`), refused);
		// A symlink in dist cannot be digested by content.
		symlinkSync(join(pkg, "package.json"), join(pkg, "dist", "linked.json"));
		assert.deepEqual(await rejectedWith(`${process.execPath} ${entry}`), refused);
		assert.deepEqual(outcome(rejected, unknown.launched), {
			status: "policy_rejected",
			reason: "pilot_receipt_unavailable",
			launches: 0,
		});
	});

	test("a Claude CLI is found only on absolute PATH entries, is hashed around its version run, and a bad config is not echoed", async () => {
		const configDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-config-")));
		const config = join(configDir, "instances.json");
		const instance = { providerId: "claude-primary", label: "primary", configRoot: configDir, expectedIdentityFingerprint: `sha256:${"1".repeat(64)}` };
		writeFileSync(config, JSON.stringify({ instances: [instance] }), { mode: 0o600 });
		process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = config;
		usePolicy((document) => {
			const route = { provider: "claude-primary", model: "opus", effort: "low" };
			document.roles.scout.routes.literal = route;
			document.pilotCases["scout-literal-1"].route = route;
		});
		const work = realpathSync(mkdtempSync(join(tmpdir(), "relative-path-")));
		const marker = join(work, "ran");
		mkdirSync(join(work, "relbin"));
		writeFileSync(join(work, "relbin", "claude"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho 1.0\n`);
		chmodSync(join(work, "relbin", "claude"), 0o755);
		const savedCwd = process.cwd();
		// Only the relative entry offers a claude; the system directories hold none.
		process.env.PATH = "relbin:/usr/bin:/bin";
		process.chdir(work);
		let relative: ToolResult;
		try {
			relative = await harness({ cwd: savedCwd }).run([scout()]);
		} finally {
			process.chdir(savedCwd);
		}
		const relativeExists = (() => {
			try {
				readFileSync(marker);
				return true;
			} catch {
				return false;
			}
		})();

		const shifting = executable("claude", "#!/bin/sh\necho 'echo changed' >> \"$0\"\necho 2.0\n");
		process.env.PI_CLAUDE_CODE_PROVIDER_PATH = shifting;
		const swapped = await harness().run([scout()], "dispatch-2");

		process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable("claude", "#!/bin/sh\necho 2.0\n");
		usePolicy((document) => {
			const route = { provider: "claude-auto", model: "opus", effort: "low" };
			document.roles.scout.routes.literal = route;
			document.pilotCases["scout-literal-1"].route = route;
		});
		defineProviders("claude-auto");
		writeFileSync(config, JSON.stringify({ instances: [], failover: { providerId: "claude-auto", label: "auto", order: [] } }));
		const emptyFailover = await harness().run([scout()], "dispatch-4");
		writeFileSync(config, '{"instances": sk-SECRETVALUE', { mode: 0o600 });
		const malformed = await harness().run([scout()], "dispatch-3");

		assert.equal(relative.details.reason, "pilot_receipt_unavailable");
		assert.equal(relativeExists, false, "a CLI on a relative PATH entry never runs");
		assert.equal(swapped.details.reason, "pilot_receipt_unavailable");
		assert.match(swapped.content[0]?.text ?? "", /changed/);
		assert.equal(malformed.details.reason, "pilot_receipt_unavailable");
		assert.equal(emptyFailover.details.reason, "pilot_receipt_unavailable");
		assert.doesNotMatch(malformed.content[0]?.text ?? "", /SECRET/);
		assert.equal(readPilotCase(store(), "scout-literal-1"), null);
	});

	test("a bootstrap proven never to have run stays consumed while its lease is not released", async () => {
		const handle = (launchId: string) => {
			const reservation = reservePilotAttempt(store(), {
				caseId: "scout-literal-1",
				caseDigest: caseDigest("scout-literal-1"),
				allowed: 5,
				launchId,
				receipt: {
					generation: "test-generation-v1",
					caseDigest: caseDigest("scout-literal-1"),
					controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
					runtime: {},
				},
			});
			assert.equal(reservation.status, "reserved");
			return reservation.status === "reserved" ? reservation.handle : assert.fail("not reserved");
		};
		const neverRan = new WriterSpawnError("bootstrap failed", true);
		let release!: (released: boolean) => void;
		const pending = new Promise<boolean>((resolve) => {
			release = resolve;
		});

		settleFailedPilotAttempt(handle("held"), neverRan, Promise.resolve(false));
		settleFailedPilotAttempt(handle("broken"), neverRan, Promise.reject(new Error("lease store failed")));
		settleFailedPilotAttempt(handle("waiting"), neverRan, pending);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const whileWaiting = attempts("scout-literal-1")?.find((entry) => entry.launchId === "waiting");
		release(true);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const byId = Object.fromEntries((attempts("scout-literal-1") ?? []).map((entry) => [entry.launchId, entry]));
		assert.equal(byId.held?.outcome, "pending");
		assert.match(byId.held?.recovery ?? "", /bootstrap failed/);
		assert.equal(byId.broken?.outcome, "pending");
		assert.match(byId.broken?.recovery ?? "", /bootstrap failed/);
		assert.deepEqual(whileWaiting, { launchId: "waiting", outcome: "pending", recovery: null }, "no refund before the lease is released");
		assert.equal(byId.waiting?.outcome, "refunded");
	});

	describe("pilot writers", () => {
		const workerCase = {
			role: "worker",
			capabilityClass: "implementation",
			artifact: "artifacts/worker-1.md",
			route: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
			resourceGrant: "isolated-child",
			attempts: { allowed: 1 },
			retry: "none",
			expires: "2999-01-01T00:00:00Z",
			acceptance: ["tests pass"],
		};

		beforeEach(() => {
			usePolicy((document) => {
				document.roles.worker.state = "pilot";
				document.pilotCases["worker-1"] = workerCase;
			});
		});

		function worker(cwd: string) {
			return {
				name: "task-worker",
				title: "Task work",
				task: "Do the task",
				agent: "pilot-worker",
				capabilityClass: "implementation",
				pilotCase: "worker-1",
				forcedCwd: cwd,
			};
		}

		test("a writer lease refusal after reservation refunds the attempt", async () => {
			const repo = writerRepo();
			const held = harness({ cwd: repo.main, agentDefs: { tools: undefined } });
			const leaseRoot = join(agentDir, "writer-leases");
			const { validateWriterWorktree } = await import("../../src/broker/writer-worktree.ts");
			const worktree = validateWriterWorktree(repo.linked, repo.main);
			assert.equal(worktree.status, "valid");
			if (worktree.status === "valid") {
				assert.equal(
					acquireWriterLease(leaseRoot, { worktree: worktree.worktree, launchId: "other", policyGeneration: "g" }).status,
					"acquired",
				);
			}

			const result = await held.run([worker(repo.linked)]);

			assert.deepEqual(outcome(result, held.launched), {
				status: "policy_rejected",
				reason: "writer_lease_held",
				launches: 0,
			});
			assert.deepEqual(attempts("worker-1"), [{ launchId: "dispatch-1", outcome: "refunded", recovery: null }]);
		});

		test("a confined bootstrap proven never to have run is refunded once its lease is released", async () => {
			const repo = writerRepo();
			const failing = harness({
				cwd: repo.main,
				agentDefs: { tools: undefined },
				failOnLaunch: { at: 1, error: new WriterSpawnError("bootstrap failed", true) },
			});

			await assert.rejects(failing.run([worker(repo.linked)]), /bootstrap failed/);
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.deepEqual(attempts("worker-1"), [{ launchId: "dispatch-1", outcome: "refunded", recovery: null }]);
			const retry = harness({ cwd: repo.main, agentDefs: { tools: undefined } });
			await retry.run([worker(repo.linked)], "dispatch-2");
			assert.equal(retry.launched.length, 1, "the refunded attempt and the released lease are usable again");
		});

		test("a confined bootstrap that may still run stays consumed for recovery", async () => {
			const repo = writerRepo();
			const failing = harness({
				cwd: repo.main,
				agentDefs: { tools: undefined },
				failOnLaunch: { at: 1, error: new WriterSpawnError("bootstrap unproven", false) },
			});

			await assert.rejects(failing.run([worker(repo.linked)]), /bootstrap unproven/);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const [attempt] = attempts("worker-1") ?? [];
			assert.equal(attempt?.outcome, "pending");
			assert.match(attempt?.recovery ?? "", /bootstrap unproven/);
		});
	});
});
