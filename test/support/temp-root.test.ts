import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "temp-root");

let privateTmp = "";

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: privateTmp, ...extra };
	if (!("SUBAGENTS_KEEP_TEST_DIRS" in extra)) delete env.SUBAGENTS_KEEP_TEST_DIRS;
	// Let the child make its own capsule root inside the private TMPDIR.
	delete env.PI_SUBAGENT_ENV_CAPSULE_DIR;
	delete env.NODE_TEST_CONTEXT;
	return env;
}

function runFixture(extra: Record<string, string> = {}) {
	return spawnSync(process.execPath, ["--test", join(FIXTURE_DIR, "creates-dirs.ts")], {
		env: childEnv(extra),
		encoding: "utf8",
		timeout: 60_000,
	});
}

describe("test temp directory cleanup", () => {
	beforeEach(() => {
		privateTmp = mkdtempSync(join(tmpdir(), "temp-root-probe-"));
	});

	afterEach(() => {
		rmSync(privateTmp, { recursive: true, force: true });
	});

	it("leaves TMPDIR empty after a passing test file", () => {
		const result = runFixture();
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.deepEqual(readdirSync(privateTmp), []);
	});

	it("leaves TMPDIR empty after a failing test file", () => {
		const result = runFixture({ FIXTURE_FAIL: "1" });
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /fixture failure/);
		assert.deepEqual(readdirSync(privateTmp), []);
	});

	it("keeps the directories when SUBAGENTS_KEEP_TEST_DIRS=1", () => {
		const result = runFixture({ SUBAGENTS_KEEP_TEST_DIRS: "1" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const kept = readdirSync(privateTmp);
		assert.equal(kept.length, 1, `expected one kept root, found ${kept.join(", ")}`);
		const contents = readdirSync(join(privateTmp, kept[0])).sort();
		assert.ok(contents.some((name) => name.startsWith("subagents-test-")), contents.join(", "));
		assert.ok(contents.some((name) => name.startsWith("direct-")), contents.join(", "));
	});

	it("keeps a passing run green when the root cannot be removed", { skip: process.getuid?.() === 0 }, () => {
		const result = runFixture({ FIXTURE_LOCKED: "1" });
		for (const entry of readdirSync(privateTmp, { recursive: true, withFileTypes: true })) {
			if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
		}
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, /Could not remove test temp root/);
	});

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		it(`leaves TMPDIR empty when the test process gets ${signal}`, { timeout: 30_000 }, async (t) => {
			const child = spawn(process.execPath, [join(FIXTURE_DIR, "waits.ts")], {
				env: childEnv(),
				stdio: ["ignore", "pipe", "inherit"],
				signal: t.signal,
				killSignal: "SIGKILL",
			});
			child.on("error", () => {});
			try {
				const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
				const ready = await Promise.race([
					new Promise<boolean>((resolve) => child.stdout.once("data", () => resolve(true))),
					exited.then(() => false),
				]);
				assert.ok(ready, "fixture exited before it was ready");
				assert.notDeepEqual(readdirSync(privateTmp), []);
				child.kill(signal);
				assert.equal(await exited, signal);
				assert.deepEqual(readdirSync(privateTmp), []);
			} finally {
				child.kill("SIGKILL");
			}
		});
	}
});
