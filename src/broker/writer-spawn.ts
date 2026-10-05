/**
 * Starts a managed writer as the init of its own PID namespace.
 *
 * The child runs under an outer bubblewrap with a new user and PID namespace
 * and the host filesystem bound as it is; it is a process boundary, not a
 * filesystem one (each tool call still gets its own credential-blind
 * sandbox). `--as-pid-1` makes the child itself the namespace init, so the
 * namespace ends exactly when the child exits. `--info-fd` reports the init's
 * host PID and namespace, and `--block-fd` holds the child before it runs
 * until its execution group is recorded. There is no `--die-with-parent`: a
 * writer outlives a crashed parent, and its lease waits for proof that its
 * group ended.
 */
import { type ChildProcess, spawn, spawnSync, type StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { BWRAP_PATH, checkBwrapBinary, type SandboxProbe } from "./sandbox-run.ts";
import { type ExecutionGroup, type ProcReader, procReader, readExecutionGroup, readSupervisorIdentity } from "./writer-group.ts";
import { awaitGroupsEmpty, type WriterLease } from "./writer-lease.ts";

const INFO_FD = "3";
const BLOCK_FD = "4";
const INFO_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 10_000;
const KILL_PROOF_TIMEOUT_MS = 5_000;

type ChildStdio = "ignore" | "pipe";

export type WriterSpawnOptions = {
	command: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdio: [ChildStdio, ChildStdio, ChildStdio];
	/** Persist the group; runs before the child is released, and a throw keeps it from ever running. */
	recordGroup(group: ExecutionGroup): void;
	reader?: ProcReader;
};

/** A writer that did not start. `nothingRunning` is true only when no process of its launch can remain. */
export class WriterSpawnError extends Error {
	readonly nothingRunning: boolean;
	constructor(message: string, nothingRunning: boolean) {
		super(message);
		this.name = "WriterSpawnError";
		this.nothingRunning = nothingRunning;
	}
}

function namespaceArgs(cwd: string): string[] {
	return [
		"--unshare-user",
		"--unshare-pid",
		"--as-pid-1",
		"--bind",
		"/",
		"/",
		"--dev-bind",
		"/dev",
		"/dev",
		"--proc",
		"/proc",
		"--chdir",
		cwd,
	];
}

/** Resolve with bwrap's info JSON as soon as it is complete. */
function readInfo(stream: Readable, child: ChildProcess): Promise<{ "child-pid": number; "pid-namespace": number }> {
	return new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => finish(new Error("bubblewrap did not report its child in time")), INFO_TIMEOUT_MS);
		const finish = (error: Error | null, info?: { "child-pid": number; "pid-namespace": number }) => {
			clearTimeout(timer);
			stream.removeAllListeners("data");
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
			if (error) reject(error);
			else resolve(info as { "child-pid": number; "pid-namespace": number });
		};
		const onExit = (code: number | null, signal: string | null) =>
			finish(new Error(`bubblewrap exited before starting the writer (${signal ?? code})`));
		const onError = (error: Error) => finish(error);
		stream.on("data", (chunk: Buffer) => {
			text += chunk.toString();
			let info: unknown;
			try {
				info = JSON.parse(text);
			} catch {
				return;
			}
			const record = info as Record<string, unknown>;
			if (!Number.isSafeInteger(record["child-pid"]) || !Number.isSafeInteger(record["pid-namespace"])) {
				finish(new Error("bubblewrap reported no child PID or PID namespace"));
				return;
			}
			finish(null, info as { "child-pid": number; "pid-namespace": number });
		});
		stream.on("error", () => {});
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function groupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (error) {
		return (error as { code?: string }).code === "ESRCH";
	}
}

/**
 * Kill a launch that never released its child. The init is held before it
 * runs and has not left the launcher's process group, so an empty process
 * group proves nothing of this launch remains.
 */
async function killUnreleased(child: ChildProcess): Promise<boolean> {
	const pgid = child.pid;
	if (pgid === undefined) return true;
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {}
	const end = Date.now() + KILL_PROOF_TIMEOUT_MS;
	while (!groupGone(pgid)) {
		if (Date.now() > end) return false;
		await delay(10);
	}
	return true;
}

