import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * pi-config's routing policy pins this package's completion extension by
 * content hash (extensionCatalog.subagent-completion). Any byte change here,
 * formatting included, breaks that pin, so change this file only together
 * with a re-pin in pi-config.
 */
const PINNED_SUBAGENT_DONE_SHA256 = "7dafab8303209e430bd95bc9a45a66b0063ec5f41e3eba724909887bb0852b5a";

test("the completion extension still matches the hash the routing policy pins", () => {
	const actual = createHash("sha256")
		.update(readFileSync(new URL("../../src/tools/subagent-done.ts", import.meta.url)))
		.digest("hex");

	assert.equal(actual, PINNED_SUBAGENT_DONE_SHA256);
});
