/**
 * Reference-consumer suite (pi-config#1221): the researcher-shaped definition
 * with the real pi-web-access and pi-multi-account packages from the host,
 * the real drover-quota-router and pi-claude-code-provider sources, and a fake
 * Claude CLI. The child inherits its model from the parent, as the researcher
 * does: the parent runs on that model ref through the scripted driver.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cellExtension } from "./cell.mjs";

const AGENT = "researcher";
const LEGACY = "claude-primary/opus";
const ANTHROPIC = "anthropic/claude-haiku-4-5";
const CODEX = "openai-codex/gpt-5.5";
const CLAUDE_VERSION = "2.1.270";
const EMAIL = "fixture@example.invalid";
const ORG = "fixture-org";

function fingerprint() {
	return `sha256:${createHash("sha256").update(`pi-claude-code-provider:claude-auth-identity:v1\n${EMAIL}\n${ORG}`, "utf8").digest("hex")}`;
}

function researcher(mode, { hostDir, root }, config) {
	const provider = join(root, "sources", "pi-claude-code-provider");
	return {
		fields: {
			name: AGENT,
			description: "Source-backed research with runtime model routing and restricted web retrieval.",
			"allow-model-override": "false",
			mode: mode === "interactive" ? "interactive" : "background",
			"session-mode": "lineage-only",
			extensions: `${join(hostDir, "node_modules", "pi-web-access")},${join(hostDir, "extensions", "drover-quota-router", "index.ts")}`,
			"provider-extensions": `claude-primary=${provider}`,
			tools: "web_search",
			// The completion helper's protocol tools would otherwise be active beside web_search.
			"deny-tools": "caller_ping,subagent_done",
			skills: "none",
			spawning: "false",
			"no-context-files": "true",
			"auto-exit": "true",
			async: "false",
			"parent-close-policy": "terminate",
			...(config === "unset" ? {} : { env: `PI_CLAUDE_CODE_PROVIDER_CONFIG=${config}` }),
		},
	};
}

const launch = () => ({
	tool: "subagent",
	arguments: { agent: AGENT, name: "qual-researcher", title: "Qualification researcher", task: "Reply once." },
});
const resume = (before = []) => ({
	tool: "subagent_resume",
	arguments: { sessionFile: "{{lastSessionFile}}", task: "Reply again." },
	before,
});

/**
 * Files every consumer cell needs: the provider's instances file (mode 0600)
 * and its configuration root, the fake Claude settings, and the
 * quota-router policy the reference configuration ships.
 */
function instancesJson(fixtures, providerId) {
	const configRoot = join(fixtures, "claude-root");
	return JSON.stringify({ instances: [{ providerId, label: "primary", configRoot, expectedIdentityFingerprint: fingerprint() }] });
}

function consumerFiles({ fixtures, evidenceDir, root }) {
	return [
		{ path: join(fixtures, "claude-root", ".keep"), content: "" },
		{ path: join(fixtures, "instances.json"), content: instancesJson(fixtures, "claude-primary"), mode: 0o600 },
		{
			path: cellExtension(fixtures, "fake-claude.json"),
			content: JSON.stringify({
				evidenceDir,
				version: CLAUDE_VERSION,
				email: EMAIL,
				orgId: ORG,
				helpPath: join(root, "sources", "pi-claude-code-provider", "test", "support", "captured", `claude-${CLAUDE_VERSION}-help.txt`),
			}),
		},
		{ path: cellExtension(fixtures, "fake-claude.mjs"), content: null, copyFrom: "fake-claude.mjs", mode: 0o755 },
		{
			path: join(fixtures, "agent", "drover-quota-router.json"),
			content: JSON.stringify({
				schemaVersion: 1,
				mode: "telemetry-only",
				allowedModes: ["disabled", "telemetry-only", "operator-confirmed"],
				accountLabels: ["claude-primary", "claude-secondary", "codex-primary", "codex-secondary"],
			}),
		},
	];
}

function setupFor({ mode, ...context }, { model, config, steps }) {
	const { fixtures } = context;
	const [driverProvider, driverModel] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)];
	const configPath = config === "valid" ? join(fixtures, "instances.json") : config === "absent" ? join(fixtures, "no-such-instances.json") : "unset";
	return {
		definition: researcher(mode, context, configPath),
		legacyConfig: "unset",
		files: consumerFiles(context),
		parentExtensions: [cellExtension(fixtures, "parent-driver.ts")],
		parentModel: model,
		extraEnv: {
			PI_CLAUDE_CODE_PROVIDER_PATH: cellExtension(fixtures, "fake-claude.mjs"),
			FIXTURE_DRIVER_PROVIDER: driverProvider,
			FIXTURE_DRIVER_MODEL: driverModel,
			FIXTURE_DRIVER_BASEURL: "http://127.0.0.1:{{port}}/parent/v1",
			// pi-multi-account pins anthropic to the public API over models.json.
			QUAL_FETCH_REDIRECTS: JSON.stringify({ "https://api.anthropic.com": "http://127.0.0.1:{{port}}/anthropic" }),
		},
		steps: steps ?? (mode === "resume" ? [launch(), resume()] : [launch()]),
	};
}

