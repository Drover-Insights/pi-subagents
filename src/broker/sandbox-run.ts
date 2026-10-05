/**
 * Runs one command inside a bubblewrap sandbox planned by `buildSandboxPlan`.
 *
 * bwrap is executed by absolute path, with an empty environment, in its own
 * process group, and with the seccomp filter on fd 3. The plan's
 * `--die-with-parent` and pid namespace mean killing bwrap's process group
 * tears down every descendant, including `setsid`ed ones.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { buildSandboxPlan } from "./sandbox-plan.ts";
import { seccompFilter } from "./seccomp.ts";

export const BWRAP_PATH = "/usr/bin/bwrap";

const SECCOMP_FD = "3";
const PROBE_TIMEOUT_MS = 10_000;

export type SandboxProbe = { status: "available" } | { status: "unavailable"; message: string };

export type SandboxRunOptions = {
	stdin?: Buffer | string;
	/** Streams stdout and stderr chunks; the result buffers then stay empty, so output is never held twice. */
	onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Kill the command once stdout and stderr together exceed this many bytes. */
	maxOutputBytes?: number;
};

export type SandboxRunResult = {
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
	timedOut: boolean;
	aborted: boolean;
	/** The command was killed for exceeding `maxOutputBytes`. */
	overflowed: boolean;
};

function sandboxArgv(planArgs: readonly string[], command: readonly string[]): string[] {
	return ["--seccomp", SECCOMP_FD, ...planArgs, "--", ...command];
}

export function checkBwrapBinary(): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(BWRAP_PATH);
	} catch {
		return `${BWRAP_PATH} does not exist`;
	}
	if (!stat.isFile()) return `${BWRAP_PATH} is not a regular file`;
	if (stat.uid !== 0) return `${BWRAP_PATH} is not owned by root`;
	if ((stat.mode & 0o022) !== 0) return `${BWRAP_PATH} is group- or world-writable`;
	return undefined;
}

function probeRun(): string | undefined {
	const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-probe-"));
	try {
		const plan = buildSandboxPlan({ mode: "read-only", cwd: dir, protectedPaths: [] });
		if (plan.status !== "ready") return `sandbox plan rejected: ${plan.message}`;
		const blobPath = join(dir, "seccomp.bpf");
		writeFileSync(blobPath, seccompFilter());
		const blobFd = openSync(blobPath, "r");
		try {
			const result = spawnSync(BWRAP_PATH, sandboxArgv(plan.args, ["/usr/bin/true"]), {
				env: {},
				stdio: ["ignore", "ignore", "pipe", blobFd],
				timeout: PROBE_TIMEOUT_MS,
			});
			if (result.error) return `bwrap failed to run: ${result.error.message}`;
			if (result.status !== 0) {
				const stderr = result.stderr?.toString().trim() ?? "";
				return `bwrap exited with ${result.status ?? result.signal}${stderr ? `: ${stderr}` : ""}`;
			}
			return undefined;
		} finally {
			closeSync(blobFd);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Synchronous; never throws. */
export function probeSandbox(): SandboxProbe {
	try {
		const failure =
			checkBwrapBinary() ??
			(process.arch === "x64" || process.arch === "arm64"
				? undefined
				: `seccomp filter does not support architecture ${process.arch}`) ??
			probeRun();
		return failure === undefined ? { status: "available" } : { status: "unavailable", message: failure };
	} catch (error) {
		return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
	}
}

/** Never throws: it runs in timers and abort listeners, where a throw would crash the child. */
function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone, or no longer ours to signal.
	}
}

export function runInSandbox(
	planArgs: readonly string[],
	command: readonly string[],
	options: SandboxRunOptions = {},
): Promise<SandboxRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(BWRAP_PATH, sandboxArgv(planArgs, command), {
			env: {},
			detached: true,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		let aborted = false;
		let overflowed = false;
		let exited = false;
		let outputBytes = 0;
		let timer: NodeJS.Timeout | undefined;

		// A command that already exited finished on its own; a late timer or abort does not kill it.
		// Overflow always counts, since its data is dropped even after exit.
		const kill = (reason: "timeout" | "abort" | "overflow") => {
			if (reason === "overflow") overflowed = true;
			if (exited) return;
			if (reason === "timeout") timedOut = true;
			else if (reason === "abort") aborted = true;
			killGroup(child.pid);
		};
		const onAbort = () => kill("abort");
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		child.once("error", (error) => {
			if (exited) return;
			cleanup();
			killGroup(child.pid);
			reject(error);
		});
		child.once("exit", () => {
			exited = true;
		});
		child.once("close", (code) => {
			cleanup();
			const killed = timedOut || aborted || overflowed;
			resolve({
				exitCode: killed ? null : code,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				timedOut,
				aborted,
				overflowed,
			});
		});

		const collect = (into: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
			if (overflowed) return;
			outputBytes += chunk.length;
			if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
				kill("overflow");
				return;
			}
			if (options.onData) options.onData(chunk, stream);
			else into.push(chunk);
		};
		child.stdout?.on("data", collect(stdout, "stdout"));
		child.stderr?.on("data", collect(stderr, "stderr"));

		// Ignore EPIPE when bwrap exits before consuming its input.
		const seccompPipe = child.stdio[3] as Writable | null;
		seccompPipe?.on("error", () => {});
		seccompPipe?.end(seccompFilter());
		child.stdin?.on("error", () => {});
		if (options.stdin !== undefined) child.stdin?.end(options.stdin);
		else child.stdin?.end();

		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => kill("timeout"), options.timeoutMs);
		}
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
