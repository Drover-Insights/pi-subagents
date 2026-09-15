import type {
	CodeGraphScoutRoute,
	CodeGraphScoutRoutingInput,
	CodeGraphScoutRoutingInputWithIrrelevantReason,
	CodeGraphScoutRoutingInputWithoutReason,
	ControllerChildForbidden,
	ControllerRequestingWorkerRoutingInput,
	FrontierCriticArchitectureRoute,
	FrontierCriticArchitectureRoutingInput,
	FrontierCriticArchitectureRoutingInputWithIrrelevantReason,
	FrontierCriticArchitectureRoutingInputWithModelOverride,
	FrontierCriticArchitectureRoutingInputWithoutReason,
	FrontierCriticArchitectureRoutingInputWithThinkingOverride,
	FrontierCriticRequestingCodeGraphScoutRoutingInput,
	FrontierCriticRequestingFrontierEngineerRoutingInput,
	FrontierCriticRequestingLiteralScoutRoutingInput,
	FrontierCriticRequestingReviewerRoutingInput,
	FrontierCriticRequestingWorkerRoutingInput,
	FrontierEngineerRequestingCodeGraphScoutRoutingInput,
	FrontierEngineerRequestingFrontierCriticArchitectureRoutingInput,
	FrontierEngineerRequestingLiteralScoutRoutingInput,
	FrontierEngineerRequestingReviewerRoutingInput,
	FrontierEngineerRequestingWorkerRoutingInput,
	FrontierEngineerRoute,
	FrontierEngineerRoutingInput,
	FrontierEngineerRoutingInputWithIrrelevantReason,
	FrontierEngineerRoutingInputWithModelOverride,
	FrontierEngineerRoutingInputWithoutReason,
	FrontierEngineerRoutingInputWithThinkingOverride,
	IrrelevantEscalationReason,
	LiteralScoutRoute,
	LiteralScoutRoutingInput,
	LiteralScoutRoutingInputWithModelOverride,
	LiteralScoutRoutingInputWithoutRisk,
	LiteralScoutRoutingInputWithReason,
	LiteralScoutRoutingInputWithThinkingOverride,
	LiteralScoutRoutingInputWithUnknownMode,
	LiteralScoutRoutingInputWithUnknownReason,
	LiteralScoutRoutingInputWithUnknownRisk,
	MissingCapabilityClass,
	MissingEscalationReason,
	MissingRisk,
	ProhibitedOverride,
	ReviewerNormalRoute,
	ReviewerNormalRoutingInput,
	ReviewerNormalRoutingInputWithModelOverride,
	ReviewerNormalRoutingInputWithReason,
	ReviewerNormalRoutingInputWithThinkingOverride,
	ReviewerRequestingCodeGraphScoutRoutingInput,
	ReviewerRequestingFrontierCriticArchitectureRoutingInput,
	ReviewerRequestingFrontierEngineerRoutingInput,
	ReviewerRequestingLiteralScoutRoutingInput,
	ReviewerRequestingWorkerRoutingInput,
	RoleClassMismatch,
	RoutingPolicyInput,
	RoutingPolicyResult,
	ScoutRequestingFrontierCriticArchitectureRoutingInput,
	ScoutRequestingFrontierEngineerRoutingInput,
	ScoutRequestingReviewerRoutingInput,
	ScoutRequestingWorkerRoutingInput,
	ScoutRoutingInputWithoutCapability,
	UnknownAgent,
	UnknownAgentRequestingWorkerRoutingInput,
	UnknownCapabilityClass,
	UnknownEscalationReason,
	UnknownMode,
	UnknownRisk,
	UnknownScoutCapabilityRoutingInput,
	WorkerImplementationRoute,
	WorkerImplementationRoutingInput,
	WorkerImplementationRoutingInputWithModelOverride,
	WorkerImplementationRoutingInputWithReason,
	WorkerImplementationRoutingInputWithThinkingOverride,
	WorkerRequestingCodeGraphScoutRoutingInput,
	WorkerRequestingFrontierCriticArchitectureRoutingInput,
	WorkerRequestingFrontierEngineerRoutingInput,
	WorkerRequestingLiteralScoutRoutingInput,
	WorkerRequestingReviewerRoutingInput,
} from "./policy-types.ts";

export type * from "./policy-types.ts";

function rejectIrrelevantEscalationReason(
	input: RoutingPolicyInput,
): IrrelevantEscalationReason | undefined {
	if (input.escalationReason === undefined) return undefined;
	return {
		status: "policy_rejected",
		reason: "irrelevant_escalation_reason",
	};
}

