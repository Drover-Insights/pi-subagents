import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import { enforceAgentFrontmatter, resolveSubagentBlocking, shouldUseBackgroundLaunch } from "../launch/policy.ts";
import { parseSpawnEnv } from "../spawn/policy.ts";
import { getLaunchError, launchSubagentEntries, type SubagentToolRuntime } from "../tools/subagent-launch.ts";
import type { SubagentParamsInput } from "../types.ts";
import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchMode,
	type TrustedLaunchRejection,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
} from "./contract.ts";
import type { TrustedLauncher } from "./registry.ts";
import type { RunningSubagent } from "../types.ts";

export interface TrustedLauncherDeps {
	pi: ExtensionAPI;
	runtime: SubagentToolRuntime;
	/** The extension context of the session that published the descriptor. */
	ctx: ExtensionContext;
	/** Whether this session currently forces every launch to be awaited. */
	forceSynchronous: () => boolean;
}

function notStarted(reason: TrustedLaunchRejection, message: string): TrustedLaunchResultV1 {
	return { outcome: "not_started", reason, message };
}

/**
 * Definitions whose child would not run in, or not be recorded at, the
 * requested directory: a verified fan-out re-targets each candidate, a
 * definition cwd and shell task expansion use their own directory, and a
 * session-less child has no session identity to return.
 */
function getUnsupportedAgentReason(agentDefs: AgentDefaults): string | null {
	if (agentDefs.llmAsVerifier === true) return "verified fan-out agents";
	if (agentDefs.cwd) return "agents with a definition cwd";
	if (agentDefs.taskExpansion === "shell") return "agents with shell task expansion";
	if (agentDefs.noSession) return "agents without a session";
	return null;
}

/**
 * Launch one trusted request through the same launch phase as the
 * `subagent` tool. Every refusal happens before a child is created; a throw
 * from the launch itself surfaces as an unknown outcome.
 */
export function createTrustedLauncher(deps: TrustedLauncherDeps): TrustedLauncher {
	return async (request, owner) => {
		const { runtime } = deps;
		// Everything before the launch phase only reads definitions and
		// policy; a throw there means nothing was created.
		let prepared: { child: SubagentParamsInput; agentDefs: AgentDefaults; mode: TrustedLaunchMode };
		try {
			const checked = prepareTrustedChild(request, owner.generation, deps);
			if ("outcome" in checked) return checked;
			prepared = checked;
		} catch (error) {
			return notStarted(
				"preparation_failed",
				`Agent "${request.agent}" could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const { child, agentDefs, mode } = prepared;
		const phase = await launchSubagentEntries([{ child, agentDefs }], {
			launchId: `trusted:${request.requestId}`,
			ctx: deps.ctx,
			pi: deps.pi,
			runtime,
			forceSynchronous: deps.forceSynchronous(),
		});
		if (phase.status === "rejected") return notStarted(phase.reason, phase.message);
		const running = phase.launched[0];
		if (!owner.isLive()) {
			// The session retired the descriptor mid-launch; its shutdown sweep
			// may already have run, so this child would be orphaned.
			return stopUnaccountedChild(runtime, running, "descriptor_retired", "The descriptor was retired during the launch.");
		}
		const recordedCwd = running.launchMetadata?.cwd;
		if (running.mode !== mode || recordedCwd !== request.effectiveCwd) {
			return stopUnaccountedChild(
				runtime,
				running,
				"effective_cwd_mismatch",
				`The child was recorded in ${JSON.stringify(recordedCwd)} (${running.mode}), not ${JSON.stringify(request.effectiveCwd)} (${mode}).`,
			);
		}
		return {
			outcome: "launched",
			requestId: request.requestId,
			runId: running.id,
			sessionFile: running.sessionFile,
			mode,
			...(running.surface ? { surfaceId: running.surface } : {}),
			effectiveCwd: recordedCwd,
		};
	};
}

/** Request a stop for a child the caller cannot account for; its outcome stays unknown. */
export async function stopUnaccountedChild(
	runtime: Pick<SubagentToolRuntime, "stopRunningSubagent">,
	running: RunningSubagent,
	reason: string,
	message: string,
): Promise<Extract<TrustedLaunchResultV1, { outcome: "unknown" }>> {
	// A resolved stop is a request: closing a pane surface can fail silently.
	let stopOutcome = "A stop was requested; its termination is not confirmed.";
	try {
		await runtime.stopRunningSubagent(running);
	} catch (error) {
		stopOutcome = `The child may still be running: stopping it failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return {
		outcome: "unknown",
		reason,
		message: `${message} ${stopOutcome}`,
		partial: { runId: running.id, sessionFile: running.sessionFile },
	};
}

/** The checks a trusted request passes before the shared launch phase. */
function prepareTrustedChild(
	request: TrustedLaunchRequestV1,
	generation: string,
	deps: TrustedLauncherDeps,
): TrustedLaunchResultV1 | { child: SubagentParamsInput; agentDefs: AgentDefaults; mode: TrustedLaunchMode } {
	const { ctx, runtime } = deps;
	const agentDefs = runtime.loadAgentDefaults(request.agent, ctx.cwd);
	if (!agentDefs) return notStarted("agent_not_found", `Unknown agent "${request.agent}".`);
	const unsupported = getUnsupportedAgentReason(agentDefs);
	if (unsupported) {
		return notStarted("agent_unsupported", `Trusted launch does not support ${unsupported} ("${request.agent}").`);
	}
	const child: SubagentParamsInput = {
		name: request.name,
		title: request.title,
		task: request.task,
		agent: request.agent,
		...(request.capabilityClass ? { capabilityClass: request.capabilityClass } : {}),
		...(request.pilotCase ? { pilotCase: request.pilotCase } : {}),
		forcedCwd: request.effectiveCwd,
		trustedLaunch: {
			version: TRUSTED_LAUNCH_VERSION,
			generation,
			requestId: request.requestId,
			...(request.labels ? { labels: request.labels } : {}),
		},
	};
	const launchError = getLaunchError(child, agentDefs, parseSpawnEnv(process.env).callerAgent ?? undefined);
	if (launchError) return notStarted("launch_denied", launchError);
	const enforced = enforceAgentFrontmatter(child, agentDefs);
	const forceSynchronous = deps.forceSynchronous();
	if (forceSynchronous || resolveSubagentBlocking(enforced, agentDefs)) {
		return notStarted("synchronous_launch", "Trusted launch is asynchronous; this launch would be awaited.");
	}
	const mode = shouldUseBackgroundLaunch(enforced, agentDefs, ctx.hasUI) ? "background" : "interactive";
	if (mode !== request.mode) {
		return notStarted("mode_mismatch", `Agent "${request.agent}" launches ${mode} here, not ${request.mode}.`);
	}
	return { child, agentDefs, mode };
}
