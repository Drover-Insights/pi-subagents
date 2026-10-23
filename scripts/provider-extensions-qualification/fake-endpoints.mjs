#!/usr/bin/env node
/**
 * Loopback-only fake model endpoints for the provider-extension qualification.
 *
 * Every request is appended to `<evidence>/requests.jsonl` before it is
 * answered, so request counters run from the first byte the server sees.
 *
 * Routes:
 * - POST /parent/v1/chat/completions   scripted parent driver (openai-completions);
 *                                       any other `.../chat/completions` path too
 * - POST /anthropic/v1/messages         native Anthropic route (anthropic-messages)
 * - POST /legacy/v1/messages            fixture legacy provider route (anthropic-messages)
 * - POST /codex/codex/responses         native Codex route (openai-codex-responses, SSE)
 * Anything else is answered 404 and recorded as `unexpected`.
 *
 * Usage: node fake-endpoints.mjs <evidence-dir> <parent-plan.json>
 * Writes `<evidence>/endpoints.port` once listening.
 */
import { appendFileSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";

const [evidenceDir, planPath] = process.argv.slice(2);
if (!evidenceDir || !planPath) {
	console.error("usage: fake-endpoints.mjs <evidence-dir> <parent-plan.json>");
	process.exit(2);
}
const requestsFile = join(evidenceDir, "requests.jsonl");

function readPlan() {
	return JSON.parse(readFileSync(planPath, "utf8"));
}

function record(entry) {
	appendFileSync(requestsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function sse(res, events) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
	for (const event of events) res.write(event);
	res.end();
}

/** Request bodies arrive compressed from some providers (Codex sends zstd). */
function decodeBody(buffer, encoding) {
	try {
		if (encoding === "zstd") return zstdDecompressSync(buffer).toString("utf8");
		if (encoding === "gzip") return gunzipSync(buffer).toString("utf8");
		if (encoding === "br") return brotliDecompressSync(buffer).toString("utf8");
	} catch {}
	return buffer.toString("utf8");
}

function toolNames(tools) {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool) => tool?.name ?? tool?.function?.name).filter(Boolean);
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
}

function systemText(body) {
	if (typeof body.system === "string") return body.system;
	if (Array.isArray(body.system)) return body.system.map((part) => part?.text ?? "").join("\n");
	if (typeof body.instructions === "string") return body.instructions;
	const first = body.messages?.find?.((message) => message.role === "system" || message.role === "developer");
	return first ? textOf(first.content) : "";
}

/** The child echoes its own model so the evidence shows which model actually answered. */
function childReply(route, model) {
	return `CHILD_OK route=${route} model=${model}`;
}

function anthropicStream(res, model, text) {
	const message = {
		id: `msg_fixture_${Date.now()}`,
		type: "message",
		role: "assistant",
		model,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 0 },
	};
	const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
	sse(res, [
		event("message_start", { message }),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
		event("message_stop", {}),
	]);
}

function codexStream(res, model, text) {
	const id = `resp_fixture_${Date.now()}`;
	const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
	sse(res, [
		event({ type: "response.created", response: { id, status: "in_progress", model } }),
		event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
		event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }),
		event({ type: "response.output_item.done", output_index: 0, item }),
		event({
			type: "response.completed",
			response: { id, status: "completed", model, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
		}),
	]);
}

let lastSessionFile = "";

function substitute(value) {
	const port = String(server.address()?.port ?? "");
	return JSON.parse(JSON.stringify(value).replaceAll("{{lastSessionFile}}", lastSessionFile).replaceAll("{{port}}", port));
}

/** File changes a plan step makes before it is sent, so a resume meets a changed world. */
function applyBefore(actions) {
	for (const action of substitute(actions ?? [])) {
		if (action.write) writeFileSync(action.write, action.content);
		else if (action.remove) rmSync(action.remove, { force: true });
		else if (action.chmod) chmodSync(action.chmod, action.mode);
		else if (action.appendMetadata) {
			const lines = readFileSync(action.appendMetadata, "utf8").split("\n").filter(Boolean);
			const first = lines.map((line) => JSON.parse(line)).find((entry) => entry.customType === "pi-subagents_launch_metadata");
			const entry = { ...first, id: `forged${Date.now()}`, data: { ...first.data, ...action.merge, timestamp: new Date().toISOString() } };
			appendFileSync(action.appendMetadata, `${JSON.stringify(entry)}\n`);
		} else if (action.rewriteFirstMetadata) {
			const lines = readFileSync(action.rewriteFirstMetadata, "utf8").split("\n").filter(Boolean);
			let done = false;
			const out = lines.map((line) => {
				const entry = JSON.parse(line);
				if (done || entry.customType !== "pi-subagents_launch_metadata") return line;
				done = true;
				return JSON.stringify({ ...entry, data: { ...entry.data, ...action.merge } });
			});
			writeFileSync(action.rewriteFirstMetadata, `${out.join("\n")}\n`);
		}
	}
}

