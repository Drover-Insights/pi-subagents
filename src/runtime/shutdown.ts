import type { CompletedSubagentResult, ParentClosePolicy, ParentShutdownAction, RunningSubagent } from "../types.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { revalidateOwnedProcess, revalidateOwnedSurface } from "../routing/managed-ownership.ts";
import { clearSubagentShutdownTimer } from "./state.ts";

export type ShutdownSubagentsOptions = {
	escalationMs?: number;
};

export interface ShutdownRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	parentCloseEscalationMs: number;
	updateWidget(): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
}

/** A stop the parent refused because it cannot prove it owns the child's process; nothing was touched. */
export class StopRefusedError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`The subagent was left running: its ownership could not be proven (${reason}).`);
		this.name = "StopRefusedError";
		this.reason = reason;
	}
}

/**
 * Why the parent may not stop a managed child now, or null: its surface is
 * not the recorded one, or its process group's ownership does not
 * revalidate. Unmanaged children, and managed ones whose owner was never
 * recorded, are stopped through the handle and surface this parent created.
 */
export function stopOwnershipRefusal(running: RunningSubagent): string | null {
	if (running.ownershipToken === undefined) return null;
	const surfaceRefusal = revalidateOwnedSurface(getAgentConfigDir(), running);
	if (surfaceRefusal) return surfaceRefusal;
	const pid = running.childProcess?.pid;
	return pid ? revalidateOwnedProcess(getAgentConfigDir(), running, pid) : null;
}

export function terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void {
	if (!running.childProcess?.pid) return;
	// A managed child is signalled only once its durable ownership revalidates;
	// otherwise it is left untouched, and the reason stays on its record.
	const refusal = stopOwnershipRefusal(running);
	running.stopRefusal = refusal ?? undefined;
	if (refusal) return;
	// A writer's launcher dies at once from a stop signal, while the writer, the
	// init of its own PID namespace, ignores any signal it has no handler for.
	// While the launcher still holds the writer, its PID cannot be reused: signal
	// the writer itself, so the launcher's exit reports the writer's. SIGKILL
	// still reaches the whole group.
	const child = running.childProcess;
	if (signal !== "SIGKILL" && running.writerInitPid && child.exitCode === null && child.signalCode === null) {
		try {
			process.kill(running.writerInitPid, signal);
		} catch {}
		return;
	}
	try {
		process.kill(-running.childProcess.pid, signal);
	} catch {
		running.childProcess.kill(signal);
	}
}

function abortBackgroundSubagent(running: RunningSubagent, escalationMs: number): void {
	if (running.abortController) {
		running.abortController.abort();
		return;
	}

	terminateBackgroundChildProcess(running, "SIGTERM");
	if (!running.childProcess?.pid) return;
	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateBackgroundChildProcess(running, "SIGKILL");
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

async function terminateInteractiveSubagent(running: RunningSubagent, runtime: ShutdownRuntime): Promise<void> {
	running.abortController?.abort();
	try {
		await runtime.closeRunningSurface(running);
	} catch {}
}

export async function shutdownSubagentsForParentExit(
	runtime: ShutdownRuntime,
	options: ShutdownSubagentsOptions = {},
): Promise<
	Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}>
> {
	const escalationMs = options.escalationMs ?? runtime.parentCloseEscalationMs;
	const actions: Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}> = [];

	for (const agent of runtime.runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.allowSteerDelivery = false;
		agent.resultOwner = undefined;
		agent.deliveryState = "detached";

		if (agent.parentClosePolicy === "continue") {
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "continue",
			});
			continue;
		}

		// A child whose ownership cannot be proven is left untouched; its durable
		// owner record keeps it visible to the next session's recovery check.
		const refusal = stopOwnershipRefusal(agent);
		if (refusal) {
			agent.stopRefusal = refusal;
			actions.push({ id: agent.id, policy: agent.parentClosePolicy, action: "untouched" });
			continue;
		}
		actions.push({
			id: agent.id,
			policy: agent.parentClosePolicy,
			action: "terminate",
		});
		if (agent.mode === "interactive") {
			await terminateInteractiveSubagent(agent, runtime);
		} else {
			abortBackgroundSubagent(agent, escalationMs);
		}
	}

	runtime.runningSubagents.clear();
	runtime.completedSubagentResults.clear();
	runtime.updateWidget();
	return actions;
}
