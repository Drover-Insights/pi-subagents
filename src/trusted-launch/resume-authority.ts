import { realpathSync } from "node:fs";
import { getEntries } from "../session/session.ts";
import {
	type PersistedSubagentLaunchMetadata,
	readSubagentLaunchMetadataEntries,
	scanLaunchMetadataLines,
} from "../session/session-files.ts";
import { readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import { TRUSTED_LAUNCH_VERSION, type TrustedResumeRejection } from "./contract.ts";
import { getEffectiveCwdError } from "./effective-cwd.ts";

/** Provenance versions whose sessions this package can resume. */
const SUPPORTED_PROVENANCE_VERSIONS: ReadonlySet<string> = new Set([TRUSTED_LAUNCH_VERSION]);

export interface TrustedResumeExpectation {
	/** The directory the caller recorded at launch; checked, never used to choose one. */
	effectiveCwd: string;
	/** The `requestId` of the launch that created the session. */
	launchRequestId: string;
}

export type TrustedResumeAuthority =
	| { ok: true; metadata: PersistedSubagentLaunchMetadata; cwd: string }
	| { ok: false; reason: TrustedResumeRejection; message: string };

function refuse(reason: TrustedResumeRejection, message: string): TrustedResumeAuthority {
	return { ok: false, reason, message };
}

function readHeaderCwd(sessionFile: string): unknown {
	try {
		const header = getEntries(sessionFile).find((entry) => (entry as { type?: unknown }).type === "session");
		return (header as { cwd?: unknown } | undefined)?.cwd;
	} catch {
		return undefined;
	}
}

/**
 * Revalidate the authority a trusted launch persisted before resuming it.
 * The only authority is the session's single launch metadata entry: a trusted
 * resume appends none, so any later entry, or a line that cannot be read, is
 * a change nobody authorized. The directory comes from that entry and must
 * still be the canonical, accessible directory the session header and the
 * caller both recorded.
 */
export function validateTrustedResumeAuthority(
	sessionFile: string,
	expected: TrustedResumeExpectation,
): TrustedResumeAuthority {
	let realSessionFile: string;
	try {
		realSessionFile = realpathSync(sessionFile);
	} catch {
		return refuse("session_not_found", `Session file not found: ${sessionFile}`);
	}
	if (realSessionFile !== sessionFile) {
		// An alias would evade the duplicate-resume guard, which compares paths.
		return refuse("session_identity_mismatch", `The session file ${JSON.stringify(sessionFile)} is not canonical.`);
	}
	let scan: ReturnType<typeof scanLaunchMetadataLines>;
	try {
		scan = scanLaunchMetadataLines(sessionFile);
	} catch {
		return refuse("session_not_found", `Session file cannot be read: ${sessionFile}`);
	}
	if (!scan.trusted) return refuse("not_trusted", "No trusted extension launched this session.");
	if (scan.unreadableLines > 0 || scan.launchEntries !== 1) {
		return refuse(
			"metadata_divergent",
			"The session holds unreadable lines or launch metadata written after its trusted launch.",
		);
	}
	const metadata = readSubagentLaunchMetadataEntries(sessionFile)[0];
	const provenance = metadata?.trustedLaunch;
	if (!metadata || !provenance) {
		return refuse("metadata_divergent", "The session's launch metadata entry cannot be read.");
	}
	if (!SUPPORTED_PROVENANCE_VERSIONS.has(provenance.version)) {
		return refuse(
			"unsupported_provenance",
			`The session was launched through ${JSON.stringify(provenance.version)}, which this package cannot resume.`,
		);
	}
	if (provenance.requestId !== expected.launchRequestId) {
		return refuse(
			"launch_request_mismatch",
			`The session was launched by request ${JSON.stringify(provenance.requestId)}, not ${JSON.stringify(expected.launchRequestId)}.`,
		);
	}
	if (readSubagentTimeoutSidecar(sessionFile)?.blocksResume) {
		return refuse("resume_denied", "The session hit its time limit and its agent does not allow a resume after that.");
	}
	const cwd = metadata.cwd;
	if (typeof cwd !== "string") return refuse("effective_cwd_invalid", "The session records no effective directory.");
	const cwdError = getEffectiveCwdError(cwd);
	if (cwdError) {
		return refuse(cwdError, `The persisted effective directory ${JSON.stringify(cwd)} is no longer usable (${cwdError}).`);
	}
	if (readHeaderCwd(sessionFile) !== cwd) {
		return refuse("session_identity_mismatch", `The session header was not recorded in ${JSON.stringify(cwd)}.`);
	}
	if (expected.effectiveCwd !== cwd) {
		return refuse(
			"effective_cwd_mismatch",
			`The session runs in ${JSON.stringify(cwd)}, not ${JSON.stringify(expected.effectiveCwd)}.`,
		);
	}
	return { ok: true, metadata, cwd };
}
