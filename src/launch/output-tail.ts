/** Characters of a background child's stdout or stderr the parent keeps. */
export const OUTPUT_TAIL_LIMIT = 4000;

/** Append a child output chunk and keep only the last `OUTPUT_TAIL_LIMIT` characters. */
export function rememberOutputTail(current: string | undefined, chunk: Buffer | string): string {
	return `${current ?? ""}${chunk.toString()}`.slice(-OUTPUT_TAIL_LIMIT);
}
