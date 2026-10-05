import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import type { ExecutionGroup, ProcReader, SupervisorIdentity } from "../../src/broker/writer-group.ts";
import { acquireWriterLease, releaseWhenEmpty, type WriterLeaseRequest } from "../../src/broker/writer-lease.ts";
import "../support/temp-root.ts";

const run = promisify(execFile);

function storeRoot(): string {
	return join(realpathSync(mkdtempSync(join(tmpdir(), "writer-lease-"))), "writer-leases");
}

function request(launchId = "call-1"): WriterLeaseRequest {
	return {
		worktree: {
			top: "/repo/worktrees/task",
			gitDir: "/repo/main/.git/worktrees/task",
			commonDir: "/repo/main/.git",
			branch: "task",
			head: "a".repeat(40),
		},
		launchId,
		policyGeneration: "gen-7",
	};
}

const SELF_NS = "pid:[4026531836]";
const supervisor: SupervisorIdentity = { pid: 50, startTime: "100", pidNamespace: SELF_NS, bootId: "boot-1" };
const group: ExecutionGroup = { initPid: 400, startTime: "9000", pidNamespace: "pid:[4026534438]", bootId: "boot-1" };

function statLine(pid: number, state: string, startTime: string): string {
	const rest = [state, "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", startTime];
	return `${pid} (pi) ${rest.join(" ")}`;
}

/** A fake /proc: each listed PID is running (or in the given state) with the given start time; others are gone. */
function proc(processes: Record<number, [string, string]>, bootId = "boot-1"): ProcReader {
	return {
		bootId: () => bootId,
		stat: (pid) => {
			const entry = processes[pid];
			if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return statLine(pid, entry[0], entry[1]);
		},
		pidNamespace: (pid) => (pid === "self" ? SELF_NS : group.pidNamespace),
		signalZero: (pid) => {
			if (!processes[pid]) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		},
	};
}

const supervisorAlive = proc({ 50: ["S", "100"] });

function files(root: string): string[] {
	const [key] = readdirSync(root);
	return readdirSync(join(root, key as string))
		.filter((name) => name !== "tmp")
		.sort();
}

function acquired(root: string, reader: ProcReader, launchId?: string) {
	const result = acquireWriterLease(root, request(launchId), { reader, supervisor });
	assert.equal(result.status, "acquired", JSON.stringify(result));
	if (result.status !== "acquired") throw new Error("unreachable");
	return result.lease;
}

