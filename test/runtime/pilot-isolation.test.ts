import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { InteractiveLaunchError } from "../../src/launch/interactive.ts";
import { readPilotCase } from "../../src/routing/pilot-attempt-store.ts";
import { ResumeRefusal } from "../../src/runtime/resume-refusal.ts";
import { resetPilotIsolationForTest } from "../../src/runtime/pilot-isolation.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { resetRuntimeStateForTest, runningSubagents } from "../../src/runtime/state.ts";
import { shutdownSubagentsForTest } from "../../src/runtime/wiring.ts";
import type { SubagentLaunchPhase } from "../../src/tools/subagent-launch.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { adoptVerifiedRuns } from "../../src/vf/run/adopt.ts";
import { verifiedRunsBaseDir } from "../../src/vf/run/launch.ts";
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

/** Kill a process group that may already be gone. */
function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

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

/** A dropped pilot child, as the parent records one; unmanaged children no longer linger. */
function pilotEntry(id: string, extra: Partial<RunningSubagent>): RunningSubagent {
	return unmanagedEntry(id, {
		agent: "pilot-scout",
		routing: { status: "managed", pilotCase: "scout-literal-1" } as RunningSubagent["routing"],
		...extra,
	});
}

/** The refusal a pilot launch gets once this process has run an unmanaged child. */
const TAINTED = /this Pi process has run an unmanaged child.*restart Pi/s;

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

	it("refuses a pilot launch while an unmanaged child runs, and still refuses it after the child exits", async () => {
		const unmanaged = await managedLaunchHarness({ spawnChild: liveGroup, onLaunched: register }).run(helper);
		const pilots = managedLaunchHarness({ onLaunched: register });

		const message = refusal(await pilots.launchPhase([scout]));

		assert.match(message, /free-helper/);
		assert.ok(message.includes(unmanaged.id), message);
		// Waiting for the child never helps, so the refusal must not promise it does.
		assert.match(message, TAINTED);
		assert.doesNotMatch(message, /waits until/);
		assert.equal(pilots.launched.length, 0);
		assert.deepEqual(reservations(), [], "a refused pilot launch reserves no attempt");

		await endGroup(unmanaged.childProcess as ChildProcess);
		runningSubagents.delete(unmanaged.id);

		assert.match(refusal(await pilots.launchPhase([scout], "dispatch-2")), TAINTED);
		assert.equal(pilots.launched.length, 0);
		assert.deepEqual(reservations(), [], "a tainted refusal reserves no attempt");
	});

	it("refuses a pilot beside an untainted unmanaged record without promising that waiting helps", async () => {
		register(unmanagedEntry("direct", { childProcess: liveGroup() }));

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout]));

		assert.ok(message.includes("direct-name (direct)"), message);
		assert.match(message, TAINTED);
		assert.doesNotMatch(message, /waits until/);
		assert.deepEqual(reservations(), []);
	});

	it("admits pilot launches in a process that never ran an unmanaged child", async () => {
		const pilots = managedLaunchHarness({ onLaunched: register });
		assert.equal((await pilots.launchPhase([scout])).status, "launched");
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

	it("keeps refusing pilot launches after an unmanaged child left a setsid descendant, even once it exits", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "isolation-setsid-")));
		const pidFile = join(dir, "pid");
		const leaver = () => {
			const child = spawn("sh", ["-c", `setsid sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'`], {
				detached: true,
				stdio: "ignore",
			});
			groups.push(child);
			return child;
		};
		const unmanaged = await managedLaunchHarness({ spawnChild: leaver, onLaunched: register }).run(helper);
		let descendant = 0;
		try {
			const child = unmanaged.childProcess as ChildProcess;
			if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
			descendant = Number(readFileSync(pidFile, "utf8"));
			assert.ok(descendant > 0, "the setsid descendant started");
			// The child exited cleanly; its own process group is empty.
			runningSubagents.delete(unmanaged.id);

			assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout])), TAINTED);

			killGroup(descendant);
			descendant = 0;

			assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout], "dispatch-2")), TAINTED);
			assert.deepEqual(reservations(), []);
		} finally {
			if (descendant > 0) killGroup(descendant);
		}
	});

	it("taints on an unmanaged launch whose spawn failed", async () => {
		const helpers = managedLaunchHarness({
			onLaunched: () => {
				throw new Error("spawn failed");
			},
		});
		await assert.rejects(helpers.launchPhase([helper]), /spawn failed/);

		assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout], "dispatch-2")), TAINTED);
		assert.deepEqual(reservations(), []);
	});

	it("keeps the taint across a session shutdown and a module reload; only the reset clears it", async () => {
		const unmanaged = await managedLaunchHarness().run(helper);
		runningSubagents.delete(unmanaged.id);
		await shutdownSubagentsForTest();

		assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout])), TAINTED);
		// Pi re-imports an extension's modules on /reload and on a cwd change.
		const href = new URL("../../src/runtime/pilot-isolation.ts?reloaded=1", import.meta.url).href;
		const reloaded = await import(href);
		const held = reloaded.acquirePilotIsolation([{ name: "route-scout", class: "pilot" }], []);
		assert.equal(held.status, "refused");
		assert.match(held.message, TAINTED);

		resetPilotIsolationForTest();

		assert.equal((await managedLaunchHarness({ onLaunched: register }).launchPhase([scout], "dispatch-2")).status, "launched");
	});

	it("counts a dropped pilot child whose liveness cannot be checked as open", async () => {
		const handleless = pilotEntry("nohandle", {});
		const pane = pilotEntry("openpane", { mode: "interactive", surface: "%9" });
		for (const entry of [handleless, pane]) {
			runningSubagents.set(entry.id, entry);
			runningSubagents.delete(entry.id);
		}

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([helper]));

		assert.ok(message.includes("nohandle") && message.includes("openpane"), message);
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
		register(pilotEntry("closed", { mode: "interactive" }));
		register(pilotEntry("failedclose", { mode: "interactive", timeoutKillFailed: true }));
		runningSubagents.delete("closed");
		runningSubagents.delete("failedclose");

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([helper]));

		assert.ok(message.includes("failedclose") && !message.includes("closed-name ("), message);
	});

	it("proves a verified fan-out gone only when its run is terminal and no candidate group lives", async () => {
		const group = liveGroup();
		const entries = [
			pilotEntry("runningrun", { verifiedRunDir: verifiedRun("running", []) }),
			pilotEntry("livecandidate", { verifiedRunDir: verifiedRun("failed", [group.pid as number]) }),
			pilotEntry("unreadable", { verifiedRunDir: join(tmpdir(), "no-such-verified-run") }),
			pilotEntry("finished", { verifiedRunDir: verifiedRun("completed", []) }),
		];
		for (const entry of entries) {
			register(entry);
			runningSubagents.delete(entry.id);
		}

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([helper]));

		for (const id of ["runningrun", "livecandidate", "unreadable"]) assert.ok(message.includes(id), message);
		assert.ok(!message.includes("finished"), message);
	});

	it("keeps a pilot child counted when the parent clears its whole record", async () => {
		const pilot = await managedLaunchHarness({ spawnChild: liveGroup, onLaunched: register }).run(scout);
		runningSubagents.clear();

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([helper], "dispatch-2"));

		assert.ok(message.includes(pilot.id), message);
		assert.match(message, /route-scout.*exit not proven/s);
	});

	it("taints on a resumed unmanaged child", async () => {
		const unmanaged = await managedLaunchHarness().run(helper);
		// A fresh process that only resumes the session.
		resetPilotIsolationForTest();
		const fakePi = process.env.PI_SUBAGENT_PI_COMMAND;
		capturePiInvocation();
		const runtime = resumeRuntime();

		const resumed = await resumeSubagentSession({ sessionFile: unmanaged.sessionFile, task: "Continue." }, runtime);
		runtime.runningSubagents.delete(resumed.id);
		// A pilot receipt needs the standalone binary back.
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;

		assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout])), TAINTED);
	});

	it("taints on an adopted verified run, observer or not", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "isolation-adopt-")));
		mkdirSync(join(cwd, ".git"));
		process.env.PI_ARTIFACT_PROJECT_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "isolation-artifacts-")));
		try {
			const runDir = join(verifiedRunsBaseDir(cwd), "vf-runs", "run-adopted");
			mkdirSync(runDir, { recursive: true });
			const manifest = (state: string) =>
				JSON.stringify({
					version: 3,
					runId: "run-adopted",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					state,
					leaseId: "lease",
					// A live supervisor, so adoption watches the run without respawning it.
					lease: { pid: process.pid },
					request: { kind: "verified-fanout", name: "fanout", title: "Fan-out", taskPrompt: "t", agent: "scout", sourceRepo: cwd, candidateCount: 1, candidates: [], parentSessionId: null },
					candidates: [],
					result: null,
				});
			writeFileSync(join(runDir, "manifest.json"), manifest("running"));

			const outcomes = await adoptVerifiedRuns({ sendMessage: () => {} } as never, cwd, { sessionId: "observer" });
			assert.equal(outcomes[0]?.action, "watching", JSON.stringify(outcomes));
			// The run ends and the parent drops it, with its exit proven.
			writeFileSync(join(runDir, "manifest.json"), manifest("completed"));
			for (const running of [...runningSubagents.values()]) runningSubagents.delete(running.id);

			assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout])), TAINTED);
		} finally {
			delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		}
	});

	it("taints at startup adoption before delivering earlier finished runs", async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "isolation-adopt-gap-")));
		mkdirSync(join(cwd, ".git"));
		process.env.PI_ARTIFACT_PROJECT_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "isolation-artifacts-")));
		let release!: (persisted: boolean) => void;
		const persisted = new Promise<boolean>((done) => {
			release = done;
		});
		let adoption: Promise<unknown> | undefined;
		try {
			const write = (runId: string, state: string) => {
				const runDir = join(verifiedRunsBaseDir(cwd), "vf-runs", runId);
				mkdirSync(runDir, { recursive: true });
				writeFileSync(
					join(runDir, "manifest.json"),
					JSON.stringify({
						version: 3,
						runId,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						state,
						leaseId: "lease",
						lease: { pid: process.pid },
						request: { kind: "verified-fanout", name: runId, title: runId, taskPrompt: "t", agent: "scout", sourceRepo: cwd, candidateCount: 1, candidates: [], parentSessionId: "parent" },
						candidates: [],
						result: null,
					}),
				);
			};
			// Finished runs this session must receive, and one live run from an earlier Pi.
			for (const runId of ["run-a-done", "run-b-done", "run-c-done"]) write(runId, "completed");
			write("run-z-live", "running");

			// Not awaited, as session_start starts it; each delivery waits on persistence.
			adoption = adoptVerifiedRuns({ sendMessage: () => {} } as never, cwd, {
				sessionId: "parent",
				triggerTurn: false,
				confirmPersisted: () => persisted,
			});

			assert.match(refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([scout])), TAINTED);
		} finally {
			release(false);
			await adoption;
			delete process.env.PI_ARTIFACT_PROJECT_ROOT;
		}
	});

	it("refuses a pilot resume after an unmanaged child exited", async () => {
		const pilot = await managedLaunchHarness().run(scout);
		const unmanaged = await managedLaunchHarness().run(helper, "dispatch-2");
		runningSubagents.delete(unmanaged.id);
		const invocation = capturePiInvocation();
		const before = JSON.stringify(reservations());

		await assert.rejects(resumeSubagentSession({ sessionFile: pilot.sessionFile, task: "Continue." }, resumeRuntime()), (error) => {
			assert.ok(error instanceof ResumeRefusal, String(error));
			assert.match(error.message, /pilot_isolation/);
			assert.match(error.message, TAINTED);
			return true;
		});

		assert.equal(JSON.stringify(reservations()), before, "a refused pilot resume appends nothing to its attempt");

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(existsSync(invocation.args), false, "no child process may start");
	});

	it("keeps counting an interactive pilot launch whose pane exists but whose delivery failed", async () => {
		const pilots = managedLaunchHarness({
			onLaunched: () => {
				throw new InteractiveLaunchError("%42", new Error("send-keys failed"));
			},
		});
		await assert.rejects(pilots.launchPhase([scout]), /send-keys failed/);

		const message = refusal(await managedLaunchHarness({ onLaunched: register }).launchPhase([helper], "dispatch-2"));

		assert.match(message, /route-scout.*exit not proven/s);
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
		// The pilot first: once an unmanaged child ran, no pilot launches.
		const pilot = await managedLaunchHarness().run(scout);
		const unmanaged = await managedLaunchHarness().run(helper, "dispatch-2");
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
