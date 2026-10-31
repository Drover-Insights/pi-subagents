import { buildParentEnvSnapshot, resolveDenyEnvPatterns } from "../../src/launch/child-env.ts";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { getSubagentChildProcessEnv } from "../../src/launch/child-command.ts";
import { getBaseSubagentEnvVars, type PreparedSubagentLaunch } from "../../src/launch/prep.ts";
import { resolveSubagentRuntimePaths } from "../../src/launch/runtime-paths.ts";
import { getSkillVisibilitySpec } from "../../src/launch/skill-visibility.ts";
import { assert, createTestDir, describe, it, join, mkdirSync } from "../support/index.ts";

/**
 * Characterizes how a fresh launch chooses the child's PI_CODING_AGENT_DIR:
 * the launch's agent-config directory (profile) wins, then a non-empty parent
 * value, then whatever `launchEnv` or an empty frontmatter `env` value already
 * set. A non-empty frontmatter `PI_CODING_AGENT_DIR` is not an override: it
 * becomes the profile itself, so the non-empty override cases use `launchEnv`.
 * Every value here is synthetic.
 */

const PARENT_DIR = "/synthetic/parent-agent";
const OVERRIDE_DIR = "/synthetic/override-agent";

interface FreshCase {
	profile?: boolean;
	parent?: string;
	frontmatterEnv?: string;
	launchEnv?: Record<string, string>;
	denyEnv?: string;
}

