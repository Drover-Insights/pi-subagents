import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { validateWriterWorktree } from "../../src/broker/writer-worktree.ts";
import "../support/temp-root.ts";
import { repoGit as git, writerRepo } from "../support/writer-repo.ts";

function invalid(cwd: string, parentCwd: string): string {
	const result = validateWriterWorktree(cwd, parentCwd);
	assert.equal(result.status, "invalid", JSON.stringify(result));
	return result.status === "invalid" ? result.message : "";
}

describe("writer worktree validation", () => {
	test("accepts a linked worktree of the parent's repository and reports its identity", () => {
		const repo = writerRepo();

		assert.deepEqual(validateWriterWorktree(repo.linked, repo.main), {
			status: "valid",
			worktree: {
				top: repo.linked,
				gitDir: repo.gitDir,
				commonDir: repo.common,
				branch: "task",
				head: repo.head,
			},
		});
	});

	test("reads the filesystem only and never runs git", () => {
		const repo = writerRepo();
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			assert.equal(validateWriterWorktree(repo.linked, repo.main).status, "valid");
		} finally {
			process.env.PATH = path;
		}
	});

	test("accepts a branch that resolves only through packed-refs", () => {
		const repo = writerRepo();
		git(repo.main, "pack-refs", "--all");

		assert.equal(validateWriterWorktree(repo.linked, repo.main).status, "valid");
	});

	test("accepts a parent that runs in another linked worktree of the same repository", () => {
		const repo = writerRepo();
		const other = join(repo.root, "other");
		git(repo.main, "worktree", "add", "-q", "-b", "other", other);

		assert.equal(validateWriterWorktree(repo.linked, other).status, "valid");
		assert.match(invalid(other, other), /parent/);
	});

	test("rejects the main checkout, the parent's own checkout, and a subdirectory of a worktree", () => {
		const repo = writerRepo();
		mkdirSync(join(repo.linked, "sub"));

		assert.match(invalid(repo.main, repo.main), /linked worktree/);
		assert.match(invalid(join(repo.linked, "sub"), repo.main), /top/);
	});

	test("rejects a symlinked path whose real path differs", () => {
		const repo = writerRepo();
		const alias = join(repo.root, "alias");
		symlinkSync(repo.linked, alias);

		assert.match(invalid(alias, repo.main), /real path/);
	});

	test("rejects a worktree of another repository", () => {
		const repo = writerRepo();
		const stranger = writerRepo();

		assert.match(invalid(stranger.linked, repo.main), /common Git directory/);
	});

	test("rejects a worktree inside the parent checkout, or one that contains another worktree", () => {
		const repo = writerRepo();
		const nested = join(repo.main, "nested");
		git(repo.main, "worktree", "add", "-q", "-b", "nested", nested);
		const inner = join(repo.linked, "inner");
		git(repo.main, "worktree", "add", "-q", "-b", "inner", inner);

		assert.match(invalid(nested, repo.main), /parent checkout/);
		assert.match(invalid(repo.linked, repo.main), /contains the worktree/);
		assert.match(invalid(inner, repo.main), /inside the worktree/);
	});

	test("rejects a detached or unborn HEAD", () => {
		const repo = writerRepo();
		writeFileSync(join(repo.gitDir, "HEAD"), `${repo.head}\n`);
		assert.match(invalid(repo.linked, repo.main), /HEAD/);

		writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/never-created\n");
		assert.match(invalid(repo.linked, repo.main), /does not resolve/);
	});

	test("rejects a branch name that would leave the refs directory", () => {
		const repo = writerRepo();
		writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/../../HEAD\n");

		assert.match(invalid(repo.linked, repo.main), /branch/);
	});

	test("rejects a branch that the main HEAD or another worktree's HEAD also names", () => {
		const repo = writerRepo();
		const mainHead = join(repo.common, "HEAD");
		const original = readFileSync(mainHead, "utf8");
		writeFileSync(mainHead, "ref: refs/heads/task\n");
		assert.match(invalid(repo.linked, repo.main), /also checked out/);
		writeFileSync(mainHead, original);

		const other = join(repo.root, "other");
		git(repo.main, "worktree", "add", "-q", "-b", "other", other);
		writeFileSync(join(repo.common, "worktrees", "other", "HEAD"), "ref: refs/heads/task\n");
		assert.match(invalid(repo.linked, repo.main), /also checked out/);
	});

	test("rejects a parent outside any repository", () => {
		const repo = writerRepo();
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "writer-outside-")));

		assert.match(invalid(repo.linked, outside), /parent/);
	});
});
