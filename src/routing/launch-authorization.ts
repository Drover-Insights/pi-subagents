import { join } from "node:path";
import type { AgentDefaults } from "../agents/definitions.ts";
import type { PolicyLaunch } from "../types.ts";
import type { CanonicalPolicyState, CanonicalRoutingPolicy, RoutingInteractionMode } from "./canonical-policy.ts";

/**
 * Launch authorization against the canonical routing policy. A child whose
 * agent name is a policy alias is managed: it launches only on its role's
 * fixed route and resources, or not at all.
 */

export type PilotAttemptLedger = {
	reserve(caseId: string, launchId: string): { status: "reserved" } | { status: "unavailable"; reason: string };
	/** Return an attempt whose launch never started. */
	release(caseId: string, launchId: string): void;
};

/** Fail-closed placeholder until durable pilot attempt accounting lands (#7). */
export const unavailablePilotAttemptLedger: PilotAttemptLedger = {
	reserve: () => ({ status: "unavailable", reason: "Durable pilot attempt accounting is not available yet." }),
	release: () => {},
};

type PolicyRejectionReason =
	| "policy_invalid"
	| "controller_child_forbidden"
	| "role_disabled"
	| "prohibited_override"
	| "missing_capability_class"
	| "capability_not_granted"
	| "interaction_mode_forbidden"
	| "recursive_spawning_forbidden"
	| "freeform_flags_forbidden"
	| "definition_env_forbidden"
	| "definition_cwd_forbidden"
	| "task_expansion_forbidden"
	| "verifier_forbidden"
	| "pilot_case_required"
	| "unknown_pilot_case"
	| "pilot_case_mismatch"
	| "pilot_case_expired"
	| "pilot_attempts_unavailable";

export type ManagedRoutingEvidence = Readonly<{
	status: "managed";
	generation: string;
	agent: string;
	role: string;
	state: string;
	capabilityClass: string;
	interactionMode: RoutingInteractionMode;
	pilotCase: string | null;
	route: Readonly<{ provider: string; model: string; effort: string }>;
	extensions: readonly string[];
	skills: readonly string[];
	projectResources: boolean;
	spawning: false;
	/** The definition's tool allowlist, or null when it inherits Pi's defaults. */
	tools: string | null;
}>;

export type LaunchAuthorization =
	| { status: "unmanaged"; reason: "policy_absent" | "not_a_policy_role" }
	| { status: "policy_rejected"; reason: PolicyRejectionReason; message: string }
	| { status: "authorized"; evidence: ManagedRoutingEvidence; launch: PolicyLaunch };

export type LaunchAuthorizationRequest = {
	policyState: CanonicalPolicyState;
	agent: string;
	capabilityClass?: string;
	pilotCase?: string;
	model?: string;
	thinking?: string;
	interactionMode: RoutingInteractionMode;
	agentDefs: Pick<
		AgentDefaults,
		"spawning" | "flags" | "taskExpansion" | "llmAsVerifier" | "env" | "cwd" | "tools"
	> | null;
	now: number;
	agentDir: string;
};

