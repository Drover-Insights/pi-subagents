/**
 * Generic-suite scenarios for the provider-extension qualification.
 * A scenario supplies the agent definition, the legacy configuration state,
 * the parent's scripted tool calls (optionally in several parent processes),
 * and a judge over the cell's observations. Judges live in `judges.mjs`.
 */
import { join } from "node:path";
import { cellExtension } from "./cell.mjs";
import {
	expectNativeSuccess,
	expectLegacySuccess,
	expectChildStartupFailure,
	expectParentStartupRefused,
	expectRefusedBeforeSpawn,
	expectResumeRefused,
	expectStaticSuccess,
} from "./judges.mjs";

export const AGENT = "qual-child";
const LEGACY = "claude-primary";
const ANTHROPIC = "anthropic/claude-haiku-4-5";
const ANTHROPIC_ALT = "anthropic/claude-sonnet-4-5";
const CODEX = "openai-codex/gpt-5.5";

function definition(mode, fields) {
	return {
		fields: {
			name: AGENT,
			description: "Provider-extension qualification child.",
			mode: mode === "interactive" ? "interactive" : "background",
			"auto-exit": "true",
			"no-context-files": "true",
			skills: "none",
			tools: "read",
			...fields,
		},
	};
}

function definitionFile(cellDir, fields) {
	const lines = ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---", "", "Reply.", ""];
	return { write: join(cellDir, "agent", "agents", `${AGENT}.md`), content: lines.join("\n") };
}

const launch = (extra = {}) => ({
	tool: "subagent",
	arguments: { agent: AGENT, name: "qual-child", title: "Qualification child", task: "Reply once.", ...extra },
});
const resume = (extra = {}, before = []) => ({
	tool: "subagent_resume",
	arguments: { sessionFile: "{{lastSessionFile}}", task: "Reply again.", ...extra },
	before,
});

/** Launch, plus a plain resume in resume mode. */
const steps = (mode, before = []) => (mode === "resume" ? [launch(), resume({}, before)] : [launch()]);

function conditional(cellDir, extra = {}) {
	return {
		extensions: cellExtension(cellDir, "unconditional-marker.ts"),
		"provider-extensions": `${LEGACY}=${cellExtension(cellDir, "legacy-provider.ts")}`,
		...extra,
	};
}

const legacyConfigPath = (cellDir) => join(cellDir, "legacy-config.json");
const legacyConfig = (extra = {}) => JSON.stringify({ baseUrl: "http://127.0.0.1:{{port}}/legacy", ...extra });

const native = (name, model, config) => ({
	name,
	modes: ["background", "interactive", "resume"],
	setup: ({ mode, fixtures }) => ({
		definition: definition(mode, conditional(fixtures, { model })),
		legacyConfig: config,
		steps: steps(mode),
	}),
	judge: expectNativeSuccess(model),
});

