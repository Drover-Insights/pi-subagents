import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRoutingPolicy } from "../../src/routing/policy.ts";

test("routes a literal Scout request to the pinned Luna model with low thinking", () => {
	const route = resolveRoutingPolicy({
		dispatchId: "dispatch-1",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "low",
	});

	assert.deepEqual(
		{ logicalRoute: route.logicalRoute, thinking: route.thinking },
		{ logicalRoute: "openai-codex/gpt-5.6-luna", thinking: "low" },
	);
});

test("routes code-graph Scout work to Terra with low thinking only for control-flow escalation", () => {
	const withReason = resolveRoutingPolicy({
		dispatchId: "dispatch-2",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "control_flow_required",
		risk: "medium",
	});
	const withoutReason = resolveRoutingPolicy({
		dispatchId: "dispatch-3",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.code-graph",
		risk: "medium",
	});

	assert.deepEqual(
		{
			withReason: { logicalRoute: withReason.logicalRoute, thinking: withReason.thinking },
			withoutReason,
		},
		{
			withReason: { logicalRoute: "openai-codex/gpt-5.6-terra", thinking: "low" },
			withoutReason: { status: "policy_rejected", reason: "missing_escalation_reason" },
		},
	);
});

test("routes Worker implementation to the pinned Terra model with medium thinking", () => {
	const route = resolveRoutingPolicy({
		dispatchId: "dispatch-4",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "medium",
	});

	assert.deepEqual(
		{ logicalRoute: route.logicalRoute, thinking: route.thinking },
		{ logicalRoute: "openai-codex/gpt-5.6-terra", thinking: "medium" },
	);
});

test("routes normal Reviewer work to the pinned Sol model with medium thinking", () => {
	const route = resolveRoutingPolicy({
		dispatchId: "dispatch-5",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "reviewer.normal",
		risk: "high",
	});

	assert.deepEqual(
		{ logicalRoute: route.logicalRoute, thinking: route.thinking },
		{ logicalRoute: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	);
});

test("rejects an irrelevant control-flow escalation reason for Worker implementation", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-6",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "worker.implementation",
		escalationReason: "control_flow_required",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("rejects an irrelevant control-flow escalation reason for literal Scout work", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-7",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		escalationReason: "control_flow_required",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("rejects an irrelevant control-flow escalation reason for normal Reviewer work", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-8",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "reviewer.normal",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("rejects a Worker requesting the normal Reviewer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-9",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "reviewer.normal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Reviewer requesting the Worker implementation capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-10",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Scout requesting the Worker implementation capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-11",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Scout requesting the normal Reviewer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-12",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "reviewer.normal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Worker requesting the literal Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-13",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Reviewer requesting the literal Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-14",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Worker requesting the code-graph Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-15",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "control_flow_required",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Reviewer requesting the code-graph Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-16",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a frontier escalation reason for code-graph Scout work", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-17",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("routes Frontier Critic architecture work to the pinned Fable model with high thinking", () => {
	const route = resolveRoutingPolicy({
		dispatchId: "dispatch-18",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(
		{ logicalRoute: route.logicalRoute, thinking: route.thinking },
		{ logicalRoute: "anthropic/claude-fable-5-1", thinking: "high" },
	);
});

test("routes Frontier Engineer work to the pinned Astra model with xhigh thinking", () => {
	const route = resolveRoutingPolicy({
		dispatchId: "dispatch-19",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		risk: "high",
	});

	assert.deepEqual(
		{ logicalRoute: route.logicalRoute, thinking: route.thinking },
		{ logicalRoute: "openai-codex/gpt-6-astra", thinking: "xhigh" },
	);
});

test("rejects Frontier Critic architecture work without an escalation reason", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-20",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.architecture",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "missing_escalation_reason",
	});
});

test("rejects Frontier Engineer work without an escalation reason", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-21",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "missing_escalation_reason",
	});
});

test("rejects an irrelevant control-flow reason for Frontier Critic architecture work", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-22",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("rejects an irrelevant control-flow reason for Frontier Engineer work", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-23",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	});
});

