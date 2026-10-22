/**
 * Durable, exclusive writer leases: at most one managed writer per worktree.
 *
 * The store lives under the agent configuration directory, which no tool
 * sandbox can reach. Each canonical worktree identity (real common Git
 * directory, real worktree Git directory) has one mode-0700 directory of
 * numbered records. Lease `n` is taken by hard-linking a fully written and
 * fsynced record into place as `lease-<n>.json`, so of two racing launches
 * exactly one wins and the other sees `EEXIST`. Lease `n` ends when its
 * `lease-<n>.end.json` marker is created with `O_EXCL`, carrying the proof
 * that its execution group is empty. Nothing is ever deleted or renamed, so
 * the directory is the audit trail.
 *
 * Before a lease that ran a writer ends, its worktree is inspected: its
 * pinned identity, the child's containment records, and a walk for
 * writer-created Git metadata. Any failure writes `lease-<n>.contained.json`
 * instead, which no proof or reclaim clears; only an operator's
 * `lease-<n>.cleared.json` lets a proven-empty contained lease end.
 *
 * Parents from before the containment record never read it, but refuse to
 * reclaim a lease whose `lease-<n>.spawn-unproven.json` exists. So a
 * containment first links an unproven-spawn marker flagged `containment`,
 * which holds the lease for them and alone already counts as containment
 * here, then writes the containment record. Only that flagged marker is
 * waived by a proof; a genuine unproven spawn found the name taken records
 * itself as `lease-<n>.spawn-unproven-late.json`, which always blocks.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createMarker, exists, linkRecord, privateDirectory, readJson } from "./lease-records.ts";
import {
	classifyExecutionGroup,
	classifySupervisor,
	type ExecutionGroup,
	type ProcReader,
	procReader,
	readSupervisorIdentity,
	type SupervisorIdentity,
} from "./writer-group.ts";
import type { PinnedWorktree, WriterIdentity } from "./env-contract.ts";
import { inspectWriterTree } from "./writer-containment.ts";
import type { WriterWorktree } from "./writer-worktree.ts";

export type WriterLeaseRequest = { worktree: WriterWorktree; launchId: string; policyGeneration: string };

export type WriterLeaseOptions = {
	reader?: ProcReader;
	/** This process's identity; read from `/proc` when absent. */
	supervisor?: SupervisorIdentity;
};

type LeaseRecord = {
	version: 1;
	number: number;
	repository: string;
	worktree: string;
	gitDir: string;
	branch: string;
	head: string;
	launchId: string;
	/** What the lease's writer keys its containment records by; absent from leases taken before they were keyed per lease. */
	containmentKey?: string;
	policyGeneration: string;
	bootId: string;
	supervisor: Omit<SupervisorIdentity, "bootId">;
	acquiredAt: string;
};

type GroupRecord = { generation: number; group: ExecutionGroup; recordedAt: string };

export type LeaseRelease = { status: "released" } | { status: "held"; reason: string };

/** Kill a still-running namespace init; injectable for tests. */
type KillProcess = (pid: number) => void;

const killProcess: KillProcess = (pid) => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
};

export type LeaseAcquisition =
	| { status: "acquired"; lease: WriterLease }
	| { status: "held"; reason: string }
	| { status: "unavailable"; reason: string };


const LEASE_FILE = /^lease-(\d+)\.json$/;


type UnprovenSpawnMarker = { reason: string; containment?: string; at: string };

/** The containment reason of lease `number`'s unproven-spawn marker when containment linked it, else undefined. */
function containmentSpawnMarker(dir: string, number: number): string | undefined {
	try {
		const { containment } = readJson<Partial<UnprovenSpawnMarker>>(join(dir, `lease-${number}.spawn-unproven.json`));
		return typeof containment === "string" ? containment : undefined;
	} catch {
		return undefined;
	}
}

