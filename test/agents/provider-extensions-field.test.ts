import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	loadAgentDefaults,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function loadDefinition(frontmatter: string) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	writeFileSync(join(configDir, "agents", "tester.md"), `---\nname: tester\n${frontmatter}\n---\n\nTester body.`);
	process.env.PI_CODING_AGENT_DIR = configDir;
	return loadAgentDefaults("tester");
}

describe("provider-extensions agent field", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("is absent unless the definition declares it", () => {
		assert.equal(loadDefinition("model: provider/model")?.providerExtensions, undefined);
	});

	it("reads one inline entry and ordered block entries, keeping provider case", () => {
		assert.deepEqual(loadDefinition("provider-extensions: claude-primary=npm:pi-claude-code-provider")?.providerExtensions, [
			{ provider: "claude-primary", source: "npm:pi-claude-code-provider" },
		]);
		assert.deepEqual(
			loadDefinition(
				"provider-extensions: |\n  Claude-Primary=./b.ts\n  claude-primary=git:github.com/a/b@v1\n\n  claude-primary=./a.ts",
			)?.providerExtensions,
			[
				{ provider: "Claude-Primary", source: "./b.ts" },
				{ provider: "claude-primary", source: "git:github.com/a/b@v1" },
				{ provider: "claude-primary", source: "./a.ts" },
			],
		);
	});

	it("rejects empty and malformed declarations instead of ignoring them", () => {
		const bad = [
			"provider-extensions:",
			"provider-extensions: |\n",
			"provider-extensions: claude-primary",
			"provider-extensions: =./a.ts",
			"provider-extensions: claude-primary=",
			"provider-extensions: claude/primary=./a.ts",
			"provider-extensions: claude-*=./a.ts",
			"provider-extensions: claude primary=./a.ts",
			"provider-extensions: claude-primary=./a.ts,./b.ts",
			"provider-extensions: claude-primary=all",
			"provider-extensions: claude-primary=None",
		];
		for (const frontmatter of bad) {
			assert.throws(() => loadDefinition(frontmatter), /provider-extensions/, frontmatter);
		}
	});
});
