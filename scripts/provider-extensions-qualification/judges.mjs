/**
 * Judgements over one cell's observations. Each judge returns
 * `{ result: "pass" | "fail", reasons, facts }`; any reason fails the cell.
 *
 * Child model requests are counted from the fake endpoints' request log, which
 * records every request before it is answered. A child that inherits the
 * driver model talks to the parent route; those requests carry
 * `parentStep: "child"`.
 */

const ROUTE_BY_PROVIDER = { anthropic: "anthropic", "openai-codex": "codex", "claude-primary": "legacy" };

function splitModel(ref) {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Requests a child made to a model, by route. */
function childModelRequests(observations) {
	return observations.requests.filter(
		(request) => request.route !== "parent" || request.parentStep === "child",
	);
}

/**
 * What the parent was told, in order: tool results, and the results an async
 * (interactive) launch delivered later as messages.
 */
function toolResults(observations) {
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

function childReplies(observations) {
	return observations.sessions
		.filter((session) => !session.isParent)
		.flatMap((session) => session.assistant)
		.filter((reply) => /CHILD_OK/.test(reply.text));
}

function childProcesses(observations) {
	return observations.processes.filter((process) => process.subagentName !== null);
}

/** Extension loads grouped per process, in load order. */
function loadSequences(observations) {
	const byPid = new Map();
	for (const load of observations.loads) {
		if (!byPid.has(load.pid)) byPid.set(load.pid, []);
		byPid.get(load.pid).push(load.extension);
	}
	return [...byPid.values()];
}

function common(observations, context, reasons) {
	const versions = new Set();
	for (const process of observations.processes) {
		for (const root of process.piRoots) if (root.version) versions.add(root.version);
	}
	if (versions.size !== 1 || !versions.has(context.host)) {
		reasons.push(`Pi versions loaded: ${[...versions].join(",") || "none recorded"} (expected only ${context.host})`);
	}
	const blocked = observations.processes.flatMap((process) => process.blocked);
	if (blocked.length > 0) reasons.push(`${blocked.length} non-loopback connection attempts`);
	const unreadable = observations.processes.filter((process) => process.unreadable);
	if (unreadable.length > 0) reasons.push(`${unreadable.length} process records were unreadable`);
	const unexpected = observations.requests.filter((request) => request.route === "unexpected");
	if (unexpected.length > 0) reasons.push(`${unexpected.length} requests to unknown fixture routes`);
	const parent = observations.parent ?? {};
	if (parent.error || parent.timedOut) reasons.push(`parent did not finish: ${parent.error ?? "deadline reached"}`);
	if (!observations.requests.some((request) => request.parentStep === "final")) reasons.push("parent never reached its final turn");
	return {
		versions: [...versions],
		blocked: blocked.length,
		unexpected: unexpected.length,
		childProcesses: childProcesses(observations).length,
		toolResults: toolResults(observations).map((text) => text.slice(0, 400)),
		loads: loadSequences(observations),
		childRequests: childModelRequests(observations).map((request) => `${request.route}:${request.model}`),
		childTools: childModelRequests(observations).map((request) => request.tools),
	};
}

function finish(reasons, facts) {
	return { result: reasons.length === 0 ? "pass" : "fail", reasons, facts };
}

/**
 * The child ran on `model` (and on `resumedModel` for the resumed turn),
 * every model request went to that model's route, and each child process
 * loaded exactly `expectedLoads`, in order: no ambient or legacy extension.
 */
export function expectRunOn(model, { resumedModel, route, expectedLoads }) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		const turns = context.mode === "resume" ? 2 : 1;
		const expected = [model, ...(turns === 2 ? [resumedModel ?? model] : [])];
		const replies = childReplies(observations);
		const actual = replies.map((reply) => `${reply.provider}/${reply.model}`);
		if (actual.join(",") !== expected.join(",")) reasons.push(`child answered on ${actual.join(",") || "nothing"}, expected ${expected.join(",")}`);
		const expectedRoute = route ?? ROUTE_BY_PROVIDER[splitModel(model).provider];
		const requests = childModelRequests(observations);
		const elsewhere = requests.filter((request) => request.route !== expectedRoute);
		if (elsewhere.length > 0) reasons.push(`${elsewhere.length} child requests reached another route (${elsewhere.map((r) => r.route).join(",")})`);
		if (requests.length < turns) reasons.push(`child made ${requests.length} model requests, expected ${turns}`);
		const sequences = loadSequences(observations);
		if (sequences.length < turns) reasons.push(`extension loads recorded for ${sequences.length} child processes, expected ${turns}`);
		for (const sequence of sequences) {
			if (sequence.join(",") !== expectedLoads.join(",")) reasons.push(`a child loaded ${sequence.join(",")}, expected ${expectedLoads.join(",")}`);
		}
		for (const text of toolResults(observations)) {
			if (/failed|Error/.test(text.split("\n")[0])) reasons.push(`a tool result failed: ${text.split("\n")[0].slice(0, 200)}`);
		}
		return finish(reasons, { ...facts, replies: actual });
	};
}

