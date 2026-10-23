/**
 * The resume service's managed branch: decides whether a session is
 * policy-managed and, when it is, the narrowed authority it resumes with.
 * A recorded launch snapshot makes a session managed whatever its own
 * metadata says; a session whose metadata names a policy alias without one
 * is refused as missing its snapshot.
 */
import { getAgentConfigDir, loadAgentDefaults } from "../agents/definitions.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";
import { getManagedResourceLaunchArgs, getPersistedPromptLaunchArgs } from "../launch/prep.ts";
import { loadCanonicalPolicy } from "../routing/canonical-policy.ts";
import { abandonGeneration, claimNextGeneration, type GenerationTicket } from "../routing/managed-ownership.ts";
import {
	authorizeManagedResume,
	recordPilotResume,
	type ManagedResumeAuthority,
	readManagedSnapshot,
} from "../routing/managed-resume-authority.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import { ResumeRefusal } from "./resume-refusal.ts";

export type ManagedResumeDecision =
	| { status: "unmanaged" }
	| { status: "refused"; message: string }
	| Extract<ManagedResumeAuthority, { status: "authorized" }>;

export function decideManagedResume(input: {
	sessionFile: string;
	sessionAgent: string | undefined;
	caller: { model?: string; thinking?: string; mode?: string };
	trustedLaunchRequestId?: string;
}): ManagedResumeDecision {
	const agentDir = getAgentConfigDir();
	const policyState = loadCanonicalPolicy(agentDir);
	if (policyState.status === "invalid") {
		return { status: "refused", message: `Routing policy blocked the request: the routing policy is invalid: ${policyState.message}.` };
	}
	const read = readManagedSnapshot(agentDir, input.sessionFile);
	const claimsAlias =
		policyState.status === "loaded" &&
		input.sessionAgent !== undefined &&
		Object.hasOwn(policyState.policy.aliases, input.sessionAgent);
	if (read.status === "missing" && !claimsAlias) return { status: "unmanaged" };
	const recorded = read.status === "found" ? read.snapshot : undefined;
	// A managed definition comes only from the global directory, as at launch.
	const definition = recorded
		? loadAgentDefaults(
				recorded.evidence.agent,
				undefined,
				recorded.metadata.blueprintCwd ?? recorded.metadata.cwd,
				resolveSubagentCwd,
				{ globalOnly: true },
			)
		: null;
	// The declaration is unmanaged-only; a managed resume must not ignore it silently.
	if (definition?.providerExtensions) {
		return {
			status: "refused",
			message: `Routing policy blocked the resume: policy-managed agent ${recorded?.evidence.agent} must not set provider-extensions.`,
		};
	}
	const authority = authorizeManagedResume({
		sessionFile: input.sessionFile,
		policyState,
		agentDir,
		caller: input.caller,
		trustedLaunchRequestId: input.trustedLaunchRequestId,
		definition: definition
			? {
					tools: definition.tools ?? null,
					denyTools: (definition.denyTools ?? "").split(",").map((name) => name.trim()).filter(Boolean),
				}
			: null,
		now: Date.now(),
	});
	if (authority.status === "refused") {
		return { status: "refused", message: `Routing policy blocked the resume (${authority.code}): ${authority.message}` };
	}
	return authority;
}

/** A managed resume's Pi arguments: the narrowed inventory, route and tools alone. */
export function getManagedResumeLaunchArgs(authority: Extract<ManagedResumeDecision, { status: "authorized" }>): string[] {
	const { metadata } = authority;
	return [
		...getManagedResourceLaunchArgs(authority.launch),
		...getPersistedPromptLaunchArgs(metadata),
		"--model",
		`${authority.launch.model}:${authority.launch.thinking}`,
		...getSubagentToolLaunchArgs(metadata.tools, new Set(metadata.denyTools), false),
	];
}

/**
 * Start a claimed generation's process; when starting throws, the claim is
 * abandoned so a retry is not blocked by a generation that never ran.
 */
export async function startClaimedGeneration<T>(
	sessionFile: string,
	ticket: GenerationTicket | undefined,
	start: () => T | Promise<T>,
): Promise<T> {
	try {
		return await start();
	} catch (error) {
		if (ticket) abandonGeneration(getAgentConfigDir(), sessionFile, ticket, error instanceof Error ? error.message : String(error));
		throw error;
	}
}

/**
 * Claim the managed session's next generation and record a pilot resume
 * under its committed launch id, before any process starts. Throws a
 * refusal, abandoning the claim when the pilot record is refused.
 */
export function claimManagedResume(
	sessionFile: string,
	managed: Extract<ManagedResumeDecision, { status: "authorized" }>,
): GenerationTicket {
	const agentDir = getAgentConfigDir();
	const claim = claimNextGeneration(agentDir, sessionFile);
	if ("refusal" in claim) {
		throw new ResumeRefusal("resume_denied", `Routing policy blocked the resume (resume_session_running): ${claim.refusal}.`);
	}
	const unrecorded = recordPilotResume(agentDir, managed.snapshot);
	if (unrecorded) {
		abandonGeneration(agentDir, sessionFile, claim, unrecorded);
		throw new ResumeRefusal("resume_denied", `Routing policy blocked the resume: ${unrecorded}.`);
	}
	return claim;
}
