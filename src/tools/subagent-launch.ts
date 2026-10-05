import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import { getSubagentNameError } from "../agents/titles.ts";
import {
	enforceAgentFrontmatter,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	shouldUseBackgroundLaunch,
} from "../launch/policy.ts";
import type { SubagentLaunchContext } from "../launch/prep.ts";
import { type PilotAttemptLedger, unavailablePilotAttemptLedger } from "../routing/launch-authorization.ts";
import {
	claimSpawnWidthSlot,
	getLiveSlotCount,
	getSpawnWidthLimit,
	releaseSlots,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "../runtime/spawn-width.ts";
import { asSubagentToolResult, markSubagentBatchBlocking } from "../runtime/state.ts";
import { parseSpawnEnv, resolveSpawnPolicy } from "../spawn/policy.ts";
import type { SandboxProbe } from "../broker/sandbox-run.ts";
import type { PolicyLaunch, RunningSubagent, SubagentParamsInput, SubagentResult } from "../types.ts";
import { resolveVerifierCandidateCount } from "../vf/criteria.ts";
import { launchVerifiedFanOut } from "../vf/run/launch.ts";
import { applySynchronousLaunchPolicy } from "./policy.ts";
import {
	authorizeSubagentLaunches,
	releasePilotAttempts,
	reservePilotAttempts,
	type SubagentRouting,
} from "./subagent-routing.ts";

type ToolResult = ReturnType<typeof asSubagentToolResult>;

export interface SubagentToolRuntime {
	loadAgentDefaults(agentName: string | undefined, cwd: string): AgentDefaults | null;
	resolveEffectiveSessionMode(params: Partial<SubagentParamsInput>, defs: AgentDefaults | null): string;
	resolveTaskSessionMode(defs: AgentDefaults): string;
	launchBackgroundSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	launchSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	startWidgetRefresh(): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<ToolResult>;
	stopRunningSubagent(running: RunningSubagent): Promise<void>;
	muxUnavailableResult(action: string): unknown;
	/** Pilot attempt reservations; defaults to failing closed. */
	pilotAttempts?: PilotAttemptLedger;
	/** Host check for the managed-child tool sandbox; defaults to the real probe. */
	probeSandbox?: () => SandboxProbe;
}

export function getSpawnWidthError(text: string): ToolResult {
	return asSubagentToolResult({
		content: [{ type: "text" as const, text }],
		details: { error: "spawn_width" },
	});
}

function getSpawnWidthLimitError(limit: number): ToolResult {
	return getSpawnWidthError(
		`Spawn width limit reached (${getLiveSlotCount()}/${limit} slots busy). Wait for a running subagent to finish, or use subagent_kill to free a slot. Interactive children with auto-exit: false keep their slot until the pane closes.`,
	);
}

/** Name, title, agent requirement, and spawn-policy checks every launch passes first. */
export function getLaunchError(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	currentAgent: string | undefined,
): string | null {
	const nameError = getSubagentNameError(params.name);
	if (nameError) return nameError;
	if (!params.title?.trim())
		return "Error: title is required for subagent launches. Provide a short sentence-case title for the child session/widget.";
	const agentError = getSubagentAgentRequirementError(params, agentDefs);
	if (agentError) return agentError.content[0]?.text ?? "Agent requirement error";
	if (params.agent && currentAgent && params.agent === currentAgent) {
		return `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`;
	}
	const callerEnv = parseSpawnEnv(process.env);
	const spawnPolicy = resolveSpawnPolicy({
		callerAgent: callerEnv.callerAgent,
		targetAgent: params.agent ?? "",
		callerBudget: callerEnv.callerBudget,
		callerSpawnable: callerEnv.callerSpawnable,
		targetSpawning: agentDefs?.spawning ?? false,
		targetSpawnDepth: agentDefs?.spawnDepth,
		targetSpawnWidth: agentDefs?.spawnWidth,
		targetVisibleTo: agentDefs?.visibleTo ?? ["all"],
		envDepthCeiling: callerEnv.envDepthCeiling,
		envWidthCeiling: callerEnv.envWidthCeiling,
	});
	if (!spawnPolicy.allowed) return `Error: ${spawnPolicy.reason ?? "Spawn policy denied this target."}`;
	return null;
}

async function launchSubagentByMode(
	params: SubagentParamsInput,
	launchCtx: SubagentLaunchContext,
	runtime: SubagentToolRuntime,
	usesBackgroundLaunch: boolean,
): Promise<RunningSubagent> {
	const running = usesBackgroundLaunch
		? await runtime.launchBackgroundSubagent(params, launchCtx)
		: await runtime.launchSubagent(params, launchCtx);
	claimSpawnWidthSlot(running);
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	const watch = usesBackgroundLaunch ? runtime.watchBackgroundSubagent : runtime.watchSubagent;
	running.completionPromise = releaseSpawnWidthSlotOnCompletion(
		running,
		watch(running, runtime.getWatcherSignal(running, watcherAbort)),
	);
	return running;
}

function buildSubagentLaunchContext(
	launchId: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	autoExit: true | undefined,
): SubagentLaunchContext {
	const parentModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	return {
		sessionManager: ctx.sessionManager,
		cwd: ctx.cwd,
		launchToolCallId: launchId,
		autoExit,
		modelRegistry: ctx.modelRegistry,
		parentModelRef,
		parentThinking: pi.getThinkingLevel() as string,
	};
}

async function launchOneSubagent(
	launchId: string,
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	options: SubagentLaunchOptions,
	policyLaunch?: PolicyLaunch,
): Promise<RunningSubagent> {
	const { ctx, pi, runtime } = options;
	const effectiveParams = enforceAgentFrontmatter(params, agentDefs);
	if (policyLaunch) {
		effectiveParams.policyLaunch = policyLaunch;
	}
	// In print/prompt-style runs there is no durable parent turn for async steer
	// delivery. Force blocking and record the batch as blocking too, so a stop
	// requested from frontmatter cannot attach `terminate` to the completed
	// result before the model reads the report it just waited for.
	const usesBackgroundLaunch = shouldUseBackgroundLaunch(effectiveParams, agentDefs, ctx.hasUI);
	const headlessAutoExit = applySynchronousLaunchPolicy(
		effectiveParams,
		agentDefs,
		usesBackgroundLaunch,
		options.forceSynchronous,
	);

	const launchCtx = buildSubagentLaunchContext(launchId, ctx, pi, headlessAutoExit);
	if (agentDefs?.llmAsVerifier === true) {
		// One logical child fronts the whole fan-out: N candidates are planned
		// here and owned by a detached supervisor; no per-candidate routes are
		// ever registered in this parent.
		const { running } = await launchVerifiedFanOut(effectiveParams, agentDefs, launchCtx, {
			slotsPreReserved: true,
		});
		return running;
	}
	return launchSubagentByMode(effectiveParams, launchCtx, runtime, usesBackgroundLaunch);
}

export interface SubagentLaunchEntry {
	child: SubagentParamsInput;
	agentDefs: AgentDefaults | null;
}

export interface SubagentLaunchOptions {
	/** The tool call id or trusted request id; batch children get `<id>:<index>`. */
	launchId: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	runtime: SubagentToolRuntime;
	/** Whether this session forces every launch to be awaited. */
	forceSynchronous: boolean;
}

export type SubagentLaunchPhase =
	| { status: "launched"; launched: RunningSubagent[]; routing: SubagentRouting[] }
	| {
			status: "rejected";
			reason: "policy_rejected" | "pilot_attempts_unavailable" | "spawn_width";
			message: string;
			result: ToolResult;
	  };

function rejectedPhase(result: ToolResult): SubagentLaunchPhase {
	const details = result.details as { reason?: string; error?: string };
	const message = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
	if (details.error === "spawn_width") return { status: "rejected", reason: "spawn_width", message, result };
	const reason = details.reason === "pilot_attempts_unavailable" ? details.reason : "policy_rejected";
	return { status: "rejected", reason, message, result };
}

/**
 * The launch phase every child goes through, from the `subagent` tool or a
 * trusted extension: policy-bound authorization, spawn-width slots, pilot
 * attempts, the launch itself, and result routing. A rejection launches
 * nothing; a throw comes from the launch itself, after reservations were
 * returned for every child that did not start.
 */
export async function launchSubagentEntries(
	entries: readonly SubagentLaunchEntry[],
	options: SubagentLaunchOptions,
): Promise<SubagentLaunchPhase> {
	const { ctx, pi, runtime } = options;
	const routing = authorizeSubagentLaunches(entries, {
		launchId: options.launchId,
		hasUI: ctx.hasUI,
		forceSynchronous: options.forceSynchronous,
		cwd: ctx.cwd,
		...(runtime.probeSandbox ? { probeSandbox: runtime.probeSandbox } : {}),
	});
	if (!Array.isArray(routing)) return rejectedPhase(routing);
	// Slot cost per child: 1 normally, N candidates for a verified
	// fan-out (SPEC: N candidates consume N spawn slots, reserved
	// atomically before any worktree creation or verifier spend).
	const slotCosts = entries.map((entry) =>
		entry.agentDefs?.llmAsVerifier === true
			? resolveVerifierCandidateCount(entry.agentDefs.llmAsVerifierCandidates)
			: 1,
	);
	const totalSlots = slotCosts.reduce((sum, cost) => sum + cost, 0);
	const widthLimit = getSpawnWidthLimit();
	if (!tryAcquireSlots(totalSlots, widthLimit)) return rejectedPhase(getSpawnWidthLimitError(widthLimit));
	const pilotAttempts = runtime.pilotAttempts ?? unavailablePilotAttemptLedger;
	const reservationRejection = reservePilotAttempts(routing, pilotAttempts);
	if (reservationRejection) {
		releaseSlots(totalSlots);
		return rejectedPhase(reservationRejection);
	}
	let unlaunchedSlots = totalSlots;
	const launched: RunningSubagent[] = [];
	try {
		if (entries.length > 1 && entries.some((entry) => resolveSubagentBlocking(entry.child, entry.agentDefs))) {
			markSubagentBatchBlocking();
		}
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const running = await launchOneSubagent(
				routing[index].launchId,
				entry.child,
				entry.agentDefs,
				options,
				routing[index].policyLaunch,
			);
			const evidence = routing[index].evidence;
			if (evidence.status === "managed") {
				running.routing = evidence;
				running.policyLaunch = routing[index].policyLaunch;
			}
			unlaunchedSlots -= slotCosts[index];
			launched.push(running);
			runtime.wireSubagentSteerBack(pi, running, running.completionPromise as Promise<SubagentResult>);
		}
	} catch (error) {
		releaseSlots(unlaunchedSlots);
		releasePilotAttempts(routing.slice(launched.length), pilotAttempts);
		throw error;
	}
	runtime.startWidgetRefresh();
	return { status: "launched", launched, routing };
}
