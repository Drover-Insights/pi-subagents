#!/usr/bin/env node
/**
 * Fake Claude Code CLI for the reference-consumer suite. It replaces only the
 * provider side: no login, account or network. Settings come from
 * `fake-claude.json` beside this file (the provider passes Claude a filtered
 * environment), and every headless request is appended to the cell's request
 * log as route `claude` before it is answered.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(new URL("./fake-claude.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
/** The nearest ancestor the network guard recorded: the Pi process whose provider ran this. */
function recordedAncestor() {
	let pid = process.ppid;
	while (pid > 1) {
		if (existsSync(join(settings.evidenceDir, "processes", `${pid}.json`))) return pid;
		try {
			pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1]);
		} catch {
			return null;
		}
	}
	return null;
}
// Every invocation counts, preflight included: a provider that must not initialize never runs this.
appendFileSync(
	join(settings.evidenceDir, "claude-invocations.jsonl"),
	`${JSON.stringify({ at: new Date().toISOString(), owner: recordedAncestor(), args: args.slice(0, 2) })}\n`,
);
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

if (args.includes("--version")) {
	process.stdout.write(`${settings.version} (Claude Code)\n`);
	process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
	process.stdout.write(
		JSON.stringify({
			loggedIn: true,
			authMethod: "claude.ai",
			apiProvider: "firstParty",
			subscriptionType: "max",
			email: settings.email,
			orgId: settings.orgId,
		}),
	);
	process.exit(0);
}
if (args.includes("--help")) {
	process.stdout.write(readFileSync(settings.helpPath, "utf8"));
	process.exit(0);
}

const argValue = (flag) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const mcp = JSON.parse(argValue("--mcp-config") ?? "{}");
const pi = mcp.mcpServers?.pi;
const catalogPath = pi?.env?.PI_CLAUDE_TOOL_CATALOG;
const catalog = catalogPath ? JSON.parse(readFileSync(catalogPath, "utf8")) : [];
const model = argValue("--model");
const systemPromptFile = argValue("--system-prompt-file");
const systemPrompt = systemPromptFile ? readFileSync(systemPromptFile, "utf8") : "";
appendFileSync(
	join(settings.evidenceDir, "requests.jsonl"),
	`${JSON.stringify({
		at: new Date().toISOString(),
		route: "claude",
		model,
		tools: catalog.map((tool) => tool.name),
		configRoot: process.env.CLAUDE_CONFIG_DIR ?? null,
		systemLength: systemPrompt.length,
		systemHasContextFiles: /AGENTS\.md|CLAUDE\.md/.test(systemPrompt),
		systemHasSkills: /<available_skills>/.test(systemPrompt),
	})}\n`,
);
if (pi?.env?.PI_CLAUDE_TOOL_READY) writeFileSync(pi.env.PI_CLAUDE_TOOL_READY, "ready\n", { flag: "wx" });

// The provider writes the prompt to stdin and closes it; answer once it is read.
process.stdin.resume();
process.stdin.on("end", () => {
	const text = `CHILD_OK route=claude model=${model}`;
	out({
		type: "system",
		subtype: "init",
		tools: catalog.map((tool) => `mcp__pi__${tool.name}`),
		mcp_servers: catalog.length > 0 ? [{ name: "pi", status: "connected" }] : [],
		model: `claude-${model}-fixture`,
		permissionMode: "dontAsk",
		slash_commands: [],
		skills: [],
		plugins: [],
		apiKeySource: "none",
	});
	out({ type: "stream_event", event: { type: "message_start", message: { id: "msg_fixture", model: `claude-${model}-fixture`, usage: {} } } });
	out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
	out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
	out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
	out({ type: "result", is_error: false, result: text, usage: { input_tokens: 4, output_tokens: 2 } });
});
