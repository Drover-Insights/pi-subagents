import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
	appendPilotRecord,
	commitPilotAttempt,
	markPilotAttemptRecovery,
	type PilotAttemptRequest,
	type PilotReceipt,
	readPilotCase,
	refundPilotAttempt,
	reservePilotAttempt,
} from "../../src/routing/pilot-attempt-store.ts";
import "../support/temp-root.ts";

const run = promisify(execFile);

function storeRoot(): string {
	return join(realpathSync(mkdtempSync(join(tmpdir(), "pilot-attempts-"))), "pilot-attempts");
}

function receipt(overrides: Partial<PilotReceipt> = {}): PilotReceipt {
	return {
		generation: "gen-7",
		caseDigest: "sha256:case-a",
		controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
		runtime: { pi: { command: "/usr/bin/node", commandSha256: "a".repeat(64), entry: null } },
		...overrides,
	};
}

function request(launchId: string, overrides: Partial<PilotAttemptRequest> = {}): PilotAttemptRequest {
	return {
		caseId: "scout-literal-1",
		caseDigest: "sha256:case-a",
		allowed: 2,
		launchId,
		receipt: receipt(),
		...overrides,
	};
}

function reserved(root: string, launchId: string, overrides: Partial<PilotAttemptRequest> = {}) {
	const result = reservePilotAttempt(root, request(launchId, overrides));
	assert.equal(result.status, "reserved", JSON.stringify(result));
	return result.status === "reserved" ? result.handle : assert.fail("not reserved");
}

function caseDir(root: string, caseId = "scout-literal-1"): string {
	return join(root, createHash("sha256").update(caseId).digest("hex"));
}

