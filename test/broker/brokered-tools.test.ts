import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { TOOL_BROKER_ENV } from "../../src/broker/env-contract.ts";
import { BWRAP_PATH } from "../../src/broker/sandbox-run.ts";
import { BROKERED_DESCRIPTION_SUFFIX, BROKERED_TOOL_NAMES, installToolBroker } from "../../src/broker/tools.ts";
import subagentDoneExtension from "../../src/tools/subagent-done.ts";
import "../support/temp-root.ts";

/**
 * The tools a managed child's model calls, driven the way Pi drives them,
 * against the real sandbox.
 */
const skip = existsSync(BWRAP_PATH) ? false : `${BWRAP_PATH} is not installed`;

type ToolResult = { content: { type: string; text?: string }[] };
type Tool = {
	name: string;
	description: string;
	renderCall?: unknown;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
};

type ToolInfo = { name: string; description: string; sourceInfo: { path: string; source: string } };

function fakePi(activeTools: string[] = [], extraTools: ToolInfo[] = []) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	let active = [...activeTools];
	const pi = {
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getAllTools: (): ToolInfo[] => [
			...[...tools.values()]
				.filter((tool) => !extraTools.some((extra) => extra.name === tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					sourceInfo: { path: "/ext/subagent-done.ts", source: "local" },
				})),
			...extraTools,
		],
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	};
	return { pi, tools, handlers, active: () => active };
}

function install(env: Record<string, string>) {
	const fake = fakePi();
	installToolBroker(fake.pi as never, env);
	return fake;
}

function text(result: ToolResult): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

const brokered = (mode: string) => ({ [TOOL_BROKER_ENV]: JSON.stringify({ version: 1, mode }) });

describe("broker installation", () => {
	test("an unmanaged child keeps Pi's own tools", () => {
		assert.equal(install({}).tools.size, 0);
	});

	test("a malformed broker config leaves every model tool failing closed", async () => {
		const { tools } = install({ [TOOL_BROKER_ENV]: "{" });
		assert.deepEqual([...tools.keys()].sort(), [...BROKERED_TOOL_NAMES].sort());
		for (const tool of tools.values()) {
			await assert.rejects(
				tool.execute("call-1", { path: "README.md", command: "true", pattern: "x" }, undefined, undefined, {
					cwd: process.cwd(),
				}),
				/tool broker/,
			);
		}
	});

	test("the completion helper every child loads first installs the broker", () => {
		const fake = fakePi();
		const saved = process.env[TOOL_BROKER_ENV];
		process.env[TOOL_BROKER_ENV] = brokered("read-only")[TOOL_BROKER_ENV];
		try {
			subagentDoneExtension({ ...fake.pi, registerShortcut() {}, registerCommand() {} } as never);
		} finally {
			if (saved === undefined) delete process.env[TOOL_BROKER_ENV];
			else process.env[TOOL_BROKER_ENV] = saved;
		}
		for (const name of BROKERED_TOOL_NAMES) {
			assert.ok(fake.tools.get(name)?.description.endsWith(BROKERED_DESCRIPTION_SUFFIX), name);
		}
	});

	test("deactivates any active built-in tool the broker does not provide, powershell included", async () => {
		const builtin = (name: string): ToolInfo => ({
			name,
			description: `Built-in ${name}`,
			sourceInfo: { path: `<builtin:${name}>`, source: "builtin" },
		});
		const fake = fakePi(["read", "bash", "powershell", "subagent_done"], [builtin("bash"), builtin("powershell")]);
		installToolBroker(fake.pi as never, brokered("read-only"));
		for (const handler of fake.handlers.get("before_agent_start") ?? []) await handler({}, {});
		assert.deepEqual(fake.active(), ["read", "subagent_done"]);
	});

	test("the brokered edit preview never reads files in the trusted process", () => {
		const { tools } = install(brokered("writer"));
		assert.equal(tools.get("edit")?.renderCall, undefined);
	});
});

