import { once } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

/**
 * Characterizes how resume and timeout wrap-up choose the child's
 * PI_CODING_AGENT_DIR. The interactive cases read the launch capsule, which
 * keeps the inherited parent snapshot (`parentEnv`) apart from controlled
 * `overrides`, so a parent copy is visible separately from inheritance. The
 * background cases read the spawned child's env, where only a denied parent
 * value tells a copy apart from inheritance.
 *
 * Resume: persisted agent-config directory (profile), then a non-empty parent
 * value, then the persisted `env` value. Timeout wrap-up: profile, then the
 * persisted `env` value; it never copies the parent value.
 *
 * A fresh launch always persists a non-empty `agentConfigDir`, so the
 * `profile: ""` cases stand for legacy or hand-written metadata. Every value
 * here is synthetic: each case strips the ambient env to PATH and TMPDIR, so
 * the capsule never holds a live env, and HOME and the artifact root point
 * into the test directory so no case reads or writes the host's ~/.pi.
 */

const PROFILE_DIR = "/synthetic/profile-agent";
const PARENT_DIR = "/synthetic/parent-agent";
const OVERRIDE_DIR = "/synthetic/override-agent";
/** Ambient names a case keeps; everything else is removed and restored afterwards. */
const AMBIENT_KEEP = new Set(["PATH", "TMPDIR"]);

interface SelectionCase {
	/** Persisted agentConfigDir; "" means no profile. */
	profile: string;
	parent?: string;
	/** Persisted frontmatter env. */
	env?: string;
	denyEnv?: string;
	mode?: "interactive" | "background";
}

interface Capsule {
	parentEnv: Record<string, string>;
	overrides: Record<string, string>;
}

let ambient: NodeJS.ProcessEnv = {};
let dir = "";

function installFakeTmux(): void {
	ambient = { ...process.env };
	for (const key of Object.keys(process.env)) if (!AMBIENT_KEEP.has(key)) delete process.env[key];
	dir = createTestDir();
	const tmuxLog = join(dir, "tmux.log");
	writeFileSync(tmuxLog, "");
	writeExecutable(
		dir,
		"tmux",
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
	);
	const capsuleRoot = join(dir, "capsules");
	mkdirSync(capsuleRoot, { recursive: true });
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
	process.env.PATH = `${dir}:${ambient.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "tmux";
	process.env.TMUX = "fake-tmux-socket";
	process.env.SHELL = "/bin/sh";
	process.env.FAKE_TMUX_LOG = tmuxLog;
	process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
}

function restoreSavedEnv(): void {
	// Capsules hold the whole parent env snapshot; the fake tmux never consumes them.
	rmSync(join(dir, "capsules"), { recursive: true, force: true });
	for (const key of Object.keys(process.env)) if (!Object.hasOwn(ambient, key)) delete process.env[key];
	for (const [key, value] of Object.entries(ambient)) if (value !== undefined) process.env[key] = value;
}

function setParent(parent: string | undefined): void {
	if (parent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = parent;
}

function readCapsule(): Capsule {
	const log = readFileSync(join(dir, "tmux.log"), "utf8");
	const match = log.match(/run-child\.mjs' '([^']+)'/);
	assert.ok(match, "expected the command to invoke the capsule launcher");
	return JSON.parse(readFileSync(match[1], "utf8"));
}

/** Points the background launcher at a fake pi that records only PI_CODING_AGENT_DIR. */
function captureBackgroundAgentDir(): string {
	const captured = join(dir, "agent-dir.txt");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
		dir,
		"capture-pi",
		`#!/usr/bin/env bash\ncat > /dev/null\nprintf '[%s]' "\${PI_CODING_AGENT_DIR-<unset>}" > ${JSON.stringify(captured)}\n`,
	);
	return captured;
}

