/**
 * Checks that a managed writer runs in its own linked worktree of the
 * parent's repository. The worktree is untrusted, so everything is read from
 * the filesystem; `git` is never run in it.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contains, findRepository, readControlFile } from "./sandbox-plan.ts";

export type WriterWorktree = {
	/** The worktree's top, which is the writer's working directory. */
	top: string;
	/** The worktree's own Git directory, `<common>/worktrees/<name>`. */
	gitDir: string;
	commonDir: string;
	branch: string;
	/** The commit the branch named when it was checked. */
	head: string;
};

export type WriterWorktreeCheck = { status: "valid"; worktree: WriterWorktree } | { status: "invalid"; message: string };

class WorktreeError extends Error {}

/** packed-refs can be large, but not without bound. */
const MAX_PACKED_REFS_BYTES = 64 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/;

function realPath(path: string, what: string): string {
	try {
		return realpathSync(path);
	} catch {
		throw new WorktreeError(`${what} does not exist: ${path}`);
	}
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function repositoryAt(realCwd: string, what: string) {
	const found = findRepository(realCwd);
	if (found.status === "rejected") throw new WorktreeError(`${what}: ${found.message}`);
	return found.repository;
}

/** The branch a HEAD file names, or a rejection for a detached HEAD or an unsupported name. */
function headBranch(gitDir: string): string {
	const head = readControlFile(join(gitDir, "HEAD"));
	const match = /^ref: refs\/heads\/(.+)$/.exec(head);
	if (!match) throw new WorktreeError(`the worktree's HEAD is not on a branch: ${gitDir}`);
	const branch = match[1] as string;
	const segments = branch.split("/");
	if (!segments.every((segment) => BRANCH_SEGMENT.test(segment) && !segment.endsWith(".lock"))) {
		throw new WorktreeError(`unsupported branch name in the worktree's HEAD: ${branch}`);
	}
	return branch;
}

/** The branch a HEAD file names, or null when it names none. */
function namedBranch(headFile: string): string | null {
	return /^ref: refs\/heads\/(.+)$/.exec(readControlFile(headFile))?.[1] ?? null;
}

function resolveBranch(commonDir: string, branch: string): string {
	const loose = join(commonDir, "refs", "heads", branch);
	let looseStat: ReturnType<typeof lstatSync> | undefined;
	try {
		looseStat = lstatSync(loose);
	} catch {
		looseStat = undefined;
	}
	if (looseStat) {
		const id = readControlFile(loose);
		if (!OBJECT_ID.test(id)) throw new WorktreeError(`branch ${branch} holds no commit id`);
		return id;
	}
	const packed = join(commonDir, "packed-refs");
	let packedStat: ReturnType<typeof lstatSync> | undefined;
	try {
		packedStat = lstatSync(packed);
	} catch {
		throw new WorktreeError(`branch ${branch} does not resolve`);
	}
	if (!packedStat.isFile() || packedStat.size > MAX_PACKED_REFS_BYTES) {
		throw new WorktreeError(`packed-refs is not a regular file of reasonable size: ${packed}`);
	}
	const wanted = `refs/heads/${branch}`;
	for (const line of readFileSync(packed, "utf8").split("\n")) {
		const [id, name] = line.split(" ");
		if (name === wanted && id && OBJECT_ID.test(id)) return id;
	}
	throw new WorktreeError(`branch ${branch} does not resolve`);
}

type OtherCheckout = { top: string; headFile: string };

/** The main checkout and every linked worktree of `commonDir` except the writer's own. */
function otherCheckouts(commonDir: string, ownGitDir: string): OtherCheckout[] {
	// A bare repository's main HEAD names a branch but has no checkout.
	const mainTop = basename(commonDir) === ".git" ? dirname(commonDir) : "";
	const others: OtherCheckout[] = [{ top: mainTop, headFile: join(commonDir, "HEAD") }];
	let names: string[];
	try {
		names = readdirSync(join(commonDir, "worktrees"));
	} catch {
		throw new WorktreeError(`cannot list the worktrees of ${commonDir}`);
	}
	for (const name of names) {
		const gitDir = join(commonDir, "worktrees", name);
		if (gitDir === ownGitDir) continue;
		const link = resolve(gitDir, readControlFile(join(gitDir, "gitdir")));
		others.push({ top: realOrResolved(dirname(link)), headFile: join(gitDir, "HEAD") });
	}
	return others;
}

function check(cwd: string, parentCwd: string): WriterWorktree {
	if (!isAbsolute(cwd)) throw new WorktreeError(`the writer's working directory is not absolute: ${cwd}`);
	const real = realPath(cwd, "the writer's working directory");
	if (real !== cwd) throw new WorktreeError(`the writer's working directory ${cwd} differs from its real path ${real}`);
	const repo = repositoryAt(real, "the writer's working directory");
	if (!repo.linkFile || !repo.commonDir || !repo.gitDir) {
		throw new WorktreeError(`the writer's working directory is not a linked worktree: ${real}`);
	}
	if (repo.top !== real) throw new WorktreeError(`the writer's working directory is not the top of its worktree ${repo.top}`);
	const parent = repositoryAt(realPath(parentCwd, "the parent's working directory"), "the parent's working directory");
	if (!parent.commonDir) throw new WorktreeError(`the parent's working directory is not in a Git repository: ${parentCwd}`);
	if (parent.commonDir !== repo.commonDir) {
		throw new WorktreeError(`the worktree's common Git directory ${repo.commonDir} is not the parent's ${parent.commonDir}`);
	}
	if (parent.top === repo.top) throw new WorktreeError(`the worktree is the parent's own checkout: ${repo.top}`);
	if (contains(parent.top, repo.top) || contains(repo.top, parent.top)) {
		throw new WorktreeError(`the worktree ${repo.top} and the parent checkout ${parent.top} overlap`);
	}
	const branch = headBranch(repo.gitDir);
	const head = resolveBranch(repo.commonDir, branch);
	for (const other of otherCheckouts(repo.commonDir, repo.gitDir)) {
		if (other.top && contains(repo.top, other.top)) {
			throw new WorktreeError(`the worktree ${repo.top} contains the worktree ${other.top}`);
		}
		if (other.top && contains(other.top, repo.top)) {
			throw new WorktreeError(`the worktree ${repo.top} is inside the worktree ${other.top}`);
		}
		if (namedBranch(other.headFile) === branch) {
			throw new WorktreeError(`branch ${branch} is also checked out by ${other.top || repo.commonDir}`);
		}
	}
	return { top: repo.top, gitDir: repo.gitDir, commonDir: repo.commonDir, branch, head };
}

/** Never throws: every failure is an `invalid` result with the reason. */
export function validateWriterWorktree(cwd: string, parentCwd: string): WriterWorktreeCheck {
	try {
		return { status: "valid", worktree: check(cwd, parentCwd) };
	} catch (error) {
		return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}
