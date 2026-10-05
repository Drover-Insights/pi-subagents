import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { buildSandboxPlan, type BrokerMode } from "../../src/broker/sandbox-plan.ts";
import { BWRAP_PATH, probeSandbox, runInSandbox } from "../../src/broker/sandbox-run.ts";
import "../support/temp-root.ts";

/**
 * Real-bubblewrap escape tests. They run tool commands inside the actual
 * sandbox and prove what the commands cannot reach. Skipped only when
 * bubblewrap is not installed; a host with bubblewrap whose probe fails is a
 * failure, so a broken plan cannot silently skip the suite.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;
const hasPython = existsSync("/usr/bin/python3");

type Fixture = {
	root: string;
	home: string;
	secret: string;
	main: string;
	linked: string;
	common: string;
};

function fixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "broker-escape-")));
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const secret = join(agentDir, "auth.json");
	writeFileSync(secret, '{"token":"broker-canary-secret"}');
	// Supervisor and session state live in the agent directory; artifacts beside it.
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	writeFileSync(join(agentDir, "sessions", "supervisor.json"), '{"token":"broker-canary-secret"}');
	mkdirSync(join(root, "artifacts"), { recursive: true });
	writeFileSync(join(root, "artifacts", "run.json"), '{"token":"broker-canary-secret"}');
	const main = join(root, "repos", "main");
	mkdirSync(main, { recursive: true });
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			stdio: "pipe",
		});
	git(main, "init", "-q", "-b", "main");
	git(main, "config", "user.email", "t@example.com");
	git(main, "config", "user.name", "t");
	writeFileSync(join(main, "README.md"), "hello\n");
	git(main, "add", "README.md");
	git(main, "commit", "-q", "-m", "init");
	const linked = join(root, "worktrees", "linked");
	git(main, "worktree", "add", "-q", "-b", "linked", linked);
	// A symlink alias inside the repository that points at the credential file.
	symlinkSync(secret, join(linked, "alias.json"));
	return { root, home, secret, main, linked, common: join(main, ".git") };
}

async function run(f: Fixture, mode: BrokerMode, script: string, options: { cwd?: string; timeoutMs?: number } = {}) {
	const plan = buildSandboxPlan({
		mode,
		cwd: options.cwd ?? f.linked,
		protectedPaths: [f.home],
		protectedAncestors: [homedir()],
	});
	assert.equal(plan.status, "ready", plan.status === "rejected" ? plan.message : "");
	if (plan.status !== "ready") throw new Error("unreachable");
	const result = await runInSandbox(plan.args, ["/usr/bin/bash", "-c", script], { timeoutMs: options.timeoutMs ?? 20_000 });
	return { ...result, out: result.stdout.toString(), err: result.stderr.toString() };
}

function python(code: string): string {
	return `/usr/bin/python3 - <<'PY'\n${code}\nPY`;
}

describe("sandboxed tool execution", { skip }, () => {
	let f: Fixture;
	before(() => {
		f = fixture();
	});

	test("the host probe finds a usable sandbox", () => {
		assert.deepEqual(probeSandbox(), { status: "available" });
	});

	test("cannot reach credentials by absolute path, relative traversal, or symlink alias", async () => {
		const realAuth = join(homedir(), ".pi", "agent", "auth.json");
		const result = await run(
			f,
			"read-only",
			[
				`test -e ${JSON.stringify(f.secret)} && echo REACHED-ABSOLUTE`,
				`test -e ${JSON.stringify(join(f.home, ".pi", "agent", "sessions", "supervisor.json"))} && echo REACHED-SUPERVISOR`,
				`test -e ${JSON.stringify(join(f.root, "artifacts", "run.json"))} && echo REACHED-ARTIFACTS`,
				`test -e ../../home/.pi/agent/auth.json && echo REACHED-RELATIVE`,
				"cat alias.json 2>/dev/null && echo REACHED-ALIAS",
				`test -e ${JSON.stringify(realAuth)} && echo REACHED-REAL-HOME`,
				`test -e ${JSON.stringify(homedir())} && echo REACHED-HOME-DIR`,
				"echo done",
			].join("\n"),
		);
		assert.equal(result.out.trim(), "done", result.out + result.err);
		assert.ok(!result.out.includes("broker-canary-secret"));
	});

	test("sees an empty environment with no terminal, provider, or control variables", async () => {
		process.env.BROKER_CANARY_ENV = "canary-value";
		try {
			const result = await run(f, "read-only", "env; tty || true");
			const names = result.out
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => line.split("=")[0])
				.sort();
			const allowed = new Set(["GIT_OPTIONAL_LOCKS", "HOME", "LANG", "OLDPWD", "PATH", "PWD", "SHLVL", "TMPDIR", "_"]);
			assert.deepEqual(
				names.filter((name) => !allowed.has(name)),
				[],
			);
			assert.match(result.out, /not a tty/);
		} finally {
			delete process.env.BROKER_CANARY_ENV;
		}
	});

	test("cannot see host processes or read the trusted runtime's memory or environment", async () => {
		process.env.BROKER_CANARY_ENV = "canary-value";
		try {
			const result = await run(
				f,
				"read-only",
				[
					"ls /proc | grep -cE '^[0-9]+$'",
					`test -e /proc/${process.pid}/mem && echo SAW-PARENT`,
					"cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c canary-value || true",
				].join("\n"),
			);
			const [count, ...rest] = result.out.trim().split("\n");
			assert.ok(Number(count) < 10, `sandbox sees ${count} processes`);
			assert.deepEqual(rest, ["0"], result.out);
		} finally {
			delete process.env.BROKER_CANARY_ENV;
		}
	});

	test("has no network, not even the host's loopback", async () => {
		const server = createServer((socket) => socket.end("host-reached\n"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const result = await run(
				f,
				"read-only",
				[
					`(exec 3<>/dev/tcp/127.0.0.1/${port} && cat <&3) 2>/dev/null && echo LOOPBACK-OPEN`,
					"(exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo TCP-OPEN",
					"echo done",
				].join("\n"),
			);
			assert.equal(result.out.trim(), "done", result.out + result.err);
		} finally {
			server.close();
		}
	});

	test("cannot reach a host abstract unix socket or one inside its own repository", { skip: !hasPython }, async () => {
		const abstract = `\0broker-canary-${process.pid}`;
		// Inside a bound root: a filesystem socket is not network-namespaced.
		const fsSocket = join(f.linked, "control.sock");
		const servers = [createServer(), createServer()];
		await new Promise<void>((resolve) => servers[0].listen(abstract, resolve));
		await new Promise<void>((resolve) => servers[1].listen(fsSocket, resolve));
		try {
			const result = await run(
				f,
				"read-only",
				python(
					[
						"import socket",
						`for addr in [${JSON.stringify(abstract)}, ${JSON.stringify(fsSocket)}]:`,
						"    try:",
						"        socket.socket(socket.AF_UNIX).connect(addr); print('CONNECTED')",
						"    except OSError as e: print('blocked')",
					].join("\n"),
				),
			);
			assert.equal(result.out.trim(), "blocked\nblocked", result.out + result.err);
		} finally {
			for (const server of servers) server.close();
		}
	});

	test("denies vsock, keyrings, ptrace, process memory calls, io_uring, and nested user namespaces", { skip: !hasPython }, async () => {
		const result = await run(
			f,
			"read-only",
			[
				python(
					[
						"import ctypes, os, platform, socket",
						"try:",
						"    socket.socket(40, socket.SOCK_STREAM); print('vsock-open')",
						"except OSError as e: print('vsock', e.errno)",
						"libc = ctypes.CDLL(None, use_errno=True)",
						"arm = platform.machine() == 'aarch64'",
						"calls = {'keyctl': 219 if arm else 250, 'ptrace': 117 if arm else 101, 'process_vm_readv': 270 if arm else 310, 'io_uring_setup': 425, 'bpf': 280 if arm else 321}",
						"for name, nr in calls.items():",
						"    r = libc.syscall(nr, 0, 0, 0, 0, 0)",
						"    print(name, ctypes.get_errno() if r == -1 else 'ALLOWED')",
					].join("\n"),
				),
				"unshare -U true 2>/dev/null && echo USERNS-OPEN || echo userns-blocked",
			].join("\n"),
		);
		const lines = result.out.trim().split("\n");
		assert.deepEqual(lines, [
			"vsock 1",
			"keyctl 1",
			"ptrace 1",
			"process_vm_readv 1",
			"io_uring_setup 1",
			"bpf 1",
			"userns-blocked",
		], result.out + result.err);
	});

	test("kills every descendant, including detached ones, when a command times out", async () => {
		const marker = `${Date.now() % 1000}.${process.pid}`;
		const result = await run(f, "read-only", `setsid sleep ${marker} & disown; nohup sleep ${marker} & sleep 30`, {
			timeoutMs: 1_000,
		});
		assert.equal(result.exitCode, null);
		assert.equal(result.timedOut, true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const survivors = readdirSync("/proc")
			.filter((entry) => /^\d+$/.test(entry))
			.filter((pid) => {
				try {
					return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker);
				} catch {
					return false;
				}
			});
		assert.deepEqual(survivors, []);
	});

	test("read-only work cannot modify the repository, shared Git metadata, or the parent checkout", async () => {
		const head = execFileSync("git", ["-C", f.linked, "rev-parse", "HEAD"]).toString();
		const result = await run(
			f,
			"read-only",
			[
				"touch new-file 2>/dev/null && echo WROTE-REPO",
				"echo x >> README.md 2>/dev/null && echo WROTE-README",
				`echo '[core]' >> ${JSON.stringify(join(f.common, "config"))} 2>/dev/null && echo WROTE-GIT-CONFIG`,
				`touch ${JSON.stringify(join(f.common, "hooks", "pre-commit"))} 2>/dev/null && echo WROTE-HOOK`,
				`touch ${JSON.stringify(join(f.main, "planted"))} 2>/dev/null`,
				"git -c user.email=a@b -c user.name=a commit -q --allow-empty -m evil 2>/dev/null && echo COMMITTED",
				"git status --short >/dev/null 2>&1 && echo status-ok",
				"echo scratch > /tmp/scratch && cat /tmp/scratch",
			].join("\n"),
		);
		assert.equal(result.out.trim(), "status-ok\nscratch", result.out + result.err);
		assert.equal(execFileSync("git", ["-C", f.linked, "rev-parse", "HEAD"]).toString(), head);
		assert.ok(!existsSync(join(f.linked, "new-file")));
		assert.ok(!existsSync(join(f.main, "planted")));
	});

	test("streams output labelled with the stream it came from", async () => {
		const plan = buildSandboxPlan({ mode: "read-only", cwd: f.linked, protectedPaths: [f.home] });
		if (plan.status !== "ready") throw new Error(plan.message);
		const chunks: string[] = [];
		await runInSandbox(plan.args, ["/usr/bin/bash", "-c", "echo out; sleep 0.1; echo err >&2"], {
			onData: (chunk, stream) => chunks.push(`${stream}:${chunk.toString().trim()}`),
		});
		assert.deepEqual(chunks, ["stdout:out", "stderr:err"]);
	});

	test("scratch output is disposable between commands", async () => {
		await run(f, "read-only", "echo left > /tmp/left");
		const result = await run(f, "read-only", "test -e /tmp/left && echo PERSISTED; echo done");
		assert.equal(result.out.trim(), "done");
	});

	test("a writer can change its working tree but no Git metadata, link, or other checkout", async () => {
		const head = execFileSync("git", ["-C", f.linked, "rev-parse", "HEAD"]).toString();
		const result = await run(
			f,
			"writer",
			[
				"echo changed > writer-file && echo wrote-repo",
				"git add writer-file 2>/dev/null && echo STAGED",
				`echo '[core]' >> ${JSON.stringify(join(f.common, "config"))} 2>/dev/null && echo WROTE-GIT-CONFIG`,
				`touch ${JSON.stringify(join(f.common, "hooks", "pre-commit"))} 2>/dev/null && echo WROTE-HOOK`,
				`echo ../evil > ${JSON.stringify(join(f.common, "commondir"))} 2>/dev/null && echo WROTE-COMMONDIR`,
				`echo /tmp > ${JSON.stringify(join(f.common, "worktrees", "linked", "commondir"))} 2>/dev/null && echo REDIRECTED-WORKTREE`,
				`echo 'gitdir: /tmp' > .git 2>/dev/null && echo WROTE-GITDIR-LINK`,
				"mv .git .git-old 2>/dev/null && echo RENAMED-GITDIR-LINK",
				`touch ${JSON.stringify(join(f.main, "planted"))} 2>/dev/null`,
			].join("\n"),
		);
		assert.equal(result.out.trim(), "wrote-repo", result.out + result.err);
		assert.equal(execFileSync("git", ["-C", f.linked, "rev-parse", "HEAD"]).toString(), head);
		assert.ok(!existsSync(join(f.main, "planted")));
		assert.ok(!existsSync(join(f.common, "commondir")));
	});

	test("a writer in a main checkout cannot replace or redirect its .git directory", async () => {
		const result = await run(
			f,
			"writer",
			[
				"echo ../evil > .git/commondir 2>/dev/null && echo WROTE-COMMONDIR",
				"mv .git .git-old 2>/dev/null && echo RENAMED-GITDIR",
				"echo changed > main-file && echo wrote-repo",
			].join("\n"),
			{ cwd: f.main },
		);
		assert.equal(result.out.trim(), "wrote-repo", result.out + result.err);
		assert.ok(existsSync(join(f.main, ".git", "HEAD")));
	});

	test("an aborted command stops at once", async () => {
		const plan = buildSandboxPlan({ mode: "read-only", cwd: f.linked, protectedPaths: [f.home] });
		if (plan.status !== "ready") throw new Error(plan.message);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const started = Date.now();
		const result = await runInSandbox(plan.args, ["/usr/bin/sleep", "30"], { signal: controller.signal });
		assert.deepEqual([result.aborted, result.exitCode], [true, null]);
		assert.ok(Date.now() - started < 5_000);
	});

	test("endless output is cut off at the limit", async () => {
		const plan = buildSandboxPlan({ mode: "read-only", cwd: f.linked, protectedPaths: [f.home] });
		if (plan.status !== "ready") throw new Error(plan.message);
		const result = await runInSandbox(plan.args, ["/usr/bin/yes"], { maxOutputBytes: 1024 * 1024 });
		assert.deepEqual([result.overflowed, result.exitCode], [true, null]);
		assert.ok(result.stdout.length <= 1024 * 1024);
	});
});
