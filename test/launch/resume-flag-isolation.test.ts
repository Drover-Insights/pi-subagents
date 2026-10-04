import { launchBackgroundSubagent } from "../../src/launch/background.ts";
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

describe("ordinary launch resume-flag isolation", () => {
	it("does not pass an ambient PI_SUBAGENT_RESUME_WITHOUT_TASK=1 to an ordinary background child", async () => {
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
			`#!/bin/sh\nprintf 'FLAG=[%s]\\n' "\${PI_SUBAGENT_RESUME_WITHOUT_TASK-unset}" > '${childLog}'\n`,
		);
		const saved = {
			command: process.env.PI_SUBAGENT_PI_COMMAND,
			artifactRoot: process.env.PI_ARTIFACT_PROJECT_ROOT,
			flag: process.env.PI_SUBAGENT_RESUME_WITHOUT_TASK,
		};
		process.env.PI_SUBAGENT_PI_COMMAND = fakeBin;
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(dir, "artifacts");
		// The parent is itself a task-less background resume.
		process.env.PI_SUBAGENT_RESUME_WITHOUT_TASK = "1";
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
			const flagLine = await readLineEventually(childLog);
			assert.equal(flagLine, "FLAG=[]", "an ordinary child expects its prompt");
		} finally {
			for (const [key, value] of [
				["PI_SUBAGENT_PI_COMMAND", saved.command],
				["PI_ARTIFACT_PROJECT_ROOT", saved.artifactRoot],
				["PI_SUBAGENT_RESUME_WITHOUT_TASK", saved.flag],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
