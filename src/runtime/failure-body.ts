import { OUTPUT_TAIL_LIMIT } from "../launch/output-tail.ts";
import type { SubagentResult } from "../types.ts";
import { hasRealSubagentOutput } from "./state.ts";

/**
 * The body under a subagent's error line, shared by steer delivery and
 * `subagent_wait` so both tell the parent the same thing.
 */
export function formatSubagentFailureBody(result: SubagentResult): string {
	if (hasRealSubagentOutput(result)) {
		return `Last output before the failure (may be incomplete — verify before trusting):\n\n${result.summary}`;
	}
	const noResult = result.contextExhausted
		? `The subagent did not produce a result, and its context window is spent. ` +
			`A fresh subagent is usually better than resuming this session.`
		: `The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with subagent_resume.`;
	const stderr = result.stderrTail?.trim();
	if (!stderr) return noResult;
	return `${noResult}\n\nChild stderr (last ${OUTPUT_TAIL_LIMIT} characters at most):\n${stderr}`;
}
