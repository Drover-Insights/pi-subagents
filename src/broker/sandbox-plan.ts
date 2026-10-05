/**
 * Pure bubblewrap mount planner for the credential-blind tool broker.
 *
 * Returns the bwrap argv (everything before the command) for one sandbox.
 * The repository is untrusted, so it is discovered by reading the filesystem
 * in JavaScript, never by running `git`, and a `.git` file is followed only
 * when it has the exact shape of a linked worktree of a real repository. Git
 * metadata is always mounted read-only: whatever a tool writes there would
 * run later in Git outside the sandbox. Never throws: every failure becomes a
 * `rejected` plan.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export type BrokerMode = "read-only" | "writer";

export type SandboxPlanInput = {
	mode: BrokerMode;
	cwd: string;
	/** Paths no root may equal, contain, or sit inside. */
	protectedPaths: readonly string[];
	/** Paths no root may equal or contain; a root may sit inside one, as a repository sits inside home. */
	protectedAncestors?: readonly string[];
	/** Tool name to executable file; each is bound read-only at `/opt/pi-broker/bin/<name>`. */
	executables?: Readonly<Record<string, string>>;
};

export type SandboxPlan = { status: "ready"; args: string[]; cwd: string } | { status: "rejected"; message: string };

const BIN_DIR = "/opt/pi-broker/bin";
const SANDBOX_HOME = "/tmp/home";
const SYSTEM_DIRS = ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"];
const ETC_ENTRIES = [
	"passwd",
	"group",
	"nsswitch.conf",
	"ld.so.cache",
	"ld.so.conf",
	"ld.so.conf.d",
	"alternatives",
	"ssl",
	"ca-certificates",
	"localtime",
	"gitconfig",
];
/** Trees no sandbox root may sit inside: pseudo-filesystems, runtime sockets, and system configuration. */
const SYSTEM_TREES = ["/proc", "/sys", "/dev", "/run", "/var/run", "/etc", "/usr", "/boot", ...SYSTEM_DIRS];
/** Git control files are a line or two; anything larger, or not a regular file, is refused unread. */
const MAX_CONTROL_FILE_BYTES = 4096;
const EXECUTABLE_NAME = /^[A-Za-z0-9._-]+$/;

type Repository = { top: string; commonDir?: string; linkFile?: string };

class PlanError extends Error {}

/** True when `parent` equals `child` or is a path-segment ancestor of it. */
function contains(parent: string, child: string): boolean {
	if (parent === child) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function realExisting(path: string, what: string): string {
	try {
		return realpathSync(path);
	} catch {
		throw new PlanError(`${what} does not exist: ${path}`);
	}
}

function isKind(path: string, kind: "file" | "directory"): boolean {
	try {
		const stat = lstatSync(path);
		return kind === "file" ? stat.isFile() : stat.isDirectory();
	} catch {
		return false;
	}
}

/** The trimmed content of a small regular file; symlinks, FIFOs and devices are refused unread. */
function readControlFile(path: string): string {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		throw new PlanError(`Git control file is missing: ${path}`);
	}
	if (!stat.isFile() || stat.size > MAX_CONTROL_FILE_BYTES) {
		throw new PlanError(`Git control file is not a small regular file: ${path}`);
	}
	return readFileSync(path, "utf8").trim();
}

/** A Git directory has a HEAD file and objects and refs directories. */
function isGitDirectory(dir: string): boolean {
	return isKind(resolve(dir, "HEAD"), "file") && isKind(resolve(dir, "objects"), "directory") && isKind(resolve(dir, "refs"), "directory");
}

/**
 * Follow a `.git` file only to `<common>/worktrees/<name>` of a real
 * repository whose `commondir` leads back to `<common>` and whose `gitdir`
 * leads back to this `.git` file.
 */
function linkedWorktree(top: string, dotGit: string): Repository {
	const match = /^gitdir:\s*(.+)$/.exec(readControlFile(dotGit));
	if (!match) throw new PlanError(`malformed gitdir file: ${dotGit}`);
	const gitDir = realExisting(resolve(top, match[1] as string), "gitdir");
	const commonDir = dirname(dirname(gitDir));
	if (basename(dirname(gitDir)) !== "worktrees" || !isGitDirectory(commonDir)) {
		throw new PlanError(`${dotGit} does not point at a linked worktree of a Git repository`);
	}
	const commondir = realOrResolved(resolve(gitDir, readControlFile(resolve(gitDir, "commondir"))));
	const backLink = realOrResolved(resolve(gitDir, readControlFile(resolve(gitDir, "gitdir"))));
	if (commondir !== commonDir || backLink !== dotGit) {
		throw new PlanError(`the Git metadata of ${dotGit} does not lead back to it`);
	}
	return { top, commonDir, linkFile: dotGit };
}

