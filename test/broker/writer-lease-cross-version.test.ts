import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { classifyExecutionGroup, classifySupervisor, type ProcReader } from "../../src/broker/writer-group.ts";
import { acquireWriterLease, containWriterLease } from "../../src/broker/writer-lease.ts";
import "../support/temp-root.ts";
import { acquired, files, group, LEASED, proc, request, storeRoot, supervisor } from "../support/writer-lease-store.ts";

const running = proc({ 50: ["S", "100"], 400: ["S", "9000"] });
const groupGone = proc({ 50: ["S", "100"] });
const parentCrashed = proc({});

function keyDir(root: string): string {
	return join(root, readdirSync(root)[0] as string);
}

/**
 * The reclaim rule of parents from before the containment marker (`tryReclaim`
 * and `proveLeaseEmpty` at 3320a85^1): an ended lease is free; otherwise the
 * supervisor must be dead, no `lease-<n>.spawn-unproven.json` may exist,
 * whatever it contains, and every recorded group must be proven gone. Such
 * parents never read `lease-<n>.contained.json`.
 */
function preContainmentReclaim(root: string, number: number, reader: ProcReader): "held" | "reclaimed" {
	const dir = keyDir(root);
	if (existsSync(join(dir, `lease-${number}.end.json`))) return "reclaimed";
	const record = JSON.parse(readFileSync(join(dir, `lease-${number}.json`), "utf8"));
	if (classifySupervisor({ ...record.supervisor, bootId: record.bootId }, reader).state !== "dead") return "held";
	if (existsSync(join(dir, `lease-${number}.spawn-unproven.json`))) return "held";
	const groups = readdirSync(dir)
		.filter((name) => new RegExp(`^lease-${number}\\.group-\\d+\\.json$`).test(name))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).group);
	if (groups.length === 0) return "held";
	const gone = groups.every((g) => classifyExecutionGroup(g, record.supervisor.pidNamespace, reader).state === "empty");
	return gone ? "reclaimed" : "held";
}

/** Run `body` with the store's `tmp/` read-only, so a record cannot be linked through it. */
function withReadOnlyTmp<T>(root: string, body: () => T): T {
	chmodSync(join(keyDir(root), "tmp"), 0o500);
	try {
		return body();
	} finally {
		chmodSync(join(keyDir(root), "tmp"), 0o700);
	}
}

function clear(root: string, number = 1): void {
	writeFileSync(join(keyDir(root), `lease-${number}.cleared.json`), '{"by":"operator"}\n');
}

