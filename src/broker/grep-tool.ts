/**
 * The brokered grep tool. Pi's own grep spawns ripgrep in the calling
 * process, so this keeps Pi's grep definition (schema, renderers) and replaces
 * `execute` with the same algorithm running ripgrep inside the sandbox.
 */
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
	createGrepToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type { BrokerMode } from "./sandbox-plan.ts";
import {
	type BrokerScope,
	requireSearchBinary,
	sandboxIsDirectory,
	sandboxReadText,
	sandboxRun,
} from "./tool-operations.ts";

const DEFAULT_LIMIT = 100;
/** Pi's GREP_MAX_LINE_LENGTH, which its root barrel does not export. */
const GREP_MAX_LINE_LENGTH = 500;

type GrepResult = { content: { type: "text"; text: string }[]; details: GrepToolDetails | undefined };
type Match = { filePath: string; lineNumber: number; lineText?: string };

/** Pi's resolveToCwd: unicode spaces, `@` prefix, `~`, `file://`, then cwd. */
function resolveToolPath(input: string, cwd: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (path.startsWith("file://")) path = fileURLToPath(path);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function aborted(): Error {
	return new Error("Operation aborted");
}

async function runGrep(scope: BrokerScope, cwd: string, input: GrepToolInput, signal?: AbortSignal): Promise<GrepResult> {
	if (signal?.aborted) throw aborted();
	requireSearchBinary("rg");
	const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = input;
	const searchPath = resolveToolPath(searchDir || ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = await sandboxIsDirectory(scope, cwd, searchPath);
	} catch (error) {
		if (signal?.aborted) throw aborted();
		if (error instanceof Error && error.message.startsWith("tool broker:")) throw error;
		throw new Error(`Path not found: ${searchPath}`);
	}
	const contextValue = context && context > 0 ? context : 0;
	const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

	const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
	if (ignoreCase) args.push("--ignore-case");
	if (literal) args.push("--fixed-strings");
	if (glob) args.push("--glob", glob);
	args.push("--", pattern, searchPath);
	// Output streams so the search stops at the match limit, as Pi's grep does.
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const matches: Match[] = [];
	const stderrChunks: Buffer[] = [];
	let matchLimitReached = false;
	let pending = "";
	const decoder = new StringDecoder("utf8");
	const onLine = (line: string) => {
		if (!line.trim() || matchLimitReached) return;
		let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type !== "match") return;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
		if (matches.length >= effectiveLimit) {
			matchLimitReached = true;
			stop.abort();
		}
	};
	let result: Awaited<ReturnType<typeof sandboxRun>>;
	try {
		result = await sandboxRun(scope, cwd, args, {
			signal: stop.signal,
			onData: (chunk, stream) => {
				if (stream === "stderr") {
					stderrChunks.push(chunk);
					return;
				}
				const lines = (pending + decoder.write(chunk)).split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			},
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
	onLine(pending + decoder.end());
	if (signal?.aborted) throw aborted();
	if (!matchLimitReached && result.exitCode !== 0 && result.exitCode !== 1) {
		throw new Error(Buffer.concat(stderrChunks).toString().trim() || `ripgrep exited with code ${result.exitCode}`);
	}
	if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const formatPath = (filePath: string) => {
		if (isDirectory) {
			const rel = relative(searchPath, filePath);
			if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
		}
		return basename(filePath);
	};
	let linesTruncated = false;
	const truncated = (text: string) => {
		const { text: out, wasTruncated } = truncateLine(text);
		if (wasTruncated) linesTruncated = true;
		return out;
	};
	const fileCache = new Map<string, string[]>();
	const fileLines = async (filePath: string) => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = await sandboxReadText(scope, cwd, filePath);
				lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};

	const outputLines: string[] = [];
	for (const match of matches) {
		if (signal?.aborted) throw aborted();
		const relativePath = formatPath(match.filePath);
		if (contextValue === 0 && match.lineText !== undefined) {
			const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			outputLines.push(`${relativePath}:${match.lineNumber}: ${truncated(sanitized)}`);
			continue;
		}
		const lines = await fileLines(match.filePath);
		if (!lines.length) {
			outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
		const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
		for (let current = start; current <= end; current++) {
			const text = truncated((lines[current - 1] ?? "").replace(/\r/g, ""));
			outputLines.push(
				current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`,
			);
		}
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/** Pi's grep definition whose search runs inside the sandbox. */
export function createBrokeredGrepDefinition(mode: BrokerMode): ReturnType<typeof createGrepToolDefinition> {
	const base = createGrepToolDefinition(process.cwd());
	const execute: typeof base.execute = (_toolCallId, params, signal, _onUpdate, ctx) =>
		runGrep({ mode, ...(signal ? { signal } : {}) }, ctx?.cwd || process.cwd(), params, signal);
	return { ...base, execute };
}
