import { Type } from "typebox";

const SUBAGENT_NAME_DESCRIPTION =
	"Required machine handle for this launch. Use lower-kebab <scope>-<role>, 2-4 words, max 32 chars, matching ^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}$; examples: auth-scout, diff-reviewer, session-tester. Do not use Title Case, spaces, underscores, generic names, or prose.";

const SUBAGENT_TITLE_DESCRIPTION =
	"Required human title for this child session/widget. Use sentence case, 3-8 words, outcome/objective focused, and not a prompt or instruction; examples: Auth implementation map, Local diff bug review.";

const SUBAGENT_MODEL_DESCRIPTION =
	"Model routing/cost control only. Omit unless the user named a concrete model for this launch. " +
	"For routing-enabled pilot agents, always omit this field because policy selects the model. " +
	"Do not infer a model from quality, depth, urgency, safety, or cost language. " +
	"Never invent or upgrade models. Format model as provider/model; put the thinking level in `thinking`.";

const SUBAGENT_THINKING_DESCRIPTION =
	"Child runtime thinking level only. Omit unless the user named a concrete thinking level for this launch. " +
	"For routing-enabled pilot agents, always omit this field because policy selects the thinking level. " +
	"Do not infer thinking from quality, depth, urgency, safety, or cost language. " +
	"Use a thinking level supported by the selected model and the installed Pi version.";

const subagentRoutingProperties = {
	capabilityClass: Type.Optional(
		Type.String({
			description:
				"Required for routing-enabled pilot agents. Role mappings: pilot-scout: scout.literal or scout.code-graph; pilot-worker: worker.implementation; pilot-reviewer: reviewer.normal; pilot-frontier-critic: frontier.architecture; pilot-frontier-engineer: frontier.engineering. pilot-controller cannot be launched as a child.",
		}),
	),
	escalationReason: Type.Optional(
		Type.String({
			description:
				"Use scout.code-graph: control_flow_required; frontier.architecture: architecture_invariant_risk; frontier.engineering: difficult_code_grounded_debugging. Omit for scout.literal, worker.implementation, and reviewer.normal.",
		}),
	),
	risk: Type.Optional(
		Type.String({
			description:
				"Required risk for routing-enabled pilot agents: low, medium, high, or critical.",
		}),
	),
};

export const SubagentChildParams = Type.Object({
	name: Type.String({ description: SUBAGENT_NAME_DESCRIPTION }),
	task: Type.String({
		description:
			"Task/prompt for the sub-agent. For non-trivial work, write readable Markdown: short paragraphs, bullets, or headings as appropriate. Use a one-line task only for trivial work.",
	}),
	title: Type.String({ description: SUBAGENT_TITLE_DESCRIPTION }),
	agent: Type.String({
		description:
			"Required agent definition name. Reads .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md and refuses ad-hoc unnamed subagents.",
	}),
	model: Type.Optional(
		Type.String({ description: SUBAGENT_MODEL_DESCRIPTION }),
	),
	thinking: Type.Optional(
		Type.String({ description: SUBAGENT_THINKING_DESCRIPTION }),
	),
	...subagentRoutingProperties,
});

export const SubagentParams = Type.Object({
	name: Type.Optional(Type.String({ description: SUBAGENT_NAME_DESCRIPTION })),
	task: Type.Optional(
		Type.String({
			description:
				"Task/prompt for a single sub-agent. For non-trivial work, write readable Markdown: short paragraphs, bullets, or headings as appropriate. Use a one-line task only for trivial work.",
		}),
	),
	title: Type.Optional(
		Type.String({ description: SUBAGENT_TITLE_DESCRIPTION }),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Required agent definition name for a single subagent launch.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: SUBAGENT_MODEL_DESCRIPTION }),
	),
	thinking: Type.Optional(
		Type.String({ description: SUBAGENT_THINKING_DESCRIPTION }),
	),
	...subagentRoutingProperties,
	children: Type.Optional(
		Type.Array(SubagentChildParams, {
			description:
				"Spawn multiple children in one deterministic launch. Use this instead of multiple separate subagent tool calls when a user asks for more than one agent.",
		}),
	),
});