export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithModelOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithThinkingOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInput,
): LiteralScoutRoute;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithUnknownReason,
): UnknownEscalationReason;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithUnknownMode,
): UnknownMode;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithUnknownRisk,
): UnknownRisk;
export function resolveRoutingPolicy(
	input: LiteralScoutRoutingInputWithoutRisk,
): MissingRisk;
export function resolveRoutingPolicy(
	input: WorkerRequestingLiteralScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ReviewerRequestingLiteralScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticRequestingLiteralScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRequestingLiteralScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ScoutRoutingInputWithoutCapability,
): MissingCapabilityClass;
export function resolveRoutingPolicy(
	input: CodeGraphScoutRoutingInput,
): CodeGraphScoutRoute;
export function resolveRoutingPolicy(
	input: CodeGraphScoutRoutingInputWithoutReason,
): MissingEscalationReason;
export function resolveRoutingPolicy(
	input: CodeGraphScoutRoutingInputWithIrrelevantReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: UnknownScoutCapabilityRoutingInput,
): UnknownCapabilityClass;
export function resolveRoutingPolicy(
	input: WorkerRequestingCodeGraphScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ReviewerRequestingCodeGraphScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticRequestingCodeGraphScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRequestingCodeGraphScoutRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: WorkerImplementationRoutingInputWithModelOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: WorkerImplementationRoutingInputWithThinkingOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: WorkerImplementationRoutingInput,
): WorkerImplementationRoute;
export function resolveRoutingPolicy(
	input: WorkerImplementationRoutingInputWithReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: ReviewerRequestingWorkerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ScoutRequestingWorkerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticRequestingWorkerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRequestingWorkerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ControllerRequestingWorkerRoutingInput,
): ControllerChildForbidden;
export function resolveRoutingPolicy(
	input: UnknownAgentRequestingWorkerRoutingInput,
): UnknownAgent;
export function resolveRoutingPolicy(
	input: ReviewerNormalRoutingInputWithModelOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: ReviewerNormalRoutingInputWithThinkingOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: ReviewerNormalRoutingInput,
): ReviewerNormalRoute;
export function resolveRoutingPolicy(
	input: ReviewerNormalRoutingInputWithReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: WorkerRequestingReviewerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ScoutRequestingReviewerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticRequestingReviewerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRequestingReviewerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticArchitectureRoutingInputWithModelOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: FrontierCriticArchitectureRoutingInputWithThinkingOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: FrontierCriticArchitectureRoutingInput,
): FrontierCriticArchitectureRoute;
export function resolveRoutingPolicy(
	input: FrontierCriticArchitectureRoutingInputWithoutReason,
): MissingEscalationReason;
export function resolveRoutingPolicy(
	input: FrontierCriticArchitectureRoutingInputWithIrrelevantReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: WorkerRequestingFrontierCriticArchitectureRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ReviewerRequestingFrontierCriticArchitectureRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ScoutRequestingFrontierCriticArchitectureRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRequestingFrontierCriticArchitectureRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierEngineerRoutingInputWithModelOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: FrontierEngineerRoutingInputWithThinkingOverride,
): ProhibitedOverride;
export function resolveRoutingPolicy(
	input: FrontierEngineerRoutingInput,
): FrontierEngineerRoute;
export function resolveRoutingPolicy(
	input: FrontierEngineerRoutingInputWithoutReason,
): MissingEscalationReason;
export function resolveRoutingPolicy(
	input: FrontierEngineerRoutingInputWithIrrelevantReason,
): IrrelevantEscalationReason;
export function resolveRoutingPolicy(
	input: WorkerRequestingFrontierEngineerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ReviewerRequestingFrontierEngineerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: ScoutRequestingFrontierEngineerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: FrontierCriticRequestingFrontierEngineerRoutingInput,
): RoleClassMismatch;
export function resolveRoutingPolicy(
	input: RoutingPolicyInput,
): RoutingPolicyResult;
export function resolveRoutingPolicy(
	input:
		| LiteralScoutRoutingInput
		| LiteralScoutRoutingInputWithReason
		| LiteralScoutRoutingInputWithUnknownReason
		| LiteralScoutRoutingInputWithModelOverride
		| LiteralScoutRoutingInputWithThinkingOverride
		| LiteralScoutRoutingInputWithUnknownMode
		| LiteralScoutRoutingInputWithUnknownRisk
		| LiteralScoutRoutingInputWithoutRisk
		| WorkerRequestingLiteralScoutRoutingInput
		| ReviewerRequestingLiteralScoutRoutingInput
		| FrontierCriticRequestingLiteralScoutRoutingInput
		| FrontierEngineerRequestingLiteralScoutRoutingInput
		| UnknownScoutCapabilityRoutingInput
		| ScoutRoutingInputWithoutCapability
		| CodeGraphScoutRoutingInput
		| CodeGraphScoutRoutingInputWithoutReason
		| CodeGraphScoutRoutingInputWithIrrelevantReason
		| WorkerRequestingCodeGraphScoutRoutingInput
		| ReviewerRequestingCodeGraphScoutRoutingInput
		| FrontierCriticRequestingCodeGraphScoutRoutingInput
		| FrontierEngineerRequestingCodeGraphScoutRoutingInput
		| WorkerImplementationRoutingInput
		| WorkerImplementationRoutingInputWithReason
		| WorkerImplementationRoutingInputWithModelOverride
		| WorkerImplementationRoutingInputWithThinkingOverride
		| ReviewerRequestingWorkerRoutingInput
		| ScoutRequestingWorkerRoutingInput
		| FrontierCriticRequestingWorkerRoutingInput
		| FrontierEngineerRequestingWorkerRoutingInput
		| ControllerRequestingWorkerRoutingInput
		| UnknownAgentRequestingWorkerRoutingInput
		| ReviewerNormalRoutingInput
		| ReviewerNormalRoutingInputWithReason
		| ReviewerNormalRoutingInputWithModelOverride
		| ReviewerNormalRoutingInputWithThinkingOverride
		| WorkerRequestingReviewerRoutingInput
		| ScoutRequestingReviewerRoutingInput
		| FrontierCriticRequestingReviewerRoutingInput
		| FrontierEngineerRequestingReviewerRoutingInput
		| FrontierCriticArchitectureRoutingInput
		| FrontierCriticArchitectureRoutingInputWithoutReason
		| FrontierCriticArchitectureRoutingInputWithIrrelevantReason
		| FrontierCriticArchitectureRoutingInputWithModelOverride
		| FrontierCriticArchitectureRoutingInputWithThinkingOverride
		| WorkerRequestingFrontierCriticArchitectureRoutingInput
		| ReviewerRequestingFrontierCriticArchitectureRoutingInput
		| ScoutRequestingFrontierCriticArchitectureRoutingInput
		| FrontierEngineerRequestingFrontierCriticArchitectureRoutingInput
		| FrontierEngineerRoutingInput
		| FrontierEngineerRoutingInputWithoutReason
		| FrontierEngineerRoutingInputWithIrrelevantReason
		| FrontierEngineerRoutingInputWithModelOverride
		| FrontierEngineerRoutingInputWithThinkingOverride
		| WorkerRequestingFrontierEngineerRoutingInput
		| ReviewerRequestingFrontierEngineerRoutingInput
		| ScoutRequestingFrontierEngineerRoutingInput
		| FrontierCriticRequestingFrontierEngineerRoutingInput
		| RoutingPolicyInput,
):
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
	| UnknownEscalationReason {
	if (input.agent === "pilot-controller") {
		return { status: "policy_rejected", reason: "controller_child_forbidden" };
	}
	if (
		input.agent !== "pilot-scout" &&
		input.agent !== "pilot-worker" &&
		input.agent !== "pilot-reviewer" &&
		input.agent !== "pilot-frontier-critic" &&
		input.agent !== "pilot-frontier-engineer"
	) {
		return { status: "policy_rejected", reason: "unknown_agent" };
	}
	if (input.capabilityClass === undefined) {
		return { status: "policy_rejected", reason: "missing_capability_class" };
	}
	if (
		input.capabilityClass !== "scout.literal" &&
		input.capabilityClass !== "scout.code-graph" &&
		input.capabilityClass !== "worker.implementation" &&
		input.capabilityClass !== "reviewer.normal" &&
		input.capabilityClass !== "frontier.architecture" &&
		input.capabilityClass !== "frontier.engineering"
	) {
		return { status: "policy_rejected", reason: "unknown_capability_class" };
	}
	if (input.mode !== "background" && input.mode !== "interactive") {
		return { status: "policy_rejected", reason: "unknown_mode" };
	}
	if (input.risk === undefined) {
		return { status: "policy_rejected", reason: "missing_risk" };
	}
	if (
		input.risk !== "low" &&
		input.risk !== "medium" &&
		input.risk !== "high" &&
		input.risk !== "critical"
	) {
		return { status: "policy_rejected", reason: "unknown_risk" };
	}
	if (
		input.escalationReason !== undefined &&
		input.escalationReason !== "control_flow_required" &&
		input.escalationReason !== "architecture_invariant_risk" &&
		input.escalationReason !== "difficult_code_grounded_debugging"
	) {
		return { status: "policy_rejected", reason: "unknown_escalation_reason" };
	}

	if (
		(input.agent === "pilot-scout" &&
			("model" in input || "thinking" in input)) ||
		(input.agent === "pilot-worker" &&
			("model" in input || "thinking" in input)) ||
		(input.agent === "pilot-reviewer" &&
			("model" in input || "thinking" in input)) ||
		(input.agent === "pilot-frontier-critic" &&
			("model" in input || "thinking" in input)) ||
		(input.agent === "pilot-frontier-engineer" &&
			("model" in input || "thinking" in input))
	) {
		return { status: "policy_rejected", reason: "prohibited_override" };
	}

	if (input.capabilityClass === "frontier.engineering") {
		if (
			input.agent === "pilot-worker" ||
			input.agent === "pilot-reviewer" ||
			input.agent === "pilot-scout" ||
			input.agent === "pilot-frontier-critic"
		) {
			return { status: "policy_rejected", reason: "role_class_mismatch" };
		}
		if (input.escalationReason === undefined) {
			return { status: "policy_rejected", reason: "missing_escalation_reason" };
		}
		if (input.escalationReason !== "difficult_code_grounded_debugging") {
			return {
				status: "policy_rejected",
				reason: "irrelevant_escalation_reason",
			};
		}
		return {
			logicalRoute: "openai-codex/gpt-6-astra",
			thinking: "xhigh",
		};
	}

	if (input.capabilityClass === "frontier.architecture") {
		if (
			input.agent === "pilot-worker" ||
			input.agent === "pilot-reviewer" ||
			input.agent === "pilot-scout" ||
			input.agent === "pilot-frontier-engineer"
		) {
			return { status: "policy_rejected", reason: "role_class_mismatch" };
		}
		if (input.escalationReason === undefined) {
			return { status: "policy_rejected", reason: "missing_escalation_reason" };
		}
		if (input.escalationReason !== "architecture_invariant_risk") {
			return {
				status: "policy_rejected",
				reason: "irrelevant_escalation_reason",
			};
		}
		return {
			logicalRoute: "anthropic/claude-fable-5-1",
			thinking: "high",
		};
	}

	if (input.capabilityClass === "reviewer.normal") {
		if (
			input.agent === "pilot-worker" ||
			input.agent === "pilot-scout" ||
			input.agent === "pilot-frontier-critic" ||
			input.agent === "pilot-frontier-engineer"
		) {
			return { status: "policy_rejected", reason: "role_class_mismatch" };
		}
		const escalationRejection = rejectIrrelevantEscalationReason(input);
		if (escalationRejection) return escalationRejection;
		return {
			logicalRoute: "openai-codex/gpt-5.6-sol",
			thinking: "medium",
		};
	}

	if (input.capabilityClass === "worker.implementation") {
		if (
			input.agent === "pilot-reviewer" ||
			input.agent === "pilot-scout" ||
			input.agent === "pilot-frontier-critic" ||
			input.agent === "pilot-frontier-engineer"
		) {
			return { status: "policy_rejected", reason: "role_class_mismatch" };
		}
		const escalationRejection = rejectIrrelevantEscalationReason(input);
		if (escalationRejection) return escalationRejection;
		return {
			logicalRoute: "openai-codex/gpt-5.6-terra",
			thinking: "medium",
		};
	}

	if (input.capabilityClass === "scout.code-graph") {
		if (
			input.agent === "pilot-worker" ||
			input.agent === "pilot-reviewer" ||
			input.agent === "pilot-frontier-critic" ||
			input.agent === "pilot-frontier-engineer"
		) {
			return { status: "policy_rejected", reason: "role_class_mismatch" };
		}
		if (input.escalationReason === undefined) {
			return { status: "policy_rejected", reason: "missing_escalation_reason" };
		}
		if (input.escalationReason !== "control_flow_required") {
			return {
				status: "policy_rejected",
				reason: "irrelevant_escalation_reason",
			};
		}
		return {
			logicalRoute: "openai-codex/gpt-5.6-terra",
			thinking: "low",
		};
	}

	if (
		input.agent === "pilot-worker" ||
		input.agent === "pilot-reviewer" ||
		input.agent === "pilot-frontier-critic" ||
		input.agent === "pilot-frontier-engineer"
	) {
		return { status: "policy_rejected", reason: "role_class_mismatch" };
	}
	const escalationRejection = rejectIrrelevantEscalationReason(input);
	if (escalationRejection) return escalationRejection;
	return {
		logicalRoute: "openai-codex/gpt-5.6-luna",
		thinking: "low",
	};
}
