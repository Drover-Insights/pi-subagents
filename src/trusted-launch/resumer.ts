import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResumeRefusal, type ResumeServiceRuntime, resumeSubagentSession } from "../runtime/resume-service.ts";
import type { SubagentToolRuntime } from "../tools/subagent-launch.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import type { RunningSubagent, TrustedLaunchProvenance } from "../types.ts";
import type { TrustedResumeRejection, TrustedResumeResultV1 } from "./contract.ts";
import { stopUnaccountedChild } from "./launcher.ts";
import type { TrustedResumer } from "./registry.ts";

export interface TrustedResumeRuntime
	extends ResumeServiceRuntime,
		Pick<SubagentToolRuntime, "wireSubagentSteerBack" | "stopRunningSubagent"> {}

export interface TrustedResumerDeps {
	pi: ExtensionAPI;
	runtime: TrustedResumeRuntime;
	/** Whether this session currently forces every launch to be awaited. */
	forceSynchronous: () => boolean;
}

function notStarted(reason: TrustedResumeRejection, message: string): TrustedResumeResultV1 {
	return { outcome: "not_started", reason, message };
}

/**
 * Resume one trusted request through the shared resume service, from the
 * session's revalidated launch authority only. A refusal never falls back to
 * the ordinary resume path.
 */
export function createTrustedResumer(deps: TrustedResumerDeps): TrustedResumer {
	return async (request, owner) => {
		const { runtime } = deps;
		if (deps.forceSynchronous()) {
			return notStarted("synchronous_launch", "Trusted resume is asynchronous; this resume would be awaited.");
		}
		let running: RunningSubagent;
		try {
			running = await resumeSubagentSession(
				{
					sessionFile: request.sessionFile,
					...(request.task !== undefined ? { task: request.task } : {}),
					trusted: { effectiveCwd: request.effectiveCwd, launchRequestId: request.launchRequestId },
				},
				runtime,
			);
		} catch (error) {
			if (error instanceof ResumeRefusal && error.reason !== "trusted_session") {
				return notStarted(error.reason, error.message);
			}
			throw error;
		}
		runtime.wireSubagentSteerBack(deps.pi, running, running.completionPromise!);
		if (!owner.isLive()) {
			// The session retired the descriptor mid-resume; its shutdown sweep
			// may already have run, so this child would be orphaned.
			return stopUnaccountedChild(runtime, running, "descriptor_retired", "The descriptor was retired during the resume.");
		}
		// The service resumed from the authority it validated: a trusted launch
		// entry recorded in this exact directory.
		const { trustedLaunch, cwd } = running.launchMetadata as PersistedSubagentLaunchMetadata & {
			trustedLaunch: TrustedLaunchProvenance;
		};
		return {
			outcome: "resumed",
			requestId: request.requestId,
			runId: running.id,
			sessionFile: running.sessionFile,
			mode: running.mode,
			...(running.surface ? { surfaceId: running.surface } : {}),
			effectiveCwd: cwd,
			// A copy: the caller must not reach the running child's state.
			launch: Object.freeze({
				...trustedLaunch,
				...(trustedLaunch.labels ? { labels: Object.freeze({ ...trustedLaunch.labels }) } : {}),
			}),
		};
	};
}
