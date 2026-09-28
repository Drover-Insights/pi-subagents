import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const createdAgentDirs: string[] = [];

after(() => {
	for (const dir of createdAgentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp Pi agent directory, removed when the test run ends. */
export function emptyAgentDir(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-policy-"));
	createdAgentDirs.push(agentDir);
	return agentDir;
}

/** Mutable JSON shape of the canonical policy fixture; tests edit a fresh copy. */
// biome-ignore lint/suspicious/noExplicitAny: fixture documents are edited freely to build invalid variants.
export type PolicyDocument = Record<string, any>;

/**
 * A known-good schema v3 canonical routing policy, mirroring the generation
 * pi-config installs. Pilot case `scout-literal-1` authorizes one literal Scout
 * launch so acceptance paths have a live record to name.
 */
export function canonicalPolicyDocument(): PolicyDocument {
	return {
		schemaVersion: 3,
		generation: "test-generation-v1",
		schemaCompatibility: {
			controller: { minimum: 3, maximum: 3 },
			childRuntime: { minimum: 3, maximum: 3 },
		},
		defaultRole: "controller",
		canonicalRoles: ["controller", "scout", "worker", "reviewer", "frontier-critic", "frontier-engineer"],
		aliases: {
			finder: "scout",
			"implementation-worker": "worker",
			"pilot-scout": "scout",
			"pilot-worker": "worker",
			"pilot-reviewer": "reviewer",
			"pilot-frontier-critic": "frontier-critic",
			"pilot-frontier-engineer": "frontier-engineer",
			"pilot-controller": "controller",
		},
		operationalStates: ["disabled", "pilot", "selective", "automated"],
		capabilityClasses: {
			controller: {},
			literal: {},
			"code-graph": {},
			implementation: {},
			review: {},
			architecture: {},
			"frontier-engineering": {},
		},
		interactionModes: ["synchronous", "background", "interactive"],
		resourceGrants: {
			controller: { skills: ["*"], projectResources: true },
			"isolated-child": { skills: [], projectResources: false },
		},
		roles: {
			controller: {
				state: "automated",
				childLaunch: false,
				modes: ["controller"],
				allowedInteractionModes: [],
				resourceGrant: "controller",
				routes: { controller: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" } },
			},
			scout: {
				state: "pilot",
				childLaunch: true,
				modes: ["literal", "code-graph"],
				allowedInteractionModes: ["synchronous", "background"],
				resourceGrant: "isolated-child",
				routes: {
					literal: { provider: "openai-codex", model: "gpt-5.6-luna", effort: "low" },
					"code-graph": { provider: "openai-codex", model: "gpt-5.6-terra", effort: "low" },
				},
			},
			worker: {
				state: "selective",
				childLaunch: true,
				modes: ["implementation"],
				allowedInteractionModes: ["synchronous", "background"],
				resourceGrant: "isolated-child",
				routes: { implementation: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" } },
			},
			reviewer: {
				state: "automated",
				childLaunch: true,
				modes: ["review"],
				allowedInteractionModes: ["synchronous"],
				resourceGrant: "isolated-child",
				routes: { review: { provider: "claude-primary", model: "opus", effort: "medium" } },
			},
			"frontier-critic": {
				state: "disabled",
				childLaunch: false,
				modes: [],
				allowedInteractionModes: [],
				resourceGrant: "isolated-child",
				routes: {},
			},
			"frontier-engineer": {
				state: "disabled",
				childLaunch: false,
				modes: [],
				allowedInteractionModes: [],
				resourceGrant: "isolated-child",
				routes: {},
			},
		},
		pilotCases: {
			"scout-literal-1": {
				role: "scout",
				capabilityClass: "literal",
				artifact: "artifacts/scout-literal-1.md",
				route: { provider: "openai-codex", model: "gpt-5.6-luna", effort: "low" },
				resourceGrant: "isolated-child",
				attempts: { allowed: 1 },
				retry: "none",
				expires: "2999-01-01T00:00:00Z",
				acceptance: ["cites exact paths"],
			},
			"scout-code-graph-1": {
				role: "scout",
				capabilityClass: "code-graph",
				artifact: "artifacts/scout-code-graph-1.md",
				route: { provider: "openai-codex", model: "gpt-5.6-terra", effort: "low" },
				resourceGrant: "isolated-child",
				attempts: { allowed: 1 },
				retry: "none",
				expires: "2999-01-01T00:00:00Z",
				acceptance: ["traces the call path"],
			},
		},
		extensionCatalog: {
			"subagent-completion": {
				source: "git:github.com/Drover-Insights/pi-subagents@04ce06169928d1af9b83c3de4ded2c6bb2e271c1",
				files: [
					{
						path: "src/tools/subagent-done.ts",
						sha256: "7dafab8303209e430bd95bc9a45a66b0063ec5f41e3eba724909887bb0852b5a",
					},
				],
			},
			"workspace-boundary": {
				source: "pi-config",
				files: [{ path: "extensions/workspace-boundary/index.ts", sha256: "a".repeat(64) }],
			},
			"drover-model-routing": {
				source: "pi-config",
				files: [
					{ path: "extensions/drover-model-routing/index.ts", sha256: "b".repeat(64) },
					{ path: "extensions/drover-model-routing/policy.ts", sha256: "c".repeat(64) },
				],
			},
		},
		mandatoryExtensions: ["subagent-completion", "workspace-boundary"],
		extensionGrants: {
			scout: ["drover-model-routing"],
			worker: ["drover-model-routing"],
			reviewer: ["drover-model-routing"],
			"frontier-critic": ["drover-model-routing"],
			"frontier-engineer": ["drover-model-routing"],
		},
		guardrails: {
			allowProviderFallback: false,
			allowRouteNormalization: false,
			allowRecursiveSpawning: false,
			allowMaxEffort: false,
			allowInteractiveLaunch: false,
		},
	};
}

/** Create a temp Pi agent directory holding `document` as its canonical policy. */
export function writeCanonicalPolicy(document: PolicyDocument | string = canonicalPolicyDocument()): string {
	const agentDir = emptyAgentDir();
	writeFileSync(
		join(agentDir, "drover-model-routing.json"),
		typeof document === "string" ? document : JSON.stringify(document, null, 2),
	);
	return agentDir;
}
