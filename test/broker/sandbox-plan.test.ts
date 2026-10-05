import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildSandboxPlan, type SandboxPlan, type SandboxPlanInput } from "../../src/broker/sandbox-plan.ts";
import "../support/temp-root.ts";

function scratch(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "broker-plan-")));
}

function gitDirectory(path: string): void {
	mkdirSync(join(path, "objects"), { recursive: true });
	mkdirSync(join(path, "refs"), { recursive: true });
	mkdirSync(join(path, "hooks"), { recursive: true });
	writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(path, "config"), "[core]\n");
}

/** A main checkout with a `.git` directory, and a linked worktree of it, laid out as Git does. */
function repository() {
	const root = scratch();
	const home = join(root, "home");
	const main = join(root, "repos", "main");
	const common = join(main, ".git");
	gitDirectory(common);
	const linkedGitDir = join(common, "worktrees", "linked");
	mkdirSync(linkedGitDir, { recursive: true });
	const linked = join(root, "worktrees", "linked");
	mkdirSync(join(linked, "src"), { recursive: true });
	writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
	writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
	writeFileSync(join(linkedGitDir, "gitdir"), `${join(linked, ".git")}\n`);
	writeFileSync(join(linkedGitDir, "HEAD"), "ref: refs/heads/linked\n");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	return { root, home, main, common, linked, linkedGitDir, agentDir };
}

type Repo = ReturnType<typeof repository>;

function plan(repo: Repo, input: Partial<SandboxPlanInput> & Pick<SandboxPlanInput, "cwd">): SandboxPlan {
	return buildSandboxPlan({
		mode: "read-only",
		protectedPaths: [repo.agentDir],
		protectedAncestors: [repo.home],
		...input,
	});
}

function ready(result: SandboxPlan) {
	assert.equal(result.status, "ready", result.status === "rejected" ? result.message : "");
	return result as Extract<SandboxPlan, { status: "ready" }>;
}

function rejected(result: SandboxPlan, pattern?: RegExp) {
	assert.equal(result.status, "rejected", "the plan was accepted");
	if (pattern && result.status === "rejected") assert.match(result.message, pattern);
}

/** Every `[flag, source, destination]` mount in argv order. */
function mounts(args: readonly string[]): string[][] {
	const found: string[][] = [];
	for (let index = 0; index < args.length; index++) {
		if (["--bind", "--ro-bind", "--ro-bind-try"].includes(args[index])) {
			found.push([args[index], args[index + 1], args[index + 2]]);
			index += 2;
		}
	}
	return found;
}

function lastMountOf(args: readonly string[], path: string): string | undefined {
	return mounts(args)
		.filter(([, , destination]) => destination === path)
		.at(-1)?.[0];
}

