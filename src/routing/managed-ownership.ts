/**
 * Durable ownership of a managed child's running process.
 *
 * A stop or close never acts on a caller's claim or on in-memory state alone:
 * before the parent signals a managed child, it revalidates the running
 * record's ownership token against the durable owner record in the trusted
 * state store, and the process it is about to signal against the stable
 * identity that record holds (pid plus kernel start time, which a reused pid
 * does not repeat). Anything it cannot prove is left untouched, with the
 * reason kept on the record so it stays visible.
 *
 * Each later generation, a resume or a timeout wrap-up, first claims its
 * generation write-once, so of two parents resuming one session only one
 * starts a child, and none starts while an earlier generation may still be
 * running. A claim whose parent died before recording its generation fails
 * closed: the session stays in recovery until an operator abandons the claim.
 */
import { procReader, readProcessStartTime, statFields } from "../broker/writer-group.ts";
import type { RunningSubagent } from "../types.ts";
import {
	abandonClaim,
	appendOwnerRecord,
	type GenerationClaim,
	linkClaim,
	listSnapshotSessions,
	type OwnerRecord,
	readClaim,
	readLatestOwnerRecord,
	readResumeSnapshot,
	resumeSnapshotRoot,
} from "./resume-snapshot-store.ts";

export type ManagedOwnership = { status: "owned"; owner: OwnerRecord } | { status: "unowned"; reason: string };

/** A process's kernel start time, or null when no process holds the pid or it cannot be read. */
export function processStartTime(pid: number | undefined): string | null {
	if (pid === undefined) return null;
	try {
		return readProcessStartTime(pid, procReader);
	} catch {
		return null;
	}
}

/**
 * Whether a process group still exists. Only ESRCH proves it gone: the probe
 * is atomic, unlike any scan of `/proc`, which a member that forks and exits
 * can outrun. A group holding only zombies still counts until they are reaped.
 */
function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
	}
}

function isZombie(pid: number): boolean {
	try {
		return statFields(procReader.stat(pid))[0] === "Z";
	} catch {
		return false;
	}
}

/** Whether a process is the recorded one and has not exited: same start time, not a zombie. */
function isRecordedProcessRunning(pid: number, startTime: string | null): boolean {
	return startTime !== null && processStartTime(pid) === startTime && !isZombie(pid);
}

/**
 * Whether a recorded generation may still be running: its leader is, or
 * its leader exited (a zombie, or gone with no process holding its pid)
 * while a group with that id survives, which can only be the leader's own
 * group, since the kernel never reuses a pid that still names a process group.
 */
function ownerMayBeRunning(owner: OwnerRecord): boolean {
	if (owner.pid === null) return false;
	const current = processStartTime(owner.pid);
	if (current !== null && current !== owner.startTime) return false;
	if (current !== null && !isZombie(owner.pid)) return true;
	return groupExists(owner.pid);
}

/** The current durable owner of a session's child; readable after a parent crash, reload, or session switch. */
export function readManagedOwnership(agentDir: string, sessionFile: string): ManagedOwnership {
	const read = readLatestOwnerRecord(resumeSnapshotRoot(agentDir), sessionFile);
	if (read.status === "found") return { status: "owned", owner: read.record };
	return {
		status: "unowned",
		reason: read.status === "none" ? `no durable owner is recorded for ${sessionFile}` : read.reason,
	};
}

/** Why a session may not start a generation; `recovery` marks what only an operator or time can settle. */
type Blocked = { refusal: string; recovery: boolean };

/** The latest owner generation, when no generation may still be running. */
function settledOwner(root: string, sessionFile: string): { after: number } | Blocked {
	const owner = readLatestOwnerRecord(root, sessionFile);
	if (owner.status === "unreadable") return { refusal: `its latest owner record cannot be read: ${owner.reason}`, recovery: true };
	if (owner.status === "none") return { after: 0 };
	const record = owner.record;
	if (ownerMayBeRunning(record)) {
		const orphaned = !isRecordedProcessRunning(record.parent.pid, record.parent.startTime);
		return {
			refusal: orphaned
				? `generation ${record.generation} may still be running as process group ${record.pid}, but its parent ${record.parent.pid} is gone`
				: `generation ${record.generation} may still be running as process group ${record.pid}`,
			recovery: orphaned,
		};
	}
	return { after: record.generation };
}