async function readCapturedEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(path)) {
			const value = readFileSync(path, "utf8");
			if (value) return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function metadata(input: SelectionCase): PersistedSubagentLaunchMetadata {
	const mode = input.mode ?? "interactive";
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "agent-dir-child",
		mode,
		sessionMode: mode === "background" ? "lineage-only" : "fork",
		...(mode === "background" ? { autoExit: true } : {}),
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: input.profile,
		cwd: dir,
		boundarySystemPrompt: false,
		...(input.env !== undefined ? { env: input.env } : {}),
		...(input.denyEnv ? { denyEnv: input.denyEnv } : {}),
	};
}

function writeSession(): string {
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	return sessionFile;
}

async function resume(input: SelectionCase): Promise<RunningSubagent> {
	const sessionFile = writeSession();
	await writeSubagentLaunchMetadataEntryForTest(sessionFile, metadata(input));
	setParent(input.parent);
	const quietResult = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	return resumeSubagentSession(
		{ sessionFile, task: "Agent-dir probe." },
		{
			isMuxAvailable: () => true,
			getShellReadyDelayMs: () => 0,
			watchBackgroundSubagent: quietResult,
			watchSubagent: quietResult,
			getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
			startWidgetRefresh: () => {},
			getContextWindow: () => undefined,
			runningSubagents: new Map<string, any>(),
		},
	);
}

async function resumeCapsule(input: SelectionCase): Promise<Capsule> {
	await resume(input);
	return readCapsule();
}

async function wrapUp(input: SelectionCase): Promise<RunningSubagent> {
	const sessionFile = writeSession();
	const running: RunningSubagent = {
		id: "agent-dir-child",
		name: "agent-dir-child",
		task: "Do the long task",
		mode: input.mode ?? "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: false,
		noSession: false,
		startTime: Date.now() - 8_000,
		sessionFile,
		timeoutBudget: { timeoutSeconds: 10 },
		timeoutWarnThreshold: 80,
		timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
		launchMetadata: metadata(input),
	};
	setParent(input.parent);
	await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
	return running;
}

async function wrapUpCapsule(input: SelectionCase): Promise<Capsule> {
	await wrapUp(input);
	return readCapsule();
}

