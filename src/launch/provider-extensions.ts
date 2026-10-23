import type { AgentDefaults } from "../agents/definitions.ts";
import type { PersistedSubagentLaunchMetadata } from "../session/session-files.ts";
import { resolveSubagentExtensions, resolveSubagentExtensionSource } from "./policy.ts";

/** The provider a `provider-extensions` launch matched against, and the extension list it produced. */
export interface ProviderExtensionAuthority {
	provider: string;
	extensions: string[];
}

/** Freeform flags could swap the model after provider selection, so a declaring agent must not set them. */
export function assertNoProviderExtensionFlags(agentDefs: AgentDefaults): void {
	if (agentDefs.flags?.trim()) {
		throw new Error("An agent that declares provider-extensions must not set flags.");
	}
}

/**
 * Pins Pi's model resolution to the matched provider. Without it Pi may read
 * `provider/id` as a raw model id on another provider, or substitute a model.
 */
export function getProviderConstraintArgs(authority: ProviderExtensionAuthority | undefined): string[] {
	return authority ? ["--provider", authority.provider] : [];
}

/** Only a qualified `provider/model` names the provider to match. */
export function resolveProviderExtensionProvider(effectiveModel: string | undefined): string {
	const slash = effectiveModel?.indexOf("/") ?? -1;
	if (!effectiveModel || slash <= 0 || slash === effectiveModel.length - 1) {
		throw new Error(
			`An agent that declares provider-extensions needs a qualified provider/model (got ${JSON.stringify(effectiveModel ?? "")}).`,
		);
	}
	return effectiveModel.slice(0, slash);
}

/**
 * Unconditional extensions, then the declared sources whose provider matches
 * exactly, in declaration order, without exact duplicates. Unset or `all`
 * unconditional extensions become an empty list, so a declaring agent never
 * falls back to ambient discovery.
 */
export function selectProviderExtensionSources(agentDefs: AgentDefaults, provider: string): string[] {
	const baseDir = agentDefs.cwdBase ?? process.cwd();
	const matching = (agentDefs.providerExtensions ?? [])
		.filter((entry) => entry.provider === provider)
		.map((entry) => resolveSubagentExtensionSource(entry.source, baseDir));
	return [...new Set([...(resolveSubagentExtensions(agentDefs) ?? []), ...matching])];
}

function isAuthority(value: unknown): value is ProviderExtensionAuthority {
	if (!value || typeof value !== "object") return false;
	const { provider, extensions } = value as Partial<ProviderExtensionAuthority>;
	return (
		typeof provider === "string" &&
		provider.length > 0 &&
		!provider.includes("/") &&
		Array.isArray(extensions) &&
		extensions.every((source) => typeof source === "string")
	);
}

/**
 * Apply the original launch authority of a `provider-extensions` session to the
 * metadata a resume is about to run. Opt-in is decided by the first launch
 * entry alone: a later entry can neither opt a session in nor change what an
 * opted-in session loads. The resumed model must stay on the recorded provider.
 * Throws when the recorded authority is missing, malformed or contradicted.
 */
export function applyProviderExtensionResumeAuthority(
	first: PersistedSubagentLaunchMetadata | undefined,
	invocation: PersistedSubagentLaunchMetadata | undefined,
): PersistedSubagentLaunchMetadata | undefined {
	if (!invocation) return invocation;
	if (first?.providerExtensionAuthority === undefined) {
		if (invocation.providerExtensionAuthority === undefined) return invocation;
		const { providerExtensionAuthority: _ignored, ...rest } = invocation;
		return rest;
	}
	const authority = first.providerExtensionAuthority;
	const refuse: (reason: string) => never = (reason) => {
		throw new Error(`This session was launched with provider-extensions; ${reason}, so it cannot be resumed.`);
	};
	if (!isAuthority(authority)) refuse("its recorded provider and extension authority is missing or malformed");
	if (first.flags?.trim()) refuse("its launch metadata records freeform flags");
	const modelRef = invocation.modelRef ?? "";
	const slash = modelRef.indexOf("/");
	const provider = slash > 0 ? modelRef.slice(0, slash) : undefined;
	if (provider !== authority.provider) {
		refuse(
			`the resumed model ${JSON.stringify(modelRef)} is not on its recorded provider ${JSON.stringify(authority.provider)}`,
		);
	}
	return {
		...invocation,
		extensions: [...authority.extensions],
		providerExtensionAuthority: { provider: authority.provider, extensions: [...authority.extensions] },
		agentConfigDir: first.agentConfigDir,
		flags: undefined,
	};
}
