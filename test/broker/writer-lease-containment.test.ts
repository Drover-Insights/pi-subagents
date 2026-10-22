import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { WriterContainment } from "../../src/broker/writer-containment.ts";
import { acquireWriterLease, containWriterLease, releaseWhenEmpty } from "../../src/broker/writer-lease.ts";
import "../support/temp-root.ts";
import { repoGit } from "../support/writer-repo.ts";
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
		assert.ok(readdirSync(join(new WriterContainment(lease.identity(1)).directory, "quarantine-parent")).includes("manifest.jsonl"));
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

	test("a cleared lease's containment never reaches a later launch that reuses its request id", () => {
		const root = storeRoot();
		const first = acquired(root, running, "trusted:op_01");
		first.recordGroup(group, 1);
		const firstChild = new WriterContainment(first.identity(1));
		firstChild.contain("the child saw its branch change");
		assert.equal(first.releaseIfEmpty(groupGone).status, "held");
		writeFileSync(join(keyDir(root), "lease-1.cleared.json"), '{"by":"operator"}\n');

		const second = acquired(root, groupGone, "trusted:op_01");
		second.recordGroup(group, 1);

		assert.equal(second.inspect(groupGone), null);
		const secondChild = new WriterContainment(second.identity(1));
		assert.notEqual(secondChild.directory, firstChild.directory);
		assert.deepEqual(second.releaseIfEmpty(groupGone), { status: "released" });
		// The earlier lease's records stay as its audit trail.
		assert.ok(readdirSync(firstChild.directory).includes("contained-g1.json"));
	});

	test("a reused request id's new writer records its own containment, which contains its lease", () => {
		const root = storeRoot();
		const first = acquired(root, running, "trusted:op_01");
		first.recordGroup(group, 1);
		new WriterContainment(first.identity(1)).contain("first");
		first.releaseIfEmpty(groupGone);
		writeFileSync(join(keyDir(root), "lease-1.cleared.json"), '{"by":"operator"}\n');
		const second = acquired(root, groupGone, "trusted:op_01");
		second.recordGroup(group, 1);

		const child = new WriterContainment(second.identity(1));
		child.contain("second");

		assert.ok(readdirSync(child.directory).includes("contained-g1.json"));
		assert.match(JSON.stringify(second.releaseIfEmpty(groupGone)), /contained.*generation 1: second/);
	});

	test("every generation of one lease shares its containment, and another worktree's lease with the same id does not", () => {
		const root = storeRoot();
		const lease = acquired(root, running, "trusted:op_01");
		assert.equal(new WriterContainment(lease.identity(2)).directory, new WriterContainment(lease.identity(1)).directory);
		lease.recordGroup(group, 1);
		new WriterContainment(lease.identity(1)).contain("generation 1 contained itself");
		assert.match(lease.inspect(running) ?? "", /generation 1 contained itself/);

		const otherTop = join(LEASED.root, "other");
		repoGit(LEASED.main, "worktree", "add", "-q", "-b", "other", otherTop);
		try {
			const other = acquireWriterLease(
				root,
				{
					...request("trusted:op_01"),
					worktree: { top: otherTop, gitDir: join(LEASED.common, "worktrees", "other"), commonDir: LEASED.common, branch: "other", head: LEASED.head },
				},
				{ reader: running, supervisor },
			);
			assert.equal(other.status, "acquired", JSON.stringify(other));
			if (other.status !== "acquired") return;
			assert.equal(other.lease.number, lease.number);
			assert.notEqual(new WriterContainment(other.lease.identity(1)).directory, new WriterContainment(lease.identity(1)).directory);
		} finally {
			repoGit(LEASED.main, "worktree", "remove", "--force", otherTop);
		}
	});

	test("a lease in another lease store never reads the containment of a lease with the same id and number", () => {
		const first = acquired(storeRoot(), running, "trusted:op_01");
		first.recordGroup(group, 1);
		new WriterContainment(first.identity(1)).contain("the first store's writer");

		// A fresh agent directory numbers its leases from 1 again.
		const second = acquired(storeRoot(), running, "trusted:op_01");
		second.recordGroup(group, 1);

		assert.equal(second.number, first.number);
		assert.equal(second.inspect(groupGone), null);
		assert.match(first.inspect(groupGone) ?? "", /the first store's writer/);
	});

	for (const malformed of ["", null, 42]) {
		test(`a lease record whose containment key is ${JSON.stringify(malformed)} contains the lease at reclaim, until an operator clears it`, () => {
			const root = storeRoot();
			acquired(root, running, "trusted:op_01").recordGroup(group, 1);
			const record = join(keyDir(root), "lease-1.json");
			const stored = JSON.parse(readFileSync(record, "utf8"));
			rmSync(record);
			writeFileSync(record, `${JSON.stringify({ ...stored, containmentKey: malformed })}\n`);

			const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });

			assert.equal(later.status, "held", JSON.stringify(later));
			assert.match(later.status === "held" ? later.reason : "", /contained.*malformed containment key/);
			assert.ok(files(root).includes("lease-1.spawn-unproven.json"), "older parents could reclaim the lease");
			assert.ok(files(root).includes("lease-1.contained.json"));
			assert.ok(!files(root).includes("lease-1.end.json"));

			writeFileSync(join(keyDir(root), "lease-1.cleared.json"), '{"by":"operator"}\n');
			assert.equal(acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor }).status, "acquired");
		});
	}

	test("after a parent crash, a reclaim reads the child's containment records", () => {
		const root = storeRoot();
		const lease = acquired(root, running, "trusted:op_01");
		lease.recordGroup(group, 1);
		new WriterContainment(lease.identity(1)).contain("the child contained itself");

		const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });

		assert.match(JSON.stringify(later), /held.*contained.*the child contained itself/);
	});

	test("a reclaim of a lease taken before containment was keyed to its lease reads the child's records under the launch id", () => {
		const root = storeRoot();
		const lease = acquired(root, running, "trusted:op_01");
		lease.recordGroup(group, 1);
		const record = join(keyDir(root), "lease-1.json");
		const { containmentKey: _dropped, ...legacy } = JSON.parse(readFileSync(record, "utf8"));
		rmSync(record);
		writeFileSync(record, `${JSON.stringify(legacy)}\n`);
		new WriterContainment({ ...PINNED, launchId: "trusted:op_01", generation: 1 }).contain("an earlier version's child");

		const later = acquireWriterLease(root, request("call-2"), { reader: parentCrashed, supervisor });

		assert.match(JSON.stringify(later), /held.*contained.*an earlier version's child/);
	});

	for (const dir of ["quarantine-g1", "quarantine-parent"]) {
		test(`a ${dir} quarantine left without its containment record still contains the lease`, () => {
			const root = storeRoot();
			const lease = acquired(root, running);
			lease.recordGroup(group, 1);
			// A crash after the walk moved an entry, before anything recorded the containment.
			const quarantine = join(new WriterContainment(lease.identity(1)).directory, dir);
			mkdirSync(quarantine, { recursive: true });
			writeFileSync(join(quarantine, "manifest.jsonl"), `${JSON.stringify({ from: planted, to: join(quarantine, "1-0") })}\n`);

			assert.match(JSON.stringify(lease.releaseIfEmpty(groupGone)), new RegExp(`contained.*${dir}`));
			assert.ok(!files(root).includes("lease-1.end.json"));
		});
	}
});
