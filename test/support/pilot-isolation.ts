import { beforeEach } from "node:test";
import { resetPilotIsolationForTest } from "../../src/runtime/pilot-isolation.ts";

// Suites drop fake children without a process from the shared registry, which
// pilot isolation keeps counting; start every test without them.
beforeEach(() => {
	resetPilotIsolationForTest();
});
