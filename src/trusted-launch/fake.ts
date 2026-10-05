import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchMode,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
	type TrustedResumeRequestV1,
	type TrustedSubagentsDescriptor,
	type TrustedTerminateRequestV1,
	type TrustedTerminateResultV1,
} from "./contract.ts";
import { getEffectiveCwdError } from "./effective-cwd.ts";
import { publishTrustedSubagents } from "./registry.ts";

export interface FakeTrustedSubagentsOptions {
	/** Known agents and the mode each launches in; any other agent is `agent_not_found`. */
	agents: Readonly<Record<string, TrustedLaunchMode>>;
	/**
	 * Script the outcome of an accepted request (0-based across accepted
	 * requests). A throw becomes an `unknown` outcome, as in the real descriptor.
	 */
	respond?: (request: TrustedLaunchRequestV1, index: number) => TrustedLaunchResultV1;
	/**
	 * Script the outcome of a termination request that passed validation
	 * (0-based). Its result passes the same contract check as the real one.
	 */
	respondTerminate?: (request: TrustedTerminateRequestV1, index: number) => TrustedTerminateResultV1;
}

export interface FakeTrustedSubagents {
	readonly descriptor: TrustedSubagentsDescriptor;
	/** Every request that passed validation, in order. */
	readonly requests: readonly TrustedLaunchRequestV1[];
	/** Every resume request that passed validation, in order. */
	readonly resumeRequests: readonly TrustedResumeRequestV1[];
	/** Every termination request that passed validation, in order. */
	readonly terminateRequests: readonly TrustedTerminateRequestV1[];
	dispose(): void;
}

/**
 * A deterministic stand-in for downstream acceptance tests. It publishes
 * through the same registry and request validation as the real descriptor
 * and creates no process, session, or surface.
 */
export function createFakeTrustedSubagents(options: FakeTrustedSubagentsOptions): FakeTrustedSubagents {
	const requests: TrustedLaunchRequestV1[] = [];
	const resumeRequests: TrustedResumeRequestV1[] = [];
	const terminateRequests: TrustedTerminateRequestV1[] = [];
	/** Runs this fake started and their launch request; `ended` once terminated. */
	const runs = new Map<string, { sessionFile: string; launchRequestId: string; mode: TrustedLaunchMode; ended: boolean }>();
	const launchedSessions = new Map<string, { request: TrustedLaunchRequestV1; result: TrustedLaunchResultV1 & { outcome: "launched" } }>();
	let generation = "";
	const publication = publishTrustedSubagents({
		async launch(request) {
			const mode = Object.hasOwn(options.agents, request.agent) ? options.agents[request.agent] : undefined;
			if (!mode) return { outcome: "not_started", reason: "agent_not_found", message: `Unknown agent "${request.agent}".` };
			if (mode !== request.mode) {
				return {
					outcome: "not_started",
					reason: "mode_mismatch",
					message: `Agent "${request.agent}" launches ${mode} here, not ${request.mode}.`,
				};
			}
			requests.push(request);
			const index = requests.length - 1;
			const runId = `fake-run-${index + 1}`;
			const result: TrustedLaunchResultV1 = options.respond
				? options.respond(request, index)
				: {
						outcome: "launched",
						requestId: request.requestId,
						runId,
						sessionFile: `/fake-pi-subagents/sessions/${runId}.jsonl`,
						mode,
						...(mode === "interactive" ? { surfaceId: `fake-surface-${index + 1}` } : {}),
						effectiveCwd: request.effectiveCwd,
					};
			if (result.outcome === "launched") {
				launchedSessions.set(result.sessionFile, { request, result });
				runs.set(result.runId, {
					sessionFile: result.sessionFile,
					launchRequestId: request.requestId,
					mode: result.mode,
					ended: false,
				});
			}
			return result;
		},
		async resume(request) {
			// A session this fake launched resumes when the request names its launch
			// and directory; anything else is refused as the real descriptor refuses it.
			resumeRequests.push(request);
			const index = resumeRequests.length - 1;
			const launched = launchedSessions.get(request.sessionFile);
			if (!launched) {
				return { outcome: "not_started", reason: "session_not_found", message: "This fake launched no such session." };
			}
			if (launched.request.requestId !== request.launchRequestId) {
				return { outcome: "not_started", reason: "launch_request_mismatch", message: "The session was launched by another request." };
			}
			const cwdError = getEffectiveCwdError(launched.result.effectiveCwd);
			if (cwdError) return { outcome: "not_started", reason: cwdError, message: "The session's directory is no longer usable." };
			if (launched.result.effectiveCwd !== request.effectiveCwd) {
				return { outcome: "not_started", reason: "effective_cwd_mismatch", message: "The session runs in another directory." };
			}
			const { result } = launched;
			const runId = `fake-resume-${index + 1}`;
			runs.set(runId, {
				sessionFile: result.sessionFile,
				launchRequestId: launched.request.requestId,
				mode: result.mode,
				ended: false,
			});
			return {
				outcome: "resumed",
				requestId: request.requestId,
				runId,
				sessionFile: result.sessionFile,
				mode: result.mode,
				...(result.mode === "interactive" ? { surfaceId: `fake-resume-surface-${index + 1}` } : {}),
				effectiveCwd: result.effectiveCwd,
				launch: {
					version: TRUSTED_LAUNCH_VERSION,
					generation,
					requestId: launched.request.requestId,
					...(launched.request.labels ? { labels: launched.request.labels } : {}),
				},
			};
		},
		async terminate(request) {
			// Only a run this fake started, named by its exact identities, ends;
			// anything else is unknown, as the real descriptor reports it.
			terminateRequests.push(request);
			if (options.respondTerminate) return options.respondTerminate(request, terminateRequests.length - 1);
			const run = runs.get(request.runId);
			if (!run) {
				return { outcome: "unknown", reason: "ownership_unavailable", message: "This fake started no such run.", stopRequested: false };
			}
			if (run.sessionFile !== request.sessionFile || run.launchRequestId !== request.launchRequestId) {
				return {
					outcome: "unknown",
					reason: "identity_mismatch",
					message: "The run's session or launch does not match the request.",
					stopRequested: false,
				};
			}
			const wasEnded = run.ended;
			run.ended = true;
			if (run.mode === "interactive") {
				// No pane close proves a child ended, so the real descriptor never reports one.
				return {
					outcome: "unknown",
					reason: "termination_unconfirmed",
					message: "The run's surface was closed; a pane child's end cannot be proven.",
					stopRequested: !wasEnded,
				};
			}
			const outcome = wasEnded ? "already_terminal" : "terminated";
			return { outcome, requestId: request.requestId, runId: request.runId, sessionFile: request.sessionFile };
		},
	});
	generation = publication.descriptor.generation;
	return {
		descriptor: publication.descriptor,
		requests,
		resumeRequests,
		terminateRequests,
		dispose: () => publication.dispose(),
	};
}
