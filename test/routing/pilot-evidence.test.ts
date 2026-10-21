import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, mock, test } from "node:test";
import {
	appendPilotRecord,
	commitPilotAttempt,
	markPilotAttemptRecovery,
	type PilotAttemptRequest,
	reservePilotAttempt,
} from "../../src/routing/pilot-attempt-store.ts";
import { pilotCaseDigest, readPilotEvidence } from "../../src/routing/pilot-evidence.ts";
import "../support/temp-root.ts";

const CASE_ID = "scout-literal-1";

/** A pilot case record as the routing policy holds it, with a non-ASCII string to pin the UTF-8 encoding. */
function caseRecord() {
	return {
		role: "scout",
		capabilityClass: "scout.literal",
		artifact: "docs/pilot.md",
		route: { provider: "openai-codex", model: "gpt-6-sol", thinking: "low" },
		resourceGrant: "read-only",
		attempts: { allowed: 2 },
		retry: "never",
		expires: "2030-01-01T00:00:00Z",
		acceptance: ["report names every match", "café ✓"],
	};
}

function agentDirectory(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pilot-evidence-")));
}

function storeOf(agentDir: string): string {
	return join(agentDir, "pilot-attempts");
}

function caseDir(agentDir: string, caseId = CASE_ID): string {
	return join(storeOf(agentDir), createHash("sha256").update(caseId).digest("hex"));
}

function launchHash(launchId: string): string {
	return createHash("sha256").update(launchId).digest("hex");
}

const runtime = { pi: { command: "/usr/bin/node", commandSha256: "a".repeat(64), entry: null, package: null } };

function request(launchId: string, overrides: Partial<PilotAttemptRequest> = {}): PilotAttemptRequest {
	const caseDigest = pilotCaseDigest(caseRecord());
	return {
		caseId: CASE_ID,
		caseDigest,
		allowed: 2,
		launchId,
		receipt: {
			generation: "gen-7",
			caseDigest,
			controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
			runtime,
		},
		...overrides,
	};
}

/** Reserve, commit and append records for one launch through the store's own writers. */
function committedLaunch(agentDir: string, launchId: string, records = true) {
	const reservation = reservePilotAttempt(storeOf(agentDir), request(launchId));
	assert.equal(reservation.status, "reserved", JSON.stringify(reservation));
	if (reservation.status !== "reserved") return assert.fail("not reserved");
	assert.equal(commitPilotAttempt(reservation.handle).status, "committed");
	if (records) {
		for (const [kind, body] of [
			["resume", { session: "s-1" }],
			["block", { reason: "awaiting review" }],
			["verdict", { verdict: "accepted" }],
			["resume", { session: "s-2" }],
		] as const) {
			const appended = appendPilotRecord(storeOf(agentDir), { caseId: CASE_ID, launchId, kind, body });
			assert.equal(appended.status, "appended", JSON.stringify(appended));
		}
	}
	return reservation.handle;
}

/** Every path under `root` with its inode, size, mode and mtime, to prove a read changed nothing. */
function snapshot(root: string): string[] {
	const entries: string[] = [];
	const walk = (path: string) => {
		const stat = lstatSync(path, { bigint: true });
		entries.push(`${path} ${stat.ino} ${stat.size} ${stat.mode} ${stat.mtimeNs} ${stat.ctimeNs}`);
		if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
	};
	walk(root);
	return entries;
}

function read(agentDir: string, launchId = "call-1", caseId = CASE_ID) {
	return readPilotEvidence({ agentDir, caseId, launchId });
}

function writeRaw(path: string, text: string): void {
	writeFileSync(path, text, { mode: 0o600 });
}