describe("durable pilot attempt store", () => {
	test("reserves at most the allowed attempts and refuses the next as exhausted", () => {
		const root = storeRoot();
		reserved(root, "call-1");
		reserved(root, "call-2");

		const third = reservePilotAttempt(root, request("call-3"));

		assert.equal(third.status, "exhausted");
		assert.deepEqual(
			readPilotCase(root, "scout-literal-1")?.reservations.map((entry) => [entry.number, entry.launchId, entry.outcome]),
			[
				[1, "call-1", "pending"],
				[2, "call-2", "pending"],
			],
		);
	});

	test("a refunded attempt frees one reservation; a committed one never does", () => {
		const root = storeRoot();
		const first = reserved(root, "call-1");
		const second = reserved(root, "call-2");
		assert.deepEqual(commitPilotAttempt(first), { status: "committed" });
		assert.deepEqual(refundPilotAttempt(second, ["the writer was killed before it ran"]), { status: "refunded" });

		reserved(root, "call-3");

		assert.equal(reservePilotAttempt(root, request("call-4")).status, "exhausted");
		assert.deepEqual(
			readPilotCase(root, "scout-literal-1")?.reservations.map((entry) => entry.outcome),
			["committed", "refunded", "pending"],
		);
	});

	test("commit and refund exclude each other and never repeat", () => {
		const root = storeRoot();
		const committed = reserved(root, "call-1");
		const refunded = reserved(root, "call-2");
		commitPilotAttempt(committed);
		refundPilotAttempt(refunded, ["never started"]);

		assert.equal(refundPilotAttempt(committed, ["late"]).status, "refused");
		assert.equal(commitPilotAttempt(committed).status, "refused");
		assert.equal(commitPilotAttempt(refunded).status, "refused");
		assert.equal(refundPilotAttempt(refunded, ["again"]).status, "refused");
		assert.deepEqual(
			readPilotCase(root, "scout-literal-1")?.reservations.map((entry) => entry.outcome),
			["committed", "refunded"],
		);
	});

	test("a handle from another reservation cannot settle this one", () => {
		const root = storeRoot();
		const handle = reserved(root, "call-1");

		const forged = { ...handle, nonce: "0".repeat(32) };

		assert.equal(refundPilotAttempt(forged, ["forged"]).status, "refused");
		assert.equal(commitPilotAttempt(forged).status, "refused");
		assert.equal(readPilotCase(root, "scout-literal-1")?.reservations[0]?.outcome, "pending");
	});

	test("a replayed launch id resolves to its reservation and consumes nothing more", () => {
		const root = storeRoot();
		const handle = reserved(root, "call-1");
		commitPilotAttempt(handle);

		const replay = reservePilotAttempt(root, request("call-1", { receipt: receipt({ generation: "gen-8" }) }));

		assert.deepEqual(replay, { status: "replayed", number: 1, outcome: "committed" });
		const state = readPilotCase(root, "scout-literal-1");
		assert.equal(state?.reservations.length, 1);
		assert.equal(state?.reservations[0]?.receipt.generation, "gen-7");
	});

	test("a replayed launch id is refused even after its reservation was refunded", () => {
		const root = storeRoot();
		refundPilotAttempt(reserved(root, "call-1"), ["never started"]);

		assert.deepEqual(reservePilotAttempt(root, request("call-1")), { status: "replayed", number: 1, outcome: "refunded" });
		assert.equal(readPilotCase(root, "scout-literal-1")?.reservations.length, 1);
	});

	test("a launch id spent without a reservation is refused, not reserved again", () => {
		const root = storeRoot();
		reserved(root, "call-1");
		reserved(root, "call-2");
		assert.equal(reservePilotAttempt(root, request("call-3")).status, "exhausted");

		assert.deepEqual(reservePilotAttempt(root, request("call-3", { allowed: 5 })), {
			status: "replayed",
			number: null,
			outcome: null,
		});
	});

	test("consumption is keyed by case id and survives a generation change and rollback", () => {
		const root = storeRoot();
		commitPilotAttempt(reserved(root, "call-1", { receipt: receipt({ generation: "gen-8" }) }));
		commitPilotAttempt(reserved(root, "call-2", { receipt: receipt({ generation: "gen-8" }) }));

		const rolledBack = reservePilotAttempt(root, request("call-3", { receipt: receipt({ generation: "gen-7" }) }));

		assert.equal(rolledBack.status, "exhausted");
	});

	test("a case record that changed under the same case id is refused and writes nothing", () => {
		const root = storeRoot();
		reserved(root, "call-1");
		const before = readdirSync(caseDir(root)).sort();

		const changed = reservePilotAttempt(root, request("call-2", { caseDigest: "sha256:case-b", allowed: 9 }));

		assert.equal(changed.status, "case_changed");
		assert.deepEqual(readdirSync(caseDir(root)).sort(), before);
	});

	test("crash states count as consumed: no outcome, an empty outcome, a garbage outcome, stray temporary files", () => {
		const root = storeRoot();
		reserved(root, "call-1", { allowed: 3 });
		reserved(root, "call-2", { allowed: 3 });
		reserved(root, "call-3", { allowed: 3 });
		const dir = caseDir(root);
		writeFileSync(join(dir, "reservation-2.outcome.json"), "");
		writeFileSync(join(dir, "reservation-3.outcome.json"), "{not json");
		writeFileSync(join(dir, "tmp", "123-deadbeef.json"), '{"kind":"refunded"}');

		assert.equal(reservePilotAttempt(root, request("call-4", { allowed: 3 })).status, "exhausted");
		const state = readPilotCase(root, "scout-literal-1");
		assert.deepEqual(
			state?.reservations.map((entry) => entry.outcome),
			["pending", "unknown", "unknown"],
		);
		assert.deepEqual(
			state?.reservations.map((entry) => entry.receipt),
			[receipt(), receipt(), receipt()],
			"every crash state keeps its Controller snapshot",
		);
	});

	test("a crash between claiming a launch id and linking its reservation spends the id and nothing else", () => {
		const root = storeRoot();
		reserved(root, "call-1");
		writeFileSync(
			join(caseDir(root), `launch-${createHash("sha256").update("call-crashed").digest("hex")}.json`),
			'{"launchId":"call-crashed"}',
		);

		assert.deepEqual(reservePilotAttempt(root, request("call-crashed")), { status: "replayed", number: null, outcome: null });
		reserved(root, "call-2");
		assert.equal(readPilotCase(root, "scout-literal-1")?.reservations.length, 2);
	});

	test("an unreadable reservation counts as consumed and is reported", () => {
		const root = storeRoot();
		reserved(root, "call-1");
		writeFileSync(join(caseDir(root), "reservation-2.json"), "{");

		assert.equal(reservePilotAttempt(root, request("call-2")).status, "exhausted");
		assert.deepEqual(readPilotCase(root, "scout-literal-1")?.unreadable, [2]);
	});

	test("a gap in the reservation numbers makes the store unavailable rather than reusing a number", () => {
		const root = storeRoot();
		reserved(root, "call-1", { allowed: 5 });
		const dir = caseDir(root);
		linkSync(join(dir, "reservation-1.json"), join(dir, "reservation-3.json"));

		const next = reservePilotAttempt(root, request("call-2", { allowed: 5 }));

		assert.equal(next.status, "unavailable");
		assert.equal(existsSync(join(dir, "reservation-2.json")), false);
		assert.equal(existsSync(join(dir, "reservation-4.json")), false);
	});

	test("a reservation marked for recovery stays consumed and keeps the first reason", () => {
		const root = storeRoot();
		const handle = reserved(root, "call-1", { allowed: 1 });

		markPilotAttemptRecovery(handle, "the child may still run");
		markPilotAttemptRecovery(handle, "second reason");

		const state = readPilotCase(root, "scout-literal-1");
		assert.equal(state?.reservations[0]?.outcome, "pending");
		assert.equal(state?.reservations[0]?.recovery, "the child may still run");
		assert.equal(reservePilotAttempt(root, request("call-2", { allowed: 1 })).status, "exhausted");
	});

	test("the receipt is written in the reservation and never rewritten", () => {
		const root = storeRoot();
		const handle = reserved(root, "call-1");
		commitPilotAttempt(handle);
		appendPilotRecord(root, {
			caseId: "scout-literal-1",
			launchId: "call-1",
			kind: "resume",
			body: { route: { provider: "openai-codex", model: "other", effort: "high" } },
		});

		const state = readPilotCase(root, "scout-literal-1");
		assert.deepEqual(state?.reservations[0]?.receipt, receipt());
		const raw = JSON.parse(readFileSync(join(caseDir(root), "reservation-1.json"), "utf8"));
		assert.deepEqual(raw.receipt, receipt());
	});

	test("resume, block and verdict records append in sequence under a committed launch", () => {
		const root = storeRoot();
		commitPilotAttempt(reserved(root, "call-1"));
		const append = (kind: "resume" | "block" | "verdict", body: Record<string, unknown>) =>
			appendPilotRecord(root, { caseId: "scout-literal-1", launchId: "call-1", kind, body });

		assert.deepEqual(append("block", { reason: "drift" }), { status: "appended", sequence: 1 });
		assert.deepEqual(append("block", { reason: "again" }), { status: "appended", sequence: 2 });
		assert.deepEqual(append("resume", { route: "same" }), { status: "appended", sequence: 1 });
		assert.deepEqual(append("verdict", { checks: [{ name: "a", result: "pass" }] }), {
			status: "appended",
			sequence: 1,
		});

		const records = readPilotCase(root, "scout-literal-1")?.reservations[0]?.records;
		assert.deepEqual(
			records?.map((record) => [record.kind, record.sequence, record.body]),
			[
				["block", 1, { reason: "drift" }],
				["block", 2, { reason: "again" }],
				["resume", 1, { route: "same" }],
				["verdict", 1, { checks: [{ name: "a", result: "pass" }] }],
			],
		);
		// Resume never consumes or restores an attempt.
		reserved(root, "call-2");
		assert.equal(reservePilotAttempt(root, request("call-3")).status, "exhausted");
	});

	test("records require a committed reservation of that launch id", () => {
		const root = storeRoot();
		reserved(root, "call-pending");
		refundPilotAttempt(reserved(root, "call-refunded"), ["never started"]);

		for (const launchId of ["call-pending", "call-refunded", "call-unknown"]) {
			const result = appendPilotRecord(root, { caseId: "scout-literal-1", launchId, kind: "resume", body: {} });
			assert.equal(result.status, "refused", launchId);
		}
		assert.equal(
			appendPilotRecord(root, { caseId: "unknown-case", launchId: "call-pending", kind: "verdict", body: {} }).status,
			"refused",
		);
	});

	test("concurrent processes never reserve more than the allowed attempts", async () => {
		const root = storeRoot();
		const script = `
			import { reservePilotAttempt } from ${JSON.stringify(new URL("../../src/routing/pilot-attempt-store.ts", import.meta.url).href)};
			const request = JSON.parse(process.argv[1]);
			while (Date.now() < Number(process.argv[2])) {}
			console.log(reservePilotAttempt(process.argv[3], request).status);
		`;
		const startAt = String(Date.now() + 3000);
		const racers = Array.from({ length: 6 }, (_, index) =>
			run(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request(`call-${index}`)), startAt, root]),
		);

		const statuses = (await Promise.all(racers)).map((result) => result.stdout.trim()).sort();

		assert.deepEqual(statuses, ["exhausted", "exhausted", "exhausted", "exhausted", "reserved", "reserved"]);
		assert.deepEqual(
			readPilotCase(root, "scout-literal-1")?.reservations.map((entry) => entry.number),
			[1, 2],
		);
	});

	test("concurrent processes replaying one launch id reserve it once", async () => {
		const root = storeRoot();
		const script = `
			import { reservePilotAttempt } from ${JSON.stringify(new URL("../../src/routing/pilot-attempt-store.ts", import.meta.url).href)};
			const request = JSON.parse(process.argv[1]);
			while (Date.now() < Number(process.argv[2])) {}
			console.log(reservePilotAttempt(process.argv[3], request).status);
		`;
		const startAt = String(Date.now() + 3000);
		const racers = Array.from({ length: 4 }, () =>
			run(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request("call-same")), startAt, root]),
		);

		const statuses = (await Promise.all(racers)).map((result) => result.stdout.trim()).sort();

		assert.deepEqual(statuses, ["replayed", "replayed", "replayed", "reserved"]);
		assert.equal(readPilotCase(root, "scout-literal-1")?.reservations.length, 1);
	});

	test("the store refuses directories other users can reach or that are symlinks", () => {
		const root = storeRoot();
		mkdirSync(root, { mode: 0o700 });
		chmodSync(root, 0o755);
		assert.equal(reservePilotAttempt(root, request("call-1")).status, "unavailable");

		const other = storeRoot();
		mkdirSync(other, { mode: 0o700 });
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
		chmodSync(elsewhere, 0o700);
		symlinkSync(elsewhere, caseDir(other));
		assert.equal(reservePilotAttempt(other, request("call-1")).status, "unavailable");
		assert.deepEqual(readdirSync(elsewhere), []);
	});

	test("a reservation record linked by hand under a used number is never overwritten", () => {
		const root = storeRoot();
		reserved(root, "call-1", { allowed: 3 });
		const dir = caseDir(root);
		writeFileSync(join(dir, "tmp", "planted.json"), "{}");
		linkSync(join(dir, "tmp", "planted.json"), join(dir, "reservation-2.json"));
		rmSync(join(dir, "tmp", "planted.json"));

		const next = reservePilotAttempt(root, request("call-2", { allowed: 3 }));

		assert.equal(next.status, "reserved");
		assert.equal(next.status === "reserved" ? next.handle.number : 0, 3);
		assert.equal(readFileSync(join(dir, "reservation-2.json"), "utf8"), "{}");
		assert.ok(existsSync(join(dir, "reservation-3.json")));
	});
});
