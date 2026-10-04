import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCanonicalPolicy } from "../../src/routing/canonical-policy.ts";
import {
	canonicalPolicyDocument,
	emptyAgentDir,
	type PolicyDocument,
	writeCanonicalPolicy,
} from "../support/routing-policy.ts";

function invalidReason(edit: (policy: PolicyDocument) => void): string {
	const document = canonicalPolicyDocument();
	edit(document);
	const state = loadCanonicalPolicy(writeCanonicalPolicy(document));
	assert.equal(state.status, "invalid", "expected the edited policy to be rejected");
	return state.status === "invalid" ? state.message : "";
}

test("loads the canonical policy from the Pi agent directory as an immutable contract", () => {
	const state = loadCanonicalPolicy(writeCanonicalPolicy());

	assert.equal(state.status, "loaded");
	if (state.status !== "loaded") return;
	assert.equal(state.policy.generation, "test-generation-v1");
	assert.deepEqual(state.policy.roles.scout.routes.literal, {
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		effort: "low",
	});
	assert.equal(Object.isFrozen(state.policy.roles.scout.routes.literal), true);
});

test("reports an agent directory without a policy file as absent", () => {
	const state = loadCanonicalPolicy(emptyAgentDir());

	assert.deepEqual(state, { status: "absent" });
});

test("rejects a policy file that is not JSON", () => {
	const state = loadCanonicalPolicy(writeCanonicalPolicy("{ not json"));

	assert.equal(state.status, "invalid");
});

test("rejects enforcement-affecting unknown and missing fields", () => {
	assert.match(
		invalidReason((policy) => {
			policy.fallbackProviders = ["anthropic"];
		}),
		/unknown field fallbackProviders/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.roles.scout.maxEffort = "high";
		}),
		/Role scout has unknown field maxEffort/,
	);
	assert.match(
		invalidReason((policy) => {
			delete policy.guardrails;
		}),
		/missing field guardrails/,
	);
});

test("rejects a schema version or child runtime range this package cannot read", () => {
	assert.match(
		invalidReason((policy) => {
			policy.schemaVersion = 4;
			policy.schemaCompatibility.childRuntime = { minimum: 4, maximum: 4 };
		}),
		/schema/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.schemaCompatibility.childRuntime = { minimum: 4, maximum: 5 };
		}),
		/childRuntime/,
	);
});

test("rejects ambiguous or dangling role aliases", () => {
	assert.match(
		invalidReason((policy) => {
			policy.aliases.scout = "worker";
		}),
		/Alias scout overlaps a canonical role/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.aliases.helper = "planner";
		}),
		/Alias helper must point directly to a canonical role/,
	);
});

test("rejects guardrails, efforts, and interaction grants the contract forbids", () => {
	assert.match(
		invalidReason((policy) => {
			policy.guardrails.allowProviderFallback = true;
		}),
		/guardrails.allowProviderFallback must be false/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.roles.worker.routes.implementation.effort = "xhigh";
		}),
		/xhigh/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.roles.worker.allowedInteractionModes = ["interactive"];
		}),
		/interactive/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.roles.worker.routes.implementation.provider = "Openai Codex";
		}),
		/provider is invalid/,
	);
});

test("rejects pilot cases whose route differs from the role's fixed route", () => {
	assert.match(
		invalidReason((policy) => {
			policy.pilotCases["scout-literal-1"].route.model = "gpt-5.6-terra";
		}),
		/Pilot case scout-literal-1 route must equal the role fixed route/,
	);
});

test("rejects extension grants that drop the route guard or grant subagent spawning", () => {
	assert.match(
		invalidReason((policy) => {
			policy.extensionGrants.worker = [];
		}),
		/must grant the drover-model-routing route guard/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.extensionCatalog.spawner = {
				source: "git:github.com/Drover-Insights/pi-subagents@04ce06169928d1af9b83c3de4ded2c6bb2e271c1",
				files: [{ path: "src/index.ts", sha256: "d".repeat(64) }],
			};
			policy.extensionGrants.worker = ["drover-model-routing", "spawner"];
		}),
		/must not grant subagent spawning support/,
	);
});

test("rejects operational states this package cannot enforce", () => {
	assert.match(
		invalidReason((policy) => {
			policy.operationalStates.push("suspended");
			policy.roles.worker.state = "suspended";
		}),
		/operationalStates/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.operationalStates = ["disabled", "pilot", "automated"];
			policy.roles.worker.state = "pilot";
		}),
		/operationalStates/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.operationalStates = ["disabled", "pilot", "suspended", "automated"];
			policy.roles.worker.state = "suspended";
		}),
		/operationalStates/,
	);
});

test("rejects resource-grant Skill names that are not plain identifiers", () => {
	for (const skill of ["all", "none", "review,deploy", "review=hidden"]) {
		assert.match(
			invalidReason((policy) => {
				policy.resourceGrants["isolated-child"].skills = [skill];
			}),
			/Resource grant isolated-child skills/,
			skill,
		);
	}
});

test("rejects a child role that uses the all-Skills grant", () => {
	assert.match(
		invalidReason((policy) => {
			policy.roles.worker.resourceGrant = "controller";
			policy.pilotCases = {};
		}),
		/Role worker is a child role and cannot use the all-Skills grant controller/,
	);
});

test("rejects a pilot role whose resource grant enables Skills or project resources", () => {
	assert.match(
		invalidReason((policy) => {
			policy.resourceGrants.reviewing = { skills: ["review"], projectResources: false };
			policy.roles.scout.resourceGrant = "reviewing";
			policy.pilotCases = {};
		}),
		/Role scout is a pilot role and cannot use resource grant reviewing, which enables Skills or project resources/,
	);
	assert.match(
		invalidReason((policy) => {
			policy.resourceGrants.project = { skills: [], projectResources: true };
			policy.roles.scout.resourceGrant = "project";
			policy.pilotCases = {};
		}),
		/Role scout is a pilot role and cannot use resource grant project/,
	);
});

test("rejects a granted extension whose catalog source is a Git commit rather than a local file", () => {
	assert.match(
		invalidReason((policy) => {
			policy.extensionCatalog.remote = {
				source: "git:github.com/example/remote-extension@04ce06169928d1af9b83c3de4ded2c6bb2e271c1",
				files: [{ path: "index.ts", sha256: "d".repeat(64) }],
			};
			policy.extensionGrants.worker = ["drover-model-routing", "remote"];
		}),
		/extensionGrants.worker must not grant remote, whose catalog source is a Git commit rather than a verified local file/,
	);
});

test("a pilot-state controller keeps its all-Skills grant, since it never runs as a child", () => {
	const document = canonicalPolicyDocument();
	document.roles.controller.state = "pilot";

	assert.equal(loadCanonicalPolicy(writeCanonicalPolicy(document)).status, "loaded");
});
