/**
 * The launch phase's writer leases: every writer entry of one call holds its
 * worktree's lease before any child spawns, all or nothing.
 */
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { acquireWriterLease, releaseWhenEmpty, type WriterLease } from "../broker/writer-lease.ts";
import { WriterSpawnError } from "../broker/writer-spawn.ts";
import { validateWriterWorktree } from "../broker/writer-worktree.ts";
import type { asSubagentToolResult } from "../runtime/state.ts";
import { policyRejection, type SubagentRouting } from "./subagent-routing.ts";

export type AcquireWriterLease = typeof acquireWriterLease;

export function getWriterLeaseRoot(): string {
	return join(getAgentConfigDir(), "writer-leases");
}

/** Release leases whose child never spawned. Never throws: a lease that cannot be released stays held. */
function releaseUnspawned(leases: readonly (WriterLease | undefined)[], reason: string): void {
	for (const lease of leases) {
		try {
			lease?.releaseUnspawned(reason);
		} catch (error) {
			lease?.markForRecovery(`releasing the unspawned lease failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/**
 * Acquire the lease of every writer entry, then validate each worktree again
 * under its lease. Any refusal or change releases every lease taken and
 * rejects the whole call. Returns leases aligned with `routing`.
 */
export function acquireWriterLeases(
	routing: readonly SubagentRouting[],
	parentCwd: string,
	acquire: AcquireWriterLease = acquireWriterLease,
): (WriterLease | undefined)[] | ReturnType<typeof asSubagentToolResult> {
	const leases: (WriterLease | undefined)[] = [];
	const root = getWriterLeaseRoot();
	for (const entry of routing) {
		const worktree = entry.writerWorktree;
		if (!worktree || entry.evidence.status !== "managed") {
			leases.push(undefined);
			continue;
		}
		const acquired = acquire(root, { worktree, launchId: entry.launchId, policyGeneration: entry.evidence.generation });
		if (acquired.status !== "acquired") {
			releaseUnspawned(leases, "another writer lease of the same call was refused");
			return acquired.status === "held"
				? policyRejection("writer_lease_held", `the worktree ${worktree.top} already has a writer: ${acquired.reason}`)
				: policyRejection("writer_confinement_unavailable", acquired.reason);
		}
		leases.push(acquired.lease);
	}
	for (const entry of routing) {
		const worktree = entry.writerWorktree;
		if (!worktree) continue;
		const again = validateWriterWorktree(worktree.top, parentCwd);
		if (again.status !== "valid" || !isDeepStrictEqual(again.worktree, worktree)) {
			releaseUnspawned(leases, "the worktree changed before launch");
			const detail = again.status === "invalid" ? again.message : "its branch, HEAD, or Git directories changed";
			return policyRejection(
				"writer_worktree_invalid",
				`the worktree ${worktree.top} changed while its writer lease was acquired: ${detail}`,
			);
		}
	}
	return leases;
}

/**
 * Return the leases of children whose launch did not start. Only a launch
 * that proved nothing of it runs releases at once; otherwise the lease waits
 * for proof that its execution group ended.
 */
export function releaseUnlaunchedWriterLeases(leases: readonly (WriterLease | undefined)[], error: unknown): void {
	const [failed, ...neverStarted] = leases;
	releaseUnspawned(neverStarted, "an earlier child of the same call failed to launch");
	if (!failed) return;
	if (error instanceof WriterSpawnError && !error.nothingRunning) {
		void releaseWhenEmpty(failed);
		return;
	}
	try {
		failed.releaseUnspawned(error instanceof Error ? error.message : String(error));
	} catch {
		// A group or an unproven spawn is recorded: only proof releases it.
		void releaseWhenEmpty(failed);
	}
}
