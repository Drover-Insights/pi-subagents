import { runHerdrJsonAsync } from "../../src/mux/herdr.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHerdrWorkReporter } from "../../src/mux/herdr-work.ts";

const environment = { HERDR_ENV: "1", HERDR_PANE_ID: "pane-owned", HERDR_SOCKET_PATH: "alternate-endpoint", HERDR_BIN_PATH: "alternate-herdr" };
const context = { mode: "tui", sessionManager: { getSessionFile: () => "parent.jsonl" } };

test("Herdr metadata is namespaced, session-bound, expiring and cleared after serialized writes", async () => {
	const writes: string[][] = [];
	const run = async (args: string[], env: NodeJS.ProcessEnv) => {
		assert.equal(env.HERDR_SOCKET_PATH, "alternate-endpoint");
		assert.equal(env.HERDR_BIN_PATH, "alternate-herdr");
		if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
		if (args[1] === "current") return { result: { pane: { pane_id: "pane-owned" } } };
		writes.push(args);
		return { result: {} };
	};
	const reporter = await createHerdrWorkReporter(context, environment, run);
	assert.ok(reporter);
	await reporter.publish(2);
	const write = writes.at(-1);
	assert.ok(write);
	assert.deepEqual(write.slice(0, 5), ["pane", "report-metadata", "pane-owned", "--source", "pi-subagents:work-v1"]);
	assert.equal(write[write.indexOf("--ttl-ms") + 1], "30000");
	const token = write[write.indexOf("--token") + 1];
	assert.ok(token.startsWith("pi_subagents_work_v1="));
	const [sessionHash, count, expiresAt] = token.slice(token.indexOf("=") + 1).split(":");
	assert.equal(sessionHash, "rbOz4jmLPImzY52C1O64FwFWuSl8kvjFeC2Xvign-nY");
	assert.equal(count, "2");
	assert.ok(Number(expiresAt) > Date.now());
	await reporter.stop();
	assert.deepEqual(writes.at(-1)?.slice(-2), ["--clear-token", "pi_subagents_work_v1"]);
	const size = writes.length;
	await reporter.publish(7);
	await reporter.stop();
	assert.equal(writes.length, size);
});

for (const [label, mode, patch] of [
	["print", "print", {}], ["RPC", "rpc", {}], ["JSON", "json", {}],
	["outside Herdr", "tui", { HERDR_ENV: "0" }], ["no pane", "tui", { HERDR_PANE_ID: "" }],
	["other mux", "tui", { PI_SUBAGENT_MUX: "tmux" }],
	["hidden child inheriting pane", "tui", { PI_SUBAGENT_NAME: "hidden" }],
	["child on another surface", "tui", { PI_SUBAGENT_NAME: "child", PI_SUBAGENT_SURFACE: "foreign" }],
] as const) {
	test(`${label} performs no Herdr discovery, writes or heartbeat`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const reporter = await createHerdrWorkReporter({ ...context, mode }, { ...environment, ...patch }, async () => assert.fail("Herdr must not run"));
		assert.equal(reporter, undefined);
		t.mock.timers.tick(60_000);
	});
}

test("unsupported servers and missing binaries fail open without reporting", async () => {
	for (const status of [{ running: false, compatible: true, protocol: 22 }, { running: true, compatible: false, protocol: 22 },
		{ running: true, compatible: true, protocol: 21 }, {}]) {
		const calls: string[][] = [];
		assert.equal(await createHerdrWorkReporter(context, environment, async (args) => { calls.push(args); return status; }), undefined);
		assert.equal(calls.length, 1);
	}
	assert.equal(await createHerdrWorkReporter(context, environment, async () => { throw new Error("ENOENT"); }), undefined);
});

