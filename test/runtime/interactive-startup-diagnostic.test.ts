import { describe, it } from "node:test";
import { appendStartupDiagnostic } from "../../src/runtime/interactive-watch.ts";
import { assert } from "../support/index.ts";

describe("interactive startup diagnostic", () => {
	it("appends the pane's last nonblank lines, where Pi printed the startup error", () => {
		const screen = ["$ launcher /tmp/capsule", "Error: Failed to load extension: configuration file is unavailable", "", "$ ", ""].join("\n");
		assert.equal(
			appendStartupDiagnostic("Sub-agent exited with code 1", screen),
			"Sub-agent exited with code 1\n\n$ launcher /tmp/capsule\nError: Failed to load extension: configuration file is unavailable\n$",
		);
	});

	it("keeps only the last lines of a long screen, and the summary alone without a screen", () => {
		// A wrapped launcher command can fill many rows below the error; keep enough of them.
		const screen = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
		const result = appendStartupDiagnostic("Sub-agent exited with code 1", screen);
		assert.ok(result.endsWith("line 59"));
		assert.ok(result.includes("\nline 30\n"));
		assert.ok(!result.includes("line 29\n"));
		assert.equal(appendStartupDiagnostic("Sub-agent exited with code 1", undefined), "Sub-agent exited with code 1");
		assert.equal(appendStartupDiagnostic("Sub-agent exited with code 1", " \n "), "Sub-agent exited with code 1");
	});
});
