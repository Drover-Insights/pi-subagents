import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	classifyExecutionGroup,
	classifySupervisor,
	type ExecutionGroup,
	type ProcReader,
	procReader,
	readSupervisorIdentity,
} from "../../src/broker/writer-group.ts";

function fsError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** A `/proc/<pid>/stat` line whose command name holds spaces and a `)`. */
function statLine(pid: number, state: string, startTime: string): string {
	const rest = [state, "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", startTime, "0"];
	return `${pid} (pi ) worker) ${rest.join(" ")}`;
}

type FakeProc = {
	bootId?: string | Error;
	stats?: Record<number, string | Error>;
	namespaces?: Record<string, string | Error>;
	signals?: Record<number, Error | undefined>;
};

function fakeReader(proc: FakeProc): ProcReader {
	const value = <T>(entry: T | Error | undefined, fallback: Error): T => {
		if (entry === undefined) throw fallback;
		if (entry instanceof Error) throw entry;
		return entry;
	};
	return {
		bootId: () => value(proc.bootId ?? "boot-1", fsError("EACCES")),
		stat: (pid) => value(proc.stats?.[pid], fsError("ENOENT")),
		pidNamespace: (pid) => value(proc.namespaces?.[String(pid)], fsError("EACCES")),
		signalZero: (pid) => {
			const error = proc.signals?.[pid];
			if (error) throw error;
		},
	};
}

const group: ExecutionGroup = { initPid: 400, startTime: "9000", pidNamespace: "pid:[4026534438]", bootId: "boot-1" };
const supervisorNamespace = "pid:[4026531836]";
const self = { self: supervisorNamespace };

describe("writer execution group proof", () => {
	test("a running init in its recorded namespace is running", () => {
		const reader = fakeReader({ stats: { 400: statLine(400, "S", "9000") }, namespaces: { ...self, 400: group.pidNamespace } });

		assert.equal(classifyExecutionGroup(group, supervisorNamespace, reader).state, "running");
	});

	test("an init that is gone, reused, or from an earlier boot proves the group empty", () => {
		const gone = fakeReader({ namespaces: self, signals: { 400: fsError("ESRCH") } });
		const otherUser = fakeReader({ namespaces: self, signals: { 400: fsError("EPERM") } });
		const reused = fakeReader({ stats: { 400: statLine(400, "S", "9999") }, namespaces: self });
		const rebooted = fakeReader({ bootId: "boot-2", namespaces: self });

		for (const reader of [gone, otherUser, reused, rebooted]) {
			assert.equal(classifyExecutionGroup(group, supervisorNamespace, reader).state, "empty");
		}
	});

	test("a missing stat file whose PID still answers a signal is not proof", () => {
		const reader = fakeReader({ namespaces: self });

		assert.equal(classifyExecutionGroup(group, supervisorNamespace, reader).state, "unknown");
	});

	test("a zombie init, an unreadable /proc, or an unreadable boot id leaves the group unproven", () => {
		const cases: [string, ProcReader][] = [
			["zombie", fakeReader({ stats: { 400: statLine(400, "Z", "9000") }, namespaces: self })],
			["dead", fakeReader({ stats: { 400: statLine(400, "X", "9000") }, namespaces: self })],
			["stat", fakeReader({ stats: { 400: fsError("EACCES") }, namespaces: self })],
			["boot", fakeReader({ bootId: fsError("ENOENT"), namespaces: self })],
			["malformed", fakeReader({ stats: { 400: "400 (pi) S" }, namespaces: self })],
		];
		for (const [name, reader] of cases) {
			const result = classifyExecutionGroup(group, supervisorNamespace, reader);
			assert.equal(result.state, "unknown", name);
			assert.ok(result.state === "unknown" && result.reason.length > 0, name);
		}
	});

	test("a live init in another PID namespace than the one recorded is an anomaly, not proof", () => {
		const reader = fakeReader({ stats: { 400: statLine(400, "S", "9000") }, namespaces: { ...self, 400: "pid:[1]" } });

		const result = classifyExecutionGroup(group, supervisorNamespace, reader);

		assert.equal(result.state, "unknown");
		assert.match(result.state === "unknown" ? result.reason : "", /namespace/);
	});

	test("host PIDs mean nothing from another supervisor PID namespace", () => {
		const reader = fakeReader({ namespaces: { self: "pid:[777]" }, signals: { 400: fsError("ESRCH") } });

		assert.equal(classifyExecutionGroup(group, supervisorNamespace, reader).state, "unknown");
	});

	test("a supervisor is dead only when gone, reused, a zombie, or from an earlier boot", () => {
		const supervisor = { pid: 50, startTime: "100", bootId: "boot-1" };
		const cases: [string, ProcReader, string][] = [
			["alive", fakeReader({ stats: { 50: statLine(50, "S", "100") } }), "alive"],
			["gone", fakeReader({ signals: { 50: fsError("ESRCH") } }), "dead"],
			["reused", fakeReader({ stats: { 50: statLine(50, "S", "101") } }), "dead"],
			["zombie", fakeReader({ stats: { 50: statLine(50, "Z", "100") } }), "dead"],
			["rebooted", fakeReader({ bootId: "boot-2" }), "dead"],
			["unreadable", fakeReader({ stats: { 50: fsError("EACCES") } }), "unknown"],
			["answers a signal", fakeReader({}), "unknown"],
		];
		for (const [name, reader, state] of cases) {
			assert.equal(classifySupervisor(supervisor, reader).state, state, name);
		}
	});

	test("the real /proc describes this process as a live supervisor", () => {
		const identity = readSupervisorIdentity(procReader);

		assert.equal(identity.pid, process.pid);
		assert.match(identity.startTime, /^\d+$/);
		assert.match(identity.pidNamespace, /^pid:\[\d+\]$/);
		assert.equal(classifySupervisor(identity, procReader).state, "alive");
	});
});