describe("pilot evidence reader", () => {
	test("reads a launch's receipt, outcome and every resume, block and verdict record without writing", () => {
		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1");
		committedLaunch(agentDir, "call-2", false);
		const before = snapshot(agentDir);

		const result = read(agentDir);

		assert.deepEqual(snapshot(agentDir), before);
		assert.equal(result.status, "found", JSON.stringify(result));
		if (result.status !== "found") return;
		const { evidence } = result;
		assert.equal(evidence.caseId, CASE_ID);
		assert.equal(evidence.launchId, "call-1");
		assert.equal(evidence.caseDigest, pilotCaseDigest(caseRecord()));
		assert.equal(evidence.reservation.number, 1);
		assert.equal(evidence.reservation.outcome, "committed");
		assert.equal(evidence.reservation.recovery, null);
		assert.equal(typeof evidence.reservation.reservedAt, "string");
		assert.deepEqual(evidence.reservation.receipt, request("call-1").receipt);
		assert.deepEqual(evidence.reservation.receipt.controller, {
			provider: "openai-codex",
			model: "gpt-6-sol",
			effort: "medium",
		});
		assert.deepEqual(evidence.reservation.receipt.runtime, runtime);
		assert.deepEqual(
			evidence.resume.map((entry) => [entry.sequence, entry.body]),
			[
				[1, { session: "s-1" }],
				[2, { session: "s-2" }],
			],
		);
		assert.deepEqual(
			evidence.block.map((entry) => [entry.sequence, entry.body]),
			[[1, { reason: "awaiting review" }]],
		);
		assert.deepEqual(
			evidence.verdict.map((entry) => [entry.sequence, entry.body]),
			[[1, { verdict: "accepted" }]],
		);
		for (const entry of [...evidence.resume, ...evidence.block, ...evidence.verdict])
			assert.equal(typeof entry.at, "string");

		const other = read(agentDir, "call-2");
		assert.equal(other.status === "found" && other.evidence.reservation.number, 2);
		assert.deepEqual(
			other.status === "found" && [other.evidence.resume, other.evidence.block, other.evidence.verdict],
			[[], [], []],
		);
	});

	test("reports the outcome and recovery marker as accounting reads them", () => {
		const agentDir = agentDirectory();
		const reservation = reservePilotAttempt(storeOf(agentDir), request("call-1"));
		assert.equal(reservation.status, "reserved");
		if (reservation.status !== "reserved") return;
		assert.equal(
			read(agentDir).status === "found" &&
				(read(agentDir) as { evidence: { reservation: { outcome: string } } }).evidence.reservation.outcome,
			"pending",
		);

		markPilotAttemptRecovery(reservation.handle, "an unreadable recovery marker exists");
		const marked = read(agentDir);
		assert.deepEqual(marked.status === "found" && marked.evidence.reservation.recovery, {
			reason: "an unreadable recovery marker exists",
		});

		writeRaw(join(caseDir(agentDir), "reservation-1.outcome.json"), "{not json");
		renameSync(join(caseDir(agentDir), "reservation-1.recovery.json"), join(caseDir(agentDir), "tmp", "moved.json"));
		writeRaw(join(caseDir(agentDir), "reservation-1.recovery.json"), "{not json");
		const garbage = read(agentDir);
		assert.equal(garbage.status === "found" && garbage.evidence.reservation.outcome, "unknown");
		assert.deepEqual(garbage.status === "found" && garbage.evidence.reservation.recovery, { unreadable: true });
	});

	test("missing evidence is reported with a code, never as an empty success, and creates nothing", () => {
		const absent = join(agentDirectory(), "no-such-agent-dir");
		assert.deepEqual(pick(read(absent)), ["missing", "store"]);
		assert.throws(() => lstatSync(absent));

		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1", false);
		committedLaunch(agentDir, "call-2", false);
		assert.deepEqual(pick(read(agentDir, "call-1", "other-case")), ["missing", "case"]);
		assert.deepEqual(pick(read(agentDir, "never-claimed")), ["missing", "launch_unclaimed"]);
		// The case allows two attempts: a third launch claims its id and is refused as exhausted.
		assert.equal(reservePilotAttempt(storeOf(agentDir), request("call-3")).status, "exhausted");
		const before = snapshot(agentDir);
		assert.deepEqual(pick(read(agentDir, "call-3")), ["missing", "launch_not_reserved"]);
		assert.deepEqual(snapshot(agentDir), before);

		const bare = agentDirectory();
		mkdirSync(caseDir(bare), { recursive: true, mode: 0o700 });
		chmodSync(storeOf(bare), 0o700);
		assert.deepEqual(pick(read(bare)), ["missing", "case_record"]);
	});

	test("an unreadable store or case directory is unreadable, not missing", () => {
		const open = agentDirectory();
		committedLaunch(open, "call-1");
		chmodSync(storeOf(open), 0o755);
		assert.equal(read(open).status, "unreadable");

		const openCase = agentDirectory();
		committedLaunch(openCase, "call-1");
		chmodSync(caseDir(openCase), 0o750);
		assert.equal(read(openCase).status, "unreadable");

		const linked = agentDirectory();
		const real = agentDirectory();
		committedLaunch(real, "call-1");
		symlinkSync(storeOf(real), storeOf(linked));
		assert.equal(read(linked).status, "unreadable");
	});

	test("a reservation or record that cannot be read is unreadable, not missing", {
		skip: process.getuid?.() === 0,
	}, () => {
		// The launch's reservation could be the one that cannot be read.
		const locked = agentDirectory();
		committedLaunch(locked, "call-1", false);
		committedLaunch(locked, "call-2", false);
		chmodSync(join(caseDir(locked), "reservation-1.json"), 0o000);
		assert.equal(read(locked, "call-1").status, "unreadable");
		assert.equal(read(locked, "never-reserved").status, "unreadable");
		// A readable match does not depend on an unrelated reservation.
		assert.equal(read(locked, "call-2").status, "found");

		const lockedRecord = agentDirectory();
		committedLaunch(lockedRecord, "call-1");
		chmodSync(join(caseDir(lockedRecord), `block-${launchHash("call-1")}-1.json`), 0o000);
		assert.equal(read(lockedRecord).status, "unreadable");
	});

	test("a launch that reserves, commits and appends after the reservation scan is found, not damaged", () => {
		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1", false);
		// Listing 1 scans reservations; the launch then finishes before listing 2 looks for orphaned records.
		const result = readDuringListing(agentDir, "call-2", 2, () => {
			committedLaunch(agentDir, "call-2");
		});
		assert.equal(result.status, "found", JSON.stringify(result));
		assert.equal(result.status === "found" && result.evidence.verdict.length, 1);
	});

	test("a planted named pipe is invalid instead of blocking the read", () => {
		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1");
		execFileSync("mkfifo", ["-m", "600", join(caseDir(agentDir), `verdict-${launchHash("call-1")}-2.json`)]);
		const script = [
			`const { readPilotEvidence } = await import(${JSON.stringify(join(process.cwd(), "src/routing/pilot-evidence.ts"))});`,
			`console.log(JSON.stringify(readPilotEvidence({ agentDir: ${JSON.stringify(agentDir)}, caseId: ${JSON.stringify(CASE_ID)}, launchId: "call-1" })));`,
		].join("\n");
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 10_000,
		});
		const result = JSON.parse(output) as { status: string; reason: string };
		assert.equal(result.status, "invalid", output);
		assert.match(result.reason, /verdict-[0-9a-f]+-2\.json is not a file/);
	});

	test("a launch that claims and reserves while the reader lists it is found, not damaged", () => {
		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1", false);
		// The launch links its claim and reservation just after the reader looked for the claim.
		const result = readDuringListing(agentDir, "call-2", 1, () =>
			assert.equal(reservePilotAttempt(storeOf(agentDir), request("call-2")).status, "reserved"),
		);
		assert.equal(result.status, "found", JSON.stringify(result));
		assert.equal(result.status === "found" && result.evidence.reservation.outcome, "pending");
	});

	test("a launch that commits and appends while the reader lists its records is found, not damaged", () => {
		const agentDir = agentDirectory();
		const reservation = reservePilotAttempt(storeOf(agentDir), request("call-1"));
		if (reservation.status !== "reserved") return assert.fail("not reserved");
		// The launch commits and appends just after the reader read its outcome.
		const result = readDuringListing(agentDir, "call-1", 2, () => {
			assert.equal(commitPilotAttempt(reservation.handle).status, "committed");
			const body = { verdict: "accepted" };
			assert.equal(
				appendPilotRecord(storeOf(agentDir), { caseId: CASE_ID, launchId: "call-1", kind: "verdict", body }).status,
				"appended",
			);
		});
		assert.equal(result.status, "found", JSON.stringify(result));
		assert.equal(result.status === "found" && result.evidence.reservation.outcome, "committed");
		assert.equal(result.status === "found" && result.evidence.verdict.length, 1);
	});

	test("malformed evidence is invalid: case record, reservations, records and file names", () => {
		const cases: Array<[string, (agentDir: string) => void, RegExp, string?]> = [
			["garbage case record", (dir) => replace(join(caseDir(dir), "case.json"), "{"), /case\.json is not JSON/],
			[
				"case record for another case id",
				(dir) =>
					replace(
						join(caseDir(dir), "case.json"),
						JSON.stringify({ version: 1, caseId: "other", caseDigest: pilotCaseDigest(caseRecord()) }),
					),
				/case\.json is malformed/,
			],
			[
				"garbage reservation with no match",
				(dir) => replace(join(caseDir(dir), "reservation-1.json"), "{"),
				/reservation-1\.json is not JSON/,
				"never-reserved",
			],
			[
				"receipt missing its Controller",
				(dir) =>
					editJson(join(caseDir(dir), "reservation-1.json"), (value) => {
						delete (value.receipt as Record<string, unknown>).controller;
					}),
				/reservation-1\.json is malformed/,
			],
			[
				"receipt for another case digest",
				(dir) =>
					editJson(join(caseDir(dir), "reservation-1.json"), (value) => {
						(value.receipt as Record<string, unknown>).caseDigest = "sha256:other";
					}),
				/reservation-1\.json is malformed/,
			],
			[
				"reservation numbers with a gap",
				(dir) => renameSync(join(caseDir(dir), "reservation-1.json"), join(caseDir(dir), "reservation-3.json")),
				/reservation numbers have a gap/,
				"never-reserved",
			],
			[
				"reservation file with a leading zero",
				(dir) => linkSync(join(caseDir(dir), "reservation-1.json"), join(caseDir(dir), "reservation-01.json")),
				/reservation-01\.json has a malformed number/,
			],
			[
				"garbage verdict record",
				(dir) => replace(join(caseDir(dir), `verdict-${launchHash("call-1")}-1.json`), "{"),
				/verdict-[0-9a-f]+-1\.json is not JSON/,
			],
			[
				"record whose kind disagrees with its name",
				(dir) =>
					editJson(join(caseDir(dir), `block-${launchHash("call-1")}-1.json`), (value) => {
						value.kind = "verdict";
					}),
				/block-[0-9a-f]+-1\.json is malformed/,
			],
			[
				"record sequence with a gap",
				(dir) => {
					const second = join(caseDir(dir), `resume-${launchHash("call-1")}-2.json`);
					editJson(second, (value) => {
						value.sequence = 3;
					});
					renameSync(second, join(caseDir(dir), `resume-${launchHash("call-1")}-3.json`));
				},
				/resume record numbers have a gap/,
			],
			[
				"reservation with no launch claim",
				(dir) =>
					renameSync(
						join(caseDir(dir), `launch-${launchHash("call-1")}.json`),
						join(caseDir(dir), "tmp", "claim.json"),
					),
				/has no launch claim/,
			],
			[
				"two reservations for the launch",
				(dir) => {
					const value = JSON.parse(readFileSync(join(caseDir(dir), "reservation-1.json"), "utf8"));
					writeRaw(join(caseDir(dir), "reservation-2.json"), JSON.stringify({ ...value, number: 2 }));
				},
				/more than one reservation/,
			],
			[
				"record for another case id",
				(dir) =>
					editJson(join(caseDir(dir), `verdict-${launchHash("call-1")}-1.json`), (value) => {
						value.caseId = "other";
					}),
				/verdict-[0-9a-f]+-1\.json is malformed/,
			],
			[
				"record file with a leading zero",
				(dir) =>
					linkSync(
						join(caseDir(dir), `verdict-${launchHash("call-1")}-1.json`),
						join(caseDir(dir), `verdict-${launchHash("call-1")}-01.json`),
					),
				/verdict-[0-9a-f]+-01\.json has a malformed number/,
			],
			[
				"record file that is a symlink",
				(dir) => {
					const record = join(caseDir(dir), `verdict-${launchHash("call-1")}-1.json`);
					renameSync(record, join(caseDir(dir), "tmp", "verdict.json"));
					symlinkSync(join(caseDir(dir), "tmp", "verdict.json"), record);
				},
				/verdict-[0-9a-f]+-1\.json is a symlink/,
			],
			[
				"record under a reservation that was never committed",
				(dir) => {
					assert.equal(reservePilotAttempt(storeOf(dir), request("call-2")).status, "reserved");
					const value = JSON.parse(readFileSync(join(caseDir(dir), `verdict-${launchHash("call-1")}-1.json`), "utf8"));
					writeRaw(
						join(caseDir(dir), `verdict-${launchHash("call-2")}-1.json`),
						JSON.stringify({ ...value, launchId: "call-2" }),
					);
				},
				/records but is pending/,
				"call-2",
			],
			[
				"records of a launch whose only reservation was removed",
				(dir) => renameSync(join(caseDir(dir), "reservation-1.json"), join(caseDir(dir), "tmp", "reservation.json")),
				/records but no reservation/,
			],
			[
				"records of a launch whose reservation and claim were removed",
				(dir) => {
					renameSync(join(caseDir(dir), "reservation-1.json"), join(caseDir(dir), "tmp", "reservation.json"));
					renameSync(
						join(caseDir(dir), `launch-${launchHash("call-1")}.json`),
						join(caseDir(dir), "tmp", "claim.json"),
					);
				},
				/records but no reservation/,
			],
		];
		for (const [name, corrupt, reason, launchId] of cases) {
			const agentDir = agentDirectory();
			committedLaunch(agentDir, "call-1");
			corrupt(agentDir);
			const result = read(agentDir, launchId);
			assert.equal(result.status, "invalid", `${name}: ${JSON.stringify(result)}`);
			assert.match((result as { reason: string }).reason, reason, name);
		}
	});
});

