import { appendFileSync } from "node:fs";
import { buildBackgroundLaunchPlan } from "../../src/launch/background.ts";
import { loadCanonicalPolicy } from "../../src/routing/canonical-policy.ts";
import { authorizeLaunch } from "../../src/routing/launch-authorization.ts";
import type { PolicyLaunch, SubagentParamsInput } from "../../src/types.ts";
import {
	assert,
	beforeEach,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	SESSION_HEADER,
	writeFileSync,
} from "../support/index.ts";
import { COMPLETION_HELPER_PATH, emptyAgentDir, writeCanonicalPolicy } from "../support/routing-policy.ts";

let agentDir: string;

function writeDefinition(dir: string, frontmatter: string[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "pilot-worker.md"),
		["---", "name: pilot-worker", "mode: background", ...frontmatter, "---", "Worker body."].join("\n"),
	);
}

/** The launch the canonical fixture policy authorizes for a selective Worker. */
function authorizedLaunch(): PolicyLaunch {
	const authorization = authorizeLaunch({
		policyState: loadCanonicalPolicy(agentDir),
		agent: "pilot-worker",
		capabilityClass: "implementation",
		interactionMode: "background",
		agentDefs: null,
		now: Date.now(),
		agentDir,
	});
	assert.equal(authorization.status, "authorized");
	return (authorization as { launch: PolicyLaunch }).launch;
}

function managedLaunch(
	options: {
		global?: string[] | null;
		project?: string[];
		caller?: Partial<SubagentParamsInput>;
		afterAuthorize?: () => void;
	} = {},
) {
	const cwd = createTestDir();
	if (options.global !== null) writeDefinition(join(agentDir, "agents"), options.global ?? []);
	if (options.project) writeDefinition(join(cwd, ".pi", "agents"), options.project);
	const parentSession = join(cwd, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const params: SubagentParamsInput = {
		name: "slice-worker",
		title: "Slice worker",
		task: "Implement the slice",
		agent: "pilot-worker",
		...options.caller,
		policyLaunch: authorizedLaunch(),
	};
	options.afterAuthorize?.();
	return buildBackgroundLaunchPlan(params, {
		cwd,
		sessionManager: {
			getSessionFile: () => parentSession,
			getSessionId: () => "parent-session-id",
		},
		modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6-sol", reasoning: true }] },
	} as never);
}

const RESOURCE_FLAGS = new Set([
	"-e",
	"--extension",
	"--no-extensions",
	"--skill",
	"--no-skills",
	"--prompt-template",
	"--no-prompt-templates",
	"--theme",
	"--no-themes",
	"--no-context-files",
	"--approve",
	"-a",
	"--no-approve",
]);

/** Every resource-loading flag in argv order, with the value each `-e` loads. */
function resourceArgs(args: string[]): string[] {
	return args.flatMap((arg, index) =>
		RESOURCE_FLAGS.has(arg) ? (arg === "-e" || arg === "--skill" ? [arg, args[index + 1]] : [arg]) : [],
	);
}

const EXPECTED_RESOURCES = () => [
	"--no-extensions",
	"-e",
	COMPLETION_HELPER_PATH,
	"-e",
	join(agentDir, "extensions/workspace-boundary/index.ts"),
	"-e",
	join(agentDir, "extensions/drover-model-routing/index.ts"),
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-approve",
];

describe("policy-managed child launch", () => {
	beforeEach(() => {
		agentDir = writeCanonicalPolicy();
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	it("loads exactly the verified inventory with every discovery path disabled", async () => {
		const plan = await managedLaunch({
			global: [
				"extensions: all",
				"skills: all",
				"inject-skills: review",
				"trust-project: true",
				"no-context-files: false",
				"model: provider/frontmatter-model",
				"thinking: high",
			],
			caller: { skills: "all", injectSkills: "review" },
		});

		assert.deepEqual(resourceArgs(plan.args), EXPECTED_RESOURCES());
		assert.deepEqual(
			plan.args.flatMap((arg, index) => (arg === "--model" ? [plan.args[index + 1]] : [])),
			["openai-codex/gpt-6-sol:medium"],
		);
	});

	it("re-verifies the inventory before building the child argv", async () => {
		appendFileSync(join(agentDir, "extensions/drover-model-routing/index.ts"), "// drift\n");

		await assert.rejects(() => managedLaunch(), /drover-model-routing.*sha256/);
	});

	it("reads a managed definition only from the global agent directory", async () => {
		const plan = await managedLaunch({ global: [], project: ["flags: --approve", "extensions: all", "env: X=1"] });

		assert.deepEqual(resourceArgs(plan.args), EXPECTED_RESOURCES());
	});

	it("refuses a managed launch whose child would read another agent directory", async () => {
		mkdirSync(join(agentDir, ".pi", "agent"), { recursive: true });

		await assert.rejects(() => managedLaunch(), /pilot-worker.*agent directory/);
	});

	it("reads only the global definition even when the policy is unreadable at launch time", async () => {
		const plan = await managedLaunch({
			global: [],
			project: ["inherit-append-system: true", "tools: bash"],
			afterAuthorize: () => writeFileSync(join(agentDir, "drover-model-routing.json"), "{ mid-rewrite"),
		});

		assert.deepEqual(
			{ tools: plan.launch.launchMetadata.tools, inherit: plan.launch.launchMetadata.inheritAppendSystem },
			{ tools: undefined, inherit: false },
		);
	});

	it("keeps a caller Skill field out of discovery and launch metadata", async () => {
		const plan = await managedLaunch({ caller: { skills: "all" } });

		assert.equal(plan.launch.launchMetadata.skills, "none");
	});

	it("refuses a managed agent defined only in the project", async () => {
		await assert.rejects(() => managedLaunch({ global: null, project: [] }), /pilot-worker.*definition/);
	});

	it("refuses a managed definition that gained forbidden launch fields after authorization", async () => {
		const forbidden: [string, RegExp][] = [
			["flags: --model openai-codex/gpt-6-astra", /pilot-worker.*flags/],
			["spawning: true", /pilot-worker.*spawning/],
			["task-expansion: shell", /pilot-worker.*task expansion/],
			["env: PI_CODING_AGENT_DIR=/elsewhere", /pilot-worker.*env/],
			["cwd: /elsewhere", /pilot-worker.*cwd/],
		];
		for (const [field, message] of forbidden) {
			await assert.rejects(() => managedLaunch({ global: [field] }), message);
		}
	});

	it("refuses a managed launch whose definition can no longer be read", async () => {
		const launch = authorizedLaunch();
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir();
		const cwd = createTestDir();
		await assert.rejects(
			() =>
				buildBackgroundLaunchPlan(
					{ name: "slice-worker", title: "Slice worker", task: "t", agent: "pilot-worker", policyLaunch: launch },
					{ cwd, sessionManager: { getSessionFile: () => null, getSessionId: () => "p" } } as never,
				),
			/pilot-worker.*definition/,
		);
	});
});