/**
 * The parent driver plays the plan's tool calls in order: the n-th call is
 * sent when the request carries n tool results. `{{lastSessionFile}}` is the
 * last `Session: <path>` any tool result named, so a resume step can target
 * the session an earlier launch created, even from a later parent process.
 * A request that is not the parent's (a child inheriting the driver model)
 * gets a plain child reply.
 */
function parentStream(res, body) {
	const plan = readPlan();
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const chunk = (delta, finish = null) =>
		`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const firstUser = messages.find((message) => message.role === "user");
	if (!textOf(firstUser?.content).includes("Run the qualification plan.")) {
		sse(res, [chunk({ role: "assistant", content: childReply("parent", body.model) }), chunk({}, "stop"), "data: [DONE]\n\n"]);
		return { parentStep: "child" };
	}
	const toolResults = messages.filter((message) => message.role === "tool");
	for (const message of toolResults) {
		const match = textOf(message.content).match(/Session: (\S+\.jsonl)/);
		if (match) lastSessionFile = match[1];
	}
	const step = plan.steps?.[toolResults.length];
	if (!step) {
		sse(res, [chunk({ role: "assistant", content: "PARENT_DONE" }), chunk({}, "stop"), "data: [DONE]\n\n"]);
		return { parentStep: "final", toolResults: toolResults.map((message) => textOf(message.content).slice(0, 8000)) };
	}
	applyBefore(step.before);
	const args = substitute(step.arguments);
	sse(res, [
		chunk({
			role: "assistant",
			tool_calls: [{ index: 0, id: `call_${toolResults.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(args) } }],
		}),
		chunk({}, "tool_calls"),
		"data: [DONE]\n\n",
	]);
	return {
		parentStep: toolResults.length,
		tool: step.tool,
		arguments: args,
		toolResults: toolResults.map((message) => textOf(message.content).slice(0, 8000)),
	};
}

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (data) => {
		chunks.push(data);
	});
	req.on("end", () => {
		const raw = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
		const url = (req.url ?? "").split("?")[0];
		let body = {};
		try {
			body = raw ? JSON.parse(raw) : {};
		} catch {}
		const base = {
			method: req.method,
			url,
			model: body.model,
			tools: toolNames(body.tools),
			systemLength: systemText(body).length,
			systemHasContextFiles: /AGENTS\.md|CLAUDE\.md/.test(systemText(body)),
			systemHasSkills: /<available_skills>/.test(systemText(body)),
			headers: {
				"x-api-key": req.headers["x-api-key"] ? "present" : undefined,
				authorization: req.headers.authorization ? "present" : undefined,
				"user-agent": req.headers["user-agent"],
				"content-encoding": req.headers["content-encoding"],
			},
			bodyKeys: Object.keys(body).sort(),
		};
		// The scripted driver speaks chat completions; a parent that overrides a
		// native provider for itself reaches it under that provider's prefix.
		if (req.method === "POST" && (url.startsWith("/parent/") || url.endsWith("/chat/completions"))) {
			const messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({
				role: message.role,
				text: textOf(message.content).slice(0, 8000),
			}));
			record({ route: "parent", ...base, messages, ...parentStream(res, body) });
			return;
		}
		if (req.method === "POST" && url.startsWith("/anthropic/") && url.endsWith("/messages")) {
			record({ route: "anthropic", ...base });
			anthropicStream(res, body.model, childReply("anthropic", body.model));
			return;
		}
		if (req.method === "POST" && url.startsWith("/legacy/") && url.endsWith("/messages")) {
			record({ route: "legacy", ...base });
			anthropicStream(res, body.model, childReply("legacy", body.model));
			return;
		}
		if (req.method === "POST" && url.startsWith("/codex/") && url.endsWith("/responses")) {
			record({ route: "codex", ...base });
			codexStream(res, body.model, childReply("codex", body.model));
			return;
		}
		record({ route: "unexpected", ...base });
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { type: "not_found", message: `fixture has no route ${url}` } }));
	});
});

server.on("upgrade", (req, socket) => {
	record({ route: "unexpected", method: "UPGRADE", url: req.url, headers: { "user-agent": req.headers["user-agent"] } });
	socket.destroy();
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	writeFileSync(join(evidenceDir, "endpoints.port"), String(address.port));
});
