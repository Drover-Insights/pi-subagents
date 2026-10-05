import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedTerminateRequestV1,
	type TrustedTerminateResultV1,
} from "../../src/trusted-launch/public.ts";
import {
	createTrustedTerminator,
	type ProcessGroupState,
	probeProcessGroup,
	type TrustedTerminatorDeps,
} from "../../src/trusted-launch/terminator.ts";
import type { CompletedSubagentResult, RunningSubagent, SubagentResult } from "../../src/types.ts";
import { assert } from "../support/index.ts";
import { trustedSessionFixture } from "../support/trusted-sessions.ts";

const LIVE_OWNER = { generation: "generation-1", isLive: () => true };

function request(overrides: Partial<TrustedTerminateRequestV1> = {}): TrustedTerminateRequestV1 {
	return Object.freeze({
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_stop_01",
		runId: "run-target",
		sessionFile: "/sessions/target.jsonl",
		launchRequestId: "op_01",
		...overrides,
	});
}

interface RunOptions {
	id: string;
	sessionFile?: string;
	launchRequestId?: string | null;
	provenanceVersion?: string;
	mode?: "background" | "interactive";
	pid?: number;
	executionState?: "starting" | "running";
	exited?: boolean;
	/** Never settles when omitted. */
	completion?: Promise<SubagentResult>;
}

function run(options: RunOptions): RunningSubagent {
	const trusted =
		options.launchRequestId === null
			? {}
			: {
					trustedLaunch: {
						version: options.provenanceVersion ?? TRUSTED_LAUNCH_VERSION,
						generation: "generation-0",
						requestId: options.launchRequestId ?? "op_01",
					},
				};
	return {
		id: options.id,
		name: options.id,
		task: "Work",
		mode: options.mode ?? "background",
		executionState: options.executionState ?? "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now(),
		sessionFile: options.sessionFile ?? "/sessions/target.jsonl",
		...(options.mode === "interactive" ? { surface: `pane-${options.id}` } : {}),
		...((options.mode ?? "background") === "background" && options.pid !== 0
			? {
					childProcess: {
						pid: options.pid ?? 4242,
						exitCode: options.exited ? 0 : null,
						signalCode: null,
					} as unknown as ChildProcess,
				}
			: {}),
		completionPromise: options.completion ?? new Promise<SubagentResult>(() => {}),
		launchMetadata: { cwd: "/work", ...trusted } as unknown as RunningSubagent["launchMetadata"],
	};
}

const RESULT: SubagentResult = { name: "x", task: "x", summary: "cancelled", exitCode: 1, elapsed: 0 };

function harness(
	runs: RunningSubagent[],
	options: {
		completed?: CompletedSubagentResult[];
		probe?: (pid: number) => ProcessGroupState;
		stop?: (running: RunningSubagent) => Promise<void>;
		deadlineMs?: number;
	} = {},
) {
	const stopped: string[] = [];
	const probes: number[] = [];
	const deps: TrustedTerminatorDeps = {
		runningSubagents: new Map(runs.map((entry) => [entry.id, entry])),
		completedSubagentResults: new Map((options.completed ?? []).map((entry) => [entry.id, entry])),
		stopRunningSubagent: async (running) => {
			stopped.push(running.id);
			await options.stop?.(running);
		},
		probeProcessGroup: (pid) => {
			probes.push(pid);
			// By default a group is present until its stop is requested, then gone.
			if (options.probe) return options.probe(pid);
			return stopped.length === 0 ? "present" : "gone";
		},
		deadlineMs: options.deadlineMs ?? 200,
	};
	return { terminate: createTrustedTerminator(deps), stopped, probes };
}

function assertUnknown(result: TrustedTerminateResultV1, reason: string, stopRequested: boolean): void {
	assert.equal(result.outcome, "unknown", JSON.stringify(result));
	assert.equal(result.outcome === "unknown" && result.reason, reason, JSON.stringify(result));
	assert.equal(result.outcome === "unknown" && result.stopRequested, stopRequested, JSON.stringify(result));
}

