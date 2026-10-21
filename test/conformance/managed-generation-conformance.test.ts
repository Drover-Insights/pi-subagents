import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { CHILD_RUNTIME_SCHEMA_RANGE } from "../../src/routing/canonical-policy.ts";

/**
 * pi-config's generation stager reads `managed-generation-conformance.json`
 * from the pinned package checkout with an exact shape (see
 * docs/conformance/package-conformance-report.md). These checks keep the
 * published report true to this tree: its hashes, its declared schema range,
 * its loading contract, and every test its evidence cites. They never consult
 * Git, so the recorded test counts do not depend on the report's content.
 */
const ROOT = new URL("../../", import.meta.url);
const REPORT_FILE = "managed-generation-conformance.json";
const REPOSITORY = "git:github.com/Drover-Insights/pi-subagents";
const TEST_COMMAND = "npx tsc --noEmit && npm test";
const EVIDENCE_IDS = [
	"package-conformance-report",
	"extension-allowlist",
	"writer-confinement",
	"resume-narrowing",
	"tool-broker",
	"pilot-attempts",
];
const CITATION = /`(test\/[A-Za-z0-9/._-]+\.test\.ts)`(?::\s*"([^"]+)")?/g;
const ANY_TEST_PATH = /test\/\S+?\.test\.ts/g;

type Report = {
	schemaVersion: number;
	package: { repository: string; commit: string };
	supportedPolicySchema: { minimum: number; maximum: number };
	extensionLoading: { autoload: boolean; resources: Array<{ path: string; sha256: string }> };
	evidence: Array<{ id: string; path: string; sha256: string }>;
	test: { command: string; result: string };
};

function file(path: string): Buffer {
	return readFileSync(new URL(path, ROOT));
}

function sha256(path: string): string {
	return createHash("sha256").update(file(path)).digest("hex");
}

function report(): Report {
	return JSON.parse(file(REPORT_FILE).toString("utf8")) as Report;
}

function packageJson(): { pi: { extensions: string[] }; scripts: { test: string } } {
	return JSON.parse(file("package.json").toString("utf8"));
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `source` opens a test under exactly `title`; `test.skip(` and `it.todo(` forms do not count. */
function opensTest(source: string, title: string): boolean {
	return new RegExp(`\\b(?:test|it)\\(\\s*"${escapeRegExp(title)}"\\s*,`).test(source);
}

/** Test files `npm test` runs: the barrel's imports plus files its script names directly. */
function testsRun(): Set<string> {
	const barrel = file("test/test.ts").toString("utf8");
	const imported = [...barrel.matchAll(/^import "\.\/([^"]+)";$/gm)].map((match) => `test/${match[1]}`);
	const direct = packageJson().scripts.test.split(/\s+/).filter((word) => /^test\/.+\.test\.ts$/.test(word));
	return new Set([...imported, ...direct]);
}

describe("managed-generation conformance report", () => {
	test("has exactly the shape pi-config's stager reads, bound to the checked-out HEAD", () => {
		const value = report();
		assert.deepEqual(Object.keys(value).sort(), [
			"evidence",
			"extensionLoading",
			"package",
			"schemaVersion",
			"supportedPolicySchema",
			"test",
		]);
		assert.equal(value.schemaVersion, 1);
		assert.deepEqual(value.package, { repository: REPOSITORY, commit: "HEAD" });
		assert.deepEqual(Object.keys(value.test).sort(), ["command", "result"]);
		assert.equal(value.test.command, TEST_COMMAND);
	});

	test("declares exactly the policy schema range the child runtime enforces", () => {
		assert.deepEqual(CHILD_RUNTIME_SCHEMA_RANGE, { minimum: 3, maximum: 3 });
		assert.deepEqual(report().supportedPolicySchema, CHILD_RUNTIME_SCHEMA_RANGE);
	});

	test("lists the package manifest and every extension it declares, at their current hashes", () => {
		const { extensionLoading } = report();
		assert.equal(extensionLoading.autoload, true);
		const declared = packageJson().pi.extensions.map((path) => path.replace(/^\.\//, ""));
		assert.deepEqual(
			extensionLoading.resources.map((resource) => resource.path),
			["package.json", ...declared],
		);
		for (const resource of extensionLoading.resources) {
			assert.equal(resource.sha256, sha256(resource.path), `${resource.path} hash is stale`);
		}
	});

	test("carries one evidence document per required id, at its current hash", () => {
		const { evidence } = report();
		assert.deepEqual(
			evidence.map((item) => item.id),
			EVIDENCE_IDS,
		);
		for (const item of evidence) {
			assert.equal(item.path, `docs/conformance/${item.id}.md`);
			assert.equal(item.sha256, sha256(item.path), `${item.path} hash is stale`);
		}
	});

	test("cites only tests that npm test runs, under titles those files still hold", () => {
		const run = testsRun();
		for (const item of report().evidence) {
			const text = file(item.path).toString("utf8");
			const citations = [...text.matchAll(CITATION)];
			assert.ok(citations.length > 0, `${item.path} cites no test`);
			assert.equal(
				[...text.matchAll(ANY_TEST_PATH)].length,
				citations.length,
				`${item.path} names a test file outside the checked citation form`,
			);
			for (const [, path, title] of citations) {
				assert.ok(existsSync(new URL(path, ROOT)), `${item.path} cites missing ${path}`);
				assert.ok(run.has(path), `${item.path} cites ${path}, which npm test does not run`);
				if (title) {
					assert.ok(opensTest(file(path).toString("utf8"), title), `${path} has no runnable test "${title}"`);
				}
			}
		}
	});

	test("the main report names the validated commit with its results, and the exact test command", () => {
		const text = file("docs/conformance/package-conformance-report.md").toString("utf8");
		const commit = text.match(/^Validated commit: `([0-9a-f]{40}|pending)`$/m)?.[1];
		const results = text.match(/^Results: (.+)$/m)?.[1];
		assert.ok(commit && results, "the report must carry a Validated commit line and a Results line");
		// A pending report must not reach staging: pi-config's stager admits only `result: "passed"`.
		if (commit === "pending") {
			assert.equal(results, "pending", "a pending commit cannot carry results");
			assert.equal(report().test.result, "pending", "a pending report cannot declare a passed result");
		} else {
			assert.match(results, /^tests \d+, pass \d+, fail 0, cancelled 0, skipped \d+, todo 0; tsc clean$/);
			assert.equal(report().test.result, "passed");
		}
		assert.ok(text.includes(TEST_COMMAND), "the report must record the exact test command");
	});
});
