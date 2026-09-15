import assert from "node:assert/strict";
import test from "node:test";
import { registerSubagentCoreTools, type SubagentToolRuntime } from "../../src/tools/subagent-tools.ts";

function registerTool(runtime: SubagentToolRuntime) {
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
	return tool;
}

test("returns a structured policy rejection before launch side effects", async () => {
	let launchCalls = 0;
	const launch = async () => {
		launchCalls++;
		return {
			id: "launched-child",
			name: "route-scout",
			task: "Map the route",
			title: "Route map",
			agent: "pilot-scout",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/launched-child.jsonl",
		};
	};
	const runtime = {
		loadAgentDefaults: () => ({ spawning: false, mode: "background", async: true }),
		resolveEffectiveSessionMode: () => "lineage-only",
		resolveTaskSessionMode: () => "lineage-only",
		launchBackgroundSubagent: launch,
		launchSubagent: launch,
		watchBackgroundSubagent: async () => ({ exitCode: 0 }),
		watchSubagent: async () => ({ exitCode: 0 }),
		getWatcherSignal: (_running, controller) => controller.signal,
		wireSubagentSteerBack: () => {},
		startWidgetRefresh: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: { status: "started" } }),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [], details: {} }),
	} as SubagentToolRuntime;
	const tool = registerTool(runtime);

	const result = (await tool.execute(
		"dispatch-tool-call",
		{
			name: "route-scout",
			title: "Route map",
			task: "Map the route",
			agent: "pilot-scout",
			capabilityClass: "scout.literal",
			risk: "low",
			model: "openai-codex/gpt-6-astra",
		},
		undefined,
		undefined,
		{
			hasUI: false,
			cwd: process.cwd(),
			sessionManager: {},
		},
	)) as { details: unknown };

	assert.deepEqual(
		{ details: result.details, launchCalls },
		{
			details: { status: "policy_rejected", reason: "prohibited_override" },
			launchCalls: 0,
		},
	);
});
