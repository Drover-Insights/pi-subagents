/**
 * Pilot isolation: an unmanaged child runs unsandboxed as the parent's user,
 * so it could write the pilot attempt store. A parent therefore never runs a
 * pilot attempt and an unmanaged child at the same time.
 *
 * The parent's record of live children is `runningSubagents`, plus the
 * in-flight launches this module holds and the pilot children that left that
 * record before their exit was proven. A child whose liveness cannot be
 * checked counts as running.
 *
 * An unmanaged child can start processes the parent never sees and can forge
 * any proof of its own exit, so once this Pi process has run one it refuses
 * every later pilot launch and pilot resume until Pi restarts. The taint lives
 * on `globalThis` because Pi re-imports extension modules on reload.
 */
import { isCandidateGroupAlive, isTerminalRunState, readVerifiedRunManifest } from "../vf/run/types.ts";
import type { RunningSubagent } from "../types.ts";

/** How a child bears on the pilot attempt store. */
type IsolationClass = "pilot" | "unmanaged" | "managed";
/** The classes that never run beside each other. */
type ExclusiveClass = Exclude<IsolationClass, "managed">;

export interface IsolationChild {
	name: string;
	class: IsolationClass;
}

type Hold = { class: ExclusiveClass; names: string[] };

/** What the parent knows of a child, tracked or not: enough to classify it and check its liveness. */
type ChildRecord = Pick<
	RunningSubagent,
	"id" | "name" | "routing" | "mode" | "surface" | "timeoutKillFailed" | "childProcess" | "verifiedRunDir"
>;

const inFlight = new Set<Hold>();
/** Pilot children the parent stopped tracking before their exit was proven. */
const lingering = new Set<ChildRecord>();

const TAINT_KEY = Symbol.for("pi-subagents/pilot-isolation-tainted");

/** Record that this Pi process has run an unmanaged child; nothing but a restart clears it. */
export function noteUnmanagedChildRan(): void {
	(globalThis as Record<PropertyKey, unknown>)[TAINT_KEY] = true;
}

function isTainted(): boolean {
	return Boolean((globalThis as Record<PropertyKey, unknown>)[TAINT_KEY]);
}

/** A launch or child without managed routing evidence counts as unmanaged, which fails closed. */
export function isolationClassOf(
	evidence: { status: "managed"; pilotCase: string | null } | { status: "unmanaged" } | undefined,
): IsolationClass {
	if (evidence?.status !== "managed") return "unmanaged";
	// Only an explicit null exempts a managed child; anything else counts as a pilot.
	return evidence.pilotCase === null ? "managed" : "pilot";
}

function classifyRunningChild(running: ChildRecord): IsolationClass {
	return isolationClassOf(running.routing);
}

/** True only when the child's exit is proven; anything unknowable counts as running. */
function isProvenGone(running: ChildRecord): boolean {
	if (running.verifiedRunDir) {
		try {
			// A failed supervisor can mark its run terminal while candidates still run.
			const manifest = readVerifiedRunManifest(running.verifiedRunDir);
			return (
				isTerminalRunState(manifest.state) &&
				manifest.candidates.every((candidate) => !isCandidateGroupAlive(candidate.pgid))
			);
		} catch {
			return false;
		}
	}
	if (running.mode === "interactive") {
		// The runtime clears the surface once it closed the pane, and flags a close that failed.
		return running.surface === undefined && running.timeoutKillFailed !== true;
	}
	const child = running.childProcess;
	if (!child) return false;
	// No pid means the spawn itself failed: nothing ran.
	return child.pid === undefined || !isCandidateGroupAlive(child.pid);
}

/** The parent dropped `running` from its record; keep a pilot child counted until it is proven gone. */
export function noteChildUntracked(running: ChildRecord): void {
	if (classifyRunningChild(running) === "pilot" && !isProvenGone(running)) lingering.add(running);
}

function describe(running: ChildRecord): string {
	return `${running.name} (${running.id})`;
}

function conflicts(wanted: ExclusiveClass, tracked: Iterable<RunningSubagent>): string[] {
	const other = wanted === "pilot" ? "unmanaged" : "pilot";
	const found: string[] = [];
	for (const hold of inFlight) if (hold.class === other) found.push(...hold.names.map((name) => `${name} (launching)`));
	for (const running of tracked) if (classifyRunningChild(running) === other) found.push(describe(running));
	for (const running of lingering) {
		if (isProvenGone(running)) lingering.delete(running);
		else if (classifyRunningChild(running) === other) found.push(`${describe(running)}, exit not proven`);
	}
	return found;
}

export type IsolationHold = { status: "held"; release(): void } | { status: "refused"; message: string };

/**
 * Check `children` against what runs now and hold their class until they are
 * tracked. Synchronous, so two concurrent launches cannot both pass. Every
 * `held` result must be released once its children are in `tracked` or the
 * launch failed.
 */
export function acquirePilotIsolation(
	children: readonly IsolationChild[],
	tracked: Iterable<RunningSubagent>,
): IsolationHold {
	const pilots = children.filter((child) => child.class === "pilot").map((child) => child.name);
	const unmanaged = children.filter((child) => child.class === "unmanaged").map((child) => child.name);
	if (pilots.length > 0 && unmanaged.length > 0) {
		return {
			status: "refused",
			message: `a pilot launch cannot run alongside unmanaged children; launch these separately: ${unmanaged.join(", ")}`,
		};
	}
	if (pilots.length === 0 && unmanaged.length === 0) return { status: "held", release: () => {} };
	const hold: Hold = pilots.length > 0 ? { class: "pilot", names: pilots } : { class: "unmanaged", names: unmanaged };
	const found = conflicts(hold.class, tracked);
	if (hold.class === "pilot" && (isTainted() || found.length > 0)) {
		// Waiting for an unmanaged child never helps here, so the refusal names it without promising that.
		const running = found.length > 0 ? ` Still running: ${found.join(", ")}.` : "";
		return {
			status: "refused",
			message: `a pilot launch or resume is refused because this Pi process has run an unmanaged child, which may have left processes that can still write the pilot attempt store; restart Pi to run pilot launches.${running}`,
		};
	}
	if (found.length > 0) {
		const message = `an unmanaged launch waits until no pilot attempt of this session is open; still open: ${found.join(", ")}`;
		const unproven = found.some((entry) => entry.endsWith("exit not proven"));
		const recovery = unproven
			? " A child whose exit is not proven keeps counting until its process group is gone or its verified run ended; a pane child keeps counting until Pi restarts."
			: "";
		return { status: "refused", message: `${message}.${recovery}` };
	}
	// Before spawn, so a launch that later fails still taints.
	if (hold.class === "unmanaged") noteUnmanagedChildRan();
	inFlight.add(hold);
	return { status: "held", release: () => inFlight.delete(hold) };
}

export function resetPilotIsolationForTest(): void {
	inFlight.clear();
	lingering.clear();
	delete (globalThis as Record<PropertyKey, unknown>)[TAINT_KEY];
}