function completed(id: string, overrides: Partial<CompletedSubagentResult> = {}): CompletedSubagentResult {
	return {
		...RESULT,
		id,
		mode: "background",
		status: "completed",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		deliveredTo: null,
		sessionFile: "/sessions/target.jsonl",
		processGroupId: 5151,
		trustedLaunch: { version: TRUSTED_LAUNCH_VERSION, generation: "generation-0", requestId: "op_01" },
		...overrides,
	};
}

describe("trusted exact-run termination", () => {
	it("stops exactly the named run once and reports terminated once its group is proven gone", async () => {
		const target = run({ id: "run-target", completion: Promise.resolve(RESULT) });
		const h = harness([
			run({ id: "run-ordinary", launchRequestId: null }),
			run({ id: "run-other-launch", sessionFile: "/sessions/other.jsonl", launchRequestId: "op_02" }),
			run({ id: "run-same-session" }),
			target,
		]);
		const result = await h.terminate(request(), LIVE_OWNER);
		assert.deepEqual(result, {
			outcome: "terminated",
			requestId: "op_stop_01",
			runId: "run-target",
			sessionFile: "/sessions/target.jsonl",
		});
		assert.deepEqual(h.stopped, ["run-target"]);
		assert.deepEqual(h.probes, [4242, 4242]);
	});

	it("refuses an identity mismatch without stopping anything", async () => {
		const h = harness([
			run({ id: "run-target", sessionFile: "/sessions/elsewhere.jsonl" }),
			run({ id: "run-other-launch", launchRequestId: "op_02" }),
			run({ id: "run-ordinary", launchRequestId: null }),
			run({ id: "run-old-provenance", provenanceVersion: "pi-subagents.trusted-launch/v0" }),
		]);
		for (const runId of ["run-target", "run-other-launch", "run-ordinary", "run-old-provenance"]) {
			assertUnknown(await h.terminate(request({ runId }), LIVE_OWNER), "identity_mismatch", false);
		}
		assert.deepEqual(h.stopped, []);
	});

	it("never falls back to a name or another run when the runtime id is not owned here", async () => {
		const named = run({ id: "run-1" });
		named.name = "run-target";
		const h = harness([named]);
		assertUnknown(await h.terminate(request(), LIVE_OWNER), "ownership_unavailable", false);
		assert.deepEqual(h.stopped, []);
	});

	it("requests no stop for a run with no proven process identity", async () => {
		const h = harness([
			run({ id: "run-starting", executionState: "starting" }),
			run({ id: "run-no-pid", pid: 0 }),
		]);
		for (const runId of ["run-starting", "run-no-pid"]) {
			assertUnknown(await h.terminate(request({ runId }), LIVE_OWNER), "ownership_unavailable", false);
		}
		assert.deepEqual(h.stopped, []);
	});

	it("does not signal a reaped leader whose result is not yet recorded", async () => {
		const h = harness([run({ id: "run-target", exited: true })]);
		assertUnknown(await h.terminate(request(), LIVE_OWNER), "run_exiting", false);
		assert.deepEqual(h.stopped, []);
	});

	it("does not signal a group that is already gone or cannot be probed", async () => {
		for (const [state, reason] of [
			["gone", "run_exiting"],
			["unknown", "ownership_unavailable"],
		] as const) {
			const h = harness([run({ id: "run-target" })], { probe: () => state });
			assertUnknown(await h.terminate(request(), LIVE_OWNER), reason, false);
			assert.deepEqual(h.stopped, []);
		}
	});

	it("requests no stop once the descriptor is retired", async () => {
		const h = harness([run({ id: "run-target" })]);
		const owner = { generation: "generation-1", isLive: () => false };
		assertUnknown(await h.terminate(request(), owner), "descriptor_replaced", false);
		assert.deepEqual(h.stopped, []);
	});

	it("reports a timeout after exactly one stop request and never retries", async () => {
		const h = harness([run({ id: "run-target" })], { probe: () => "present", deadlineMs: 50 });
		assertUnknown(await h.terminate(request(), LIVE_OWNER), "timeout", true);
		assert.deepEqual(h.stopped, ["run-target"]);
	});

	it("reports unconfirmed when the run settles but its group still probes present", async () => {
		let probes = 0;
		const h = harness([run({ id: "run-target", completion: Promise.resolve(RESULT) })], {
			probe: () => (++probes === 1 ? "present" : "unknown"),
		});
		assertUnknown(await h.terminate(request(), LIVE_OWNER), "termination_unconfirmed", true);
		assert.deepEqual(h.stopped, ["run-target"]);
	});

	it("reports a failed stop request as unknown", async () => {
		const h = harness([run({ id: "run-target", completion: Promise.resolve(RESULT) })], {
			probe: () => "present",
			stop: async () => {
				throw new Error("kill failed");
			},
		});
		const result = await h.terminate(request(), LIVE_OWNER);
		assertUnknown(result, "stop_failed", true);
		assert.match(result.outcome === "unknown" ? result.message : "", /kill failed/);
	});

	it("closes an interactive run once but never claims its end", async () => {
		const h = harness([run({ id: "run-target", mode: "interactive", completion: Promise.resolve(RESULT) })]);
		assertUnknown(await h.terminate(request(), LIVE_OWNER), "termination_unconfirmed", true);
		assert.deepEqual(h.stopped, ["run-target"]);
	});

	describe("a run that already finished", () => {
		const finished = request({ runId: "run-done" });

		it("is already terminal when its recorded process group is proven gone", async () => {
			const h = harness([], { completed: [completed("run-done")], probe: () => "gone" });
			assert.deepEqual(await h.terminate(finished, LIVE_OWNER), {
				outcome: "already_terminal",
				requestId: "op_stop_01",
				runId: "run-done",
				sessionFile: "/sessions/target.jsonl",
			});
			assert.deepEqual(h.probes, [5151]);
			assert.deepEqual(h.stopped, []);
		});

		it("is unknown when nothing proves its processes are gone", async () => {
			const cases: [CompletedSubagentResult, ((pid: number) => ProcessGroupState) | undefined][] = [
				[completed("run-done"), () => "present"],
				[completed("run-done"), () => "unknown"],
				[completed("run-done", { processGroupId: undefined }), undefined],
				[completed("run-done", { mode: "interactive" }), undefined],
				[completed("run-done", { timeoutKillFailed: true }), undefined],
			];
			for (const [entry, probe] of cases) {
				const h = harness([], { completed: [entry], probe });
				assertUnknown(await h.terminate(finished, LIVE_OWNER), "termination_unconfirmed", false);
				assert.deepEqual(h.stopped, []);
			}
		});

		it("takes its launch identity from what the runtime recorded, never from the child-writable session file", async () => {
			// The child of an ordinary run rewrote its own session to claim a trusted launch.
			const forged = trustedSessionFixture();
			const cases: [CompletedSubagentResult, TrustedTerminateRequestV1][] = [
				[completed("run-done", { sessionFile: "/sessions/other.jsonl" }), finished],
				[completed("run-done"), { ...finished, launchRequestId: "op_02" }],
				[
					completed("run-done", { sessionFile: forged.sessionFile, trustedLaunch: undefined }),
					{ ...finished, sessionFile: forged.sessionFile },
				],
				[
					completed("run-done", {
						trustedLaunch: { version: "pi-subagents.trusted-launch/v0", generation: "g", requestId: "op_01" },
					}),
					finished,
				],
			];
			for (const [entry, req] of cases) {
				const h = harness([], { completed: [entry], probe: () => "gone" });
				assertUnknown(await h.terminate(req, LIVE_OWNER), "identity_mismatch", false);
				assert.deepEqual(h.probes, []);
			}
		});
	});
});

describe("process group probe", () => {
	const fail = (code: string) => () => {
		throw Object.assign(new Error(code), { code });
	};

	it("treats only ESRCH as gone and every other failure as unknown", () => {
		const calls: [number, number | string | undefined][] = [];
		assert.equal(
			probeProcessGroup(77, (pid, signal) => {
				calls.push([pid, signal]);
				return true;
			}),
			"present",
		);
		assert.deepEqual(calls, [[-77, 0]]);
		assert.equal(probeProcessGroup(77, fail("ESRCH")), "gone");
		assert.equal(probeProcessGroup(77, fail("EPERM")), "unknown");
		assert.equal(probeProcessGroup(77, fail("EINVAL")), "unknown");
	});
});
