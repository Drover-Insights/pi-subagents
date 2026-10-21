/**
 * Supported read-only entrypoint (`pi-subagents/pilot-evidence`) for the
 * durable pilot-attempt evidence one launch left in the store, and the case
 * digest its reservation recorded. It registers nothing, launches nothing,
 * probes no runtime identity and writes nothing: importing it loads only
 * Node built-ins and the store's record formats.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	caseDirectory,
	PILOT_ATTEMPT_DIRECTORY,
	type PilotOutcome,
	type PilotReceipt,
	pilotCaseDigest,
	RECORD_FILE,
	RESERVATION_FILE,
} from "./pilot-attempt-store.ts";
import { existingPrivateDirectory, isObject, message, sha256 } from "./write-once-records.ts";

export { pilotCaseDigest };
export type { PilotOutcome, PilotReceipt };

export type PilotEvidenceQuery = {
	/** Pi's agent directory, the one holding `drover-model-routing.json`; the store is its `pilot-attempts/`. */
	agentDir: string;
	caseId: string;
	launchId: string;
};

export type PilotEvidenceRecord = { sequence: number; body: Record<string, unknown>; at: string };

export type PilotEvidence = {
	caseId: string;
	caseDigest: string;
	launchId: string;
	reservation: {
		number: number;
		reservedAt: string;
		/** The write-once receipt: generation, case digest, Controller snapshot and runtime identity. */
		receipt: PilotReceipt;
		outcome: PilotOutcome;
		recovery: null | { reason: string } | { unreadable: true };
	};
	resume: PilotEvidenceRecord[];
	block: PilotEvidenceRecord[];
	verdict: PilotEvidenceRecord[];
};

export type PilotEvidenceMissing = "store" | "case" | "case_record" | "launch_unclaimed" | "launch_not_reserved";

export type PilotEvidenceResult =
	| { status: "found"; evidence: PilotEvidence }
	| { status: "missing"; code: PilotEvidenceMissing; reason: string }
	| { status: "unreadable"; reason: string }
	| { status: "invalid"; reason: string };

type Failure = Exclude<PilotEvidenceResult, { status: "found" }>;

class EvidenceFailure extends Error {
	readonly result: Failure;
	constructor(result: Failure) {
		super(result.reason);
		this.result = result;
	}
}

function fail(status: "unreadable" | "invalid", reason: string): never {
	throw new EvidenceFailure({ status, reason });
}

/** A numbering gap, which a directory listing that missed a concurrent link also shows. */
class NumberingGap extends EvidenceFailure {}

/**
 * Run a scan, listing the directory once more on a gap, as reservation does:
 * a gap that persists is damage.
 */
function relistingOnGap<T>(scan: () => T): T {
	try {
		return scan();
	} catch (error) {
		if (error instanceof NumberingGap) return scan();
		throw error;
	}
}

type Read = { kind: "missing" } | { kind: "failed"; result: Failure } | { kind: "value"; value: unknown };

/** One record file, never followed through a symlink; a read error is unreadable, a parse error invalid. */
function readFile(dir: string, name: string): Read {
	let text: string;
	try {
		const fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			if (!fstatSync(fd).isFile())
				return { kind: "failed", result: { status: "invalid", reason: `${name} is not a file` } };
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code === "ENOENT") return { kind: "missing" };
		// Linux reports a refused symlink as ELOOP, the BSDs as EMLINK.
		if (code === "ELOOP" || code === "EMLINK")
			return { kind: "failed", result: { status: "invalid", reason: `${name} is a symlink` } };
		return { kind: "failed", result: { status: "unreadable", reason: `${name}: ${code ?? message(error)}` } };
	}
	try {
		return { kind: "value", value: JSON.parse(text) as unknown };
	} catch {
		return { kind: "failed", result: { status: "invalid", reason: `${name} is not JSON` } };
	}
}

/** A file listed in the directory; vanishing between listing and reading is unreadable. */
function readListed(dir: string, name: string): unknown {
	const read = readFile(dir, name);
	if (read.kind === "value") return read.value;
	if (read.kind === "missing") fail("unreadable", `${name} vanished while being read`);
	throw new EvidenceFailure(read.result);
}

/** The number in a file name, refusing a form the store never writes, such as a leading zero. */
function fileNumber(digits: string, name: string): number {
	const number = Number(digits);
	if (!Number.isSafeInteger(number) || number < 1 || String(number) !== digits)
		fail("invalid", `${name} has a malformed number`);
	return number;
}

function dense(numbers: number[], label: string): void {
	numbers.forEach((number, index) => {
		if (number !== index + 1) {
			throw new NumberingGap({ status: "invalid", reason: `the ${label} numbers have a gap before ${number}` });
		}
	});
}

