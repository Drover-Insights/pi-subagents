/** A fake Pi extension host that records the tools an extension registers, for driving brokered tools as Pi does. */
import { installToolBroker } from "../../src/broker/tools.ts";

export type ToolResult = { content: { type: string; text?: string }[] };
export type Tool = {
	name: string;
	description: string;
	renderCall?: unknown;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
};

export type ToolInfo = { name: string; description: string; sourceInfo: { path: string; source: string } };

export function fakePi(activeTools: string[] = [], extraTools: ToolInfo[] = []) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	let active = [...activeTools];
	const pi = {
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getAllTools: (): ToolInfo[] => [
			...[...tools.values()]
				.filter((tool) => !extraTools.some((extra) => extra.name === tool.name))
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					sourceInfo: { path: "/ext/subagent-done.ts", source: "local" },
				})),
			...extraTools,
		],
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	};
	return { pi, tools, handlers, active: () => active };
}

export function install(env: Record<string, string>) {
	const fake = fakePi();
	installToolBroker(fake.pi as never, env);
	return fake;
}

export function text(result: ToolResult): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}