describe("pilot case digest", () => {
	test("pins the canonical JSON, UTF-8 and SHA-256 encoding with fixed vectors", () => {
		assert.equal(
			pilotCaseDigest(caseRecord()),
			"sha256:8a41adcb10bf83c86734bc1b71295d346e799e2747eeed24bad32a045ba0763d",
		);
		const changed = caseRecord();
		changed.attempts.allowed = 3;
		assert.equal(pilotCaseDigest(changed), "sha256:f874878851fd5a39d829e2021433504b846455b7d4ce34e299db90feeb098c97");
		// Key order in the input does not matter.
		const reordered = Object.fromEntries(Object.entries(caseRecord()).reverse());
		assert.equal(pilotCaseDigest(reordered), pilotCaseDigest(caseRecord()));
	});

	test("refuses values JSON cannot carry instead of hashing them", () => {
		for (const value of [
			undefined,
			{ a: undefined },
			Number.NaN,
			{ a: Number.POSITIVE_INFINITY },
			() => 1,
			new Date(0),
			new Array(1),
			cyclic(),
			{ a: 1n },
		]) {
			assert.throws(() => pilotCaseDigest(value), TypeError, String(value));
		}
	});
});

describe("pilot evidence package entrypoint", () => {
	test("a linked consumer imports only the read API by package subpath, launching and writing nothing", () => {
		const agentDir = agentDirectory();
		committedLaunch(agentDir, "call-1");
		const before = snapshot(agentDir);
		const consumer = agentDirectory();
		mkdirSync(join(consumer, "node_modules"));
		symlinkSync(process.cwd(), join(consumer, "node_modules", "pi-subagents"));
		const script = [
			'import { registerHooks } from "node:module";',
			"const loaded = [];",
			"registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.push(result.url); return result; } });",
			'const api = await import("pi-subagents/pilot-evidence");',
			`const result = api.readPilotEvidence({ agentDir: ${JSON.stringify(agentDir)}, caseId: ${JSON.stringify(CASE_ID)}, launchId: "call-1" });`,
			"console.log(JSON.stringify({",
			"  exports: Object.keys(api).sort(),",
			"  status: result.status,",
			"  verdicts: result.evidence?.verdict.length,",
			'  trusted: globalThis[Symbol.for("drover.pi-subagents.trusted-launch")] !== undefined,',
			'  foreign: loaded.filter((url) => !url.startsWith("node:") && !/\\/src\\/routing\\/(pilot-evidence|pilot-attempt-store|write-once-records)\\.ts$/.test(url)),',
			"}));",
		].join("\n");
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: consumer,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.deepEqual(JSON.parse(output), {
			exports: ["pilotCaseDigest", "readPilotEvidence"],
			status: "found",
			verdicts: 1,
			trusted: false,
			foreign: [],
		});
		assert.deepEqual(snapshot(agentDir), before);
	});
});

function pick(result: ReturnType<typeof readPilotEvidence>): [string, string | undefined] {
	return [result.status, (result as { code?: string }).code];
}

/** Rewrite a hard-linked record in place, as damage from outside the store would. */
function replace(path: string, text: string): void {
	chmodSync(path, 0o600);
	writeRaw(path, text);
}

function editJson(path: string, edit: (value: Record<string, unknown>) => void): void {
	const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	edit(value);
	replace(path, JSON.stringify(value));
}

function cyclic(): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	value.self = value;
	return value;
}

/** Read with `write` run just before the reader's `call`-th directory listing, as a concurrent writer would. */
function readDuringListing(agentDir: string, launchId: string, call: number, write: () => void) {
	const original = fs.readdirSync;
	let calls = 0;
	const restore = () => {
		hooked.mock.restore();
		syncBuiltinESMExports();
	};
	const hooked = mock.method(fs, "readdirSync", ((...args: Parameters<typeof original>) => {
		if (++calls === call) {
			restore();
			write();
		}
		return original(...args);
	}) as typeof original);
	syncBuiltinESMExports();
	try {
		return read(agentDir, launchId);
	} finally {
		if (calls < call) restore();
	}
}
