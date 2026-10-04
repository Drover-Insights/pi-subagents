import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getCompletionHelperPath } from "../launch/completion-helper.ts";
import type { PolicyLaunch } from "../types.ts";

/**
 * Filesystem checks a managed launch must pass immediately before its child
 * starts: every catalogued file still matches its pin, the completion helper
 * entry is the file the launcher loads, and the route's provider exists in the
 * child runtime without any extension registering it.
 */

export type ResourceVerification =
	| { status: "verified" }
	| { status: "rejected"; reason: "resource_unverified" | "provider_unknown"; message: string };

function sha256Of(path: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Pi's own `models.json` leniency: `//` line comments and trailing commas,
 * with string literals left untouched. Pi does not export its helper.
 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

/** Provider ids `models.json` in `agentDir` defines, read as Pi reads it; a missing file defines none. */
function modelsJsonProviders(agentDir: string): Set<string> {
	let text: string;
	try {
		text = readFileSync(join(agentDir, "models.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw new Error(`models.json is unreadable: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
	} catch (error) {
		throw new Error(`models.json is not valid JSON: ${(error as Error).message}`);
	}
	const providers = (parsed as { providers?: unknown } | null)?.providers;
	if (providers === undefined) return new Set();
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		throw new Error("models.json providers must be an object.");
	}
	return new Set(Object.keys(providers));
}

function verifyProvider(provider: string, agentDir: string): ResourceVerification {
	if (builtinProviders().some((builtin) => builtin.id === provider)) return { status: "verified" };
	let defined: Set<string>;
	try {
		defined = modelsJsonProviders(agentDir);
	} catch (error) {
		return {
			status: "rejected",
			reason: "provider_unknown",
			message: `Provider ${provider} is not built into Pi, and ${(error as Error).message}`,
		};
	}
	if (defined.has(provider)) return { status: "verified" };
	return {
		status: "rejected",
		reason: "provider_unknown",
		message: `Provider ${provider} is neither built into Pi nor defined in ${join(agentDir, "models.json")}.`,
	};
}

/** Verify one authorized launch against the filesystem; never throws. */
export function verifyPolicyLaunch(launch: PolicyLaunch, agentDir: string): ResourceVerification {
	const completion = launch.extensions[0];
	const completionPath = getCompletionHelperPath();
	if (completion?.id !== "subagent-completion" || completion.files[0]?.path !== completionPath) {
		return {
			status: "rejected",
			reason: "resource_unverified",
			message: `The subagent-completion catalog entry does not name the completion helper the launcher loads, ${completionPath}.`,
		};
	}
	for (const extension of launch.extensions) {
		for (const file of extension.files) {
			const actual = sha256Of(file.path);
			if (actual !== file.sha256) {
				return {
					status: "rejected",
					reason: "resource_unverified",
					message:
						actual === null
							? `Extension ${extension.id} file ${file.path} is missing or unreadable.`
							: `Extension ${extension.id} file ${file.path} does not match its pinned sha256.`,
				};
			}
		}
	}
	return verifyProvider(launch.model.slice(0, launch.model.indexOf("/")), agentDir);
}
