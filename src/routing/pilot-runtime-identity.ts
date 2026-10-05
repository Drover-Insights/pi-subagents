/**
 * The runtime identity a pilot receipt records for one route provider: the Pi
 * command that starts the child, and for a Claude route the Claude CLI and the
 * non-secret identity of each pi-claude-code-provider instance the route may
 * use. It never records configuration paths or file contents beyond digests.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getPiInvocation } from "../launch/child-command.ts";

type ClaudeInstanceIdentity = { providerId: string; label: string; expectedIdentityFingerprint: string };

type ClaudeFailover = { providerId: string; label: string; order: string[] };

/** The Pi package an entry script belongs to, with a digest over every file of its `dist` tree. */
type PiPackage = { name: string; version: string; distSha256: string };

type PilotRuntime = {
	pi: {
		command: string;
		commandSha256: string;
		entry: { path: string; sha256: string } | null;
		package: PiPackage | null;
	};
	claude?: {
		version: string;
		path: string;
		sha256: string;
		instances: ClaudeInstanceIdentity[];
		failover?: ClaudeFailover;
	};
};

type PilotRuntimeIdentity = { status: "resolved"; runtime: PilotRuntime } | { status: "unavailable"; reason: string };

class Unavailable extends Error {}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The real path of an executable named absolutely or found on `PATH`. */
function resolveExecutable(command: string, what: string): string {
	if (isAbsolute(command)) return realpathSync(command);
	if (!command.includes("/")) {
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			// A relative entry resolves against the working directory, which a child may write.
			if (!isAbsolute(dir)) continue;
			const candidate = join(dir, command);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return realpathSync(candidate);
			} catch {
				// Not here; keep searching.
			}
		}
	}
	throw new Unavailable(`${what} ${JSON.stringify(command)} is not an absolute path and is not on PATH`);
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const GENERIC_RUNTIME = /^(node|bun)(\.exe)?$/i;

/** Every regular file under `dir`, as sorted paths relative to `base`. */
function treeFiles(dir: string, base: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...treeFiles(path, base));
		else if (entry.isFile()) files.push(relative(base, path));
		// A symlink or special file has no content of its own to digest.
		else throw new Unavailable(`the Pi package's ${relative(base, path)} is not a regular file`);
	}
	return files.sort();
}

/**
 * The Pi package that holds `entry`, or null when none does. The entry script
 * is often a shim that loads the real bundle, so the whole `dist` tree is
 * digested: one line per file, its path and its sha256.
 */
function piPackage(entry: string): PiPackage | null {
	for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
		let manifest: { name?: unknown; version?: unknown };
		try {
			manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		} catch {
			continue;
		}
		if (manifest.name !== PI_PACKAGE || typeof manifest.version !== "string") return null;
		const dist = join(dir, "dist");
		// Only a script of the digested tree is described by its digest.
		const inDist = relative(dist, entry);
		if (!inDist || inDist.startsWith("..") || isAbsolute(inDist)) return null;
		const digest = createHash("sha256");
		for (const file of treeFiles(dist, dist)) digest.update(`${file}\0${sha256File(join(dist, file))}\n`);
		return { name: PI_PACKAGE, version: manifest.version, distSha256: digest.digest("hex") };
	}
	return null;
}

/** Whether a file starts with `#!`; reads two bytes, never the whole binary. */
function isScript(path: string): boolean {
	const head = Buffer.alloc(2);
	const fd = openSync(path, "r");
	try {
		readSync(fd, head, 0, 2, 0);
	} finally {
		closeSync(fd);
	}
	return head.toString("latin1") === "#!";
}

