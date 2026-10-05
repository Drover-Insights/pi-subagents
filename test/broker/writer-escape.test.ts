import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { buildSandboxPlan } from "../../src/broker/sandbox-plan.ts";
import { BWRAP_PATH, runInSandbox } from "../../src/broker/sandbox-run.ts";
import { spawnWriterChild } from "../../src/broker/writer-spawn.ts";
import "../support/temp-root.ts";
import { repoGit, writerRepo } from "../support/writer-repo.ts";

/**
 * Real-bubblewrap escape tests for a writer's sandbox: it may write its own
 * worktree and its private /tmp, and nothing else. Skipped only when
 * bubblewrap is not installed.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;

/** Every file and symlink under `dir`, with a hash of its content or target. */
function snapshot(dir: string, into = new Map<string, string>()): Map<string, string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) snapshot(path, into);
		else if (stat.isSymbolicLink()) into.set(path, `link:${readlinkSync(path)}`);
		else into.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
	}
	return into;
}

function protectedState(repo: ReturnType<typeof writerRepo>, other: string): Map<string, string> {
	const state = snapshot(repo.main);
	snapshot(other, state);
	state.set(join(repo.linked, ".git"), readFileSync(join(repo.linked, ".git"), "utf8"));
	return state;
}

describe("writer sandbox confinement", { skip }, () => {
	for (const nested of [false, true]) {
		test(`a writer can write only its worktree and private /tmp, by every route${nested ? ", inside the writer's own PID namespace" : ""}`, async (t) => {
			// Outside /tmp, so the sandbox's private /tmp cannot shadow a target path.
			const repo = writerRepo("/var/tmp");
			t.after(() => rmSync(repo.root, { recursive: true, force: true }));
			const other = join(repo.root, "other");
			repoGit(repo.main, "worktree", "add", "-q", "-b", "other", other);
			const targets: Record<string, string> = {
				"parent checkout file": join(repo.main, "README.md"),
				"parent checkout new file": join(repo.main, "planted"),
				"other worktree file": join(other, "README.md"),
				"other worktree new file": join(other, "planted"),
				"branch ref": join(repo.common, "refs", "heads", "task"),
				"new ref": join(repo.common, "refs", "heads", "planted"),
				"objects": join(repo.common, "objects", "planted"),
				"hook": join(repo.common, "hooks", "pre-commit"),
				"common config": join(repo.common, "config"),
				"worktree HEAD": join(repo.gitDir, "HEAD"),
				"worktree index": join(repo.gitDir, "index"),
				"worktree config": join(repo.gitDir, "config.worktree"),
				"worktree commondir": join(repo.gitDir, "commondir"),
				"worktree gitdir": join(repo.gitDir, "gitdir"),
				".git link": join(repo.linked, ".git"),
			};
			const attempts: string[] = [];
			for (const [index, [label, target]] of Object.entries(targets).entries()) {
				const quoted = JSON.stringify(target);
				const traversal = JSON.stringify(relative(repo.linked, target) || ".git");
				attempts.push(
					`(echo x >> ${quoted}) 2>/dev/null && echo "ESCAPED absolute: ${label}"`,
					`(echo x >> ${traversal}) 2>/dev/null && echo "ESCAPED traversal: ${label}"`,
					`ln -s ${quoted} planted-link-${index} 2>/dev/null; (echo x >> planted-link-${index}) 2>/dev/null && echo "ESCAPED symlink: ${label}"`,
					`/bin/sh -c 'echo x >> ${quoted}' 2>/dev/null && echo "ESCAPED subprocess: ${label}"`,
					`setsid -w /bin/sh -c 'echo x >> ${quoted}' 2>/dev/null && echo "ESCAPED setsid: ${label}"`,
				);
			}
			const git = [
				"git add writer-file 2>/dev/null && echo 'ESCAPED git add'",
				"git -c user.name=t -c user.email=t@e commit -qm x 2>/dev/null && echo 'ESCAPED git commit'",
				"git config core.hooksPath /tmp 2>/dev/null && echo 'ESCAPED git config'",
				"git config --worktree core.fsmonitor true 2>/dev/null && echo 'ESCAPED git config --worktree'",
				"git branch planted 2>/dev/null && echo 'ESCAPED git branch'",
				"git update-ref refs/heads/planted HEAD 2>/dev/null && echo 'ESCAPED git update-ref'",
				"git checkout -q -b planted2 2>/dev/null && echo 'ESCAPED git checkout'",
				"(printf '#!/bin/sh\\necho pwned\\n' > \"$(git rev-parse --git-path hooks)/post-checkout\") 2>/dev/null && echo 'ESCAPED hook install'",
			];
			const before = protectedState(repo, other);
			const plan = buildSandboxPlan({ mode: "writer", cwd: repo.linked, protectedPaths: [join(homedir(), ".pi")], protectedAncestors: [homedir()] });
			if (plan.status !== "ready") throw new Error(plan.message);

			const command = [
				"/usr/bin/bash",
				"-c",
				["echo changed > writer-file && echo wrote-worktree", "echo scratch > /tmp/scratch && echo wrote-tmp", ...attempts, ...git].join("\n"),
			];

			const { out, err } = nested
				? await runNested(plan.args, command, repo.linked)
				: await runInSandbox(plan.args, command, { timeoutMs: 60_000 }).then((result) => ({
						out: result.stdout.toString(),
						err: result.stderr.toString(),
					}));

			assert.deepEqual(out.trim().split("\n"), ["wrote-worktree", "wrote-tmp"], out + err);
			assert.equal(readFileSync(join(repo.linked, "writer-file"), "utf8"), "changed\n");
			assert.deepEqual(protectedState(repo, other), before);
		});
	}
});

/**
 * Run a tool sandbox the way production does: from a process that is the init
 * of a writer's own PID namespace, under the outer bubblewrap.
 */
async function runNested(planArgs: string[], command: string[], cwd: string): Promise<{ out: string; err: string }> {
	const runner = `
		import { runInSandbox } from ${JSON.stringify(new URL("../../src/broker/sandbox-run.ts", import.meta.url).href)};
		const [planArgs, command] = JSON.parse(process.argv[1]);
		const result = await runInSandbox(planArgs, command, { timeoutMs: 60_000 });
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	`;
	const child = await spawnWriterChild({
		command: process.execPath,
		args: ["--input-type=module", "-e", runner, JSON.stringify([planArgs, command])],
		cwd,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		stdio: ["ignore", "pipe", "pipe"],
		recordGroup: () => {},
	});
	let out = "";
	let err = "";
	child.stdout?.on("data", (chunk) => {
		out += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		err += chunk;
	});
	await new Promise((resolve) => child.once("close", resolve));
	return { out, err };
}
