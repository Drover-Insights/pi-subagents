import { statSync } from "node:fs";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	rmSync,
	sleep,
	subagentDoneExtension,
} from "../support/index.ts";

function makeLongReport(): string {
	const body = Array.from({ length: 160 }, (_, i) => `finding line ${i} with enough detail to grow the report`).join("\n");
	return `REPORT-BEGIN-MARKER\n${body}\nREPORT-END-MARKER`;
}

interface ChildHarness {
	emit(event: string, payload: unknown, ctx?: unknown): void;
	tools: Map<string, any>;
	exitFile: string;
	cleanup(): void;
}

/** Load the real completion extension with every handler kept, as Pi does. */
function loadChild(env: { autoExit: boolean }): ChildHarness {
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	const saved = {
		session: process.env.PI_SUBAGENT_SESSION,
		autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
		surface: process.env.PI_SUBAGENT_SURFACE,
	};
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	if (env.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	else delete process.env.PI_SUBAGENT_AUTO_EXIT;
	delete process.env.PI_SUBAGENT_SURFACE;
	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool: (definition: { name: string }) => tools.set(definition.name, definition),
		on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		appendEntry() {},
		registerShortcut() {},
		registerCommand() {},
		sendUserMessage() {},
	} as any);
	return {
		emit(event, payload, ctx = { shutdown() {}, hasPendingMessages: () => false }) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
		tools,
		exitFile: `${sessionFile}.exit`,
		cleanup() {
			for (const [key, value] of [
				["PI_SUBAGENT_SESSION", saved.session],
				["PI_SUBAGENT_AUTO_EXIT", saved.autoExit],
				["PI_SUBAGENT_SURFACE", saved.surface],
			] as const) {
				if (value == null) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function runAutoExitChild(messages: unknown[]): { exitFile: string; cleanup(): void } {
	const child = loadChild({ autoExit: true });
	child.emit("agent_start", {});
	child.emit("agent_end", { messages });
	return child;
}

describe("subagent-done final report", () => {
	it("records the complete final report, not an intermediate turn or tool diagnostic, when an autonomous child completes", async () => {
		const report = makeLongReport();
		const { exitFile, cleanup } = runAutoExitChild([
			{ role: "user", content: [{ type: "text", text: "task" }] },
			{
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "INTERMEDIATE-MARKER checking files" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				],
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "TOOL-DIAGNOSTIC-MARKER" }] },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: report }] },
		]);
		try {
			await sleep(0);
			const sidecar = JSON.parse(readFileSync(exitFile, "utf8"));
			assert.equal(sidecar.type, "done");
			assert.equal(sidecar.finalReport, report);
			assert.equal(statSync(exitFile).mode & 0o777, 0o600, "the report-bearing sidecar must be private to its owner");
		} finally {
			cleanup();
		}
	});

	it("records no final report when the completed run ended without one", async () => {
		const { exitFile, cleanup } = runAutoExitChild([
			{ role: "user", content: [{ type: "text", text: "task" }] },
			{ role: "assistant", stopReason: "stop", content: [] },
		]);
		try {
			await sleep(0);
			const sidecar = JSON.parse(readFileSync(exitFile, "utf8"));
			assert.equal(sidecar.type, "done");
			assert.equal(sidecar.finalReport, undefined);
		} finally {
			cleanup();
		}
	});

	it("records the final report when a manual-lifecycle child completes through subagent_done", async () => {
		const report = makeLongReport();
		const child = loadChild({ autoExit: false });
		try {
			child.emit("agent_start", {});
			child.emit("message_end", {
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "text", text: report },
						{ type: "toolCall", id: "done", name: "subagent_done", arguments: {} },
					],
				},
			});
			await child.tools.get("subagent_done").execute("done", {}, undefined, undefined, { shutdown() {} });
			await sleep(0);
			const sidecar = JSON.parse(readFileSync(child.exitFile, "utf8"));
			assert.equal(sidecar.type, "done");
			assert.equal(sidecar.finalReport, report);
		} finally {
			child.cleanup();
		}
	});

	it("never attaches an earlier run's report to a later completion", async () => {
		const child = loadChild({ autoExit: false });
		try {
			child.emit("agent_start", {});
			child.emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "STALE-EARLIER-RUN" }] }],
			});
			child.emit("agent_start", {});
			child.emit("message_end", {
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "done", name: "subagent_done", arguments: {} }],
				},
			});
			await child.tools.get("subagent_done").execute("done", {}, undefined, undefined, { shutdown() {} });
			await sleep(0);
			const sidecar = JSON.parse(readFileSync(child.exitFile, "utf8"));
			assert.equal(sidecar.type, "done");
			assert.equal(sidecar.finalReport, undefined);
		} finally {
			child.cleanup();
		}
	});

	it("records no report when the child is shut down mid-run, so a half-finished turn is never presented as complete", async () => {
		const child = loadChild({ autoExit: true });
		try {
			child.emit("agent_start", {});
			child.emit("message_end", {
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "text", text: "INTERMEDIATE-MARKER checking files" },
						{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
					],
				},
			});
			// A timeout kill or a closed pane ends the session before the run finishes.
			child.emit("session_shutdown", {});
			await sleep(0);
			const sidecar = JSON.parse(readFileSync(child.exitFile, "utf8"));
			assert.equal(sidecar.type, "done");
			assert.equal(sidecar.finalReport, undefined);
		} finally {
			child.cleanup();
		}
	});
});
