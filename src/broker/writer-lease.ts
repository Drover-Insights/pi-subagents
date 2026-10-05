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
 */
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	classifyExecutionGroup,
	classifySupervisor,
	type ExecutionGroup,
	type ProcReader,
	procReader,
	readSupervisorIdentity,
	type SupervisorIdentity,
} from "./writer-group.ts";
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
	policyGeneration: string;
	bootId: string;
	supervisor: Omit<SupervisorIdentity, "bootId">;
	acquiredAt: string;
};

type GroupRecord = { generation: number; group: ExecutionGroup; recordedAt: string };

export type LeaseRelease = { status: "released" } | { status: "held"; reason: string };

export type LeaseAcquisition =
	| { status: "acquired"; lease: WriterLease }
	| { status: "held"; reason: string }
	| { status: "unavailable"; reason: string };

class StoreError extends Error {}

const LEASE_FILE = /^lease-(\d+)\.json$/;

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

/** A directory this user alone can use; created when missing, never followed through a symlink. */
function privateDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw new StoreError(`cannot create ${path}: ${errorCode(error) ?? error}`);
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(`${path} is not a directory`);
	if ((stat.mode & 0o077) !== 0) throw new StoreError(`${path} is accessible to other users`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new StoreError(`${path} is owned by another user`);
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write a fully synced temporary file, then link it into place; `EEXIST` means the name is taken. */
function linkRecord(dir: string, name: string, value: unknown): "linked" | "exists" {
	const temp = join(dir, "tmp", `${process.pid}-${randomBytes(8).toString("hex")}.json`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temp, join(dir, name));
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "exists";
		throw error;
	} finally {
		// The temporary name only; the linked record stays.
		unlinkSync(temp);
	}
	fsyncDirectory(dir);
	return "linked";
}

/** Create a marker with `O_EXCL`; false when it already exists. */
function createMarker(dir: string, name: string, value: unknown): boolean {
	let fd: number;
	try {
		fd = openSync(join(dir, name), "wx", 0o600);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(dir);
	return true;
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
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

/** Whether lease `number` is proven empty: no unproven spawn, and every recorded group proven gone. */
function proveLeaseEmpty(
	dir: string,
	number: number,
	supervisorPidNamespace: string,
	reader: ProcReader,
): ReturnType<typeof proveGroupsEmpty> {
	const unproven = join(dir, `lease-${number}.spawn-unproven.json`);
	if (exists(unproven)) {
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
	private readonly supervisorPidNamespace: string;
	/** Why a spawn of this lease may have left an unrecorded writer, once one has. */
	private unprovenSpawn: string | undefined;

	constructor(dir: string, number: number, worktree: string, supervisorPidNamespace: string) {
		this.dir = dir;
		this.number = number;
		this.worktree = worktree;
		this.supervisorPidNamespace = supervisorPidNamespace;
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
		createMarker(this.dir, `${this.name}.spawn-unproven.json`, { reason, at: new Date().toISOString() });
	}

	/** Release when every recorded group is proven empty; otherwise the lease stays held and the reason is returned. */
	releaseIfEmpty(reader: ProcReader = procReader): LeaseRelease {
		const proof = this.proveEmpty(reader);
		if (!proof.proven) {
			if (!proof.running) this.markForRecovery(proof.reason);
			return { status: "held", reason: proof.reason };
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

	/** Release a lease whose child never spawned. Refused once a group is recorded. */
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

/** Reclaim lease `number` when its supervisor is dead and its groups are proven empty; otherwise why not. */
function tryReclaim(dir: string, number: number, reader: ProcReader): string | null {
	const record = readJson<LeaseRecord>(join(dir, `lease-${number}.json`));
	const held = `the worktree's writer lease is held by launch ${record.launchId} (supervisor ${record.supervisor.pid})`;
	const supervisor = classifySupervisor({ ...record.supervisor, bootId: record.bootId }, reader);
	if (supervisor.state !== "dead") {
		return supervisor.state === "unknown" ? `${held}; its supervisor cannot be checked: ${supervisor.reason}` : held;
	}
	const proof = proveLeaseEmpty(dir, number, record.supervisor.pidNamespace, reader);
	if (!proof.proven) return `${held}; its supervisor is dead but ${proof.reason}`;
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
	const record: LeaseRecord = {
		version: 1,
		number,
		repository: worktree.commonDir,
		worktree: worktree.top,
		gitDir: worktree.gitDir,
		branch: worktree.branch,
		head: worktree.head,
		launchId: request.launchId,
		policyGeneration: request.policyGeneration,
		bootId: supervisor.bootId,
		supervisor: { pid: supervisor.pid, startTime: supervisor.startTime, pidNamespace: supervisor.pidNamespace },
		acquiredAt: new Date().toISOString(),
	};
	if (linkRecord(dir, `lease-${number}.json`, record) === "exists") {
		return { status: "held", reason: "another launch acquired the worktree's writer lease first" };
	}
	return { status: "acquired", lease: new WriterLease(dir, number, worktree.top, supervisor.pidNamespace) };
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
