import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import type { ResumeServiceRuntime } from "../../src/runtime/resume-service.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { launchSubagentEntries } from "../../src/tools/subagent-launch.ts";
import type { SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../src/types.ts";
import { writeExecutable } from "./fixtures.ts";

const result: SubagentResult = { name: "w", task: "t", summary: "done", exitCode: 0, elapsed: 0 };

/**
 * A launch phase over fake process backends that still creates each child's
 * session file and launch metadata, as a real background launch does, so the
 * managed launch's snapshot and a later resume see real files.
 */
export function managedLaunchHarness(
	options: {
		cwd?: string;
		agentDefs?: Partial<AgentDefaults>;
		spawnChild?: () => ChildProcess;
		/** A standalone session: nothing seeds the file before the child writes it. */
		standalone?: boolean;
	} = {},
) {
	const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "managed-cwd-")));
	const sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "managed-sessions-")));
	const launched: RunningSubagent[] = [];
	const launch: SubagentToolRuntime["launchBackgroundSubagent"] = async (params) => {
		const sessionFile = join(sessionDir, `child-${launched.length + 1}.jsonl`);
		if (!options.standalone) writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: `session-${launched.length + 1}`, timestamp: new Date().toISOString(), cwd })}\n`,
		);
		const managed = params.policyLaunch;
		const running: RunningSubagent = {
			id: `child-${launched.length + 1}`,
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile,
			...(options.spawnChild ? { childProcess: options.spawnChild() } : {}),
			launchMetadata: {
				version: 1,
				timestamp: new Date().toISOString(),
				name: params.name,
				agent: params.agent,
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				...(managed ? { modelRef: `${managed.model}:${managed.thinking}` } : {}),
				tools: runtime.loadAgentDefaults(params.agent, cwd)?.tools,
				denyTools: [],
				noContextFiles: true,
				noSession: false,
				agentConfigDir: process.env.PI_CODING_AGENT_DIR ?? "",
				cwd,
				boundarySystemPrompt: true,
			},
		};
		if (running.launchMetadata && !options.standalone) writeSubagentLaunchMetadataEntry(sessionFile, running.launchMetadata);
		launched.push(running);
		return running;
	};
	const watch = async (): Promise<SubagentResult> => result;
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
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: { status: "started" } }),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [], details: {} }),
		probeSandbox: () => ({ status: "available" }),
		probeWriterConfinement: () => ({ status: "available" }),
	};
	const run = async (child: Record<string, unknown>, launchId = "dispatch-1") => {
		const phase = await launchSubagentEntries(
			[{ child: child as unknown as SubagentParamsInput, agentDefs: runtime.loadAgentDefaults(child.agent as string, cwd) }],
			{
				launchId,
				ctx: { hasUI: false, cwd, sessionManager: {}, model: { provider: "openai-codex", id: "gpt-6-sol" } } as never,
				pi: { getThinkingLevel: () => "medium" } as never,
				runtime,
				forceSynchronous: false,
			},
		);
		if (phase.status !== "launched") throw new Error(`launch was not committed: ${JSON.stringify(phase)}`);
		return phase.launched[0];
	};
	return { run, launched, cwd };
}

/** A fake `pi` that records its arguments, one per line, and its environment. */
export function capturePiInvocation(): { args: string; env: string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "managed-pi-")));
	const args = join(dir, "args");
	const env = join(dir, "env");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
		dir,
		"capture-pi",
		`#!/usr/bin/env bash\nenv > '${env}.tmp' && mv '${env}.tmp' '${env}'\nprintf '%s\\n' "$@" > '${args}.tmp' && mv '${args}.tmp' '${args}'\ncat >/dev/null\n`,
	);
	return { args, env };
}

export async function readEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (existsSync(path)) return readFileSync(path, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

export function resumeRuntime(): ResumeServiceRuntime & { runningSubagents: Map<string, RunningSubagent> } {
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

/** Write global agent definitions for the managed aliases, as pi-config installs them. */
export function writeManagedDefinition(agentDir: string, agent: string, frontmatter = "tools: read,grep,find,ls"): void {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", `${agent}.md`), `---\nname: ${agent}\ndescription: ${agent}\n${frontmatter}\n---\nWork.\n`);
}

export function writeManagedDefinitions(agentDir: string): void {
	for (const agent of ["pilot-worker", "pilot-scout"]) writeManagedDefinition(agentDir, agent);
}
