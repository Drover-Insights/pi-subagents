import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchMode,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
	type TrustedResumeRequestV1,
	type TrustedSubagentsDescriptor,
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
}

export interface FakeTrustedSubagents {
	readonly descriptor: TrustedSubagentsDescriptor;
	/** Every request that passed validation, in order. */
	readonly requests: readonly TrustedLaunchRequestV1[];
	/** Every resume request that passed validation, in order. */
	readonly resumeRequests: readonly TrustedResumeRequestV1[];
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
			if (result.outcome === "launched") launchedSessions.set(result.sessionFile, { request, result });
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
			return {
				outcome: "resumed",
				requestId: request.requestId,
				runId: `fake-resume-${index + 1}`,
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
	});
	generation = publication.descriptor.generation;
	return {
		descriptor: publication.descriptor,
		requests,
		resumeRequests,
		dispose: () => publication.dispose(),
	};
}
