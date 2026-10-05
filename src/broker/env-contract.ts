/**
 * How the trusted parent tells a child to broker its tools. The parent sets
 * the variable for every managed child and clears it for every other child,
 * so an ambient value never reaches a child the parent did not configure. A
 * managed definition cannot set env, so only the parent writes it.
 */
import type { BrokerMode } from "./sandbox-plan.ts";

export const TOOL_BROKER_ENV = "PI_SUBAGENT_TOOL_BROKER";

const VERSION = 1;

export type ToolBrokerConfig = { status: "absent" } | { status: "brokered"; mode: BrokerMode } | { status: "malformed" };

/** The env override for a child: its broker config when managed, empty otherwise. */
export function toolBrokerEnv(
	policyLaunch: { toolBroker: Readonly<{ mode: BrokerMode }> } | undefined,
): Record<string, string> {
	return {
		[TOOL_BROKER_ENV]: policyLaunch ? JSON.stringify({ version: VERSION, mode: policyLaunch.toolBroker.mode }) : "",
	};
}

/** Read the config the parent set. Anything but an exact known shape is malformed. */
export function readToolBrokerConfig(env: Record<string, string | undefined> = process.env): ToolBrokerConfig {
	const raw = env[TOOL_BROKER_ENV];
	if (!raw) return { status: "absent" };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { status: "malformed" };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "malformed" };
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join() !== "mode,version" || record.version !== VERSION) return { status: "malformed" };
	if (record.mode !== "read-only" && record.mode !== "writer") return { status: "malformed" };
	return { status: "brokered", mode: record.mode };
}
