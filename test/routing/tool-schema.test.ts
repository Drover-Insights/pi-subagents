import assert from "node:assert/strict";
import test from "node:test";
import {
	SubagentChildParams,
	SubagentParams,
} from "../../src/tools/subagent-tools.ts";

test("exposes capability class and risk for a single routed child", () => {
	assert.deepEqual(
		Object.keys(SubagentParams.properties ?? {}).filter(
			(key) => key === "capabilityClass" || key === "risk",
		),
		["capabilityClass", "risk"],
	);
});

test("exposes capability class and risk for each routed batch child", () => {
	assert.deepEqual(
		Object.keys(SubagentChildParams.properties ?? {}).filter(
			(key) => key === "capabilityClass" || key === "risk",
		),
		["capabilityClass", "risk"],
	);
});

test("exposes an escalation reason for a single routed child", () => {
	assert.equal("escalationReason" in (SubagentParams.properties ?? {}), true);
});

test("exposes an escalation reason for each routed batch child", () => {
	assert.equal(
		"escalationReason" in (SubagentChildParams.properties ?? {}),
		true,
	);
});

test("documents valid routing values and role mappings", () => {
	for (const schema of [SubagentParams, SubagentChildParams]) {
		const properties = (schema.properties ?? {}) as Record<
			string,
			{ description?: string } | undefined
		>;
		const modelDescription = properties.model?.description ?? "";
		const thinkingDescription = properties.thinking?.description ?? "";
		const capabilityDescription = properties.capabilityClass?.description ?? "";
		const riskDescription = properties.risk?.description ?? "";
		const escalationDescription =
			properties.escalationReason?.description ?? "";

		assert.match(modelDescription, /Format model as provider\/model/);
		assert.match(modelDescription, /routing-enabled pilot agents, always omit this field/);
		assert.match(thinkingDescription, /thinking level only/);
		assert.match(thinkingDescription, /routing-enabled pilot agents, always omit this field/);
		assert.match(
			capabilityDescription,
			/pilot-scout: scout\.literal or scout\.code-graph/,
		);
		assert.match(capabilityDescription, /pilot-worker: worker\.implementation/);
		assert.match(capabilityDescription, /pilot-reviewer: reviewer\.normal/);
		assert.match(
			capabilityDescription,
			/pilot-frontier-critic: frontier\.architecture/,
		);
		assert.match(
			capabilityDescription,
			/pilot-frontier-engineer: frontier\.engineering/,
		);
		assert.match(capabilityDescription, /pilot-controller cannot be launched as a child/);
		assert.match(riskDescription, /low, medium, high, or critical/);
		assert.match(
			escalationDescription,
			/scout\.code-graph: control_flow_required/,
		);
		assert.match(
			escalationDescription,
			/frontier\.architecture: architecture_invariant_risk/,
		);
		assert.match(
			escalationDescription,
			/frontier\.engineering: difficult_code_grounded_debugging/,
		);
		assert.match(
			escalationDescription,
			/Omit for scout\.literal, worker\.implementation, and reviewer\.normal/,
		);
	}
});
