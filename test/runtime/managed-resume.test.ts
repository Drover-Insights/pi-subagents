import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	symlinkSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { readPilotCase } from "../../src/routing/pilot-attempt-store.ts";
import { readResumeSnapshot, writeResumeSnapshot } from "../../src/routing/resume-snapshot-store.ts";
import { ResumeRefusal } from "../../src/runtime/resume-refusal.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import { assert } from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";
import {
	capturePiInvocation,
	managedLaunchHarness,
	readEventually,
	resumeRuntime,
	writeManagedDefinition,
	writeManagedDefinitions,
} from "../support/managed-children.ts";
import {
	COMPLETION_HELPER_PATH,
	canonicalPolicyDocument,
	type PolicyDocument,
	writeCanonicalPolicy,
} from "../support/routing-policy.ts";

let agentDir: string;
let policy: PolicyDocument;

function usePolicy(edit?: (document: PolicyDocument) => void): void {
	policy = canonicalPolicyDocument();
	edit?.(policy);
	agentDir = writeCanonicalPolicy(policy);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeManagedDefinitions(agentDir);
}

/** Rewrite the policy in the same agent directory, keeping its trusted state stores. */
function editPolicy(edit: (document: PolicyDocument) => void): void {
	edit(policy);
	writeFileSync(join(agentDir, "drover-model-routing.json"), JSON.stringify(policy));
}

const worker = {
	name: "slice-worker",
	title: "Slice worker",
	task: "Map the slice",
	agent: "pilot-worker",
	capabilityClass: "implementation",
};

const scout = {
	name: "route-scout",
	title: "Route map",
	task: "Map the route",
	agent: "pilot-scout",
	capabilityClass: "literal",
	pilotCase: "scout-literal-1",
};

async function assertRefused(promise: Promise<unknown>, code: RegExp, invocation: { args: string }): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ResumeRefusal, `expected a ResumeRefusal, got ${String(error)}`);
		assert.equal(error.reason, "resume_denied");
		assert.match(error.message, code);
		return true;
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(existsSync(invocation.args), false, "no child process may start");
}

function snapshotFile(): string {
	const root = join(agentDir, "resume-snapshots");
	const [dir] = readdirSync(root);
	return join(root, dir, "snapshot.json");
}