describe("resume PI_CODING_AGENT_DIR selection", () => {
	beforeEach(installFakeTmux);
	afterEach(restoreSavedEnv);

	it("uses the persisted profile over the parent value and the persisted env", async () => {
		const capsule = await resumeCapsule({
			profile: PROFILE_DIR,
			parent: PARENT_DIR,
			env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}`,
		});
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PROFILE_DIR);
	});

	it("copies a non-empty parent value over the persisted env when no profile is set", async () => {
		const capsule = await resumeCapsule({
			profile: "",
			parent: PARENT_DIR,
			env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}`,
		});
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PARENT_DIR);
	});

	it("copies a non-empty parent value when no profile or env is set", async () => {
		const capsule = await resumeCapsule({ profile: "", parent: PARENT_DIR });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PARENT_DIR);
		assert.equal(capsule.parentEnv.PI_CODING_AGENT_DIR, PARENT_DIR, "the parent value is also inherited");
	});

	it("keeps the persisted env value when neither profile nor parent is set", async () => {
		const capsule = await resumeCapsule({ profile: "", env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}` });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, OVERRIDE_DIR);
	});

	it("keeps an empty persisted env value when the parent value is empty", async () => {
		const capsule = await resumeCapsule({ profile: "", parent: "", env: "PI_CODING_AGENT_DIR=" });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, "");
	});

	it("keeps an empty persisted env value when the parent is unset", async () => {
		const capsule = await resumeCapsule({ profile: "", env: "PI_CODING_AGENT_DIR=" });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, "");
	});

	it("leaves the name absent when nothing sets it", async () => {
		const capsule = await resumeCapsule({ profile: "" });
		assert.equal(Object.hasOwn(capsule.overrides, "PI_CODING_AGENT_DIR"), false);
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false);
	});

	it("still copies a parent value that persisted deny-env removes from the inherited snapshot", async () => {
		const capsule = await resumeCapsule({ profile: "", parent: PARENT_DIR, denyEnv: "PI_CODING_*" });
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false, "deny-env filters the snapshot");
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PARENT_DIR, "the override copy ignores deny-env");
	});

	it("still copies a parent value that PI_SUBAGENT_ENV_DENY removes from the inherited snapshot", async () => {
		process.env.PI_SUBAGENT_ENV_DENY = "PI_CODING_AGENT_DIR";
		const capsule = await resumeCapsule({ profile: "", parent: PARENT_DIR });
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false);
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PARENT_DIR);
	});

	it("gives a background child a parent value that deny-env removes from its inherited env", async () => {
		const captured = captureBackgroundAgentDir();
		const running = await resume({ profile: "", parent: PARENT_DIR, denyEnv: "PI_CODING_*", mode: "background" });
		assert.ok(running.childProcess);
		await once(running.childProcess!, "exit");
		assert.equal(await readCapturedEventually(captured), `[${PARENT_DIR}]`);
	});
});

describe("timeout wrap-up PI_CODING_AGENT_DIR selection", () => {
	beforeEach(installFakeTmux);
	afterEach(restoreSavedEnv);

	it("uses the persisted profile over the parent value and the persisted env", async () => {
		const capsule = await wrapUpCapsule({
			profile: PROFILE_DIR,
			parent: PARENT_DIR,
			env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}`,
		});
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, PROFILE_DIR);
	});

	it("keeps the persisted env value instead of copying the parent value", async () => {
		const capsule = await wrapUpCapsule({
			profile: "",
			parent: PARENT_DIR,
			env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}`,
		});
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, OVERRIDE_DIR);
	});

	it("keeps the persisted env value when neither profile nor parent is set", async () => {
		const capsule = await wrapUpCapsule({ profile: "", env: `PI_CODING_AGENT_DIR=${OVERRIDE_DIR}` });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, OVERRIDE_DIR);
	});

	it("does not copy the parent value into overrides; it only inherits it", async () => {
		const capsule = await wrapUpCapsule({ profile: "", parent: PARENT_DIR });
		assert.equal(Object.hasOwn(capsule.overrides, "PI_CODING_AGENT_DIR"), false);
		assert.equal(capsule.parentEnv.PI_CODING_AGENT_DIR, PARENT_DIR);
	});

	it("keeps an empty persisted env value", async () => {
		const capsule = await wrapUpCapsule({ profile: "", parent: PARENT_DIR, env: "PI_CODING_AGENT_DIR=" });
		assert.equal(capsule.overrides.PI_CODING_AGENT_DIR, "");
	});

	it("leaves the name absent when nothing sets it", async () => {
		const capsule = await wrapUpCapsule({ profile: "" });
		assert.equal(Object.hasOwn(capsule.overrides, "PI_CODING_AGENT_DIR"), false);
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false);
	});

	it("leaves a parent value that persisted deny-env removes absent from the child", async () => {
		const capsule = await wrapUpCapsule({ profile: "", parent: PARENT_DIR, denyEnv: "PI_CODING_*" });
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false);
		assert.equal(Object.hasOwn(capsule.overrides, "PI_CODING_AGENT_DIR"), false);
	});

	it("leaves a parent value that PI_SUBAGENT_ENV_DENY removes absent from the child", async () => {
		process.env.PI_SUBAGENT_ENV_DENY = "PI_CODING_AGENT_DIR";
		const capsule = await wrapUpCapsule({ profile: "", parent: PARENT_DIR });
		assert.equal(Object.hasOwn(capsule.parentEnv, "PI_CODING_AGENT_DIR"), false);
		assert.equal(Object.hasOwn(capsule.overrides, "PI_CODING_AGENT_DIR"), false);
	});

	it("leaves a parent value that deny-env removes absent from a background child", async () => {
		const captured = captureBackgroundAgentDir();
		const running = await wrapUp({ profile: "", parent: PARENT_DIR, denyEnv: "PI_CODING_*", mode: "background" });
		assert.ok(running.childProcess);
		await once(running.childProcess!, "exit");
		assert.equal(await readCapturedEventually(captured), "[<unset>]");
	});
});