function claimIsLive(claim: GenerationClaim): boolean {
	return isRecordedProcessRunning(claim.claimant.pid, claim.claimant.startTime);
}

/**
 * The first claim attempt after owner generation `after` that is free. An
 * abandoned claim is skipped. A live claim's parent is starting the
 * generation. A claim whose parent died without recording its generation
 * may have left a child running, so it blocks until an operator abandons it.
 */
function firstFreeAttempt(root: string, sessionFile: string, after: number, from = 1): { attempt: number } | Blocked {
	for (let attempt = from; ; attempt++) {
		const claim = readClaim(root, sessionFile, after, attempt);
		if (claim.status === "none") return { attempt };
		if (claim.status === "unreadable") return { refusal: `its claims cannot be read: ${claim.reason}`, recovery: true };
		if (claim.record.abandoned) continue;
		if (claimIsLive(claim.record)) {
			return { refusal: `parent process ${claim.record.claimant.pid} is starting generation ${after + 1}`, recovery: false };
		}
		return {
			refusal:
				`parent process ${claim.record.claimant.pid} died while starting generation ${after + 1}, ` +
				`which may still be running; once it is proven gone, an operator clears it by writing ` +
				`claim-${after}.${attempt}.abandoned.json beside the claim`,
			recovery: true,
		};
	}
}

function blockedFor(agentDir: string, sessionFile: string): Blocked | null {
	const root = resumeSnapshotRoot(agentDir);
	const owner = settledOwner(root, sessionFile);
	if ("refusal" in owner) return owner;
	const free = firstFreeAttempt(root, sessionFile, owner.after);
	return "refusal" in free ? free : null;
}

/**
 * Why a new generation of the session may not start now, or null: an
 * earlier generation may still run, a claim's parent is starting one or
 * died starting one, or the records cannot be read.
 */
export function generationInUse(agentDir: string, sessionFile: string): string | null {
	return blockedFor(agentDir, sessionFile)?.refusal ?? null;
}

export type ManagedRecovery = { sessionFile: string; reason: string };

/**
 * Managed sessions whose execution ownership cannot be proven: a generation
 * that may still run after its parent died, a claim whose parent died, or
 * records that cannot be read. Each stays blocked from resuming and is left
 * untouched; this list makes them visible after a crash, reload or session switch.
 */
export function findManagedRecovery(agentDir: string): ManagedRecovery[] {
	const root = resumeSnapshotRoot(agentDir);
	const { sessions, unreadable } = listSnapshotSessions(root);
	const recovery: ManagedRecovery[] = unreadable.map((dir) => ({ sessionFile: dir, reason: "its snapshot cannot be read" }));
	for (const sessionFile of sessions) {
		const snapshot = readResumeSnapshot(root, sessionFile);
		if (snapshot.status !== "found") {
			recovery.push({ sessionFile, reason: `its snapshot is ${snapshot.status}` });
			continue;
		}
		const blocked = blockedFor(agentDir, sessionFile);
		if (blocked?.recovery) recovery.push({ sessionFile, reason: blocked.refusal });
	}
	return recovery;
}

export type GenerationTicket = { generation: number; claim: { after: number; attempt: number } };

/**
 * Claim the session's next generation for this parent. Every parent that
 * follows the same owner generation competes for the same claim name, so
 * exactly one links it; a later attempt is taken only after an abandoned
 * claim. A claimant that finds a newer owner after linking abandons its claim.
 */
