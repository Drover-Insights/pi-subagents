/**
 * The parent's checks that a managed child's tools can run in the
 * credential-blind sandbox at all, run before any child exists. The child
 * plans every tool call's sandbox again with the same protected paths, so a
 * check that passes here and later fails makes that call fail closed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { type BrokerMode, buildSandboxPlan, type SandboxPlanInput } from "./sandbox-plan.ts";
import { probeSandbox, type SandboxProbe } from "./sandbox-run.ts";

/** Tools that write files; any one of them, `all`, or Pi's default tool set makes a writer. */
const WRITING_TOOLS = new Set(["edit", "write"]);

/** Read the allowlist as Pi's tool policy does: `all` and no list mean every tool, `none` means none. */
export function brokerModeForTools(tools: string | null | undefined): BrokerMode {
	const normalized = (tools ?? "").trim().toLowerCase();
	if (normalized === "" || normalized === "all") return "writer";
	if (normalized === "none") return "read-only";
	return normalized.split(",").some((name) => WRITING_TOOLS.has(name.trim())) ? "writer" : "read-only";
}

/** Credential and agent-state directories under home that no sandbox root may touch. */
const HOME_CREDENTIAL_DIRS = [
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	".config",
	".local/share",
	".password-store",
	".mozilla",
	".claude",
	".codex",
];

/**
 * Home may hold a repository but never be inside a sandbox root. Pi's agent
 * directory (auth, sessions, managed state), artifact storage, the per-user
 * runtime directory (control sockets) and credential directories may neither
 * hold nor sit inside one.
 */
export function protectedBrokerPaths(): Pick<SandboxPlanInput, "protectedPaths" | "protectedAncestors"> {
	const home = homedir();
	const protectedPaths = [
		getAgentConfigDir(),
		getArtifactStorageRoot(),
		...HOME_CREDENTIAL_DIRS.map((dir) => join(home, dir)),
	];
	if (process.env.XDG_RUNTIME_DIR) protectedPaths.push(process.env.XDG_RUNTIME_DIR);
	return { protectedPaths, protectedAncestors: [home] };
}

/** Null when tools can run sandboxed in `cwd`; otherwise why they cannot. */
export function checkToolBroker(
	cwd: string,
	mode: BrokerMode,
	probe: () => SandboxProbe = probeSandbox,
): string | null {
	const plan = buildSandboxPlan({ mode, cwd, ...protectedBrokerPaths() });
	if (plan.status === "rejected") return plan.message;
	const result = probe();
	return result.status === "unavailable" ? result.message : null;
}
