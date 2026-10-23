/**
 * Loaded by the parent only. Registers the scripted driver under the provider
 * the consumer child inherits (`FIXTURE_DRIVER_PROVIDER/FIXTURE_DRIVER_MODEL`),
 * so the parent runs on that model ref while the child resolves the same ref
 * through its own extensions. Requests reach the driver's chat-completions route.
 */
export default function parentDriver(pi: { registerProvider(name: string, config: Record<string, unknown>): void }) {
	const provider = process.env.FIXTURE_DRIVER_PROVIDER;
	const model = process.env.FIXTURE_DRIVER_MODEL;
	const baseUrl = process.env.FIXTURE_DRIVER_BASEURL;
	if (!provider || !model || !baseUrl) throw new Error("parent driver needs FIXTURE_DRIVER_PROVIDER, _MODEL and _BASEURL");
	pi.registerProvider(provider, {
		name: "Fixture parent driver",
		baseUrl,
		apiKey: "fixture-parent-key",
		api: "openai-completions",
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [{ id: model, name: model, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
	});
}
