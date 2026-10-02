import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export function getSubagentExitSidecarPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

/**
 * True once the child has published an outcome of its own. The parent checks
 * this before starting a timeout kill: a child that already recorded a verdict
 * finished on its own terms and must not be relabelled as a runaway.
 */
export function hasSubagentExitSidecar(sessionFile: string): boolean {
	return existsSync(getSubagentExitSidecarPath(sessionFile));
}

export function clearSubagentExitSidecar(sessionFile: string): void {
	rmSync(getSubagentExitSidecarPath(sessionFile), { force: true });
}

/**
 * Write the child's exit outcome. Returns false when an outcome already owns
 * this child and the write was refused, so callers never record a verdict the
 * parent will not see.
 */
export function writeSubagentExitSidecar(
	sessionFile: string,
	payload: object,
	opts?: { supersede?: boolean },
): boolean {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (existsSync(exitFile)) {
		if (!opts?.supersede) return false;
		try {
			const existing = JSON.parse(readFileSync(exitFile, "utf8")) as {
				type?: unknown;
			};
			if (existing.type !== "error") return false;
		} catch {
			// A consumed or unreadable sidecar carries no verdict worth protecting.
			// Let a genuine completion replace it.
		}
	}
	// The payload can carry the child's final report. Write a fresh private file
	// and rename it into place, so the reader never sees a torn write and an
	// existing file or planted symlink never decides where the report goes.
	const tempFile = `${exitFile}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(tempFile, JSON.stringify(payload), { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(tempFile, exitFile);
	} catch (error) {
		rmSync(tempFile, { force: true });
		throw error;
	}
	return true;
}
