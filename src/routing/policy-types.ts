export type RoutingPolicyInput = {
	dispatchId: string;
	agent: string;
	mode?: string;
	capabilityClass?: string;
	escalationReason?: string;
	risk?: string;
	model?: string;
	thinking?: string;
};

type ScoutRoutingInput = {
	dispatchId: string;
	agent: "pilot-scout";
	mode: "background" | "interactive";
	risk: "low" | "medium" | "high" | "critical";
};

export type LiteralScoutRoutingInput = ScoutRoutingInput & {
	capabilityClass: "scout.literal";
	escalationReason?: undefined;
};

export type LiteralScoutRoutingInputWithReason = Omit<
	LiteralScoutRoutingInput,
	"escalationReason"
> & {
	escalationReason:
		| "control_flow_required"
		| "architecture_invariant_risk"
		| "difficult_code_grounded_debugging";
};

export type LiteralScoutRoutingInputWithUnknownReason = Omit<
	LiteralScoutRoutingInput,
	"escalationReason"
> & {
	escalationReason: string;
};

export type LiteralScoutRoutingInputWithModelOverride =
	LiteralScoutRoutingInput & {
		model: string;
	};

export type LiteralScoutRoutingInputWithThinkingOverride =
	LiteralScoutRoutingInput & {
		thinking: string;
	};

export type UnknownScoutCapabilityRoutingInput = ScoutRoutingInput & {
	capabilityClass: string;
	escalationReason?: undefined;
};

export type ScoutRoutingInputWithoutCapability = ScoutRoutingInput & {
	capabilityClass?: undefined;
	escalationReason?: undefined;
};

export type LiteralScoutRoutingInputWithUnknownMode = Omit<
	LiteralScoutRoutingInput,
	"mode"
> & {
	mode: string;
};

export type LiteralScoutRoutingInputWithUnknownRisk = Omit<
	LiteralScoutRoutingInput,
	"risk"
> & {
	risk: string;
};

export type LiteralScoutRoutingInputWithoutRisk = Omit<
	LiteralScoutRoutingInput,
	"risk"
> & {
	risk?: undefined;
};

export type WorkerRequestingLiteralScoutRoutingInput = Omit<
	LiteralScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-worker";
};

export type ReviewerRequestingLiteralScoutRoutingInput = Omit<
	LiteralScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-reviewer";
};

export type FrontierCriticRequestingLiteralScoutRoutingInput = Omit<
	LiteralScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-critic";
};

export type FrontierEngineerRequestingLiteralScoutRoutingInput = Omit<
	LiteralScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-engineer";
};

export type CodeGraphScoutRoutingInput = ScoutRoutingInput & {
	capabilityClass: "scout.code-graph";
	escalationReason: "control_flow_required";
};

export type CodeGraphScoutRoutingInputWithoutReason = ScoutRoutingInput & {
	capabilityClass: "scout.code-graph";
	escalationReason?: undefined;
};

export type CodeGraphScoutRoutingInputWithIrrelevantReason =
	ScoutRoutingInput & {
		capabilityClass: "scout.code-graph";
		escalationReason: "architecture_invariant_risk";
	};

export type WorkerRequestingCodeGraphScoutRoutingInput = Omit<
	CodeGraphScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-worker";
};

export type ReviewerRequestingCodeGraphScoutRoutingInput = Omit<
	CodeGraphScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-reviewer";
};

export type FrontierCriticRequestingCodeGraphScoutRoutingInput = Omit<
	CodeGraphScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-critic";
};

export type FrontierEngineerRequestingCodeGraphScoutRoutingInput = Omit<
	CodeGraphScoutRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-engineer";
};

export type WorkerImplementationRoutingInput = {
	dispatchId: string;
	agent: "pilot-worker";
	mode: "background" | "interactive";
	capabilityClass: "worker.implementation";
	escalationReason?: undefined;
	risk: "low" | "medium" | "high" | "critical";
};

export type WorkerImplementationRoutingInputWithReason = Omit<
	WorkerImplementationRoutingInput,
	"escalationReason"
> & {
	escalationReason: "control_flow_required";
};

