import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The completion helper every child loads first. The one place its path is
 * computed, so the file the routing policy verifies is the file `-e` loads.
 */
export function getCompletionHelperPath(): string {
	return join(dirname(dirname(fileURLToPath(import.meta.url))), "tools", "subagent-done.ts");
}

/** This package's root, which completion helper catalog paths resolve against. */
export function getPackageRoot(): string {
	return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
