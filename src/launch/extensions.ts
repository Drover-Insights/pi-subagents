import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The ref of a Git source, split the way Pi's parser splits it: after the first
 * `@` of the repository path, or a `#committish`. Pi does not export its parser.
 * Seeing a ref Pi would not see only costs a fallback, so this errs toward one.
 */
function gitSourceRef(source: string): string | undefined {
	const url = source.replace(/^git:/, "").trim();
	const hash = url.indexOf("#");
	if (hash >= 0) return url.slice(hash + 1);
	const scpPath = url.match(/^git@[^:]+:(.+)$/)?.[1];
	let path = scpPath;
	if (path === undefined && url.includes("://")) {
		try {
			path = new URL(url).pathname;
		} catch {
			return "";
		}
	}
	path ??= url.slice(url.indexOf("/") + 1);
	const at = path.indexOf("@");
	return at < 0 ? undefined : path.slice(at + 1);
}

function git(repository: string, args: string[]): string {
	// Drop inherited GIT_* variables so they cannot point git at another repository.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	// Use -C rather than cwd: an empty PATH entry resolves against cwd, which
	// would run a `git` file inside the checkout being validated.
	return execFileSync("git", ["-C", repository, ...args], {
		env,
		encoding: "utf8",
		stdio: "pipe",
		timeout: 5000,
	}).trim();
}

/**
 * A Git install is valid when it is its own checkout and, for a source with a
 * ref, HEAD is at the commit that ref resolves to. Pi keys Git installs by
 * host and path only, so a settings ref edited without `pi install` leaves the
 * old commit checked out.
 */
function isValidGitInstall(installedPath: string, source: string): boolean {
	try {
		if (realpathSync(git(installedPath, ["rev-parse", "--show-toplevel"])) !== realpathSync(installedPath)) {
			return false;
		}
		const ref = gitSourceRef(source);
		if (ref === undefined) return true;
		if (!ref || ref.startsWith("-")) return false;
		return (
			git(installedPath, ["rev-parse", "--verify", "HEAD^{commit}"]) ===
			git(installedPath, ["rev-parse", "--verify", `${ref}^{commit}`])
		);
	} catch {
		return false;
	}
}

function isValidNpmInstall(installedPath: string, name: string): boolean {
	try {
		return JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8").replace(/^\uFEFF/, ""))?.name === name;
	} catch {
		return false;
	}
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
 * Reuse configured, unfiltered, valid package installations for child allowlists.
 * An install that does not validate keeps the original source, so Pi's
 * temporary resolution installs it instead.
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
		if (
			!match ||
			match.filtered ||
			!match.installedPath ||
			!(npmSource
				? isValidNpmInstall(match.installedPath, npmSource.name)
				: isValidGitInstall(match.installedPath, source))
		) {
			resolved.push(source);
			continue;
		}
		resolved.push(match.installedPath);
	}

	return [...new Set(resolved)];
}
