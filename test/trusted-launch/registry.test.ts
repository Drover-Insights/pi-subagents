import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { publishTrustedSubagents, type TrustedLauncher } from "../../src/trusted-launch/registry.ts";
import {
	resolveTrustedSubagents,
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
} from "../../src/trusted-launch/public.ts";
import { assert, createTestDir } from "../support/index.ts";

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_01",
		agent: "worker",
		name: "trusted-worker",
		title: "Trusted worker",
		task: "Do the work",
		effectiveCwd: realpathSync(createTestDir()),
		mode: "background",
		...overrides,
	};
}

function recordingLauncher() {
	const calls: TrustedLaunchRequestV1[] = [];
	const launcher = async (request: TrustedLaunchRequestV1): Promise<TrustedLaunchResultV1> => {
		calls.push(request);
		return {
			outcome: "launched",
			requestId: request.requestId,
			runId: "run-1",
			sessionFile: "/sessions/run-1.jsonl",
			mode: request.mode,
			effectiveCwd: request.effectiveCwd,
		};
	};
	return { launcher, calls };
}

const publications: { dispose(): void }[] = [];
function clearRegistrySlot() {
	delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
}
/** Resume has its own suite; these tests exercise launch. */
async function unusedResume(): Promise<never> {
	throw new Error("resume is not under test");
}
function publish(launcher: TrustedLauncher) {
	const publication = publishTrustedSubagents({ launch: launcher, resume: unusedResume });
	publications.push(publication);
	return publication;
}

