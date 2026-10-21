/**
 * Seals the Git metadata a writer may create inside its writable worktree.
 *
 * Bind mounts cannot forbid new names in a writable tree, so a writer can
 * plant a nested repository, a redirected submodule `.git` link, or a
 * bare-repository-shaped directory whose config a later host-side Git run
 * would honor. After a writer's sandboxes have exited, a bounded `lstat` walk
 * that follows no symlinks finds every such entry and moves it to a
 * quarantine outside the worktree. Any finding, a changed top-level `.git`
 * link, or reaching the walk's cap is a breach the caller contains.
 *
 * The walk must run only while nothing writes the tree: a concurrent writer
 * could swap a directory for a symlink between a read and a rename.
 */
import { createHash } from "node:crypto";
import { appendFileSync, type Dirent, lstatSync, mkdirSync, opendirSync, realpathSync, renameSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { PinnedWorktree } from "./env-contract.ts";
import { contains, readControlFile } from "./sandbox-plan.ts";

/** Generous: a large monorepo with its dependencies fits, and a writer cannot make the walk endless. */
const SEAL_MAX_ENTRIES = 250_000;

type SealFinding = { path: string; kind: "git-entry" | "bare-repository" | "unreadable" };

type SealResult =
	| { status: "sealed" }
	| {
			status: "breached";
			reason: string;
			findings: SealFinding[];
			quarantined: { from: string; to: string }[];
			unquarantined: { path: string; error: string }[];
	  };

/**
 * Where a launch's containment records and quarantined entries live: under
 * the repository's common Git directory, which no writer sandbox can write
 * and which the parent and its child both know.
 */
export function containmentDirectory(pinned: PinnedWorktree, launchId: string): string {
	const key = createHash("sha256").update(launchId).digest("hex");
	return join(pinned.commonDir, "pi-subagents", "writer-containment", key);
}

/** Why the top-level `.git` link is not the one the worktree was pinned with, or null. */
function topLinkChange(pinned: PinnedWorktree): string | null {
	const link = join(pinned.top, ".git");
	try {
		const match = /^gitdir:\s*(.+)$/.exec(readControlFile(link));
		if (!match) return `the top-level .git link ${link} is malformed`;
		const target = realpathSync(resolve(pinned.top, match[1] as string));
		if (target !== pinned.worktreeGitDir) return `the top-level .git link ${link} now points at ${target}`;
		return null;
	} catch (error) {
		return `the top-level .git link ${link} is not the sealed link: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function isDirectoryEntry(dir: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()) return false;
	if (entry.isBlockDevice() || entry.isCharacterDevice()) return false;
	// The file system reported no type; ask without following a symlink.
	return lstatSync(join(dir, entry.name)).isDirectory();
}

/**
 * A name as a case-insensitive file system might compare it. Linux
 * casefolding decomposes and folds case (the long s, U+017F, becomes `s`),
 * and before 6.12 also drops invisible characters such as U+200D. This
 * strips those, decomposes, drops combining marks, and folds case through
 * upper case. It may fold more than the file system does, which only flags more.
 */
function foldCase(name: string): string {
	return name
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toUpperCase()
		.toLowerCase();
}

/**
 * Whether Git could take a directory with these entries for a repository, as
 * its `is_git_directory` does: a `HEAD`, and a `commondir` naming where the
 * rest lives or a `refs` that passes its `access(X_OK)` check. Its `objects`
 * check is left out, since a host Git that sets `GIT_OBJECT_DIRECTORY` needs
 * no local `objects`. A `HEAD` of any type counts, since Git follows a
 * symlinked one. A `refs` is ruled out only when it is neither a directory
 * nor a symlink and has no execute bit.
 */
function isRepositoryShaped(dir: string, entries: ReadonlyMap<string, Dirent>): boolean {
	// Names match in any case: on a case-insensitive file system Git resolves `REFS` as `refs`.
	const named = (name: string) => [...entries.values()].filter((entry) => foldCase(entry.name) === name);
	if (named("head").length === 0) return false;
	if (named("commondir").length > 0) return true;
	return named("refs").some((refs) => {
		try {
			return refs.isSymbolicLink() || isDirectoryEntry(dir, refs) || (lstatSync(join(dir, refs.name)).mode & 0o111) !== 0;
		} catch {
			// A refs that vanished during the walk counts.
			return true;
		}
	});
}

type Walk = { findings: SealFinding[]; capped: boolean; unreadable: string[] };

/** A directory's entries, read one at a time so a huge directory stops at the cap. */
function readEntries(dir: string, budget: number): { entries: Map<string, Dirent>; capped: boolean } {
	const handle = opendirSync(dir);
	const entries = new Map<string, Dirent>();
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			if (entries.size >= budget) return { entries, capped: true };
			entries.set(entry.name, entry);
		}
		return { entries, capped: false };
	} finally {
		handle.closeSync();
	}
}

function walk(pinned: PinnedWorktree, maxEntries: number): Walk {
	const found: Walk = { findings: [], capped: false, unreadable: [] };
	const pending = [pinned.top];
	let seen = 0;
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let read: ReturnType<typeof readEntries>;
		try {
			read = readEntries(dir, maxEntries - seen);
		} catch (error) {
			// An unreadable directory may still be reached by path, so it is moved out whole.
			const code = (error as { code?: string }).code ?? String(error);
			if (dir === pinned.top) found.unreadable.push(`cannot read the worktree top ${dir}: ${code}`);
			else found.findings.push({ path: dir, kind: "unreadable" });
			continue;
		}
		seen += read.entries.size;
		if (read.capped) return { ...found, capped: true };
		if (isRepositoryShaped(dir, read.entries)) {
			if (dir === pinned.top) found.unreadable.push(`the worktree top ${dir} is shaped like a Git directory`);
			else found.findings.push({ path: dir, kind: "bare-repository" });
			continue;
		}
		for (const entry of read.entries.values()) {
			const path = join(dir, entry.name);
			// Any case but the sealed top-level link itself, for case-insensitive file systems.
			if (foldCase(entry.name) === ".git") {
				if (dir !== pinned.top || entry.name !== ".git") found.findings.push({ path, kind: "git-entry" });
				continue;
			}
			if (isDirectoryEntry(dir, entry)) pending.push(path);
		}
	}
	return found;
}

function quarantine(
	pinned: PinnedWorktree,
	dir: string,
	findings: readonly SealFinding[],
): Pick<Extract<SealResult, { status: "breached" }>, "quarantined" | "unquarantined"> {
	const quarantined: { from: string; to: string }[] = [];
	const unquarantined: { path: string; error: string }[] = [];
	if (findings.length === 0) return { quarantined, unquarantined };
	let ready: string | undefined;
	try {
		if (contains(pinned.top, resolve(dir))) throw new Error(`the quarantine ${dir} is inside the worktree`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		ready = dir;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const finding of findings) unquarantined.push({ path: finding.path, error: message });
		return { quarantined, unquarantined };
	}
	const stamp = Date.now();
	for (const [index, finding] of findings.entries()) {
		const to = join(ready, `${stamp}-${index}`);
		try {
			renameSync(finding.path, to);
			appendFileSync(
				join(ready, "manifest.jsonl"),
				`${JSON.stringify({ from: finding.path, relative: relative(pinned.top, finding.path), kind: finding.kind, to })}\n`,
				{ mode: 0o600 },
			);
			quarantined.push({ from: finding.path, to });
		} catch (error) {
			unquarantined.push({ path: finding.path, error: (error as { code?: string }).code ?? String(error) });
		}
	}
	return { quarantined, unquarantined };
}

/** Why the findings breach the seal: created Git metadata, and directories the walk could not read. */
function findingsReason(findings: readonly SealFinding[]): string | undefined {
	const paths = (unreadable: boolean) =>
		findings.filter((finding) => (finding.kind === "unreadable") === unreadable).map((finding) => finding.path);
	const parts = [
		...(paths(false).length > 0 ? [`the writer created Git metadata in its worktree: ${paths(false).join(", ")}`] : []),
		...(paths(true).length > 0 ? [`unreadable directories: ${paths(true).join(", ")}`] : []),
	];
	return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Walk the pinned worktree and quarantine writer-created Git metadata into
 * `quarantineDir`. Never throws: an unreadable tree is a breach.
 */
export function sealWriterTree(
	pinned: PinnedWorktree,
	quarantineDir: string,
	options: { maxEntries?: number } = {},
): SealResult {
	const maxEntries = options.maxEntries ?? SEAL_MAX_ENTRIES;
	const linkChange = topLinkChange(pinned);
	let found: Walk;
	try {
		found = walk(pinned, maxEntries);
	} catch (error) {
		found = { findings: [], capped: false, unreadable: [error instanceof Error ? error.message : String(error)] };
	}
	const moved = quarantine(pinned, quarantineDir, found.findings);
	const reason =
		linkChange ??
		(found.capped ? `the worktree walk reached its cap of ${maxEntries} entries` : undefined) ??
		found.unreadable[0] ??
		findingsReason(found.findings);
	if (reason === undefined) return { status: "sealed" };
	return { status: "breached", reason, findings: found.findings, ...moved };
}

/** A breach's reason, naming every entry the quarantine could not take. */
export function breachReason(seal: Extract<SealResult, { status: "breached" }>): string {
	const unmoved = seal.unquarantined.map((entry) => `${entry.path} (${entry.error})`).join(", ");
	return unmoved ? `${seal.reason}; not quarantined: ${unmoved}` : seal.reason;
}