function readJsonLines(path) {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function finalOutcomes(observations) {
	const seen = [];
	for (const request of observations.requests) {
		if (request.route !== "parent" || request.parentStep === "child") continue;
		for (const message of request.messages ?? []) {
			const delivered = message.role === "user" && /^Sub-agent "/.test(message.text);
			if ((message.role === "tool" || delivered) && !seen.includes(message.text)) seen.push(message.text);
		}
	}
	return seen.filter((text) => !/launched async with id/.test(text.split("\n")[0]));
}

function common(observations, context, reasons) {
	const versions = new Set(observations.processes.flatMap((process) => process.piRoots.map((root) => root.version)).filter(Boolean));
	if (versions.size !== 1 || !versions.has(context.host)) reasons.push(`Pi versions loaded: ${[...versions].join(",") || "none"}`);
	const blocked = observations.processes.flatMap((process) => process.blocked);
	if (blocked.length > 0) reasons.push(`${blocked.length} non-loopback connection attempts (${blocked.map((b) => `${b.host}:${b.port}`).join(",")})`);
	const unreadable = observations.processes.filter((process) => process.unreadable);
	if (unreadable.length > 0) reasons.push(`${unreadable.length} process records were unreadable`);
	const unexpected = observations.requests.filter((request) => request.route === "unexpected");
	if (unexpected.length > 0) reasons.push(`${unexpected.length} requests to unknown fixture routes (${unexpected.map((r) => r.url).join(",")})`);
	if (observations.parent?.error || observations.parent?.timedOut) reasons.push(`parent did not finish: ${observations.parent.error ?? "deadline"}`);
	if (!observations.requests.some((request) => request.parentStep === "final")) reasons.push("parent never reached its final turn");
	const childLoads = observations.loads.filter((load) => load.extension === "fixture-ambient");
	const parentPids = new Set(observations.processes.filter((process) => process.subagentName === null).map((process) => process.pid));
	if (childLoads.some((load) => !parentPids.has(load.pid))) reasons.push("a child loaded the ambient extension");
	const invocations = readJsonLines(join(context.cell.evidenceDir, "claude-invocations.jsonl"));
	const redirected = observations.processes.flatMap((process) => process.redirected ?? []);
	if (invocations.some((invocation) => invocation.owner == null)) reasons.push("a Claude CLI run has no recorded owner process");
	const invokers = new Set(invocations.map((invocation) => invocation.owner)).size;
	const childProcesses = observations.processes.filter((process) => process.subagentName !== null).length;
	return { versions: [...versions], blocked: blocked.length, redirected: redirected.map((r) => r.from), invocations: invocations.length, invokers, childProcesses, outcomes: finalOutcomes(observations).map((t) => t.slice(0, 300)) };
}

const ROUTES = { anthropic: "anthropic", "openai-codex": "codex", "claude-primary": "claude" };

/** The researcher answered on `model` with exactly `web_search` active, and no other model or Claude CLI ran. */
function expectConsumerRun(model) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		const turns = context.mode === "resume" ? 2 : 1;
		const [provider, id] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)];
		const route = ROUTES[provider];
		const childRequests = observations.requests.filter((request) => request.route !== "parent" && request.route !== "unexpected");
		const elsewhere = childRequests.filter((request) => request.route !== route);
		if (elsewhere.length > 0) reasons.push(`child requests reached ${elsewhere.map((r) => r.route).join(",")}`);
		if (childRequests.length < turns) reasons.push(`${childRequests.length} child model requests, expected ${turns}`);
		for (const request of childRequests) {
			if ((request.tools ?? []).join(",") !== "web_search") reasons.push(`a request carried tools ${(request.tools ?? []).join(",") || "none"}`);
			if (request.systemHasContextFiles) reasons.push("a request carried context files");
			if (request.systemHasSkills) reasons.push("a request carried skills");
		}
		const replies = observations.sessions
			.filter((session) => !session.isParent)
			.flatMap((session) => session.assistant)
			.filter((reply) => /CHILD_OK/.test(reply.text))
			.map((reply) => `${reply.provider}/${reply.model}`);
		const expected = Array.from({ length: turns }, () => `${provider}/${id}`);
		if (replies.join(",") !== expected.join(",")) reasons.push(`child answered on ${replies.join(",") || "nothing"}, expected ${expected.join(",")}`);
		// The quota router records one decision per model request it shapes.
		const decisionsPath = join(context.cell.agentDir, "drover-quota-router", "decisions.json");
		const decisions = existsSync(decisionsPath) ? JSON.parse(readFileSync(decisionsPath, "utf8")) : [];
		if (decisions.length < turns) reasons.push(`the quota router recorded ${decisions.length} request decisions, expected ${turns}`);
		facts.routerDecisions = decisions.length;
		if (provider === "claude-primary" ? facts.invocations === 0 : facts.invocations > 0) {
			reasons.push(`the Claude CLI ran ${facts.invocations} times`);
		}
		for (const text of facts.outcomes) if (/failed|Error/.test(text.split("\n")[0])) reasons.push(`a result failed: ${text.split("\n")[0]}`);
		return { result: reasons.length ? "fail" : "pass", reasons, facts: { ...facts, childRequests, replies } };
	};
}

