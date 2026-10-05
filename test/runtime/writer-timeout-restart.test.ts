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

const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;
const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;

function lease(dir: string): WriterLease {
	const acquired = acquireWriterLease(join(dir, "leases"), {
		worktree: { top: dir, gitDir: join(dir, ".git-wt"), commonDir: join(dir, ".git"), branch: "task", head: "a".repeat(40) },
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
			cwd: dir,
		},
	};
}

function setup() {
	const dir = realpathSync(createTestDir());
	mkdirSync(join(dir, "leases"), { mode: 0o700 });
	const pidFile = join(dir, "pid.txt");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "capture-pi", `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ncat > /dev/null\n`);
	writeFileSync(join(dir, "child.jsonl"), "");
	return { dir, pidFile };
}

describe("writer timeout wrap-up restart", { skip }, () => {
	afterEach(() => {
		if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
	});

	it("starts the next generation in a new PID namespace once the previous one is proven empty", async () => {
		const { dir, pidFile } = setup();
		const writerLease = lease(dir);
		const self = readSupervisorIdentity();
		// A generation whose init PID now belongs to a process with another start time.
		writerLease.recordGroup(
			{ initPid: process.pid, startTime: "1", pidNamespace: self.pidNamespace, bootId: self.bootId },
			1,
		);
		const running = writerRunning(dir, writerLease);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		await once(running.childProcess!, "exit");

		assert.equal(readFileSync(pidFile, "utf8"), "1\n");
		assert.equal(running.writerGeneration, 2);
		const group = JSON.parse(readFileSync(join(writerLease.dir, "lease-1.group-2.json"), "utf8")).group;
		assert.notEqual(group.pidNamespace, procReader.pidNamespace("self"));
	});

	it("refuses to start the next generation while the previous one is not proven empty", async () => {
		const { dir, pidFile } = setup();
		const writerLease = lease(dir);
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
});
