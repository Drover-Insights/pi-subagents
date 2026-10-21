import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	claimNextGeneration,
	generationInUse,
	readManagedOwnership,
	recordOwnedGeneration,
} from "../../src/routing/managed-ownership.ts";
import { appendOwnerRecord } from "../../src/routing/resume-snapshot-store.ts";
import { stopRunningSubagent } from "../../src/runtime/running-registry.ts";
import { getLiveSlotCount } from "../../src/runtime/spawn-width.ts";
import { createTrustedTerminator } from "../../src/trusted-launch/terminator.ts";
import { ResumeRefusal } from "../../src/runtime/resume-refusal.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { startClaimedGeneration } from "../../src/runtime/managed-resume.ts";
import { terminateBackgroundChildProcess } from "../../src/runtime/shutdown.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { managedLaunchHarness, resumeRuntime, writeManagedDefinitions } from "../support/managed-children.ts";
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

/** A real detached process group, so a stop either reaches it or provably does not. */
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

async function exited(child: ChildProcess): Promise<boolean> {
	for (let attempt = 0; attempt < 100 && alive(child); attempt++) await new Promise((r) => setTimeout(r, 10));
	return !alive(child);
}

/** A fake `pi` that reads its prompt and then keeps running, as a live child does. */
function sleepingPi(): string {
	const bin = realpathSync(mkdtempSync(join(tmpdir(), "owned-pi-")));
	const fakePi = join(bin, "fake-pi");
	writeFileSync(fakePi, "#!/usr/bin/env bash\ncat >/dev/null\nexec sleep 30\n");
	chmodSync(fakePi, 0o755);
	return fakePi;
}

async function launchOwned(): Promise<RunningSubagent> {
	return managedLaunchHarness({ spawnChild: sleeper }).run(worker);
}

