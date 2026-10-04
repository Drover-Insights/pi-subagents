import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd: string, args: string[]): string {
	// Drop inherited GIT_* variables, as a git hook sets, so fixtures never write to another repository.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	const config = ["user.name=test", "user.email=test@example.com", "commit.gpgsign=false", "tag.gpgsign=false"];
	return execFileSync("git", [...config.flatMap((entry) => ["-c", entry]), ...args], {
		cwd,
		env,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();
}

/**
 * Make `dir` a Git checkout holding a package.json, committed and tagged `v1`.
 * Returns the commit sha so tests can pin a source to it.
 */
export function createGitCheckout(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "footer-extension", version: "1.0.0" }));
	git(dir, ["init", "--quiet"]);
	git(dir, ["add", "package.json"]);
	git(dir, ["commit", "--quiet", "-m", "v1"]);
	git(dir, ["tag", "v1"]);
	return git(dir, ["rev-parse", "HEAD"]);
}

/** Add a commit on top of the checkout, moving HEAD off `v1`. */
export function advanceGitCheckout(dir: string): void {
	writeFileSync(join(dir, "CHANGELOG.md"), "v2\n");
	git(dir, ["add", "CHANGELOG.md"]);
	git(dir, ["commit", "--quiet", "-m", "v2"]);
}