describe("managed resume narrows to the launch snapshot", () => {
	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === "PI_SUBAGENT_AGENT" || key.startsWith("PI_SUBAGENT_SPAWN")) delete process.env[key];
		}
		resetSpawnWidthForTest();
		usePolicy();
		// A pilot receipt needs a Pi command that is a standalone binary.
		const bin = realpathSync(mkdtempSync(join(tmpdir(), "managed-bin-")));
		const fakePi = join(bin, "fake-pi");
		writeFileSync(fakePi, readFileSync("/usr/bin/true"));
		chmodSync(fakePi, 0o755);
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
	});

	it("records the launch's authority snapshot in the trusted state store", async () => {
		const running = await managedLaunchHarness().run(worker);

		const read = readResumeSnapshot(join(agentDir, "resume-snapshots"), running.sessionFile);

		assert.equal(read.status, "found");
		const snapshot = (read as Extract<typeof read, { status: "found" }>).snapshot;
		assert.deepEqual(
			{
				launchId: snapshot.launchId,
				session: snapshot.session,
				trust: snapshot.trust,
				generation: snapshot.evidence.generation,
				route: snapshot.evidence.route,
				extensions: snapshot.launch.extensions.map((extension) => extension.id),
				tools: snapshot.evidence.tools,
				writeRoot: snapshot.writeRoot,
				executionGroup: snapshot.executionGroup.kind,
				terminal: snapshot.terminal,
			},
			{
				launchId: "dispatch-1",
				session: { file: running.sessionFile, id: "session-1" },
				trust: { kind: "tool" },
				generation: "test-generation-v1",
				route: { provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
				extensions: ["subagent-completion", "workspace-boundary", "drover-model-routing"],
				tools: "read,grep,find,ls",
				writeRoot: { path: running.launchMetadata?.cwd, mode: "read-only" },
				executionGroup: "process",
				terminal: { kind: "none" },
			},
		);
		assert.match(snapshot.ownershipToken, /^[0-9a-f]{32}$/);
		assert.equal(snapshot.ownershipToken, running.ownershipToken);
	});

	it("resumes from the snapshot alone, ignoring launch metadata the child appended to its session", async () => {
		const running = await managedLaunchHarness().run(worker);
		appendFileSync(
			running.sessionFile,
			`${JSON.stringify({
				type: "custom",
				customType: "subagent_launch_metadata",
				data: {
					...running.launchMetadata,
					modelRef: "openai-codex/gpt-6-sol:xhigh",
					tools: "read,bash,edit,write",
					extensions: ["/tmp/evil.ts"],
					flags: "--approve",
				},
			})}\n`,
		);
		const invocation = capturePiInvocation();

		const resumed = await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());

		const args = (await readEventually(invocation.args)).trim().split("\n");
		const env = await readEventually(invocation.env);
		assert.ok(!args.join(" ").includes("evil"), args.join(" "));
		assert.ok(!args.includes("--approve"));
		assert.deepEqual(args.slice(args.indexOf("--no-extensions"), args.indexOf("--no-extensions") + 7), [
			"--no-extensions",
			"-e",
			COMPLETION_HELPER_PATH,
			"-e",
			join(agentDir, "extensions/workspace-boundary/index.ts"),
			"-e",
			join(agentDir, "extensions/drover-model-routing/index.ts"),
		]);
		assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-6-sol:medium");
		assert.match(args[args.indexOf("--tools") + 1], /^read,grep,find,ls(,|$)/);
		assert.match(env, /^PI_SUBAGENT_TOOL_BROKER=.*"mode":"read-only"/m);
		assert.equal(resumed.routing?.generation, "test-generation-v1");
		assert.equal(resumed.ownershipToken, running.ownershipToken);
	});

	it("narrows extensions to what the current policy still grants, keeping safety resources", async () => {
		const extra = "export default function extra() {}\n";
		usePolicy((document) => {
			document.extensionCatalog["extra-tool"] = {
				source: "pi-config",
				files: [{ path: "extensions/extra-tool/index.ts", sha256: createHash("sha256").update(extra).digest("hex") }],
			};
			document.extensionGrants.worker = ["drover-model-routing", "extra-tool"];
		});
		mkdirSync(join(agentDir, "extensions/extra-tool"), { recursive: true });
		writeFileSync(join(agentDir, "extensions/extra-tool/index.ts"), extra);
		const running = await managedLaunchHarness().run(worker);
		assert.deepEqual(running.routing?.extensions, ["subagent-completion", "workspace-boundary", "drover-model-routing", "extra-tool"]);
		editPolicy((document) => {
			document.generation = "test-generation-v2";
			document.extensionGrants.worker = ["drover-model-routing"];
		});
		const invocation = capturePiInvocation();

		const resumed = await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());

		const args = (await readEventually(invocation.args)).trim().split("\n");
		const extensions = args.flatMap((arg, index) => (args[index - 1] === "-e" ? [arg] : []));
		assert.deepEqual(extensions, [
			COMPLETION_HELPER_PATH,
			join(agentDir, "extensions/workspace-boundary/index.ts"),
			join(agentDir, "extensions/drover-model-routing/index.ts"),
		]);
		assert.deepEqual(resumed.routing?.extensions, ["subagent-completion", "workspace-boundary", "drover-model-routing"]);
		assert.equal(resumed.routing?.generation, "test-generation-v2");
	});

	it("narrows tools to what the current definition still grants and never widens them", async () => {
		for (const [definitionTools, expected, broker] of [
			["read,grep", "read,grep", "read-only"],
			["read,grep,find,ls,bash,edit,write", "read,grep,find,ls", "read-only"],
		] as const) {
			usePolicy();
			const running = await managedLaunchHarness().run(worker);
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(
				join(agentDir, "agents", "pilot-worker.md"),
				`---\nname: pilot-worker\ndescription: Worker\ntools: ${definitionTools}\n---\nWork.\n`,
			);
			const invocation = capturePiInvocation();

			const resumed = await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());

			const args = (await readEventually(invocation.args)).trim().split("\n");
			const env = await readEventually(invocation.env);
			assert.match(args[args.indexOf("--tools") + 1], new RegExp(`^${expected}(,|$)`));
			assert.equal(resumed.routing?.tools, expected);
			assert.match(env, new RegExp(`^PI_SUBAGENT_TOOL_BROKER=.*"mode":"${broker}"`, "m"));
		}
	});

	it("refuses every widening or unverifiable resume before any child process exists", async () => {
		const cases: Array<{ label: string; arrange: (sessionFile: string) => void; input?: object; code: RegExp }> = [
			{ label: "torn snapshot", arrange: () => writeFileSync(snapshotFile(), ""), code: /resume_snapshot_invalid/ },
			{
				label: "edited snapshot",
				arrange: () => {
					const file = snapshotFile();
					writeFileSync(file, readFileSync(file, "utf8").replace('"read,grep,find,ls"', '"read,bash,write"'));
				},
				code: /resume_snapshot_invalid/,
			},
			{
				label: "incompatible snapshot",
				arrange: () => {
					const file = snapshotFile();
					writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: 99 }));
				},
				code: /resume_snapshot_incompatible/,
			},
			{
				label: "revoked role",
				arrange: () => editPolicy((document) => { document.roles.worker.state = "disabled"; }),
				code: /resume_role_revoked/,
			},
			{
				label: "changed route",
				arrange: () => editPolicy((document) => { document.roles.worker.routes.implementation.model = "gpt-5.6-terra"; }),
				code: /resume_authority_changed/,
			},
			{
				label: "changed extension pin",
				arrange: () => {
					const path = "extensions/drover-model-routing/index.ts";
					writeFileSync(join(agentDir, path), "export default function changed() {}\n");
					editPolicy((document) => {
						document.extensionCatalog["drover-model-routing"].files[0].sha256 = createHash("sha256")
							.update("export default function changed() {}\n")
							.digest("hex");
					});
				},
				code: /resume_resource_changed/,
			},
			{
				label: "extension file changed on disk",
				arrange: () => writeFileSync(join(agentDir, "extensions/workspace-boundary/index.ts"), "// changed\n"),
				code: /resource_unverified/,
			},
			{
				label: "policy dropping a mandatory safety resource",
				arrange: () => editPolicy((document) => { document.mandatoryExtensions = ["subagent-completion"]; }),
				code: /routing policy is invalid/,
			},
			{ label: "model override", arrange: () => {}, input: { model: "openai-codex/gpt-6-sol" }, code: /resume_broadening/ },
			{ label: "thinking override", arrange: () => {}, input: { thinking: "xhigh" }, code: /resume_broadening/ },
			{ label: "interactive mode", arrange: () => {}, input: { mode: "interactive" }, code: /resume_broadening/ },
			{
				label: "replaced session",
				arrange: (sessionFile) =>
					writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "other", cwd: "/" })}\n`),
				code: /resume_session_mismatch/,
			},
		];
		for (const entry of cases) {
			usePolicy();
			const running = await managedLaunchHarness().run(worker);
			entry.arrange(running.sessionFile);
			const invocation = capturePiInvocation();
			await assertRefused(
				resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue.", ...entry.input }, resumeRuntime()),
				entry.code,
				invocation,
			).catch((error: Error) => {
				throw new Error(`${entry.label}: ${error.message}`);
			});
		}
	});

	it("refuses to resume a writer, whose lease authorized a single launch", async () => {
		const running = await managedLaunchHarness().run(worker);
		const recorded = readResumeSnapshot(join(agentDir, "resume-snapshots"), running.sessionFile);
		assert.equal(recorded.status, "found");
		const writerSession = join(running.sessionFile, "..", "writer.jsonl");
		writeFileSync(writerSession, readFileSync(running.sessionFile, "utf8"));
		const snapshot = (recorded as Extract<typeof recorded, { status: "found" }>).snapshot;
		writeResumeSnapshot(join(agentDir, "resume-snapshots"), {
			...snapshot,
			session: { ...snapshot.session, file: writerSession },
			executionGroup: { kind: "writer-lease", worktree: snapshot.writeRoot.path, initPid: null, startTime: null },
		});
		const invocation = capturePiInvocation();

		await assertRefused(
			resumeSubagentSession({ sessionFile: writerSession, task: "Continue." }, resumeRuntime()),
			/resume_single_launch/,
			invocation,
		);
	});

	it("refuses a managed session the parent never recorded a snapshot for", async () => {
		const running = await managedLaunchHarness().run(worker);
		const other = join(running.sessionFile, "..", "unrecorded.jsonl");
		writeFileSync(other, readFileSync(running.sessionFile, "utf8"));
		const invocation = capturePiInvocation();

		await assertRefused(resumeSubagentSession({ sessionFile: other, task: "Continue." }, resumeRuntime()), /resume_snapshot_missing/, invocation);
	});

	it("narrows to the current definition: refuses a disabled one, applies its deny-tools, and keeps tool name case", async () => {
		const running = await managedLaunchHarness({ agentDefs: { tools: "read,grep,myTool" } }).run(worker);
		writeManagedDefinition(agentDir, "pilot-worker", "tools: read,grep,myTool\ndeny-tools: grep");
		const invocation = capturePiInvocation();

		await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());

		const args = (await readEventually(invocation.args)).trim().split("\n");
		const tools = args[args.indexOf("--tools") + 1].split(",");
		assert.ok(tools.includes("myTool"), tools.join(","));
		const env = await readEventually(invocation.env);
		assert.match(env, /^PI_DENY_TOOLS=(.*,)?grep(,|$)/m);

		usePolicy();
		const again = await managedLaunchHarness().run(worker);
		writeManagedDefinition(agentDir, "pilot-worker", "enabled: false");
		const refused = capturePiInvocation();
		await assertRefused(
			resumeSubagentSession({ sessionFile: again.sessionFile, task: "Continue." }, resumeRuntime()),
			/resume_role_revoked/,
			refused,
		);
	});

	it("refuses to resume a managed agent whose definition now declares provider-extensions", async () => {
		const running = await managedLaunchHarness().run(worker);
		writeManagedDefinition(agentDir, "pilot-worker", "provider-extensions: claude-primary=/x/provider.ts");
		const refused = capturePiInvocation();
		await assertRefused(
			resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/pilot-worker.*must not set provider-extensions/,
			refused,
		);
	});

	it("refuses a resume whose recorded working directory now leads elsewhere", async () => {
		const harness = managedLaunchHarness();
		const running = await harness.run(worker);
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "elsewhere-")));
		renameSync(harness.cwd, `${harness.cwd}.moved`);
		symlinkSync(elsewhere, harness.cwd);
		const invocation = capturePiInvocation();

		await assertRefused(
			resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/resume_authority_changed/,
			invocation,
		);
	});

	it("refuses an alias session that has no snapshot even when only a non-metadata entry names its agent", async () => {
		const running = await managedLaunchHarness().run(worker);
		const other = join(running.sessionFile, "..", "inferred.jsonl");
		writeFileSync(
			other,
			`${JSON.stringify({ type: "session", version: 3, id: "inferred", cwd: "/" })}\n${JSON.stringify({
				type: "custom",
				customType: "note",
				data: { sessionFile: other, mode: "background", agent: "pilot-worker" },
			})}\n`,
		);
		const invocation = capturePiInvocation();

		await assertRefused(resumeSubagentSession({ sessionFile: other, task: "Continue." }, resumeRuntime()), /resume_snapshot_missing/, invocation);
	});

	it("resumes a pilot launch under its committed launch id, consuming and restoring nothing", async () => {
		const running = await managedLaunchHarness().run(scout);
		const invocation = capturePiInvocation();

		await resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime());
		await readEventually(invocation.args);

		const state = readPilotCase(join(agentDir, "pilot-attempts"), "scout-literal-1");
		assert.deepEqual(
			state?.reservations.map((entry) => [entry.launchId, entry.outcome, entry.records.map((record) => record.kind)]),
			[["dispatch-1", "committed", ["resume"]]],
		);
	});

	it("refuses to resume a pilot launch once its case expired", async () => {
		const running = await managedLaunchHarness().run(scout);
		editPolicy((document) => {
			document.pilotCases["scout-literal-1"].expires = "2000-01-01T00:00:00Z";
		});
		const invocation = capturePiInvocation();

		await assertRefused(
			resumeSubagentSession({ sessionFile: running.sessionFile, task: "Continue." }, resumeRuntime()),
			/resume_role_revoked/,
			invocation,
		);
	});
});
