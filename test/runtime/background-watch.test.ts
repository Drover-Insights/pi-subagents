import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { cleanupNoSessionSessionFile } from "../../src/launch/prep.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
	subagentDoneExtension,
} from "../support/index.ts";

const dirs: string[] = [];

function makeRunning(sessionFile: string, childProcess: ChildProcess): RunningSubagent {
	return {
		id: "background-context",
		name: "Background context",
		task: "Report context",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		modelContextWindow: 200_000,
		modelRef: "zai/glm-5v-turbo:off",
		childProcess,
	};
}

function makeSession(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return createSessionFile(dir, [
		{
			type: "message",
			id: "assistant-final",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5v-turbo",
				content: [{ type: "text", text: "Finished the delegated work." }],
				usage: { totalTokens: 145_000 },
			},
		},
	]);
}

describe("background watcher final context usage", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("uses the exact context snapshot from the exit sidecar", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, {
			type: "done",
			contextTokens: 146_000,
			contextWindow: 210_000,
		});
		const resultPromise = watchBackgroundSubagent(
			makeRunning(sessionFile, child),
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, 146_000);
		assert.equal(result.contextWindow, 210_000);
	});

	it("falls back to the child session when the sidecar has no context snapshot", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const resultPromise = watchBackgroundSubagent(
			makeRunning(sessionFile, child),
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, 145_000);
		assert.equal(result.contextWindow, 200_000);
	});

	it("does not reuse assistant usage from before the current launch", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, child);
		running.launchEntryCount = 1;
		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, undefined);
		assert.equal(result.contextWindow, undefined);
	});

	it("omits fallback usage after a model switch", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, child);
		running.modelRef = "openai/gpt-5.6:off";
		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, undefined);
		assert.equal(result.contextWindow, undefined);
	});
});

function makeLongReport(): string {
	const body = Array.from({ length: 160 }, (_, i) => `finding line ${i} with enough detail to grow the report`).join("\n");
	return `REPORT-BEGIN-MARKER\n${body}\nREPORT-END-MARKER`;
}

/** A no-session child's temp file: seeded with parent context the in-memory child never loads. */
function makeSeededEphemeralSession(): { sessionFile: string; launchEntryCount: number } {
	const dir = createTestDir();
	dirs.push(dir);
	const sessionFile = createSessionFile(dir, [
		{
			type: "message",
			id: "parent-seed",
			message: { role: "assistant", content: [{ type: "text", text: "PARENT-SEED-MARKER" }] },
		},
	]);
	return { sessionFile, launchEntryCount: 1 };
}

