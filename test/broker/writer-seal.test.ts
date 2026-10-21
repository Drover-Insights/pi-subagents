import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { containmentDirectory, sealWriterTree } from "../../src/broker/writer-seal.ts";
import "../support/temp-root.ts";
import { writerRepo } from "../support/writer-repo.ts";

function pinnedOf(repo: ReturnType<typeof writerRepo>) {
	return { top: repo.linked, commonDir: repo.common, worktreeGitDir: repo.gitDir, branch: "task" };
}

function setup(t: { after: (fn: () => void) => void }) {
	const repo = writerRepo();
	t.after(() => rmSync(repo.root, { recursive: true, force: true }));
	const pinned = pinnedOf(repo);
	const quarantine = join(containmentDirectory(pinned, "call-1"), "quarantine-g1");
	return { repo, pinned, quarantine };
}

function quarantined(dir: string): string[] {
	const manifest = join(dir, "manifest.jsonl");
	if (!existsSync(manifest)) return [];
	return readFileSync(manifest, "utf8")
		.trim()
		.split("\n")
		.map((line) => (JSON.parse(line) as { from: string }).from)
		.sort();
}

describe("writer-created Git metadata seal", () => {
	test("keeps the containment directory outside the worktree, keyed by launch", () => {
		const repo = writerRepo();
		const pinned = pinnedOf(repo);
		const dir = containmentDirectory(pinned, "call-1");
		assert.ok(dir.startsWith(join(repo.common, "pi-subagents", "writer-containment") + "/"));
		assert.ok(!dir.startsWith(repo.linked));
		assert.notEqual(containmentDirectory(pinned, "call-2"), dir);
		assert.equal(containmentDirectory(pinned, "../../x"), containmentDirectory(pinned, "../../x"));
		assert.ok(!containmentDirectory(pinned, "../../x").includes(".."));
		rmSync(repo.root, { recursive: true, force: true });
	});

	test("a clean worktree, with ordinary files and symlinks, stays sealed", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		mkdirSync(join(repo.linked, "src", "deep"), { recursive: true });
		writeFileSync(join(repo.linked, "src", "deep", "HEAD"), "not a repository on its own\n");
		symlinkSync("/", join(repo.linked, "root-link"));
		symlinkSync(repo.common, join(repo.linked, "common-link"));
		assert.deepEqual(sealWriterTree(pinned, quarantine), { status: "sealed" });
		assert.equal(existsSync(quarantine), false);
	});

	test("quarantines every nested .git entry, of any file type, and a bare-repository-shaped directory", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		execFileSync("git", ["init", "-q", join(repo.linked, "nested")], { env: { PATH: process.env.PATH } });
		mkdirSync(join(repo.linked, "sub"));
		writeFileSync(join(repo.linked, "sub", ".git"), "gitdir: ../evil\n");
		mkdirSync(join(repo.linked, "links"));
		symlinkSync(repo.common, join(repo.linked, "links", ".git"));
		execFileSync("mkfifo", [join(repo.linked, "fifo-dir-.git")]);
		mkdirSync(join(repo.linked, "fifo"));
		execFileSync("mkfifo", [join(repo.linked, "fifo", ".git")]);
		const bare = join(repo.linked, "vendor", "evil");
		mkdirSync(join(bare, "objects"), { recursive: true });
		mkdirSync(join(bare, "refs"));
		writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(bare, "config"), "[core]\n\tfsmonitor = touch /tmp/never\n");

		const result = sealWriterTree(pinned, quarantine);
		assert.equal(result.status, "breached");
		const expected = [
			join(repo.linked, "fifo", ".git"),
			join(repo.linked, "links", ".git"),
			join(repo.linked, "nested", ".git"),
			join(repo.linked, "sub", ".git"),
			bare,
		].sort();
		assert.deepEqual(result.status === "breached" ? result.findings.map((finding) => finding.path).sort() : [], expected);
		assert.deepEqual(quarantined(quarantine), expected);
		for (const path of expected) assert.equal(existsSync(path), false, `${path} was left in the worktree`);
		assert.ok(existsSync(join(repo.linked, "fifo-dir-.git")), "a name that only contains .git is not Git metadata");
		// The quarantine holds the moved entries, outside the worktree.
		assert.equal(readdirSync(quarantine).length, expected.length + 1);
		assert.deepEqual(sealWriterTree(pinned, quarantine), { status: "sealed" });
	});

	test("a changed top-level .git link is a breach and is left in place", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const link = join(repo.linked, ".git");
		const original = readFileSync(link, "utf8");
		writeFileSync(link, "gitdir: ../elsewhere\n");
		const result = sealWriterTree(pinned, quarantine);
		assert.equal(result.status, "breached");
		assert.match(result.status === "breached" ? result.reason : "", /top-level \.git link/);
		assert.equal(readFileSync(link, "utf8"), "gitdir: ../elsewhere\n");
		rmSync(link);
		symlinkSync(repo.gitDir, link);
		assert.equal(sealWriterTree(pinned, quarantine).status, "breached");
		rmSync(link);
		writeFileSync(link, original);
		assert.deepEqual(sealWriterTree(pinned, quarantine), { status: "sealed" });
	});

	test("reaching the walk's cap is a breach", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		for (let index = 0; index < 20; index++) writeFileSync(join(repo.linked, `file-${index}`), "");
		const result = sealWriterTree(pinned, quarantine, { maxEntries: 10 });
		assert.equal(result.status, "breached");
		assert.match(result.status === "breached" ? result.reason : "", /cap of 10 entries/);
		assert.deepEqual(sealWriterTree(pinned, quarantine, { maxEntries: 1000 }), { status: "sealed" });
	});

	test("an entry that cannot be moved still breaches, and is reported unquarantined", (t) => {
		const { repo, pinned } = setup(t);
		mkdirSync(join(repo.linked, "sub"));
		writeFileSync(join(repo.linked, "sub", ".git"), "gitdir: ../evil\n");
		// A quarantine path under a regular file cannot be created.
		writeFileSync(join(repo.root, "blocker"), "");
		const result = sealWriterTree(pinned, join(repo.root, "blocker", "quarantine"));
		assert.equal(result.status, "breached");
		assert.deepEqual(
			result.status === "breached" ? result.unquarantined.map((entry) => entry.path) : [],
			[join(repo.linked, "sub", ".git")],
		);
	});

	test("refuses a quarantine inside the worktree", (t) => {
		const { repo, pinned } = setup(t);
		mkdirSync(join(repo.linked, "sub"));
		writeFileSync(join(repo.linked, "sub", ".git"), "gitdir: ../evil\n");
		const result = sealWriterTree(pinned, join(repo.linked, "q"));
		assert.equal(result.status, "breached");
		assert.equal(existsSync(join(repo.linked, "q")), false);
		assert.ok(existsSync(join(repo.linked, "sub", ".git")));
	});

	test("quarantines a repository split across two directories through a commondir file, as Git discovers it", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const head = join(repo.linked, "split", "a");
		const common = join(repo.linked, "split", "b");
		mkdirSync(head, { recursive: true });
		mkdirSync(join(common, "objects"), { recursive: true });
		mkdirSync(join(common, "refs"));
		writeFileSync(join(head, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(head, "commondir"), "../b\n");
		writeFileSync(join(common, "config"), "[core]\n\tfsmonitor = touch /tmp/never\n");
		// Control: Git itself takes the HEAD-and-commondir directory for a repository.
		const discovered = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: head,
			env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			encoding: "utf8",
		});
		assert.equal(discovered.trim(), ".");

		const result = sealWriterTree(pinned, quarantine);
		assert.equal(result.status, "breached");
		assert.deepEqual(quarantined(quarantine), [head]);
		assert.equal(existsSync(head), false);
	});

	test("executable files named objects and refs make a repository, as Git's access check does", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const dir = join(repo.linked, "vendor", "x");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
		for (const name of ["objects", "refs"]) writeFileSync(join(dir, name), "", { mode: 0o755 });
		const discovered = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: dir,
			env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
			encoding: "utf8",
		});
		assert.equal(discovered.trim(), ".", "control: Git takes the directory for a repository");
		assert.equal(sealWriterTree(pinned, quarantine).status, "breached");
		assert.deepEqual(quarantined(quarantine), [dir]);
	});

	test("a HEAD with refs alone makes a repository for a host Git that sets GIT_OBJECT_DIRECTORY", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const dir = join(repo.linked, "vendor", "y");
		mkdirSync(join(dir, "refs"), { recursive: true });
		writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(dir, "config"), "[core]\n\tfsmonitor = touch /tmp/never\n");
		const discovered = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: dir,
			env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OBJECT_DIRECTORY: repo.linked },
			encoding: "utf8",
		});
		assert.equal(discovered.trim(), ".", "control: Git takes the directory for a repository");
		assert.equal(sealWriterTree(pinned, quarantine).status, "breached");
		assert.deepEqual(quarantined(quarantine), [dir]);
	});

	test("names match in any case, as Git resolves them on a case-insensitive file system", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const upper = join(repo.linked, "upper");
		mkdirSync(join(upper, "REFS"), { recursive: true });
		writeFileSync(join(upper, "head"), "ref: refs/heads/main\n");
		mkdirSync(join(repo.linked, "sub"));
		writeFileSync(join(repo.linked, "sub", ".GIT"), "gitdir: ../evil\n");
		// Linux casefolding folds the long s (U+017F) to s, which lower-casing alone does not.
		const folded = join(repo.linked, "folded");
		mkdirSync(join(folded, "ref\u017f"), { recursive: true });
		writeFileSync(join(folded, "HEAD"), "ref: refs/heads/main\n");
		// Linux before 6.12 also drops invisible characters such as U+200C and U+200D when it folds names.
		const invisible = join(repo.linked, "invisible");
		mkdirSync(join(invisible, "re\u200cfs"), { recursive: true });
		writeFileSync(join(invisible, "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(repo.linked, "joined"));
		writeFileSync(join(repo.linked, "joined", ".g\u200dit"), "gitdir: ../evil\n");
		assert.equal(sealWriterTree(pinned, quarantine).status, "breached");
		assert.deepEqual(
			quarantined(quarantine),
			[join(repo.linked, "sub", ".GIT"), folded, upper, invisible, join(repo.linked, "joined", ".g\u200dit")].sort(),
		);
	});

	test("ordinary files named HEAD, objects and refs are project data, not a repository", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		const fixture = join(repo.linked, "fixtures", "example");
		mkdirSync(fixture, { recursive: true });
		for (const name of ["HEAD", "objects", "refs"]) writeFileSync(join(fixture, name), "data\n");
		// Git needs a refs it can enter; HEAD beside an objects directory alone is never a repository.
		const assets = join(repo.linked, "fixtures", "assets");
		mkdirSync(join(assets, "objects"), { recursive: true });
		writeFileSync(join(assets, "HEAD"), "ref: refs/heads/main\n");
		const control = spawnSync("git", ["rev-parse", "--git-dir"], {
			cwd: assets,
			env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: join(repo.linked, "fixtures") },
			encoding: "utf8",
		});
		assert.equal(control.error, undefined);
		assert.equal(control.status, 128, control.stderr);
		assert.match(control.stderr, /not a git repository/, "control: Git does not take HEAD and objects alone for a repository");
		assert.deepEqual(sealWriterTree(pinned, quarantine), { status: "sealed" });
		assert.ok(existsSync(join(fixture, "objects")));
		assert.ok(existsSync(join(assets, "objects")));
	});

	test("an unreadable directory does not hide metadata elsewhere, and is quarantined itself", (t) => {
		const { repo, pinned, quarantine } = setup(t);
		mkdirSync(join(repo.linked, "a"));
		writeFileSync(join(repo.linked, "a", ".git"), "gitdir: ../evil\n");
		const locked = join(repo.linked, "z");
		mkdirSync(locked);
		writeFileSync(join(locked, ".git"), "gitdir: ../evil\n");
		if (process.getuid?.() === 0) return t.skip("root reads every directory");
		chmodSync(locked, 0o311);
		try {
			const result = sealWriterTree(pinned, quarantine);
			assert.equal(result.status, "breached");
			assert.match(result.status === "breached" ? result.reason : "", /unreadable directories: .*\/z/);
			assert.deepEqual(quarantined(quarantine), [join(repo.linked, "a", ".git"), locked].sort());
			assert.equal(existsSync(join(repo.linked, "a", ".git")), false);
			assert.equal(existsSync(locked), false);
		} finally {
			// Unlock wherever the directory ended up, so the fixture can be removed.
			for (const path of [locked, ...readdirIfAny(quarantine)]) {
				try {
					chmodSync(path, 0o755);
				} catch {}
			}
		}
	});
});

function readdirIfAny(dir: string): string[] {
	try {
		return readdirSync(dir).map((name) => join(dir, name));
	} catch {
		return [];
	}
}