describe("owned lifecycle of managed children", () => {
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

	it("records the launch's durable owner: its token and its process's stable identity", async () => {
		const running = await launchOwned();

		const ownership = readManagedOwnership(agentDir, running.sessionFile);

		assert.equal(ownership.status, "owned");
		const owner = (ownership as Extract<typeof ownership, { status: "owned" }>).owner;
		assert.equal(owner.token, running.ownershipToken);
		assert.equal(owner.pid, running.childProcess?.pid);
		assert.match(owner.startTime ?? "", /^\d+$/);
	});

	it("stops a managed child whose ownership revalidates", async () => {
		const running = await launchOwned();

		terminateBackgroundChildProcess(running, "SIGTERM");

		assert.equal(await exited(running.childProcess as ChildProcess), true);
		assert.equal(running.stopRefusal, undefined);
	});

	it("leaves the process untouched and says why when the ownership token does not revalidate", async () => {
		const running = await launchOwned();
		running.ownershipToken = "0".repeat(32);

		terminateBackgroundChildProcess(running, "SIGKILL");

		assert.equal(await exited(running.childProcess as ChildProcess), false);
		assert.match(running.stopRefusal ?? "", /ownership token/);
	});

	it("leaves an unrecorded process untouched when the recorded process identity no longer matches", async () => {
		const running = await launchOwned();
		// The recorded child is gone and a different process now sits where it was.
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		const stranger = sleeper();
		running.childProcess = stranger;

		terminateBackgroundChildProcess(running, "SIGKILL");

		assert.equal(await exited(stranger), false);
		assert.match(running.stopRefusal ?? "", /process identity/);
	});

	it("leaves the process untouched when the owner record cannot be read", async () => {
		const running = await launchOwned();
		process.env.PI_CODING_AGENT_DIR = writeCanonicalPolicy();

		terminateBackgroundChildProcess(running, "SIGKILL");

		assert.equal(await exited(running.childProcess as ChildProcess), false);
		assert.match(running.stopRefusal ?? "", /no durable owner/);
	});

	it("keeps ownership inspectable after the parent's in-memory state is gone", async () => {
		const running = await launchOwned();
		const sessionFile = running.sessionFile;
		const pid = running.childProcess?.pid;

		// A reloaded parent holds nothing in memory; the store alone tells who owns the child.
		const ownership = readManagedOwnership(agentDir, sessionFile);

		assert.equal(ownership.status, "owned");
		assert.equal((ownership as Extract<typeof ownership, { status: "owned" }>).owner.pid, pid);
	});

	it("records a timeout wrap-up continuation's process as the new owner", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();
		running.timeoutWrapUp = { kind: "timeout", seconds: 10, threshold: 80 };
		running.timeoutBudget = { timeoutSeconds: 10 };

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		started.push(running.childProcess as ChildProcess);

		const ownership = readManagedOwnership(agentDir, running.sessionFile);
		const owner = (ownership as Extract<typeof ownership, { status: "owned" }>).owner;
		assert.deepEqual([owner.generation, owner.pid], [2, running.childProcess?.pid]);
		terminateBackgroundChildProcess(running, "SIGKILL");
		assert.equal(await exited(running.childProcess as ChildProcess), true);
	});

	it("records a resumed generation's process as the new owner under the same token", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();

		const resumed = await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());
		started.push(resumed.childProcess as ChildProcess);

		const ownership = readManagedOwnership(agentDir, running.sessionFile);
		const owner = (ownership as Extract<typeof ownership, { status: "owned" }>).owner;
		assert.equal(owner.generation, 2);
		assert.equal(owner.pid, resumed.childProcess?.pid);
		assert.equal(owner.token, running.ownershipToken);
		terminateBackgroundChildProcess(resumed, "SIGKILL");
		assert.equal(resumed.stopRefusal, undefined);
		assert.equal(await exited(resumed.childProcess as ChildProcess), true);
	});

	it("refuses a recorded pid whose kernel start time differs, as after pid reuse", async () => {
		const running = await launchOwned();
		appendOwnerRecord(join(agentDir, "resume-snapshots"), running.sessionFile, 2, {
			token: running.ownershipToken as string,
			parent: thisParent(),
			pid: running.childProcess?.pid as number,
			startTime: "1",
		});

		terminateBackgroundChildProcess(running, "SIGKILL");

		assert.equal(await exited(running.childProcess as ChildProcess), false);
		assert.match(running.stopRefusal ?? "", /process identity/);
	});

	it("still kills survivors of a group whose leader has already exited and been reaped", async () => {
		const running = await managedLaunchHarness({
			spawnChild: () => {
				// The leader exits at once; a member of its group ignores SIGTERM and stays.
				const child = spawn("bash", ["-c", "(trap '' TERM; exec sleep 30) & sleep 0.3"], { detached: true, stdio: "ignore" });
				started.push(child);
				return child;
			},
		}).run(worker);
		const leader = running.childProcess as ChildProcess;
		await new Promise((resolve) => leader.once("exit", resolve));
		assert.equal(groupAlive(leader.pid as number), true);

		terminateBackgroundChildProcess(running, "SIGKILL");

		for (let attempt = 0; attempt < 100 && groupAlive(leader.pid as number); attempt++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(groupAlive(leader.pid as number), false);
		assert.equal(running.stopRefusal, undefined);
	});

	it("keeps a child whose owner could not be recorded stoppable through the parent's own handle", async () => {
		// A store the parent cannot trust refuses every record.
		mkdirSync(join(agentDir, "resume-snapshots"), { mode: 0o755 });
		chmodSync(join(agentDir, "resume-snapshots"), 0o755);
		const running = await launchOwned();

		assert.equal(running.ownershipToken, undefined);
		terminateBackgroundChildProcess(running, "SIGKILL");
		assert.equal(await exited(running.childProcess as ChildProcess), true);
	});

	it("leaves a refused stop untouched: the watcher, the slot and the record stay, and the caller is told", async () => {
		const running = await launchOwned();
		running.abortController = new AbortController();
		running.ownershipToken = "0".repeat(32);
		const slots = getLiveSlotCount();

		await assert.rejects(() => stopRunningSubagent(running, async () => {}), /ownership token/);

		assert.equal(running.abortController.signal.aborted, false);
		assert.equal(getLiveSlotCount(), slots);
		assert.equal(alive(running.childProcess as ChildProcess), true);
	});

	it("reports a refused trusted termination as unproven ownership with no stop requested", async () => {
		const running = await launchOwned();
		running.ownershipToken = "0".repeat(32);

		const outcome = await refusedTermination(running);

		assert.deepEqual(outcome, { reason: "ownership_unavailable", stopRequested: false });
		assert.equal(alive(running.childProcess as ChildProcess), true);
	});

	it("refuses to resume a session whose recorded owner is still running", async () => {
		const running = await launchOwned();
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();

		await assert.rejects(
			() => resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			(error: unknown) => error instanceof ResumeRefusal && /resume_session_running/.test(error.message),
		);
	});

	it("does not record a snapshot for a session that has no header yet, so the child stays stoppable", async () => {
		const running = await managedLaunchHarness({ spawnChild: sleeper, standalone: true }).run(worker);

		assert.equal(running.ownershipToken, undefined);
		assert.equal(readManagedOwnership(agentDir, running.sessionFile).status, "unowned");
		terminateBackgroundChildProcess(running, "SIGKILL");
		assert.equal(await exited(running.childProcess as ChildProcess), true);
	});

	it("lets exactly one of two concurrent resumes of a session start a child", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();

		const outcomes = await Promise.allSettled([
			resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
		]);

		for (const outcome of outcomes) if (outcome.status === "fulfilled") started.push(outcome.value.childProcess as ChildProcess);
		assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
		const refusal = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
		assert.match(String(refusal.reason?.message), /resume_session_running/);
	});

	it("refuses to resume while an earlier generation's group survives its exited leader", async () => {
		const running = await managedLaunchHarness({
			spawnChild: () => {
				const child = spawn("bash", ["-c", "(trap '' TERM; exec sleep 30) & sleep 0.3"], { detached: true, stdio: "ignore" });
				started.push(child);
				return child;
			},
		}).run(worker);
		await new Promise((resolve) => (running.childProcess as ChildProcess).once("exit", resolve));
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();

		await assert.rejects(
			() => resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/resume_session_running/,
		);
	});

	it("refuses to resume when the latest owner record cannot be read", async () => {
		const running = await launchOwned();
		const root = join(agentDir, "resume-snapshots");
		const [dir] = readdirSync(root);
		writeFileSync(join(root, dir, "owner-2.json"), "{torn");
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();

		await assert.rejects(
			() => resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/resume_session_running/,
		);
	});

	it("never signals a reaped leader's pid once another process holds it", async () => {
		const running = await launchOwned();
		const stranger = sleeper();
		appendOwnerRecord(join(agentDir, "resume-snapshots"), running.sessionFile, 2, {
			token: running.ownershipToken as string,
			parent: thisParent(),
			pid: stranger.pid as number,
			startTime: "1",
		});
		// The parent reaped the recorded leader, and its pid now names an unrelated process.
		running.childProcess = { pid: stranger.pid, exitCode: 0, signalCode: null } as unknown as ChildProcess;

		terminateBackgroundChildProcess(running, "SIGKILL");

		assert.equal(await exited(stranger), false);
		assert.match(running.stopRefusal ?? "", /process identity/);
	});

	it("lets the lower of two interleaved claims win, so a later claimant never starts a second child", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		let first: ReturnType<typeof claimNextGeneration> | undefined;

		// The second claimant passed its check before the first linked its claim.
		const second = claimNextGeneration(agentDir, running.sessionFile, {
			beforeLink: () => {
				first = claimNextGeneration(agentDir, running.sessionFile);
			},
		});

		assert.equal(first && "generation" in first ? first.generation : undefined, 2);
		assert.ok("refusal" in second, JSON.stringify(second));
	});

	it("refuses a claimant whose check ran before another parent started and recorded its generation", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);

		const late = claimNextGeneration(agentDir, running.sessionFile, {
			beforeLink: () => {
				const first = claimNextGeneration(agentDir, running.sessionFile);
				assert.ok("generation" in first);
				running.childProcess = sleeper();
				assert.equal(recordOwnedGeneration(agentDir, running, running.ownershipToken as string, first.generation), null);
			},
		});

		assert.ok("refusal" in late, JSON.stringify(late));
	});

	it("counts a group holding only its zombie leader as running until it is reaped, failing closed", async () => {
		const running = await launchOwned();
		const holder = spawn("bash", ["-c", 'setsid sh -c "exit 0" & echo $!; exec sleep 30'], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		started.push(holder);
		const leader = Number(await new Promise<string>((resolve) => holder.stdout?.once("data", (chunk) => resolve(String(chunk)))));
		await waitForZombie(leader);
		appendOwnerRecord(join(agentDir, "resume-snapshots"), running.sessionFile, 2, {
			token: running.ownershipToken as string,
			parent: thisParent(),
			pid: leader,
			startTime: startTimeOf(leader),
		});

		assert.match(generationInUse(agentDir, running.sessionFile) ?? "", /may still be running/);
	});

	it("treats survivors of a zombie leader's group as a running generation", async () => {
		const running = await launchOwned();
		// The setsid'd leader exits; its parent never reaps it, and a member of its group survives.
		const holder = spawn("bash", ["-c", 'setsid sh -c "sleep 30 & exit 0" & echo $!; exec sleep 30'], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		started.push(holder);
		const leader = Number(await new Promise<string>((resolve) => holder.stdout?.once("data", (chunk) => resolve(String(chunk)))));
		await waitForZombie(leader);
		appendOwnerRecord(join(agentDir, "resume-snapshots"), running.sessionFile, 2, {
			token: running.ownershipToken as string,
			parent: thisParent(),
			pid: leader,
			startTime: startTimeOf(leader),
		});

		assert.match(generationInUse(agentDir, running.sessionFile) ?? "", /may still be running/);
		try {
			process.kill(-leader, "SIGKILL");
		} catch {}
	});

	it("releases the claim of a resume that failed before its child started, so a retry can run", async () => {
		// A pilot receipt needs a Pi command that is a standalone binary.
		const bin = realpathSync(mkdtempSync(join(tmpdir(), "owned-bin-")));
		writeFileSync(join(bin, "fake-pi"), readFileSync("/usr/bin/true"));
		chmodSync(join(bin, "fake-pi"), 0o755);
		process.env.PI_SUBAGENT_PI_COMMAND = join(bin, "fake-pi");
		const running = await managedLaunchHarness({ spawnChild: sleeper }).run({
			name: "route-scout",
			title: "Route map",
			task: "Map the route",
			agent: "pilot-scout",
			capabilityClass: "literal",
			pilotCase: "scout-literal-1",
		});
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		process.env.PI_SUBAGENT_PI_COMMAND = sleepingPi();
		// The pilot store refuses the resume record, after the claim and before any child starts.
		chmodSync(join(agentDir, "pilot-attempts"), 0o755);
		await assert.rejects(
			() => resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/pilot attempt store/,
		);
		chmodSync(join(agentDir, "pilot-attempts"), 0o700);

		const retried = await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());

		started.push(retried.childProcess as ChildProcess);
		const ownership = readManagedOwnership(agentDir, running.sessionFile);
		assert.equal((ownership as Extract<typeof ownership, { status: "owned" }>).owner.pid, retried.childProcess?.pid);
	});

	it("releases a claimed generation whose process failed to start", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		const ticket = claimNextGeneration(agentDir, running.sessionFile);
		assert.ok("generation" in ticket);

		await assert.rejects(() =>
			startClaimedGeneration(running.sessionFile, ticket, () => spawn("true", ["bad\0argument"])),
		);

		assert.equal(generationInUse(agentDir, running.sessionFile), null);
	});

	it("finds the snapshot through a symlinked session path, so an alias cannot resume unmanaged", async () => {
		const running = await launchOwned();
		process.kill(-(running.childProcess?.pid as number), "SIGKILL");
		await exited(running.childProcess as ChildProcess);
		const alias = join(realpathSync(mkdtempSync(join(tmpdir(), "alias-"))), "s.jsonl");
		symlinkSync(running.sessionFile, alias);

		await assert.rejects(
			() => resumeSubagentSession({ sessionFile: alias, task: "Continue.", model: "openai-codex/gpt-6-sol" }, resumeRuntime()),
			(error: unknown) => error instanceof ResumeRefusal && /resume_broadening/.test(error.message),
		);
	});
});

