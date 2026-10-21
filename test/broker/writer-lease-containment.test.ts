import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { WriterContainment } from "../../src/broker/writer-containment.ts";
import { acquireWriterLease, containWriterLease, releaseWhenEmpty } from "../../src/broker/writer-lease.ts";
import { containmentDirectory } from "../../src/broker/writer-seal.ts";
import "../support/temp-root.ts";
import { acquired, files, group, LEASED, proc, request, storeRoot, supervisor } from "../support/writer-lease-store.ts";

const running = proc({ 50: ["S", "100"], 400: ["S", "9000"] });
const groupGone = proc({ 50: ["S", "100"] });
const parentCrashed = proc({});

function keyDir(root: string): string {
	return join(root, readdirSync(root)[0] as string);
}

const PINNED = { top: LEASED.linked, commonDir: LEASED.common, worktreeGitDir: LEASED.gitDir, branch: "task" };
const planted = join(LEASED.linked, "sub", ".git");

function plant(): void {
	mkdirSync(join(LEASED.linked, "sub"), { recursive: true });
	writeFileSync(planted, "gitdir: ../evil\n");
}

describe("a contained writer lease", () => {
	afterEach(() => {
		rmSync(join(LEASED.linked, "sub"), { recursive: true, force: true });
		rmSync(join(LEASED.common, "pi-subagents"), { recursive: true, force: true });
		writeFileSync(join(LEASED.gitDir, "HEAD"), "ref: refs/heads/task\n");
	});

	test("a release that finds writer-created Git metadata quarantines it and contains the lease instead", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		plant();

		const release = lease.releaseIfEmpty(groupGone);

		assert.equal(release.status, "held");
		assert.match(release.status === "held" ? release.reason : "", /contained.*sub\/\.git/);
		assert.equal(existsSync(planted), false, "the planted link was left in the worktree");
		assert.ok(readdirSync(join(containmentDirectory(PINNED, "call-1"), "quarantine-parent")).includes("manifest.jsonl"));
		assert.ok(files(root).includes("lease-1.contained.json"));
		assert.ok(!files(root).includes("lease-1.end.json"));
	});

	test("a release after the worktree's branch changed contains the lease", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		writeFileSync(join(LEASED.gitDir, "HEAD"), "ref: refs/heads/other\n");
		assert.match(JSON.stringify(lease.releaseIfEmpty(groupGone)), /contained.*branch other/);
		assert.ok(!files(root).includes("lease-1.end.json"));
	});

	test("a containment record the child wrote contains the lease at release", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		new WriterContainment(lease.identity(1)).contain("the child saw its branch change");
		assert.match(JSON.stringify(lease.releaseIfEmpty(groupGone)), /contained.*the child saw its branch change/);
	});

	test("a contained lease is never released or reclaimed, and a later launch into the worktree is rejected", async () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });

		assert.equal((await releaseWhenEmpty(lease, { reader: groupGone, intervalMs: 1 })).status, "held");
		const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });
		assert.equal(later.status, "held");
		assert.match(later.status === "held" ? later.reason : "", /contained.*identity changed.*operator/);
		assert.ok(!files(root).includes("lease-1.end.json"));
	});

	test("after a parent crash, a reclaim inspects the tree and contains instead of reclaiming", () => {
		const root = storeRoot();
		acquired(root, running).recordGroup(group, 1);
		plant();

		const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });

		assert.equal(later.status, "held");
		assert.match(later.status === "held" ? later.reason : "", /contained/);
		assert.equal(existsSync(planted), false);
		assert.ok(files(root).includes("lease-1.contained.json"));
		assert.ok(!files(root).includes("lease-2.json"));
	});

	test("an operator's clear ends a contained lease only once its group is proven empty", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		containWriterLease(lease, "identity changed", { reader: groupGone, kill: () => {} });
		writeFileSync(join(keyDir(root), "lease-1.cleared.json"), '{"by":"operator"}\n');
		// The clear takes effect at the next launch into the worktree, not in the supervising parent.
		assert.equal(lease.releaseIfEmpty(groupGone).status, "held");

		assert.equal(acquireWriterLease(root, request("call-2"), { reader: running, supervisor }).status, "held");
		const later = acquireWriterLease(root, request("call-2"), { reader: groupGone, supervisor });

		assert.equal(later.status, "acquired", JSON.stringify(later));
		const end = JSON.parse(readFileSync(join(keyDir(root), "lease-1.end.json"), "utf8"));
		assert.equal(end.kind, "cleared");
	});

	test("containment marks the lease before it kills, and kills only a group that is still running", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		const killed: number[] = [];
		containWriterLease(lease, "identity changed", {
			reader: running,
			kill: (pid) => {
				assert.ok(files(root).includes("lease-1.contained.json"), "killed before the lease was marked");
				killed.push(pid);
			},
		});
		assert.deepEqual(killed, [group.initPid]);

		// A PID that now belongs to another process is never signalled.
		const reused = proc({ 50: ["S", "100"], 400: ["S", "1234"] });
		const other = acquired(storeRoot(), running);
		other.recordGroup(group, 1);
		const none: number[] = [];
		containWriterLease(other, "identity changed", { reader: reused, kill: (pid) => none.push(pid) });
		assert.deepEqual(none, []);
	});

	test("inspect reports a contained lease from disk, an identity change, and walks only a group proven empty", () => {
		const root = storeRoot();
		const lease = acquired(root, running);
		lease.recordGroup(group, 1);
		assert.equal(lease.inspect(running), null);
		plant();
		assert.equal(lease.inspect(running), null, "walked a tree its writer may still be writing");
		assert.match(lease.inspect(groupGone) ?? "", /sub\/\.git/);
		writeFileSync(join(LEASED.gitDir, "HEAD"), "ref: refs/heads/other\n");
		assert.match(lease.inspect(running) ?? "", /branch other/);
		writeFileSync(join(LEASED.gitDir, "HEAD"), "ref: refs/heads/task\n");
		writeFileSync(join(keyDir(root), "lease-1.contained.json"), '{"reason":"written by another process"}\n');
		assert.match(lease.inspect(running) ?? "", /written by another process/);
	});

	for (const dir of ["quarantine-g1", "quarantine-parent"]) {
		test(`a ${dir} quarantine left without its containment record still contains the lease`, () => {
			const root = storeRoot();
			const lease = acquired(root, running);
			lease.recordGroup(group, 1);
			// A crash after the walk moved an entry, before anything recorded the containment.
			const quarantine = join(containmentDirectory(PINNED, "call-1"), dir);
			mkdirSync(quarantine, { recursive: true });
			writeFileSync(join(quarantine, "manifest.jsonl"), `${JSON.stringify({ from: planted, to: join(quarantine, "1-0") })}\n`);

			assert.match(JSON.stringify(lease.releaseIfEmpty(groupGone)), new RegExp(`contained.*${dir}`));
			assert.ok(!files(root).includes("lease-1.end.json"));
		});
	}
});
