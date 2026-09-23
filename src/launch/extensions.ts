import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import type { ResumeMode } from "../session/session-files.ts";
import { parseCommandWords } from "./child-command.ts";

interface NpmSource {
	name: string;
	version?: string;
}

function isGitSource(source: string): boolean {
	return /^(?:git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source);
}

function parseNpmSource(source: string): NpmSource | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length).trim();
	if (!spec) return undefined;
	const versionSeparator = spec.lastIndexOf("@");
	if (versionSeparator > 0) {
		return {
			name: spec.slice(0, versionSeparator),
			version: spec.slice(versionSeparator + 1),
		};
	}
	return { name: spec };
}

function isProjectTrustedForLaunch(agentDefs: AgentDefaults | null, mode: ResumeMode): boolean {
	let trusted = mode !== "background" && agentDefs?.trustProject === true;
	for (const flag of parseCommandWords(agentDefs?.flags ?? "")) {
		if (flag === "--approve") trusted = true;
		if (flag === "--no-approve") trusted = false;
	}
	return trusted;
}

type ConfiguredPackage = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];

function listConfiguredPackages(cwd: string, agentDir: string, projectTrusted: boolean): ConfiguredPackage[] {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	return new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
}

/**
 * Reuse configured, unfiltered package installations for child allowlists.
 * Unversioned npm sources match by package name. Git sources require the exact
 * configured source, including any ref, so managed reuse cannot change refs.
 * A Git source the child Pi root does not configure falls back to the parent
 * Pi root's user packages, so a child profile without packages still reuses the
 * parent's managed install instead of a temporary copy that Pi never moves to
 * a new pinned ref. Other sources retain Pi's normal temporary CLI resolution
 * semantics.
 */
export function resolveConfiguredExtensionSources(
	sources: string[] | undefined,
	options: {
		cwd: string;
		agentDir: string;
		parentAgentDir?: string;
		agentDefs: AgentDefaults | null;
		mode: ResumeMode;
	},
): string[] | undefined {
	if (sources === undefined || sources.length === 0) return sources;

	const projectTrusted = isProjectTrustedForLaunch(options.agentDefs, options.mode);
	const configured = listConfiguredPackages(options.cwd, options.agentDir, projectTrusted);
	let parentConfigured: ConfiguredPackage[] | undefined;
	// Read the parent root only when needed. Its project packages come from the
	// shared cwd and are already in the child list. An unreadable parent root only
	// loses the fallback; it must not block a launch that never depended on it.
	const listParentPackages = (): ConfiguredPackage[] => {
		if (parentConfigured) return parentConfigured;
		parentConfigured = [];
		if (!options.parentAgentDir || options.parentAgentDir === options.agentDir) return parentConfigured;
		try {
			parentConfigured = listConfiguredPackages(options.cwd, options.parentAgentDir, false).filter(
				(entry) => entry.scope === "user",
			);
		} catch {
			// Keep the empty list.
		}
		return parentConfigured;
	};
	const resolved: string[] = [];

	for (const source of sources) {
		const npmSource = parseNpmSource(source);
		const matchesSource = (entry: ConfiguredPackage) => {
			if (entry.scope === "project" && !projectTrusted) return false;
			if (npmSource && !npmSource.version) {
				return parseNpmSource(entry.source)?.name === npmSource.name;
			}
			return isGitSource(source) && entry.source === source;
		};
		const matches = configured.filter(matchesSource);
		const match =
			matches.find((entry) => entry.scope === "project") ??
			matches[0] ??
			(isGitSource(source) ? listParentPackages().find(matchesSource) : undefined);
		if (!match || match.filtered || !match.installedPath) {
			resolved.push(source);
			continue;
		}
		resolved.push(match.installedPath);
	}

	return [...new Set(resolved)];
}
