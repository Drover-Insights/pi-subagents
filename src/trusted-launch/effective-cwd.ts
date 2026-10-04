import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type EffectiveCwdError =
	| "effective_cwd_invalid"
	| "effective_cwd_missing"
	| "effective_cwd_noncanonical"
	| "effective_cwd_revoked";

/**
 * Why `path` cannot be a trusted child's effective directory, or null when it
 * can: it must be absolute, exist, equal its realpath (no symlink anywhere on
 * it), be a directory, and be readable and searchable by this process.
 */
export function getEffectiveCwdError(path: string): EffectiveCwdError | null {
	if (!isAbsolute(path)) return "effective_cwd_invalid";
	let real: string;
	try {
		real = realpathSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return "effective_cwd_missing";
		if (code === "ELOOP") return "effective_cwd_noncanonical";
		return "effective_cwd_revoked";
	}
	if (real !== path) return "effective_cwd_noncanonical";
	try {
		if (!statSync(path).isDirectory()) return "effective_cwd_invalid";
		accessSync(path, constants.R_OK | constants.X_OK);
	} catch {
		return "effective_cwd_revoked";
	}
	return null;
}