describe("a contained writer lease across package versions", () => {
	afterEach(() => {
		rmSync(join(LEASED.linked, "sub"), { recursive: true, force: true });
		rmSync(join(LEASED.common, "pi-subagents"), { recursive: true, force: true });
	});

	test("a parent from before the containment marker keeps a supervisor-contained lease held", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		assert.equal(preContainmentReclaim(root, 1, parentCrashed), "reclaimed", "the scenario would reclaim an uncontained lease");

		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });

		assert.equal(preContainmentReclaim(root, 1, parentCrashed), "held");
		const marker = JSON.parse(readFileSync(join(keyDir(root), "lease-1.spawn-unproven.json"), "utf8"));
		assert.match(marker.reason, /contained.*identity changed/);
	});

	test("a parent from before the containment marker keeps a lease a reclaim contained held", () => {
		const root = storeRoot();
		acquired(root, running).recordGroup(group, 1);
		mkdirSync(join(LEASED.linked, "sub"), { recursive: true });
		writeFileSync(join(LEASED.linked, "sub", ".git"), "gitdir: ../evil\n");

		assert.equal(acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor }).status, "held");

		assert.equal(preContainmentReclaim(root, 1, parentCrashed), "held");
	});

	test("a lease contained without the marker gains it at the next launch into the worktree", () => {
		const root = storeRoot();
		acquired(root, running).recordGroup(group, 1);
		writeFileSync(join(keyDir(root), "lease-1.contained.json"), '{"reason":"contained by an earlier version"}\n');

		// Not while its supervisor lives: it may still record a genuine unproven spawn under that name.
		assert.equal(acquireWriterLease(root, request("call-2"), { reader: running, supervisor }).status, "held");
		assert.ok(!files(root).includes("lease-1.spawn-unproven.json"), "marked a lease whose supervisor still runs");

		assert.equal(acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor }).status, "held");

		assert.equal(preContainmentReclaim(root, 1, parentCrashed), "held");
	});

	test("an operator's clear still ends a contained lease proven empty", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });
		clear(root);

		const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });

		assert.equal(later.status, "acquired", JSON.stringify(later));
		assert.equal(JSON.parse(readFileSync(join(keyDir(root), "lease-1.end.json"), "utf8")).kind, "cleared");
	});

	test("a containment interrupted before its containment record still holds, and an operator's clear ends it", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });
		// A crash after the unproven-spawn marker, before the containment record.
		rmSync(join(keyDir(root), "lease-1.contained.json"));

		const held = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });
		assert.equal(held.status, "held");
		assert.match(held.status === "held" ? held.reason : "", /contained.*identity changed.*cleared\.json/);

		clear(root);
		assert.equal(acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor }).status, "acquired");
	});

	test("a spawn left unproven blocks an operator's clear, whether it came before or after the containment", () => {
		const before = storeRoot();
		const first = acquired(before, running);
		first.recordGroup(group, 1);
		first.markSpawnUnproven("generation 2 could not be proven gone");
		containWriterLease(first, "identity changed", { reader: groupGone, kill: () => {} });
		clear(before);
		const blockedBefore = acquireWriterLease(before, request("call-2"), { reader: parentCrashed, supervisor });
		assert.equal(blockedBefore.status, "held");
		assert.match(blockedBefore.status === "held" ? blockedBefore.reason : "", /cleared but generation 2/);

		const after = storeRoot();
		const second = acquired(after, running);
		second.recordGroup(group, 1);
		containWriterLease(second, "identity changed", { reader: groupGone, kill: () => {} });
		second.markSpawnUnproven("generation 2 could not be proven gone");
		assert.ok(files(after).includes("lease-1.spawn-unproven-late.json"));
		clear(after);
		const blockedAfter = acquireWriterLease(after, request("call-2"), { reader: parentCrashed, supervisor });
		assert.equal(blockedAfter.status, "held");
		assert.match(blockedAfter.status === "held" ? blockedAfter.reason : "", /cleared but generation 2/);
		assert.ok(!files(after).includes("lease-1.end.json"));
	});

	test("an unreadable unproven-spawn marker blocks an operator's clear", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		writeFileSync(join(keyDir(root), "lease-1.spawn-unproven.json"), "");
		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });
		clear(root);
		assert.equal(acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor }).status, "held");
	});

	test("a contained lease keeps older parents held when its unproven-spawn marker cannot be linked through tmp", () => {
		const legacy = storeRoot();
		acquired(legacy, running).recordGroup(group, 1);
		writeFileSync(join(keyDir(legacy), "lease-1.contained.json"), '{"reason":"contained by an earlier version"}\n');
		const backfill = withReadOnlyTmp(legacy, () =>
			acquireWriterLease(legacy, request("call-2"), { reader: parentCrashed, supervisor }),
		);
		assert.equal(backfill.status, "held", JSON.stringify(backfill));
		assert.equal(preContainmentReclaim(legacy, 1, parentCrashed), "held");

		const breached = storeRoot();
		acquired(breached, running).recordGroup(group, 1);
		mkdirSync(join(LEASED.linked, "sub"), { recursive: true });
		writeFileSync(join(LEASED.linked, "sub", ".git"), "gitdir: ../evil\n");
		const reclaim = withReadOnlyTmp(breached, () =>
			acquireWriterLease(breached, request("call-2"), { reader: parentCrashed, supervisor }),
		);
		assert.equal(reclaim.status, "held", JSON.stringify(reclaim));
		assert.ok(files(breached).includes("lease-1.contained.json"));
		assert.equal(preContainmentReclaim(breached, 1, parentCrashed), "held");
	});
});