test("rejects a Worker requesting the Frontier Critic architecture capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-24",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Reviewer requesting the Frontier Critic architecture capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-25",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Scout requesting the Frontier Critic architecture capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-26",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Engineer requesting the Frontier Critic architecture capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-27",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Worker requesting the Frontier Engineer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-28",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Reviewer requesting the Frontier Engineer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-29",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Scout requesting the Frontier Engineer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-30",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Critic requesting the Frontier Engineer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-31",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Critic requesting the normal Reviewer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-32",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "reviewer.normal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Engineer requesting the normal Reviewer capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-33",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "reviewer.normal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Critic requesting the Worker implementation capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-34",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Engineer requesting the Worker implementation capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-35",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Critic requesting the literal Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-36",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Engineer requesting the literal Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-37",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Critic requesting the code-graph Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-38",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a Frontier Engineer requesting the code-graph Scout capability", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-39",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "scout.code-graph",
		escalationReason: "control_flow_required",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "role_class_mismatch",
	});
});

test("rejects a direct model override for a routing-enabled Scout", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-40",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		model: "openai-codex/gpt-6-astra",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct thinking override for a routing-enabled Scout", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-41",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		thinking: "medium",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct model override for a routing-enabled Worker", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-42",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "worker.implementation",
		model: "openai-codex/gpt-6-astra",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct thinking override for a routing-enabled Worker", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-43",
		agent: "pilot-worker",
		mode: "background",
		capabilityClass: "worker.implementation",
		thinking: "high",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct model override for a routing-enabled Reviewer", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-44",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "reviewer.normal",
		model: "openai-codex/gpt-6-astra",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects forbidden Max thinking for a routing-enabled Reviewer", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-45",
		agent: "pilot-reviewer",
		mode: "background",
		capabilityClass: "reviewer.normal",
		thinking: "max",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct model override for the routing-enabled Frontier Critic", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-46",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		model: "openai-codex/gpt-6-astra",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct thinking override for the routing-enabled Frontier Critic", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-47",
		agent: "pilot-frontier-critic",
		mode: "background",
		capabilityClass: "frontier.architecture",
		escalationReason: "architecture_invariant_risk",
		thinking: "xhigh",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct model override for the routing-enabled Frontier Engineer", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-48",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		model: "anthropic/claude-fable-5-1",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects a direct thinking override for the routing-enabled Frontier Engineer", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-49",
		agent: "pilot-frontier-engineer",
		mode: "background",
		capabilityClass: "frontier.engineering",
		escalationReason: "difficult_code_grounded_debugging",
		thinking: "high",
		risk: "high",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "prohibited_override",
	});
});

test("rejects the Controller as a child profile", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-50",
		agent: "pilot-controller",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "controller_child_forbidden",
	});
});

test("rejects an unknown agent", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-51",
		agent: "pilot-unknown",
		mode: "background",
		capabilityClass: "worker.implementation",
		risk: "medium",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "unknown_agent",
	});
});

test("rejects an unknown capability class", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-52",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.unknown",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "unknown_capability_class",
	});
});

test("rejects an unknown launch mode", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-53",
		agent: "pilot-scout",
		mode: "deferred",
		capabilityClass: "scout.literal",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "unknown_mode",
	});
});

test("rejects an unknown risk", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-54",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		risk: "severe",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "unknown_risk",
	});
});

test("rejects an unknown escalation reason", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-55",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
		escalationReason: "budget_pressure",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "unknown_escalation_reason",
	});
});

test("rejects a routing-enabled request without a capability class", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-56",
		agent: "pilot-scout",
		mode: "background",
		risk: "low",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "missing_capability_class",
	});
});

test("rejects a routing-enabled request without a risk", () => {
	const result = resolveRoutingPolicy({
		dispatchId: "dispatch-57",
		agent: "pilot-scout",
		mode: "background",
		capabilityClass: "scout.literal",
	});

	assert.deepEqual(result, {
		status: "policy_rejected",
		reason: "missing_risk",
	});
});
