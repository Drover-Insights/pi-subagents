import type { AgentDefaults } from "../agents/definitions.ts";
import {
	type RoutingPolicyResult,
	resolveRoutingPolicy,
} from "../routing/policy.ts";
import type { SubagentParamsInput } from "../types.ts";

export type ResolvedSubagentRoute = {
	model: string;
	thinking: string;
};

function isRoutingEnabledAgent(agent: string): boolean {
	return (
		agent === "pilot-scout" ||
		agent === "pilot-worker" ||
		agent === "pilot-reviewer" ||
		agent === "pilot-frontier-critic" ||
		agent === "pilot-frontier-engineer" ||
		agent === "pilot-controller"
	);
}

export function resolveSubagentRouting(
	dispatchId: string,
	child: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
): RoutingPolicyResult | null {
	if (!isRoutingEnabledAgent(child.agent)) return null;
	return resolveRoutingPolicy({
		dispatchId,
		agent: child.agent,
		mode:
			(child.background ?? agentDefs?.mode === "background")
				? "background"
				: "interactive",
		capabilityClass: child.capabilityClass,
		escalationReason: child.escalationReason,
		risk: child.risk,
		...(child.model !== undefined ? { model: child.model } : {}),
		...(child.thinking !== undefined ? { thinking: child.thinking } : {}),
	});
}
