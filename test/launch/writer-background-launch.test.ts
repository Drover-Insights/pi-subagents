import { mkdirSync, realpathSync } from "node:fs";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { acquireWriterLease, type WriterLease } from "../../src/broker/writer-lease.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { terminateBackgroundChildProcess } from "../../src/runtime/shutdown.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	SESSION_HEADER,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import { writerRepo } from "../support/writer-repo.ts";

const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** A writer runs at the top of a real linked worktree: completion inspects the tree before releasing its lease. */
function setup(fakePi = "") {
	const repo = writerRepo(createTestDir());
	const cwd = repo.linked;
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "writer.md"), "---\nname: writer\nmode: background\nauto-exit: true\n---\nWrite.\n");
	const parentSession = join(cwd, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const pidFile = join(cwd, "pid.txt");
	process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(createTestDir(), "fake-pi", `#!/bin/sh\necho $$ > '${pidFile}'\n${fakePi}`);
	const leaseRoot = join(cwd, "leases");
	mkdirSync(leaseRoot, { mode: 0o700 });
	const ctx = {
		cwd,
		sessionManager: {
			getSessionFile: () => parentSession,
			getSessionId: () => "parent-session-id",
			getLeafId: () => null,
		},
	};
	return { repo, cwd, pidFile, leaseRoot, ctx };
}

function lease(root: string, repo: ReturnType<typeof writerRepo>, top = repo.linked): WriterLease {
	const acquired = acquireWriterLease(root, {
		worktree: { top, gitDir: repo.gitDir, commonDir: repo.common, branch: "task", head: repo.head },
		launchId: "call-1",
		policyGeneration: "gen",
	});
	if (acquired.status !== "acquired") throw new Error(JSON.stringify(acquired));
	return acquired.lease;
}

const params = { name: "write-child", title: "Write child", task: "Write it", agent: "writer" };

describe("managed writer background launch", { skip }, () => {
	it("runs the writer as the init of its own PID namespace and releases its lease once the group is proven empty", async () => {
		const { repo, pidFile, leaseRoot, ctx } = setup();
		const writerLease = lease(leaseRoot, repo);

		const running = await launchBackgroundSubagent({ ...params, writerLease }, ctx as never, { getContextWindow: () => undefined });
		assert.equal(running.writerLease, writerLease);
		assert.equal(running.writerGeneration, 1);
		await watchBackgroundSubagent(
			running,
			{ cleanupNoSessionSessionFile: () => {}, terminateBackgroundChildProcess: () => {} },
			new AbortController().signal,
		);

		assert.equal(readFileSync(pidFile, "utf8"), "1\n");
		assert.ok(existsSync(join(writerLease.dir, "lease-1.group-1.json")));
		await until(() => existsSync(join(writerLease.dir, "lease-1.end.json")));
		const end = JSON.parse(readFileSync(join(writerLease.dir, "lease-1.end.json"), "utf8"));
		assert.equal(end.kind, "released");
	});

	it("refuses to run a writer anywhere but its leased worktree", async () => {
		const { repo, pidFile, leaseRoot, ctx } = setup();
		const writerLease = lease(leaseRoot, repo, realpathSync(createTestDir()));

		await assert.rejects(
			launchBackgroundSubagent({ ...params, writerLease }, ctx as never, { getContextWindow: () => undefined }),
			/not its leased worktree/,
		);
		assert.equal(existsSync(pidFile), false);
	});

	it("a stop signal reaches the writer itself, so the launcher reports the writer's own exit", async () => {
		const { repo, cwd, leaseRoot, ctx } = setup();
		const marker = join(cwd, "term.txt");
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
			createTestDir(),
			"trapping-pi",
			`#!/bin/sh\ntrap 'echo term > "${marker}"; exit 7' TERM\nwhile :; do sleep 0.05; done\n`,
		);
		const writerLease = lease(leaseRoot, repo);
		const running = await launchBackgroundSubagent({ ...params, writerLease }, ctx as never, { getContextWindow: () => undefined });
		const child = running.childProcess!;
		const exited = new Promise<[number | null, string | null]>((resolve) => child.once("exit", (code, signal) => resolve([code, signal])));
		await new Promise((resolve) => setTimeout(resolve, 300));

		terminateBackgroundChildProcess(running, "SIGTERM");

		assert.deepEqual(await exited, [7, null]);
		assert.equal(readFileSync(marker, "utf8"), "term\n");
	});

	it("quarantines Git metadata the writer left and contains its lease instead of releasing it", async () => {
		const { repo, leaseRoot, ctx } = setup("mkdir -p sub && echo 'gitdir: ../evil' > sub/.git\n");
		const writerLease = lease(leaseRoot, repo);
		const running = await launchBackgroundSubagent({ ...params, writerLease }, ctx as never, { getContextWindow: () => undefined });
		await watchBackgroundSubagent(running, WATCH_RUNTIME, new AbortController().signal);

		await until(() => existsSync(join(writerLease.dir, "lease-1.contained.json")));
		assert.match(readFileSync(join(writerLease.dir, "lease-1.contained.json"), "utf8"), /sub\/\.git/);
		assert.equal(existsSync(join(repo.linked, "sub", ".git")), false);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(existsSync(join(writerLease.dir, "lease-1.end.json")), false);
	});

	it("contains the lease when the worktree's identity changed while the writer ran", async () => {
		const { repo, leaseRoot, ctx } = setup();
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(
			createTestDir(),
			"switching-pi",
			`#!/bin/sh\necho 'ref: refs/heads/other' > '${join(repo.gitDir, "HEAD")}'\n`,
		);
		const writerLease = lease(leaseRoot, repo);
		const running = await launchBackgroundSubagent({ ...params, writerLease }, ctx as never, { getContextWindow: () => undefined });
		await watchBackgroundSubagent(running, WATCH_RUNTIME, new AbortController().signal);

		await until(() => existsSync(join(writerLease.dir, "lease-1.contained.json")));
		assert.match(readFileSync(join(writerLease.dir, "lease-1.contained.json"), "utf8"), /branch other/);
		const later = acquireWriterLease(leaseRoot, {
			worktree: { top: repo.linked, gitDir: repo.gitDir, commonDir: repo.common, branch: "task", head: repo.head },
			launchId: "call-2",
			policyGeneration: "gen",
		});
		assert.equal(later.status, "held");
		assert.match(later.status === "held" ? later.reason : "", /contained/);
	});
});

const WATCH_RUNTIME = { cleanupNoSessionSessionFile: () => {}, terminateBackgroundChildProcess: () => {} };
