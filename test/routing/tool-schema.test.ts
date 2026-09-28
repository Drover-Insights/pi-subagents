import assert from "node:assert/strict";
import test from "node:test";
import { SubagentChildParams, SubagentParams } from "../../src/tools/subagent-tools.ts";

const ROUTING_KEYS = ["capabilityClass", "pilotCase", "risk", "escalationReason"];

test("exposes capability class and pilot case for a single routed child", () => {
	assert.deepEqual(
		Object.keys(SubagentParams.properties ?? {}).filter((key) => ROUTING_KEYS.includes(key)),
		["capabilityClass", "pilotCase"],
	);
});

test("exposes capability class and pilot case for each routed batch child", () => {
	assert.deepEqual(
		Object.keys(SubagentChildParams.properties ?? {}).filter((key) => ROUTING_KEYS.includes(key)),
		["capabilityClass", "pilotCase"],
	);
});

test("documents routing fields for policy-managed agents", () => {
	for (const schema of [SubagentParams, SubagentChildParams]) {
		const properties = (schema.properties ?? {}) as Record<string, { description?: string } | undefined>;
		const modelDescription = properties.model?.description ?? "";
		const thinkingDescription = properties.thinking?.description ?? "";

		assert.match(modelDescription, /Format model as provider\/model/);
		assert.match(modelDescription, /policy-managed agents, always omit this field/);
		assert.match(thinkingDescription, /thinking level only/);
		assert.match(thinkingDescription, /policy-managed agents, always omit this field/);
		assert.match(properties.capabilityClass?.description ?? "", /Required for policy-managed agents/);
		assert.match(properties.pilotCase?.description ?? "", /Required for pilot-state roles/);
	}
});
