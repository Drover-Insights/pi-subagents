/**
 * The write-once record primitives the trusted state stores under the agent
 * directory share: private directories this user alone can use, never
 * followed through a symlink, and records linked into place fully written and
 * fsynced, so a name is taken exactly once and nothing is ever rewritten.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export class StoreError extends Error {}

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Refuse a path that is a symlink, not a directory, reachable by others, or owned by another user. */
function checkPrivate(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(`${path} is not a directory`);
	if ((stat.mode & 0o077) !== 0) throw new StoreError(`${path} is accessible to other users`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new StoreError(`${path} is owned by another user`);
	}
}

/** A directory this user alone can use; created when missing, never followed through a symlink. */
export function privateDirectory(path: string): void {
	let created = false;
	try {
		mkdirSync(path, { mode: 0o700 });
		created = true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw new StoreError(`cannot create ${path}: ${errorCode(error) ?? error}`);
	}
	checkPrivate(path);
	if (created) fsyncDirectory(dirname(path));
}

/** Whether an existing private directory is there; false when missing, throws when not private. */
export function existingPrivateDirectory(path: string): boolean {
	try {
		lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	checkPrivate(path);
	return true;
}

/**
 * Write a fully synced temporary file under `dir/tmp`, then link it into
 * place; `exists` means the name is already taken.
 */
export function linkRecord(dir: string, name: string, value: unknown): "linked" | "exists" {
	const temp = join(dir, "tmp", `${process.pid}-${randomBytes(8).toString("hex")}.json`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temp, join(dir, name));
	} catch (error) {
		if (errorCode(error) === "EEXIST") return "exists";
		throw error;
	} finally {
		// The temporary name only; the linked record stays, so a failed cleanup changes nothing.
		try {
			unlinkSync(temp);
		} catch {}
	}
	fsyncDirectory(dir);
	return "linked";
}

/** The parsed JSON at `path`: `undefined` when missing, `null` when unreadable or unparseable. */
export function tryReadJson(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return null;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted recursively and no whitespace: the input of every store digest. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