export type WorkerImplementationRoutingInputWithModelOverride =
	WorkerImplementationRoutingInput & {
		model: string;
	};

export type WorkerImplementationRoutingInputWithThinkingOverride =
	WorkerImplementationRoutingInput & {
		thinking: string;
	};

export type ReviewerRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: "pilot-reviewer";
};

export type ScoutRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: "pilot-scout";
};

export type FrontierCriticRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-critic";
};

export type FrontierEngineerRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-engineer";
};

export type ControllerRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: "pilot-controller";
};

export type UnknownAgentRequestingWorkerRoutingInput = Omit<
	WorkerImplementationRoutingInput,
	"agent"
> & {
	agent: string;
};

export type ReviewerNormalRoutingInput = {
	dispatchId: string;
	agent: "pilot-reviewer";
	mode: "background" | "interactive";
	capabilityClass: "reviewer.normal";
	escalationReason?: undefined;
	risk: "low" | "medium" | "high" | "critical";
};

export type ReviewerNormalRoutingInputWithReason = Omit<
	ReviewerNormalRoutingInput,
	"escalationReason"
> & {
	escalationReason: "control_flow_required";
};

export type ReviewerNormalRoutingInputWithModelOverride =
	ReviewerNormalRoutingInput & {
		model: string;
	};

export type ReviewerNormalRoutingInputWithThinkingOverride =
	ReviewerNormalRoutingInput & {
		thinking: string;
	};

export type WorkerRequestingReviewerRoutingInput = Omit<
	ReviewerNormalRoutingInput,
	"agent"
> & {
	agent: "pilot-worker";
};

export type ScoutRequestingReviewerRoutingInput = Omit<
	ReviewerNormalRoutingInput,
	"agent"
> & {
	agent: "pilot-scout";
};

export type FrontierCriticRequestingReviewerRoutingInput = Omit<
	ReviewerNormalRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-critic";
};

export type FrontierEngineerRequestingReviewerRoutingInput = Omit<
	ReviewerNormalRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-engineer";
};

export type FrontierCriticArchitectureRoutingInput = {
	dispatchId: string;
	agent: "pilot-frontier-critic";
	mode: "background" | "interactive";
	capabilityClass: "frontier.architecture";
	escalationReason: "architecture_invariant_risk";
	risk: "low" | "medium" | "high" | "critical";
};

export type FrontierCriticArchitectureRoutingInputWithoutReason = Omit<
	FrontierCriticArchitectureRoutingInput,
	"escalationReason"
> & {
	escalationReason?: undefined;
};

export type FrontierCriticArchitectureRoutingInputWithIrrelevantReason = Omit<
	FrontierCriticArchitectureRoutingInput,
	"escalationReason"
> & {
	escalationReason: "control_flow_required";
};

export type FrontierCriticArchitectureRoutingInputWithModelOverride =
	FrontierCriticArchitectureRoutingInput & {
		model: string;
	};

export type FrontierCriticArchitectureRoutingInputWithThinkingOverride =
	FrontierCriticArchitectureRoutingInput & {
		thinking: string;
	};

export type WorkerRequestingFrontierCriticArchitectureRoutingInput = Omit<
	FrontierCriticArchitectureRoutingInput,
	"agent"
> & {
	agent: "pilot-worker";
};

export type ReviewerRequestingFrontierCriticArchitectureRoutingInput = Omit<
	FrontierCriticArchitectureRoutingInput,
	"agent"
> & {
	agent: "pilot-reviewer";
};

export type ScoutRequestingFrontierCriticArchitectureRoutingInput = Omit<
	FrontierCriticArchitectureRoutingInput,
	"agent"
> & {
	agent: "pilot-scout";
};

export type FrontierEngineerRequestingFrontierCriticArchitectureRoutingInput =
	Omit<FrontierCriticArchitectureRoutingInput, "agent"> & {
		agent: "pilot-frontier-engineer";
	};

export type FrontierEngineerRoutingInput = {
	dispatchId: string;
	agent: "pilot-frontier-engineer";
	mode: "background" | "interactive";
	capabilityClass: "frontier.engineering";
	escalationReason: "difficult_code_grounded_debugging";
	risk: "low" | "medium" | "high" | "critical";
};