const SCENARIOS = [
	native("native-anthropic-unset", ANTHROPIC, "unset"),
	native("native-anthropic-absent", ANTHROPIC, "absent"),
	native("native-codex-unset", CODEX, "unset"),
	native("native-codex-absent", CODEX, "absent"),
	{
		name: "legacy-success",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: "valid",
			steps: steps(mode),
		}),
		judge: expectLegacySuccess(),
	},
	{
		// On resume the configuration disappears between turns.
		name: "legacy-missing-config",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: mode === "resume" ? "valid" : "absent",
			steps: steps(mode, [{ remove: legacyConfigPath(fixtures) }]),
		}),
		judge: expectChildStartupFailure(/configuration file is unavailable/),
	},
	{
		name: "legacy-unusable-config",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: mode === "resume" ? "valid" : "unusable",
			steps: steps(mode, [{ write: legacyConfigPath(fixtures), content: JSON.stringify({ note: "no baseUrl" }) }]),
		}),
		judge: expectChildStartupFailure(/configuration has no baseUrl/),
	},
	{
		// The provider extension loads but registers another provider, so the selected one cannot resolve.
		name: "unresolvable-provider",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => {
			const rename = [{ write: legacyConfigPath(fixtures), content: legacyConfig({ provider: "claude-renamed" }) }];
			return {
				definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
				legacyConfig: "valid",
				steps: mode === "resume" ? [launch(), resume({}, rename)] : [{ ...launch(), before: rename }],
			};
		},
		judge: expectChildStartupFailure(/Unknown provider "claude-primary"/, { requiredLoad: "fixture-legacy-provider" }),
	},
	{
		// The matching conditional extension fails to load; on resume it starts failing between turns.
		name: "extension-load-failure",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => {
			const target = cellExtension(fixtures, mode === "resume" ? "unconditional-marker-copy.ts" : "failing-extension.ts");
			return {
				definition: definition(mode, {
					model: ANTHROPIC,
					extensions: cellExtension(fixtures, "unconditional-marker.ts"),
					"provider-extensions": `anthropic=${target}`,
				}),
				legacyConfig: "unset",
				steps: steps(mode, [
					{ write: target, content: 'export default function () { throw new Error("Fixture extension failed to load on purpose."); }\n' },
				]),
				copies: mode === "resume" ? [["unconditional-marker.ts", "unconditional-marker-copy.ts"]] : [],
			};
		},
		judge: expectChildStartupFailure(/failed to load on purpose/),
	},
	{
		name: "refuse-bare-model",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: "opus" })),
			legacyConfig: "valid",
			steps: [launch()],
		}),
		judge: expectRefusedBeforeSpawn(/provider-extensions needs a qualified provider\/model/),
	},
	{
		name: "refuse-flags",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus`, flags: "--verbose" })),
			legacyConfig: "valid",
			steps: [launch()],
		}),
		judge: expectRefusedBeforeSpawn(/provider-extensions must not set flags/),
	},
	{
		name: "refuse-malformed",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode }) => ({
			definition: definition(mode, { model: `${LEGACY}/opus`, "provider-extensions": "claude-*=./x.ts" }),
			legacyConfig: "valid",
			steps: [launch()],
		}),
		judge: expectParentStartupRefused(/provider-extensions provider "claude-\*"/),
	},
	{
		name: "static-definition",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, { model: ANTHROPIC, extensions: cellExtension(fixtures, "unconditional-marker.ts") }),
			legacyConfig: "absent",
			steps: steps(mode),
		}),
		judge: expectStaticSuccess(ANTHROPIC, ["fixture-unconditional-marker"]),
	},
	{
		name: "static-all-extensions",
		modes: ["background", "interactive", "resume"],
		setup: ({ mode }) => ({
			definition: definition(mode, { model: ANTHROPIC }),
			legacyConfig: "unset",
			steps: steps(mode),
		}),
		judge: expectStaticSuccess(ANTHROPIC, ["fixture-ambient"]),
	},
	{
		name: "resume-override-other-provider",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus`, "allowed-models": ANTHROPIC })),
			legacyConfig: "valid",
			steps: [launch(), resume({ model: ANTHROPIC })],
		}),
		judge: expectResumeRefused(/not on its recorded provider "claude-primary"/),
	},
	{
		name: "resume-override-locked",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus`, "allow-model-override": "false" })),
			legacyConfig: "valid",
			steps: [launch(), resume({ model: ANTHROPIC })],
		}),
		judge: expectLegacySuccess(),
	},
	{
		name: "resume-override-same-provider",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: ANTHROPIC, "allowed-models": ANTHROPIC_ALT })),
			legacyConfig: "unset",
			steps: [launch(), resume({ model: ANTHROPIC_ALT })],
		}),
		judge: expectNativeSuccess(ANTHROPIC, { resumedModel: ANTHROPIC_ALT }),
	},
	{
		// A forged later entry and a changed definition try to move the session to another provider.
		name: "resume-drift-provider",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: "valid",
			steps: [
				launch(),
				resume({}, [
					{ appendMetadata: "{{lastSessionFile}}", merge: { model: ANTHROPIC, modelRef: ANTHROPIC } },
					definitionFile(fixtures, { name: AGENT, model: ANTHROPIC, mode: "background" }),
				]),
			],
		}),
		judge: expectResumeRefused(/not on its recorded provider "claude-primary"/),
	},
	{
		// A forged later entry widens resources on the same provider, and the definition changes; resume keeps the original.
		name: "resume-drift-resources",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: "valid",
			steps: [
				launch(),
				resume({}, [
					{
						appendMetadata: "{{lastSessionFile}}",
						merge: {
							extensions: [cellExtension(fixtures, "unconditional-marker.ts"), cellExtension(fixtures, "legacy-provider.ts"), join(fixtures, "agent", "extensions", "ambient.ts")],
							providerExtensionAuthority: { provider: LEGACY, extensions: [join(fixtures, "agent", "extensions", "ambient.ts")] },
						},
					},
					definitionFile(fixtures, { name: AGENT, model: ANTHROPIC, mode: "background", extensions: "all" }),
				]),
			],
		}),
		judge: expectLegacySuccess(),
	},
	{
		name: "resume-missing-authority",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, conditional(fixtures, { model: `${LEGACY}/opus` })),
			legacyConfig: "valid",
			steps: [launch(), resume({}, [{ rewriteFirstMetadata: "{{lastSessionFile}}", merge: { providerExtensionAuthority: { provider: LEGACY } } }])],
		}),
		judge: expectResumeRefused(/authority is missing or malformed/),
	},
	{
		// The child inherits the parent's model; a later parent on another provider resumes it.
		name: "resume-parent-change",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, {
				extensions: cellExtension(fixtures, "unconditional-marker.ts"),
				"provider-extensions": `fixture-parent=${cellExtension(fixtures, "legacy-provider.ts")}`,
			}),
			legacyConfig: "unset",
			phases: [
				{ parentModel: "fixture-parent/driver", steps: [launch()] },
				{ parentModel: "fixture-parent-b/driver", steps: [resume()] },
			],
		}),
		judge: expectNativeSuccess("fixture-parent/driver", { route: "parent", expectedLoads: ["fixture-unconditional-marker", "fixture-legacy-provider"] }),
	},
	{
		// A session launched without the feature keeps its saved behavior after the definition opts in.
		name: "resume-non-opt-in",
		modes: ["resume"],
		setup: ({ mode, fixtures }) => ({
			definition: definition(mode, { model: ANTHROPIC, extensions: cellExtension(fixtures, "unconditional-marker.ts") }),
			legacyConfig: "valid",
			steps: [
				launch(),
				resume({}, [
					definitionFile(fixtures, {
						name: AGENT,
						model: `${LEGACY}/opus`,
						mode: "background",
						"provider-extensions": `${LEGACY}=${cellExtension(fixtures, "legacy-provider.ts")}`,
					}),
				]),
			],
		}),
		judge: expectStaticSuccess(ANTHROPIC, ["fixture-unconditional-marker"]),
	},
];

export function scenariosFor(options) {
	const selected = SCENARIOS.filter(
		(scenario) =>
			scenario.modes.includes(options.mode) && (options.scenarios.length === 0 || options.scenarios.includes(scenario.name)),
	);
	return selected.map((scenario) => ({
		...scenario,
		setup: (context) => scenario.setup({ ...context, mode: options.mode, suite: options.suite }),
	}));
}
