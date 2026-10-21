import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { TOOL_BROKER_ENV } from "../../src/broker/env-contract.ts";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { containmentDirectory } from "../../src/broker/writer-seal.ts";
import { install, type Tool } from "../support/fake-tool-host.ts";
import "../support/temp-root.ts";
import { repoGit } from "../support/writer-repo.ts";

/**
 * Review finding R8 of PR #35, end to end: Git metadata a writer plants in
 * its worktree through a brokered tool, which a later host-side Git run
 * would honor, is quarantined and contains the writer before the tool
 * returns, so a host `git status` afterwards never runs the planted
 * fsmonitor command. Each attack also runs once without the broker, to prove
 * it fires.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;

/** Git outside every sandbox, as a user's shell would run it, isolated only from the host's own config. */
function hostGit(cwd: string, ...args: string[]) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return spawnSync("git", args, {
		cwd,
		env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
}

/** The hardened form: explicit Git and work-tree directories, no fsmonitor, no hooks, no implicit bare repositories. */
function hardenedGitStatus(repo: Fixture) {
	return hostGit(
		repo.linked,
		"-c",
		"core.fsmonitor=",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"safe.bareRepository=explicit",
		`--git-dir=${repo.gitDir}`,
		`--work-tree=${repo.linked}`,
		"status",
		"--porcelain",
	);
}

/**
 * A main checkout with a committed, uninitialized submodule `sub`, and a
 * linked worktree of it on branch `task`, outside /tmp so the sandbox's
 * private /tmp cannot shadow it.
 */
function fixture() {
	const root = realpathSync(mkdtempSync(join("/var/tmp", "writer-git-metadata-")));
	const source = join(root, "sub-source");
	mkdirSync(source);
	repoGit(source, "init", "-q", "-b", "main");
	writeFileSync(join(source, "file"), "sub\n");
	repoGit(source, "add", "file");
	repoGit(source, "commit", "-q", "-m", "sub");
	const main = join(root, "main");
	mkdirSync(main);
	repoGit(main, "init", "-q", "-b", "main");
	writeFileSync(join(main, "README.md"), "hello\n");
	repoGit(main, "add", "README.md");
	repoGit(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
	repoGit(main, "commit", "-q", "-m", "init");
	const linked = join(root, "linked");
	repoGit(main, "worktree", "add", "-q", "-b", "task", linked);
	return { root, main, linked, common: join(main, ".git"), gitDir: join(main, ".git", "worktrees", "linked") };
}

type Fixture = ReturnType<typeof fixture>;

/** Each attack plants metadata from the worktree top whose fsmonitor command creates `marker`. */
const ATTACKS: { name: string; plant: (marker: string) => string; planted: string[]; trigger: string }[] = [
	{
		name: "a submodule .git link redirected to a Git directory inside the tree",
		plant: (marker) =>
			[
				"git init -q --bare evil",
				"git --git-dir=evil config core.bare false",
				'git --git-dir=evil config core.worktree "$PWD/sub"',
				`git --git-dir=evil config core.fsmonitor 'touch ${marker}; false'`,
				"echo 'gitdir: ../evil' > sub/.git",
			].join(" && "),
		planted: ["sub/.git", "evil"],
		trigger: ".",
	},
	{
		name: "a new repository with an fsmonitor command",
		plant: (marker) => `mkdir nested && cd nested && git init -q . && git config core.fsmonitor 'touch ${marker}; false'`,
		planted: ["nested/.git"],
		trigger: "nested",
	},
	{
		name: "a bare-repository-shaped directory",
		plant: (marker) =>
			[
				"mkdir vendor",
				"git init -q --bare vendor/cache.git",
				"git --git-dir=vendor/cache.git config core.bare false",
				'git --git-dir=vendor/cache.git config core.worktree "$PWD/vendor"',
				`git --git-dir=vendor/cache.git config core.fsmonitor 'touch ${marker}; false'`,
			].join(" && "),
		planted: ["vendor/cache.git"],
		trigger: "vendor/cache.git",
	},
	{
		name: "a .git symlink to a Git directory inside the tree",
		plant: (marker) =>
			[
				"mkdir linkdir",
				"git init -q --bare meta",
				"git --git-dir=meta config core.bare false",
				`git --git-dir=meta config core.fsmonitor 'touch ${marker}; false'`,
				"ln -s ../meta linkdir/.git",
			].join(" && "),
		planted: ["linkdir/.git", "meta"],
		trigger: "linkdir",
	},
];

describe("writer-created Git metadata, planted through a brokered tool", { skip }, () => {
	for (const attack of ATTACKS) {
		test(`control: without the broker, ${attack.name} survives a hardened git status and fires in a plain one`, (t) => {
			const repo = fixture();
			t.after(() => rmSync(repo.root, { recursive: true, force: true }));
			const marker = join(repo.root, "fired");
			execFileSync("/usr/bin/bash", ["-c", attack.plant(marker)], { cwd: repo.linked, env: { PATH: process.env.PATH } });
			hardenedGitStatus(repo);
			assert.equal(existsSync(marker), false, "the hardened git status ran the planted command");
			hostGit(join(repo.linked, attack.trigger), "status");
			assert.ok(existsSync(marker), "the attack did not fire; the test would prove nothing");
		});
	}

	for (const attack of ATTACKS) {
		test(`${attack.name} is quarantined and contains the writer`, async (t) => {
			const repo = fixture();
			t.after(() => rmSync(repo.root, { recursive: true, force: true }));
			const marker = join(repo.root, "fired");
			const pinned = { top: repo.linked, commonDir: repo.common, worktreeGitDir: repo.gitDir, branch: "task" };
			const identity = { ...pinned, launchId: "call-r8", generation: 1 };
			const { tools } = install({ [TOOL_BROKER_ENV]: JSON.stringify({ version: 2, mode: "writer", identity }) });
			let shutdowns = 0;
			const ctx = { cwd: repo.linked, shutdown: () => shutdowns++ };
			const bash = tools.get("bash") as Tool;

			await assert.rejects(bash.execute("plant", { command: attack.plant(marker) }, undefined, undefined, ctx), /contained/);
			await assert.rejects(bash.execute("again", { command: "true" }, undefined, undefined, ctx), /contained/);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(shutdowns >= 1, "the writer was not asked to exit");

			const dir = containmentDirectory(pinned, "call-r8");
			assert.ok(existsSync(join(dir, "contained-g1.json")));
			const manifest = readFileSync(join(dir, "quarantine-g1", "manifest.jsonl"), "utf8");
			for (const path of attack.planted) {
				assert.equal(existsSync(join(repo.linked, path)), false, `${path} was left in the worktree`);
				assert.ok(manifest.includes(JSON.stringify(join(repo.linked, path))), `${path} is not in the quarantine`);
			}

			assert.equal(hardenedGitStatus(repo).status, 0);
			for (const cwd of [repo.linked, join(repo.linked, attack.trigger), ...attack.planted.map((path) => join(repo.linked, path, ".."))]) {
				if (existsSync(cwd)) hostGit(cwd, "status");
			}
			assert.equal(existsSync(marker), false, "a host git status ran the planted fsmonitor command");
		});
	}
});
