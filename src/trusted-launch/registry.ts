import { randomUUID } from "node:crypto";
import {
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
	type TrustedResumeRequestV1,
	type TrustedResumeResultV1,
	type TrustedSubagentsDescriptor,
	type TrustedSubagentsResolution,
} from "./contract.ts";
import { validateTrustedLaunchRequest, validateTrustedResumeRequest } from "./request.ts";

/** The publishing descriptor, as its launcher sees it. */
interface TrustedLaunchOwner {
	readonly generation: string;
	/** False once the descriptor is disposed or replaced, including mid-launch. */
	isLive(): boolean;
}

/** Launches one validated request. A throw means the launch outcome is unknown. */
export type TrustedLauncher = (request: TrustedLaunchRequestV1, owner: TrustedLaunchOwner) => Promise<TrustedLaunchResultV1>;

/** Resumes one validated request. A throw means the resume outcome is unknown. */
export type TrustedResumer = (request: TrustedResumeRequestV1, owner: TrustedLaunchOwner) => Promise<TrustedResumeResultV1>;

export interface TrustedSubagentsHandlers {
	launch: TrustedLauncher;
	resume: TrustedResumer;
}

export interface TrustedSubagentsPublication {
	readonly descriptor: TrustedSubagentsDescriptor;
	/** Retire this descriptor; removes it from the registry only while it still owns the slot. */
	dispose(): void;
}

/** The registry slot value. Its object identity is the owner token. */
type RegistryRecord = Readonly<{ descriptor: TrustedSubagentsDescriptor }>;

type GlobalRegistry = Record<symbol, unknown>;

function readSlot(): unknown {
	return (globalThis as GlobalRegistry)[TRUSTED_LAUNCH_REGISTRY_KEY];
}

/**
 * Publish this package instance's descriptor. Refuses while any descriptor
 * holds the slot, so two package instances never both launch.
 */
export function publishTrustedSubagents(handlers: TrustedSubagentsHandlers): TrustedSubagentsPublication {
	const existing = readSlot() as RegistryRecord | undefined;
	if (existing !== undefined) {
		throw new Error(
			"A pi-subagents trusted launch descriptor is already published in this process; dispose it before publishing another.",
		);
	}
	const generation = randomUUID();
	let disposed = false;
	let record: RegistryRecord;
	const ownsSlot = () => readSlot() === record;
	const isLive = () => !disposed && ownsSlot();
	/**
	 * Refuse a retired descriptor and an invalid request before any effect, then
	 * run the handler; a throw from it means the outcome is unknown.
	 */
	async function guarded<Request, Rejection extends string, Result>(
		input: unknown,
		validate: (raw: unknown) => { ok: true; request: Request } | { ok: false; reason: Rejection; message: string },
		run: (request: Request, owner: TrustedLaunchOwner) => Promise<Result>,
	): Promise<Result | { outcome: "not_started"; reason: Rejection | "invalid_request" | "descriptor_disposed" | "descriptor_replaced"; message: string } | { outcome: "unknown"; reason: string; message: string }> {
		if (disposed) {
			return { outcome: "not_started", reason: "descriptor_disposed", message: "This descriptor was disposed." };
		}
		if (!ownsSlot()) {
			return {
				outcome: "not_started",
				reason: "descriptor_replaced",
				message: "This descriptor no longer owns the registry slot.",
			};
		}
		let validation: ReturnType<typeof validate>;
		try {
			validation = validate(input);
		} catch (error) {
			// Validation is written not to throw; this keeps the descriptor total anyway.
			return {
				outcome: "not_started",
				reason: "invalid_request",
				message: `The request could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (!validation.ok) {
			return { outcome: "not_started", reason: validation.reason, message: validation.message };
		}
		try {
			return await run(validation.request, { generation, isLive });
		} catch (error) {
			return {
				outcome: "unknown",
				reason: "launcher_failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
	const descriptor: TrustedSubagentsDescriptor = Object.freeze({
		version: TRUSTED_LAUNCH_VERSION,
		generation,
		isLive,
		launch: (input: unknown): Promise<TrustedLaunchResultV1> =>
			guarded(input, validateTrustedLaunchRequest, handlers.launch),
		resume: (input: unknown): Promise<TrustedResumeResultV1> =>
			guarded(input, validateTrustedResumeRequest, handlers.resume),
	});
	record = Object.freeze({ descriptor });
	(globalThis as GlobalRegistry)[TRUSTED_LAUNCH_REGISTRY_KEY] = record;
	return {
		descriptor,
		dispose() {
			disposed = true;
			if (ownsSlot()) delete (globalThis as GlobalRegistry)[TRUSTED_LAUNCH_REGISTRY_KEY];
		},
	};
}

/** Find the live descriptor and check its contract version before use. */
export function resolveTrustedSubagents(expectedVersion: string): TrustedSubagentsResolution {
	const record = readSlot() as Partial<RegistryRecord> | undefined;
	const descriptor = record?.descriptor;
	if (!descriptor) return { status: "missing" };
	if (descriptor.version !== expectedVersion) return { status: "incompatible", version: descriptor.version };
	if (typeof descriptor.isLive !== "function" || !descriptor.isLive()) return { status: "missing" };
	return { status: "ok", descriptor };
}
