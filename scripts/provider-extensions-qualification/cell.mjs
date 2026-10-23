/**
 * Runs one qualification cell: a real parent Pi CLI that loads this checkout's
 * pi-subagents, driven by the scripted fixture model, launching or resuming a
 * real child Pi CLI through the ordinary `subagent` / `subagent_resume` tools.
 *
 * Must run inside the loopback-only network namespace `run.mjs` creates.
 * Returns the raw observations; `scenarios.mjs` judges them.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");
export const fixtureExtensions = join(here, "fixtures");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, deadlineMs, label) {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		const value = check();
		if (value) return value;
		await sleep(200);
	}
	throw new Error(`deadline: ${label} not reached within ${deadlineMs}ms`);
}

function fakeJwt(accountId) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, exp: 4102444800 })}.fixture`;
}

function frontmatter(definition) {
	const lines = ["---"];
	for (const [key, value] of Object.entries(definition.fields)) {
		if (value.includes("\n")) {
			lines.push(`${key}: |`);
			for (const line of value.split("\n")) lines.push(`  ${line}`);
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---", "", definition.body ?? "Reply with one short line.", "");
	return lines.join("\n");
}

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { unparsed: line };
			}
		});
}

/** Child session files under the fixture agent dir, with the facts a cell judges. */
function readChildSessions(agentDir) {
	const root = join(agentDir, "sessions");
	const found = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	};
	walk(root);
	return found.map((path) => {
		const entries = readJsonLines(path);
		const launchMetadata = entries
			.filter((entry) => entry.type === "custom" && entry.customType === "pi-subagents_launch_metadata")
			.map((entry) => entry.data);
		const assistant = entries
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
			.map((entry) => ({
				provider: entry.message.provider,
				model: entry.message.model,
				stopReason: entry.message.stopReason,
				errorMessage: entry.message.errorMessage,
				text: (entry.message.content ?? []).map((part) => part.text ?? "").join(""),
			}));
		const modelChanges = entries
			.filter((entry) => entry.type === "model_change")
			.map((entry) => ({ provider: entry.provider, modelId: entry.modelId }));
		return { path, launchMetadata, assistant, modelChanges, isParent: launchMetadata.length === 0 };
	});
}

/** The cell's own copy of a fixture extension, so a scenario may change it between turns. */
export function cellExtension(cellDir, file) {
	return join(cellDir, "ext", file);
}

