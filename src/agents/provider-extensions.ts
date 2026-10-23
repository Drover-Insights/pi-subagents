/** One `provider-extensions` entry: load `source` only when the child's provider is `provider`. */
export interface ProviderExtensionEntry {
	provider: string;
	source: string;
}

/**
 * Parse `provider-extensions` frontmatter: one `<provider>=<source>` per
 * nonblank line, split on the first `=`. Fails closed: a malformed declaration
 * fails agent loading rather than silently dropping a conditional extension.
 */
export function parseProviderExtensions(
	raw: string | undefined,
	present: boolean,
	path: string,
): ProviderExtensionEntry[] | undefined {
	if (!present) return undefined;
	const fail = (reason: string): never => {
		throw new Error(`provider-extensions ${reason} in ${path}.`);
	};
	const lines = (raw ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) fail("must declare at least one <provider>=<source> entry");
	return lines.map((line) => {
		const eq = line.indexOf("=");
		if (eq === -1) fail(`entry ${JSON.stringify(line)} must be <provider>=<source>`);
		const provider = line.slice(0, eq).trim();
		const source = line.slice(eq + 1).trim();
		if (!provider || !source) fail(`entry ${JSON.stringify(line)} needs a nonempty provider and source`);
		if (/[/\s*?,=]/.test(provider)) {
			fail(`provider ${JSON.stringify(provider)} must be an exact provider name (no "/", whitespace, "*", "?", ",", "=")`);
		}
		if (source.includes(",")) fail(`source ${JSON.stringify(source)} must be a single extension source (no ",")`);
		const lowered = source.toLowerCase();
		if (lowered === "all" || lowered === "none") {
			fail(`source ${JSON.stringify(source)} must be an extension source, not "${lowered}"`);
		}
		return { provider, source };
	});
}