/** Why lease `number` is contained, or undefined. The marker's existence decides; a crash can leave it empty. */
function containedReason(dir: string, number: number): string | undefined {
	const marker = join(dir, `lease-${number}.contained.json`);
	if (!exists(marker)) return containmentSpawnMarker(dir, number);
	try {
		return readJson<{ reason: string }>(marker).reason;
	} catch {
		return "its containment marker is unreadable";
	}
}

/** Link the unproven-spawn marker that holds a contained lease for parents that never read the containment record; an existing marker is kept. */
function linkContainmentSpawnMarker(dir: string, number: number, reason: string): void {
	const marker: UnprovenSpawnMarker = {
		reason: `the writer lease is contained: ${reason}`,
		containment: reason,
		at: new Date().toISOString(),
	};
	try {
		linkRecord(dir, `lease-${number}.spawn-unproven.json`, marker);
	} catch {
		// Written in place instead; a crash that leaves it empty reads as a genuine unproven spawn, which still holds.
		createMarker(dir, `lease-${number}.spawn-unproven.json`, marker);
	}
}

/** Contain lease `number` on disk: the unproven-spawn marker first, then the containment record. */
function writeContainment(dir: string, number: number, reason: string): void {
	let failure: unknown;
	try {
		linkContainmentSpawnMarker(dir, number, reason);
	} catch (error) {
		failure = error;
	}
	createMarker(dir, `lease-${number}.contained.json`, { reason, at: new Date().toISOString() });
	if (failure !== undefined) throw failure;
}

function heldContained(dir: string, number: number, reason: string): string {
	return `the writer lease is contained: ${reason}; an operator must inspect the worktree and create ${join(dir, `lease-${number}.cleared.json`)} to clear it`;
}

function groupRecords(dir: string, number: number): GroupRecord[] {
	const pattern = new RegExp(`^lease-${number}\\.group-(\\d+)\\.json$`);
	return readdirSync(dir)
		.filter((name) => pattern.test(name))
		.map((name) => readJson<GroupRecord>(join(dir, name)));
}

/**
 * Whether every recorded group of a lease is proven empty. No recorded group
 * is never proof: a child may have started before its group was recorded.
 */
function proveGroupsEmpty(
	groups: readonly GroupRecord[],
	supervisorPidNamespace: string,
	reader: ProcReader,
): { proven: true; evidence: string[] } | { proven: false; reason: string; running: boolean } {
	if (groups.length === 0) return { proven: false, reason: "the lease has no recorded execution group", running: false };
	const evidence: string[] = [];
	for (const { generation, group } of groups) {
		const state = classifyExecutionGroup(group, supervisorPidNamespace, reader);
		if (state.state === "running") {
			return { proven: false, reason: `generation ${generation} (init ${group.initPid}) is still running`, running: true };
		}
		if (state.state === "unknown") return { proven: false, reason: `generation ${generation}: ${state.reason}`, running: false };
		evidence.push(`generation ${generation}: ${state.evidence}`);
	}
	return { proven: true, evidence };
}

/** Whether lease `number` is proven empty: no unproven spawn, and every recorded group proven gone. Containment's marker is no unproven spawn. */
function proveLeaseEmpty(
	dir: string,
	number: number,
	supervisorPidNamespace: string,
	reader: ProcReader,
): ReturnType<typeof proveGroupsEmpty> {
	const late = join(dir, `lease-${number}.spawn-unproven-late.json`);
	const unproven = exists(late) ? late : join(dir, `lease-${number}.spawn-unproven.json`);
	if (exists(unproven) && (unproven === late || containmentSpawnMarker(dir, number) === undefined)) {
		// The marker's existence decides; its reason is read best-effort, since a crash can leave it empty.
		let reason = "a spawn of this lease could not be proven gone";
		try {
			reason = readJson<{ reason: string }>(unproven).reason;
		} catch {}
		return { proven: false, reason, running: false };
	}
	return proveGroupsEmpty(groupRecords(dir, number), supervisorPidNamespace, reader);
}

