import { type AgentDefaults, getAgentConfigDir } from "../agents/definitions.ts";
import { checkToolBroker } from "../broker/preflight.ts";
import type { SandboxProbe } from "../broker/sandbox-run.ts";
import { probeWriterConfinement } from "../broker/writer-spawn.ts";
import { validateWriterWorktree, type WriterWorktree } from "../broker/writer-worktree.ts";
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
	/** The validated worktree of a managed writer; the launch phase leases it. */
	writerWorktree?: WriterWorktree;
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
	/** Host check that a writer can run as the init of its own PID namespace; defaults to the real probe. */
	probeWriterConfinement?: () => SandboxProbe;
};

/**
 * The directory a managed child process will run in, as the launcher resolves
 * it: a trusted `forcedCwd`, or else the parent's. The launcher never takes
 * `cwd` from call input, and a managed definition may not set one.
 */
function getChildCwd(child: SubagentParamsInput, parentCwd: string): string {
	return child.forcedCwd ? resolveSubagentCwd(child.forcedCwd, parentCwd) : parentCwd;
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

export function policyRejection(reason: string, message: string): ReturnType<typeof asSubagentToolResult> {
	return asSubagentToolResult({
		content: [{ type: "text", text: `Routing policy rejected the request: ${message}` }],
		details: { status: "policy_rejected", reason, message },
	});
}

type WriterCheck = { status: "valid"; worktree: WriterWorktree } | { status: "rejected"; reason: string; message: string };

/**
 * A managed writer runs only as a supervised background child, in its own
 * validated linked worktree, on a host that can confine it to its own PID
 * namespace. A pane child or a verified fan-out has no execution group that
 * one lease can cover.
 */
export function checkWriter(
	child: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	interactionMode: RoutingInteractionMode,
	options: RoutingOptions,
): WriterCheck {
	if (interactionMode === "interactive" || agentDefs?.llmAsVerifier === true) {
		return {
			status: "rejected",
			reason: "writer_requires_supervised_group",
			message: `agent ${child.agent} writes files, so it must run as a supervised background child, not ${interactionMode === "interactive" ? "in a pane" : "as a verified fan-out"}`,
		};
	}
	const worktree = validateWriterWorktree(getChildCwd(child, options.cwd), options.cwd);
	if (worktree.status === "invalid") {
		return {
			status: "rejected",
			reason: "writer_worktree_invalid",
			message: `agent ${child.agent} writes files, so it must run at the top of its own linked worktree of this repository: ${worktree.message}`,
		};
	}
	const confinement = (options.probeWriterConfinement ?? probeWriterConfinement)();
	if (confinement.status === "unavailable") {
		return {
			status: "rejected",
			reason: "writer_confinement_unavailable",
			message: `agent ${child.agent} cannot be confined to its own process group: ${confinement.message}`,
		};
	}
	return { status: "valid", worktree: worktree.worktree };
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
		const interactionMode = getInteractionMode(child, agentDefs, options);
		const authorization = authorizeLaunch({
			policyState,
			agent: child.agent,
			capabilityClass: child.capabilityClass,
			pilotCase: child.pilotCase,
			model: child.model,
			thinking: child.thinking,
			interactionMode,
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
		if (authorization.status !== "authorized") {
			routing.push({ launchId, evidence: { status: "unmanaged", reason: authorization.reason } });
			continue;
		}
		let writerWorktree: WriterWorktree | undefined;
		if (authorization.launch.toolBroker.mode === "writer") {
			const writer = checkWriter(child, agentDefs, interactionMode, options);
			if (writer.status === "rejected") return policyRejection(writer.reason, writer.message);
			writerWorktree = writer.worktree;
			if (routing.some((entry) => entry.writerWorktree?.gitDir === writerWorktree?.gitDir)) {
				return policyRejection(
					"writer_lease_held",
					`two writers of this call name the same worktree ${writerWorktree.top}; one worktree takes one writer`,
				);
			}
		}
		routing.push({
			launchId,
			policyLaunch: authorization.launch,
			evidence: authorization.evidence,
			...(writerWorktree ? { writerWorktree } : {}),
		});
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
