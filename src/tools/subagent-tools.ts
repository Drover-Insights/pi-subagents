import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stripInternalLaunchOverrides } from "../launch/launch-overrides.ts";
import { resolveSubagentBlocking, shouldUseBackgroundLaunch } from "../launch/policy.ts";
import { findRunningSubagent } from "../runtime/running-registry.ts";
import { getSpawnWidthLimit } from "../runtime/spawn-width.ts";
import {
	asSubagentToolResult,
	getCoordinatorOnlyTurnPrompt,
	getSubagentBatchStopMetadata,
} from "../runtime/state.ts";
import { parseSpawnEnv } from "../spawn/policy.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";

import { formatSubagentBatchLines, formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";
import { getBackgroundAutoExitWarning, getSubagentToolsWarning } from "./policy.ts";
import { registerSetTabTitleTool } from "./set-tab-title.ts";
import { getLaunchError, getSpawnWidthError, launchSubagentEntries, type SubagentToolRuntime } from "./subagent-launch.ts";
import { SubagentParams } from "./subagent-schema.ts";
import { SET_TAB_TITLE_TOOL_NAME, SUBAGENT_KILL_TOOL_NAME, SUBAGENT_TOOL_NAME } from "./tool-names.ts";

export { getSubagentNameError } from "../agents/titles.ts";
export type { SubagentToolRuntime } from "./subagent-launch.ts";
export { SubagentChildParams, SubagentParams } from "./subagent-schema.ts";

let initialPromptLaunchActive = isInitialPromptInvocation();

const SubagentKillParams = Type.Object({
	id: Type.String({
		description: "Running subagent id or display name to stop",
	}),
});

type ToolResult = ReturnType<typeof asSubagentToolResult>;

type SubagentToolParams = Partial<SubagentParamsInput> & {
	children?: SubagentParamsInput[];
};

function getRequestedChildren(params: SubagentToolParams): SubagentParamsInput[] {
	if (Array.isArray(params.children) && params.children.length > 0) {
		return params.children.map((child) => stripInternalLaunchOverrides(child));
	}
	return [stripInternalLaunchOverrides(params as SubagentParamsInput)];
}

function getBatchWidthValidationError(count: number, limit: number): ToolResult {
	return getSpawnWidthError(
		`Error: batch of ${count} subagents exceeds the spawn width limit of ${limit}. Launch fewer children in this batch.`,
	);
}

export function withToolWarning(result: ToolResult, warningPrefix: string): ToolResult {
	if (!warningPrefix) return result;
	const existingText = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	// Spread the original result so batch/turn-control fields like `terminate`
	// survive; only the text content is prepended with the warning.
	return asSubagentToolResult({
		...result,
		content: [{ type: "text", text: `${warningPrefix}\n\n${existingText}` }],
	});
}

export function isOneShotPromptInvocation(argv = process.argv): boolean {
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--print" || arg === "-p") return true;
		if (arg === "--mode" && (argv[i + 1] === "json" || argv[i + 1] === "rpc")) {
			return true;
		}
	}
	return false;
}

function hasInitialPromptArgument(argv = process.argv): boolean {
	const optionsWithValue = new Set([
		"--provider",
		"--model",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--mode",
		"--name",
		"-n",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--models",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
		"--extension",
		"-e",
		"--skill",
		"--prompt-template",
		"--theme",
		"--thinking",
		"--tui-mode",
		"--export",
		"--list-models",
	]);
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") return i + 1 < argv.length;
		if (optionsWithValue.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		if (arg.startsWith("@")) continue;
		return true;
	}
	return false;
}

export function isInitialPromptInvocation(argv = process.argv): boolean {
	return !isOneShotPromptInvocation(argv) && hasInitialPromptArgument(argv);
}

export function markInitialPromptLaunchComplete(): void {
	initialPromptLaunchActive = false;
}

/**
 * A session with no durable turn for later steer delivery: no UI, or a
 * one-shot `pi -p` / `--mode json|rpc` run. Every launch in it is awaited, so
 * no helper ever reports later.
 */
export function isHeadlessLaunchSession(hasUI: boolean, argv = process.argv): boolean {
	return !hasUI || isOneShotPromptInvocation(argv);
}

export function shouldForceSynchronousLaunch(hasUI: boolean, argv = process.argv): boolean {
	const startupPromptActive = argv === process.argv ? initialPromptLaunchActive : isInitialPromptInvocation(argv);
	return isHeadlessLaunchSession(hasUI, argv) || startupPromptActive;
}

