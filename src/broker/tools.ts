/**
 * Installs the credential-blind tool broker in a policy-managed child. Every
 * model-directed built-in tool is overridden by Pi's own definition with
 * operations that run in a bubblewrap sandbox, never in the child process.
 * A malformed broker config disables the tools instead of falling back.
 */
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readToolBrokerConfig } from "./env-contract.ts";
import { createBrokeredGrepDefinition } from "./grep-tool.ts";
import type { BrokerMode } from "./sandbox-plan.ts";
import {
	type BrokerScope,
	bashOperations,
	editOperations,
	findOperations,
	lsOperations,
	readOperations,
	writeOperations,
} from "./tool-operations.ts";

export const BROKERED_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Appended to every override's description; also how the guard recognizes an override. */
export const BROKERED_DESCRIPTION_SUFFIX = " Runs in a credential-blind sandbox.";

// biome-ignore lint/suspicious/noExplicitAny: definitions differ in parameter and detail types.
type AnyToolDefinition = ToolDefinition<any, any, any>;
type Execute = AnyToolDefinition["execute"];

const BASE_DEFINITIONS: Record<string, (cwd: string) => AnyToolDefinition> = {
	read: (cwd) => createReadToolDefinition(cwd),
	bash: (cwd) => createBashToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
	grep: (cwd) => createGrepToolDefinition(cwd),
	find: (cwd) => createFindToolDefinition(cwd),
	ls: (cwd) => createLsToolDefinition(cwd),
};

/**
 * Pi's definition for `name` with sandboxed operations. File operations plan
 * their sandbox for the tool call's working directory, so the definition is
 * built per call for `ctx.cwd`.
 */
function perCallDefinition(mode: BrokerMode, name: string): (cwd: string, scope: BrokerScope) => AnyToolDefinition {
	switch (name) {
		case "read":
			return (cwd, scope) => createReadToolDefinition(cwd, { operations: readOperations(scope, cwd) });
		case "edit":
			return (cwd, scope) => createEditToolDefinition(cwd, { operations: editOperations(scope, cwd) });
		case "write":
			return (cwd, scope) => createWriteToolDefinition(cwd, { operations: writeOperations(scope, cwd) });
		case "find":
			return (cwd, scope) => createFindToolDefinition(cwd, { operations: findOperations(scope, cwd) });
		case "ls":
			return (cwd, scope) => createLsToolDefinition(cwd, { operations: lsOperations(scope, cwd) });
		case "bash":
			return (cwd, scope) =>
				createBashToolDefinition(cwd, { operations: bashOperations(scope), exposeSessionEnvironment: false });
		default:
			return () => createBrokeredGrepDefinition(mode);
	}
}

function brokeredTool(mode: BrokerMode, name: string): AnyToolDefinition {
	const build = perCallDefinition(mode, name);
	const base = build(process.cwd(), { mode });
	// The call's abort signal reaches every sandbox the operations start.
	const execute: Execute = (toolCallId, params, signal, onUpdate, ctx) =>
		build(ctx?.cwd || process.cwd(), { mode, ...(signal ? { signal } : {}) }).execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			ctx,
		);
	const tool: AnyToolDefinition = { ...base, description: base.description + BROKERED_DESCRIPTION_SUFFIX, execute };
	// Pi's edit preview reads the target file in this process; the default rendering reads nothing.
	if (name === "edit") delete tool.renderCall;
	return tool;
}

function disabledTool(name: string): AnyToolDefinition {
	const base = (BASE_DEFINITIONS[name] as (cwd: string) => AnyToolDefinition)(process.cwd());
	const execute: Execute = async () => {
		throw new Error("The tool broker configuration is malformed; tools are disabled.");
	};
	return { ...base, execute };
}

/** Pi built-ins with no broker; the guard keeps them inactive. */
const UNBROKERED_BUILTIN_NAMES = ["powershell"];

/** Deactivates any built-in-named tool that is not this broker's override. */
function deactivateUnbrokered(pi: ExtensionAPI): void {
	const names = new Set([...BROKERED_TOOL_NAMES, ...UNBROKERED_BUILTIN_NAMES]);
	const unbrokered = new Set(
		pi
			.getAllTools()
			.filter(
				(tool) =>
					names.has(tool.name) &&
					(!tool.description.endsWith(BROKERED_DESCRIPTION_SUFFIX) || tool.sourceInfo?.source === "builtin"),
			)
			.map((tool) => tool.name),
	);
	if (unbrokered.size === 0) return;
	const active = pi.getActiveTools();
	const kept = active.filter((name) => !unbrokered.has(name));
	if (kept.length !== active.length) pi.setActiveTools(kept);
}

export function installToolBroker(pi: ExtensionAPI, env: Record<string, string | undefined> = process.env): void {
	const config = readToolBrokerConfig(env);
	if (config.status === "absent") return;
	for (const name of BROKERED_TOOL_NAMES) {
		pi.registerTool(config.status === "malformed" ? disabledTool(name) : brokeredTool(config.mode, name));
	}
	const guard = () => {
		deactivateUnbrokered(pi);
		return undefined;
	};
	pi.on("session_start", guard);
	pi.on("before_agent_start", guard);
}
