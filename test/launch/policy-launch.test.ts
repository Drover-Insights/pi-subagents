import { buildBackgroundLaunchPlan } from "../../src/launch/background.ts";
import type { SubagentParamsInput } from "../../src/types.ts";
import { assert, createTestDir, describe, it, join, mkdirSync, SESSION_HEADER, writeFileSync } from "../support/index.ts";
import { emptyAgentDir } from "../support/routing-policy.ts";

const POLICY_LAUNCH = {
	model: "openai-codex/gpt-6-sol",
	thinking: "medium",
	extensions: ["/agent/extensions/workspace-boundary/index.ts", "/agent/extensions/drover-model-routing/index.ts"],
	skills: "none",
	noContextFiles: true,
};

function managedLaunch(frontmatter: string[] | null) {
	const cwd = createTestDir();
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	if (frontmatter) {
		writeFileSync(
			join(cwd, ".pi", "agents", "pilot-worker.md"),
			["---", "name: pilot-worker", "mode: background", ...frontmatter, "---", "Worker body."].join("\n"),
		);
	}
	const parentSession = join(cwd, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const params: SubagentParamsInput = {
		name: "slice-worker",
		title: "Slice worker",
		task: "Implement the slice",
		agent: "pilot-worker",
		policyLaunch: POLICY_LAUNCH,
	};
	return buildBackgroundLaunchPlan(params, {
		cwd,
		sessionManager: {
			getSessionFile: () => parentSession,
			getSessionId: () => "parent-session-id",
		},
		modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6-sol", reasoning: true }] },
	} as never);
}

function values(args: string[], flag: string): string[] {
	return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}

describe("policy-managed child launch", () => {
	it("replaces ambient resources with the policy launch in the real child argv", async () => {
		const plan = await managedLaunch([
			"extensions: all",
			"skills: all",
			"model: provider/frontmatter-model",
			"thinking: high",
		]);

		const extensions = values(plan.args, "-e");
		assert.deepEqual(
			{
				noExtensions: plan.args.includes("--no-extensions"),
				policyExtensions: extensions.slice(1),
				completionHelper: /subagent-done\.ts$/.test(extensions[0] ?? ""),
				model: values(plan.args, "--model"),
				noContextFiles: plan.args.includes("--no-context-files"),
				noSkills: plan.args.includes("--no-skills"),
			},
			{
				noExtensions: true,
				policyExtensions: POLICY_LAUNCH.extensions,
				completionHelper: true,
				model: ["openai-codex/gpt-6-sol:medium"],
				noContextFiles: true,
				noSkills: true,
			},
		);
	});

	it("refuses a managed definition that gained forbidden launch fields after authorization", async () => {
		await assert.rejects(() => managedLaunch(["flags: --model openai-codex/gpt-6-astra"]), /pilot-worker.*flags/);
		await assert.rejects(() => managedLaunch(["spawning: true"]), /pilot-worker.*spawning/);
		await assert.rejects(() => managedLaunch(["task-expansion: shell"]), /pilot-worker.*task expansion/);
		await assert.rejects(() => managedLaunch(["env: PI_CODING_AGENT_DIR=/elsewhere"]), /pilot-worker.*env/);
		await assert.rejects(() => managedLaunch(["cwd: /elsewhere"]), /pilot-worker.*cwd/);
	});

	it("refuses a managed launch whose definition can no longer be read", async () => {
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
		await assert.rejects(() => managedLaunch(null), /pilot-worker.*definition/);
	});
});
