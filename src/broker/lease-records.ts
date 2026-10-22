/**
 * Durable records for a private store directory: records linked into place
 * fully written and fsynced, markers created with `O_EXCL`. Nothing here
 * deletes or renames a record.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

class StoreError extends Error {}

function errorCode(error: unknown): string | undefined {
	return (error as { code?: string } | null)?.code;
}

/** A directory this user alone can use; created when missing, never followed through a symlink. */
export function privateDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw new StoreError(`cannot create ${path}: ${errorCode(error) ?? error}`);
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError(`${path} is not a directory`);
	if ((stat.mode & 0o077) !== 0) throw new StoreError(`${path} is accessible to other users`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new StoreError(`${path} is owned by another user`);
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write a fully synced temporary file, then link it into place; `EEXIST` means the name is taken. */
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
		// The temporary name only; the linked record stays.
		unlinkSync(temp);
	}
	fsyncDirectory(dir);
	return "linked";
}

/** Create a marker with `O_EXCL`; false when it already exists. */
export function createMarker(dir: string, name: string, value: unknown): boolean {
	let fd: number;
	try {
		fd = openSync(join(dir, name), "wx", 0o600);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(value, null, "\t")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(dir);
	return true;
}

export function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}