function getAfterLaunchPrompt(): string {
	// The tool is registered before any extension context exists, so only the
	// argv-based one-shot check is available here. Background children are
	// `pi -p` processes, which is the case that matters.
	if (isOneShotPromptInvocation()) {
		return (
			"After launch:\n" +
			"- In this session every launch waits for the helper and returns its report as the tool result. Read the report and continue; do not redo delegated work.\n" +
			"- Ask the user only when there is a plausible next step but ownership is ambiguous.\n"
		);
	}
	return (
		"After launch:\n" +
		"- If a helper returns later, continue only with clearly independent work. Do not redo delegated work and do not claim the helper's findings before its later message appears.\n" +
		"- If no safe independent work is clear, stop your response and wait for the later helper message.\n" +
		"- Ask the user only when there is a plausible next step but ownership is ambiguous.\n" +
		"Results arrive automatically as a steer message that starts a new turn. " +
		"Do not poll, sleep-read, or check session files — the harness handles delivery.\n" +
		getCoordinatorOnlyTurnPrompt()
	);
}

function getToolWaitSignal(running: RunningSubagent, signal: AbortSignal | undefined): AbortSignal | undefined {
	return running.async === false ? undefined : signal;
}

export function registerSubagentCoreTools(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: SubagentToolRuntime,
): void {
	if (shouldRegister(SUBAGENT_TOOL_NAME))
		pi.registerTool({
			name: SUBAGENT_TOOL_NAME,
			label: "Subagent",
			description:
				"Launch one or more named helper agents from the subagent roster. " +
				"Agent definitions own model, tools, context, UI mode, wait behavior, and completion lifecycle; " +
				"this call chooses the agent name(s), task(s), and titles. " +
				"Model/thinking are routing controls, not quality knobs; set them only when the user named concrete values.",
			promptSnippet:
				"Subagents are separate helper processes you can launch to do work outside this chat turn.\n" +
				"\n" +
				"Use this tool when a listed agent is a clear fit for specialist, complex, or parallel work. Do small direct work yourself: quick answers, simple file reads, and tiny one-shot edits.\n" +
				"\n" +
				"Use exact agent names and behavior fields from the subagent roster when present; field meanings are defined in <subagent-rules>.\n" +
				"\n" +
				"How to call:\n" +
				"- Use exact roster names in agent fields.\n" +
				"- Always provide name and title. name is a machine handle: lower-kebab <scope>-<role>, 2-4 words, max 32 chars, e.g. auth-scout, diff-reviewer, session-tester. title is human prose: sentence case, 3-8 words, e.g. Auth implementation map.\n" +
				"- If launching one helper, pass agent/name/title/task normally.\n" +
				"- If launching multiple helpers for one user request, make one subagent call with children:[...] so all helpers start before any waiting happens.\n" +
				"- If the user names multiple agents, include each named agent exactly once. Do not substitute one agent for another.\n" +
				"- Leave model/thinking unset unless the user named concrete values. Do not infer them from quality, depth, urgency, safety, or cost language.\n" +
				"- For policy-managed agents, leave model and thinking unset even when the user names concrete values; the routing policy selects both.\n" +
				"\n" +
				"Writing tasks:\n" +
				"- Translate the user's request into each helper's task; do not change the work just because of the agent name.\n" +
				"- For non-trivial work, write readable Markdown with objective, scope, relevant files/facts, constraints, and requested output.\n" +
				"- For parallel helpers, make each task non-overlapping.\n" +
				"\n" +
				getAfterLaunchPrompt(),
			parameters: SubagentParams,
			execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
				const children = getRequestedChildren(params as SubagentToolParams);
				const widthLimit = getSpawnWidthLimit();
				if (children.length > widthLimit) return getBatchWidthValidationError(children.length, widthLimit);
				const currentAgent = parseSpawnEnv(process.env).callerAgent ?? undefined;
				const prepared = children.map((child) => {
					const agentDefs = runtime.loadAgentDefaults(child.agent, ctx.cwd);
					const error = getLaunchError(child, agentDefs, currentAgent);
					if (error) throw new Error(error);
					return {
						child,
						agentDefs,
						blocking: resolveSubagentBlocking(child, agentDefs),
						warning:
							getSubagentToolsWarning(agentDefs?.tools) ??
							getBackgroundAutoExitWarning(agentDefs, shouldUseBackgroundLaunch(child, agentDefs, ctx.hasUI)),
					};
				});
				const phase = await launchSubagentEntries(prepared, {
					launchId: toolCallId,
					ctx,
					pi,
					runtime,
					forceSynchronous: shouldForceSynchronousLaunch(ctx.hasUI),
				});
				if (phase.status === "rejected") return phase.result;
				const { launched, routing } = phase;
				const hasBlockingChild = prepared.some((entry) => entry.blocking);
				const warnings = prepared.map((entry) => entry.warning?.message ?? "");
				const warningPrefix = warnings.filter(Boolean).join("\n\n");
				if (launched.length === 1) {
					const result = await runtime.getLaunchedSubagentResult(launched[0], getToolWaitSignal(launched[0], signal));
					const details = { ...(result.details as Record<string, unknown>), routing: routing[0].evidence };
					return withToolWarning(asSubagentToolResult({ ...result, details }), warningPrefix);
				}

				const results = await Promise.all(
					launched.map((running) => runtime.getLaunchedSubagentResult(running, getToolWaitSignal(running, signal))),
				);
				const texts = results
					.flatMap((result) => result.content)
					.filter((block) => block.type === "text")
					.map((block) => block.text);
				const joined = texts.join("\n\n");
				return asSubagentToolResult({
					content: [
						{
							type: "text",
							text: warningPrefix ? `${warningPrefix}\n\n${joined}` : joined,
						},
					],
					details: {
						status: hasBlockingChild ? "batch" : "started",
						children: results.map((result, index) => ({
							...(result.details as Record<string, unknown>),
							task: prepared[index]?.child.task,
							title: prepared[index]?.child.title,
							agent: prepared[index]?.child.agent,
							name: (result.details as { name?: string } | undefined)?.name ?? prepared[index]?.child.name,
							routing: routing[index]?.evidence,
						})),
					},
					...getSubagentBatchStopMetadata(),
				});
			},
			renderCall(args, theme, context) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				const children = Array.isArray(args.children) ? args.children : undefined;
				if (children?.length) {
					const lines = [
						`▸ ${theme.fg("toolTitle", theme.bold("Spawn"))} ${theme.fg("toolTitle", theme.bold(`${children.length} agents`))}`,
						"",
					];
					children.forEach((child, index) => {
						if (index > 0) lines.push("");
						const agent = child.agent ? theme.fg("dim", ` (${child.agent})`) : "";
						lines.push(`${theme.fg("accent", theme.bold(child.name ?? "subagent"))}${agent}`);
						const taskPreview = formatTaskPreview(child.task, context, theme).replace(/^\n/, "");
						if (taskPreview) lines.push(taskPreview);
					});
					text.setText(lines.join("\n"));
					return text;
				}
				const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
				text.setText(
					"▸ " +
						theme.fg("toolTitle", theme.bold("Spawn")) +
						" " +
						theme.fg("accent", theme.bold(args.name ?? "subagent")) +
						agent +
						formatTaskPreview(args.task, context, theme),
				);
				return text;
			},
			renderResult(result, options, theme, context) {
				const details = result.details as { status?: string; children?: unknown[] } | undefined;
				if (details?.children) {
					if (details.status !== "batch") return new Text("", 0, 0);
					const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
					component.setText(`\n${formatSubagentBatchLines(result, context.args, options, theme).join("\n")}`);
					return component;
				}
				if (details?.status !== "completed" && details?.status !== "failed" && details?.status !== "cancelled") {
					return new Text("", 0, 0);
				}
				return renderSubagentCompletionText(
					result,
					options,
					theme,
					context.lastComponent instanceof Text ? context.lastComponent : undefined,
					true,
				);
			},
		});

	pi.registerTool({
		name: SUBAGENT_KILL_TOOL_NAME,
		label: "Kill Subagent",
		description: "Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		promptSnippet:
			"Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		parameters: SubagentKillParams,
		execute: async (_toolCallId, params) => {
			const match = findRunningSubagent(params.id);
			if (!match.running)
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: match.error ?? "Subagent not found.",
						},
					],
					details: { error: match.error ?? "not found" },
				});
			await runtime.stopRunningSubagent(match.running);
			return asSubagentToolResult({
				content: [
					{
						type: "text" as const,
						text: `Stopping subagent "${match.running.name}" (${match.running.id}).`,
					},
				],
				details: {
					id: match.running.id,
					name: match.running.name,
					status: "stopping",
				},
			});
		},
	});

	if (shouldRegister(SET_TAB_TITLE_TOOL_NAME)) registerSetTabTitleTool(pi);
}
