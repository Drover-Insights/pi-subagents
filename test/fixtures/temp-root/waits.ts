// Fixture for test/support/temp-root.test.ts: creates a temp directory, then
// waits to be signalled.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDir } from "../../support/fixtures.ts";

writeFileSync(join(createTestDir(), "file.txt"), "x");
process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