export function claimNextGeneration(
	agentDir: string,
	sessionFile: string,
	options: { beforeLink?: () => void } = {},
): GenerationTicket | { refusal: string } {
	const root = resumeSnapshotRoot(agentDir);
	const owner = settledOwner(root, sessionFile);
	if ("refusal" in owner) return { refusal: owner.refusal };
	let free = firstFreeAttempt(root, sessionFile, owner.after);
	if ("refusal" in free) return { refusal: free.refusal };
	options.beforeLink?.();
	const claimant = { pid: process.pid, startTime: processStartTime(process.pid) };
	while (true) {
		const linked = linkClaim(root, sessionFile, { after: owner.after, attempt: free.attempt, claimant });
		if (linked.status === "refused") return { refusal: linked.reason };
		if (linked.status === "claimed") break;
		free = firstFreeAttempt(root, sessionFile, owner.after, free.attempt);
		if ("refusal" in free) return { refusal: free.refusal };
	}
	const now = settledOwner(root, sessionFile);
	if ("refusal" in now || now.after !== owner.after) {
		const reason = "refusal" in now ? now.refusal : `generation ${now.after} started meanwhile`;
		abandonClaim(root, sessionFile, owner.after, free.attempt, reason);
		return { refusal: reason };
	}
	return { generation: owner.after + 1, claim: { after: owner.after, attempt: free.attempt } };
}

/** Release a claimed generation that never started a child. */
export function abandonGeneration(agentDir: string, sessionFile: string, ticket: GenerationTicket, reason: string): void {
	abandonClaim(resumeSnapshotRoot(agentDir), sessionFile, ticket.claim.after, ticket.claim.attempt, reason);
}

/**
 * Record the running generation's process as the child's owner under
 * `token`, and only then give the running record that token. When the store
 * refuses, the record holds no token: the parent stops the child through the
 * handle it spawned, as for an unmanaged child, rather than leave it
 * unstoppable. Returns the store's refusal, or null.
 */
export function recordOwnedGeneration(
	agentDir: string,
	running: RunningSubagent,
	token: string,
	generation: number,
): string | null {
	running.ownershipToken = undefined;
	const pid = running.childProcess?.pid;
	const written = appendOwnerRecord(resumeSnapshotRoot(agentDir), running.sessionFile, generation, {
		token,
		pid: pid ?? null,
		startTime: processStartTime(pid),
		parent: { pid: process.pid, startTime: processStartTime(process.pid) },
	});
	if (written.status !== "written") return written.reason;
	running.ownershipToken = token;
	return null;
}

/**
 * Whether the parent may close this managed child's terminal surface: only
 * the surface its launch snapshot recorded. Returns the reason it may not, or null.
 */
export function revalidateOwnedSurface(agentDir: string, running: RunningSubagent): string | null {
	if (!running.surface) return null;
	const read = readResumeSnapshot(resumeSnapshotRoot(agentDir), running.sessionFile);
	if (read.status !== "found") return `the launch snapshot that names its surface cannot be read (${read.status})`;
	const terminal = read.snapshot.terminal;
	if (terminal.kind !== "surface" || terminal.surface !== running.surface) {
		return `surface ${running.surface} is not the surface its launch recorded`;
	}
	return null;
}

/**
 * Whether the parent may signal the process group led by `pid` for this
 * managed child: returns the reason it may not, or null.
 */
export function revalidateOwnedProcess(agentDir: string, running: RunningSubagent, pid: number): string | null {
	const ownership = readManagedOwnership(agentDir, running.sessionFile);
	if (ownership.status === "unowned") return ownership.reason;
	const { owner } = ownership;
	if (owner.token !== running.ownershipToken) return "the ownership token does not match the durable owner record";
	if (owner.pid !== pid || owner.startTime === null) {
		return `the process identity of pid ${pid} does not match the durable owner record`;
	}
	// Once the parent has reaped the recorded leader through its own handle,
	// its start time is gone. While no other process holds the pid, a group
	// with that id can only be the leader's own survivors.
	const child = running.childProcess;
	const reaped = child?.pid === pid && (child.exitCode !== null || child.signalCode !== null);
	const current = processStartTime(pid);
	if (reaped ? current !== null : current !== owner.startTime) {
		return `the process identity of pid ${pid} does not match the durable owner record`;
	}
	return null;
}
