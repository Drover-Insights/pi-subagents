import { afterEach, beforeEach, describe, it } from "node:test";
import { publishTrustedSubagents, type TrustedTerminator } from "../../src/trusted-launch/registry.ts";
import {
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedTerminateRequestV1,
	type TrustedTerminateResultV1,
} from "../../src/trusted-launch/public.ts";
import { assert } from "../support/index.ts";

function terminateRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestVersion: TRUSTED_LAUNCH_VERSION,
		requestId: "op_stop_01",
		runId: "run-1",
		sessionFile: "/sessions/run-1.jsonl",
		launchRequestId: "op_01",
		...overrides,
	};
}

const publications: { dispose(): void }[] = [];

function publish(terminate: TrustedTerminator) {
	const publication = publishTrustedSubagents({
		launch: async () => {
			throw new Error("launch is not under test");
		},
		resume: async () => {
			throw new Error("resume is not under test");
		},
		terminate,
	});
	publications.push(publication);
	return publication;
}

function scripted(result: unknown) {
	const calls: TrustedTerminateRequestV1[] = [];
	const terminate: TrustedTerminator = async (request) => {
		calls.push(request);
		return result as TrustedTerminateResultV1;
	};
	return { terminate, calls };
}

function assertUnknown(result: TrustedTerminateResultV1, reason: string, stopRequested: boolean): void {
	assert.equal(result.outcome, "unknown", JSON.stringify(result));
	if (result.outcome !== "unknown") return;
	assert.equal(result.reason, reason, JSON.stringify(result));
	assert.equal(result.stopRequested, stopRequested, JSON.stringify(result));
	assert.equal(typeof result.message, "string");
}

describe("trusted terminate contract", () => {
	const clear = () => {
		delete (globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY];
	};
	beforeEach(clear);
	afterEach(() => {
		for (const publication of publications.splice(0)) publication.dispose();
		clear();
	});

	it("passes a validated, frozen request to the terminator and returns its proven outcome", async () => {
		const { terminate, calls } = scripted({
			outcome: "terminated",
			requestId: "op_stop_01",
			runId: "run-1",
			sessionFile: "/sessions/run-1.jsonl",
		});
		const { descriptor } = publish(terminate);
		const request = terminateRequest();
		const result = await descriptor.terminate(request);
		assert.deepEqual(result, {
			outcome: "terminated",
			requestId: "op_stop_01",
			runId: "run-1",
			sessionFile: "/sessions/run-1.jsonl",
		});
		assert.deepEqual(calls, [request]);
		assert.equal(Object.isFrozen(calls[0]), true);
	});

	it("accepts only exact trusted identities, never a pid, pane, name, or free text", async () => {
		const { terminate, calls } = scripted({ outcome: "terminated" });
		const { descriptor } = publish(terminate);
		const cases: [unknown, string][] = [
			[null, "invalid_request"],
			["run-1", "invalid_request"],
			[terminateRequest({ requestVersion: "pi-subagents.trusted-launch/v9" }), "unsupported_version"],
			[terminateRequest({ pid: 1234 }), "invalid_request"],
			[terminateRequest({ surfaceId: "pane-1" }), "invalid_request"],
			[terminateRequest({ name: "task-worker" }), "invalid_request"],
			[terminateRequest({ runId: "" }), "invalid_request"],
			[terminateRequest({ runId: 7 }), "invalid_request"],
			[terminateRequest({ sessionFile: "relative.jsonl" }), "invalid_request"],
			[terminateRequest({ launchRequestId: "not an id" }), "invalid_request"],
			[terminateRequest({ requestId: "x".repeat(129) }), "invalid_request"],
			[new Proxy(terminateRequest(), {}), "invalid_request"],
		];
		for (const [request, reason] of cases) {
			assertUnknown(await descriptor.terminate(request), reason, false);
		}
		assert.equal(calls.length, 0);
	});

	it("a disposed or replaced descriptor terminates nothing and reports unknown", async () => {
		const disposed = scripted({ outcome: "terminated" });
		const first = publish(disposed.terminate);
		first.dispose();
		assertUnknown(await first.descriptor.terminate(terminateRequest()), "descriptor_disposed", false);

		const replaced = scripted({ outcome: "terminated" });
		const second = publish(replaced.terminate);
		(globalThis as Record<symbol, unknown>)[TRUSTED_LAUNCH_REGISTRY_KEY] = { descriptor: {} };
		assertUnknown(await second.descriptor.terminate(terminateRequest()), "descriptor_replaced", false);
		assert.equal(disposed.calls.length + replaced.calls.length, 0);
	});

	it("reports a malformed terminator response as unknown, never as an end", async () => {
		const identity = { requestId: "op_stop_01", runId: "run-1", sessionFile: "/sessions/run-1.jsonl" };
		const malformed: unknown[] = [
			undefined,
			"terminated",
			{ outcome: "killed", ...identity },
			{ outcome: "terminated", ...identity, runId: "run-2" },
			{ outcome: "already_terminal", ...identity, sessionFile: "/sessions/other.jsonl" },
			{ outcome: "terminated", ...identity, requestId: "op_other" },
			{ outcome: "terminated", runId: "run-1", sessionFile: "/sessions/run-1.jsonl" },
			{ outcome: "unknown", reason: "timeout", message: "late" },
			{ outcome: "unknown", reason: 5, message: "late", stopRequested: false },
		];
		for (const response of malformed) {
			const publication = publish(scripted(response).terminate);
			assertUnknown(await publication.descriptor.terminate(terminateRequest()), "malformed_response", true);
			publication.dispose();
		}
	});

	it("reports a throwing terminator as unknown with a possible stop", async () => {
		const { descriptor } = publish(async () => {
			throw new Error("terminator exploded");
		});
		const result = await descriptor.terminate(terminateRequest());
		assertUnknown(result, "terminator_failed", true);
		assert.match(result.outcome === "unknown" ? result.message : "", /terminator exploded/);
	});
});