export type FrontierEngineerRoutingInputWithoutReason = Omit<
	FrontierEngineerRoutingInput,
	"escalationReason"
> & {
	escalationReason?: undefined;
};

export type FrontierEngineerRoutingInputWithIrrelevantReason = Omit<
	FrontierEngineerRoutingInput,
	"escalationReason"
> & {
	escalationReason: "control_flow_required";
};

export type FrontierEngineerRoutingInputWithModelOverride =
	FrontierEngineerRoutingInput & {
		model: string;
	};

export type FrontierEngineerRoutingInputWithThinkingOverride =
	FrontierEngineerRoutingInput & {
		thinking: string;
	};

export type WorkerRequestingFrontierEngineerRoutingInput = Omit<
	FrontierEngineerRoutingInput,
	"agent"
> & {
	agent: "pilot-worker";
};

export type ReviewerRequestingFrontierEngineerRoutingInput = Omit<
	FrontierEngineerRoutingInput,
	"agent"
> & {
	agent: "pilot-reviewer";
};

export type ScoutRequestingFrontierEngineerRoutingInput = Omit<
	FrontierEngineerRoutingInput,
	"agent"
> & {
	agent: "pilot-scout";
};

export type FrontierCriticRequestingFrontierEngineerRoutingInput = Omit<
	FrontierEngineerRoutingInput,
	"agent"
> & {
	agent: "pilot-frontier-critic";
};

export type LiteralScoutRoute = {
	logicalRoute: "openai-codex/gpt-5.6-luna";
	thinking: "low";
};

export type CodeGraphScoutRoute = {
	logicalRoute: "openai-codex/gpt-5.6-terra";
	thinking: "low";
};

export type WorkerImplementationRoute = {
	logicalRoute: "openai-codex/gpt-5.6-terra";
	thinking: "medium";
};

export type ReviewerNormalRoute = {
	logicalRoute: "openai-codex/gpt-5.6-sol";
	thinking: "medium";
};

export type FrontierCriticArchitectureRoute = {
	logicalRoute: "anthropic/claude-fable-5-1";
	thinking: "high";
};

export type FrontierEngineerRoute = {
	logicalRoute: "openai-codex/gpt-6-astra";
	thinking: "xhigh";
};

export type MissingEscalationReason = {
	status: "policy_rejected";
	reason: "missing_escalation_reason";
};

export type IrrelevantEscalationReason = {
	status: "policy_rejected";
	reason: "irrelevant_escalation_reason";
};

export type RoleClassMismatch = {
	status: "policy_rejected";
	reason: "role_class_mismatch";
};

export type ProhibitedOverride = {
	status: "policy_rejected";
	reason: "prohibited_override";
};

export type ControllerChildForbidden = {
	status: "policy_rejected";
	reason: "controller_child_forbidden";
};

export type UnknownAgent = {
	status: "policy_rejected";
	reason: "unknown_agent";
};

export type UnknownCapabilityClass = {
	status: "policy_rejected";
	reason: "unknown_capability_class";
};

export type MissingCapabilityClass = {
	status: "policy_rejected";
	reason: "missing_capability_class";
};

export type UnknownMode = {
	status: "policy_rejected";
	reason: "unknown_mode";
};

export type UnknownRisk = {
	status: "policy_rejected";
	reason: "unknown_risk";
};

export type MissingRisk = {
	status: "policy_rejected";
	reason: "missing_risk";
};

export type UnknownEscalationReason = {
	status: "policy_rejected";
	reason: "unknown_escalation_reason";
};

export type RoutingPolicyResult =
	| LiteralScoutRoute
	| CodeGraphScoutRoute
	| WorkerImplementationRoute
	| ReviewerNormalRoute
	| FrontierCriticArchitectureRoute
	| FrontierEngineerRoute
	| MissingEscalationReason
	| IrrelevantEscalationReason
	| RoleClassMismatch
	| ProhibitedOverride
	| ControllerChildForbidden
	| UnknownAgent
	| UnknownCapabilityClass
	| MissingCapabilityClass
	| UnknownMode
	| UnknownRisk
	| MissingRisk
	| UnknownEscalationReason;
