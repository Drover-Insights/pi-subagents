/**
 * Durable launch authority snapshots: the only source a managed child's
 * resume trusts.
 *
 * The parent writes one snapshot when it commits a managed launch, under the
 * agent configuration directory, which no tool sandbox can reach. Each child
 * session has one mode-0700 directory, named by the SHA-256 of the session
 * file's absolute path, holding a write-once `snapshot.json`. The record
 * carries a `sha256:` digest of its canonical JSON, so a torn or edited record
 * reads as invalid. The digest is not a keyed MAC: a key would have to live in
 * the same directory, so it would add nothing. Integrity rests on the
 * location: child tools run in a sandbox that cannot see the agent directory,
 * and metadata a child appends to its own session is never read as authority.
 * Nothing is ever deleted or rewritten.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import type { PolicyLaunch, TrustedLaunchProvenance } from "../types.ts";
import type { ManagedRoutingEvidence } from "./launch-authorization.ts";
import {
	canonicalJson,
	existingPrivateDirectory,
	isObject,
	linkRecord,
	message,
	privateDirectory,
	sha256,
	tryReadJson,
} from "../write-once-records.ts";

export const RESUME_SNAPSHOT_VERSION = 1;

/** Who may resume the child: the `subagent` tool path, or the trusted extension that launched it. */
type SnapshotTrust = { kind: "tool" } | { kind: "trusted"; provenance: TrustedLaunchProvenance };

/** The process or group whose ending proves the child's execution ended. */
type SnapshotExecutionGroup =
	| { kind: "process"; pid: number | null; startTime: string | null }
	/** A managed writer's lease authorizes exactly one launch; resume never reuses it. */
	| { kind: "writer-lease"; worktree: string; initPid: number | null; startTime: string | null };

/** The terminal surface the child owns; managed children are never interactive, so this is `none`. */
type SnapshotTerminal = { kind: "none" } | { kind: "surface"; surface: string };

export type ResumeSnapshot = {
	version: typeof RESUME_SNAPSHOT_VERSION;
	launchId: string;
	/** Random per launch; stop and close requests must present it. */
	ownershipToken: string;
	session: { file: string; id: string | null };
	trust: SnapshotTrust;
	evidence: ManagedRoutingEvidence;
	launch: PolicyLaunch;
	writeRoot: { path: string; mode: PolicyLaunch["toolBroker"]["mode"] };
	executionGroup: SnapshotExecutionGroup;
	terminal: SnapshotTerminal;
	metadata: PersistedSubagentLaunchMetadata;
	recordedAt: string;
};

export type SnapshotRead =
	| { status: "found"; snapshot: ResumeSnapshot }
	| { status: "missing" }
	| { status: "invalid"; reason: string }
	| { status: "incompatible"; version: unknown };

/**
 * The session file's real path, symlinks resolved, so no alias of a session
 * can miss its snapshot; the absolute path when it does not exist yet.
 */
export function canonicalSessionPath(sessionFile: string): string {
	try {
		return realpathSync(sessionFile);
	} catch {
		return resolve(sessionFile);
	}
}

/** The snapshot store under an agent directory. */
export function resumeSnapshotRoot(agentDir: string): string {
	return join(agentDir, "resume-snapshots");
}

function snapshotDirectory(root: string, sessionFile: string): string {
	return join(root, sha256(canonicalSessionPath(sessionFile)));
}

function snapshotDigest(snapshot: ResumeSnapshot): string {
	return `sha256:${sha256(canonicalJson(snapshot))}`;
}

/** The id in a session file's header line, or null when the header is missing or unreadable. */
export function readSessionHeaderId(sessionFile: string): string | null {
	try {
		const first = readFileSync(sessionFile, "utf8").split("\n", 1)[0];
		const header = JSON.parse(first) as unknown;
		return isObject(header) && header.type === "session" && typeof header.id === "string" ? header.id : null;
	} catch {
		return null;
	}
}

/** Record a launch's authority snapshot once. Never throws. */
export function writeResumeSnapshot(
	root: string,
	snapshot: ResumeSnapshot,
): { status: "written" } | { status: "refused"; reason: string } {
	try {
		privateDirectory(root);
		const dir = snapshotDirectory(root, snapshot.session.file);
		privateDirectory(dir);
		privateDirectory(join(dir, "tmp"));
		if (linkRecord(dir, "snapshot.json", { ...snapshot, digest: snapshotDigest(snapshot) }) === "exists") {
			return { status: "refused", reason: `a snapshot for ${snapshot.session.file} already exists` };
		}
		return { status: "written" };
	} catch (error) {
		return { status: "refused", reason: `resume snapshot store: ${message(error)}` };
	}
}