function privateDirectory(path: string, missing: PilotEvidenceMissing, label: string): Failure | null {
	try {
		if (existingPrivateDirectory(path)) return null;
	} catch (error) {
		return { status: "unreadable", reason: `the ${label} cannot be used: ${message(error)}` };
	}
	return { status: "missing", code: missing, reason: `the ${label} does not exist` };
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function validReceipt(value: unknown, caseDigest: string): value is PilotReceipt {
	if (!isObject(value) || !isString(value.generation) || value.caseDigest !== caseDigest) return false;
	const controller = value.controller;
	if (!isObject(controller) || !isString(controller.provider) || !isString(controller.model)) return false;
	return isString(controller.effort) && isObject(value.runtime);
}

type Reservation = { number: number; launchId: string; nonce: string; receipt: PilotReceipt; reservedAt: string };

type Scanned = { reservation: Reservation } | { failure: Failure; launchId: unknown };

function scanReservation(dir: string, name: string, number: number, caseId: string, caseDigest: string): Scanned {
	const read = readFile(dir, name);
	if (read.kind === "missing")
		return { failure: { status: "unreadable", reason: `${name} vanished while being read` }, launchId: undefined };
	if (read.kind === "failed") return { failure: read.result, launchId: undefined };
	const value = read.value;
	const launchId = isObject(value) ? value.launchId : undefined;
	if (
		!isObject(value) ||
		value.version !== 1 ||
		value.number !== number ||
		value.caseId !== caseId ||
		!isString(value.launchId) ||
		!isString(value.nonce) ||
		!isString(value.reservedAt) ||
		!validReceipt(value.receipt, caseDigest)
	) {
		return { failure: { status: "invalid", reason: `${name} is malformed` }, launchId };
	}
	return {
		reservation: {
			number,
			launchId: value.launchId,
			nonce: value.nonce,
			receipt: value.receipt,
			reservedAt: value.reservedAt,
		},
	};
}

/** The outcome as accounting reads it: only a parseable outcome carrying the reservation's nonce settles it. */
function readOutcome(dir: string, reservation: Reservation): PilotOutcome {
	const read = readFile(dir, `reservation-${reservation.number}.outcome.json`);
	if (read.kind === "missing") return "pending";
	if (read.kind === "failed" || !isObject(read.value) || read.value.nonce !== reservation.nonce) return "unknown";
	return read.value.kind === "committed" || read.value.kind === "refunded" ? read.value.kind : "unknown";
}

function readRecovery(dir: string, number: number): PilotEvidence["reservation"]["recovery"] {
	const read = readFile(dir, `reservation-${number}.recovery.json`);
	if (read.kind === "missing") return null;
	if (read.kind === "value" && isObject(read.value) && isString(read.value.reason))
		return { reason: read.value.reason };
	return { unreadable: true };
}

function readRecords(dir: string, query: PilotEvidenceQuery) {
	const hash = sha256(query.launchId);
	const records: Record<"resume" | "block" | "verdict", PilotEvidenceRecord[]> = { resume: [], block: [], verdict: [] };
	for (const name of readdirSync(dir)) {
		const match = RECORD_FILE.exec(name);
		if (!match || match[2] !== hash) continue;
		const kind = match[1] as keyof typeof records;
		const sequence = fileNumber(match[3], name);
		const value = readListed(dir, name);
		if (
			!isObject(value) ||
			value.version !== 1 ||
			value.kind !== kind ||
			value.caseId !== query.caseId ||
			value.launchId !== query.launchId ||
			value.sequence !== sequence ||
			!isObject(value.body) ||
			!isString(value.at)
		) {
			fail("invalid", `${name} is malformed`);
		}
		records[kind].push({ sequence, body: value.body, at: value.at });
	}
	for (const [kind, list] of Object.entries(records)) {
		list.sort((a, b) => a.sequence - b.sequence);
		dense(
			list.map((entry) => entry.sequence),
			`${kind} record`,
		);
	}
	return records;
}

function read(query: PilotEvidenceQuery, reread = false): PilotEvidenceResult {
	const root = join(query.agentDir, PILOT_ATTEMPT_DIRECTORY);
	const noStore = privateDirectory(root, "store", "pilot attempt store");
	if (noStore) return noStore;
	const dir = caseDirectory(root, query.caseId);
	const noCase = privateDirectory(dir, "case", `case ${query.caseId}`);
	if (noCase) return noCase;
	const caseRead = readFile(dir, "case.json");
	if (caseRead.kind === "missing")
		return { status: "missing", code: "case_record", reason: `case ${query.caseId} has no case record` };
	if (caseRead.kind === "failed") return caseRead.result;
	const caseRecord = caseRead.value;
	if (
		!isObject(caseRecord) ||
		caseRecord.version !== 1 ||
		caseRecord.caseId !== query.caseId ||
		!isString(caseRecord.caseDigest)
	) {
		fail("invalid", "case.json is malformed");
	}
	const caseDigest = caseRecord.caseDigest;

	// The store links the launch claim before the reservation and the outcome
	// before any record, so each is read before what follows it, and read once
	// more when what follows appeared in between.
	const claimName = `launch-${sha256(query.launchId)}.json`;
	const readClaim = (): "present" | "missing" => {
		const claim = readFile(dir, claimName);
		if (claim.kind === "failed") throw new EvidenceFailure(claim.result);
		if (claim.kind === "missing") return "missing";
		if (!isObject(claim.value) || claim.value.launchId !== query.launchId) fail("invalid", `${claimName} is malformed`);
		return "present";
	};
	let claim = readClaim();

	let scanned = relistingOnGap(() => scanReservations(dir, query, caseDigest));
	// A claimed launch may be linking its reservation right now; look once more.
	if (scanned.matches.length === 0 && !scanned.failure && claim === "present") {
		scanned = relistingOnGap(() => scanReservations(dir, query, caseDigest));
	}
	if (scanned.matches.length > 1) fail("invalid", `launch ${query.launchId} has more than one reservation`);
	const reservation = scanned.matches[0];
	if (!reservation) {
		// With no match, the launch's reservation could be the one that cannot be read.
		if (scanned.failure) return scanned.failure;
		// Records are appended only under a reservation: unless the launch reserved
		// and appended since the scan, which a second read shows, it was removed.
		const hash = sha256(query.launchId);
		if (readdirSync(dir).some((name) => RECORD_FILE.exec(name)?.[2] === hash)) {
			if (!reread) return read(query, true);
			fail("invalid", `launch ${query.launchId} has records but no reservation`);
		}
		return claim === "missing"
			? {
					status: "missing",
					code: "launch_unclaimed",
					reason: `launch ${query.launchId} never claimed case ${query.caseId}`,
				}
			: {
					status: "missing",
					code: "launch_not_reserved",
					reason: `launch ${query.launchId} claimed case ${query.caseId} but has no reservation: it was refused, stopped before reserving, or is reserving now`,
				};
	}
	if (claim === "missing") claim = readClaim();
	if (claim === "missing") fail("invalid", `reservation ${reservation.number} has no launch claim`);

	let outcome = readOutcome(dir, reservation);
	const recovery = readRecovery(dir, reservation.number);
	const records = relistingOnGap(() => readRecords(dir, query));
	// The store appends records only under a committed reservation.
	const hasRecords = records.resume.length + records.block.length + records.verdict.length > 0;
	if (hasRecords && outcome === "pending") outcome = readOutcome(dir, reservation);
	if (hasRecords && outcome !== "committed") {
		fail("invalid", `launch ${query.launchId} has records but is ${outcome}, not committed`);
	}
	return {
		status: "found",
		evidence: {
			caseId: query.caseId,
			caseDigest,
			launchId: query.launchId,
			reservation: {
				number: reservation.number,
				reservedAt: reservation.reservedAt,
				receipt: reservation.receipt,
				outcome,
				recovery,
			},
			...records,
		},
	};
}

type ReservationScan = { matches: Reservation[]; failure: Failure | null };

/**
 * The readable reservations that name the launch, and the first failure among
 * the rest. A damaged reservation that names the launch is the launch's
 * evidence, so it fails the read at once.
 */
function scanReservations(dir: string, query: PilotEvidenceQuery, caseDigest: string): ReservationScan {
	const numbers: number[] = [];
	for (const name of readdirSync(dir)) {
		const match = RESERVATION_FILE.exec(name);
		if (match) numbers.push(fileNumber(match[1], name));
	}
	numbers.sort((a, b) => a - b);
	dense(numbers, "reservation");
	const scan: ReservationScan = { matches: [], failure: null };
	for (const number of numbers) {
		const entry = scanReservation(dir, `reservation-${number}.json`, number, query.caseId, caseDigest);
		if ("reservation" in entry) {
			if (entry.reservation.launchId === query.launchId) scan.matches.push(entry.reservation);
			continue;
		}
		if (entry.launchId === query.launchId) throw new EvidenceFailure(entry.failure);
		scan.failure ??= entry.failure;
	}
	return scan;
}

/**
 * The evidence one launch left for a case, as a point-in-time read. Never
 * throws and never writes; anything that cannot prove the evidence complete
 * is `missing`, `unreadable` or `invalid`, never an empty `found`.
 */
export function readPilotEvidence(query: PilotEvidenceQuery): PilotEvidenceResult {
	try {
		return read(query);
	} catch (error) {
		if (error instanceof EvidenceFailure) return error.result;
		return { status: "unreadable", reason: `pilot attempt store: ${message(error)}` };
	}
}
