/**
 * Preloaded into every fixture Node process with `--import`.
 *
 * - Refuses and records any TCP connection to a non-loopback address.
 *   The run also executes in a network namespace with loopback only, so this
 *   is the counter, not the only barrier.
 * - Records which `@earendil-works/pi-coding-agent` package roots the process
 *   resolved or read, so a cell that ran on mixed Pi versions is visible.
 *
 * Writes `<QUAL_EVIDENCE_DIR>/processes/<pid>.json` on exit.
 */
import fs, { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = process.env.QUAL_EVIDENCE_DIR;
const blocked = [];
const piRoots = new Set();

function isLoopback(host) {
	if (host === undefined || host === null || host === "") return true;
	const value = String(host);
	return value === "localhost" || value === "::1" || value.startsWith("127.") || value === "::ffff:127.0.0.1";
}

function targetOf(args) {
	const [first, second] = args;
	if (Array.isArray(first)) return targetOf(first);
	if (first && typeof first === "object") {
		if (first.path) return { local: true };
		return { host: first.host ?? "localhost", port: first.port };
	}
	if (typeof first === "string" && Number.isNaN(Number(first))) return { local: true };
	return { host: typeof second === "string" ? second : "localhost", port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
	const target = targetOf(args);
	if (!target.local && !isLoopback(target.host)) {
		blocked.push({ host: String(target.host), port: target.port, at: new Date().toISOString() });
		// A process killed by SIGKILL never reaches its exit handler; record now.
		writeRecord();
		const error = new Error(`network-guard: non-loopback connection to ${target.host}:${target.port} refused`);
		error.code = "ECONNREFUSED";
		process.nextTick(() => this.destroy(error));
		return this;
	}
	return originalConnect.apply(this, args);
};

// `QUAL_FETCH_REDIRECTS` maps a public origin to a loopback base, for consumer
// extensions that pin a public baseUrl over models.json (pi-multi-account
// re-registers `anthropic` at https://api.anthropic.com). Each redirect is
// recorded, and an unmapped public origin still hits the connection guard.
const redirects = Object.entries(JSON.parse(process.env.QUAL_FETCH_REDIRECTS || "{}"));
const redirected = [];
if (redirects.length > 0 && typeof globalThis.fetch === "function") {
	// Pi installs its own undici fetch at startup, so keep the redirect in front
	// of whatever fetch is installed later.
	let inner = globalThis.fetch;
	const redirectingFetch = function redirectingFetch(input, init) {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
		const match = typeof url === "string" ? redirects.find(([origin]) => url === origin || url.startsWith(`${origin}/`)) : undefined;
		if (!match) return inner(input, init);
		const target = `${match[1]}${url.slice(match[0].length)}`;
		redirected.push({ from: url, to: target, at: new Date().toISOString() });
		writeRecord();
		if (typeof input === "string" || input instanceof URL) return inner(target, init);
		return inner(new Request(target, input), init);
	};
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		get: () => redirectingFetch,
		set: (value) => {
			if (value !== redirectingFetch) inner = value;
		},
	});
}

function notePiRoot(url) {
	if (typeof url !== "string" || !url.includes("@earendil-works/pi-coding-agent")) return;
	try {
		const path = url.startsWith("file:") ? fileURLToPath(url) : url;
		const marker = `${join("@earendil-works", "pi-coding-agent")}`;
		const index = path.lastIndexOf(marker);
		if (index < 0) return;
		const root = path.slice(0, index + marker.length);
		piRoots.add(root);
	} catch {}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		notePiRoot(result.url);
		return result;
	},
});
notePiRoot(process.argv[1] ?? "");

// Loaders that resolve files themselves (jiti) still read them through fs.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function trackedReadFileSync(path, ...rest) {
	if (typeof path === "string" && path.includes("@earendil-works")) notePiRoot(path);
	return originalReadFileSync.call(this, path, ...rest);
};
syncBuiltinESMExports();

function versionOf(root) {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	} catch {
		return null;
	}
}

/** Written at start, on every blocked or redirected connection, and at exit, so a killed process still leaves its record. */
function writeRecord() {
	if (!evidenceDir) return;
	try {
		const dir = join(evidenceDir, "processes");
		mkdirSync(dir, { recursive: true });
		// Write then rename, so a reader never sees a torn record.
		const target = join(dir, `${process.pid}.json`);
		writeFileSync(
			`${target}.tmp`,
			JSON.stringify({
				pid: process.pid,
				ppid: process.ppid,
				argv1: process.argv[1],
				cwd: process.cwd(),
				subagentName: process.env.PI_SUBAGENT_NAME ?? null,
				piRoots: [...piRoots].map((root) => ({ root, version: versionOf(root) })),
				blocked,
				redirected,
			}),
		);
		renameSync(`${target}.tmp`, target);
	} catch {}
}

writeRecord();
process.on("exit", writeRecord);

export const networkGuardDir = dirname(fileURLToPath(import.meta.url));
