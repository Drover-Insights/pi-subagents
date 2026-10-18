/**
 * Resume authority for policy-managed children.
 *
 * A managed launch records an authority snapshot in the trusted state store.
 * A resume runs with the intersection of that verified snapshot and the
 * current policy: it can lose extensions and tools the policy or definition
 * no longer grant, but never gain any, never change route, role, trust, write
 * root or session, never drop a mandatory safety resource, and never reuse a
 * single-launch authorization such as a writer lease. Metadata a child writes
 * into its own session is never read.
 */
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { brokerModeForTools } from "../broker/preflight.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import type { PolicyLaunch, RunningSubagent } from "../types.ts";
import type { CanonicalPolicyState } from "./canonical-policy.ts";
import { authorizeLaunch, type ManagedRoutingEvidence } from "./launch-authorization.ts";
import { generationInUse, processStartTime, recordOwnedGeneration } from "./managed-ownership.ts";
import { appendPilotRecord } from "./pilot-attempt-store.ts";
import { verifyPolicyLaunch } from "./resource-verification.ts";
import {
	RESUME_SNAPSHOT_VERSION,
	type ResumeSnapshot,
	readResumeSnapshot,
	canonicalSessionPath,
	readSessionHeaderId,
	resumeSnapshotRoot,
	type SnapshotRead,
	writeResumeSnapshot,
} from "./resume-snapshot-store.ts";

type ManagedResumeRefusal =
	| "resume_snapshot_missing"
	| "resume_snapshot_invalid"
	| "resume_snapshot_incompatible"
	| "resume_session_mismatch"
	| "resume_trust_mismatch"
	| "resume_session_running"
	| "resume_broadening"
	| "resume_single_launch"
	| "resume_role_revoked"
	| "resume_authority_changed"
	| "resume_resource_changed"
	| "resource_unverified"
	| "provider_unknown";

export type ManagedResumeAuthority =
	| {
			status: "authorized";
			snapshot: ResumeSnapshot;
			evidence: ManagedRoutingEvidence;
			launch: PolicyLaunch;
			metadata: PersistedSubagentLaunchMetadata;
	  }
	| { status: "refused"; code: ManagedResumeRefusal; message: string };

export type ManagedResumeRequest = {
	sessionFile: string;
	policyState: CanonicalPolicyState;
	agentDir: string;
	/** Caller fields that would widen or change the launch; any of them refuses. */
	caller: { model?: string; thinking?: string; mode?: string };
	/** The trusted launch request a descriptor resume names; absent for the `subagent_resume` path. */
	trustedLaunchRequestId?: string;
	/**
	 * The agent's current global definition, or null when it is missing or
	 * disabled, which revokes the resume.
	 */
	definition: { tools: string | null; denyTools: readonly string[] } | null;
	now: number;
};


function getPilotAttemptRoot(agentDir: string): string {
	return join(agentDir, "pilot-attempts");
}

/** The snapshot recorded for a session, if any; a present snapshot makes the session managed. */
export function readManagedSnapshot(agentDir: string, sessionFile: string): SnapshotRead {
	return readResumeSnapshot(resumeSnapshotRoot(agentDir), sessionFile);
}

function processIdentity(pid: number | undefined): { pid: number | null; startTime: string | null } {
	return { pid: pid ?? null, startTime: processStartTime(pid) };
}

function groupIdentity(initPid: number | undefined): { initPid: number | null; startTime: string | null } {
	return { initPid: initPid ?? null, startTime: processStartTime(initPid) };
}

/**
 * Record a committed managed launch's authority and its first owner. The
 * running child gets its ownership token only once both are written; when
 * the store refuses, the child runs and is stopped through the parent's own
 * handle, but it can never be resumed. Returns the store's refusal, or null.
 */
