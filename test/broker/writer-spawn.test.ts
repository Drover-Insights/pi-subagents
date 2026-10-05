import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { classifyExecutionGroup, type ExecutionGroup, procReader } from "../../src/broker/writer-group.ts";
import { acquireWriterLease, releaseWhenEmpty } from "../../src/broker/writer-lease.ts";
import { probeWriterConfinement, spawnLeasedWriter, spawnWriterChild, WriterSpawnError } from "../../src/broker/writer-spawn.ts";
import "../support/temp-root.ts";

/**
 * Real-bubblewrap tests of the writer's execution group. Skipped only when
 * bubblewrap is not installed.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;
const ownNamespace = procReader.pidNamespace("self");

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "writer-spawn-")));
}

function exited(child: { exitCode: number | null; signalCode: string | null; once: (event: "exit", cb: () => void) => void }) {
	return child.exitCode !== null || child.signalCode !== null
		? Promise.resolve()
		: new Promise<void>((resolve) => child.once("exit", resolve));
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await delay(25);
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("writer execution group", { skip }, () => {
	test("the host can confine a writer to its own PID namespace", () => {
		assert.deepEqual(probeWriterConfinement(), { status: "available" });
	});

	test("a host whose identity inputs cannot be read cannot confine a writer", () => {
		const result = probeWriterConfinement({
			...procReader,
			bootId: () => {
				throw new Error("boot_id is unreadable");
			},
		});

		assert.equal(result.status, "unavailable");
		assert.match(result.status === "unavailable" ? result.message : "", /boot_id is unreadable/);
	});

	test("records the group before the child runs, and the child is the init of its own PID namespace", async () => {
		const dir = scratch();
		const marker = join(dir, "started");
		let recorded: ExecutionGroup | undefined;
		let ranBeforeRecord = true;

		const child = await spawnWriterChild({
			command: "/bin/sh",
			args: ["-c", `echo $$ > ${marker}; [ -e /proc/$$/fd/3 ] || [ -e /proc/$$/fd/4 ] && echo leaked >> ${marker}; exit 3`],
			cwd: dir,
			env: { PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "ignore", "ignore"],
			recordGroup: (group) => {
				ranBeforeRecord = existsSync(marker);
				recorded = group;
			},
		});
		await exited(child);

		assert.equal(ranBeforeRecord, false);
		assert.equal(readFileSync(marker, "utf8"), "1\n");
		assert.equal(child.exitCode, 3);
		assert.ok(recorded);
		assert.notEqual(recorded.pidNamespace, ownNamespace);
		assert.match(recorded.pidNamespace, /^pid:\[\d+\]$/);
		assert.equal(recorded.bootId, procReader.bootId());
		await until(() => classifyExecutionGroup(recorded as ExecutionGroup, ownNamespace).state === "empty");
	});

	test("a child cannot start when its group cannot be recorded", async () => {
		const dir = scratch();
		const marker = join(dir, "started");

		await assert.rejects(
			spawnWriterChild({
				command: "/bin/sh",
				args: ["-c", `touch ${marker}`],
				cwd: dir,
				env: {},
				stdio: ["ignore", "ignore", "ignore"],
				recordGroup: () => {
					throw new Error("disk full");
				},
			}),
			(error: unknown) => error instanceof WriterSpawnError && error.nothingRunning && /disk full/.test(error.message),
		);
		await delay(200);
		assert.equal(existsSync(marker), false);
	});

	test("a setsid descendant and a running tool sandbox keep the writer's lease held until the init exits, even with its launcher killed", async (t) => {
		const dir = scratch();
		const pids = join(dir, "pids");
		const leaseRoot = join(dir, "leases");
		mkdirSync(leaseRoot, { mode: 0o700 });
		const acquired = acquireWriterLease(leaseRoot, {
			worktree: { top: dir, gitDir: join(dir, ".wt"), commonDir: join(dir, ".git"), branch: "task", head: "a".repeat(40) },
			launchId: "call-1",
			policyGeneration: "gen",
		});
		if (acquired.status !== "acquired") throw new Error(JSON.stringify(acquired));
		const lease = acquired.lease;
		const script = [
			`setsid sleep 1000 & echo $! > ${pids}.tmp && mv ${pids}.tmp ${pids}`,
			`${BWRAP_PATH} --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev sleep 1000 &`,
			"while true; do sleep 0.05; done",
		].join("\n");
		const { child } = await spawnLeasedWriter(lease, 1, {
			command: "/bin/sh",
			args: ["-c", script],
			cwd: dir,
			env: { PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "ignore", "ignore"],
		});
		await until(() => existsSync(pids));
		const recorded = JSON.parse(readFileSync(join(lease.dir, "lease-1.group-1.json"), "utf8")).group as ExecutionGroup;
		t.after(() => {
			try {
				process.kill(recorded.initPid, "SIGKILL");
			} catch {}
		});
		const descendantHostPid = findHostPid(recorded.pidNamespace, Number(readFileSync(pids, "utf8")));
		// The init, the setsid descendant, and the tool sandbox's own bubblewrap; the loop's sleeps come and go.
		await until(() => countMembers(recorded.pidNamespace) >= 3);

		// Kill only the launcher process; the namespace and its members survive it.
		process.kill(child.pid as number, "SIGKILL");
		await exited(child);
		await delay(200);
		assert.equal(lease.releaseIfEmpty().status, "held");
		assert.equal(pidAlive(descendantHostPid), true);
		assert.ok(countMembers(recorded.pidNamespace) >= 3, "init, the setsid descendant, and the tool sandbox still run");
		assert.equal(acquireWriterLease(leaseRoot, { worktree: { top: dir, gitDir: join(dir, ".wt"), commonDir: join(dir, ".git"), branch: "task", head: "a".repeat(40) }, launchId: "call-2", policyGeneration: "gen" }).status, "held");

		process.kill(recorded.initPid, "SIGKILL");
		assert.deepEqual(await releaseWhenEmpty(lease, { intervalMs: 25 }), { status: "released" });
		assert.equal(pidAlive(descendantHostPid), false);
		assert.equal(countMembers(recorded.pidNamespace), 0);
	});
});

/** How many host processes run in `namespace`. */
function countMembers(namespace: string): number {
	let count = 0;
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (procReader.pidNamespace(Number(name)) === namespace) count++;
		} catch {}
	}
	return count;
}

/** The host PID of the member of `namespace` whose in-namespace PID is `nsPid`. */
function findHostPid(namespace: string, nsPid: number): number {
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (procReader.pidNamespace(Number(name)) !== namespace) continue;
			const nspid = /NSpid:\s+(\d+)\s+(\d+)/.exec(readFileSync(`/proc/${name}/status`, "utf8"));
			if (nspid && Number(nspid[2]) === nsPid) return Number(name);
		} catch {}
	}
	throw new Error(`no host PID for namespace PID ${nsPid}`);
}
