import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { TOOL_BROKER_ENV } from "../../src/broker/env-contract.ts";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { BROKERED_TOOL_NAMES } from "../../src/broker/tools.ts";
import { containmentDirectory } from "../../src/broker/writer-seal.ts";
import { install, text, type Tool } from "../support/fake-tool-host.ts";
import "../support/temp-root.ts";
import { writerRepo } from "../support/writer-repo.ts";

/**
 * A managed writer's brokered tools, driven as Pi drives them against the
 * real sandbox: pinned to their worktree, contained on any identity change
 * or writer-created Git metadata.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;

/** Parameters every tool accepts well enough to reach its sandbox. */
const ANY_PARAMS: Record<string, Record<string, unknown>> = {
	read: { path: "README.md" },
	bash: { command: "echo reached > reached.txt" },
	edit: { path: "README.md", edits: [{ oldText: "hello", newText: "bye" }] },
	write: { path: "reached.txt", content: "reached\n" },
	grep: { pattern: "hello" },
	find: { pattern: "*.md" },
	ls: {},
};

function writerSession(t: { after: (fn: () => void) => void }) {
	// Outside /tmp, so the sandbox's private /tmp cannot shadow the worktree.
	const repo = writerRepo("/var/tmp");
	t.after(() => rmSync(repo.root, { recursive: true, force: true }));
	const pinned = { top: repo.linked, commonDir: repo.common, worktreeGitDir: repo.gitDir, branch: "task" };
	const identity = { ...pinned, launchId: "call-7", generation: 1 };
	const { tools } = install({ [TOOL_BROKER_ENV]: JSON.stringify({ version: 2, mode: "writer", identity }) });
	let shutdowns = 0;
	const call = (name: string, params: Record<string, unknown>, cwd = repo.linked) => {
		const tool = tools.get(name) as Tool;
		return tool.execute("call", params, undefined, undefined, { cwd, shutdown: () => shutdowns++ });
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
	const containment = containmentDirectory(pinned, "call-7");
	return { repo, call, shutdowns: () => shutdowns, settle, containment };
}

/** Every tool now fails with the containment reason, and none reaches a sandbox. */
async function assertAllDisabled(session: ReturnType<typeof writerSession>, reason: RegExp) {
	for (const name of BROKERED_TOOL_NAMES) {
		await assert.rejects(session.call(name, ANY_PARAMS[name] as Record<string, unknown>), (error: Error) => {
			assert.match(error.message, /^tool broker: .*contained/);
			assert.match(error.message, reason);
			return true;
		}, name);
	}
	assert.equal(existsSync(join(session.repo.linked, "reached.txt")), false, "a contained tool reached its sandbox");
}

function containmentRecord(dir: string): { reason: string; generation: number } {
	return JSON.parse(readFileSync(join(dir, "contained-g1.json"), "utf8"));
}

describe("a managed writer's brokered tools", { skip }, () => {
	test("write and edit their pinned worktree", async (t) => {
		const session = writerSession(t);
		await session.call("write", { path: "notes/new.txt", content: "first\n" });
		await session.call("edit", { path: "notes/new.txt", edits: [{ oldText: "first", newText: "second" }] });
		assert.equal(readFileSync(join(session.repo.linked, "notes", "new.txt"), "utf8"), "second\n");
		assert.match(text(await session.call("bash", { command: "cat notes/new.txt" })), /second/);
		// A credential outside the worktree stays out of reach of the writer's own write and edit.
		const canary = join(session.repo.root, "canary.json");
		writeFileSync(canary, '{"token":"writer-canary"}');
		await assert.rejects(session.call("write", { path: canary, content: "x" }));
		await assert.rejects(session.call("edit", { path: canary, edits: [{ oldText: "writer", newText: "x" }] }));
		assert.equal(readFileSync(canary, "utf8"), '{"token":"writer-canary"}');
		assert.equal(session.shutdowns(), 0);
		assert.equal(existsSync(session.containment), false);
	});

	test("a switched branch stops dispatch for the rest of the session and signals exit", async (t) => {
		const session = writerSession(t);
		const head = join(session.repo.gitDir, "HEAD");
		writeFileSync(head, "ref: refs/heads/other\n");
		await assert.rejects(session.call("write", { path: "reached.txt", content: "x" }), /contained.*branch other/);
		await session.settle();
		assert.ok(session.shutdowns() >= 1, "the child was not asked to exit");
		assert.match(containmentRecord(session.containment).reason, /branch other/);
		// Restoring the branch does not reopen the session.
		writeFileSync(head, "ref: refs/heads/task\n");
		await assertAllDisabled(session, /branch other/);
	});

	test("a renamed worktree is contained", async (t) => {
		const session = writerSession(t);
		renameSync(session.repo.linked, `${session.repo.linked}-moved`);
		await assert.rejects(session.call("ls", {}), /contained.*does not exist/);
		await session.settle();
		assert.ok(session.shutdowns() >= 1);
	});

	test("a working directory in a nested repository is contained", async (t) => {
		const session = writerSession(t);
		const nested = join(session.repo.linked, "nested");
		mkdirSync(nested);
		execFileSync("git", ["init", "-q"], { cwd: nested, env: { PATH: process.env.PATH } });
		await assert.rejects(session.call("read", { path: "x" }, nested), /contained.*not the pinned worktree/);
		await assertAllDisabled(session, /not the pinned worktree/);
	});

	test("Git metadata a tool writes is quarantined before the result returns, and the writer is contained", async (t) => {
		const session = writerSession(t);
		await assert.rejects(
			session.call("bash", { command: "mkdir -p sub && echo 'gitdir: ../evil' > sub/.git && echo done" }),
			/contained.*Git metadata.*sub\/\.git/,
		);
		assert.equal(existsSync(join(session.repo.linked, "sub", ".git")), false);
		const quarantine = join(session.containment, "quarantine-g1");
		assert.ok(readdirSync(quarantine).includes("manifest.jsonl"));
		assert.match(containmentRecord(session.containment).reason, /sub\/\.git/);
		await session.settle();
		assert.ok(session.shutdowns() >= 1);
		await assertAllDisabled(session, /Git metadata/);
	});

	test("parallel tool calls run their sandboxes and walks one at a time", async (t) => {
		const session = writerSession(t);
		const order: string[] = [];
		const slow = session.call("bash", { command: "sleep 0.5; echo slow" }).then(() => order.push("slow"));
		const fast = session.call("bash", { command: "echo fast" }).then(() => order.push("fast"));
		await Promise.all([slow, fast]);
		assert.deepEqual(order, ["slow", "fast"]);
	});
});