function discoverRepository(realCwd: string): Repository {
	for (let dir = realCwd; ; dir = dirname(dir)) {
		if (isGitDirectory(dir)) {
			throw new PlanError(`working directory is inside a Git directory: ${dir}`);
		}
		const dotGit = resolve(dir, ".git");
		let stat: ReturnType<typeof lstatSync> | undefined;
		try {
			stat = lstatSync(dotGit);
		} catch {
			stat = undefined;
		}
		if (stat?.isDirectory()) {
			if (!isGitDirectory(dotGit)) throw new PlanError(`malformed Git directory: ${dotGit}`);
			return { top: dir, commonDir: dotGit };
		}
		if (stat?.isFile()) return linkedWorktree(dir, dotGit);
		if (stat) throw new PlanError(`unsupported .git entry: ${dotGit}`);
		if (dirname(dir) === dir) return { top: realCwd };
	}
}

function checkRoot(root: string, input: SandboxPlanInput): void {
	const system = SYSTEM_TREES.find((tree) => contains(realOrResolved(tree), root) || contains(tree, root));
	if (system !== undefined) throw new PlanError(`sandbox root ${root} is inside the system tree ${system}`);
	for (const ancestor of [...(input.protectedAncestors ?? []), "/"].map(realOrResolved)) {
		if (contains(root, ancestor)) throw new PlanError(`sandbox root ${root} exposes protected path ${ancestor}`);
	}
	for (const path of input.protectedPaths.map(realOrResolved)) {
		if (contains(root, path) || contains(path, root)) {
			throw new PlanError(`sandbox root ${root} exposes protected path ${path}`);
		}
	}
}

function systemArgs(): string[] {
	const args = ["--ro-bind", "/usr", "/usr"];
	for (const path of SYSTEM_DIRS) {
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
		else args.push("--ro-bind", path, path);
	}
	for (const entry of ETC_ENTRIES) {
		const path = `/etc/${entry}`;
		if (existsSync(path)) args.push("--ro-bind", path, path);
	}
	return args;
}

function executableArgs(executables: Readonly<Record<string, string>>): string[] {
	const args: string[] = [];
	for (const [name, executable] of Object.entries(executables)) {
		if (!EXECUTABLE_NAME.test(name)) throw new PlanError(`invalid executable name: ${name}`);
		const real = realExisting(executable, "executable");
		if (!statSync(real).isFile()) throw new PlanError(`executable is not a regular file: ${executable}`);
		args.push("--ro-bind", real, `${BIN_DIR}/${name}`);
	}
	return args;
}

function plan(input: SandboxPlanInput): SandboxPlan {
	const realCwd = realExisting(input.cwd, "working directory");
	if (!statSync(realCwd).isDirectory()) throw new PlanError(`working directory is not a directory: ${realCwd}`);

	const repo = discoverRepository(realCwd);
	const roots = [repo.top, ...(repo.commonDir && !contains(repo.top, repo.commonDir) ? [repo.commonDir] : [])];
	for (const root of roots) checkRoot(root, input);

	const args = [
		"--unshare-all",
		// --unshare-all only tries a user namespace; --disable-userns needs it for certain.
		"--unshare-user",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--setenv",
		"PATH",
		`${BIN_DIR}:/usr/local/bin:/usr/bin:/bin`,
		"--setenv",
		"HOME",
		SANDBOX_HOME,
		"--setenv",
		"LANG",
		"C.UTF-8",
		"--setenv",
		"TMPDIR",
		"/tmp",
		"--setenv",
		"GIT_OPTIONAL_LOCKS",
		"0",
		...systemArgs(),
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		SANDBOX_HOME,
		...executableArgs(input.executables ?? {}),
		input.mode === "writer" ? "--bind" : "--ro-bind",
		repo.top,
		repo.top,
	];
	// After the working tree, so a writer's mount cannot reach them; a mount
	// point also cannot be renamed away and replaced.
	if (repo.commonDir) args.push("--ro-bind", repo.commonDir, repo.commonDir);
	if (repo.linkFile) args.push("--ro-bind", repo.linkFile, repo.linkFile);
	args.push("--remount-ro", "/", "--chdir", realCwd);
	return { status: "ready", args, cwd: realCwd };
}

export function buildSandboxPlan(input: SandboxPlanInput): SandboxPlan {
	try {
		return plan(input);
	} catch (error) {
		return { status: "rejected", message: error instanceof Error ? error.message : String(error) };
	}
}
