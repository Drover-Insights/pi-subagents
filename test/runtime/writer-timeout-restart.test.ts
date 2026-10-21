import { once } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { procReader, readSupervisorIdentity } from "../../src/broker/writer-group.ts";
import { acquireWriterLease, type WriterLease } from "../../src/broker/writer-lease.ts";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import { writerRepo } from "../support/writer-repo.ts";

const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;
const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;

function lease(dir: string, repo: ReturnType<typeof writerRepo>): WriterLease {
	const acquired = acquireWriterLease(join(dir, "leases"), {
		worktree: { top: repo.linked, gitDir: repo.gitDir, commonDir: repo.common, branch: "task", head: repo.head },
		launchId: "call-1",
		policyGeneration: "gen",
	});
	if (acquired.status !== "acquired") throw new Error(JSON.stringify(acquired));
	return acquired.lease;
}

function writerRunning(dir: string, writerLease: WriterLease): RunningSubagent {
	return {
		id: "writer-child",
		name: "writer-child",
		task: "Write the thing",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		noSession: true,
		startTime: Date.now() - 8_000,
		sessionFile: join(dir, "child.jsonl"),
		timeoutBudget: { timeoutSeconds: 10 },
		timeoutWarnThreshold: 80,
		timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
		modelRef: "test/model:off",
		writerLease,
		writerGeneration: 1,
		launchMetadata: {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "writer-child",
			agent: "scout",
			mode: "background",
			sessionMode: "fork",
			autoExit: false,
			parentClosePolicy: "terminate",
			async: true,
			modelRef: "test/model:off",
			denyTools: [],
			spawnBudget: 0,
			spawnableAgents: true,
			boundarySystemPrompt: true,
			noContextFiles: false,
			noSession: true,
			agentConfigDir: dir,
			cwd: writerLease.worktree,
		},
	};
}

/** The writer's own worktree is a real linked worktree; a restart inspects it before the next generation. */
function setup() {
	const dir = realpathSync(createTestDir());
	mkdirSync(join(dir, "leases"), { mode: 0o700 });
	const pidFile = join(dir, "pid.txt");
	const brokerFile = join(dir, "broker.json");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
		dir,
		"capture-pi",
		`#!/usr/bin/env bash\necho $$ > "${pidFile}"\nprintf '%s' "$PI_SUBAGENT_TOOL_BROKER" > "${brokerFile}"\ncat > /dev/null\n`,
	);
	writeFileSync(join(dir, "child.jsonl"), "");
	const repo = writerRepo(dir);
	return { dir, pidFile, brokerFile, repo };
}

/** A recorded first generation whose init PID now belongs to a process with another start time. */
function recordGoneGeneration(writerLease: WriterLease): void {
	const self = readSupervisorIdentity();
	writerLease.recordGroup({ initPid: process.pid, startTime: "1", pidNamespace: self.pidNamespace, bootId: self.bootId }, 1);
}

describe("writer timeout wrap-up restart", { skip }, () => {
	afterEach(() => {
		if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
	});

	it("starts the next generation in a new PID namespace once the previous one is proven empty", async () => {
		const { dir, pidFile, repo } = setup();
		const writerLease = lease(dir, repo);
		recordGoneGeneration(writerLease);
		const running = writerRunning(dir, writerLease);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		await once(running.childProcess!, "exit");

		assert.equal(readFileSync(pidFile, "utf8"), "1\n");
		assert.equal(running.writerGeneration, 2);
		const group = JSON.parse(readFileSync(join(writerLease.dir, "lease-1.group-2.json"), "utf8")).group;
		assert.notEqual(group.pidNamespace, procReader.pidNamespace("self"));
	});

	it("refuses to start the next generation while the previous one is not proven empty", async () => {
		const { dir, pidFile, repo } = setup();
		const writerLease = lease(dir, repo);
		const self = readSupervisorIdentity();
		writerLease.recordGroup(
			{ initPid: process.pid, startTime: self.startTime, pidNamespace: self.pidNamespace, bootId: self.bootId },
			1,
		);
		const running = writerRunning(dir, writerLease);

		await assert.rejects(
			restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }),
			/previous generation.*not proven empty/,
		);

		assert.equal(running.childProcess, undefined);
		assert.equal(existsSync(pidFile), false);
		assert.equal(existsSync(join(writerLease.dir, "lease-1.end.json")), false);
	});

	it("pins the next generation to the same worktree identity, as generation 2", async () => {
		const { dir, brokerFile, repo } = setup();
		const writerLease = lease(dir, repo);
		recordGoneGeneration(writerLease);
		const running = writerRunning(dir, writerLease);
		running.policyLaunch = { model: "test/model", thinking: "off", extensions: [], toolBroker: { mode: "writer" } } as never;

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }).catch(() => {});
		if (running.childProcess) await once(running.childProcess, "exit");

		assert.deepEqual(JSON.parse(readFileSync(brokerFile, "utf8")).identity, {
			top: repo.linked,
			commonDir: repo.common,
			worktreeGitDir: repo.gitDir,
			branch: "task",
			launchId: "call-1",
			generation: 2,
		});
	});

	for (const [label, change, reason] of [
		["a lease already contained on disk", (_repo: Repo, writerLease: WriterLease) => writeFileSync(join(writerLease.dir, "lease-1.contained.json"), '{"reason":"contained elsewhere"}\n'), /contained elsewhere/],
		["a switched branch", (repo: Repo) => writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/other\n"), /branch other/],
		["Git metadata the previous generation left", (repo: Repo) => {
			mkdirSync(join(repo.linked, "sub"));
			writeFileSync(join(repo.linked, "sub", ".git"), "gitdir: ../evil\n");
		}, /sub\/\.git/],
	] as const) {
		it(`contains the writer and starts no next generation after ${label}`, async () => {
			const { dir, pidFile, repo } = setup();
			const writerLease = lease(dir, repo);
			recordGoneGeneration(writerLease);
			change(repo, writerLease);
			const running = writerRunning(dir, writerLease);

			await assert.rejects(restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }), reason);

			assert.equal(running.childProcess, undefined);
			assert.equal(existsSync(pidFile), false);
			assert.ok(existsSync(join(writerLease.dir, "lease-1.contained.json")));
			assert.equal(existsSync(join(writerLease.dir, "lease-1.group-2.json")), false);
		});
	}
});

type Repo = ReturnType<typeof writerRepo>;
