/**
 * How the trusted parent tells a child to broker its tools. The parent sets
 * the variable for every managed child and clears it for every other child,
 * so an ambient value never reaches a child the parent did not configure. A
 * managed definition cannot set env, so only the parent writes it. A writer's
 * config pins the worktree identity its sandboxes are planned from.
 */
import { isAbsolute } from "node:path";
import type { BrokerMode } from "./sandbox-plan.ts";

export const TOOL_BROKER_ENV = "PI_SUBAGENT_TOOL_BROKER";

const VERSION = 2;

/** The worktree a writer's sandboxes may use, as the parent validated it. */
export type PinnedWorktree = { top: string; commonDir: string; worktreeGitDir: string; branch: string };

/**
 * A writer's pinned worktree, with its lease's containment key and its
 * execution generation. `launchId` carries the containment key, an opaque
 * value the child only uses to name its containment directory; it is not the
 * launch's tool call or request id.
 */
export type WriterIdentity = PinnedWorktree & { launchId: string; generation: number };

export type ToolBrokerConfig =
	| { status: "absent" }
	| { status: "brokered"; mode: "read-only" }
	| { status: "brokered"; mode: "writer"; identity: WriterIdentity }
	| { status: "malformed" };

const IDENTITY_KEYS = ["branch", "commonDir", "generation", "launchId", "top", "worktreeGitDir"].join();

/**
 * The env override for a child: its broker config when managed, empty
 * otherwise. A writer must carry its identity and a read-only child none.
 */
export function toolBrokerEnv(
	policyLaunch: { toolBroker: Readonly<{ mode: BrokerMode }> } | undefined,
	identity?: WriterIdentity,
): Record<string, string> {
	if (!policyLaunch) return { [TOOL_BROKER_ENV]: "" };
	const { mode } = policyLaunch.toolBroker;
	if (mode === "writer" && !identity) throw new Error("a managed writer needs its pinned worktree identity");
	if (mode === "read-only" && identity) throw new Error("a read-only child takes no worktree identity");
	return { [TOOL_BROKER_ENV]: JSON.stringify({ version: VERSION, mode, ...(identity ? { identity } : {}) }) };
}

function readIdentity(value: unknown): WriterIdentity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join() !== IDENTITY_KEYS) return undefined;
	for (const key of ["top", "commonDir", "worktreeGitDir"] as const) {
		const path = record[key];
		if (typeof path !== "string" || !isAbsolute(path)) return undefined;
	}
	for (const key of ["branch", "launchId"] as const) {
		if (typeof record[key] !== "string" || record[key] === "") return undefined;
	}
	if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return undefined;
	return record as WriterIdentity;
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
	if (record.version !== VERSION) return { status: "malformed" };
	const keys = Object.keys(record).sort().join();
	if (record.mode === "read-only" && keys === "mode,version") return { status: "brokered", mode: "read-only" };
	if (record.mode !== "writer" || keys !== "identity,mode,version") return { status: "malformed" };
	const identity = readIdentity(record.identity);
	return identity ? { status: "brokered", mode: "writer", identity } : { status: "malformed" };
}
