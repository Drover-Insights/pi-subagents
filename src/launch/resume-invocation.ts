import { assertModelAllowed, buildModelRef, splitModelRef } from "../agents/model-refs.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import { normalizeModelRef, resolveAvailableModelRef } from "./prep.ts";

/** The models a resume can choose from when it applies a model or thinking override. */
export interface ResumeModelRegistry {
	getAvailable(): Array<{
		provider: string;
		id: string;
		reasoning?: boolean;
		thinkingLevelMap?: Record<string, string | null | undefined>;
	}>;
}

function splitResumeModelRef(
	model: string,
	fallbackThinking: string | undefined,
): { model: string; thinking: string | undefined; explicitThinking: boolean } {
	const split = splitModelRef(model);
	return split.thinking === undefined
		? { model, thinking: fallbackThinking, explicitThinking: false }
		: { model: split.model, thinking: split.thinking, explicitThinking: true };
}

export function resolveResumeLaunchMetadataForInvocation(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	requestedModel: string | undefined,
	requestedThinking?: string,
	modelRegistry?: ResumeModelRegistry,
): PersistedSubagentLaunchMetadata | undefined {
	if (!launchMetadata || (!requestedModel && !requestedThinking)) return launchMetadata;
	if (launchMetadata.allowModelOverride === false) {
		return {
			...launchMetadata,
			...(requestedModel ? { ignoredModelOverride: requestedModel } : {}),
			...(requestedThinking ? { ignoredThinkingOverride: requestedThinking } : {}),
		};
	}
	const baseModel = requestedModel ?? launchMetadata.modelRef ?? launchMetadata.model;
	if (!baseModel) {
		throw new Error("Cannot apply thinking override without a persisted model.");
	}
	const requested = splitResumeModelRef(baseModel, requestedThinking ?? launchMetadata.thinking);
	const explicitThinking = requested.explicitThinking || requestedThinking != null;
	const resolved = resolveAvailableModelRef(
		requested.model,
		requested.thinking,
		explicitThinking,
		modelRegistry,
		launchMetadata.modelRef,
	);
	const { effectiveModel, effectiveThinking, effectiveModelRef } = normalizeModelRef(resolved.model, resolved.thinking);
	const implicitDefaultRef = buildModelRef(launchMetadata.definitionModel, launchMetadata.definitionThinking);
	const implicitAllowed = implicitDefaultRef
		? [implicitDefaultRef]
		: launchMetadata.modelSource === "parent" && launchMetadata.modelRef
			? [launchMetadata.modelRef]
			: [];
	assertModelAllowed(effectiveModelRef, launchMetadata.allowedModels, launchMetadata.name, implicitAllowed);
	return {
		...launchMetadata,
		timestamp: new Date().toISOString(),
		model: effectiveModel,
		thinking: effectiveThinking,
		modelRef: effectiveModelRef,
		modelSource: "resume-override",
		...(requestedModel ? { requestedModelOverride: requestedModel } : {}),
		...(requestedThinking ? { requestedThinkingOverride: requestedThinking } : {}),
	};
}

export function mergeResumeInvocationMetadata(
	launchMetadata: PersistedSubagentLaunchMetadata,
	laterMetadata: PersistedSubagentLaunchMetadata,
): PersistedSubagentLaunchMetadata {
	return {
		...launchMetadata,
		...laterMetadata,
		// A child can append metadata to its own session. Keep grant authority
		// anchored to the first launch entry while allowing later entries to
		// carry legitimate invocation changes such as model and thinking.
		spawnBudget: launchMetadata.spawnBudget,
		spawnableAgents: launchMetadata.spawnableAgents,
		denyTools: launchMetadata.denyTools,
	};
}