describe("brokered child tools", { skip }, () => {
	let root: string;
	let repo: string;
	let secret: string;
	const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };

	before(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "brokered-tools-")));
		const agentDir = join(root, "home", ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		secret = join(agentDir, "auth.json");
		writeFileSync(secret, '{"token":"brokered-canary"}');
		process.env.PI_CODING_AGENT_DIR = agentDir;
		repo = join(root, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "src", "main.ts"), "export const needle = 1;\n");
		writeFileSync(join(repo, "README.md"), "hello\n");
		writeFileSync(join(repo, "trailing.md "), "trailing space\n");
		mkdirSync(join(repo, "a b"));
		writeFileSync(join(repo, "a b", "spaced.txt"), "needle in a spaced dir\n");
		symlinkSync(secret, join(repo, "alias.json"));
		symlinkSync(join(repo, "src"), join(repo, "src-link"));
	});
	after(() => {
		if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
		process.env.PATH = saved.path;
	});

	const call = (tool: Tool | undefined, params: Record<string, unknown>, signal?: AbortSignal) => {
		assert.ok(tool, "tool is registered");
		return tool.execute("call-1", params, signal, undefined, { cwd: repo });
	};

	test("read-only tools read the repository and nothing outside it", async () => {
		const { tools } = install(brokered("read-only"));
		assert.deepEqual([...tools.keys()].sort(), [...BROKERED_TOOL_NAMES].sort());
		assert.match(text(await call(tools.get("read"), { path: "README.md" })), /hello/);
		assert.match(text(await call(tools.get("ls"), { path: "src" })), /main\.ts/);
		assert.match(text(await call(tools.get("find"), { pattern: "*.ts" })), /src\/main\.ts/);
		assert.match(text(await call(tools.get("grep"), { pattern: "needle" })), /src\/main\.ts:1: export const needle/);
		for (const path of [secret, "../home/.pi/agent/auth.json", "alias.json", join(homedir(), ".pi", "agent", "auth.json")]) {
			let leaked = false;
			try {
				leaked = /canary|token/.test(text(await call(tools.get("read"), { path })));
			} catch {
				continue;
			}
			assert.equal(leaked, false, `read reached ${path}`);
			assert.fail(`read of ${path} did not fail`);
		}
		const grepped = await call(tools.get("grep"), { pattern: "canary", path: join(root, "home") }).catch(() => ({
			content: [],
		}));
		assert.equal(/canary/.test(text(grepped)), false, "grep reached the credential directory");
	});

	test("paths keep their exact bytes: leading spaces, encoded file URLs, and symlinked directories", async () => {
		const { tools } = install(brokered("read-only"));
		assert.match(text(await call(tools.get("find"), { pattern: "trailing*" })), /^trailing\.md $/m);
		const url = pathToFileURL(join(repo, "a b")).href;
		assert.match(text(await call(tools.get("grep"), { pattern: "needle", path: url })), /spaced\.txt/);
		assert.match(text(await call(tools.get("ls"), { path: "src-link" })), /main\.ts/);
	});

	test("find keeps the results it found when part of the tree is unreadable", async () => {
		const locked = join(repo, "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		try {
			const { tools } = install(brokered("read-only"));
			assert.match(text(await call(tools.get("find"), { pattern: "*.ts" })), /src\/main\.ts/);
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	test("grep and find fail loudly when ripgrep or fd is unavailable", { skip: ["/usr/bin/rg", "/bin/rg"].some(existsSync) }, async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PATH = "/usr/bin:/bin";
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent");
		try {
			const { tools } = install(brokered("read-only"));
			await assert.rejects(call(tools.get("grep"), { pattern: "needle" }), /ripgrep|rg/);
			if (!["/usr/bin/fd", "/bin/fd", "/usr/bin/fdfind"].some(existsSync)) {
				await assert.rejects(call(tools.get("find"), { pattern: "*.ts" }), /fd/);
			}
		} finally {
			process.env.PATH = saved.path;
			process.env.PI_CODING_AGENT_DIR = agentDir;
		}
	});

	const installedFd = (() => {
		try {
			return execFileSync("/usr/bin/bash", ["-c", "command -v fd || command -v fdfind"], { encoding: "utf8" }).trim();
		} catch {
			return "";
		}
	})();

	test("find runs Debian's fdfind under the name fd", { skip: installedFd ? false : "fd is not installed" }, async () => {
		const fd = installedFd;
		const bin = join(root, "debian-bin");
		mkdirSync(bin, { recursive: true });
		symlinkSync(fd, join(bin, "fdfind"));
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent");
		try {
			const { tools } = install(brokered("read-only"));
			assert.match(text(await call(tools.get("find"), { pattern: "*.ts" })), /src\/main\.ts/);
		} finally {
			process.env.PATH = saved.path;
			process.env.PI_CODING_AGENT_DIR = agentDir;
		}
	});

	test("an aborted read stops its sandbox, and endless output is cut off", async () => {
		const fifo = join(repo, "pipe");
		execFileSync("mkfifo", [fifo]);
		symlinkSync("/dev/zero", join(repo, "zero"));
		const { tools } = install(brokered("read-only"));
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 300);
		await assert.rejects(call(tools.get("read"), { path: "pipe" }, controller.signal));
		assert.ok(Date.now() - started < 5_000, "the aborted read kept running");
		await assert.rejects(call(tools.get("read"), { path: "zero" }), /output limit/);
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(call(tools.get("grep"), { pattern: "needle" }, aborted.signal), /abort/i);
	});

	test("read-only tools cannot write, and bash runs confined without session variables", async () => {
		const { tools } = install(brokered("read-only"));
		await assert.rejects(call(tools.get("write"), { path: "new.txt", content: "x" }));
		await assert.rejects(call(tools.get("edit"), { path: "README.md", edits: [{ oldText: "hello", newText: "bye" }] }));
		assert.equal(existsSync(join(repo, "new.txt")), false);
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "hello\n");
		const output = text(await call(tools.get("bash"), { command: "touch planted 2>&1; env | grep -c '^PI_' ; echo ok" }));
		assert.match(output, /Read-only file system/);
		assert.match(output, /^0$/m);
		assert.match(output, /ok/);
		assert.equal(existsSync(join(repo, "planted")), false);
	});

	test("a writer can write and edit its repository through the broker", async () => {
		const { tools } = install(brokered("writer"));
		await call(tools.get("write"), { path: "notes/new.txt", content: "first\n" });
		assert.equal(readFileSync(join(repo, "notes", "new.txt"), "utf8"), "first\n");
		await call(tools.get("edit"), { path: "notes/new.txt", edits: [{ oldText: "first", newText: "second" }] });
		assert.equal(readFileSync(join(repo, "notes", "new.txt"), "utf8"), "second\n");
		await assert.rejects(call(tools.get("write"), { path: secret, content: "x" }));
		assert.equal(readFileSync(secret, "utf8"), '{"token":"brokered-canary"}');
	});
});
