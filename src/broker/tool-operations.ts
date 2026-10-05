/**
 * The file and shell operations behind the brokered tools. Each one is a
 * single argv command run in a fresh credential-blind sandbox planned for the
 * tool's working directory; no path is ever interpolated into a shell string.
 */
import { lstatSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { protectedBrokerPaths } from "./preflight.ts";
import { type BrokerMode, buildSandboxPlan } from "./sandbox-plan.ts";
import { runInSandbox, type SandboxRunOptions, type SandboxRunResult } from "./sandbox-run.ts";

/** The first regular file named one of `names`: Pi's managed bin first, then PATH. */
function resolveExecutable(names: readonly string[]): string | undefined {
	const isFile = (path: string) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	};
	const dirs = [join(getAgentConfigDir(), "bin"), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)];
	for (const name of names) {
		for (const dir of dirs) {
			const candidate = join(dir, name);
			if (isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Search binaries the sandbox runs by name; Debian ships fd as `fdfind`. */
const SEARCH_BINARIES: Readonly<Record<string, readonly string[]>> = { rg: ["rg"], fd: ["fd", "fdfind"] };

function brokerExecutables(): Record<string, string> {
	const found: Record<string, string> = {};
	for (const [name, candidates] of Object.entries(SEARCH_BINARIES)) {
		const path = resolveExecutable(candidates);
		if (path) found[name] = path;
	}
	return found;
}

/** Throws when the search binary `name` cannot be found, so a missing binary never reads as "no results". */
export function requireSearchBinary(name: "rg" | "fd"): void {
	if (!resolveExecutable(SEARCH_BINARIES[name])) {
		throw new Error(`${name === "rg" ? "ripgrep (rg)" : "fd"} is not available to the tool broker`);
	}
}

/** Bounds for one file operation: abortable, time-limited, and with capped output held in memory. */
const FILE_OP_TIMEOUT_MS = 120_000;
const FILE_OP_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** One tool call's confinement mode and the abort signal that stops its sandboxes. */
export type BrokerScope = { mode: BrokerMode; signal?: AbortSignal };

/**
 * Runs `command` in a sandbox for the scope's mode rooted at `cwd`. A rejected
 * plan throws. A bounded run, every operation but bash, gets the file-operation
 * time and output limits; a caller that passes its own signal handles its abort.
 */
export async function sandboxRun(
	scope: BrokerScope,
	cwd: string,
	command: readonly string[],
	options: SandboxRunOptions = {},
	bounded = true,
): Promise<SandboxRunResult> {
	const plan = buildSandboxPlan({ mode: scope.mode, cwd, ...protectedBrokerPaths(), executables: brokerExecutables() });
	if (plan.status === "rejected") throw new Error(`tool broker: ${plan.message}`);
	const result = await runInSandbox(plan.args, command, {
		...(bounded ? { timeoutMs: FILE_OP_TIMEOUT_MS, maxOutputBytes: FILE_OP_MAX_OUTPUT_BYTES } : {}),
		...(scope.signal ? { signal: scope.signal } : {}),
		...options,
	});
	if (result.aborted && bounded && !options.signal) throw new Error("Operation aborted");
	if (result.overflowed) throw new Error(`tool broker: output limit of ${FILE_OP_MAX_OUTPUT_BYTES} bytes exceeded`);
	if (result.timedOut && bounded) throw new Error(`tool broker: operation timed out after ${FILE_OP_TIMEOUT_MS} ms`);
	// bwrap reports its own setup failures, such as a command it cannot run, on stderr.
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0 && stderr.startsWith("bwrap: ")) throw new Error(`tool broker: ${stderr.trim()}`);
	return result;
}

function failure(result: SandboxRunResult, what: string): Error {
	const stderr = result.stderr.toString().trim();
	return new Error(stderr || `${what} failed with exit code ${result.exitCode}`);
}

/** Runs `command`, returning stdout and throwing stderr on a nonzero exit. */
async function checked(scope: BrokerScope, cwd: string, command: readonly string[], options?: SandboxRunOptions) {
	const result = await sandboxRun(scope, cwd, command, options);
	if (result.exitCode !== 0) throw failure(result, command[0] ?? "command");
	return result.stdout;
}

async function succeeds(scope: BrokerScope, cwd: string, command: readonly string[]): Promise<boolean> {
	return (await sandboxRun(scope, cwd, command)).exitCode === 0;
}

const readFile = (scope: BrokerScope, cwd: string) => (path: string) => checked(scope, cwd, ["/usr/bin/cat", "--", path]);

const writeFile = (scope: BrokerScope, cwd: string) => async (path: string, content: string) => {
	await checked(scope, cwd, ["/usr/bin/sh", "-c", 'cat > "$1"', "sh", path], { stdin: content });
};

const exists = (scope: BrokerScope, cwd: string) => (path: string) => succeeds(scope, cwd, ["/usr/bin/test", "-e", path]);

/** 0 for a directory, 1 for another existing entry, 2 when nothing exists. */
const KIND_SCRIPT = 'if [ -d "$1" ]; then exit 0; elif [ -e "$1" ]; then exit 1; else exit 2; fi';

/** Whether `path` is a directory; throws when it does not exist. */
export async function sandboxIsDirectory(scope: BrokerScope, cwd: string, path: string): Promise<boolean> {
	const result = await sandboxRun(scope, cwd, ["/usr/bin/sh", "-c", KIND_SCRIPT, "sh", path]);
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new Error(`Path not found: ${path}`);
}

export function sandboxReadText(scope: BrokerScope, cwd: string, path: string): Promise<string> {
	return readFile(scope, cwd)(path).then((buffer) => buffer.toString("utf-8"));
}

function sniffImage(bytes: Buffer): string | null {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
		return "image/webp";
	}
	return null;
}

export function readOperations(scope: BrokerScope, cwd: string): ReadOperations {
	return {
		readFile: readFile(scope, cwd),
		access: async (path) => {
			await checked(scope, cwd, ["/usr/bin/test", "-r", path]).catch(() => {
				throw new Error(`File is not readable: ${path}`);
			});
		},
		detectImageMimeType: async (path) => {
			const result = await sandboxRun(scope, cwd, ["/usr/bin/head", "-c", "16", "--", path]);
			return result.exitCode === 0 ? sniffImage(result.stdout) : null;
		},
	};
}

export function writeOperations(scope: BrokerScope, cwd: string): WriteOperations {
	return {
		writeFile: writeFile(scope, cwd),
		mkdir: async (dir) => {
			await checked(scope, cwd, ["/usr/bin/mkdir", "-p", "--", dir]);
		},
	};
}

export function editOperations(scope: BrokerScope, cwd: string): EditOperations {
	return {
		readFile: readFile(scope, cwd),
		writeFile: writeFile(scope, cwd),
		access: async (path) => {
			if (!(await succeeds(scope, cwd, ["/usr/bin/sh", "-c", 'test -r "$1" && test -w "$1"', "sh", path]))) {
				throw new Error(`File is not readable and writable: ${path}`);
			}
		},
	};
}

export function lsOperations(scope: BrokerScope, cwd: string): LsOperations {
	return {
		exists: exists(scope, cwd),
		stat: async (path) => {
			const directory = await sandboxIsDirectory(scope, cwd, path);
			return { isDirectory: () => directory };
		},
		readdir: async (path) => {
			const out = await checked(scope, cwd, ["/usr/bin/find", "-H", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]);
			return out
				.toString("utf-8")
				.split("\0")
				.filter((name) => name.length > 0);
		},
	};
}

/** Host-side metadata walk for a `.git` entry, as Pi's find does. */
function insideGitRepo(searchPath: string): boolean {
	for (let current = searchPath; ; ) {
		try {
			lstatSync(join(current, ".git"));
			return true;
		} catch {}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** `**\/name/**` becomes `name`; any other ignore glob passes to fd unchanged. */
function fdExclude(glob: string): string {
	const match = /^\*\*\/([^/*]+)\/\*\*$/.exec(glob);
	return match ? (match[1] as string) : glob;
}

export function findOperations(scope: BrokerScope, cwd: string): FindOperations {
	return {
		exists: exists(scope, cwd),
		glob: async (pattern, searchPath, { ignore, limit }) => {
			requireSearchBinary("fd");
			const args = ["fd", "--glob", "--color=never", "--hidden"];
			if (!insideGitRepo(searchPath)) args.push("--no-require-git");
			args.push("--max-results", String(limit));
			for (const glob of ignore) args.push("--exclude", fdExclude(glob));
			let effectivePattern = pattern;
			if (pattern.includes("/")) {
				args.push("--full-path");
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
					effectivePattern = `**/${pattern}`;
				}
			}
			args.push("--", effectivePattern, searchPath);
			const out = await checked(scope, cwd, args);
			return out
				.toString("utf-8")
				.split("\n")
				// Strip only the line terminator: leading and trailing spaces belong to the name.
				.map((line) => line.replace(/\r$/, ""))
				.filter((line) => line.length > 0)
				.map((line) => {
					const absolute = resolve(searchPath, line);
					return line.endsWith("/") && !absolute.endsWith("/") ? `${absolute}/` : absolute;
				});
		},
	};
}

export function bashOperations(scope: BrokerScope): BashOperations {
	return {
		// options.env carries session variables; it never reaches the sandbox.
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const result = await sandboxRun(scope, cwd, ["/usr/bin/bash", "-c", command], {
				onData,
				signal,
				timeoutMs: timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined,
			}, false);
			if (result.aborted) throw new Error("aborted");
			if (result.timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode: result.exitCode };
		},
	};
}
