import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import {
	readSubagentLaunchMetadataEntries,
	seedSubagentSessionFile,
	writeSubagentLaunchMetadataEntry,
} from "../../src/session/session-files.ts";
import { readSubagentTimeoutSidecar, writeSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import {
	assert,
	createTestDir,
	existsSync,
	mkdirSync,
	readFileSync,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

const SPAWN_GRANT_VARS = [
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_SPAWN_DEPTH",
] as const;

const AUTHORITY = { provider: "claude-primary", extensions: ["/x/web.ts", "/x/provider.ts"] };

function baseMetadata(dir: string, overrides: Partial<PersistedSubagentLaunchMetadata>): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "researcher",
		agent: "researcher",
		mode: "background",
		sessionMode: "lineage-only",
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: true,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
		model: "claude-primary/opus",
		modelRef: "claude-primary/opus",
		modelSource: "agent",
		definitionModel: "claude-primary/opus",
		allowModelOverride: true,
		allowedModels: "claude-primary/sonnet, anthropic/claude-haiku-4-5",
		extensions: AUTHORITY.extensions,
		providerExtensionAuthority: AUTHORITY,
		...overrides,
	};
}

function writeSession(dir: string, entries: PersistedSubagentLaunchMetadata[]): string {
	const sessionFile = join(dir, `child-${Math.random().toString(16).slice(2)}.jsonl`);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	for (const entry of entries) writeSubagentLaunchMetadataEntry(sessionFile, entry);
	return sessionFile;
}

function runtime() {
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	return {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, unknown>(),
		modelRegistry: {
			getAvailable: () => [
				{ provider: "claude-primary", id: "opus" },
				{ provider: "claude-primary", id: "sonnet" },
				{ provider: "anthropic", id: "claude-haiku-4-5" },
			],
		},
	};
}