function freshLaunch(input: FreshCase): { overrides: Record<string, string>; profileDir: string; parentCwd: string } {
	const parentCwd = createTestDir();
	const profileDir = join(parentCwd, ".pi", "agent");
	if (input.profile) mkdirSync(profileDir, { recursive: true });
	if (input.parent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = input.parent;
	const agentDefs: AgentDefaults = {
		...(input.frontmatterEnv !== undefined ? { env: input.frontmatterEnv } : {}),
		...(input.denyEnv ? { denyEnv: input.denyEnv } : {}),
	};
	const runtimePaths = resolveSubagentRuntimePaths({}, agentDefs, parentCwd, join(parentCwd, "parent-sessions"));
	const overrides = getBaseSubagentEnvVars(
		{
			agentDefs,
			denySet: new Set<string>(),
			runtimePaths,
			subagentSessionFile: join(parentCwd, "child.jsonl"),
			sessionFile: join(parentCwd, "parent.jsonl"),
			skillLaunchPlan: { visibilitySpec: getSkillVisibilitySpec(agentDefs.skills) },
		} as PreparedSubagentLaunch,
		{
			agent: "tester",
			name: "child",
			title: "Child task",
			task: "Task",
			...(input.launchEnv ? { launchEnv: input.launchEnv } : {}),
		},
		() => "lineage-only",
	);
	return { overrides, profileDir, parentCwd };
}

/** Names the merge keeps from the ambient env; the rest is removed so no live env is captured. */
const MERGE_KEEP = new Set(["PI_CODING_AGENT_DIR"]);

/** Runs the background child-env merge the launcher uses over a synthetic parent env. */
function childProcessEnv(overrides: Record<string, string>, denyEnv: string | undefined, envDeny?: string) {
	const ambient = { ...process.env };
	for (const key of Object.keys(process.env)) if (!MERGE_KEEP.has(key)) delete process.env[key];
	process.env.AGENT_DIR_TEST_UNRELATED = "kept";
	if (envDeny !== undefined) process.env.PI_SUBAGENT_ENV_DENY = envDeny;
	try {
		const patterns = resolveDenyEnvPatterns(denyEnv);
		const snapshot = buildParentEnvSnapshot(process.env, patterns);
		const env = getSubagentChildProcessEnv({ command: "pi", args: [] }, overrides, patterns);
		return { snapshotHasAgentDir: Object.hasOwn(snapshot, "PI_CODING_AGENT_DIR"), env };
	} finally {
		for (const key of Object.keys(process.env)) if (!Object.hasOwn(ambient, key)) delete process.env[key];
		for (const [key, value] of Object.entries(ambient)) if (value !== undefined) process.env[key] = value;
	}
}

describe("fresh launch PI_CODING_AGENT_DIR selection", () => {
	it("uses the launch's agent-config directory over the parent value and any override", () => {
		const { overrides, profileDir } = freshLaunch({
			profile: true,
			parent: PARENT_DIR,
			launchEnv: { PI_CODING_AGENT_DIR: OVERRIDE_DIR },
		});
		assert.equal(overrides.PI_CODING_AGENT_DIR, profileDir);
	});

	it("treats a non-empty frontmatter value as the profile, over the parent value", () => {
		const frontmatterDir = createTestDir();
		const { overrides } = freshLaunch({ parent: PARENT_DIR, frontmatterEnv: `PI_CODING_AGENT_DIR=${frontmatterDir}` });
		assert.equal(overrides.PI_CODING_AGENT_DIR, frontmatterDir);
	});

	it("copies a non-empty parent value when no profile is set", () => {
		const { overrides } = freshLaunch({ parent: PARENT_DIR });
		assert.equal(overrides.PI_CODING_AGENT_DIR, PARENT_DIR);
	});

	it("lets the parent copy replace a launchEnv override when no profile is set", () => {
		const { overrides } = freshLaunch({ parent: PARENT_DIR, launchEnv: { PI_CODING_AGENT_DIR: OVERRIDE_DIR } });
		assert.equal(overrides.PI_CODING_AGENT_DIR, PARENT_DIR);
	});

	it("keeps a launchEnv override when neither profile nor parent is set", () => {
		const { overrides } = freshLaunch({ launchEnv: { PI_CODING_AGENT_DIR: OVERRIDE_DIR } });
		assert.equal(overrides.PI_CODING_AGENT_DIR, OVERRIDE_DIR);
	});

	it("keeps an empty frontmatter override, which is not a profile, when the parent is unset", () => {
		const { overrides } = freshLaunch({ frontmatterEnv: "PI_CODING_AGENT_DIR=" });
		assert.equal(overrides.PI_CODING_AGENT_DIR, "");
	});

	it("treats an empty parent value as unset and keeps the override", () => {
		const { overrides } = freshLaunch({ parent: "", launchEnv: { PI_CODING_AGENT_DIR: OVERRIDE_DIR } });
		assert.equal(overrides.PI_CODING_AGENT_DIR, OVERRIDE_DIR);
	});

	it("leaves the name absent when nothing sets it", () => {
		const { overrides } = freshLaunch({});
		assert.equal(Object.hasOwn(overrides, "PI_CODING_AGENT_DIR"), false);
	});

	it("still copies a parent value that deny-env removes from the inherited snapshot", () => {
		const denyEnv = "PI_CODING_*";
		const { overrides } = freshLaunch({ parent: PARENT_DIR, denyEnv });
		const { snapshotHasAgentDir, env } = childProcessEnv(overrides, denyEnv);
		assert.equal(snapshotHasAgentDir, false, "deny-env filters the inherited snapshot");
		assert.equal(env.AGENT_DIR_TEST_UNRELATED, "kept", "unrelated names still flow");
		assert.equal(env.PI_CODING_AGENT_DIR, PARENT_DIR, "the override copy ignores deny-env");
	});

	it("still copies a parent value that PI_SUBAGENT_ENV_DENY removes from the inherited snapshot", () => {
		const { overrides } = freshLaunch({ parent: PARENT_DIR });
		const { snapshotHasAgentDir, env } = childProcessEnv(overrides, undefined, "PI_CODING_AGENT_DIR");
		assert.equal(snapshotHasAgentDir, false);
		assert.equal(env.PI_CODING_AGENT_DIR, PARENT_DIR);
	});
});
