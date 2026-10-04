import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { TRUSTED_LAUNCH_VERSION } from "../../src/trusted-launch/contract.ts";
import type { TrustedResumeExpectation } from "../../src/trusted-launch/resume-authority.ts";
import type { TrustedLaunchProvenance } from "../../src/types.ts";
import { createTestDir } from "./fixtures.ts";

export interface TrustedSessionFixtureOptions {
	/** The directory the child was launched in; created under a fresh test dir by default. */
	cwd?: string;
	/** The `cwd` the session header records; defaults to `cwd`. */
	headerCwd?: string;
	/** False writes ordinary launch metadata with no trusted provenance. */
	trusted?: boolean;
	version?: string;
	generation?: string;
	mode?: "background" | "interactive";
	/** Appends a second launch metadata entry recording this directory. */
	laterEntryCwd?: string;
}

export interface TrustedSessionFixture {
	sessionFile: string;
	cwd: string;
	provenance: TrustedLaunchProvenance;
	expected: TrustedResumeExpectation;
}

/** A child session as a trusted launch leaves it: a header and one launch metadata entry. */
export function trustedSessionFixture(options: TrustedSessionFixtureOptions = {}): TrustedSessionFixture {
	const root = createTestDir();
	let cwd = options.cwd;
	if (cwd === undefined) {
		cwd = join(root, "effective");
		mkdirSync(cwd);
	}
	const provenance: TrustedLaunchProvenance = {
		version: options.version ?? TRUSTED_LAUNCH_VERSION,
		generation: options.generation ?? "generation-1",
		requestId: "op_01",
		labels: { runId: "run_01" },
	};
	const metadata: PersistedSubagentLaunchMetadata = {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "task-worker",
		title: "Task worker",
		agent: "worker",
		mode: options.mode ?? "background",
		sessionMode: "lineage-only",
		autoExit: true,
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: root,
		cwd,
		blueprintCwd: root,
		boundarySystemPrompt: false,
		...(options.trusted === false ? {} : { trustedLaunch: provenance }),
	};
	const sessionFile = join(root, "child.jsonl");
	const lines: object[] = [
		{ type: "session", version: 3, id: "child-session", timestamp: metadata.timestamp, cwd: options.headerCwd ?? cwd },
		{ type: "custom", customType: "pi-subagents_launch_metadata", data: metadata, id: "meta0001", parentId: null },
	];
	if (options.laterEntryCwd !== undefined) {
		lines.push({
			type: "custom",
			customType: "pi-subagents_launch_metadata",
			data: { ...metadata, cwd: options.laterEntryCwd },
			id: "meta0002",
			parentId: "meta0001",
		});
	}
	writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return {
		sessionFile,
		cwd,
		provenance,
		expected: { effectiveCwd: cwd, launchRequestId: provenance.requestId },
	};
}
