import type { TrustedLaunchMode, TrustedLaunchRequestV1, TrustedLaunchResultV1, TrustedSubagentsDescriptor } from "./contract.ts";
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
	dispose(): void;
}

/**
 * A deterministic stand-in for downstream acceptance tests. It publishes
 * through the same registry and request validation as the real descriptor
 * and creates no process, session, or surface.
 */
export function createFakeTrustedSubagents(options: FakeTrustedSubagentsOptions): FakeTrustedSubagents {
	const requests: TrustedLaunchRequestV1[] = [];
	const publication = publishTrustedSubagents(async (request) => {
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
		if (options.respond) return options.respond(request, index);
		const runId = `fake-run-${index + 1}`;
		return {
			outcome: "launched",
			requestId: request.requestId,
			runId,
			sessionFile: `/fake-pi-subagents/sessions/${runId}.jsonl`,
			mode,
			...(mode === "interactive" ? { surfaceId: `fake-surface-${index + 1}` } : {}),
			effectiveCwd: request.effectiveCwd,
		};
	});
	return { descriptor: publication.descriptor, requests, dispose: () => publication.dispose() };
}
