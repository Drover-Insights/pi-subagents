/**
 * Proof that a managed writer's execution group has ended.
 *
 * A writer runs as the init of its own PID namespace. When that init exits,
 * the kernel kills and reaps every other member before the init itself is
 * reaped, so "the init is gone" proves the whole group is gone, including
 * `setsid`ed descendants and nested tool sandboxes. The group is identified by
 * the init's host PID, its start time, its PID-namespace inode, and the host
 * boot id; a reused PID has another start time, and a reboot ends everything.
 */
import { readFileSync, readlinkSync } from "node:fs";

export type ExecutionGroup = {
	/** Host PID of the namespace init. */
	initPid: number;
	/** Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. */
	startTime: string;
	/** `pid:[<inode>]`, as `/proc/<pid>/ns/pid` reads. */
	pidNamespace: string;
	bootId: string;
};

export type SupervisorIdentity = { pid: number; startTime: string; pidNamespace: string; bootId: string };

/** The `/proc` reads the proof needs; injectable so tests can cover PID reuse and reboots. */
export interface ProcReader {
	bootId(): string;
	stat(pid: number): string;
	pidNamespace(pid: number | "self"): string;
	/** `process.kill(pid, 0)`. */
	signalZero(pid: number): void;
}

export const procReader: ProcReader = {
	bootId: () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
	stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
	pidNamespace: (pid) => readlinkSync(`/proc/${pid}/ns/pid`),
	signalZero: (pid) => {
		process.kill(pid, 0);
	},
};

export type GroupState =
	| { state: "running" }
	| { state: "empty"; evidence: string }
	| { state: "unknown"; reason: string };

export type SupervisorState = { state: "alive" } | { state: "dead"; evidence: string } | { state: "unknown"; reason: string };

function errorCode(error: unknown): string {
	return (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.message : String(error));
}

type ProcessLook =
	| { kind: "gone"; evidence: string }
	| { kind: "present"; state: string }
	| { kind: "unknown"; reason: string };

/** One snapshot of a process's state, judged against the start time it was recorded with. */
function lookAt(pid: number, startTime: string, reader: ProcReader): ProcessLook {
	let stat: string;
	try {
		stat = reader.stat(pid);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return { kind: "unknown", reason: `cannot read /proc/${pid}/stat: ${errorCode(error)}` };
		try {
			reader.signalZero(pid);
		} catch (signalError) {
			const code = errorCode(signalError);
			// EPERM: the PID now belongs to a process of another user, so not ours.
			if (code === "ESRCH" || code === "EPERM") return { kind: "gone", evidence: `process ${pid} is gone (${code})` };
			return { kind: "unknown", reason: `cannot signal process ${pid}: ${code}` };
		}
		return { kind: "unknown", reason: `/proc/${pid}/stat is missing but process ${pid} still answers a signal` };
	}
	// The command name may hold spaces and `)`, so parse after the last `)`.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
	const state = fields[0];
	const started = fields[19];
	if (!state || !started || !/^\d+$/.test(started)) return { kind: "unknown", reason: `malformed /proc/${pid}/stat` };
	if (started !== startTime) {
		return { kind: "gone", evidence: `PID ${pid} now belongs to a process started at ${started}, not ${startTime}` };
	}
	return { kind: "present", state };
}

function bootChanged(bootId: string, reader: ProcReader): { changed: true; evidence: string } | { changed: false } | { reason: string } {
	let current: string;
	try {
		current = reader.bootId();
	} catch (error) {
		return { reason: `cannot read boot_id: ${errorCode(error)}` };
	}
	return current === bootId ? { changed: false } : { changed: true, evidence: `the host rebooted (boot_id ${current})` };
}

/** Whether a recorded execution group is proven empty. Never throws. */
export function classifyExecutionGroup(
	group: ExecutionGroup,
	supervisorPidNamespace: string,
	reader: ProcReader = procReader,
): GroupState {
	try {
		const boot = bootChanged(group.bootId, reader);
		if ("reason" in boot) return { state: "unknown", reason: boot.reason };
		if (boot.changed) return { state: "empty", evidence: boot.evidence };
		const own = reader.pidNamespace("self");
		if (own !== supervisorPidNamespace) {
			return {
				state: "unknown",
				reason: `this process runs in PID namespace ${own}, not the supervisor's ${supervisorPidNamespace}`,
			};
		}
		const look = lookAt(group.initPid, group.startTime, reader);
		if (look.kind === "gone") return { state: "empty", evidence: look.evidence };
		if (look.kind === "unknown") return { state: "unknown", reason: look.reason };
		if (look.state === "Z" || look.state === "X") {
			return { state: "unknown", reason: `init ${group.initPid} is a zombie that has not been reaped` };
		}
		const namespace = reader.pidNamespace(group.initPid);
		if (namespace !== group.pidNamespace) {
			return {
				state: "unknown",
				reason: `init ${group.initPid} runs in PID namespace ${namespace}, not the recorded ${group.pidNamespace}`,
			};
		}
		return { state: "running" };
	} catch (error) {
		return { state: "unknown", reason: `cannot read the execution group: ${errorCode(error)}` };
	}
}

/** Whether a lease's supervising parent is dead. Never throws. */
export function classifySupervisor(
	supervisor: Pick<SupervisorIdentity, "pid" | "startTime" | "bootId">,
	reader: ProcReader = procReader,
): SupervisorState {
	try {
		const boot = bootChanged(supervisor.bootId, reader);
		if ("reason" in boot) return { state: "unknown", reason: boot.reason };
		if (boot.changed) return { state: "dead", evidence: boot.evidence };
		const look = lookAt(supervisor.pid, supervisor.startTime, reader);
		if (look.kind === "gone") return { state: "dead", evidence: look.evidence };
		if (look.kind === "unknown") return { state: "unknown", reason: look.reason };
		if (look.state === "Z" || look.state === "X") {
			return { state: "dead", evidence: `supervisor ${supervisor.pid} has exited` };
		}
		return { state: "alive" };
	} catch (error) {
		return { state: "unknown", reason: `cannot read the supervisor: ${errorCode(error)}` };
	}
}

function startTimeOf(pid: number, reader: ProcReader): string {
	const stat = reader.stat(pid);
	const started = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[19];
	if (!started || !/^\d+$/.test(started)) throw new Error(`malformed /proc/${pid}/stat`);
	return started;
}

/** This process's identity as a lease supervisor. Throws when `/proc` cannot provide it. */
export function readSupervisorIdentity(reader: ProcReader = procReader): SupervisorIdentity {
	return {
		pid: process.pid,
		startTime: startTimeOf(process.pid, reader),
		pidNamespace: reader.pidNamespace("self"),
		bootId: reader.bootId(),
	};
}

/** The identity of a freshly started namespace init, read before it is released to run. */
export function readExecutionGroup(initPid: number, pidNamespace: string, reader: ProcReader = procReader): ExecutionGroup {
	return { initPid, startTime: startTimeOf(initPid, reader), pidNamespace, bootId: reader.bootId() };
}