function piIdentity(): PilotRuntime["pi"] {
	const invocation = getPiInvocation([]);
	const command = resolveExecutable(invocation.command, "the Pi command");
	const first = invocation.args[0];
	let entry: PilotRuntime["pi"]["entry"] = null;
	// A relative entry resolves against the child's directory, not this one, so it names no file here.
	if (first !== undefined && isAbsolute(first)) {
		let isFile = false;
		try {
			isFile = statSync(first).isFile();
		} catch {
			// Not a file: an argument, not an entry script.
		}
		if (isFile) {
			const path = realpathSync(first);
			entry = { path, sha256: sha256File(path) };
		}
	}
	// The script that is Pi: the entry a runtime runs, or the command itself, such as `pi` linked to the package's CLI.
	const pkg = piPackage(entry ? entry.path : command);
	// Without the package, only a standalone Pi binary run with no arguments
	// identifies Pi; a runtime, a launcher such as `env`, or a shell shim hides it.
	if (pkg === null && (GENERIC_RUNTIME.test(basename(command)) || invocation.args.length > 0 || isScript(command))) {
		throw new Unavailable(`the Pi command ${command} runs no script of the ${PI_PACKAGE} package`);
	}
	return { command, commandSha256: sha256File(command), entry, package: pkg };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The instances a Claude route may use, read from the pi-claude-code-provider configuration. */
function claudeInstances(provider: string): { instances: ClaudeInstanceIdentity[]; failover?: ClaudeFailover } {
	const configPath = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
	if (!configPath || !isAbsolute(configPath)) {
		throw new Unavailable(
			`provider ${provider} is not built into Pi and no absolute PI_CLAUDE_CODE_PROVIDER_CONFIG names its instances`,
		);
	}
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		// A parse error quotes the file's text, which may hold a secret; name the failure only.
		const cause = error instanceof SyntaxError ? "it is not valid JSON" : `it cannot be read (${(error as { code?: string }).code ?? "error"})`;
		throw new Unavailable(`provider ${provider} has no usable Claude instance configuration: ${cause}`);
	}
	const rawInstances = isRecord(config) && Array.isArray(config.instances) ? config.instances : [];
	const instances = new Map<string, ClaudeInstanceIdentity>();
	for (const raw of rawInstances) {
		if (
			isRecord(raw) &&
			typeof raw.providerId === "string" &&
			typeof raw.label === "string" &&
			typeof raw.expectedIdentityFingerprint === "string"
		) {
			instances.set(raw.providerId, {
				providerId: raw.providerId,
				label: raw.label,
				expectedIdentityFingerprint: raw.expectedIdentityFingerprint,
			});
		}
	}
	const direct = instances.get(provider);
	if (direct) return { instances: [direct] };
	const failover = isRecord(config) ? config.failover : undefined;
	if (
		isRecord(failover) &&
		failover.providerId === provider &&
		typeof failover.label === "string" &&
		Array.isArray(failover.order) &&
		failover.order.length > 0 &&
		failover.order.every((id) => typeof id === "string")
	) {
		const order = failover.order as string[];
		const ordered = order.map((id) => instances.get(id));
		if (ordered.some((instance) => instance === undefined)) {
			throw new Unavailable(`failover provider ${provider} names an instance the Claude configuration does not define`);
		}
		return {
			instances: ordered as ClaudeInstanceIdentity[],
			failover: { providerId: provider, label: failover.label, order: [...order] },
		};
	}
	throw new Unavailable(`provider ${provider} is neither built into Pi nor a configured Claude instance`);
}

function claudeIdentity(provider: string): NonNullable<PilotRuntime["claude"]> {
	const routed = claudeInstances(provider);
	const path = resolveExecutable(process.env.PI_CLAUDE_CODE_PROVIDER_PATH || "claude", "the Claude CLI");
	// Hashed before and after it runs, so the version and the digest describe one file.
	const sha256 = sha256File(path);
	let version: string;
	try {
		version = execFileSync(path, ["--version"], {
			timeout: 10_000,
			killSignal: "SIGKILL",
			env: { PATH: process.env.PATH ?? "" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch (error) {
		throw new Unavailable(`the Claude CLI ${path} did not report its version: ${message(error)}`);
	}
	if (!version) throw new Unavailable(`the Claude CLI ${path} reported an empty version`);
	if (sha256File(path) !== sha256) throw new Unavailable(`the Claude CLI ${path} changed while its version was read`);
	return { version, path, sha256, ...routed };
}

/** Resolve the runtime identity of a route provider. Never throws. */
export function resolvePilotRuntimeIdentity(provider: string): PilotRuntimeIdentity {
	try {
		const pi = piIdentity();
		if (builtinProviders().some((builtin) => builtin.id === provider)) return { status: "resolved", runtime: { pi } };
		return { status: "resolved", runtime: { pi, claude: claudeIdentity(provider) } };
	} catch (error) {
		const reason = message(error);
		return {
			status: "unavailable",
			reason: reason.includes(provider) ? reason : `provider ${provider}: ${reason}`,
		};
	}
}
