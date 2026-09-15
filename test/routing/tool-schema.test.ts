import assert from "node:assert/strict";
import test from "node:test";
import { SubagentChildParams, SubagentParams } from "../../src/tools/subagent-tools.ts";

test("exposes capability class and risk for a single routed child", () => {
	assert.deepEqual(Object.keys(SubagentParams.properties ?? {}).filter((key) => key === "capabilityClass" || key === "risk"), [
		"capabilityClass",
		"risk",
	]);
});

test("exposes capability class and risk for each routed batch child", () => {
	assert.deepEqual(
		Object.keys(SubagentChildParams.properties ?? {}).filter((key) => key === "capabilityClass" || key === "risk"),
		["capabilityClass", "risk"],
	);
});

test("exposes an escalation reason for a single routed child", () => {
	assert.equal("escalationReason" in (SubagentParams.properties ?? {}), true);
});

test("exposes an escalation reason for each routed batch child", () => {
	assert.equal("escalationReason" in (SubagentChildParams.properties ?? {}), true);
});
