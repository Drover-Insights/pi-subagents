/**
 * The writer lease store's record readers. Writes go through the shared
 * write-once primitives in `src/write-once-records.ts`; a lease read throws on
 * a missing or unparseable record, so a caller can never act on a partial one.
 */
import { lstatSync, readFileSync } from "node:fs";

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