const AMBIENT_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default function () {
	const evidence = process.env.QUAL_EVIDENCE_DIR;
	if (evidence) appendFileSync(join(evidence, "extension-loads.jsonl"), JSON.stringify({ pid: process.pid, extension: "fixture-ambient", at: new Date().toISOString() }) + "\\n");
}
`;

export function prepareCell({ cellDir, evidenceDir, host, definition, legacyConfig, copies = [], extraEnv = {}, files = [], parentExtensions = [], parentModel }) {
	const home = join(cellDir, "home");
	const agentDir = join(cellDir, "agent");
	const workspace = join(cellDir, "workspace");
	for (const dir of [home, join(agentDir, "agents"), join(agentDir, "extensions"), join(cellDir, "ext"), workspace, evidenceDir]) {
		mkdirSync(dir, { recursive: true });
	}
	for (const file of readdirSync(fixtureExtensions)) copyFileSync(join(fixtureExtensions, file), cellExtension(cellDir, file));
	for (const [from, to] of copies) copyFileSync(join(fixtureExtensions, from), cellExtension(cellDir, to));
	// Ambient discovery would load this; a declaring child must not.
	writeFileSync(join(agentDir, "extensions", "ambient.ts"), AMBIENT_EXTENSION);
	writeFileSync(join(agentDir, "agents", `${definition.fields.name}.md`), frontmatter(definition));
	writeFileSync(join(evidenceDir, "agent-definition.md"), frontmatter(definition));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ transport: "sse", quietStartup: true }, null, 2));
	const env = {
		PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
		HOME: home,
		USER: "fixture",
		LANG: "C.UTF-8",
		TERM: "xterm-256color",
		TMPDIR: join(cellDir, "tmp"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
		QUAL_EVIDENCE_DIR: evidenceDir,
		NODE_OPTIONS: `--import ${join(here, "network-guard.mjs")}`,
		...extraEnv,
	};
	mkdirSync(env.TMPDIR, { recursive: true });
	if (legacyConfig === "valid") {
		env.FIXTURE_LEGACY_CONFIG = join(cellDir, "legacy-config.json");
	} else if (legacyConfig === "absent") {
		env.FIXTURE_LEGACY_CONFIG = join(cellDir, "no-such-legacy-config.json");
	} else if (legacyConfig === "unusable") {
		env.FIXTURE_LEGACY_CONFIG = join(cellDir, "legacy-config.json");
	}
	for (const file of files) {
		mkdirSync(dirname(file.path), { recursive: true });
		if (file.copyFrom) copyFileSync(join(fixtureExtensions, file.copyFrom), file.path);
		else writeFileSync(file.path, file.content);
		chmodSync(file.path, file.mode ?? 0o644);
	}
	return { home, agentDir, workspace, env, cellDir, evidenceDir, host, legacyConfig, parentExtensions, parentModel };
}

export function writeEndpointConfig(cell, port) {
	const base = `http://127.0.0.1:${port}`;
	for (const [key, value] of Object.entries(cell.env)) cell.env[key] = value.replaceAll("{{port}}", String(port));
	writeFileSync(
		join(cell.agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					...Object.fromEntries(
						["fixture-parent", "fixture-parent-b"].map((name) => [
							name,
							{
								baseUrl: `${base}/parent/v1`,
								api: "openai-completions",
								apiKey: "fixture-parent-key",
								compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
								models: [{ id: "driver", reasoning: false, contextWindow: 200000, maxTokens: 4096 }],
							},
						]),
					),
					anthropic: { baseUrl: `${base}/anthropic`, apiKey: "fixture-anthropic-key" },
					"openai-codex": { baseUrl: `${base}/codex`, apiKey: fakeJwt("fixture-account") },
				},
			},
			null,
			2,
		),
	);
	if (cell.legacyConfig === "valid") {
		writeFileSync(join(cell.cellDir, "legacy-config.json"), JSON.stringify({ baseUrl: `${base}/legacy` }));
	} else if (cell.legacyConfig === "unusable") {
		writeFileSync(join(cell.cellDir, "legacy-config.json"), JSON.stringify({ note: "no baseUrl" }));
	}
}

export function startEndpoints(cell, deadlineMs = 10_000) {
	const server = spawn(process.execPath, [join(here, "fake-endpoints.mjs"), cell.evidenceDir, join(cell.evidenceDir, "plan.json")], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { PATH: cell.env.PATH },
	});
	let stderr = "";
	server.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const portFile = join(cell.evidenceDir, "endpoints.port");
	return waitFor(() => existsSync(portFile) && Number(readFileSync(portFile, "utf8")), deadlineMs, "fake endpoints").then(
		(port) => ({ port, stop: () => server.kill("SIGTERM"), stderr: () => stderr }),
	);
}

export function writePlan(cell, steps) {
	writeFileSync(join(cell.evidenceDir, "plan.json"), JSON.stringify({ steps }, null, 2));
}

