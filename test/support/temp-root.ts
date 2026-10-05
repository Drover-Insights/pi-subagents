import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
// Tests never read the host's agent directory (~/.pi/agent): its routing
// policy, definitions and sessions belong to the user's own Pi install.
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
// The verifier venv would otherwise live in that fresh agent directory and be
// installed again on every run; keep one test-only venv across runs, in this
// user's own cache directory, where no other user can plant it.
if (!process.env.PI_SUBAGENT_LLM_VERIFIER_VENV?.trim()) {
	const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
	process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = join(cacheHome, "pi-subagents-test", "llm-verifier-venv");
}

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