/**
 * The researcher fails at startup with `diagnostic`, after no model request.
 * `providerRan` says whether the failing child's provider got far enough to
 * run the Claude CLI: that proves the conditional source was selected when
 * the same error could otherwise come from a missing provider.
 */
function expectConsumerStartupFailure(diagnostic, { providerRan }) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		const before = context.mode === "resume" ? 1 : 0;
		const childRequests = observations.requests.filter((request) => request.route !== "parent" && request.route !== "unexpected");
		if (childRequests.length !== before) reasons.push(`${childRequests.length} child model requests, expected ${before}`);
		const last = finalOutcomes(observations).at(-1) ?? "";
		// A pane wraps long lines; the diagnostic may span them.
		if (!diagnostic.test(last.replaceAll("\n", ""))) reasons.push(`the parent's last result lacks the diagnostic: ${last.slice(0, 300)}`);
		if (!/failed/i.test(last.split("\n")[0])) reasons.push("the parent's last result does not report a failure");
		if (facts.childProcesses < before + 1) reasons.push("the failing child process never ran");
		const invokers = before + (providerRan ? 1 : 0);
		if (facts.invokers !== invokers) reasons.push(`the Claude CLI ran from ${facts.invokers} processes, expected ${invokers}`);
		return { result: reasons.length ? "fail" : "pass", reasons, facts: { ...facts, childRequests } };
	};
}

const ALL = ["background", "interactive", "resume"];
const SCENARIOS = [
	{ name: "consumer-legacy-success", modes: ALL, setup: (c) => setupFor(c, { model: LEGACY, config: "valid" }), judge: expectConsumerRun(LEGACY) },
	...[
		["consumer-native-anthropic-unset", ANTHROPIC, "unset"],
		["consumer-native-anthropic-absent", ANTHROPIC, "absent"],
		["consumer-native-codex-unset", CODEX, "unset"],
		["consumer-native-codex-absent", CODEX, "absent"],
	].map(([name, model, config]) => ({ name, modes: ALL, setup: (c) => setupFor(c, { model, config }), judge: expectConsumerRun(model) })),
	{
		name: "consumer-legacy-missing-config",
		modes: ALL,
		setup: (c) =>
			setupFor(c, {
				model: LEGACY,
				config: "valid",
				steps: c.mode === "resume" ? [launch(), resume([{ remove: join(c.fixtures, "instances.json") }])] : [{ ...launch(), before: [{ remove: join(c.fixtures, "instances.json") }] }],
			}),
		judge: expectConsumerStartupFailure(/configuration file is unavailable/, { providerRan: false }),
	},
	{
		name: "consumer-extension-load-failure",
		modes: ALL,
		setup: (c) => {
			const loosen = [{ chmod: join(c.fixtures, "instances.json"), mode: 0o644 }];
			return setupFor(c, {
				model: LEGACY,
				config: "valid",
				steps: c.mode === "resume" ? [launch(), resume(loosen)] : [{ ...launch(), before: loosen }],
			});
		},
		judge: expectConsumerStartupFailure(/must have mode 0600/, { providerRan: false }),
	},
	{
		name: "consumer-unresolvable-provider",
		modes: ALL,
		setup: (c) => {
			const rename = [{ write: join(c.fixtures, "instances.json"), content: instancesJson(c.fixtures, "claude-secondary") }];
			return setupFor(c, {
				model: LEGACY,
				config: "valid",
				steps: c.mode === "resume" ? [launch(), resume(rename)] : [{ ...launch(), before: rename }],
			});
		},
		judge: expectConsumerStartupFailure(/Unknown provider "claude-primary"/, { providerRan: true }),
	},
];

export function consumerScenariosFor(options) {
	return SCENARIOS.filter(
		(scenario) => scenario.modes.includes(options.mode) && (options.scenarios.length === 0 || options.scenarios.includes(scenario.name)),
	).map((scenario) => ({ ...scenario, setup: (context) => scenario.setup({ ...context, mode: options.mode }) }));
}
