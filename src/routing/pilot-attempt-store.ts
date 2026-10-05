/**
 * Durable pilot attempts: at most `allowed` non-refunded reservations per case.
 *
 * The store lives under the agent configuration directory, which no tool
 * sandbox can reach. Each case id has one mode-0700 directory holding a
 * write-once `case.json` and numbered reservation records. A launch first
 * claims its launch id by linking `launch-<hash>.json`, so a launch id is
 * spent once, whether or not it is admitted. Admission then counts the live
 * reservations before linking the next number, and numbers are dense: a
 * reservation is taken by hard-linking a fully written and fsynced record into
 * place as `reservation-<n>.json`, so of two racing launches exactly one wins
 * `n` and the other rescans. Hence at most `allowed` reservations are ever
 * non-refunded. Outcomes, recovery reasons and later records are linked the
 * same way, write-once. A refund only lowers the live count; a missing, empty,
 * unreadable or foreign outcome counts as consumed. Nothing is ever deleted or
 * renamed except temporary names, so the directory is the audit trail.
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
import { dirname, join } from "node:path";

export type PilotReceipt = {
	generation: string;
	caseDigest: string;
	controller: { provider: string; model: string; effort: string };
	/** Opaque to the store; stored verbatim. */
	runtime: Record<string, unknown>;
};

export type PilotAttemptRequest = {
	caseId: string;
	caseDigest: string;
	allowed: number;
	launchId: string;
	receipt: PilotReceipt;
};

export type PilotAttemptHandle = { root: string; caseId: string; launchId: string; number: number; nonce: string };

export type PilotOutcome = "pending" | "committed" | "refunded" | "unknown";

export type PilotReservation =
	| { status: "reserved"; handle: PilotAttemptHandle }
	| { status: "replayed"; number: number | null; outcome: PilotOutcome | null }
	| { status: "exhausted"; allowed: number; live: number }
	| { status: "case_changed"; reason: string }
	| { status: "unavailable"; reason: string };

export type PilotRecordKind = "resume" | "block" | "verdict";

export type PilotRecordRequest = {
	caseId: string;
	launchId: string;
	kind: PilotRecordKind;
	body: Record<string, unknown>;
};

type Refused = { status: "refused"; reason: string };

export type PilotCaseReservation = {
	number: number;
	launchId: string;
	receipt: PilotReceipt;
	outcome: PilotOutcome;
	recovery: string | null;
	records: Array<{ kind: PilotRecordKind; sequence: number; body: Record<string, unknown> }>;
};

export type PilotCase = { caseDigest: string; reservations: PilotCaseReservation[]; unreadable: number[] };

type CaseRecord = { version: 1; caseId: string; caseDigest: string };

type ReservationRecord = {
	version: 1;
	number: number;
	caseId: string;
	launchId: string;
	nonce: string;
	receipt: PilotReceipt;
	reservedAt: string;
};

type OutcomeRecord = { kind: "committed" | "refunded"; nonce: string; evidence?: string[]; at: string };

type AppendedRecord = {
	version: 1;
	kind: PilotRecordKind;
	caseId: string;
	launchId: string;
	sequence: number;
	body: Record<string, unknown>;
	at: string;
};

class StoreError extends Error {}

