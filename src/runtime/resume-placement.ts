import { parseEnvString } from "../launch/env.ts";
import { resolveHerdrPlacementPolicy, resolveZellijPlacementPolicy } from "../mux.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";

/**
 * Where a resumed pane child is placed: the agent's own env setting, then
 * the parent's, then what the launch recorded.
 */
export function resolveResumeHerdrPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveHerdrPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_HERDR_PLACEMENT;
	if (agentPolicy !== undefined) return resolveHerdrPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveHerdrPlacementPolicy(parentPolicy);
	return launchMetadata?.herdrPlacementPolicy;
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_ZELLIJ_PLACEMENT;
	if (agentPolicy !== undefined) return resolveZellijPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveZellijPlacementPolicy(parentPolicy);
	return launchMetadata?.zellijPlacementPolicy;
}
