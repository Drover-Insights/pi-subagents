import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { InteractiveLaunchError } from "../../src/launch/interactive.ts";
import { readPilotCase } from "../../src/routing/pilot-attempt-store.ts";
import { ResumeRefusal } from "../../src/runtime/resume-refusal.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { resetRuntimeStateForTest, runningSubagents } from "../../src/runtime/state.ts";
import type { SubagentLaunchPhase } from "../../src/tools/subagent-launch.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import { capturePiInvocation, managedLaunchHarness, resumeRuntime, writeManagedDefinitions } from "../support/managed-children.ts";
import { canonicalPolicyDocument, writeCanonicalPolicy } from "../support/routing-policy.ts";

let agentDir: string;
const groups: ChildProcess[] = [];

const scout = {
	name: "route-scout",
	title: "Route map",
	task: "Map the route",
	agent: "pilot-scout",
	capabilityClass: "literal",
	pilotCase: "scout-literal-1",
};

/** `scout` is not a policy alias, so it launches unmanaged and unsandboxed. */
const helper = {
	name: "free-helper",
	title: "Free helper",
	task: "Help out",
	agent: "scout",
};

/** A real process group, as a background child leads one. */
function liveGroup(): ChildProcess {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	groups.push(child);
	return child;
}

async function endGroup(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	process.kill(-(child.pid as number), "SIGKILL");
	await exited;
}

let exited: ChildProcess;

/** Track a child as the runtime does; a fake without a process gets one that already exited. */
function register(running: RunningSubagent): void {
	running.childProcess ??= exited;
	runningSubagents.set(running.id, running);
}

function reservations() {
	return readPilotCase(join(agentDir, "pilot-attempts"), "scout-literal-1")?.reservations ?? [];
}

function refusal(phase: SubagentLaunchPhase): string {
	assert.equal(phase.status, "rejected", JSON.stringify(phase));
	const rejected = phase as Extract<SubagentLaunchPhase, { status: "rejected" }>;
	assert.equal(rejected.reason, "policy_rejected");
	assert.equal((rejected.result.details as { reason?: string }).reason, "pilot_isolation");
	return rejected.message;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(condition(), "condition never held");
}

function unmanagedEntry(id: string, extra: Partial<RunningSubagent>): RunningSubagent {
	return {
		id,
		name: `${id}-name`,
		task: "t",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: `/tmp/${id}.jsonl`,
		...extra,
	};
}

/** A verified fan-out's run directory whose manifest reports `state` for candidates in `pgids`. */
function verifiedRun(state: string, pgids: number[]): string {
	const runDir = join(realpathSync(mkdtempSync(join(tmpdir(), "isolation-vf-"))), "run-1");
	mkdirSync(runDir);
	const candidates = pgids.map((pgid, index) => ({ index, pgid }));
	writeFileSync(
		join(runDir, "manifest.json"),
		JSON.stringify({ version: 3, runId: basename(runDir), request: { kind: "verified-fanout" }, state, candidates }),
	);
	return runDir;
}