function reject(reason: PolicyRejectionReason, message: string): LaunchAuthorization {
	return { status: "policy_rejected", reason, message };
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function extensionPath(policy: CanonicalRoutingPolicy, id: string, agentDir: string): string {
	const entry = policy.extensionCatalog[id];
	return entry.source === "pi-config" ? join(agentDir, entry.files[0].path) : entry.source;
}

/**
 * Decide whether one child launch may proceed. Pure: pilot attempts are
 * reserved by the caller only once the whole call is authorized.
 */
export function authorizeLaunch(request: LaunchAuthorizationRequest): LaunchAuthorization {
	const { policyState, agent } = request;
	if (policyState.status === "invalid") return reject("policy_invalid", policyState.message);
	if (policyState.status === "absent") return { status: "unmanaged", reason: "policy_absent" };
	const policy = policyState.policy;
	if (!Object.hasOwn(policy.aliases, agent)) return { status: "unmanaged", reason: "not_a_policy_role" };

	const roleId = policy.aliases[agent];
	if (roleId === policy.defaultRole) {
		return reject("controller_child_forbidden", `Agent ${agent} maps to the ${roleId} role, which cannot run as a child.`);
	}
	const role = policy.roles[roleId];
	if (role.state === "disabled" || !role.childLaunch) {
		return reject("role_disabled", `Agent ${agent} maps to the ${roleId} role, which is disabled for child launches.`);
	}
	if (request.model !== undefined || request.thinking !== undefined) {
		return reject(
			"prohibited_override",
			`Agent ${agent} is policy-managed; omit model and thinking because the policy selects both.`,
		);
	}
	const capabilityClass = request.capabilityClass;
	if (capabilityClass === undefined) {
		return reject(
			"missing_capability_class",
			`Agent ${agent} requires a capabilityClass; the ${roleId} role grants ${role.modes.join(", ")}.`,
		);
	}
	if (!role.modes.includes(capabilityClass)) {
		return reject(
			"capability_not_granted",
			`The ${roleId} role does not grant capability class ${JSON.stringify(capabilityClass)}; it grants ${role.modes.join(", ")}.`,
		);
	}
	if (!role.allowedInteractionModes.includes(request.interactionMode)) {
		return reject(
			"interaction_mode_forbidden",
			`The ${roleId} role does not permit ${request.interactionMode} launches.`,
		);
	}
	const spawning = request.agentDefs?.spawning;
	if (spawning === true || (Array.isArray(spawning) && spawning.length > 0)) {
		return reject("recursive_spawning_forbidden", `Agent ${agent} is policy-managed and must not grant spawning.`);
	}
	if (request.agentDefs?.flags?.trim()) {
		return reject("freeform_flags_forbidden", `Agent ${agent} is policy-managed and must not set freeform flags.`);
	}
	if (request.agentDefs?.env?.trim()) {
		return reject(
			"definition_env_forbidden",
			`Agent ${agent} is policy-managed and must not set env, which can redirect the child runtime.`,
		);
	}
	if (request.agentDefs?.cwd?.trim()) {
		return reject(
			"definition_cwd_forbidden",
			`Agent ${agent} is policy-managed and must not set cwd, which can redirect the child agent directory.`,
		);
	}
	if (request.agentDefs?.taskExpansion === "shell") {
		return reject(
			"task_expansion_forbidden",
			`Agent ${agent} is policy-managed and must not run shell task expansion in the parent.`,
		);
	}
	if (request.agentDefs?.llmAsVerifier === true) {
		return reject(
			"verifier_forbidden",
			`Agent ${agent} is policy-managed and must not run verifier model calls outside the routing policy.`,
		);
	}

	let pilotCase: string | null = null;
	if (role.state === "pilot") {
		const caseId = request.pilotCase;
		if (caseId === undefined) {
			return reject("pilot_case_required", `The ${roleId} role is in pilot; name an approved pilotCase.`);
		}
		if (!Object.hasOwn(policy.pilotCases, caseId)) {
			return reject("unknown_pilot_case", `Pilot case ${JSON.stringify(caseId)} is not in the routing policy.`);
		}
		const record = policy.pilotCases[caseId];
		if (record.role !== roleId || record.capabilityClass !== capabilityClass) {
			return reject(
				"pilot_case_mismatch",
				`Pilot case ${caseId} covers ${record.role}/${record.capabilityClass}, not ${roleId}/${capabilityClass}.`,
			);
		}
		if (Date.parse(record.expires) <= request.now) {
			return reject("pilot_case_expired", `Pilot case ${caseId} expired at ${record.expires}.`);
		}
		pilotCase = caseId;
	}

	const route = role.routes[capabilityClass];
	const grant = policy.resourceGrants[role.resourceGrant];
	const grantedExtensions = policy.extensionGrants[roleId] ?? [];
	const loadedExtensions = [
		...policy.mandatoryExtensions.filter((id) => id !== "subagent-completion"),
		...grantedExtensions,
	];
	const launch: PolicyLaunch = {
		model: `${route.provider}/${route.model}`,
		thinking: route.effort,
		extensions: loadedExtensions.map((id) => extensionPath(policy, id, request.agentDir)),
		skills: grant.skills.length === 0 ? "none" : grant.skills.join(","),
		noContextFiles: !grant.projectResources,
	};
	const evidence: ManagedRoutingEvidence = deepFreeze({
		status: "managed",
		generation: policy.generation,
		agent,
		role: roleId,
		state: role.state,
		capabilityClass,
		interactionMode: request.interactionMode,
		pilotCase,
		route: { provider: route.provider, model: route.model, effort: route.effort },
		extensions: [...policy.mandatoryExtensions, ...grantedExtensions],
		skills: [...grant.skills],
		projectResources: grant.projectResources,
		spawning: false,
		tools: request.agentDefs?.tools ?? null,
	});
	return { status: "authorized", evidence, launch };
}

/**
 * The parent-side request gate for a child that is already running: every
 * later parent-authorized request re-runs launch authorization against the
 * current policy and requires the same evidence the launch recorded.
 * Revocation or drift blocks the request. Returns the blocking reason, or
 * null when the launch authority still holds.
 */
export function checkManagedChildRequest(
	policyState: CanonicalPolicyState,
	evidence: ManagedRoutingEvidence,
	now = Date.now(),
): string | null {
	const current = authorizeLaunch({
		policyState,
		agent: evidence.agent,
		capabilityClass: evidence.capabilityClass,
		pilotCase: evidence.pilotCase ?? undefined,
		interactionMode: evidence.interactionMode,
		agentDefs: evidence.tools === null ? null : { tools: evidence.tools },
		now,
		agentDir: "",
	});
	if (current.status === "unmanaged") return `the routing policy no longer manages agent ${evidence.agent}`;
	if (current.status === "policy_rejected") return current.message;
	if (current.evidence.generation !== evidence.generation) {
		return `the policy generation changed from ${evidence.generation} to ${current.evidence.generation} since launch`;
	}
	if (JSON.stringify(current.evidence) !== JSON.stringify(evidence)) {
		return `the launch authority of agent ${evidence.agent} changed since launch`;
	}
	return null;
}

/**
 * Resume of a policy-managed child fails closed until resume can prove it
 * preserves the launch authority (#8). Returns the blocking reason, or null.
 */
export function checkResumeRequest(policyState: CanonicalPolicyState, agent: string | undefined): string | null {
	if (policyState.status === "invalid") return `the routing policy is invalid: ${policyState.message}`;
	if (policyState.status === "absent" || agent === undefined || !Object.hasOwn(policyState.policy.aliases, agent)) {
		return null;
	}
	return `agent ${agent} is policy-managed and cannot be resumed until resume preserves its launch authority`;
}
