/**
 * Fixture-owned stand-in for a configured legacy provider extension.
 * It mirrors the reference provider's startup contract without its identity:
 * - FIXTURE_LEGACY_CONFIG naming a missing file throws during the factory,
 *   before the provider registers (the original missing-configuration failure);
 * - a readable file registers its `provider` (default `claude-primary`) with its `models` (default `opus`),
 *   whose requests go to the file's loopback `baseUrl`;
 * - an unset variable registers nothing.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default function legacyProvider(pi: {
	registerProvider(name: string, config: Record<string, unknown>): void;
}) {
	const evidence = process.env.QUAL_EVIDENCE_DIR;
	if (evidence) {
		appendFileSync(
			join(evidence, "extension-loads.jsonl"),
			`${JSON.stringify({ pid: process.pid, extension: "fixture-legacy-provider", at: new Date().toISOString() })}\n`,
		);
	}
	const configPath = process.env.FIXTURE_LEGACY_CONFIG;
	if (configPath === undefined || configPath.trim() === "") return;
	if (!existsSync(configPath)) {
		throw new Error(`Fixture legacy provider configuration file is unavailable: ${configPath}`);
	}
	const config = JSON.parse(readFileSync(configPath, "utf8")) as { baseUrl?: string; models?: string[]; provider?: string };
	if (!config.baseUrl) throw new Error("Fixture legacy provider configuration has no baseUrl.");
	pi.registerProvider(config.provider ?? "claude-primary", {
		name: "Fixture legacy provider",
		baseUrl: config.baseUrl,
		apiKey: "fixture-legacy-key",
		api: "anthropic-messages",
		models: (config.models ?? ["opus"]).map((id) => ({
			id,
			name: `Fixture legacy ${id}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 4096,
		})),
	});
}
