import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBackgroundLaunchPlan } from "../../src/launch/background.ts";
import { loadCanonicalPolicy } from "../../src/routing/canonical-policy.ts";
import { authorizeLaunch } from "../../src/routing/launch-authorization.ts";
import type { PolicyLaunch } from "../../src/types.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	SESSION_HEADER,
	writeFileSync,
} from "../support/index.ts";
import { canonicalPolicyDocument, writeCanonicalPolicy } from "../support/routing-policy.ts";

/**
 * Runs the real `pi` binary this package pins, with the argv the production
 * launcher builds for a managed child, against an agent directory and project
 * that plant every ambient resource Pi can discover. Probe extensions record
 * what Pi loaded and exit before any model request. Print mode exposes no
 * theme list to extensions, so theme suppression is proven only by the argv
 * tests in policy-launch.test.ts.
 */

const PI_CLI = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);

const WORKSPACE_BOUNDARY_PROBE = `import { appendFileSync } from "node:fs";
export default function () {
	appendFileSync(process.env.PROBE_LOG!, "load workspace-boundary\\n");
}
`;

const ROUTE_GUARD_PROBE = `import { appendFileSync, writeFileSync } from "node:fs";
export default function (pi: any) {
	appendFileSync(process.env.PROBE_LOG!, "load drover-model-routing\\n");
	pi.on("before_agent_start", (event: any) => {
		const options = event.systemPromptOptions;
		writeFileSync(process.env.PROBE_REPORT!, JSON.stringify({
			contextFiles: (options.contextFiles ?? []).map((file: any) => file.path),
			skills: (options.skills ?? []).map((skill: any) => skill.name),
			systemPrompt: event.systemPrompt,
			commands: pi.getCommands().map((command: any) => command.name),
			tools: pi.getAllTools().map((tool: any) => tool.name),
		}));
		process.exit(0);
	});
}
`;

const ROUTE_GUARD_POLICY = "export const probePolicy = true;\n";

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function ambientExtension(name: string): string {
	return `import { appendFileSync } from "node:fs";\nexport default function () {\n\tappendFileSync(process.env.PROBE_LOG!, "ambient ${name}\\n");\n}\n`;
}

function skill(name: string): string {
	return `---\nname: ${name}\ndescription: Ambient Skill ${name} that a managed child must not see.\n---\nAmbient body.\n`;
}

/** Plant every ambient resource of one scope: `<root>` is the agent dir or a project's `.pi`. */
function plantScope(root: string, scope: string): void {
	write(join(root, "extensions", `ambient-${scope}.ts`), ambientExtension(`${scope}-extension`));
	write(join(root, "skills", `ambient-${scope}-skill`, "SKILL.md"), skill(`ambient-${scope}-skill`));
	write(join(root, "prompts", `ambient-${scope}-prompt.md`), "Ambient prompt template.\n");
	const packageDir = join(root, `ambient-${scope}-package`);
	write(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: `ambient-${scope}-package`,
			pi: {
				extensions: ["./extension.ts"],
				skills: ["./skills"],
				prompts: ["./prompts"],
			},
		}),
	);
	write(join(packageDir, "extension.ts"), ambientExtension(`${scope}-package`));
	write(
		join(packageDir, "skills", `ambient-${scope}-package-skill`, "SKILL.md"),
		skill(`ambient-${scope}-package-skill`),
	);
	write(join(packageDir, "prompts", `ambient-${scope}-package-prompt.md`), "Ambient package prompt.\n");
	write(join(root, "settings.json"), JSON.stringify({ packages: [packageDir] }));
}

