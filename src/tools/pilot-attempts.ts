/**
 * The launch phase's pilot attempts: every pilot entry of one call gets a
 * receipt and reserves one durable attempt before any child spawns, all or
 * nothing. An attempt is refunded only with evidence its child never ran;
 * otherwise it stays consumed, marked for recovery when its fate is unknown.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { WriterSpawnError } from "../broker/writer-spawn.ts";
import {
	commitPilotAttempt,
	markPilotAttemptRecovery,
	type PilotAttemptHandle,
	type PilotReceipt,
	refundPilotAttempt,
	reservePilotAttempt,
} from "../routing/pilot-attempt-store.ts";
import { resolvePilotRuntimeIdentity } from "../routing/pilot-runtime-identity.ts";
import type { asSubagentToolResult } from "../runtime/state.ts";
import { policyRejection, type SubagentRouting } from "./subagent-routing.ts";

type ToolResult = ReturnType<typeof asSubagentToolResult>;

function getPilotAttemptRoot(): string {
	return join(getAgentConfigDir(), "pilot-attempts");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The receipt of every pilot entry, aligned with `routing`, built before
 * anything is written to the store. Any entry without a full receipt
 * rejects the whole call.
 */
export function preparePilotReceipts(
	routing: readonly SubagentRouting[],
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): (PilotReceipt | undefined)[] | ToolResult {
	const receipts: (PilotReceipt | undefined)[] = [];
	for (const entry of routing) {
		if (entry.evidence.status !== "managed" || entry.evidence.pilotCase === null) {
			receipts.push(undefined);
			continue;
		}
		const caseId = entry.evidence.pilotCase;
		// Authorization names the case; without its policy record no attempt can be counted.
		if (!entry.pilot || entry.pilot.caseId !== caseId) {
			return policyRejection("pilot_receipt_unavailable", `Pilot case ${caseId} has no policy record to count against`);
		}
		if (!ctx.model) {
			return policyRejection(
				"pilot_receipt_unavailable",
				`Pilot case ${caseId} needs a receipt, but the Controller has no model selected`,
			);
		}
		const controller = { provider: ctx.model.provider, model: ctx.model.id, effort: String(pi.getThinkingLevel()) };
		const identity = resolvePilotRuntimeIdentity(entry.evidence.route.provider);
		if (identity.status === "unavailable") {
			return policyRejection(
				"pilot_receipt_unavailable",
				`Pilot case ${caseId} needs a receipt, but its runtime identity is unavailable: ${identity.reason}`,
			);
		}
		receipts.push({
			generation: entry.evidence.generation,
			caseDigest: entry.pilot.caseDigest,
			controller,
			runtime: identity.runtime,
		});
	}
	return receipts;
}

/** Refund attempts whose child never started. Never throws: a refused refund stays consumed. */
export function refundPilotAttempts(handles: readonly (PilotAttemptHandle | undefined)[], evidence: string[]): void {
	for (const handle of handles) {
		if (!handle) continue;
		const refund = refundPilotAttempt(handle, evidence);
		if (refund.status === "refused") markPilotAttemptRecovery(handle, `refund refused: ${refund.reason}`);
	}
}

/**
 * Reserve one attempt for every pilot entry, aligned with `routing`. Any
 * refusal refunds the reservations already taken and rejects the whole call.
 */
export function reservePilotAttempts(
	routing: readonly SubagentRouting[],
	receipts: readonly (PilotReceipt | undefined)[],
	root: string = getPilotAttemptRoot(),
): (PilotAttemptHandle | undefined)[] | ToolResult {
	const handles: (PilotAttemptHandle | undefined)[] = [];
	for (const [index, entry] of routing.entries()) {
		const receipt = receipts[index];
		if (!entry.pilot || !receipt) {
			handles.push(undefined);
			continue;
		}
		const { caseId, caseDigest, allowed } = entry.pilot;
		const reservation = reservePilotAttempt(root, { caseId, caseDigest, allowed, launchId: entry.launchId, receipt });
		if (reservation.status === "reserved") {
			handles.push(reservation.handle);
			continue;
		}
		refundPilotAttempts(handles, ["another child of the same call was refused"]);
		let cause: string;
		switch (reservation.status) {
			case "replayed":
				cause = `launch id ${entry.launchId} was already used`;
				break;
			case "exhausted":
				cause = `all ${reservation.allowed} attempts are used`;
				break;
			default:
				cause = reservation.reason;
		}
		return policyRejection("pilot_attempts_unavailable", `Pilot case ${caseId} has no attempt available: ${cause}`);
	}
	return handles;
}

/** Commit the attempt of a child that is now running. Never throws. */
export function commitLaunchedPilotAttempt(handle: PilotAttemptHandle | undefined): void {
	if (!handle) return;
	const commit = commitPilotAttempt(handle);
	if (commit.status === "refused") markPilotAttemptRecovery(handle, `commit refused: ${commit.reason}`);
}

/**
 * Settle the attempt of the child whose launch threw. Only a writer bootstrap
 * proven never to have run is refunded, and only once its lease is released;
 * every other failure stays consumed and is marked for recovery.
 */
export function settleFailedPilotAttempt(
	handle: PilotAttemptHandle | undefined,
	error: unknown,
	leaseReleased: Promise<boolean>,
): void {
	if (!handle) return;
	const reason = errorMessage(error);
	if (!(error instanceof WriterSpawnError && error.nothingRunning)) {
		markPilotAttemptRecovery(handle, reason);
		return;
	}
	void leaseReleased.then(
		(released) => {
			if (released) refundPilotAttempts([handle], [`the writer bootstrap never ran: ${reason}`]);
			else markPilotAttemptRecovery(handle, reason);
		},
		() => markPilotAttemptRecovery(handle, reason),
	);
}
