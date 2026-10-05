import { readToolBrokerConfig, TOOL_BROKER_ENV, toolBrokerEnv } from "../../src/broker/env-contract.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { getBaseSubagentEnvVars, type PreparedSubagentLaunch } from "../../src/launch/prep.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	mkdirSync,
	readFileSync,
	SESSION_HEADER,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

const managed = {
	model: "openai-codex/gpt-5.6-luna",
	thinking: "low",
	extensions: [],
	toolBroker: { mode: "read-only" as const },
};

async function readLineEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8");
			if (text.endsWith("\n")) return text.trim();
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

describe("tool broker env contract", () => {
	it("tells a managed child its broker mode and clears the variable for every other child", () => {
		assert.deepEqual(toolBrokerEnv(managed), { [TOOL_BROKER_ENV]: '{"version":1,"mode":"read-only"}' });
		assert.deepEqual(toolBrokerEnv(undefined), { [TOOL_BROKER_ENV]: "" });
	});

	it("reads only an exact, known config and reports anything else as malformed", () => {
		assert.deepEqual(readToolBrokerConfig({}), { status: "absent" });
		assert.deepEqual(readToolBrokerConfig({ [TOOL_BROKER_ENV]: "" }), { status: "absent" });
		assert.deepEqual(readToolBrokerConfig({ [TOOL_BROKER_ENV]: '{"version":1,"mode":"writer"}' }), {
			status: "brokered",
			mode: "writer",
		});
		for (const value of [
			"read-only",
			"{",
			'{"version":2,"mode":"writer"}',
			'{"version":1,"mode":"root"}',
			'{"version":1}',
			'{"version":1,"mode":"writer","network":true}',
			"null",
			"[]",
		]) {
			assert.equal(readToolBrokerConfig({ [TOOL_BROKER_ENV]: value }).status, "malformed", value);
		}
	});

	it("sets the broker config on every managed launch and clears it on every other", () => {
		const prepared = (policyLaunch?: typeof managed) =>
			({
				agentDefs: null,
				runtimePaths: { localAgentConfigDir: null },
				skillLaunchPlan: { visibilitySpec: "" },
				spawnPolicy: { childBudget: null, effectiveWidth: null, spawnableAgents: [] },
				denySet: [],
				sessionFile: null,
				...(policyLaunch ? { policyLaunch } : {}),
			}) as unknown as PreparedSubagentLaunch;
		const params = { name: "route-scout", task: "Map", title: "Map", agent: "pilot-scout" };
		const saved = process.env[TOOL_BROKER_ENV];
		process.env[TOOL_BROKER_ENV] = '{"version":1,"mode":"writer"}';
		try {
			assert.equal(
				getBaseSubagentEnvVars(prepared(managed), params, () => "standalone")[TOOL_BROKER_ENV],
				'{"version":1,"mode":"read-only"}',
			);
			assert.equal(getBaseSubagentEnvVars(prepared(), params, () => "standalone")[TOOL_BROKER_ENV], "");
		} finally {
			if (saved === undefined) delete process.env[TOOL_BROKER_ENV];
			else process.env[TOOL_BROKER_ENV] = saved;
		}
	});

	it("does not pass an ambient broker config to an unmanaged background child", async () => {
		const dir = createTestDir();
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "agents", "plain.md"),
			["---", "name: plain", "mode: background", "auto-exit: true", "---", "You are plain."].join("\n"),
		);
		const parentSession = join(dir, "parent.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		const childLog = join(dir, "child-env.log");
		const fakeBin = writeExecutable(
			createTestDir(),
			"fake-pi",
			`#!/bin/sh\nprintf 'BROKER=[%s]\\n' "\${${TOOL_BROKER_ENV}-unset}" > '${childLog}'\n`,
		);
		const saved = {
			command: process.env.PI_SUBAGENT_PI_COMMAND,
			artifactRoot: process.env.PI_ARTIFACT_PROJECT_ROOT,
			broker: process.env[TOOL_BROKER_ENV],
		};
		process.env.PI_SUBAGENT_PI_COMMAND = fakeBin;
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
		process.env[TOOL_BROKER_ENV] = '{"version":1,"mode":"writer"}';
		try {
			await launchBackgroundSubagent(
				{ name: "ordinary-child", title: "Ordinary child", task: "Do the work.", agent: "plain" },
				{
					cwd: dir,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => null,
					},
				},
				{ getContextWindow: () => undefined },
			);
			assert.equal(await readLineEventually(childLog), "BROKER=[]");
		} finally {
			for (const [key, value] of [
				["PI_SUBAGENT_PI_COMMAND", saved.command],
				["PI_ARTIFACT_PROJECT_ROOT", saved.artifactRoot],
				[TOOL_BROKER_ENV, saved.broker],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