export class WriterLease {
	readonly dir: string;
	readonly number: number;
	/** The leased worktree's top, the only directory its writer may run in. */
	readonly worktree: string;
	/** The worktree identity the lease was taken for. */
	readonly pinned: PinnedWorktree;
	/** What this lease's writer keys its containment records by, so no other lease reads them. */
	readonly containmentKey: string;
	private readonly supervisorPidNamespace: string;
	/** Why a spawn of this lease may have left an unrecorded writer, once one has. */
	private unprovenSpawn: string | undefined;
	/** Why this lease was contained, held in memory in case its marker cannot be written. */
	private containedInMemory: string | undefined;

	constructor(dir: string, number: number, pinned: PinnedWorktree, containmentKey: string, supervisorPidNamespace: string) {
		this.dir = dir;
		this.number = number;
		this.worktree = pinned.top;
		this.pinned = pinned;
		this.containmentKey = containmentKey;
		this.supervisorPidNamespace = supervisorPidNamespace;
	}

	/**
	 * The identity generation `generation` of this lease's writer is pinned to.
	 * Its `launchId` is the lease's containment key: the child uses it only to
	 * key its containment records, which must belong to this lease alone.
	 */
	identity(generation: number): WriterIdentity {
		return { ...this.pinned, launchId: this.containmentKey, generation };
	}

	private get name(): string {
		return `lease-${this.number}`;
	}

	/** Record a started generation's execution group; one synchronous atomic step. */
	recordGroup(group: ExecutionGroup, generation: number): void {
		const record: GroupRecord = { generation, group, recordedAt: new Date().toISOString() };
		if (linkRecord(this.dir, `${this.name}.group-${generation}.json`, record) === "exists") {
			throw new Error(`${this.name} already recorded generation ${generation}`);
		}
	}

	/** Whether every recorded generation's group is proven empty, without releasing. Never throws. */
	proveEmpty(reader: ProcReader = procReader): ReturnType<typeof proveGroupsEmpty> {
		try {
			if (this.unprovenSpawn !== undefined) return { proven: false, reason: this.unprovenSpawn, running: false };
			return proveLeaseEmpty(this.dir, this.number, this.supervisorPidNamespace, reader);
		} catch (error) {
			return {
				proven: false,
				reason: `cannot read the lease's records: ${error instanceof Error ? error.message : String(error)}`,
				running: false,
			};
		}
	}

	/**
	 * Record that a spawn failed without proof that nothing of it runs: an
	 * unrecorded writer may be loose, so no proof can release this lease.
	 */
	markSpawnUnproven(reason: string): void {
		// Held in memory first, so a marker that cannot be written still blocks
		// release in this process. If this process then dies too, nothing records
		// the unproven spawn and a later launch may reclaim the lease.
		this.unprovenSpawn = reason;
		const marker = { reason, at: new Date().toISOString() };
		if (!createMarker(this.dir, `${this.name}.spawn-unproven.json`, marker)) {
			// The name may hold containment's marker, which a proof waives.
			createMarker(this.dir, `${this.name}.spawn-unproven-late.json`, marker);
		}
	}

	/** Why this lease is contained, from this process or from disk, or undefined. Throws when the store is unreadable. */
	containedReason(): string | undefined {
		return this.containedInMemory ?? containedReason(this.dir, this.number);
	}

