import type { CompletedSubagentResult, RunningSubagent } from "../types.ts";
import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedTerminateRequestV1,
	type TrustedTerminateResultV1,
	type TrustedTerminateUnknownReason,
} from "./contract.ts";
import type { TrustedTerminator } from "./registry.ts";

/**
 * Longer than the background watcher's 5 s SIGKILL escalation after an
 * abort, so a child that ignores SIGTERM can still be proven gone.
 */
const TERMINATION_DEADLINE_MS = 8000;

export type ProcessGroupState = "present" | "gone" | "unknown";

/**
 * Probe a process group. Only ESRCH proves it gone: the kernel never reuses
 * a pid that still names a group, so a gone group cannot read as present
 * through reuse, while EPERM or any other failure proves nothing.
 */
export function probeProcessGroup(
	pid: number,
	kill: (pid: number, signal?: string | number) => boolean = process.kill,
): ProcessGroupState {
	try {
		kill(-pid, 0);
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "gone" : "unknown";
	}
}

export interface TrustedTerminatorDeps {
	runningSubagents: ReadonlyMap<string, RunningSubagent>;
	completedSubagentResults: ReadonlyMap<string, CompletedSubagentResult>;
	/** The session's own stop path: aborts the watcher, signals the group, closes the surface. */
	stopRunningSubagent(running: RunningSubagent): Promise<void>;
	probeProcessGroup?: (pid: number) => ProcessGroupState;
	deadlineMs?: number;
}

function unknown(
	reason: TrustedTerminateUnknownReason,
	message: string,
	stopRequested: boolean,
): TrustedTerminateResultV1 {
	return { outcome: "unknown", reason, message, stopRequested };
}

function ended(outcome: "terminated" | "already_terminal", request: TrustedTerminateRequestV1): TrustedTerminateResultV1 {
	return { outcome, requestId: request.requestId, runId: request.runId, sessionFile: request.sessionFile };
}

/** Whether persisted trusted provenance names the requested launch. */
function namesLaunch(provenance: { version?: unknown; requestId?: unknown } | undefined, launchRequestId: string): boolean {
	return provenance?.version === TRUSTED_LAUNCH_VERSION && provenance.requestId === launchRequestId;
}

/**
 * Terminate one run by its exact trusted identities. It requests at most one
 * stop, through the session's own stop path, never retries, and reports an
 * end only when the run's process group is proven gone.
 */
export function createTrustedTerminator(deps: TrustedTerminatorDeps): TrustedTerminator {
	const probe = deps.probeProcessGroup ?? ((pid: number) => probeProcessGroup(pid));
	const deadlineMs = deps.deadlineMs ?? TERMINATION_DEADLINE_MS;

	function terminateFinished(request: TrustedTerminateRequestV1): TrustedTerminateResultV1 {
		const finished = deps.completedSubagentResults.get(request.runId);
		if (!finished) {
			return unknown("ownership_unavailable", `This session does not own run ${JSON.stringify(request.runId)}.`, false);
		}
		// The session file is the child's to write, so only the provenance the
		// runtime recorded for the run identifies its launch.
		if (finished.sessionFile !== request.sessionFile || !namesLaunch(finished.trustedLaunch, request.launchRequestId)) {
			return unknown("identity_mismatch", "The run's session or launch does not match the request.", false);
		}
		// A leader can exit while descendants keep running, and a pane child
		// leaves no group to probe, so only a recorded group that is gone counts.
		const pgid = finished.processGroupId;
		if (finished.mode !== "background" || finished.timeoutKillFailed || !pgid || probe(pgid) !== "gone") {
			return unknown("termination_unconfirmed", "The run finished, but nothing proves all of its processes ended.", false);
		}
		return ended("already_terminal", request);
	}

	return async (request, owner) => {
		const running = deps.runningSubagents.get(request.runId);
		if (!running) return terminateFinished(request);
		if (
			running.sessionFile !== request.sessionFile ||
			!namesLaunch(running.launchMetadata?.trustedLaunch, request.launchRequestId)
		) {
			return unknown("identity_mismatch", "The run's session or launch does not match the request.", false);
		}
		const child = running.childProcess;
		const pid = child?.pid;
		if (running.mode === "background") {
			if (running.executionState !== "running" || !pid || !running.completionPromise) {
				return unknown("ownership_unavailable", "The run has no recorded process to stop yet.", false);
			}
			// A reaped leader's pid is free for reuse: never signal it. The watcher
			// is finishing or restarting the run, so its result decides.
			if (child.exitCode !== null || child.signalCode !== null) {
				return unknown("run_exiting", "The run's process is already exiting; its result is not recorded yet.", false);
			}
			const state = probe(pid);
			if (state === "gone") {
				return unknown("run_exiting", "The run's process group is already gone; its result is not recorded yet.", false);
			}
			if (state === "unknown") {
				return unknown("ownership_unavailable", "The run's process group cannot be probed.", false);
			}
		}
		if (!owner.isLive()) {
			return unknown("descriptor_replaced", "The descriptor was retired before the stop.", false);
		}
		// Called in the same tick as the checks above, so the group cannot be
		// reaped and its pid reused between them and the signal.
		const stop = deps.stopRunningSubagent(running);
		try {
			await stop;
		} catch (error) {
			return unknown(
				"stop_failed",
				`Stopping the run failed: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
		}
		if (running.mode !== "background" || !pid) {
			return unknown("termination_unconfirmed", "The run's surface was closed; a pane child's end cannot be proven.", true);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			running.completionPromise!.then(
				() => true,
				() => true,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), deadlineMs);
				timer.unref?.();
			}),
		]);
		clearTimeout(timer);
		if (!settled) {
			return unknown("timeout", `The run did not finish within ${deadlineMs} ms of the stop request.`, true);
		}
		if (probe(pid) !== "gone") {
			return unknown("termination_unconfirmed", "The run finished, but its process group may still exist.", true);
		}
		return ended("terminated", request);
	};
}
