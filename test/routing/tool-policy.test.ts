import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoutingPolicy } from "../../src/routing/policy.ts";
import {
	registerSubagentCoreTools,
	type SubagentToolRuntime,
} from "../../src/tools/subagent-tools.ts";
import type { SubagentResult } from "../../src/types.ts";

function registerTool(runtime: SubagentToolRuntime) {
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<unknown> }
	>();
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

function createRuntime(
	launch: SubagentToolRuntime["launchBackgroundSubagent"],
	allowModelOverride = true,
): SubagentToolRuntime {
	const watch = async (): Promise<SubagentResult> => ({
		name: "route-scout",
		task: "Map the route",
		summary: "done",
		exitCode: 0,
		elapsed: 0,
	});
	return {
		loadAgentDefaults: () => ({
			spawning: false,
			mode: "background",
			async: true,
			allowModelOverride,
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
		getLaunchedSubagentResult: async () => ({
			content: [],
			details: { status: "started" },
		}),
		stopRunningSubagent: async () => {},
		muxUnavailableResult: () => ({ content: [], details: {} }),
	};
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
	const tool = registerTool(createRuntime(launch));

	const result = (await tool.execute(
		"dispatch-tool-call",
		{
			name: "route-scout",
			title: "Route map",
			task: "Map the route",
			agent: "pilot-scout",
			capabilityClass: "scout.literal",
			risk: "low",
			model: "caller-override",
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

test("launches a valid routed request with the policy-selected model", async () => {
	let launchedParams:
		| Parameters<SubagentToolRuntime["launchBackgroundSubagent"]>[0]
		| undefined;
	const launch: SubagentToolRuntime["launchBackgroundSubagent"] = async (
		params,
	) => {
		launchedParams = params;
		return {
			id: "launched-child",
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile: "/tmp/launched-child.jsonl",
		};
	};
	const tool = registerTool(createRuntime(launch, false));
	const request = {
		dispatchId: "dispatch-tool-call",
		agent: "pilot-scout" as const,
		mode: "background" as const,
		capabilityClass: "scout.literal" as const,
		risk: "low" as const,
	};
	const route = resolveRoutingPolicy(request);

	const result = (await tool.execute(
		request.dispatchId,
		{
			name: "route-scout",
			title: "Route map",
			task: "Map the route",
			agent: request.agent,
			capabilityClass: request.capabilityClass,
			risk: request.risk,
			policyRoute: {
				model: "caller/smuggled-model",
				thinking: "xhigh",
			},
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
		{ result: result.details, launchedParams },
		{
			result: { status: "started" },
			launchedParams: {
				name: "route-scout",
				title: "Route map",
				task: "Map the route",
				agent: "pilot-scout",
				policyRoute: {
					model: route.logicalRoute,
					thinking: route.thinking,
				},
				async: false,
				blocking: true,
			},
		},
	);
});
