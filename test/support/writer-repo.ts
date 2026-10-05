import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./temp-root.ts";

/** Run git on a fixture repository, isolated from the host's Git config and any inherited GIT_* variables. */
export function repoGit(cwd: string, ...args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	return execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: "pipe" },
	).trim();
}

/** A main checkout (the parent's) with one linked worktree on branch `task`, under `base` (the temp directory by default). */
export function writerRepo(base = tmpdir()) {
	const root = realpathSync(mkdtempSync(join(base, "writer-worktree-")));
	const main = join(root, "main");
	mkdirSync(main);
	repoGit(main, "init", "-q", "-b", "main");
	writeFileSync(join(main, "README.md"), "hello\n");
	repoGit(main, "add", "README.md");
	repoGit(main, "commit", "-q", "-m", "init");
	const linked = join(root, "linked");
	repoGit(main, "worktree", "add", "-q", "-b", "task", linked);
	const head = repoGit(main, "rev-parse", "HEAD");
	return { root, main, linked, head, common: join(main, ".git"), gitDir: join(main, ".git", "worktrees", "linked") };
}