function parentArgs(cell, parentModel = cell.parentModel ?? "fixture-parent/driver") {
	const cli = join(cell.host, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	return {
		cli,
		args: [
			"--model",
			parentModel,
			"--no-extensions",
			"-e",
			join(repoRoot, "src", "index.ts"),
			...cell.parentExtensions.flatMap((extension) => ["-e", extension]),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
		],
	};
}

/** Background cells: `pi -p` makes the parent wait for each child synchronously. */
export async function runPrintParent(cell, deadlineMs, parentModel, phase = 0) {
	const { cli, args } = parentArgs(cell, parentModel);
	const result = spawnSync(process.execPath, [cli, ...args, "-p", "Run the qualification plan."], {
		cwd: cell.workspace,
		env: cell.env,
		encoding: "utf8",
		timeout: deadlineMs,
		killSignal: "SIGKILL",
	});
	writeFileSync(join(cell.evidenceDir, `parent-${phase}.stdout`), result.stdout ?? "");
	writeFileSync(join(cell.evidenceDir, `parent-${phase}.stderr`), result.stderr ?? "");
	return {
		status: result.status,
		signal: result.signal,
		timedOut: result.error?.code === "ETIMEDOUT",
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function tmux(cell, socket, args, deadlineMs = 10_000) {
	return spawnSync("tmux", ["-S", socket, ...args], { env: cell.env, encoding: "utf8", timeout: deadlineMs });
}

/**
 * Interactive cells: the parent runs as a TUI inside a private tmux server and
 * receives its prompt after startup, so its children open real tmux panes.
 */
export async function runInteractiveParent(cell, socket, deadlineMs, session = "parent") {
	const { cli, args } = parentArgs(cell);
	const env = { ...cell.env, PI_SUBAGENT_MUX: "tmux" };
	const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
	const envPrefix = Object.entries(env)
		.map(([key, value]) => `${key}=${quote(value)}`)
		.join(" ");
	const command = `cd ${quote(cell.workspace)} && env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${envPrefix} ${quote(process.execPath)} ${[cli, ...args].map(quote).join(" ")} 2> ${quote(join(cell.evidenceDir, "parent.stderr"))}; echo PARENT_EXIT=$? > ${quote(join(cell.evidenceDir, "parent.exit"))}`;
	const started = tmux({ env }, socket, ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", command]);
	if (started.status !== 0) throw new Error(`tmux new-session failed: ${started.stderr}`);
	const capture = () => tmux({ env }, socket, ["capture-pane", "-p", "-t", `${session}:0.0`]).stdout ?? "";
	const exitFile = join(cell.evidenceDir, "parent.exit");
	const stderrOf = () => (existsSync(join(cell.evidenceDir, "parent.stderr")) ? readFileSync(join(cell.evidenceDir, "parent.stderr"), "utf8") : "");
	// The footer names the parent's model once the TUI is up.
	const parentModelId = (cell.parentModel ?? "fixture-parent/driver").split("/").pop();
	await waitFor(() => existsSync(exitFile) || capture().includes(parentModelId), 30_000, "parent TUI ready");
	if (existsSync(exitFile)) {
		return { finished: false, startupExit: readFileSync(exitFile, "utf8").trim(), stderr: stderrOf() };
	}
	await sleep(1000);
	tmux({ env }, socket, ["send-keys", "-t", `${session}:0.0`, "-l", "Run the qualification plan."]);
	tmux({ env }, socket, ["send-keys", "-t", `${session}:0.0`, "Enter"]);
	const requests = join(cell.evidenceDir, "requests.jsonl");
	let finished = false;
	try {
		const parentRequests = () => readJsonLines(requests).filter((entry) => entry.route === "parent" && entry.parentStep !== "child");
		await waitFor(() => parentRequests().some((entry) => entry.parentStep === "final"), deadlineMs, "parent final turn");
		// An async launch reports later, as a message the parent receives on a new turn.
		const launchedAsync = parentRequests().some((entry) =>
			(entry.messages ?? []).some((message) => message.role === "tool" && /launched async with id/.test(message.text)),
		);
		if (launchedAsync) {
			await waitFor(
				() =>
					parentRequests().some((entry) =>
						(entry.messages ?? []).some((message) => message.role === "user" && /^Sub-agent "/.test(message.text)),
					),
				deadlineMs,
				"async child result delivered to the parent",
			);
		}
		finished = true;
		await sleep(2000);
	} catch (error) {
		writeFileSync(join(cell.evidenceDir, "parent.timeout"), String(error));
	}
	writeFileSync(join(cell.evidenceDir, "parent.screen"), capture());
	const panes = tmux({ env }, socket, ["list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index} #{pane_pid} #{pane_current_command}"]);
	writeFileSync(join(cell.evidenceDir, "tmux-panes.txt"), panes.stdout ?? "");
	return { finished, timedOut: !finished, stderr: stderrOf() };
}

export function stopTmuxSession(cell, socket, session) {
	tmux(cell, socket, ["kill-session", "-t", session]);
}

export function stopTmux(cell, socket) {
	tmux(cell, socket, ["kill-server"]);
}

export function collectObservations(cell, parent) {
	const requests = readJsonLines(join(cell.evidenceDir, "requests.jsonl"));
	const loads = readJsonLines(join(cell.evidenceDir, "extension-loads.jsonl"));
	const processesDir = join(cell.evidenceDir, "processes");
	const processes = existsSync(processesDir)
		? readdirSync(processesDir).filter((file) => file.endsWith(".json")).flatMap((file) => {
				try {
					return [JSON.parse(readFileSync(join(processesDir, file), "utf8"))];
				} catch {
					return [{ pid: file, unreadable: true, piRoots: [], blocked: [], subagentName: null }];
				}
			})
		: [];
	const sessions = readChildSessions(cell.agentDir);
	const observations = { parent, requests, loads, processes, sessions };
	writeFileSync(join(cell.evidenceDir, "observations.json"), JSON.stringify(observations, null, 2));
	return observations;
}