/** The snapshot recorded for a session file, verified against its digest. Never throws. */
export function readResumeSnapshot(root: string, sessionFile: string): SnapshotRead {
	try {
		if (!existingPrivateDirectory(root)) return { status: "missing" };
		const dir = snapshotDirectory(root, sessionFile);
		if (!existingPrivateDirectory(dir)) return { status: "missing" };
		const value = tryReadJson(join(dir, "snapshot.json"));
		if (value === undefined) return { status: "missing" };
		if (!isObject(value)) return { status: "invalid", reason: "the snapshot is unreadable" };
		if (value.version !== RESUME_SNAPSHOT_VERSION) return { status: "incompatible", version: value.version };
		const { digest, ...snapshot } = value;
		if (typeof digest !== "string" || digest !== snapshotDigest(snapshot as ResumeSnapshot)) {
			return { status: "invalid", reason: "the snapshot does not match its digest" };
		}
		if (
			!isObject(snapshot.session) ||
			snapshot.session.file !== canonicalSessionPath(sessionFile) ||
			!isObject(snapshot.evidence) ||
			!isObject(snapshot.launch) ||
			!isObject(snapshot.metadata) ||
			!isObject(snapshot.trust) ||
			!isObject(snapshot.executionGroup) ||
			typeof snapshot.launchId !== "string" ||
			typeof snapshot.ownershipToken !== "string"
		) {
			return { status: "invalid", reason: "the snapshot is malformed" };
		}
		return { status: "found", snapshot: snapshot as ResumeSnapshot };
	} catch (error) {
		return { status: "invalid", reason: `resume snapshot store: ${message(error)}` };
	}
}

/**
 * Who owns a managed child's running generation: the launch's ownership
 * token and the stable identity of the process group leader a stop signals.
 * Generation 1 is the launch; each resume or wrap-up adds the next number,
 * write-once, so the highest number is the current owner.
 */
export type OwnerRecord = {
	version: 1;
	generation: number;
	token: string;
	pid: number | null;
	/** Field 22 of `/proc/<pid>/stat`; null when it could not be read, which proves nothing. */
	startTime: string | null;
	/** The parent process that started this generation and may stop it. */
	parent: { pid: number; startTime: string | null };
	recordedAt: string;
};

const OWNER_FILE = /^owner-(\d+)\.json$/;

type StoreRefusal = { status: "refused"; reason: string };

/**
 * A parent's claim to start the generation after owner generation `after`,
 * linked before it spawns that generation's process. Attempt `attempt`
 * follows only claims whose parent died or that were abandoned.
 */
export type GenerationClaim = {
	version: 1;
	after: number;
	attempt: number;
	claimant: { pid: number; startTime: string | null };
};

export type RecordRead<T> = { status: "none" } | { status: "found"; record: T } | { status: "unreadable"; reason: string };

/** The session's snapshot directory, when the snapshot was recorded. Throws when the store is not private. */
function recordedDirectory(root: string, sessionFile: string): string | null {
	if (!existingPrivateDirectory(root)) return null;
	const dir = snapshotDirectory(root, sessionFile);
	if (!existingPrivateDirectory(dir) || !existingPrivateDirectory(join(dir, "tmp"))) return null;
	return dir;
}

function latestOwnerNumber(dir: string): number {
	let latest = 0;
	for (const name of readdirSync(dir)) {
		const match = OWNER_FILE.exec(name);
		if (match) latest = Math.max(latest, Number(match[1]));
	}
	return latest;
}

/**
 * Record the owner of `generation`, which the launch (generation 1) or a
 * claim made earlier names. Write-once: a taken generation is refused. Never throws.
 */
export function appendOwnerRecord(
	root: string,
	sessionFile: string,
	generation: number,
	owner: Omit<OwnerRecord, "version" | "generation" | "recordedAt">,
): { status: "written" } | StoreRefusal {
	try {
		const dir = recordedDirectory(root, sessionFile);
		if (!dir) return { status: "refused", reason: `no snapshot was recorded for ${sessionFile}` };
		const record: OwnerRecord = { version: 1, generation, ...owner, recordedAt: new Date().toISOString() };
		if (linkRecord(dir, `owner-${generation}.json`, record) === "exists") {
			return { status: "refused", reason: `generation ${generation} already has an owner` };
		}
		return { status: "written" };
	} catch (error) {
		return { status: "refused", reason: `resume snapshot store: ${message(error)}` };
	}
}