describe("sandbox mount plan", () => {
	test("isolates every namespace, drops all authority, and starts from an empty environment", () => {
		const repo = repository();
		const result = ready(plan(repo, { cwd: repo.main }));
		for (const flag of [
			"--unshare-all",
			"--unshare-user",
			"--disable-userns",
			"--die-with-parent",
			"--new-session",
			"--clearenv",
			"--cap-drop",
		]) {
			assert.ok(result.args.includes(flag), `missing ${flag}`);
		}
		assert.ok(!result.args.includes("--share-net"));
		const env = new Map<string, string>();
		for (let index = 0; index < result.args.length; index++) {
			if (result.args[index] === "--setenv") env.set(result.args[index + 1], result.args[index + 2]);
		}
		assert.deepEqual([...env.keys()].sort(), ["GIT_OPTIONAL_LOCKS", "HOME", "LANG", "PATH", "TMPDIR"]);
		assert.equal(env.get("HOME"), "/tmp/home");
		assert.equal(result.args[result.args.indexOf("--chdir") + 1], repo.main);
		// The sandbox's own root, where bwrap creates mount-point parents, is read-only too.
		assert.deepEqual(result.args.slice(-4, -2), ["--remount-ro", "/"]);
	});

	test("binds a read-only role's repository and Git metadata read-only and nothing writable", () => {
		const repo = repository();
		const result = ready(plan(repo, { cwd: join(repo.linked, "src") }));
		assert.equal(lastMountOf(result.args, repo.linked), "--ro-bind");
		assert.equal(lastMountOf(result.args, repo.common), "--ro-bind");
		assert.deepEqual(
			mounts(result.args).filter(([flag]) => flag === "--bind"),
			[],
		);
		assert.equal(result.args[result.args.indexOf("--chdir") + 1], join(repo.linked, "src"));
	});

	test("lets a writer write its working tree but keeps every Git directory and link read-only", () => {
		const repo = repository();
		const linked = ready(plan(repo, { mode: "writer", cwd: repo.linked }));
		assert.equal(lastMountOf(linked.args, repo.linked), "--bind");
		assert.equal(lastMountOf(linked.args, repo.common), "--ro-bind");
		assert.equal(lastMountOf(linked.args, join(repo.linked, ".git")), "--ro-bind");
		const main = ready(plan(repo, { mode: "writer", cwd: repo.main }));
		const binds = mounts(main.args);
		const top = binds.findIndex(([flag, , destination]) => flag === "--bind" && destination === repo.main);
		const git = binds.findIndex(([flag, , destination]) => flag === "--ro-bind" && destination === repo.common);
		assert.ok(top >= 0 && git > top, "the .git directory is not sealed after the writable working tree");
	});

	test("binds a directory outside any repository by itself", () => {
		const repo = repository();
		const cwd = join(repo.root, "plain");
		mkdirSync(cwd);
		assert.equal(lastMountOf(ready(plan(repo, { cwd })).args, cwd), "--ro-bind");
	});

	test("binds named executables read-only on the sandbox PATH under their tool name", () => {
		const repo = repository();
		const fdfind = join(repo.root, "bin", "fdfind");
		mkdirSync(join(repo.root, "bin"));
		writeFileSync(fdfind, "#!/bin/sh\n");
		const result = ready(plan(repo, { cwd: repo.main, executables: { fd: fdfind } }));
		assert.deepEqual(
			mounts(result.args).find(([, source]) => source === fdfind),
			["--ro-bind", fdfind, "/opt/pi-broker/bin/fd"],
		);
		const path = result.args[result.args.indexOf("PATH") + 1];
		assert.ok(path.split(":").includes("/opt/pi-broker/bin"));
	});

	test("rejects roots that contain a protected ancestor such as home, or the filesystem root", () => {
		const repo = repository();
		rejected(plan(repo, { cwd: repo.home }));
		rejected(plan(repo, { cwd: "/" }));
		ready(plan(repo, { cwd: repo.main }));
	});

	test("rejects roots that equal, contain, or sit inside a protected path", () => {
		const repo = repository();
		rejected(plan(repo, { cwd: repo.agentDir }));
		rejected(plan(repo, { cwd: join(repo.home, ".pi") }));
		rejected(plan(repo, { cwd: join(repo.agentDir, "sessions") }));
	});

	test("rejects roots inside system trees", () => {
		const repo = repository();
		for (const cwd of ["/proc", "/etc", "/usr/bin", "/dev"]) rejected(plan(repo, { cwd }), /system/);
	});

	test("rejects a symlink alias whose real path is protected", () => {
		const repo = repository();
		const alias = join(repo.root, "alias");
		symlinkSync(join(repo.agentDir, "sessions"), alias);
		rejected(plan(repo, { mode: "writer", cwd: alias }));
	});

	test("rejects a .git file that points anywhere but a linked worktree of a real repository", () => {
		const repo = repository();
		const cases: [string, string][] = [
			["the host procfs", "gitdir: /proc\n"],
			["a protected directory", `gitdir: ${join(repo.agentDir, "sessions")}\n`],
			["a plain directory", `gitdir: ${repo.root}\n`],
			["the common directory itself", `gitdir: ${repo.common}\n`],
		];
		for (const [label, content] of cases) {
			const cwd = join(repo.root, `case-${label.replace(/\W+/g, "-")}`);
			mkdirSync(cwd);
			writeFileSync(join(cwd, ".git"), content);
			rejected(plan(repo, { cwd }));
		}
	});

	test("rejects a linked worktree whose commondir or gitdir back-link was redirected", () => {
		const repo = repository();
		writeFileSync(join(repo.linkedGitDir, "commondir"), `${repo.root}\n`);
		rejected(plan(repo, { cwd: repo.linked }));
		writeFileSync(join(repo.linkedGitDir, "commondir"), "../..\n");
		ready(plan(repo, { cwd: repo.linked }));
		writeFileSync(join(repo.linkedGitDir, "gitdir"), `${join(repo.root, "elsewhere", ".git")}\n`);
		rejected(plan(repo, { cwd: repo.linked }));
	});

	test("rejects Git control files that are not regular files", () => {
		const repo = repository();
		const commondir = join(repo.linkedGitDir, "commondir");
		writeFileSync(join(repo.root, "real-commondir"), "../..\n");
		rmSync(commondir);
		symlinkSync(join(repo.root, "real-commondir"), commondir);
		rejected(plan(repo, { cwd: repo.linked }));
	});

	test("rejects a working directory inside a bare repository or a Git directory", () => {
		const repo = repository();
		const bare = join(repo.root, "bare.git");
		gitDirectory(bare);
		rejected(plan(repo, { mode: "writer", cwd: bare }), /Git directory/);
		rejected(plan(repo, { mode: "writer", cwd: join(repo.common, "hooks") }), /Git directory/);
	});

	test("rejects a working directory that does not exist", () => {
		const repo = repository();
		rejected(plan(repo, { cwd: join(repo.root, "missing") }));
	});
});
