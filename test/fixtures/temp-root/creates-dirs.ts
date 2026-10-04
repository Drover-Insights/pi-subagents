// Fixture for test/support/temp-root.test.ts: a test file that creates temp
// directories the way real suites do. FIXTURE_FAIL=1 makes its test fail;
// FIXTURE_LOCKED=1 leaves an entry the cleanup cannot remove.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createTestDir } from "../../support/fixtures.ts";

it("creates temp directories", () => {
	writeFileSync(join(createTestDir(), "file.txt"), "x");
	writeFileSync(join(mkdtempSync(join(tmpdir(), "direct-")), "file.txt"), "x");
	writeFileSync(join(tmpdir(), "loose-file.txt"), "x");
	if (process.env.FIXTURE_LOCKED === "1") {
		const locked = mkdtempSync(join(tmpdir(), "locked-"));
		writeFileSync(join(locked, "file.txt"), "x");
		chmodSync(locked, 0o500);
	}
	if (process.env.FIXTURE_FAIL === "1") throw new Error("fixture failure");
});
