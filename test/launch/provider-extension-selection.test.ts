import { readdirSync } from "node:fs";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";
import { getPreparedExtensionLaunchArgs, prepareSubagentLaunch } from "../../src/launch/prep.ts";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { buildBackgroundLaunchPlan } from "../../src/launch/background.ts";
import { readSubagentLaunchMetadataEntries } from "../../src/session/session-files.ts";
import {
	assert,
	beforeEach,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";

const params = { name: "conditional-child", task: "work", title: "Conditional child", agent: "conditional" };

async function plan(agentDefs: AgentDefaults, options: { parentModelRef?: string; model?: string } = {}) {
	const cwd = createTestDir();
	return buildChildLaunchPlan({
		params: { ...params, ...(options.model ? { model: options.model } : {}) },
		agentDefs: { cwdBase: cwd, ...agentDefs },
		parentCwd: cwd,
		parentSessionDir: join(cwd, "sessions"),
		parentModelRef: options.parentModelRef,
	});
}

describe("provider-dependent child extensions", () => {
	beforeEach(() => {
		process.env.PI_CODING_AGENT_DIR = createTestDir();
	});

	it("appends matching sources after unconditional ones, in declaration order, without exact duplicates", async () => {
		const result = await plan({
			model: "claude-primary/opus",
			extensions: "/x/web.ts, /x/router.ts",
			providerExtensions: [
				{ provider: "claude-primary", source: "/x/provider.ts" },
				{ provider: "openai-codex", source: "/x/codex.ts" },
				{ provider: "claude-primary", source: "/x/router.ts" },
				{ provider: "claude-primary", source: "/x/after.ts" },
			],
		});
		assert.deepEqual(result.capability.extensions, ["/x/web.ts", "/x/router.ts", "/x/provider.ts", "/x/after.ts"]);
		assert.equal(result.providerExtensionAuthority?.provider, "claude-primary");
		assert.deepEqual(result.providerExtensionAuthority?.extensions, result.capability.extensions);
	});

	it("matches the exact, case-sensitive provider of the effective model", async () => {
		const declaration = { providerExtensions: [{ provider: "claude-primary", source: "/x/provider.ts" }] };
		const inherited = await plan({ ...declaration }, { parentModelRef: "claude-primary/opus" });
		assert.deepEqual(inherited.capability.extensions, ["/x/provider.ts"]);
		const otherCase = await plan({ ...declaration, model: "Claude-Primary/opus" });
		assert.deepEqual(otherCase.capability.extensions, []);
		const prefix = await plan({ ...declaration, model: "claude-primary-2/opus" });
		assert.deepEqual(prefix.capability.extensions, []);
	});

	it("turns off ambient discovery for a declaring agent even with no match", async () => {
		const declaration = { providerExtensions: [{ provider: "claude-primary", source: "/x/provider.ts" }] };
		for (const extensions of [undefined, "all", "none"]) {
			const result = await plan({ ...declaration, extensions, model: "anthropic/claude-haiku-4-5" });
			assert.deepEqual(result.capability.extensions, [], String(extensions));
			assert.equal(result.providerExtensionAuthority?.provider, "anthropic");
		}
	});

	it("resolves relative conditional sources from the definition directory, as unconditional ones", async () => {
		const result = await plan({
			model: "claude-primary/opus",
			cwdBase: "/defs",
			extensions: "./a.ts",
			providerExtensions: [
				{ provider: "claude-primary", source: "./a.ts" },
				{ provider: "claude-primary", source: "./b.ts" },
			],
		});
		assert.deepEqual(result.capability.extensions, ["/defs/a.ts", "/defs/b.ts"]);
	});

	it("fails before spawn when the effective model has no qualified provider", async () => {
		const declaration = { providerExtensions: [{ provider: "claude-primary", source: "/x/provider.ts" }] };
		await assert.rejects(plan({ ...declaration }), /provider-extensions.*qualified provider\/model/);
		await assert.rejects(plan({ ...declaration, model: "opus" }), /provider-extensions.*qualified provider\/model/);
		await assert.rejects(plan({ ...declaration, model: "/opus" }), /provider-extensions.*qualified provider\/model/);
		await assert.rejects(plan({ ...declaration, model: "claude-primary/" }), /provider-extensions.*qualified provider\/model/);
		await assert.rejects(plan({ ...declaration }, { parentModelRef: "opus" }), /provider-extensions.*qualified provider\/model/);
	});

	it("refuses freeform flags on a declaring agent, ignoring whitespace-only flags", async () => {
		const declaration = { providerExtensions: [{ provider: "claude-primary", source: "/x/provider.ts" }] };
		await assert.rejects(plan({ ...declaration, model: "claude-primary/opus", flags: "--model other/x" }), /provider-extensions.*flags/);
		const blank = await plan({ ...declaration, model: "claude-primary/opus", flags: "   " });
		assert.deepEqual(blank.capability.extensions, ["/x/provider.ts"]);
	});

	it("leaves agents without the declaration unchanged", async () => {
		const result = await plan({ extensions: "/x/web.ts", flags: "--verbose" }, { parentModelRef: "opus" });
		assert.deepEqual(result.capability.extensions, ["/x/web.ts"]);
		assert.equal(result.providerExtensionAuthority, undefined);
		assert.equal(result.effectiveModel, "opus");
		const all = await plan({}, { parentModelRef: "opus" });
		assert.equal(all.capability.extensions, undefined);
	});

	it("refuses a session mode that records no launch authority, and records it otherwise", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const ctx = {
			sessionManager: { getSessionFile: () => join(cwd, "parent.jsonl"), getSessionId: () => "parent" },
			cwd,
		};
		writeFileSync(join(cwd, "parent.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "p", timestamp: "t", cwd })}\n`);
		const write = (extra: string) =>
			writeFileSync(
				join(agentDir, "agents", "conditional.md"),
				`---\nname: conditional\nmodel: claude-primary/opus\nprovider-extensions: claude-primary=/x/provider.ts\n${extra}---\n\nBody.`,
			);
		write("session-mode: standalone\n");
		await assert.rejects(buildBackgroundLaunchPlan(params, ctx as never), /provider-extensions.*session-mode/);
		// Refused before seeding: no child session or extension sidecar is left behind.
		const leftovers = (readdirSync(cwd, { recursive: true }) as string[]).filter((file) => /\.(ext|jsonl)$/.test(file));
		assert.deepEqual(leftovers, ["parent.jsonl"]);
		write("");
		const plan = await buildBackgroundLaunchPlan(params, ctx as never);
		const [metadata] = readSubagentLaunchMetadataEntries(plan.launch.prepared.subagentSessionFile);
		assert.deepEqual(metadata?.providerExtensionAuthority, { provider: "claude-primary", extensions: ["/x/provider.ts"] });
	});

	it("emits --no-extensions with the completion helper for a no-match launch", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "conditional.md"),
			"---\nname: conditional\nmodel: anthropic/claude-haiku-4-5\nprovider-extensions: claude-primary=/x/provider.ts\n---\n\nBody.",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const prepared = await prepareSubagentLaunch(params, {
			sessionManager: { getSessionFile: () => join(cwd, "parent.jsonl"), getSessionId: () => "parent" },
			cwd,
		});
		// --provider stops Pi reading the model as a raw id on another provider.
		assert.deepEqual(getPreparedExtensionLaunchArgs(prepared, "/helper.ts"), [
			"--no-extensions",
			"-e",
			"/helper.ts",
			"--provider",
			"anthropic",
		]);
		assert.deepEqual(prepared.providerExtensionAuthority, { provider: "anthropic", extensions: [] });
	});
});