/** Spawn a writer child. Resolves once its group is recorded and it is released to run. */
export async function spawnWriterChild(options: WriterSpawnOptions): Promise<ChildProcess> {
	const reader = options.reader ?? procReader;
	const stdio: StdioOptions = [...options.stdio, "pipe", "pipe"];
	const child = spawn(
		BWRAP_PATH,
		["--info-fd", INFO_FD, "--block-fd", BLOCK_FD, ...namespaceArgs(options.cwd), "--", options.command, ...options.args],
		{ cwd: options.cwd, env: options.env, detached: true, stdio },
	);
	const infoStream = child.stdio[3] as Readable;
	const gate = child.stdio[4] as Writable;
	gate.on("error", () => {});
	try {
		const info = await readInfo(infoStream, child);
		const pidNamespace = `pid:[${info["pid-namespace"]}]`;
		const actual = reader.pidNamespace(info["child-pid"]);
		if (actual !== pidNamespace) {
			throw new Error(`the writer's init runs in PID namespace ${actual}, not the reported ${pidNamespace}`);
		}
		if (actual === reader.pidNamespace("self")) throw new Error("the writer's init shares the parent's PID namespace");
		options.recordGroup(readExecutionGroup(info["child-pid"], pidNamespace, reader));
	} catch (error) {
		// Never close the gate on failure: end of file would release the child.
		// Once the launch is proven gone there is no child left to release.
		const nothingRunning = await killUnreleased(child);
		// Otherwise the gate stays open, without holding this process alive.
		if (nothingRunning) gate.destroy();
		else (gate as Writable & { unref?: () => void }).unref?.();
		infoStream.destroy();
		const message = error instanceof Error ? error.message : String(error);
		throw new WriterSpawnError(`the writer could not start in its own PID namespace: ${message}`, nothingRunning);
	}
	gate.end("1");
	infoStream.destroy();
	return child;
}

/** How long a stopped generation may take to be proven empty before the next one is refused. */
const PREVIOUS_GENERATION_PROOF_MS = 2_000;

/** Throw unless every recorded generation of the lease is proven empty; the gate before a next generation. */
export async function requireEarlierGenerationsEmpty(lease: WriterLease, reader?: ProcReader): Promise<void> {
	const previous = await awaitGroupsEmpty(lease, PREVIOUS_GENERATION_PROOF_MS, { reader });
	if (!previous.proven) {
		throw new Error(`The previous generation's execution group is not proven empty: ${previous.reason}`);
	}
}

/** Start generation `generation` of a leased writer, which runs only in the leased worktree. */
export async function spawnLeasedWriter(
	lease: WriterLease,
	generation: number,
	options: Omit<WriterSpawnOptions, "recordGroup">,
): Promise<{ child: ChildProcess; group: ExecutionGroup }> {
	if (options.cwd !== lease.worktree) {
		throw new WriterSpawnError(`the writer would run in ${options.cwd}, not its leased worktree ${lease.worktree}`, true);
	}
	let recorded: ExecutionGroup | undefined;
	try {
		const child = await spawnWriterChild({
			...options,
			recordGroup: (group) => {
				lease.recordGroup(group, generation);
				recorded = group;
			},
		});
		return { child, group: recorded as ExecutionGroup };
	} catch (error) {
		if (error instanceof WriterSpawnError && !error.nothingRunning) {
			try {
				lease.markSpawnUnproven(error.message);
			} catch {
				// The lease still holds the mark in memory; the spawn error is what the caller must see.
			}
		}
		throw error;
	}
}

/**
 * Whether this host can run a writer as the init of its own PID namespace,
 * with nested tool sandboxes, and read the identity inputs that prove its
 * group ended. Synchronous; never throws.
 */
export function probeWriterConfinement(reader: ProcReader = procReader): SandboxProbe {
	try {
		const binary = checkBwrapBinary();
		if (binary) return { status: "unavailable", message: binary };
		readSupervisorIdentity(reader);
		const nested = `${BWRAP_PATH} --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --ro-bind / / --proc /proc --dev /dev /usr/bin/true`;
		const result = spawnSync(BWRAP_PATH, [...namespaceArgs("/"), "--", "/bin/sh", "-c", `[ "$$" = 1 ] && ${nested}`], {
			env: { PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "ignore", "pipe"],
			timeout: PROBE_TIMEOUT_MS,
		});
		if (result.error) return { status: "unavailable", message: `bwrap failed to run: ${result.error.message}` };
		if (result.status !== 0) {
			const stderr = result.stderr?.toString().trim() ?? "";
			return {
				status: "unavailable",
				message: `cannot run a writer in its own PID namespace (exit ${result.status ?? result.signal})${stderr ? `: ${stderr}` : ""}`,
			};
		}
		return { status: "available" };
	} catch (error) {
		return {
			status: "unavailable",
			message: `cannot read the writer's identity inputs: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