	/**
	 * Why the writer must be contained, or null: an existing containment, a
	 * changed worktree identity, the child's containment records, or, once
	 * every group is proven empty, writer-created Git metadata, which is
	 * quarantined. Never throws.
	 */
	inspect(reader: ProcReader = procReader): string | null {
		try {
			const contained = this.containedReason();
			if (contained !== undefined) return contained;
			return inspectWriterTree(this.pinned, this.containmentKey, this.proveEmpty(reader).proven);
		} catch (error) {
			return `cannot inspect the writer's lease: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Contain this lease for good; the first reason is kept. Never throws: the mark holds in memory regardless. */
	markContained(reason: string): void {
		this.containedInMemory ??= reason;
		try {
			writeContainment(this.dir, this.number, reason);
		} catch {
			// Held in memory; if this process dies too, a reclaim inspects the tree again.
		}
	}

	/** Kill the init of every recorded group still running as recorded; a reused PID is never signalled. */
	killRunningGroups(reader: ProcReader = procReader, kill: KillProcess = killProcess): void {
		let groups: GroupRecord[];
		try {
			groups = groupRecords(this.dir, this.number);
		} catch {
			return;
		}
		for (const { group } of groups) {
			if (classifyExecutionGroup(group, this.supervisorPidNamespace, reader).state === "running") kill(group.initPid);
		}
	}

	/**
	 * Release when every recorded group is proven empty and the worktree passes
	 * inspection; otherwise the lease stays held and the reason is returned. A
	 * failed inspection contains the lease.
	 */
	releaseIfEmpty(reader: ProcReader = procReader): LeaseRelease {
		const proof = this.proveEmpty(reader);
		if (!proof.proven) {
			if (!proof.running) this.markForRecovery(proof.reason);
			return { status: "held", reason: proof.reason };
		}
		// A contained lease ends only through an operator's clear, which the next acquire honors.
		const contained = this.containedReason();
		if (contained !== undefined) return { status: "held", reason: heldContained(this.dir, this.number, contained) };
		const breach = inspectWriterTree(this.pinned, this.containmentKey, true);
		if (breach !== null) {
			this.markContained(breach);
			return { status: "held", reason: heldContained(this.dir, this.number, breach) };
		}
		this.end({ kind: "released", evidence: proof.evidence });
		return { status: "released" };
	}

	/** Make the reason a lease stays held visible; the first reason is kept. Never throws. */
	markForRecovery(reason: string): void {
		try {
			createMarker(this.dir, `${this.name}.recovery.json`, { reason, at: new Date().toISOString() });
		} catch {
			// The lease stays held either way; only the visible reason is lost.
		}
	}

	/**
	 * Release a lease whose child never spawned. Refused once a group is
	 * recorded, so no writer ever ran under it and there is nothing to inspect.
	 */
	releaseUnspawned(reason: string): void {
		if (
			groupRecords(this.dir, this.number).length > 0 ||
			this.unprovenSpawn !== undefined ||
			exists(join(this.dir, `${this.name}.spawn-unproven.json`))
		) {
			throw new Error(`${this.name} has a recorded execution group or an unproven spawn; release it with proof`);
		}
		this.end({ kind: "released", evidence: [`no child was spawned: ${reason}`] });
	}

	private end(marker: { kind: "released"; evidence: string[] }): void {
		createMarker(this.dir, `${this.name}.end.json`, { ...marker, at: new Date().toISOString() });
	}
}

export type ReleaseWaitOptions = {
	reader?: ProcReader;
	intervalMs?: number;
	/** How long an unproven state, such as a zombie init not yet reaped, lasts before the lease is marked for recovery. */
	unknownGraceMs?: number;
};

/**
 * Release a lease once its groups are proven empty, polling for as long as
 * this process lives. An unprovable state that outlasts its grace marks the
 * lease for recovery, and polling goes on. Never rejects.
 */
export async function releaseWhenEmpty(lease: WriterLease, options: ReleaseWaitOptions = {}): Promise<LeaseRelease> {
	const intervalMs = options.intervalMs ?? 250;
	const graceMs = options.unknownGraceMs ?? 10_000;
	let unknownSince: number | undefined;
	while (true) {
		// A contained lease waits for an operator, not for proof.
		const contained = containedNow(lease);
		if (contained !== undefined) return { status: "held", reason: heldContained(lease.dir, lease.number, contained) };
		const proof = lease.proveEmpty(options.reader);
		if (proof.proven) {
			try {
				const released = lease.releaseIfEmpty(options.reader);
				if (released.status === "released") return released;
			} catch {
				// Writing the end marker failed; the lease stays held, so try again.
			}
		} else if (proof.running) {
			unknownSince = undefined;
		} else {
			unknownSince ??= Date.now();
			if (Date.now() - unknownSince >= graceMs) lease.markForRecovery(proof.reason);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs).unref?.());
	}
}

function containedNow(lease: WriterLease): string | undefined {
	try {
		return lease.containedReason();
	} catch {
		return undefined;
	}
}

/**
 * Contain a writer: mark its lease first, so a crash between the two cannot
 * leave a killed writer's lease reclaimable unmarked, then kill every
 * recorded group still running.
 */
export function containWriterLease(
	lease: WriterLease,
	reason: string,
	options: { reader?: ProcReader; kill?: KillProcess } = {},
): void {
	lease.markContained(reason);
	lease.killRunningGroups(options.reader, options.kill);
}

/** Wait until every recorded group is proven empty, or report why not once `timeoutMs` passes. */
export async function awaitGroupsEmpty(
	lease: WriterLease,
	timeoutMs: number,
	options: Pick<ReleaseWaitOptions, "reader" | "intervalMs"> = {},
): Promise<{ proven: true } | { proven: false; reason: string }> {
	const end = Date.now() + timeoutMs;
	while (true) {
		const proof = lease.proveEmpty(options.reader);
		if (proof.proven) return { proven: true };
		if (Date.now() >= end) return { proven: false, reason: proof.reason };
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
	}
}

/**
 * A new lease's containment key: its launch id and number with a random
 * nonce, stored in its record, so no other lease ever reads its containment
 * records: not a reused launch id, another worktree's lease, or a lease of
 * another lease store with the same number.
 */
function newContainmentKey(number: number, launchId: string): string {
	return `${launchId}#lease-${number}-${randomUUID()}`;
}

/**
 * Where a reclaimed lease's writer kept its containment records: its stored
 * key, or its launch id for a lease taken before keys were stored. Undefined
 * for any other value, which contains the lease.
 */
function recordContainmentKey(record: LeaseRecord): string | undefined {
	if (record.containmentKey === undefined) return record.launchId;
	return typeof record.containmentKey === "string" && record.containmentKey !== "" ? record.containmentKey : undefined;
}

function keyDirectory(root: string, worktree: WriterWorktree): string {
	const key = createHash("sha256").update(`${worktree.commonDir}\0${worktree.gitDir}`).digest("hex");
	return join(root, key);
}

function latestLease(dir: string): number {
	let latest = 0;
	for (const name of readdirSync(dir)) {
		const match = LEASE_FILE.exec(name);
		if (match) latest = Math.max(latest, Number(match[1]));
	}
	return latest;
}

/**
 * Give a lease an earlier version contained the marker that holds it for older
 * parents. Only once its supervisor is dead: a live one may still record a
 * genuine unproven spawn under that name. Best-effort; the lease is held anyway.
 */
function backfillContainmentSpawnMarker(
	dir: string,
	number: number,
	record: LeaseRecord,
	reason: string,
	reader: ProcReader,
): void {
	try {
		if (exists(join(dir, `lease-${number}.spawn-unproven.json`))) return;
		if (classifySupervisor({ ...record.supervisor, bootId: record.bootId }, reader).state !== "dead") return;
		linkContainmentSpawnMarker(dir, number, reason);
	} catch {
		// The next launch into the worktree tries again.
	}
}

/**
 * Reclaim lease `number` when its supervisor is dead, its groups are proven
 * empty, and its worktree passes inspection; otherwise why not. A contained
 * lease is reclaimed only once an operator cleared it and its groups are
 * proven empty: a contained supervisor never starts another generation.
 */
function tryReclaim(dir: string, number: number, reader: ProcReader): string | null {
	const record = readJson<LeaseRecord>(join(dir, `lease-${number}.json`));
	const held = `the worktree's writer lease is held by launch ${record.launchId} (supervisor ${record.supervisor.pid})`;
	const contained = containedReason(dir, number);
	if (contained !== undefined) {
		if (!exists(join(dir, `lease-${number}.cleared.json`))) {
			backfillContainmentSpawnMarker(dir, number, record, contained, reader);
			return `${held}; ${heldContained(dir, number, contained)}`;
		}
		const cleared = proveLeaseEmpty(dir, number, record.supervisor.pidNamespace, reader);
		if (!cleared.proven) return `${held}; it is cleared but ${cleared.reason}`;
		createMarker(dir, `lease-${number}.end.json`, { kind: "cleared", evidence: cleared.evidence, at: new Date().toISOString() });
		return null;
	}
	const supervisor = classifySupervisor({ ...record.supervisor, bootId: record.bootId }, reader);
	if (supervisor.state !== "dead") {
		return supervisor.state === "unknown" ? `${held}; its supervisor cannot be checked: ${supervisor.reason}` : held;
	}
	const proof = proveLeaseEmpty(dir, number, record.supervisor.pidNamespace, reader);
	if (!proof.proven) return `${held}; its supervisor is dead but ${proof.reason}`;
	const pinned = { top: record.worktree, commonDir: record.repository, worktreeGitDir: record.gitDir, branch: record.branch };
	const key = recordContainmentKey(record);
	const breach = key === undefined ? `lease-${number}.json has a malformed containment key` : inspectWriterTree(pinned, key, true);
	if (breach !== null) {
		try {
			writeContainment(dir, number, breach);
		} catch (error) {
			// Contained on disk all the same; a later launch adds the missing marker.
			if (containedReason(dir, number) === undefined) throw error;
		}
		return `${held}; ${heldContained(dir, number, breach)}`;
	}
	createMarker(dir, `lease-${number}.end.json`, {
		kind: "reclaimed",
		evidence: [`supervisor: ${supervisor.evidence}`, ...proof.evidence],
		at: new Date().toISOString(),
	});
	return null;
}

function acquire(root: string, request: WriterLeaseRequest, options: WriterLeaseOptions): LeaseAcquisition {
	const reader = options.reader ?? procReader;
	const supervisor = options.supervisor ?? readSupervisorIdentity(reader);
	privateDirectory(root);
	const dir = keyDirectory(root, request.worktree);
	privateDirectory(dir);
	privateDirectory(join(dir, "tmp"));
	const latest = latestLease(dir);
	if (latest > 0 && !exists(join(dir, `lease-${latest}.end.json`))) {
		const reason = tryReclaim(dir, latest, reader);
		if (reason !== null) return { status: "held", reason };
	}
	const number = latest + 1;
	const { worktree } = request;
	const containmentKey = newContainmentKey(number, request.launchId);
	const record: LeaseRecord = {
		version: 1,
		number,
		repository: worktree.commonDir,
		worktree: worktree.top,
		gitDir: worktree.gitDir,
		branch: worktree.branch,
		head: worktree.head,
		launchId: request.launchId,
		containmentKey,
		policyGeneration: request.policyGeneration,
		bootId: supervisor.bootId,
		supervisor: { pid: supervisor.pid, startTime: supervisor.startTime, pidNamespace: supervisor.pidNamespace },
		acquiredAt: new Date().toISOString(),
	};
	if (linkRecord(dir, `lease-${number}.json`, record) === "exists") {
		return { status: "held", reason: "another launch acquired the worktree's writer lease first" };
	}
	const pinned = { top: worktree.top, commonDir: worktree.commonDir, worktreeGitDir: worktree.gitDir, branch: worktree.branch };
	return { status: "acquired", lease: new WriterLease(dir, number, pinned, containmentKey, supervisor.pidNamespace) };
}

/** Acquire the writer lease for a worktree. Never throws. */
export function acquireWriterLease(
	root: string,
	request: WriterLeaseRequest,
	options: WriterLeaseOptions = {},
): LeaseAcquisition {
	try {
		return acquire(root, request, options);
	} catch (error) {
		return { status: "unavailable", reason: `writer lease store: ${error instanceof Error ? error.message : String(error)}` };
	}
}
