/** A writer lease store over a fake /proc, for the lease store's tests. */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionGroup, ProcReader, SupervisorIdentity } from "../../src/broker/writer-group.ts";
import { acquireWriterLease, type WriterLeaseRequest } from "../../src/broker/writer-lease.ts";
import "./temp-root.ts";
import { writerRepo } from "./writer-repo.ts";

export function storeRoot(): string {
	return join(realpathSync(mkdtempSync(join(tmpdir(), "writer-lease-"))), "writer-leases");
}

/** One real linked worktree for every lease of a test file: a release inspects the leased tree. */
export const LEASED = writerRepo();
process.on("exit", () => rmSync(LEASED.root, { recursive: true, force: true }));

export function request(launchId = "call-1"): WriterLeaseRequest {
	return {
		worktree: { top: LEASED.linked, gitDir: LEASED.gitDir, commonDir: LEASED.common, branch: "task", head: LEASED.head },
		launchId,
		policyGeneration: "gen-7",
	};
}

export const SELF_NS = "pid:[4026531836]";
export const supervisor: SupervisorIdentity = { pid: 50, startTime: "100", pidNamespace: SELF_NS, bootId: "boot-1" };
export const group: ExecutionGroup = { initPid: 400, startTime: "9000", pidNamespace: "pid:[4026534438]", bootId: "boot-1" };

export function statLine(pid: number, state: string, startTime: string): string {
	const rest = [state, "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", startTime];
	return `${pid} (pi) ${rest.join(" ")}`;
}

/** A fake /proc: each listed PID is running (or in the given state) with the given start time; others are gone. */
export function proc(processes: Record<number, [string, string]>, bootId = "boot-1"): ProcReader {
	return {
		bootId: () => bootId,
		stat: (pid) => {
			const entry = processes[pid];
			if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return statLine(pid, entry[0], entry[1]);
		},
		pidNamespace: (pid) => (pid === "self" ? SELF_NS : group.pidNamespace),
		signalZero: (pid) => {
			if (!processes[pid]) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		},
	};
}

export const supervisorAlive = proc({ 50: ["S", "100"] });

export function files(root: string): string[] {
	const [key] = readdirSync(root);
	return readdirSync(join(root, key as string))
		.filter((name) => name !== "tmp")
		.sort();
}

export function acquired(root: string, reader: ProcReader, launchId?: string) {
	const result = acquireWriterLease(root, request(launchId), { reader, supervisor });
	assert.equal(result.status, "acquired", JSON.stringify(result));
	if (result.status !== "acquired") throw new Error("unreachable");
	return result.lease;
}