export function recordManagedLaunchSnapshot(
	agentDir: string,
	running: RunningSubagent,
	launchId: string,
	evidence: ManagedRoutingEvidence,
	launch: PolicyLaunch,
): string | null {
	const metadata = running.launchMetadata;
	if (!metadata) return "the launch recorded no launch metadata";
	// A session with no header yet, such as a standalone one, has no identity to bind.
	const sessionId = readSessionHeaderId(running.sessionFile);
	if (sessionId === null) return `session ${running.sessionFile} has no header to bind`;
	const ownershipToken = randomBytes(16).toString("hex");
	const snapshot: ResumeSnapshot = {
		version: RESUME_SNAPSHOT_VERSION,
		launchId,
		ownershipToken,
		session: { file: canonicalSessionPath(running.sessionFile), id: sessionId },
		trust: metadata.trustedLaunch ? { kind: "trusted", provenance: metadata.trustedLaunch } : { kind: "tool" },
		evidence,
		launch,
		writeRoot: { path: canonicalDirectory(metadata.cwd) ?? metadata.cwd, mode: launch.toolBroker.mode },
		executionGroup: running.writerLease
			? { kind: "writer-lease", worktree: metadata.cwd, ...groupIdentity(running.writerInitPid) }
			: { kind: "process", ...processIdentity(running.childProcess?.pid) },
		terminal: running.surface ? { kind: "surface", surface: running.surface } : { kind: "none" },
		metadata,
		recordedAt: new Date().toISOString(),
	};
	const written = writeResumeSnapshot(resumeSnapshotRoot(agentDir), snapshot);
	return written.status === "written" ? recordOwnedGeneration(agentDir, running, ownershipToken, 1) : written.reason;
}

const ALL_TOOLS = Symbol("all");

