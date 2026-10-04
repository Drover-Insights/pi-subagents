import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Process-wide temp root for the test suite. Every later os.tmpdir() call in
// this process, and in children that inherit its environment, lands inside a
// private root that is removed when the process exits or is terminated, so a
// test run leaves the system tmpdir as it found it. Set
// SUBAGENTS_KEEP_TEST_DIRS=1 to keep the root for debugging. The npm test
// script preloads this module; fixtures.ts and capsule-root.ts import it too
// so single-file runs are covered.
const root = mkdtempSync(join(tmpdir(), "subagents-test-root-"));
process.env.TMPDIR = root;

function removeRoot(): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch (error) {
		process.stderr.write(`Could not remove test temp root ${root}: ${error}\n`);
	}
}

if (process.env.SUBAGENTS_KEEP_TEST_DIRS === "1") {
	process.on("exit", () => process.stderr.write(`Kept test temp root: ${root}\n`));
} else {
	process.on("exit", removeRoot);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			removeRoot();
			process.kill(process.pid, signal);
		});
	}
}
