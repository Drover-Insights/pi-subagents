/**
 * Surfaces managed children whose execution ownership cannot be proven, so a
 * parent that crashed, reloaded or switched sessions leaves them untouched
 * but visible, and their resumes stay blocked until they are settled.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { findManagedRecovery, type ManagedRecovery } from "../routing/managed-ownership.ts";

export function formatManagedRecovery(recovery: readonly ManagedRecovery[]): string {
	const lines = recovery.map((entry) => `- ${entry.sessionFile}: ${entry.reason}`);
	return [
		`${recovery.length} managed subagent session(s) are in recovery: their ownership cannot be proven, ` +
			"so they are left untouched and cannot be resumed.",
		...lines,
	].join("\n");
}

/** Warn about managed sessions in recovery; prints nothing when there are none. Never throws. */
export function reportManagedRecovery(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
	try {
		const recovery = findManagedRecovery(getAgentConfigDir());
		if (recovery.length > 0 && ctx.hasUI) ctx.ui.notify(formatManagedRecovery(recovery), "warning");
	} catch {
		// Recovery reporting is visibility only; resumes stay blocked either way.
	}
}
