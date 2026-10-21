import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	claimNextGeneration,
	findManagedRecovery,
	generationInUse,
} from "../../src/routing/managed-ownership.ts";
import { appendOwnerRecord } from "../../src/routing/resume-snapshot-store.ts";
import { formatManagedRecovery } from "../../src/runtime/managed-recovery.ts";
import { stopRunningSubagent } from "../../src/runtime/running-registry.ts";
import { shutdownSubagentsForParentExit } from "../../src/runtime/shutdown.ts";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { managedLaunchHarness, writeManagedDefinitions } from "../support/managed-children.ts";
import { writeCanonicalPolicy } from "../support/routing-policy.ts";

const worker = {
	name: "slice-worker",
	title: "Slice worker",
	task: "Map the slice",
	agent: "pilot-worker",
	capabilityClass: "implementation",
};

const started: ChildProcess[] = [];
let agentDir: string;

function sleeper(): ChildProcess {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	child.unref();
	started.push(child);
	return child;
}

function alive(child: ChildProcess): boolean {
	try {
		process.kill(child.pid as number, 0);
		return child.exitCode === null && child.signalCode === null;
	} catch {
		return false;
	}
}

async function exited(child: ChildProcess): Promise<void> {
	for (let attempt = 0; attempt < 200 && alive(child); attempt++) await new Promise((r) => setTimeout(r, 10));
}

/** The pid and start time of a process that has exited, as a dead parent's identity. */
async function deadProcess(): Promise<{ pid: number; startTime: string }> {
	const child = spawn("sleep", ["0.05"], { stdio: "ignore" });
	const { readProcessStartTime } = await import("../../src/broker/writer-group.ts");
	const identity = { pid: child.pid as number, startTime: readProcessStartTime(child.pid as number) };
	await new Promise((resolve) => child.once("exit", resolve));
	return identity;
}

function storeDir(): string {
	const root = join(agentDir, "resume-snapshots");
	return join(root, readdirSync(root)[0]);
}

describe("recovery of managed children whose ownership cannot be proven", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		resetSpawnWidthForTest();
		agentDir = writeCanonicalPolicy();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeManagedDefinitions(agentDir);
	});

	afterEach(() => {
		for (const child of started.splice(0)) {
			try {
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {}
		}
	});

	it("records the owning parent with each generation", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);

		const owner = JSON.parse(storeRecord("owner-1.json"));

		assert.equal(owner.pid, running.childProcess?.pid);
		assert.equal(owner.parent.pid, process.pid);
		assert.match(owner.parent.startTime, /^\d+$/);
	});

	it("lists an orphan, a child still running after its parent died, and keeps its resume blocked", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		const parent = await deadProcess();
		appendOwnerRecord(join(agentDir, "resume-snapshots"), running.sessionFile, 2, {
			token: running.ownershipToken as string,
			pid: running.childProcess?.pid as number,
			startTime: JSON.parse(storeRecord("owner-1.json")).startTime,
			parent,
		});

		const recovery = findManagedRecovery(agentDir);

		assert.deepEqual(recovery.map((entry) => entry.sessionFile), [running.sessionFile]);
		assert.match(recovery[0].reason, /parent .* is gone/);
		assert.match(generationInUse(agentDir, running.sessionFile) ?? "", /may still be running/);
		assert.match(formatManagedRecovery(recovery), /left untouched/);
	});

	it("does not list a child whose parent is still running, nor one that has ended", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		assert.deepEqual(findManagedRecovery(agentDir), []);
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		assert.deepEqual(findManagedRecovery(agentDir), []);
	});

	it("lists a session whose latest owner record cannot be read", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		writeFileSync(join(storeDir(), "owner-2.json"), "{torn");

		assert.deepEqual(
			findManagedRecovery(agentDir).map((entry) => entry.sessionFile),
			[running.sessionFile],
		);
	});

	it("lists a session whose snapshot no longer verifies", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		const file = join(storeDir(), "snapshot.json");
		writeFileSync(file, readFileSync(file, "utf8").replace('"read,grep,find,ls"', '"read,bash"'));

		const recovery = findManagedRecovery(agentDir);

		assert.deepEqual(recovery.map((entry) => entry.sessionFile), [running.sessionFile]);
		assert.match(recovery[0].reason, /snapshot/);
	});

	it("keeps a session blocked after a parent died between claiming and recording a generation", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		const parent = await deadProcess();
		writeFileSync(
			join(storeDir(), "claim-1.1.json"),
			JSON.stringify({ version: 1, after: 1, attempt: 1, claimant: parent }),
		);

		const claim = claimNextGeneration(agentDir, running.sessionFile);

		assert.ok("refusal" in claim, JSON.stringify(claim));
		assert.match(claim.refusal, /claim-1\.1\.abandoned\.json/);
		assert.deepEqual(findManagedRecovery(agentDir).map((entry) => entry.sessionFile), [running.sessionFile]);
		writeFileSync(join(storeDir(), "claim-1.1.abandoned.json"), JSON.stringify({ reason: "operator" }));
		assert.ok("generation" in claimNextGeneration(agentDir, running.sessionFile));
	});

	it("leaves a child whose stop is refused untouched at parent exit, and reports it", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		running.ownershipToken = "0".repeat(32);
		const runningSubagents = new Map([[running.id, running]]);

		const actions = await shutdownSubagentsForParentExit({
			runningSubagents,
			completedSubagentResults: new Map(),
			parentCloseEscalationMs: 10,
			updateWidget: () => {},
			closeRunningSurface: async () => {},
		});

		assert.deepEqual(actions, [{ id: running.id, policy: "terminate", action: "untouched" }]);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(alive(running.childProcess as ChildProcess), true);
	});

	it("closes only the surface a managed child's snapshot recorded", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		running.surface = "%99";
		const closed: string[] = [];

		await assert.rejects(
			() => stopRunningSubagent(running, async (target: RunningSubagent) => {
				closed.push(target.surface as string);
			}),
			/surface/,
		);

		assert.deepEqual(closed, []);
		assert.equal(alive(running.childProcess as ChildProcess), true);
	});

	it("lists a session whose owner record lacks the owning parent", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run(worker);
		const owner = JSON.parse(storeRecord("owner-1.json"));
		delete owner.parent;
		writeFileSync(join(storeDir(), "owner-2.json"), JSON.stringify({ ...owner, generation: 2 }));

		assert.deepEqual(findManagedRecovery(agentDir).map((entry) => entry.sessionFile), [running.sessionFile]);
	});
});

/** A record in the only session directory of the snapshot store. */
function storeRecord(name: string): string {
	return readFileSync(join(storeDir(), name), "utf8");
}
