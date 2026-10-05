import { type AgentDefaults, getAgentConfigDir } from "../agents/definitions.ts";
import { checkToolBroker } from "../broker/preflight.ts";
import type { SandboxProbe } from "../broker/sandbox-run.ts";
import { enforceAgentFrontmatter, resolveSubagentBlocking, shouldUseBackgroundLaunch } from "../launch/policy.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";
import { loadCanonicalPolicy, type RoutingInteractionMode } from "../routing/canonical-policy.ts";
import {
	authorizeLaunch,
	type ManagedRoutingEvidence,
	type PilotAttemptLedger,
} from "../routing/launch-authorization.ts";
import { verifyPolicyLaunch } from "../routing/resource-verification.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import type { PolicyLaunch, SubagentParamsInput } from "../types.ts";

export type SubagentRouting = {
	/** Identifies this child's launch to the pilot attempt ledger. */
	launchId: string;
	policyLaunch?: PolicyLaunch;
	evidence: ManagedRoutingEvidence | { status: "unmanaged"; reason: string };
};

type RoutingOptions = {
	/** The tool call id; batch children get `<id>:<index>`. */
	launchId: string;
	hasUI: boolean;
	/** Whether this session forces every launch to be awaited. */
	forceSynchronous: boolean;
	/** The parent session's working directory. */
	cwd: string;
	/** Host sandbox check; defaults to the real probe. */
	probeSandbox?: () => SandboxProbe;
};

/** The directory a child process will run in, as the launcher resolves it. */
function getChildCwd(child: SubagentParamsInput, parentCwd: string): string {
	if (child.forcedCwd) return child.forcedCwd;
	return child.cwd ? resolveSubagentCwd(child.cwd, parentCwd) : parentCwd;
}

/**
 * The interaction mode a child actually launches in: judged on the same
 * frontmatter-enforced params the launcher uses, after headless and startup
 * forcing, so extra caller fields cannot change it.
 */
function getInteractionMode(
	child: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	options: RoutingOptions,
): RoutingInteractionMode {
	const launched = enforceAgentFrontmatter(child, agentDefs);
	if (!shouldUseBackgroundLaunch(launched, agentDefs, options.hasUI)) return "interactive";
	if (resolveSubagentBlocking(launched, agentDefs) || options.forceSynchronous) return "synchronous";
	return "background";
}

function policyRejection(reason: string, message: string): ReturnType<typeof asSubagentToolResult> {
	return asSubagentToolResult({
		content: [{ type: "text", text: `Routing policy rejected the request: ${message}` }],
		details: { status: "policy_rejected", reason, message },
	});
}

/**
 * Authorize every child of one subagent call against the canonical routing
 * policy. Any rejection rejects the whole call before anything launches.
 */
export function authorizeSubagentLaunches(
	entries: readonly { child: SubagentParamsInput; agentDefs: AgentDefaults | null }[],
	options: RoutingOptions,
): SubagentRouting[] | ReturnType<typeof asSubagentToolResult> {
	const agentDir = getAgentConfigDir();
	const policyState = loadCanonicalPolicy(agentDir);
	const routing: SubagentRouting[] = [];
	for (const [index, { child, agentDefs }] of entries.entries()) {
		const launchId = entries.length === 1 ? options.launchId : `${options.launchId}:${index}`;
		const authorization = authorizeLaunch({
			policyState,
			agent: child.agent,
			capabilityClass: child.capabilityClass,
			pilotCase: child.pilotCase,
			model: child.model,
			thinking: child.thinking,
			interactionMode: getInteractionMode(child, agentDefs, options),
			agentDefs,
			now: Date.now(),
			agentDir,
		});
		if (authorization.status === "policy_rejected") {
			return policyRejection(authorization.reason, authorization.message);
		}
		if (authorization.status === "authorized") {
			const verification = verifyPolicyLaunch(authorization.launch, agentDir);
			if (verification.status === "rejected") return policyRejection(verification.reason, verification.message);
			const brokerFailure = checkToolBroker(
				getChildCwd(child, options.cwd),
				authorization.launch.toolBroker.mode,
				options.probeSandbox,
			);
			if (brokerFailure !== null) {
				return policyRejection(
					"tool_broker_unavailable",
					`agent ${child.agent} cannot run its tools in a credential-blind sandbox: ${brokerFailure}`,
				);
			}
		}
		routing.push(
			authorization.status === "authorized"
				? { launchId, policyLaunch: authorization.launch, evidence: authorization.evidence }
				: { launchId, evidence: { status: "unmanaged", reason: authorization.reason } },
		);
	}
	return routing;
}

/**
 * Reserve one attempt for every pilot child of an authorized call. When any
 * reservation is refused, the ones already taken are released and the whole
 * call is rejected.
 */
export function reservePilotAttempts(
	routing: readonly SubagentRouting[],
	ledger: PilotAttemptLedger,
): ReturnType<typeof asSubagentToolResult> | null {
	const reserved: SubagentRouting[] = [];
	for (const entry of routing) {
		const caseId = entry.evidence.status === "managed" ? entry.evidence.pilotCase : null;
		if (caseId === null) continue;
		const reservation = ledger.reserve(caseId, entry.launchId);
		if (reservation.status === "unavailable") {
			releasePilotAttempts(reserved, ledger);
			return policyRejection(
				"pilot_attempts_unavailable",
				`Pilot case ${caseId} has no attempt available: ${reservation.reason}`,
			);
		}
		reserved.push(entry);
	}
	return null;
}

/** Return the pilot attempts of children whose launch never started. */
export function releasePilotAttempts(routing: readonly SubagentRouting[], ledger: PilotAttemptLedger): void {
	for (const entry of routing) {
		if (entry.evidence.status === "managed" && entry.evidence.pilotCase !== null) {
			ledger.release(entry.evidence.pilotCase, entry.launchId);
		}
	}
}