/** Resume with a fake `pi` that records its argv; returns the argv, or the refusal. */
async function resume(
	dir: string,
	sessionFile: string,
	input: { model?: string } = {},
): Promise<{ argv?: string[]; error?: Error; spawned: boolean }> {
	const argvFile = join(dir, `argv-${Math.random().toString(16).slice(2)}.txt`);
	const bin = writeExecutable(dir, "argv-pi", `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$ARGV_FILE"\n`);
	const saved = new Map<string, string | undefined>();
	for (const name of [...SPAWN_GRANT_VARS, "PI_SUBAGENT_PI_COMMAND", "ARGV_FILE"]) saved.set(name, process.env[name]);
	for (const name of SPAWN_GRANT_VARS) delete process.env[name];
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	process.env.ARGV_FILE = argvFile;
	const rt = runtime();
	try {
		const running = await resumeSubagentSession({ sessionFile, mode: "background", ...input }, rt as never);
		await new Promise((resolve) => running.childProcess?.once("exit", resolve));
		return { argv: readFileSync(argvFile, "utf8").trim().split("\n"), spawned: true };
	} catch (error) {
		return { error: error as Error, spawned: existsSync(argvFile) || rt.runningSubagents.size > 0 };
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function extensionArgs(argv: string[]): string[] {
	return argv.flatMap((arg, index) => (argv[index - 1] === "-e" ? [arg] : []));
}

function modelArg(argv: string[]): string | undefined {
	return argv[argv.indexOf("--model") + 1];
}

describe("provider-extensions resume authority", () => {
	it("resumes from the recorded provider and extension list", async () => {
		const dir = createTestDir();
		const result = await resume(dir, writeSession(dir, [baseMetadata(dir, {})]));
		assert.equal(result.error, undefined);
		assert.ok(result.argv?.includes("--no-extensions"));
		assert.deepEqual(extensionArgs(result.argv ?? []).slice(1), AUTHORITY.extensions);
		assert.equal(modelArg(result.argv ?? []), "claude-primary/opus");
		assert.equal(result.argv?.[result.argv.indexOf("--provider") + 1], "claude-primary");
	});

	it("records no new launch entry for a resume that changes nothing", async () => {
		const dir = createTestDir();
		const sessionFile = writeSession(dir, [baseMetadata(dir, {})]);
		const result = await resume(dir, sessionFile);
		assert.equal(result.error, undefined);
		assert.equal(readSubagentLaunchMetadataEntries(sessionFile).length, 1);
	});

	it("keeps the first entry's resources, flags and agent directory over later entries", async () => {
		const dir = createTestDir();
		const other = join(dir, "other-agent-dir");
		mkdirSync(other, { recursive: true });
		const sessionFile = writeSession(dir, [
			baseMetadata(dir, {}),
			baseMetadata(dir, {
				extensions: ["/x/web.ts", "/x/provider.ts", "/x/extra.ts"],
				providerExtensionAuthority: { provider: "claude-primary", extensions: ["/x/extra.ts"] },
				flags: "--model anthropic/claude-haiku-4-5",
				agentConfigDir: other,
			}),
		]);
		const result = await resume(dir, sessionFile);
		assert.equal(result.error, undefined);
		assert.deepEqual(extensionArgs(result.argv ?? []).slice(1), AUTHORITY.extensions);
		assert.ok(!result.argv?.includes("anthropic/claude-haiku-4-5"));
	});

	it("refuses a later entry that moves the session to another provider, before clearing any sidecar", async () => {
		const dir = createTestDir();
		const sessionFile = writeSession(dir, [
			baseMetadata(dir, {}),
			baseMetadata(dir, { model: "anthropic/claude-haiku-4-5", modelRef: "anthropic/claude-haiku-4-5" }),
		]);
		writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: false });
		const result = await resume(dir, sessionFile);
		assert.match(String(result.error?.message), /provider-extensions[\s\S]*claude-primary/);
		assert.equal(result.spawned, false);
		assert.notEqual(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("refuses a permitted model override that changes provider, and allows a same-provider one", async () => {
		const dir = createTestDir();
		const refused = await resume(dir, writeSession(dir, [baseMetadata(dir, {})]), { model: "anthropic/claude-haiku-4-5" });
		assert.match(String(refused.error?.message), /provider-extensions/);
		assert.equal(refused.spawned, false);
		const allowed = await resume(dir, writeSession(dir, [baseMetadata(dir, {})]), { model: "claude-primary/sonnet" });
		assert.equal(allowed.error, undefined);
		assert.equal(modelArg(allowed.argv ?? []), "claude-primary/sonnet");
		assert.deepEqual(extensionArgs(allowed.argv ?? []).slice(1), AUTHORITY.extensions);
	});

	it("keeps ignoring a model override when the agent locks its model", async () => {
		const dir = createTestDir();
		const sessionFile = writeSession(dir, [baseMetadata(dir, { allowModelOverride: false })]);
		const result = await resume(dir, sessionFile, { model: "anthropic/claude-haiku-4-5" });
		assert.equal(result.error, undefined);
		assert.equal(modelArg(result.argv ?? []), "claude-primary/opus");
	});

	it("refuses a recorded opt-in whose authority is missing or incompatible", async () => {
		const dir = createTestDir();
		const broken: Array<Partial<PersistedSubagentLaunchMetadata>> = [
			{ providerExtensionAuthority: { provider: "", extensions: [] } },
			{ providerExtensionAuthority: { provider: "claude-primary/opus", extensions: [] } },
			{ providerExtensionAuthority: { provider: "claude-primary" } as never },
			{ providerExtensionAuthority: "claude-primary" as never },
			{ flags: "--verbose" },
			{ model: undefined, modelRef: undefined },
			{ model: "opus", modelRef: "opus" },
		];
		for (const overrides of broken) {
			const result = await resume(dir, writeSession(dir, [baseMetadata(dir, overrides)]));
			assert.match(String(result.error?.message), /provider-extensions/, JSON.stringify(overrides));
			assert.equal(result.spawned, false, JSON.stringify(overrides));
		}
	});

	it("never opts a session in after launch", async () => {
		const dir = createTestDir();
		const legacy = baseMetadata(dir, { extensions: ["/x/old.ts"], providerExtensionAuthority: undefined });
		const forged = writeSession(dir, [
			legacy,
			baseMetadata(dir, { extensions: ["/x/old.ts"], providerExtensionAuthority: { provider: "anthropic", extensions: [] } }),
		]);
		const result = await resume(dir, forged, { model: "anthropic/claude-haiku-4-5" });
		assert.equal(result.error, undefined);
		assert.deepEqual(extensionArgs(result.argv ?? []).slice(1), ["/x/old.ts"]);
		assert.equal(modelArg(result.argv ?? []), "anthropic/claude-haiku-4-5");
		assert.ok(!result.argv?.includes("--provider"));
	});

	it("takes a forked child's authority from its own launch entry, not its parent's", async () => {
		const dir = createTestDir();
		const parentFile = writeSession(dir, [baseMetadata(dir, {})]);
		const parentLines = readFileSync(parentFile, "utf8").trim().split("\n");
		const parentId = JSON.parse(parentLines[parentLines.length - 1]).id;
		const message = { type: "message", id: "m1", parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } };
		writeFileSync(parentFile, `${JSON.stringify(message)}\n`, { flag: "a" });
		const childFile = join(dir, "forked-child.jsonl");
		seedSubagentSessionFile("fork", parentFile, childFile, dir);
		const own = baseMetadata(dir, {
			sessionMode: "fork",
			extensions: ["/x/own.ts"],
			providerExtensionAuthority: undefined,
			model: "anthropic/claude-haiku-4-5",
			modelRef: "anthropic/claude-haiku-4-5",
		});
		writeSubagentLaunchMetadataEntry(childFile, own);
		assert.deepEqual(
			readSubagentLaunchMetadataEntries(childFile).map((entry) => entry.extensions),
			[["/x/own.ts"]],
		);
		// The inherited entry keeps its id, so a compaction that kept it still finds it.
		const childIds = readFileSync(childFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).id);
		assert.ok(childIds.includes(parentId));
		const result = await resume(dir, childFile);
		assert.equal(result.error, undefined);
		assert.deepEqual(extensionArgs(result.argv ?? []).slice(1), ["/x/own.ts"]);
	});
});
