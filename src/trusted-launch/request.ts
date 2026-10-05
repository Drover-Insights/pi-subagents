import { isAbsolute } from "node:path";
import { types } from "node:util";
import { getSubagentNameError } from "../agents/titles.ts";
import {
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchRejection,
	type TrustedLaunchRequestV1,
	type TrustedResumeRejection,
	type TrustedResumeRequestV1,
	type TrustedTerminateRequestV1,
} from "./contract.ts";
import { getEffectiveCwdError } from "./effective-cwd.ts";

const REQUIRED_STRING_KEYS = ["requestId", "agent", "name", "title", "task", "effectiveCwd"] as const;
const OPTIONAL_STRING_KEYS = ["capabilityClass", "pilotCase"] as const;
const KNOWN_KEYS = new Set<string>([
	"requestVersion",
	"mode",
	"labels",
	...REQUIRED_STRING_KEYS,
	...OPTIONAL_STRING_KEYS,
]);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LABEL_KEY = /^[a-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_LABELS = 16;
const MAX_LABEL_VALUE = 256;

export type TrustedRequestValidation =
	| { ok: true; request: TrustedLaunchRequestV1 }
	| { ok: false; reason: TrustedLaunchRejection; message: string };

function reject(reason: TrustedLaunchRejection, message: string): TrustedRequestValidation {
	return { ok: false, reason, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getLabelsError(labels: unknown): string | null {
	if (labels === undefined) return null;
	if (!isRecord(labels)) return "labels must be an object of strings.";
	const entries = Object.entries(labels);
	if (entries.length > MAX_LABELS) return `labels may hold at most ${MAX_LABELS} keys.`;
	for (const [key, value] of entries) {
		if (!LABEL_KEY.test(key)) return `label key ${JSON.stringify(key)} is malformed.`;
		if (typeof value !== "string" || value.length > MAX_LABEL_VALUE) {
			return `label ${JSON.stringify(key)} must be a string of at most ${MAX_LABEL_VALUE} characters.`;
		}
	}
	return null;
}

/**
 * Copy the plain object's own data properties once, so validation and launch
 * see the same values. Getters, inherited fields, and exotic objects are
 * refused rather than read twice. Returns null for anything else.
 */
function snapshotPlainData(value: unknown): Record<string, unknown> | null {
	try {
		if (!isRecord(value) || types.isProxy(value)) return null;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const snapshot: Record<string, unknown> = {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!("value" in descriptor)) return null;
			// defineProperty, not assignment: a `__proto__` key stays plain data.
			Object.defineProperty(snapshot, key, {
				value: descriptor.value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return snapshot;
	} catch {
		// A revoked or throwing Proxy.
		return null;
	}
}

/**
 * Validate a trusted launch request before any effect. Shared by the real
 * descriptor and the package fake so both enforce the same contract. Never
 * throws; the returned request is a frozen snapshot of what was validated.
 */
export function validateTrustedLaunchRequest(raw: unknown): TrustedRequestValidation {
	const input = snapshotPlainData(raw);
	if (!input) return reject("invalid_request", "The request must be a plain object of data properties.");
	if (input.labels !== undefined) {
		const labels = snapshotPlainData(input.labels);
		if (!labels) return reject("invalid_request", "labels must be a plain object of strings.");
		input.labels = labels;
	}
	if (input.requestVersion !== TRUSTED_LAUNCH_VERSION) {
		return reject(
			"unsupported_version",
			`Unsupported request version ${typeof input.requestVersion === "string" ? JSON.stringify(input.requestVersion) : `of type ${typeof input.requestVersion}`}; expected ${TRUSTED_LAUNCH_VERSION}.`,
		);
	}
	const unknownKeys = Object.keys(input).filter((key) => !KNOWN_KEYS.has(key));
	if (unknownKeys.length > 0) return reject("invalid_request", `Unknown request keys: ${unknownKeys.join(", ")}.`);
	for (const key of REQUIRED_STRING_KEYS) {
		if (typeof input[key] !== "string" || input[key] === "") {
			return reject("invalid_request", `${key} must be a non-empty string.`);
		}
	}
	for (const key of OPTIONAL_STRING_KEYS) {
		if (input[key] !== undefined && (typeof input[key] !== "string" || input[key] === "")) {
			return reject("invalid_request", `${key} must be a non-empty string when present.`);
		}
	}
	const request = input as unknown as TrustedLaunchRequestV1;
	if (!REQUEST_ID.test(request.requestId)) return reject("invalid_request", "requestId is malformed.");
	const nameError = getSubagentNameError(request.name);
	if (nameError) return reject("invalid_request", nameError);
	if (request.mode !== "background" && request.mode !== "interactive") {
		return reject("invalid_request", 'mode must be "background" or "interactive".');
	}
	const labelsError = getLabelsError(input.labels);
	if (labelsError) return reject("invalid_request", labelsError);
	if (getEffectiveCwdError(request.effectiveCwd)) {
		return reject(
			"effective_cwd_invalid",
			`effectiveCwd ${JSON.stringify(request.effectiveCwd)} must be an absolute, canonical, existing, accessible directory.`,
		);
	}
	if (request.labels) Object.freeze(request.labels);
	return { ok: true, request: Object.freeze(request) };
}

const RESUME_KEYS = new Set<string>(["requestVersion", "requestId", "sessionFile", "effectiveCwd", "launchRequestId", "task"]);

export type TrustedResumeRequestValidation =
	| { ok: true; request: TrustedResumeRequestV1 }
	| { ok: false; reason: TrustedResumeRejection; message: string };

/**
 * Validate the shape of a trusted resume request before any effect. The
 * session's own authority is checked later, against what it persisted.
 * Never throws; the returned request is a frozen snapshot.
 */
export function validateTrustedResumeRequest(raw: unknown): TrustedResumeRequestValidation {
	const invalid = (message: string): TrustedResumeRequestValidation => ({ ok: false, reason: "invalid_request", message });
	const input = snapshotPlainData(raw);
	if (!input) return invalid("The request must be a plain object of data properties.");
	if (input.requestVersion !== TRUSTED_LAUNCH_VERSION) {
		return {
			ok: false,
			reason: "unsupported_version",
			message: `Unsupported request version; expected ${TRUSTED_LAUNCH_VERSION}.`,
		};
	}
	const unknownKeys = Object.keys(input).filter((key) => !RESUME_KEYS.has(key));
	if (unknownKeys.length > 0) return invalid(`Unknown request keys: ${unknownKeys.join(", ")}.`);
	for (const key of ["requestId", "sessionFile", "effectiveCwd", "launchRequestId"] as const) {
		if (typeof input[key] !== "string" || input[key] === "") return invalid(`${key} must be a non-empty string.`);
	}
	if (input.task !== undefined && (typeof input.task !== "string" || input.task === "")) {
		return invalid("task must be a non-empty string when present.");
	}
	const request = input as unknown as TrustedResumeRequestV1;
	if (!REQUEST_ID.test(request.requestId)) return invalid("requestId is malformed.");
	if (!REQUEST_ID.test(request.launchRequestId)) return invalid("launchRequestId is malformed.");
	if (!isAbsolute(request.sessionFile)) return invalid("sessionFile must be absolute.");
	return { ok: true, request: Object.freeze(request) };
}

const TERMINATE_KEYS = new Set<string>(["requestVersion", "requestId", "runId", "sessionFile", "launchRequestId"]);

export type TrustedTerminateRequestValidation =
	| { ok: true; request: TrustedTerminateRequestV1 }
	| { ok: false; reason: "invalid_request" | "unsupported_version"; message: string };

/**
 * Validate a trusted termination request before any effect. It names a run
 * only by the identities a launch or resume returned; any other key, such as
 * a pid or a pane, is refused. Never throws; returns a frozen snapshot.
 */
export function validateTrustedTerminateRequest(raw: unknown): TrustedTerminateRequestValidation {
	const invalid = (message: string): TrustedTerminateRequestValidation => ({ ok: false, reason: "invalid_request", message });
	const input = snapshotPlainData(raw);
	if (!input) return invalid("The request must be a plain object of data properties.");
	if (input.requestVersion !== TRUSTED_LAUNCH_VERSION) {
		return {
			ok: false,
			reason: "unsupported_version",
			message: `Unsupported request version; expected ${TRUSTED_LAUNCH_VERSION}.`,
		};
	}
	const unknownKeys = Object.keys(input).filter((key) => !TERMINATE_KEYS.has(key));
	if (unknownKeys.length > 0) return invalid(`Unknown request keys: ${unknownKeys.join(", ")}.`);
	for (const key of ["requestId", "runId", "sessionFile", "launchRequestId"] as const) {
		if (typeof input[key] !== "string" || input[key] === "") return invalid(`${key} must be a non-empty string.`);
	}
	const request = input as unknown as TrustedTerminateRequestV1;
	if (!REQUEST_ID.test(request.requestId)) return invalid("requestId is malformed.");
	if (!REQUEST_ID.test(request.launchRequestId)) return invalid("launchRequestId is malformed.");
	if (!isAbsolute(request.sessionFile)) return invalid("sessionFile must be absolute.");
	return { ok: true, request: Object.freeze(request) };
}