export const expectNativeSuccess = (model, options = {}) =>
	expectRunOn(model, { expectedLoads: ["fixture-unconditional-marker"], ...options });

export const expectLegacySuccess = () =>
	expectRunOn("claude-primary/opus", { expectedLoads: ["fixture-unconditional-marker", "fixture-legacy-provider"] });

export const expectStaticSuccess = (model, expectedLoads) => expectRunOn(model, { expectedLoads });

/**
 * The child fails at startup with `diagnostic` visible to the parent, after no
 * model request and with no reply from any model. In resume mode the launch
 * turn succeeds first, so exactly one request and one reply precede the
 * failing resume.
 */
export function expectChildStartupFailure(diagnostic, { requiredLoad } = {}) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		const before = context.mode === "resume" ? 1 : 0;
		const requests = childModelRequests(observations);
		if (requests.length !== before) reasons.push(`child made ${requests.length} model requests, expected ${before}`);
		const replies = childReplies(observations);
		if (replies.length !== before) reasons.push(`child models replied ${replies.length} times, expected ${before}`);
		const results = toolResults(observations);
		const last = results.at(-1) ?? "";
		// A pane wraps long lines; the diagnostic may span them.
		if (!diagnostic.test(last.replaceAll("\n", ""))) reasons.push(`the parent's last tool result does not carry the diagnostic: ${last.slice(0, 300)}`);
		if (!/failed|exited|error/i.test(last.split("\n")[0])) reasons.push("the parent's last tool result does not report a failure");
		if (childProcesses(observations).length < before + 1) reasons.push("the failing child process never ran");
		if (requiredLoad) {
			// Proves the conditional source was selected: without it the same error would appear.
			const sequences = loadSequences(observations);
			if (sequences.length < before + 1 || sequences.some((sequence) => !sequence.includes(requiredLoad))) {
				reasons.push(`not every child loaded ${requiredLoad}: ${JSON.stringify(sequences)}`);
			}
		}
		return finish(reasons, facts);
	};
}

/** The launch is refused before any child process or model request exists. */
export function expectRefusedBeforeSpawn(message) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		if (childProcesses(observations).length > 0) reasons.push(`${childProcesses(observations).length} child processes started`);
		if (observations.loads.length > 0) reasons.push("a child loaded extensions");
		if (childModelRequests(observations).length > 0) reasons.push("a child model request was made");
		const last = toolResults(observations).at(-1) ?? "";
		if (!message.test(last)) reasons.push(`the refusal does not name its reason: ${last.slice(0, 300)}`);
		return finish(reasons, facts);
	};
}

/** The launch turn succeeds; the resume is refused before a second child process or request. */
export function expectResumeRefused(message) {
	return (observations, context) => {
		const reasons = [];
		const facts = common(observations, context, reasons);
		if (childProcesses(observations).length !== 1) reasons.push(`${childProcesses(observations).length} child processes ran, expected 1`);
		if (childModelRequests(observations).length !== 1) reasons.push(`${childModelRequests(observations).length} child model requests, expected 1`);
		if (childReplies(observations).length !== 1) reasons.push(`${childReplies(observations).length} child replies, expected 1`);
		const last = toolResults(observations).at(-1) ?? "";
		if (!message.test(last)) reasons.push(`the resume refusal does not name its reason: ${last.slice(0, 300)}`);
		return finish(reasons, facts);
	};
}

/** The parent refuses to start with `message`: no child process, extension load or model request exists. */
export function expectParentStartupRefused(message) {
	return (observations) => {
		const reasons = [];
		const parent = observations.parent ?? {};
		const stderr = [parent.stderr ?? "", ...(parent.phases ?? []).map((phase) => phase.stderr ?? "")].join("\n");
		const phases = parent.phases ?? [];
		const exited = parent.startupExit
			? /PARENT_EXIT=[1-9]/.test(parent.startupExit)
			: phases.length > 0 && phases.every((phase) => phase.status !== 0);
		if (!exited) reasons.push("the parent did not exit with a failure");
		if (!message.test(stderr)) reasons.push(`the parent's error does not name the reason: ${stderr.slice(0, 300)}`);
		if (childProcesses(observations).length > 0) reasons.push("a child process started");
		if (observations.loads.length > 0) reasons.push("a child loaded extensions");
		if (observations.requests.length > 0) reasons.push(`${observations.requests.length} model requests were made`);
		const blocked = observations.processes.flatMap((process) => process.blocked);
		if (blocked.length > 0) reasons.push(`${blocked.length} non-loopback connection attempts`);
		if (observations.processes.some((process) => process.unreadable)) reasons.push("a process record was unreadable");
		return finish(reasons, { stderr: stderr.slice(0, 600) });
	};
}