function claimName(after: number, attempt: number): string {
	return `claim-${after}.${attempt}.json`;
}

/** Link claim `attempt` after owner generation `after`; of two parents, exactly one links it. Never throws. */
export function linkClaim(
	root: string,
	sessionFile: string,
	claim: Omit<GenerationClaim, "version">,
): { status: "claimed" } | { status: "taken" } | StoreRefusal {
	try {
		const dir = recordedDirectory(root, sessionFile);
		if (!dir) return { status: "refused", reason: `no snapshot was recorded for ${sessionFile}` };
		const record: GenerationClaim = { version: 1, ...claim };
		return linkRecord(dir, claimName(claim.after, claim.attempt), record) === "linked" ? { status: "claimed" } : { status: "taken" };
	} catch (error) {
		return { status: "refused", reason: `resume snapshot store: ${message(error)}` };
	}
}

/** One claim and whether it was abandoned. Never throws. */
export function readClaim(
	root: string,
	sessionFile: string,
	after: number,
	attempt: number,
): RecordRead<GenerationClaim & { abandoned: boolean }> {
	try {
		const dir = recordedDirectory(root, sessionFile);
		if (!dir) return { status: "none" };
		const value = tryReadJson(join(dir, claimName(after, attempt)));
		if (value === undefined) return { status: "none" };
		if (!isObject(value) || value.version !== 1 || value.after !== after || value.attempt !== attempt || !isObject(value.claimant)) {
			return { status: "unreadable", reason: `${claimName(after, attempt)} cannot be read` };
		}
		const abandoned = tryReadJson(join(dir, `claim-${after}.${attempt}.abandoned.json`)) !== undefined;
		return { status: "found", record: { ...(value as GenerationClaim), abandoned } };
	} catch (error) {
		return { status: "unreadable", reason: `resume snapshot store: ${message(error)}` };
	}
}

/** Mark a claim whose generation never started, so later resumes can proceed. Never throws. */
export function abandonClaim(root: string, sessionFile: string, after: number, attempt: number, reason: string): void {
	try {
		const dir = recordedDirectory(root, sessionFile);
		if (dir) linkRecord(dir, `claim-${after}.${attempt}.abandoned.json`, { reason, at: new Date().toISOString() });
	} catch {
		// The claim then stays open only while its parent lives.
	}
}

/** The current owner of a session's child: the highest-numbered owner record. Never throws. */
export function readLatestOwnerRecord(root: string, sessionFile: string): RecordRead<OwnerRecord> {
	try {
		const dir = recordedDirectory(root, sessionFile);
		if (!dir) return { status: "none" };
		const generation = latestOwnerNumber(dir);
		if (generation === 0) return { status: "none" };
		const value = tryReadJson(join(dir, `owner-${generation}.json`));
		if (
			!isObject(value) ||
			value.version !== 1 ||
			value.generation !== generation ||
			typeof value.token !== "string" ||
			!isObject(value.parent) ||
			typeof value.parent.pid !== "number"
		) {
			return { status: "unreadable", reason: `owner-${generation}.json cannot be read` };
		}
		return { status: "found", record: value as OwnerRecord };
	} catch (error) {
		return { status: "unreadable", reason: `resume snapshot store: ${message(error)}` };
	}
}

/**
 * Every session the store holds a snapshot for, by its recorded session
 * file, and every snapshot directory whose snapshot cannot be read. Never throws.
 */
export function listSnapshotSessions(root: string): { sessions: string[]; unreadable: string[] } {
	const sessions: string[] = [];
	const unreadable: string[] = [];
	try {
		if (!existingPrivateDirectory(root)) return { sessions, unreadable };
		for (const name of readdirSync(root)) {
			const value = tryReadJson(join(root, name, "snapshot.json"));
			const session = isObject(value) && isObject(value.session) ? value.session.file : undefined;
			if (typeof session === "string") sessions.push(session);
			else unreadable.push(join(root, name));
		}
	} catch {
		unreadable.push(root);
	}
	return { sessions: sessions.sort(), unreadable };
}