/** This test process as the parent that owns a generation. */
function thisParent(): { pid: number; startTime: string } {
	return { pid: process.pid, startTime: startTimeOf(process.pid) };
}

function startTimeOf(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

async function waitForZombie(pid: number): Promise<void> {
	let state = "";
	for (let attempt = 0; attempt < 200 && state !== "Z"; attempt++) {
		await new Promise((r) => setTimeout(r, 10));
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
	}
	assert.equal(state, "Z");
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function refusedTermination(running: RunningSubagent): Promise<{ reason: string; stopRequested: boolean }> {
	if (running.launchMetadata) {
		running.launchMetadata.trustedLaunch = { version: "pi-subagents.trusted-launch/v1", generation: "g", requestId: "op_01" };
	}
	const terminate = createTrustedTerminator({
		runningSubagents: new Map([[running.id, running]]),
		completedSubagentResults: new Map(),
		stopRunningSubagent: (target) => stopRunningSubagent(target, async () => {}),
	});
	const result = await terminate(
		{ requestVersion: "pi-subagents.trusted-launch/v1", requestId: "op_02", runId: running.id, sessionFile: running.sessionFile, launchRequestId: "op_01" },
		{ isLive: () => true } as never,
	);
	assert.equal(result.outcome, "unknown");
	const unknown = result as Extract<typeof result, { outcome: "unknown" }>;
	return { reason: unknown.reason, stopRequested: unknown.stopRequested };
}
