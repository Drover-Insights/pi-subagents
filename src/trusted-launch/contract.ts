/**
 * The versioned contract trusted extensions use to launch a child through
 * this package's normal coordinator. Pi may load packages from separate
 * module roots, so the descriptor lives in one process-wide registry slot
 * rather than in module state.
 */

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

export interface TrustedSubagentsDescriptor {
	readonly version: typeof TRUSTED_LAUNCH_VERSION;
	/** Unique per publication; a reload publishes a new generation. */
	readonly generation: string;
	/** Not disposed, and still the descriptor in the registry slot. */
	isLive(): boolean;
	/** Never throws. Validates the request before any effect. */
	launch(request: unknown): Promise<TrustedLaunchResultV1>;
}

export type TrustedSubagentsResolution =
	| { status: "ok"; descriptor: TrustedSubagentsDescriptor }
	| { status: "missing" }
	| { status: "incompatible"; version: unknown };