test("heartbeat retries an outage, renews only positive work and cannot overwrite shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const writes: string[][] = [];
	let fail = true;
	const reporter = await createHerdrWorkReporter(context, environment, async (args) => {
		if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
		if (args[1] === "current") return { result: { pane: { pane_id: "pane-owned" } } };
		writes.push(args);
		if (fail) throw new Error("socket unavailable");
		return { result: {} };
	});
	assert.ok(reporter);
	await reporter.publish(1);
	assert.equal(writes.length, 1);
	fail = false;
	t.mock.timers.tick(10_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(writes.length, 2);
	assert.match(writes[1].at(-1) ?? "", /:1:41000$/);
	await reporter.publish(0);
	const size = writes.length;
	t.mock.timers.tick(60_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(writes.length, size, "zero count must have no heartbeat");
	await reporter.stop();
});

test("stop drains an in-flight positive write then clears, with no late heartbeat", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const writes: string[][] = [];
	let release: (() => void) | undefined;
	const reporter = await createHerdrWorkReporter(context, environment, async (args) => {
		if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
		if (args[1] === "current") return { result: { pane: { pane_id: "pane-owned" } } };
		if (args.includes("--token")) await new Promise<void>((resolve) => { release = resolve; });
		writes.push(args);
		return { result: {} };
	});
	assert.ok(reporter);
	const publishing = reporter.publish(1);
	await Promise.resolve();
	assert.ok(release);
	const stopping = reporter.stop();
	release();
	await Promise.all([publishing, stopping]);
	assert.equal(writes.length, 2);
	assert.ok(writes[1].includes("--clear-token"));
	t.mock.timers.tick(60_000);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(writes.length, 2);
});


test("bounded CLI transport honors alternate binary, config and endpoint without shell interpretation", async () => {
	const env = { HERDR_BIN_PATH: process.execPath, HERDR_SOCKET_PATH: join(tmpdir(), "alternate endpoint"),
		HERDR_CONFIG_PATH: join(tmpdir(), "alternate config.toml") };
	const reply = await runHerdrJsonAsync(["-e", `process.stdout.write(JSON.stringify({
		endpoint:process.env.HERDR_SOCKET_PATH, config:process.env.HERDR_CONFIG_PATH, arg:process.argv[1]
	}))`, "--", "literal; $(not-a-command)"], env);
	assert.deepEqual(reply, { endpoint:env.HERDR_SOCKET_PATH, config:env.HERDR_CONFIG_PATH, arg:"literal; $(not-a-command)" });
	for (const output of ["malformed", "null", JSON.stringify({error:{code:"unsupported_method",message:"no metadata"}})]) {
		await assert.rejects(runHerdrJsonAsync(["-e", `process.stdout.write(${JSON.stringify(output)})`], env));
	}
});

test("repeated shutdown callers both await the final clear", async () => {
	let release: (() => void) | undefined;
	const reporter = await createHerdrWorkReporter(context, environment, async (args) => {
		if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
		if (args[1] === "current") return { result: { pane: { pane_id: "pane-owned" } } };
		await new Promise<void>((resolve) => { release = resolve; });
		return { result: {} };
	});
	assert.ok(reporter);
	const first = reporter.stop();
	await Promise.resolve();
	let stopped = false;
	const second = reporter.stop().then(() => { stopped = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(stopped, false, "replacement must not race the old clear");
	assert.ok(release);
	release();
	await Promise.all([first, second]);
});

test("long session paths survive Herdr's 80-character token limit with count and expiry intact", async () => {
	const session = join(tmpdir(), "long-session-directory-".repeat(12), "parent.jsonl");
	let stored = "";
	let sent = "";
	const reporter = await createHerdrWorkReporter({ ...context, sessionManager: { getSessionFile: () => session } }, environment, async (args) => {
		if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
		if (args[1] === "current") return { result: { pane: { pane_id: "pane-owned" } } };
		const at = args.indexOf("--token");
		if (at >= 0) {
			sent = args[at + 1].split("=").slice(1).join("=");
			stored = sent.slice(0, 80); // Observed Herdr 0.9.0 normalization.
		}
		return { result: {} };
	});
	assert.ok(reporter);
	try {
		await reporter.publish(Number.MAX_SAFE_INTEGER);
		assert.equal(stored, sent, "Herdr must not truncate lifecycle facts");
		assert.match(stored, /^[A-Za-z0-9_-]{43}:9007199254740991:\d+$/);
		assert.ok(Number(stored.split(":")[2]) > Date.now());
	} finally { await reporter.stop(); }
});