describe("writer lease store", () => {
	test("acquires one durable lease per worktree in a private directory, binding the launch to it", () => {
		const root = storeRoot();

		const lease = acquired(root, supervisorAlive);

		const keyDir = join(root, readdirSync(root)[0] as string);
		assert.equal(lstatSync(keyDir).mode & 0o777, 0o700);
		assert.equal(lstatSync(root).mode & 0o777, 0o700);
		const record = JSON.parse(readFileSync(join(keyDir, "lease-1.json"), "utf8"));
		assert.deepEqual(record, {
			version: 1,
			number: 1,
			repository: "/repo/main/.git",
			worktree: "/repo/worktrees/task",
			gitDir: "/repo/main/.git/worktrees/task",
			branch: "task",
			head: "a".repeat(40),
			launchId: "call-1",
			policyGeneration: "gen-7",
			bootId: "boot-1",
			supervisor: { pid: 50, startTime: "100", pidNamespace: SELF_NS },
			acquiredAt: record.acquiredAt,
		});
		assert.equal(lease.number, 1);
	});

	test("a held lease rejects a second launch into the same worktree", () => {
		const root = storeRoot();
		acquired(root, supervisorAlive);

		const second = acquireWriterLease(root, request("call-2"), { reader: supervisorAlive, supervisor });

		assert.equal(second.status, "held");
		assert.match(second.status === "held" ? second.reason : "", /held by launch call-1/);
	});

	test("refuses a store directory that is a symlink or readable by others", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "writer-lease-")));
		mkdirSync(join(base, "real"), { mode: 0o700 });
		symlinkSync(join(base, "real"), join(base, "linked"));
		const linked = acquireWriterLease(join(base, "linked"), request(), { reader: supervisorAlive, supervisor });
		assert.equal(linked.status, "unavailable");

		const open = join(base, "open");
		mkdirSync(open, { mode: 0o700 });
		chmodSync(open, 0o755);
		assert.equal(acquireWriterLease(open, request(), { reader: supervisorAlive, supervisor }).status, "unavailable");
	});

	test("releases only once the recorded group is proven empty, and never deletes a record", () => {
		const root = storeRoot();
		const lease = acquired(root, supervisorAlive);
		lease.recordGroup(group, 1);

		const running = lease.releaseIfEmpty(proc({ 50: ["S", "100"], 400: ["S", "9000"] }));
		assert.equal(running.status, "held");
		assert.equal(acquireWriterLease(root, request("call-2"), { reader: supervisorAlive, supervisor }).status, "held");

		assert.equal(lease.releaseIfEmpty(supervisorAlive).status, "released");
		const end = JSON.parse(readFileSync(join(root, readdirSync(root)[0] as string, "lease-1.end.json"), "utf8"));
		assert.equal(end.kind, "released");
		assert.match(end.evidence.join("\n"), /process 400 is gone/);

		acquired(root, supervisorAlive, "call-2");
		assert.deepEqual(files(root), ["lease-1.end.json", "lease-1.group-1.json", "lease-1.json", "lease-2.json"]);
	});

	test("a zombie init, an unreadable /proc, or no recorded group keeps the lease held and marked for recovery", () => {
		const cases: [string, ProcReader, boolean][] = [
			["zombie", proc({ 50: ["S", "100"], 400: ["Z", "9000"] }), true],
			["boot unreadable", { ...supervisorAlive, bootId: () => { throw new Error("EACCES"); } }, true],
			["no group", supervisorAlive, false],
		];
		for (const [name, reader, withGroup] of cases) {
			const root = storeRoot();
			const lease = acquired(root, supervisorAlive);
			if (withGroup) lease.recordGroup(group, 1);

			const result = lease.releaseIfEmpty(reader);

			assert.equal(result.status, "held", name);
			const marker = JSON.parse(readFileSync(join(root, readdirSync(root)[0] as string, "lease-1.recovery.json"), "utf8"));
			assert.ok(marker.reason.length > 0, name);
			assert.equal(result.status === "held" && result.reason, marker.reason, name);
		}
	});

	test("waits out a running group and a brief zombie however long the writer ran, and keeps polling after marking recovery", async () => {
		const sequence = (states: string[]) => {
			let call = 0;
			const reader: ProcReader = {
				...supervisorAlive,
				stat: (pid) => {
					if (pid !== 400) return supervisorAlive.stat(pid);
					const state = states[Math.min(call++, states.length - 1)] as string;
					if (state === "gone") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
					return statLine(400, state, "9000");
				},
				signalZero: (pid) => {
					if (pid === 400) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				},
			};
			return reader;
		};
		const runningLong = [...Array(20).fill("S"), "Z", "gone"];
		const longZombie = [...Array(20).fill("Z"), "gone"];
		for (const [name, states, marked] of [
			["long run, brief zombie", runningLong, false],
			["zombie past the grace", longZombie, true],
		] as const) {
			const root = storeRoot();
			const lease = acquired(root, supervisorAlive);
			lease.recordGroup(group, 1);

			const result = await releaseWhenEmpty(lease, { reader: sequence(states), intervalMs: 5, unknownGraceMs: 40 });

			assert.deepEqual(result, { status: "released" }, name);
			assert.equal(existsSync(join(lease.dir, "lease-1.recovery.json")), marked, name);
		}
	});

	test("an unreadable group record keeps the lease held instead of throwing", () => {
		const root = storeRoot();
		const lease = acquired(root, supervisorAlive);
		lease.recordGroup(group, 1);
		writeFileSync(join(lease.dir, "lease-1.group-2.json"), "{ not json");

		const result = lease.releaseIfEmpty(supervisorAlive);

		assert.equal(result.status, "held");
	});

	test("a spawn that may have left an unrecorded writer keeps the lease held for good", () => {
		const root = storeRoot();
		const lease = acquired(root, supervisorAlive);
		lease.recordGroup(group, 1);
		lease.markSpawnUnproven("generation 2 did not die within 5 s");

		const result = lease.releaseIfEmpty(supervisorAlive);

		assert.equal(result.status, "held");
		assert.match(result.status === "held" ? result.reason : "", /generation 2 did not die/);
	});

	test("a spawn-unproven marker left empty by a crash still keeps the lease held, as held", () => {
		const root = storeRoot();
		const old = acquired(root, supervisorAlive);
		old.recordGroup(group, 1);
		writeFileSync(join(old.dir, "lease-1.spawn-unproven.json"), "");

		const result = acquireWriterLease(root, request("call-2"), { reader: proc({ 60: ["S", "600"] }), supervisor: { ...supervisor, pid: 60, startTime: "600" } });

		assert.equal(result.status, "held");
	});

	test("an unproven spawn whose marker cannot be written still keeps the lease held in this process", { skip: process.getuid?.() === 0 }, () => {
		const root = storeRoot();
		const lease = acquired(root, supervisorAlive);
		lease.recordGroup(group, 1);
		chmodSync(lease.dir, 0o500);
		try {
			assert.throws(() => lease.markSpawnUnproven("generation 2 did not die"));
		} finally {
			chmodSync(lease.dir, 0o700);
		}

		assert.equal(lease.releaseIfEmpty(supervisorAlive).status, "held");
		assert.throws(() => lease.releaseUnspawned("never"), /unproven spawn/);
	});

	test("refuses a per-worktree directory planted as a symlink", () => {
		const root = storeRoot();
		mkdirSync(root, { mode: 0o700 });
		const key = createHash("sha256").update("/repo/main/.git\0/repo/main/.git/worktrees/task").digest("hex");
		const elsewhere = join(root, "..", "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, join(root, key));

		assert.equal(acquireWriterLease(root, request(), { reader: supervisorAlive, supervisor }).status, "unavailable");
	});

	test("a launch that never spawned releases its lease, but not once a group is recorded", () => {
		const root = storeRoot();
		const lease = acquired(root, supervisorAlive);
		lease.releaseUnspawned("revalidation failed");
		assert.equal(acquireWriterLease(root, request("call-2"), { reader: supervisorAlive, supervisor }).status, "acquired");

		const other = acquired(storeRoot(), supervisorAlive);
		other.recordGroup(group, 1);
		assert.throws(() => other.releaseUnspawned("too late"), /recorded execution group/);
	});

	test("a later launch reclaims a lease only when its supervisor is dead and its group is proven empty", () => {
		const newSupervisor: SupervisorIdentity = { ...supervisor, pid: 60, startTime: "600" };
		const cases: [string, ProcReader, boolean, string][] = [
			["supervisor gone, group gone", proc({ 60: ["S", "600"] }), true, "acquired"],
			["supervisor PID reused, group gone", proc({ 50: ["S", "555"], 60: ["S", "600"] }), true, "acquired"],
			["init PID reused", proc({ 60: ["S", "600"], 400: ["S", "1"] }), true, "acquired"],
			["host rebooted", proc({}, "boot-2"), true, "acquired"],
			["supervisor alive", proc({ 50: ["S", "100"], 60: ["S", "600"] }), true, "held"],
			["supervisor gone, group alive", proc({ 60: ["S", "600"], 400: ["S", "9000"] }), true, "held"],
			["supervisor gone, no group", proc({ 60: ["S", "600"] }), false, "held"],
			["supervisor gone, group gone, a later spawn unproven", proc({ 60: ["S", "600"] }), true, "held"],
		];
		for (const [name, reader, withGroup, expected] of cases) {
			const root = storeRoot();
			const old = acquired(root, supervisorAlive);
			if (withGroup) old.recordGroup(group, 1);
			if (name.includes("unproven")) old.markSpawnUnproven("generation 2 did not die");

			const result = acquireWriterLease(root, request("call-2"), { reader, supervisor: newSupervisor });

			assert.equal(result.status, expected, `${name}: ${JSON.stringify(result)}`);
			if (expected === "acquired") {
				const end = JSON.parse(readFileSync(join(root, readdirSync(root)[0] as string, "lease-1.end.json"), "utf8"));
				assert.equal(end.kind, "reclaimed", name);
				assert.ok(end.evidence.length >= 2, name);
			}
		}
	});

	test("two processes racing for the same worktree: exactly one acquires the lease", async () => {
		const root = storeRoot();
		const script = `
			import { acquireWriterLease } from ${JSON.stringify(new URL("../../src/broker/writer-lease.ts", import.meta.url).href)};
			const request = JSON.parse(process.argv[1]);
			while (Date.now() < Number(process.argv[2])) {}
			console.log(acquireWriterLease(process.argv[3], request).status);
		`;
		const startAt = String(Date.now() + 3000);
		const racers = Array.from({ length: 4 }, (_, index) =>
			run(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request(`call-${index}`)), startAt, root]),
		);

		const statuses = (await Promise.all(racers)).map((result) => result.stdout.trim()).sort();

		assert.deepEqual(statuses, ["acquired", "held", "held", "held"]);
	});
});
