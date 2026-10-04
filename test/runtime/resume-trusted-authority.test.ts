import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ResumeRefusal, type ResumeServiceRuntime, resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir, writeExecutable } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { emptyAgentDir } from "../support/routing-policy.ts";
import { trustedSessionFixture } from "../support/trusted-sessions.ts";

function resumeRuntime(): ResumeServiceRuntime & { runningSubagents: Map<string, RunningSubagent> } {
	// Keep the host's routing policy out of these tests.
	process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
	const result = { name: "", task: "", summary: "", exitCode: 0, elapsed: 0 };
	return {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: async () => result,
		watchSubagent: async () => result,
		getWatcherSignal: (_running, controller) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map(),
	};
}

/** A fake `pi` that records the directory it started in. */
function captureChildCwd(): { file: string } {
	const dir = createTestDir();
	const file = join(dir, "child-cwd.txt");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "fake-pi", `#!/bin/sh\npwd > ${JSON.stringify(file)}\ncat > /dev/null\n`);
	return { file };
}

/** A fake tmux that logs every call, so a created surface is observable. */
function fakeTmux(): { log: string } {
	const dir = createTestDir();
	const binDir = join(dir, "bin");
	mkdirSync(binDir);
	const log = join(dir, "tmux.log");
	writeExecutable(
		binDir,
		"tmux",
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in new-window) printf '%%42\\n' ;; esac\n`,
	);
	process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "tmux";
	process.env.TMUX = "fake-tmux-socket";
	process.env.SHELL = "/bin/sh";
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "fake-pi", "#!/bin/sh\nexit 0\n");
	return { log };
}

async function readEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8");
			if (text) return text;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function assertRefused(promise: Promise<unknown>, reason: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ResumeRefusal, `expected a ResumeRefusal, got ${String(error)}`);
		assert.equal(error.reason, reason, error.message);
		return true;
	});
}

describe("trusted resume authority in the resume service", () => {
	it("refuses a trusted session on the ordinary resume path before creating a child", async () => {
		resetSpawnWidthForTest();
		const fixture = trustedSessionFixture();
		const capture = captureChildCwd();
		const runtime = resumeRuntime();
		await assertRefused(resumeSubagentSession({ sessionFile: fixture.sessionFile, task: "next" }, runtime), "trusted_session");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(capture.file), false);
		assert.equal(runtime.runningSubagents.size, 0);
	});

	it("refuses a trusted session holding an unparseable line on the ordinary resume path", async () => {
		resetSpawnWidthForTest();
		const fixture = trustedSessionFixture();
		// A torn write after a crash, or a child appending garbage to its own session.
		appendFileSync(fixture.sessionFile, '{"type":"custom","customType":\n');
		const capture = captureChildCwd();
		const runtime = resumeRuntime();
		await assertRefused(resumeSubagentSession({ sessionFile: fixture.sessionFile, task: "next" }, runtime), "trusted_session");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(capture.file), false);
		assert.equal(runtime.runningSubagents.size, 0);
	});

	it("refuses a trusted session whose launch entry escapes its custom type on the ordinary path", async () => {
		resetSpawnWidthForTest();
		const fixture = trustedSessionFixture();
		const escaped = readFileSync(fixture.sessionFile, "utf8").replace(
			'"customType":"pi-subagents_launch_metadata"',
			'"customType":"pi-subagents\\u005flaunch_metadata"',
		);
		writeFileSync(fixture.sessionFile, escaped);
		assert.ok(escaped.includes("\\u005f"));
		const capture = captureChildCwd();
		await assertRefused(
			resumeSubagentSession({ sessionFile: fixture.sessionFile, task: "next" }, resumeRuntime()),
			"trusted_session",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(capture.file), false);
	});

	it("resumes a background child in its persisted directory and keeps its launch identity", async () => {
		resetSpawnWidthForTest();
		const fixture = trustedSessionFixture({ generation: "generation-before-restart" });
		const capture = captureChildCwd();
		assert.notEqual(process.cwd(), fixture.cwd);
		const running = await resumeSubagentSession(
			{
				sessionFile: fixture.sessionFile,
				task: "next",
				// Ordinary caller fields cannot steer a trusted resume.
				name: "other-name",
				agent: "other-agent",
				mode: "interactive",
				model: "provider/other",
				trusted: fixture.expected,
			},
			resumeRuntime(),
		);
		assert.equal((await readEventually(capture.file)).trim(), fixture.cwd);
		assert.equal(running.mode, "background");
		assert.equal(running.name, "task-worker");
		assert.equal(running.agent, "worker");
		assert.equal(running.launchMetadata?.cwd, fixture.cwd);
		assert.equal(running.launchMetadata?.title, "Task worker");
		assert.deepEqual(running.launchMetadata?.trustedLaunch, fixture.provenance);
		assert.equal(running.launchMetadata?.modelSource, undefined);
	});

	it("resumes an interactive child in its persisted directory", async () => {
		resetSpawnWidthForTest();
		const fixture = trustedSessionFixture({ mode: "interactive" });
		const tmux = fakeTmux();
		const running = await resumeSubagentSession(
			{ sessionFile: fixture.sessionFile, task: "next", trusted: fixture.expected },
			resumeRuntime(),
		);
		assert.equal(running.mode, "interactive");
		assert.match(readFileSync(tmux.log, "utf8"), new RegExp(`cd '${fixture.cwd}'`));
		assert.deepEqual(running.launchMetadata?.trustedLaunch, fixture.provenance);
	});

	for (const mode of ["background", "interactive"] as const) {
		it(`refuses an invalid ${mode} resume before creating a child or surface`, async () => {
			resetSpawnWidthForTest();
			const tmux = fakeTmux();
			const capture = captureChildCwd();
			const moved = trustedSessionFixture({ mode });
			renameSync(moved.cwd, `${moved.cwd}-moved`);
			const mismatched = trustedSessionFixture({ mode });
			const runtime = resumeRuntime();
			await assertRefused(
				resumeSubagentSession({ sessionFile: moved.sessionFile, task: "next", trusted: moved.expected }, runtime),
				"effective_cwd_missing",
			);
			await assertRefused(
				resumeSubagentSession(
					{
						sessionFile: mismatched.sessionFile,
						task: "next",
						trusted: { ...mismatched.expected, effectiveCwd: createTestDir() },
					},
					runtime,
				),
				"effective_cwd_mismatch",
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(existsSync(tmux.log), false);
			assert.equal(existsSync(capture.file), false);
			assert.equal(runtime.runningSubagents.size, 0);
		});
	}
});