function managedFixture() {
	const document = canonicalPolicyDocument();
	const files: Record<string, string> = {
		"extensions/workspace-boundary/index.ts": WORKSPACE_BOUNDARY_PROBE,
		"extensions/drover-model-routing/index.ts": ROUTE_GUARD_PROBE,
		"extensions/drover-model-routing/policy.ts": ROUTE_GUARD_POLICY,
	};
	for (const id of ["workspace-boundary", "drover-model-routing"]) {
		for (const file of document.extensionCatalog[id].files) file.sha256 = sha256(files[file.path]);
	}
	document.roles.worker.routes.implementation = {
		provider: "probe",
		model: "probe-model",
		effort: "medium",
	};
	const agentDir = writeCanonicalPolicy(document);
	for (const [path, content] of Object.entries(files)) write(join(agentDir, path), content);
	write(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				probe: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "probe-key",
					models: [{ id: "probe-model", reasoning: true }],
				},
			},
		}),
	);
	write(
		join(agentDir, "agents", "pilot-worker.md"),
		["---", "name: pilot-worker", "mode: background", "extensions: all", "skills: all", "---", "Worker."].join("\n"),
	);
	plantScope(agentDir, "global");
	write(join(agentDir, "AGENTS.md"), "Ambient global context.\n");

	const root = createTestDir();
	write(join(root, "AGENTS.md"), "Ambient ancestor context.\n");
	const cwd = join(root, "project");
	plantScope(join(cwd, ".pi"), "project");
	write(join(cwd, ".pi", "SYSTEM.md"), "Ambient project system prompt.\n");
	write(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Ambient project append prompt.\n");
	write(join(cwd, "AGENTS.md"), "Ambient project context.\n");
	write(join(cwd, "CLAUDE.md"), "Ambient project Claude context.\n");
	write(join(cwd, ".agents", "skills", "ambient-agents-skill", "SKILL.md"), skill("ambient-agents-skill"));
	// Trust the project, so only the launch's own flags keep project-local files out.
	write(join(agentDir, "trust.json"), JSON.stringify({ [root]: true }));
	return { agentDir, cwd, home: join(root, "home") };
}

function authorizedLaunch(agentDir: string): PolicyLaunch {
	const authorization = authorizeLaunch({
		policyState: loadCanonicalPolicy(agentDir),
		agent: "pilot-worker",
		capabilityClass: "implementation",
		interactionMode: "background",
		agentDefs: null,
		now: Date.now(),
		agentDir,
	});
	assert.equal(authorization.status, "authorized", JSON.stringify(authorization));
	return (authorization as { launch: PolicyLaunch }).launch;
}

describe("managed child launch through the real pi binary", () => {
	it("loads exactly the verified inventory and nothing Pi could discover", async () => {
		const { agentDir, cwd, home } = managedFixture();
		mkdirSync(home, { recursive: true });
		// test/support/env.ts restores both after the test.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_SUBAGENT_PI_COMMAND = `'${process.execPath}' '${PI_CLI}'`;
		const parentSession = join(cwd, "parent.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		const plan = await buildBackgroundLaunchPlan(
			{
				name: "slice-worker",
				title: "Slice worker",
				task: "Implement the slice",
				agent: "pilot-worker",
				policyLaunch: authorizedLaunch(agentDir),
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent",
				},
				modelRegistry: {
					getAvailable: () => [{ provider: "probe", id: "probe-model", reasoning: true }],
				},
			} as never,
		);
		const log = join(home, "probe.log");
		const report = join(home, "probe-report.json");
		const result = spawnSync(plan.invocation.command, plan.invocation.args, {
			cwd,
			encoding: "utf8",
			timeout: 60_000,
			env: {
				PATH: process.env.PATH,
				...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PROBE_LOG: log,
				PROBE_REPORT: report,
			},
		});

		assert.ok(existsSync(report), `pi never reached the agent start: ${result.stderr}\n${result.stdout}`);
		assert.deepEqual(readFileSync(log, "utf8").trimEnd().split("\n"), [
			"load workspace-boundary",
			"load drover-model-routing",
		]);
		const loaded = JSON.parse(readFileSync(report, "utf8"));
		assert.deepEqual(
			{
				contextFiles: loaded.contextFiles,
				skills: loaded.skills,
				commands: loaded.commands.filter((name: string) => name.startsWith("ambient")),
				completionHelper: loaded.tools.includes("subagent_done"),
				spawningTools: loaded.tools.filter((name: string) => name === "subagent" || name === "subagent_resume"),
				ambientPrompt: /Ambient/.test(loaded.systemPrompt),
			},
			{
				contextFiles: [],
				skills: [],
				commands: [],
				completionHelper: true,
				spawningTools: [],
				ambientPrompt: false,
			},
		);
	});
});
