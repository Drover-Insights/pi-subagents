/**
 * The versioned contract trusted extensions use to launch a child through
 * this package's normal coordinator. Pi may load packages from separate
 * module roots, so the descriptor lives in one process-wide registry slot
 * rather than in module state.
 */

import type { TrustedLaunchProvenance } from "../types.ts";

export type { TrustedLaunchProvenance };

export const TRUSTED_LAUNCH_REGISTRY_KEY = Symbol.for("drover.pi-subagents.trusted-launch");
export const TRUSTED_LAUNCH_VERSION = "pi-subagents.trusted-launch/v1" as const;

export type TrustedLaunchMode = "background" | "interactive";

export interface TrustedLaunchRequestV1 {
	readonly requestVersion: typeof TRUSTED_LAUNCH_VERSION;
	/** Caller operation identity; `[A-Za-z0-9._:-]`, at most 128 characters. */
	readonly requestId: string;
	readonly agent: string;
	/** Same lower-kebab handle rule as the `subagent` tool. */
	readonly name: string;
	readonly title: string;
	readonly task: string;
	/** Absolute, canonical (equal to its realpath), existing directory the child runs in. */
	readonly effectiveCwd: string;
	/** The mode the caller expects. An assertion checked against the agent definition, never an override. */
	readonly mode: TrustedLaunchMode;
	/** Passed to policy-bound authorization exactly as the `subagent` tool passes it. */
	readonly capabilityClass?: string;
	readonly pilotCase?: string;
	/** Opaque caller evidence persisted in launch metadata: at most 16 keys, values at most 256 characters. */
	readonly labels?: Readonly<Record<string, string>>;
}

export type TrustedLaunchRejection =
	| "descriptor_disposed"
	| "descriptor_replaced"
	| "unsupported_version"
	| "invalid_request"
	| "effective_cwd_invalid"
	| "agent_not_found"
	| "agent_unsupported"
	| "preparation_failed"
	| "mode_mismatch"
	| "synchronous_launch"
	| "launch_denied"
	| "policy_rejected"
	| "spawn_width"
	| "pilot_attempts_unavailable";

/** Why a trusted resume created nothing. */
export type TrustedResumeRejection =
	| "descriptor_disposed"
	| "descriptor_replaced"
	| "unsupported_version"
	| "invalid_request"
	| "session_not_found"
	| "not_trusted"
	| "unsupported_provenance"
	| "launch_request_mismatch"
	| "metadata_divergent"
	| "session_identity_mismatch"
	| "effective_cwd_invalid"
	| "effective_cwd_missing"
	| "effective_cwd_noncanonical"
	| "effective_cwd_revoked"
	| "effective_cwd_mismatch"
	| "synchronous_launch"
	| "resume_denied";

export type TrustedLaunchResultV1 =
	| {
			outcome: "launched";
			requestId: string;
			/** Runtime id of the running child, as `subagent_kill` and the widget know it. */
			runId: string;
			sessionFile: string;
			mode: TrustedLaunchMode;
			/** Herdr or other multiplexer surface of an interactive child. */
			surfaceId?: string;
			/** The directory persisted in the child's launch metadata. */
			effectiveCwd: string;
	  }
	/** Proven: no process, session, or surface was created. */
	| { outcome: "not_started"; reason: TrustedLaunchRejection; message: string }
	/** Launch began and its result is incomplete; a child may exist. */
	| { outcome: "unknown"; reason: string; message: string; partial?: { runId?: string; sessionFile?: string } };

/**
 * Resume a child this seam launched. Everything but the follow-up task comes
 * from the session's persisted launch authority, revalidated before any child
 * exists; the caller's fields are assertions against it, never overrides.
 */
export interface TrustedResumeRequestV1 {
	readonly requestVersion: typeof TRUSTED_LAUNCH_VERSION;
	/** This resume's operation identity; same rule as a launch `requestId`. */
	readonly requestId: string;
	/** Absolute session file a `launched` result returned. */
	readonly sessionFile: string;
	/** The `effectiveCwd` the `launched` result returned. */
	readonly effectiveCwd: string;
	/** The `requestId` of the launch that created the session. */
	readonly launchRequestId: string;
	/** Follow-up task for the resumed child. */
	readonly task?: string;
}

export type TrustedResumeResultV1 =
	| {
			outcome: "resumed";
			requestId: string;
			runId: string;
			sessionFile: string;
			mode: TrustedLaunchMode;
			surfaceId?: string;
			/** The persisted directory the child resumed in. */
			effectiveCwd: string;
			/** The original launch's provenance, unchanged by the resume. */
			launch: TrustedLaunchProvenance;
	  }
	/** Proven: no process, session, or surface was created. */
	| { outcome: "not_started"; reason: TrustedResumeRejection; message: string }
	/** Resume began and its result is incomplete; a child may exist. */
	| { outcome: "unknown"; reason: string; message: string; partial?: { runId?: string; sessionFile?: string } };

export interface TrustedSubagentsDescriptor {
	readonly version: typeof TRUSTED_LAUNCH_VERSION;
	/** Unique per publication; a reload publishes a new generation. */
	readonly generation: string;
	/** Not disposed, and still the descriptor in the registry slot. */
	isLive(): boolean;
	/** Never throws. Validates the request before any effect. */
	launch(request: unknown): Promise<TrustedLaunchResultV1>;
	/** Never throws. Validates the request and the persisted authority before any effect. */
	resume(request: unknown): Promise<TrustedResumeResultV1>;
}

export type TrustedSubagentsResolution =
	| { status: "ok"; descriptor: TrustedSubagentsDescriptor }
	| { status: "missing" }
	| { status: "incompatible"; version: unknown };