describe("trusted launch registry", () => {
	// Earlier suites start extension sessions that publish a descriptor.
	beforeEach(clearRegistrySlot);
	afterEach(() => {
		for (const publication of publications.splice(0)) publication.dispose();
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	});

	it("publishes one versioned descriptor under the documented process-wide key", async () => {
		const { launcher, calls } = recordingLauncher();
		const publication = publish(launcher);

		const resolved = resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION);
		assert.equal(resolved.status, "ok");
		if (resolved.status !== "ok") return;
		assert.equal(resolved.descriptor, publication.descriptor);
		assert.equal(resolved.descriptor.version, TRUSTED_LAUNCH_VERSION);
		assert.match(resolved.descriptor.generation, /^[0-9a-f-]{36}$/);
		assert.equal(resolved.descriptor.isLive(), true);
		assert.equal(Object.isFrozen(resolved.descriptor), true);

		const request = validRequest();
		const result = await resolved.descriptor.launch(request);
		assert.equal(result.outcome, "launched");
		assert.deepEqual(calls, [request]);
	});

	it("reports a missing or incompatible descriptor", () => {
		assert.deepEqual(resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION), { status: "missing" });
		publish(recordingLauncher().launcher);
		assert.deepEqual(resolveTrustedSubagents("pi-subagents.trusted-launch/v2"), {
			status: "incompatible",
			version: TRUSTED_LAUNCH_VERSION,
		});
	});

	it("refuses a duplicate live publication", () => {
		publish(recordingLauncher().launcher);
		assert.throws(
			() => publishTrustedSubagents({ launch: recordingLauncher().launcher, resume: unusedResume }),
			/already published/,
		);
	});

	it("a disposed descriptor cannot launch and is no longer resolvable", async () => {
		const { launcher, calls } = recordingLauncher();
		const publication = publish(launcher);
		publication.dispose();

		assert.equal(publication.descriptor.isLive(), false);
		assert.deepEqual(resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION), { status: "missing" });
		const result = await publication.descriptor.launch(validRequest());
		assert.equal(result.outcome, "not_started");
		assert.equal(result.outcome === "not_started" && result.reason, "descriptor_disposed");
		assert.equal(calls.length, 0);
	});

	it("a replaced descriptor cannot launch or unregister its replacement", async () => {
		const first = recordingLauncher();
		const stale = publish(first.launcher);
		stale.dispose();
		const second = recordingLauncher();
		const current = publish(second.launcher);
		assert.notEqual(current.descriptor.generation, stale.descriptor.generation);

		stale.dispose();
		const resolved = resolveTrustedSubagents(TRUSTED_LAUNCH_VERSION);
		assert.equal(resolved.status === "ok" && resolved.descriptor, current.descriptor);
		const result = await stale.descriptor.launch(validRequest());
		assert.equal(result.outcome === "not_started" && result.reason, "descriptor_disposed");
		assert.equal(first.calls.length, 0);
	});

	it("a descriptor whose registry slot was overwritten reports itself replaced", async () => {
		const { launcher, calls } = recordingLauncher();
		const publication = publish(launcher);
		(globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY] = { descriptor: {} };

		assert.equal(publication.descriptor.isLive(), false);
		const result = await publication.descriptor.launch(validRequest());
		assert.equal(result.outcome === "not_started" && result.reason, "descriptor_replaced");
		assert.equal(calls.length, 0);
	});

	it("maps a launcher throw to an unknown outcome", async () => {
		const publication = publish(async () => {
			throw new Error("spawn exploded");
		});
		const result = await publication.descriptor.launch(validRequest());
		assert.equal(result.outcome, "unknown");
		assert.match(result.outcome === "unknown" ? result.message : "", /spawn exploded/);
	});

	describe("request validation fails before the launcher", () => {
		const symlinkParent = createTestDir();
		const target = join(symlinkParent, "target");
		mkdirSync(target);
		const link = join(symlinkParent, "link");
		symlinkSync(target, link);
		const file = join(symlinkParent, "file.txt");
		writeFileSync(file, "x");
		const canonical = realpathSync(target);
		// Readable but not searchable: the child could not enter it.
		const unsearchable = join(realpathSync(symlinkParent), "unsearchable");
		mkdirSync(unsearchable, { mode: 0o600 });

		const cases: [string, unknown, string][] = [
			["a non-object request", "launch please", "invalid_request"],
			["an unknown decision version", validRequest({ requestVersion: "pi-subagents.trusted-launch/v0" }), "unsupported_version"],
			["an unknown key", validRequest({ forcedCwd: canonical }), "invalid_request"],
			["a model override", validRequest({ model: "provider/model" }), "invalid_request"],
			["a malformed request id", validRequest({ requestId: "op 01" }), "invalid_request"],
			["an invalid name", validRequest({ name: "Trusted Worker" }), "invalid_request"],
			["an empty task", validRequest({ task: "" }), "invalid_request"],
			["an unknown mode", validRequest({ mode: "fork" }), "invalid_request"],
			["a relative effective cwd", validRequest({ effectiveCwd: "project" }), "effective_cwd_invalid"],
			["a missing effective cwd", validRequest({ effectiveCwd: join(canonical, "missing") }), "effective_cwd_invalid"],
			["a symlinked effective cwd", validRequest({ effectiveCwd: link }), "effective_cwd_invalid"],
			["a non-canonical effective cwd", validRequest({ effectiveCwd: `${canonical}/../target` }), "effective_cwd_invalid"],
			["a trailing-slash effective cwd", validRequest({ effectiveCwd: `${canonical}/` }), "effective_cwd_invalid"],
			["a file effective cwd", validRequest({ effectiveCwd: realpathSync(file) }), "effective_cwd_invalid"],
			...(process.getuid?.() === 0
				? []
				: ([["an inaccessible effective cwd", validRequest({ effectiveCwd: unsearchable }), "effective_cwd_invalid"]] as [
						string,
						unknown,
						string,
					][])),
			["a non-string label", validRequest({ labels: { runId: 7 } }), "invalid_request"],
			["a malformed label key", validRequest({ labels: { "Run Id": "x" } }), "invalid_request"],
			["too many labels", validRequest({ labels: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) }), "invalid_request"],
			["an oversized label value", validRequest({ labels: { runId: "x".repeat(257) } }), "invalid_request"],
		];
		for (const [label, request, reason] of cases) {
			it(`rejects ${label}`, async () => {
				const { launcher, calls } = recordingLauncher();
				const publication = publish(launcher);
				const result = await publication.descriptor.launch(request);
				assert.equal(result.outcome, "not_started");
				assert.equal(result.outcome === "not_started" && result.reason, reason);
				assert.equal(calls.length, 0);
			});
		}

		it("validates and launches one snapshot of the request's own data", async () => {
			const { launcher, calls } = recordingLauncher();
			const publication = publish(launcher);
			const elsewhere = realpathSync(createTestDir());
			let reads = 0;
			const shifting = validRequest({ effectiveCwd: canonical });
			Object.defineProperty(shifting, "effectiveCwd", {
				enumerable: true,
				get: () => (reads++ === 0 ? canonical : elsewhere),
			});
			const { effectiveCwd: _inherited, ...own } = validRequest({ effectiveCwd: canonical });
			const inherited = Object.assign(Object.create({ effectiveCwd: canonical }), own);
			const throwing = validRequest();
			Object.defineProperty(throwing, "task", {
				enumerable: true,
				get: () => {
					throw new Error("getter exploded");
				},
			});
			const revoked = Proxy.revocable(validRequest(), {});
			revoked.revoke();

			for (const request of [shifting, inherited, throwing, revoked.proxy]) {
				const result = await publication.descriptor.launch(request);
				assert.equal(result.outcome === "not_started" && result.reason, "invalid_request");
			}
			assert.equal(calls.length, 0);
		});

		it("never rejects its promise, whatever the request holds", async () => {
			const { launcher, calls } = recordingLauncher();
			const publication = publish(launcher);
			const cases: [unknown, string][] = [
				[validRequest({ requestVersion: 1n }), "unsupported_version"],
				[
					validRequest({
						requestVersion: {
							toJSON() {
								throw new Error("toJSON exploded");
							},
						},
					}),
					"unsupported_version",
				],
				[new Proxy(validRequest(), {}), "invalid_request"],
				[validRequest({ labels: new Proxy({ runId: "run_01" }, {}) }), "invalid_request"],
			];
			for (const [request, reason] of cases) {
				const result = await publication.descriptor.launch(request);
				assert.equal(result.outcome === "not_started" && result.reason, reason);
			}
			assert.equal(calls.length, 0);
		});

		it("accepts bounded labels, a capability class, and a pilot case", async () => {
			const { launcher, calls } = recordingLauncher();
			const publication = publish(launcher);
			const request = validRequest({
				effectiveCwd: canonical,
				mode: "interactive",
				capabilityClass: "worker.implementation",
				pilotCase: "case-1",
				labels: { runId: "run_01", "task.revision": "3" },
			});
			const result = await publication.descriptor.launch(request);
			assert.equal(result.outcome, "launched");
			assert.deepEqual(calls, [request]);
		});
	});
});