const RESERVATION_FILE = /^reservation-(\d+)\.json$/;
const RECORD_FILE = /^(resume|block|verdict)-([0-9a-f]{64})-(\d+)\.json$/;
const RECORD_KINDS: readonly string[] = ["resume", "block", "verdict"];

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function caseDirectory(root: string, caseId: string): string {
	return join(root, sha256(caseId));
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Refuse a path that is a symlink, not a directory, reachable by others, or owned by another user. */
function checkPrivate(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(`${path} is not a directory`);
	if ((stat.mode & 0o077) !== 0) throw new StoreError(`${path} is accessible to other users`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new StoreError(`${path} is owned by another user`);
	}
}

/** A directory this user alone can use; created when missing, never followed through a symlink. */
function privateDirectory(path: string): void {
	let created = false;
	try {
		mkdirSync(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw new StoreError(`cannot create ${path}: ${errorCode(error) ?? error}`);
	}
	checkPrivate(path);
	if (created) fsyncDirectory(dirname(path));
}

/** Whether an existing private directory is there; false when missing, throws when not private. */
function existingPrivateDirectory(path: string): boolean {
	try {
		lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	checkPrivate(path);
	return true;
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
		// The temporary name only; the linked record stays, so a failed cleanup changes nothing.
		try {
			unlinkSync(temp);
		} catch {}
	}
	fsyncDirectory(dir);
	return "linked";
}

/** The parsed JSON at `path`: `undefined` when missing, `null` when unreadable or unparseable. */
function tryReadJson(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return null;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReservation(dir: string, number: number): ReservationRecord | null {
	const value = tryReadJson(join(dir, `reservation-${number}.json`));
	if (!isObject(value) || value.version !== 1 || value.number !== number) return null;
	if (typeof value.launchId !== "string" || typeof value.nonce !== "string" || !isObject(value.receipt)) return null;
	return value as ReservationRecord;
}

/** A reservation's outcome; only a parseable outcome carrying the reservation's nonce settles it. */
function readOutcome(dir: string, number: number, reservation: ReservationRecord | null): PilotOutcome {
	const value = tryReadJson(join(dir, `reservation-${number}.outcome.json`));
	if (value === undefined) return "pending";
	if (!isObject(value) || reservation === null || value.nonce !== reservation.nonce) return "unknown";
	if (value.kind === "committed" || value.kind === "refunded") return value.kind;
	return "unknown";
}

type ScannedReservation = { number: number; record: ReservationRecord | null; outcome: PilotOutcome };

function scanReservations(dir: string): ScannedReservation[] {
	const numbers: number[] = [];
	for (const name of readdirSync(dir)) {
		const match = RESERVATION_FILE.exec(name);
		if (match) numbers.push(Number(match[1]));
	}
	return numbers
		.sort((a, b) => a - b)
		.map((number) => {
			const record = readReservation(dir, number);
			return { number, record, outcome: readOutcome(dir, number, record) };
		});
}

/** The case's `case.json`, or `undefined` when it does not exist yet. Throws when unreadable. */
function readCase(dir: string): CaseRecord | undefined {
	const value = tryReadJson(join(dir, "case.json"));
	if (value === undefined) return undefined;
	if (!isObject(value) || value.version !== 1 || typeof value.caseDigest !== "string") {
		throw new StoreError("case.json is unreadable");
	}
	return value as CaseRecord;
}

function caseChanged(existing: CaseRecord, caseDigest: string): PilotReservation | null {
	if (existing.caseDigest === caseDigest) return null;
	return { status: "case_changed", reason: `the case was recorded with digest ${existing.caseDigest}, not ${caseDigest}` };
}

function reserve(root: string, request: PilotAttemptRequest): PilotReservation {
	privateDirectory(root);
	const dir = caseDirectory(root, request.caseId);
	privateDirectory(dir);
	// The case record is checked before anything else is created in the case directory.
	const existing = readCase(dir);
	if (existing !== undefined) {
		const changed = caseChanged(existing, request.caseDigest);
		if (changed) return changed;
	}
	privateDirectory(join(dir, "tmp"));
	if (existing === undefined) {
		const record: CaseRecord = { version: 1, caseId: request.caseId, caseDigest: request.caseDigest };
		if (linkRecord(dir, "case.json", record) === "exists") {
			const raced = readCase(dir);
			if (raced === undefined) throw new StoreError("case.json vanished");
			const changed = caseChanged(raced, request.caseDigest);
			if (changed) return changed;
		}
	}

	// Claiming the launch id spends it, whether or not it is admitted.
	if (linkRecord(dir, `launch-${sha256(request.launchId)}.json`, { launchId: request.launchId }) === "exists") {
		const match = scanReservations(dir).find((entry) => entry.record?.launchId === request.launchId);
		return match
			? { status: "replayed", number: match.number, outcome: match.outcome }
			: { status: "replayed", number: null, outcome: null };
	}

	let gapSeen = false;
	while (true) {
		const scanned = scanReservations(dir);
		// Numbers are dense, since n+1 is linked only by a launch that saw n. A
		// gap means a directory read that missed a concurrent link, so read
		// again; a gap that persists means a record was removed, and counting
		// past it could admit more than `allowed`.
		if (scanned.some((entry, index) => entry.number !== index + 1)) {
			if (gapSeen) throw new StoreError("the reservation numbers have a gap");
			gapSeen = true;
			continue;
		}
		const live = scanned.filter((entry) => entry.outcome !== "refunded").length;
		if (live >= request.allowed) return { status: "exhausted", allowed: request.allowed, live };
		const number = scanned.reduce((max, entry) => Math.max(max, entry.number), 0) + 1;
		const nonce = randomBytes(16).toString("hex");
		const record: ReservationRecord = {
			version: 1,
			number,
			caseId: request.caseId,
			launchId: request.launchId,
			nonce,
			receipt: request.receipt,
			reservedAt: new Date().toISOString(),
		};
		if (linkRecord(dir, `reservation-${number}.json`, record) === "linked") {
			return { status: "reserved", handle: { root, caseId: request.caseId, launchId: request.launchId, number, nonce } };
		}
		// Another launch took this number; rescan, which may now be exhausted.
	}
}

/** Reserve one pilot attempt for a case. Never throws. */
export function reservePilotAttempt(root: string, request: PilotAttemptRequest): PilotReservation {
	try {
		return reserve(root, request);
	} catch (error) {
		return { status: "unavailable", reason: `pilot attempt store: ${message(error)}` };
	}
}

/** The case directory of a handle, after checking the handle names its reservation. */
function verifiedHandleDirectory(handle: PilotAttemptHandle): string {
	if (!existingPrivateDirectory(handle.root)) throw new StoreError("the store does not exist");
	const dir = caseDirectory(handle.root, handle.caseId);
	if (!existingPrivateDirectory(dir) || !existingPrivateDirectory(join(dir, "tmp"))) {
		throw new StoreError("the case does not exist");
	}
	const record = readReservation(dir, handle.number);
	if (record === null) throw new StoreError(`reservation ${handle.number} is missing or unreadable`);
	if (record.nonce !== handle.nonce || record.launchId !== handle.launchId || record.number !== handle.number) {
		throw new StoreError(`the handle does not match reservation ${handle.number}`);
	}
	return dir;
}

function settle<K extends "committed" | "refunded">(
	handle: PilotAttemptHandle,
	kind: K,
	evidence?: string[],
): { status: K } | Refused {
	try {
		const dir = verifiedHandleDirectory(handle);
		const outcome: OutcomeRecord = { kind, nonce: handle.nonce, ...(evidence ? { evidence } : {}), at: new Date().toISOString() };
		if (linkRecord(dir, `reservation-${handle.number}.outcome.json`, outcome) === "exists") {
			return { status: "refused", reason: `reservation ${handle.number} already has an outcome` };
		}
		return { status: kind };
	} catch (error) {
		return { status: "refused", reason: `pilot attempt store: ${message(error)}` };
	}
}

/** Commit a reserved attempt: it stays consumed for good. Never throws. */
export function commitPilotAttempt(handle: PilotAttemptHandle): { status: "committed" } | Refused {
	return settle(handle, "committed");
}

/** Refund a reserved attempt that never ran, with the evidence for that. Never throws. */
export function refundPilotAttempt(handle: PilotAttemptHandle, evidence: string[]): { status: "refunded" } | Refused {
	return settle(handle, "refunded", evidence);
}

/** Make visible why a reservation cannot be settled; the first reason is kept. Never throws. */
export function markPilotAttemptRecovery(handle: PilotAttemptHandle, reason: string): void {
	try {
		const dir = verifiedHandleDirectory(handle);
		linkRecord(dir, `reservation-${handle.number}.recovery.json`, { reason, at: new Date().toISOString() });
	} catch {
		// The reservation stays consumed either way; only the visible reason is lost.
	}
}

function append(root: string, request: PilotRecordRequest): { status: "appended"; sequence: number } | Refused {
	if (!RECORD_KINDS.includes(request.kind)) return { status: "refused", reason: `unknown record kind ${request.kind}` };
	if (!existingPrivateDirectory(root)) return { status: "refused", reason: "the store does not exist" };
	const dir = caseDirectory(root, request.caseId);
	if (!existingPrivateDirectory(dir) || readCase(dir) === undefined) {
		return { status: "refused", reason: `case ${request.caseId} does not exist` };
	}
	if (!existingPrivateDirectory(join(dir, "tmp"))) return { status: "refused", reason: "the case has no tmp directory" };
	const match = scanReservations(dir).find((entry) => entry.record?.launchId === request.launchId);
	if (!match) return { status: "refused", reason: `launch ${request.launchId} has no reservation` };
	if (match.outcome !== "committed") {
		return { status: "refused", reason: `reservation ${match.number} is ${match.outcome}, not committed` };
	}
	const hash = sha256(request.launchId);
	for (let sequence = 1; ; sequence++) {
		const record: AppendedRecord = {
			version: 1,
			kind: request.kind,
			caseId: request.caseId,
			launchId: request.launchId,
			sequence,
			body: request.body,
			at: new Date().toISOString(),
		};
		if (linkRecord(dir, `${request.kind}-${hash}-${sequence}.json`, record) === "linked") {
			return { status: "appended", sequence };
		}
	}
}

/** Append a resume, block or verdict record under a committed launch. Never throws. */
export function appendPilotRecord(
	root: string,
	request: PilotRecordRequest,
): { status: "appended"; sequence: number } | Refused {
	try {
		return append(root, request);
	} catch (error) {
		return { status: "refused", reason: `pilot attempt store: ${message(error)}` };
	}
}

function readRecords(dir: string, launchId: string): PilotCaseReservation["records"] {
	const hash = sha256(launchId);
	const records: PilotCaseReservation["records"] = [];
	for (const name of readdirSync(dir)) {
		const match = RECORD_FILE.exec(name);
		if (!match || match[2] !== hash) continue;
		const value = tryReadJson(join(dir, name));
		if (!isObject(value) || value.launchId !== launchId || !isObject(value.body)) continue;
		records.push({ kind: match[1] as PilotRecordKind, sequence: Number(match[3]), body: value.body });
	}
	return records.sort((a, b) => (a.kind === b.kind ? a.sequence - b.sequence : a.kind < b.kind ? -1 : 1));
}

function readRecovery(dir: string, number: number): string | null {
	const value = tryReadJson(join(dir, `reservation-${number}.recovery.json`));
	if (value === undefined) return null;
	if (isObject(value) && typeof value.reason === "string") return value.reason;
	return "an unreadable recovery marker exists";
}

/** Everything recorded for a case, or null when it does not exist or cannot be read. Never throws. */
export function readPilotCase(root: string, caseId: string): PilotCase | null {
	try {
		if (!existingPrivateDirectory(root)) return null;
		const dir = caseDirectory(root, caseId);
		if (!existingPrivateDirectory(dir)) return null;
		const record = readCase(dir);
		if (record === undefined) return null;
		const reservations: PilotCaseReservation[] = [];
		const unreadable: number[] = [];
		for (const entry of scanReservations(dir)) {
			if (entry.record === null) {
				unreadable.push(entry.number);
				continue;
			}
			reservations.push({
				number: entry.number,
				launchId: entry.record.launchId,
				receipt: entry.record.receipt,
				outcome: entry.outcome,
				recovery: readRecovery(dir, entry.number),
				records: readRecords(dir, entry.record.launchId),
			});
		}
		return { caseDigest: record.caseDigest, reservations, unreadable };
	} catch {
		return null;
	}
}
