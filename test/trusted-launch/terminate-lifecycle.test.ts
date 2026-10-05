import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { stopRunningSubagent } from "../../src/runtime/running-registry.ts";
import { buildCompletedSubagentResult } from "../../src/runtime/state.ts";
import { TRUSTED_LAUNCH_VERSION, type TrustedTerminateRequestV1 } from "../../src/trusted-launch/public.ts";
import { createTrustedTerminator, probeProcessGroup } from "../../src/trusted-launch/terminator.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/types.ts";
import { assert } from "../support/index.ts";
import { trustedSessionFixture } from "../support/trusted-sessions.ts";

/**
 * Real process groups under the real background watcher and stop path. Each
 * child is a detached shell holding a descendant, as a Pi child holds tools.
 */
const groups: number[] = [];
const LIVE_OWNER = { generation: "generation-1", isLive: () => true };

function spawnGroup(script: string): number {
	const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
	child.unref();
	groups.push(child.pid!);
	return child.pid!;
}

function backgroundRun(
	id: string,
	sessionFile: string,
	launchRequestId: string | null,
	maps: { running: Map<string, RunningSubagent>; completed: Map<string, CompletedSubagentResult> },
	options: { script?: string; watch?: boolean } = {},
): RunningSubagent {
	const child = spawn("sh", ["-c", options.script ?? "sleep 30 & wait"], { detached: true, stdio: "ignore" });
	groups.push(child.pid!);
	const abortController = new AbortController();
	const running: RunningSubagent = {
		id,
		name: id,
		task: "Work",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile,
		childProcess: child,
		abortController,
		launchMetadata: {
			cwd: "/work",
			...(launchRequestId
				? { trustedLaunch: { version: TRUSTED_LAUNCH_VERSION, generation: "generation-0", requestId: launchRequestId } }
				: {}),
		} as unknown as RunningSubagent["launchMetadata"],
	};
	running.completionPromise =
		options.watch === false
			? new Promise(() => {})
			: watchBackgroundSubagent(
					running,
					{
						cleanupNoSessionSessionFile() {},
						terminateBackgroundChildProcess(current, signal) {
							process.kill(-current.childProcess!.pid!, signal);
						},
					},
					abortController.signal,
				).then((result) => {
					// What result routing does when a detached child finishes.
					maps.running.delete(id);
					maps.completed.set(id, buildCompletedSubagentResult(running, result));
					return result;
				});
	maps.running.set(id, running);
	return running;
}

function harness(deadlineMs?: number) {
	const maps = { running: new Map<string, RunningSubagent>(), completed: new Map<string, CompletedSubagentResult>() };
	const terminate = createTrustedTerminator({
		runningSubagents: maps.running,
		completedSubagentResults: maps.completed,
		stopRunningSubagent: (running) => stopRunningSubagent(running, async () => {}),
		...(deadlineMs ? { deadlineMs } : {}),
	});
	return { maps, terminate };
}

function request(runId: string, sessionFile: string): TrustedTerminateRequestV1 {
	return Object.freeze({
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: `op_stop_${runId}`,
		runId,
		sessionFile,
		launchRequestId: "op_01",
	});
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

describe("trusted termination of real process groups", () => {
	afterEach(() => {
		for (const pid of groups.splice(0)) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		}
	});

	it("ends only the exact run, leaves unrelated runs and sessions running, then reports it already terminal", async () => {
		const h = harness();
		const target = trustedSessionFixture();
		const other = trustedSessionFixture();
		const run = backgroundRun("run-target", target.sessionFile, "op_01", h.maps);
		const ordinary = backgroundRun("run-ordinary", target.sessionFile, null, h.maps);
		const otherLaunch = backgroundRun("run-other", other.sessionFile, "op_02", h.maps);
		const independent = spawnGroup("sleep 30 & wait");
		// A detached child becomes its group's leader only after the fork returns.
		for (const pid of [run, ordinary, otherLaunch].map((entry) => entry.childProcess!.pid!).concat(independent)) {
			await waitFor(() => probeProcessGroup(pid) === "present", `group ${pid} to start`);
		}

		const result = await h.terminate(request("run-target", target.sessionFile), LIVE_OWNER);
		assert.deepEqual(result, {
			outcome: "terminated",
			requestId: "op_stop_run-target",
			runId: "run-target",
			sessionFile: target.sessionFile,
		});
		assert.equal(probeProcessGroup(run.childProcess!.pid!), "gone");
		for (const sibling of [ordinary, otherLaunch]) {
			assert.equal(probeProcessGroup(sibling.childProcess!.pid!), "present", sibling.id);
			assert.equal(sibling.abortController!.signal.aborted, false, sibling.id);
			assert.equal(h.maps.running.has(sibling.id), true, sibling.id);
		}
		assert.equal(probeProcessGroup(independent), "present");

		// A mismatched identity for a live sibling touches nothing.
		const mismatch = await h.terminate(request("run-other", target.sessionFile), LIVE_OWNER);
		assert.equal(mismatch.outcome === "unknown" && mismatch.reason, "identity_mismatch");
		assert.equal(probeProcessGroup(otherLaunch.childProcess!.pid!), "present");

		const again = await h.terminate(request("run-target", target.sessionFile), LIVE_OWNER);
		assert.equal(again.outcome, "already_terminal", JSON.stringify(again));
	});

	it("reports a group that ignores the stop as a timeout and requests no second stop", async () => {
		const h = harness(400);
		const target = trustedSessionFixture();
		const ready = join(dirname(target.sessionFile), "ready");
		const received = join(dirname(target.sessionFile), "sigterms");
		// The shell records every SIGTERM it receives and keeps running. No watcher
		// runs here, so every signal counted is the terminator's own: with a watcher,
		// the existing stop path's abort adds its own SIGTERM and later SIGKILL.
		const run = backgroundRun("run-target", target.sessionFile, "op_01", h.maps, {
			script: `trap 'echo term >> ${JSON.stringify(received)}' TERM; : > ${JSON.stringify(ready)}; while :; do sleep 0.05; done`,
			watch: false,
		});
		await waitFor(() => existsSync(ready), "the group to ignore SIGTERM");

		const result = await h.terminate(request("run-target", target.sessionFile), LIVE_OWNER);
		assert.equal(result.outcome === "unknown" && result.reason, "timeout", JSON.stringify(result));
		assert.equal(result.outcome === "unknown" && result.stopRequested, true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(probeProcessGroup(run.childProcess!.pid!), "present", "no escalation after the deadline");
		assert.deepEqual(readFileSync(received, "utf8").trim().split("\n"), ["term"], "the terminator requested one stop and never retried");
	});

	it("does not call a run already terminal while a descendant outlives its leader", async () => {
		const h = harness();
		const target = trustedSessionFixture();
		const run = backgroundRun("run-target", target.sessionFile, "op_01", h.maps, { script: "sleep 30 & exit 0" });
		await waitFor(() => h.maps.completed.has("run-target"), "the leader's exit to be recorded");
		assert.equal(probeProcessGroup(run.childProcess!.pid!), "present");

		const result = await h.terminate(request("run-target", target.sessionFile), LIVE_OWNER);
		assert.equal(result.outcome === "unknown" && result.reason, "termination_unconfirmed", JSON.stringify(result));
		assert.equal(result.outcome === "unknown" && result.stopRequested, false);
		assert.equal(probeProcessGroup(run.childProcess!.pid!), "present", "a finished run is never signalled");
	});
});