describe("pilot attempts and unmanaged children never run together", () => {
	beforeEach(async () => {
		exited = spawn("true", [], { detached: true, stdio: "ignore" });
		await once(exited, "exit");
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		resetRuntimeStateForTest(() => {});
		agentDir = writeCanonicalPolicy(canonicalPolicyDocument());
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeManagedDefinitions(agentDir);
		// A pilot receipt needs a Pi command that is a standalone binary.
		const bin = realpathSync(mkdtempSync(join(tmpdir(), "isolation-bin-")));
		const fakePi = join(bin, "fake-pi");
		writeFileSync(fakePi, readFileSync("/usr/bin/true"));
		chmodSync(fakePi, 0o755);
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
	});

	afterEach(async () => {
		for (const child of groups.splice(0)) await endGroup(child);
		resetRuntimeStateForTest(() => {});
	});

	it("refuses a pilot launch while an unmanaged child runs, and allows it once the child exits", async () => {
		const unmanaged = await managedLaunchHarness({ spawnChild: liveGroup, onLaunched: register }).run(helper);
		const pilots = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await pilots.launchPhase([scout]));

		assert.match(message, /free-helper/);
		assert.ok(message.includes(unmanaged.id), message);
		assert.equal(pilots.launched.length, 0);
		assert.deepEqual(reservations(), [], "a refused pilot launch reserves no attempt");

		await endGroup(unmanaged.childProcess as ChildProcess);
		runningSubagents.delete(unmanaged.id);

		assert.equal((await pilots.launchPhase([scout], "dispatch-2")).status, "launched");
	});

	it("refuses an unmanaged launch while a pilot attempt is open, and allows it once the attempt closes", async () => {
		const pilot = await managedLaunchHarness({ onLaunched: register }).run(scout);
		const helpers = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await helpers.launchPhase([helper], "dispatch-2"));

		assert.match(message, /route-scout/);
		assert.equal(helpers.launched.length, 0);

		runningSubagents.delete(pilot.id);

		assert.equal((await helpers.launchPhase([helper], "dispatch-3")).status, "launched");
	});

	it("keeps blocking pilot launches while an unmanaged child's exit is not proven", async () => {
		const unmanaged = await managedLaunchHarness({ spawnChild: liveGroup, onLaunched: register }).run(helper);
		// The parent dropped its record, but the child's process group still runs.
		runningSubagents.delete(unmanaged.id);
		const pilots = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await pilots.launchPhase([scout]));

		assert.ok(message.includes(unmanaged.id), message);

		await endGroup(unmanaged.childProcess as ChildProcess);

		assert.equal((await pilots.launchPhase([scout], "dispatch-2")).status, "launched");
	});

	it("counts a dropped child whose liveness cannot be checked as running", async () => {
		const handleless = unmanagedEntry("nohandle", {});
		const pane = unmanagedEntry("openpane", { mode: "interactive", surface: "%9" });
		for (const entry of [handleless, pane]) {
			runningSubagents.set(entry.id, entry);
			runningSubagents.delete(entry.id);
		}

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout]));

		assert.ok(message.includes("nohandle") && message.includes("openpane"), message);
		assert.deepEqual(reservations(), []);
	});

	it("refuses either kind while the other's launch is still in flight", async () => {
		const pilotGate = deferred();
		const pilots = managedLaunchHarness({
			onLaunched: async (running) => {
				await pilotGate.promise;
				register(running);
			},
		});
		const pilotLaunch = pilots.launchPhase([scout]);
		await until(() => pilots.launched.length === 1);

		assert.match(refusal(await managedLaunchHarness().launchPhase([helper], "dispatch-2")), /route-scout/);

		pilotGate.resolve();
		const pilot = (await pilotLaunch) as Extract<SubagentLaunchPhase, { status: "launched" }>;
		runningSubagents.delete(pilot.launched[0].id);

		const helperGate = deferred();
		const helpers = managedLaunchHarness({
			onLaunched: async (running) => {
				await helperGate.promise;
				register(running);
			},
		});
		const helperLaunch = helpers.launchPhase([helper], "dispatch-3");
		await until(() => helpers.launched.length === 1);

		assert.match(refusal(await managedLaunchHarness().launchPhase([scout], "dispatch-4")), /free-helper/);

		helperGate.resolve();
		assert.equal((await helperLaunch).status, "launched");
	});

	it("refuses a call that mixes a pilot launch with an unmanaged one", async () => {
		const harness = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await harness.launchPhase([scout, helper]));

		assert.match(message, /free-helper/);
		assert.equal(harness.launched.length, 0);
		assert.deepEqual(reservations(), []);
	});

	it("releases the hold of a pilot launch the store refused", async () => {
		const pilots = managedLaunchHarness({ onLaunched: register });
		const pilot = await pilots.run(scout);
		runningSubagents.delete(pilot.id);
		// The case allows one attempt, so this launch is refused after the gate admitted it.
		const exhausted = await pilots.launchPhase([scout], "dispatch-2");
		assert.equal((exhausted as Extract<SubagentLaunchPhase, { status: "rejected" }>).reason, "pilot_attempts_unavailable");

		assert.equal((await managedLaunchHarness().launchPhase([helper], "dispatch-3")).status, "launched");
	});

	it("counts a dropped pilot child whose exit is not proven as an open attempt", async () => {
		const group = liveGroup();
		const pilot = await managedLaunchHarness({
			onLaunched: (running) => {
				running.childProcess = group;
				register(running);
			},
		}).run(scout);
		runningSubagents.delete(pilot.id);
		const helpers = managedLaunchHarness({ onLaunched: register });

		assert.match(refusal(await helpers.launchPhase([helper], "dispatch-2")), /route-scout.*exit not proven/s);

		await endGroup(group);

		assert.equal((await helpers.launchPhase([helper], "dispatch-3")).status, "launched");
	});

	it("proves a pane child gone only when its pane closed without a failed close", async () => {
		register(unmanagedEntry("closed", { mode: "interactive" }));
		register(unmanagedEntry("failedclose", { mode: "interactive", timeoutKillFailed: true }));
		runningSubagents.delete("closed");
		runningSubagents.delete("failedclose");

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout]));

		assert.ok(message.includes("failedclose") && !message.includes("closed-name ("), message);
	});

	it("proves a verified fan-out gone only when its run is terminal and no candidate group lives", async () => {
		const group = liveGroup();
		const entries = [
			unmanagedEntry("runningrun", { verifiedRunDir: verifiedRun("running", []) }),
			unmanagedEntry("livecandidate", { verifiedRunDir: verifiedRun("failed", [group.pid as number]) }),
			unmanagedEntry("unreadable", { verifiedRunDir: join(tmpdir(), "no-such-verified-run") }),
			unmanagedEntry("finished", { verifiedRunDir: verifiedRun("completed", []) }),
		];
		for (const entry of entries) {
			register(entry);
			runningSubagents.delete(entry.id);
		}
		const pilots = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await pilots.launchPhase([scout]));

		for (const id of ["runningrun", "livecandidate", "unreadable"]) assert.ok(message.includes(id), message);
		assert.ok(!message.includes("finished"), message);
	});

	it("keeps children counted when the parent clears its whole record", async () => {
		const unmanaged = await managedLaunchHarness({ spawnChild: liveGroup, onLaunched: register }).run(helper);
		runningSubagents.clear();

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout]));

		assert.ok(message.includes(unmanaged.id), message);
		assert.match(message, /until Pi restarts/);
	});

	// Root ignores the read-only mode this test uses to fail the resume after its child started.
	it("keeps counting a resumed unmanaged child that started but was never tracked", { skip: process.getuid?.() === 0 }, async () => {
		const unmanaged = await managedLaunchHarness().run(helper);
		const bin = realpathSync(mkdtempSync(join(tmpdir(), "isolation-sleeper-")));
		const pidFile = join(bin, "pid");
		process.env.PI_SUBAGENT_PI_COMMAND = join(bin, "sleeper");
		writeFileSync(process.env.PI_SUBAGENT_PI_COMMAND, `#!/usr/bin/env bash\necho $$ > '${pidFile}'\nexec sleep 30\n`);
		chmodSync(process.env.PI_SUBAGENT_PI_COMMAND, 0o755);
		// The child starts, then persisting the model override into its session fails.
		chmodSync(unmanaged.sessionFile, 0o444);

		try {
			await assert.rejects(
				resumeSubagentSession({ sessionFile: unmanaged.sessionFile, task: "Go.", model: "openai-codex/gpt-6-sol" }, resumeRuntime()),
			);
			await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");

			const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout]));
			assert.match(message, /free-helper.*exit not proven/s);
		} finally {
			const written = () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "";
			for (let attempt = 0; attempt < 200 && !written(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
			const pid = written() ? Number(readFileSync(pidFile, "utf8")) : 0;
			if (pid > 0) process.kill(-pid, "SIGKILL");
		}
	});

	it("keeps counting an interactive launch whose pane exists but whose delivery failed", async () => {
		const helpers = managedLaunchHarness({
			onLaunched: () => {
				throw new InteractiveLaunchError("%42", new Error("send-keys failed"));
			},
		});
		await assert.rejects(helpers.launchPhase([helper]), /send-keys failed/);

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout], "dispatch-2"));

		assert.match(message, /free-helper.*exit not proven/s);
	});

	it("refuses a pilot resume while an unmanaged child runs, appending nothing to its attempt", async () => {
		const pilot = await managedLaunchHarness().run(scout);
		const runtime = resumeRuntime();
		runtime.runningSubagents.set("other", unmanagedEntry("other", { childProcess: liveGroup() }));
		const invocation = capturePiInvocation();

		await assert.rejects(resumeSubagentSession({ sessionFile: pilot.sessionFile, task: "Continue." }, runtime), (error) => {
			assert.ok(error instanceof ResumeRefusal, String(error));
			assert.match(error.message, /pilot_isolation.*other-name/s);
			return true;
		});

		assert.deepEqual(reservations().flatMap((entry) => entry.records.map((record) => record.kind)), []);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(invocation.args), false, "no child process may start");
	});

	it("refuses an unmanaged resume while a pilot attempt is open", async () => {
		const unmanaged = await managedLaunchHarness().run(helper);
		const pilot = await managedLaunchHarness().run(scout, "dispatch-2");
		const runtime = resumeRuntime();
		runtime.runningSubagents.set(pilot.id, pilot);
		const invocation = capturePiInvocation();

		await assert.rejects(resumeSubagentSession({ sessionFile: unmanaged.sessionFile, task: "Continue." }, runtime), (error) => {
			assert.ok(error instanceof ResumeRefusal, String(error));
			assert.match(error.message, /pilot_isolation.*route-scout/s);
			return true;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(invocation.args), false, "no child process may start");
	});
});