async function finishEphemeralChild(
	sidecar: object | null,
	setup: (running: RunningSubagent) => void,
	exitCode = 0,
) {
	const { sessionFile, launchEntryCount } = makeSeededEphemeralSession();
	const child = new EventEmitter() as ChildProcess;
	if (sidecar) writeSubagentExitSidecar(sessionFile, sidecar);
	const running = makeRunning(sessionFile, child);
	running.noSession = true;
	running.launchEntryCount = launchEntryCount;
	setup(running);
	const resultPromise = watchBackgroundSubagent(
		running,
		{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
		new AbortController().signal,
	);
	child.emit("exit", exitCode);
	return { result: await resultPromise, sessionFile };
}

describe("background watcher ephemeral final report", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("delivers the complete final report of a no-session child without a timeout-warning threshold", async () => {
		const report = makeLongReport();
		assert.ok(report.length > 4000, "fixture must exceed the stdout tail bound");
		const { result, sessionFile } = await finishEphemeralChild({ type: "done", finalReport: report }, (running) => {
			running.stdoutTail = `${report}\n`.slice(-4000);
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.summary.includes("REPORT-END-MARKER"), "the report ending must arrive");
		assert.ok(result.summary.startsWith("REPORT-BEGIN-MARKER"), "the report opening must not be lost");
		assert.equal(result.summary, report);
		assert.equal(result.summarySource, "subagent");
		assert.equal(result.sessionFile, undefined, "an ephemeral child must not expose a session path");
		assert.equal(existsSync(sessionFile), false, "the temporary session file must be removed");
		assert.equal(existsSync(`${sessionFile}.exit`), false, "the report-bearing sidecar must be consumed");
	});

	it("does not present a bounded stdout tail as a complete report when the child recorded none", async () => {
		const { result } = await finishEphemeralChild({ type: "done" }, (running) => {
			running.stdoutTail = "...tail of something longer REPORT-END-MARKER\n";
		});

		assert.equal(result.summarySource, "runtime", "a stdout tail is a diagnostic, not the child's report");
		assert.match(result.summary, /no final report/i);
		assert.match(result.summary, /truncated/i);
		assert.ok(result.summary.includes("REPORT-END-MARKER"), "the diagnostic tail stays visible");
		assert.ok(!result.summary.includes("PARENT-SEED-MARKER"), "seeded parent context is never the child's report");
	});

	it("keeps the failure diagnostic and removes the temporary session when an ephemeral child fails", async () => {
		const { result, sessionFile } = await finishEphemeralChild(
			null,
			(running) => {
				running.stderrTail = "boom";
			},
			2,
		);

		assert.equal(result.exitCode, 2);
		assert.match(result.summary, /exited with code 2[\s\S]*boom/);
		assert.equal(result.summarySource, "runtime");
		assert.equal(result.sessionFile, undefined);
		assert.equal(existsSync(sessionFile), false);
	});

	it("keeps the exit code and stderr when an ephemeral child fails after printing stdout", async () => {
		const { result } = await finishEphemeralChild(
			null,
			(running) => {
				running.stdoutTail = "partial output";
				running.stderrTail = "boom";
			},
			2,
		);

		assert.equal(result.exitCode, 2);
		assert.match(result.summary, /exited with code 2[\s\S]*boom/);
		assert.equal(result.summarySource, "runtime");
	});

	it("removes a leftover exit sidecar with the temporary session", async () => {
		const { sessionFile, launchEntryCount } = makeSeededEphemeralSession();
		const child = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, child);
		running.noSession = true;
		running.launchEntryCount = launchEntryCount;
		const resultPromise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
			new AbortController().signal,
		);
		child.emit("exit", 0);
		await resultPromise;
		// A sidecar the parent could not consume, such as a torn write.
		writeFileSync(`${sessionFile}.exit`, '{"type":"done","finalReport":"partial');
		cleanupNoSessionSessionFile(running);

		assert.equal(existsSync(`${sessionFile}.exit`), false);
	});

	it("falls back to the recorded report when a persisted transcript has none", async () => {
		const report = makeLongReport();
		const dir = createTestDir();
		dirs.push(dir);
		const sessionFile = createSessionFile(dir, [
			{ type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "task" }] } },
		]);
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done", finalReport: report });
		const running = makeRunning(sessionFile, child);
		running.stdoutTail = `${report}\n`.slice(-4000);
		const resultPromise = watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.summary, report);
		assert.equal(result.summarySource, "subagent");
	});

	for (const variant of [
		{ label: "persistent", noSession: false, timeoutWarnThreshold: undefined },
		{ label: "persistent with timeout-warning wrap-up", noSession: false, timeoutWarnThreshold: 80 },
		{ label: "no-session with timeout-warning wrap-up", noSession: true, timeoutWarnThreshold: 80 },
	]) {
		it(`delivers the final report from the transcript, not an intermediate turn or tool diagnostic (${variant.label})`, async () => {
			const report = makeLongReport();
			const dir = createTestDir();
			dirs.push(dir);
			const sessionFile = createSessionFile(dir, [
				{
					type: "message",
					id: "assistant-progress",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "INTERMEDIATE-MARKER checking files" },
							{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
						],
					},
				},
				{
					type: "message",
					id: "tool-result",
					message: {
						role: "toolResult",
						toolCallId: "t1",
						toolName: "bash",
						content: [{ type: "text", text: "TOOL-DIAGNOSTIC-MARKER" }],
					},
				},
				{
					type: "message",
					id: "assistant-final",
					message: { role: "assistant", content: [{ type: "text", text: report }] },
				},
			]);
			const child = new EventEmitter() as ChildProcess;
			writeSubagentExitSidecar(sessionFile, { type: "done" });
			const running = makeRunning(sessionFile, child);
			running.noSession = variant.noSession;
			if (variant.timeoutWarnThreshold !== undefined) running.timeoutWarnThreshold = variant.timeoutWarnThreshold;
			running.stdoutTail = `${report}\n`.slice(-4000);
			const resultPromise = watchBackgroundSubagent(
				running,
				{ cleanupNoSessionSessionFile, terminateBackgroundChildProcess() {} },
				new AbortController().signal,
			);

			child.emit("exit", 0);
			const result = await resultPromise;

			assert.equal(result.summary, report);
			assert.equal(result.summarySource, "subagent");
			if (variant.noSession) {
				assert.equal(result.sessionFile, undefined);
				assert.equal(existsSync(sessionFile), false, "the temporary transcript must be removed");
			} else {
				assert.equal(result.sessionFile, sessionFile);
				assert.equal(existsSync(sessionFile), true, "a persistent session is kept");
			}
		});
	}
});

describe("background watcher pre-turn exit", () => {
	it("surfaces why a child exited before its prompt reached the model instead of reporting no output", async () => {
		const dir = createTestDir();
		const sessionFile = createSessionFile(dir, []);
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const originalSurface = process.env.PI_SUBAGENT_SURFACE;
		try {
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			delete process.env.PI_SUBAGENT_SURFACE;
			const handlers = new Map<string, any>();
			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool: (definition: unknown) => definition,
				on: (event: string, handler: any) => handlers.set(event, handler),
				appendEntry() {},
				registerShortcut() {},
				registerCommand() {},
			} as any);

			const child = new EventEmitter() as ChildProcess;
			const running = makeRunning(sessionFile, child);
			running.launchEntryCount = 1;
			const resultPromise = watchBackgroundSubagent(
				running,
				{ cleanupNoSessionSessionFile() {}, terminateBackgroundChildProcess() {} },
				new AbortController().signal,
			);
			// A routing extension handled the prompt, so Pi shut down cleanly
			// without ever starting the agent loop.
			handlers.get("session_shutdown")?.();
			child.emit("exit", 0);
			const result = await resultPromise;

			assert.equal(result.exitCode, 1);
			assert.notEqual(result.summary, "Background agent exited without output");
			assert.match(result.errorMessage ?? "", /before its task prompt reached the model/);
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
			else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
			if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
			else process.env.PI_SUBAGENT_SURFACE = originalSurface;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