/** Tool names as written; only the `all` and `none` keywords are matched case-insensitively. */
function toolSet(tools: string | null | undefined): string[] | typeof ALL_TOOLS {
	const keyword = (tools ?? "").trim().toLowerCase();
	if (keyword === "" || keyword === "all") return ALL_TOOLS;
	if (keyword === "none") return [];
	return (tools ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

/** The tools both allowlists grant, in the snapshot's order. */
function intersectTools(snapshot: string | null, current: string | null): string | null {
	const left = toolSet(snapshot);
	const right = toolSet(current);
	if (left === ALL_TOOLS) return right === ALL_TOOLS ? snapshot : current;
	if (right === ALL_TOOLS) return snapshot;
	const kept = left.filter((name) => right.includes(name));
	return kept.length > 0 ? kept.join(",") : "none";
}

/** A directory's real path, or null when it is gone or not a directory. */
function canonicalDirectory(path: string): string | null {
	try {
		const real = realpathSync(path);
		return statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

function refuse(code: ManagedResumeRefusal, message: string): ManagedResumeAuthority {
	return { status: "refused", code, message };
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function checkSnapshotBinding(snapshot: ResumeSnapshot, request: ManagedResumeRequest): ManagedResumeAuthority | null {
	let real: string;
	try {
		real = realpathSync(request.sessionFile);
	} catch {
		return refuse("resume_session_mismatch", `Session ${request.sessionFile} cannot be resolved.`);
	}
	if (real !== snapshot.session.file || readSessionHeaderId(request.sessionFile) !== snapshot.session.id) {
		return refuse("resume_session_mismatch", `Session ${request.sessionFile} is not the session the launch recorded.`);
	}
	const trusted = request.trustedLaunchRequestId;
	if (trusted === undefined ? snapshot.trust.kind !== "tool" : snapshot.trust.kind !== "trusted" || snapshot.trust.provenance.requestId !== trusted) {
		return refuse("resume_trust_mismatch", "The resume does not come from the path that launched this child.");
	}
	const { caller } = request;
	if (caller.model !== undefined || caller.thinking !== undefined || (caller.mode !== undefined && caller.mode !== snapshot.metadata.mode)) {
		return refuse(
			"resume_broadening",
			"A managed child resumes on its recorded route and mode; omit model, thinking and mode.",
		);
	}
	const inUse = generationInUse(request.agentDir, request.sessionFile);
	if (inUse) return refuse("resume_session_running", `Session ${request.sessionFile} cannot start again: ${inUse}.`);
	if (snapshot.executionGroup.kind === "writer-lease") {
		return refuse(
			"resume_single_launch",
			"A managed writer's lease authorized exactly one launch; launch a new writer instead of resuming.",
		);
	}
	return null;
}

/**
 * The extensions of the snapshot the current policy still grants, in
 * snapshot order, each pinned identically on both sides. Every mandatory
 * safety resource of the current policy must be kept.
 */
function narrowExtensions(
	snapshot: ResumeSnapshot,
	current: PolicyLaunch,
	mandatory: readonly string[],
): { kept: PolicyLaunch["extensions"] } | { refused: ManagedResumeAuthority } {
	const kept: PolicyLaunch["extensions"][number][] = [];
	for (const extension of snapshot.launch.extensions) {
		const now = current.extensions.find((entry) => entry.id === extension.id);
		if (!now) continue;
		if (!sameJson(now.files, extension.files)) {
			return { refused: refuse("resume_resource_changed", `Extension ${extension.id} changed since launch.`) };
		}
		kept.push(extension);
	}
	for (const id of mandatory) {
		if (!kept.some((extension) => extension.id === id)) {
			return { refused: refuse("resume_resource_changed", `Mandatory safety resource ${id} is not in the launch snapshot.`) };
		}
	}
	return { kept };
}

/** Decide a managed resume's authority. Reads the store; writes nothing. Never throws. */
export function authorizeManagedResume(request: ManagedResumeRequest): ManagedResumeAuthority {
	const read = readManagedSnapshot(request.agentDir, request.sessionFile);
	if (read.status === "missing") {
		return refuse("resume_snapshot_missing", `No launch authority snapshot was recorded for ${request.sessionFile}.`);
	}
	if (read.status === "incompatible") {
		return refuse("resume_snapshot_incompatible", `The launch snapshot has unsupported version ${String(read.version)}.`);
	}
	if (read.status === "invalid") return refuse("resume_snapshot_invalid", `The launch snapshot is invalid: ${read.reason}.`);
	const { snapshot } = read;
	const bound = checkSnapshotBinding(snapshot, request);
	if (bound) return bound;

	const recorded = snapshot.evidence;
	if (request.definition === null) {
		return refuse("resume_role_revoked", `Agent ${recorded.agent} has no enabled global definition.`);
	}
	// A moved or swapped working directory would redirect the resumed child.
	if (canonicalDirectory(snapshot.metadata.cwd) !== snapshot.writeRoot.path) {
		return refuse("resume_authority_changed", `The working directory ${snapshot.metadata.cwd} no longer leads to the recorded write root.`);
	}
	const tools = intersectTools(recorded.tools, request.definition.tools);
	const current = authorizeLaunch({
		policyState: request.policyState,
		agent: recorded.agent,
		capabilityClass: recorded.capabilityClass,
		pilotCase: recorded.pilotCase ?? undefined,
		interactionMode: recorded.interactionMode,
		agentDefs: tools === null ? null : { tools },
		now: request.now,
		agentDir: request.agentDir,
	});
	if (current.status === "unmanaged") {
		return refuse("resume_role_revoked", `The routing policy no longer manages agent ${recorded.agent}.`);
	}
	if (current.status === "policy_rejected") return refuse("resume_role_revoked", current.message);
	const fixed = ["role", "state", "capabilityClass", "interactionMode", "pilotCase", "route", "skills", "projectResources"] as const;
	for (const field of fixed) {
		if (!sameJson(current.evidence[field], recorded[field])) {
			return refuse("resume_authority_changed", `The ${field} of agent ${recorded.agent} changed since launch.`);
		}
	}
	const { policyState } = request;
	if (policyState.status !== "loaded") return refuse("resume_role_revoked", "The routing policy is not loaded.");
	const narrowed = narrowExtensions(snapshot, current.launch, policyState.policy.mandatoryExtensions);
	if ("refused" in narrowed) return narrowed.refused;
	const extensions = narrowed.kept;
	const launch: PolicyLaunch = {
		model: snapshot.launch.model,
		thinking: snapshot.launch.thinking,
		extensions,
		toolBroker: { mode: brokerModeForTools(tools) },
	};
	const verified = verifyPolicyLaunch(launch, request.agentDir);
	if (verified.status === "rejected") return refuse(verified.reason, verified.message);
	const evidence: ManagedRoutingEvidence = Object.freeze({
		...current.evidence,
		extensions: Object.freeze(extensions.map((extension) => extension.id)),
		tools,
	});
	const metadata: PersistedSubagentLaunchMetadata = {
		...snapshot.metadata,
		...(tools === null ? {} : { tools }),
		cwd: snapshot.writeRoot.path,
		denyTools: [...new Set([...snapshot.metadata.denyTools, ...request.definition.denyTools])],
		modelRef: `${launch.model}:${launch.thinking}`,
	};
	return { status: "authorized", snapshot, evidence, launch, metadata };
}

/** Record a pilot launch's resume under its committed launch id; consumes nothing. Returns a refusal reason, or null. */
export function recordPilotResume(agentDir: string, snapshot: ResumeSnapshot): string | null {
	const caseId = snapshot.evidence.pilotCase;
	if (caseId === null) return null;
	const appended = appendPilotRecord(getPilotAttemptRoot(agentDir), {
		caseId,
		launchId: snapshot.launchId,
		kind: "resume",
		body: { sessionFile: snapshot.session.file, at: new Date().toISOString() },
	});
	return appended.status === "appended" ? null : appended.reason;
}
