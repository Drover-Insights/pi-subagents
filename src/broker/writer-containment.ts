/**
 * A managed writer child's containment: once its pinned worktree identity no
 * longer holds, or a tool left Git metadata in its worktree, every brokered
 * tool stays disabled for the rest of the session. The child records why
 * under the launch's containment directory, where the parent reads it before
 * releasing the lease or starting another generation.
 *
 * Writer sandboxes and the seal walk after each one run one at a time, so no
 * sandbox writes the tree while it is walked.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { PinnedWorktree, WriterIdentity } from "./env-contract.ts";
import { checkPinnedWorktree } from "./sandbox-plan.ts";
import { breachReason, containmentDirectory, sealWriterTree } from "./writer-seal.ts";

const RECORD = /^contained-g(\d+)\.json$/;
const QUARANTINE = /^quarantine-(g\d+|parent)$/;

/**
 * Why a writer was contained, one reason per record: each `contained-g<n>.json`,
 * and each quarantine that moved anything, since a crash can land between a
 * walk's move and its record. Throws when unreadable.
 */
function readContainmentRecords(pinned: PinnedWorktree, launchId: string): string[] {
	const dir = containmentDirectory(pinned, launchId);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
	const reasons: string[] = [];
	for (const name of names) {
		const record = RECORD.exec(name);
		if (record) {
			try {
				reasons.push(`generation ${record[1]}: ${(JSON.parse(readFileSync(join(dir, name), "utf8")) as { reason: string }).reason}`);
			} catch {
				// A record that exists contains its writer, even when a crash left it unreadable.
				reasons.push(`generation ${record[1]}: the containment record ${name} is unreadable`);
			}
		} else if (QUARANTINE.test(name) && readdirSync(join(dir, name)).length > 0) {
			reasons.push(`${name} holds Git metadata moved out of the worktree`);
		}
	}
	return reasons;
}

/**
 * The parent's check of a writer's worktree: why it no longer holds, or null.
 * It checks the pinned identity and the child's containment records and,
 * when `walk` is true, quarantines writer-created Git metadata. Walk only
 * once the writer's execution group is proven empty. Never throws.
 */
export function inspectWriterTree(pinned: PinnedWorktree, launchId: string, walk: boolean): string | null {
	const changed = checkPinnedWorktree(pinned.top, pinned);
	if (changed !== null) return changed;
	try {
		const records = readContainmentRecords(pinned, launchId);
		if (records.length > 0) return `the writer contained itself: ${records.join("; ")}`;
	} catch (error) {
		return `cannot read the writer's containment records: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!walk) return null;
	const seal = sealWriterTree(pinned, join(containmentDirectory(pinned, launchId), "quarantine-parent"));
	return seal.status === "breached" ? breachReason(seal) : null;
}

export class WriterContainment {
	readonly identity: WriterIdentity;
	readonly directory: string;
	private reason: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(identity: WriterIdentity) {
		this.identity = identity;
		this.directory = containmentDirectory(identity, identity.launchId);
	}

	/** Where this generation's seal walk moves writer-created Git metadata. */
	get quarantineDirectory(): string {
		return join(this.directory, `quarantine-g${this.identity.generation}`);
	}

	get contained(): boolean {
		return this.reason !== undefined;
	}

	/** The error every tool call fails with once the writer is contained. */
	error(): Error {
		return new Error(`tool broker: the writer was contained and its tools are disabled for the rest of the session: ${this.reason}`);
	}

	assertOpen(): void {
		if (this.reason !== undefined) throw this.error();
	}

	/** Run `work` after every earlier one has finished. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Contain the writer; the first reason is kept. Returns the error the calling tool throws. */
	contain(reason: string): Error {
		if (this.reason !== undefined) return this.error();
		this.reason = reason;
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			const fd = openSync(join(this.directory, `contained-g${this.identity.generation}.json`), "wx", 0o600);
			try {
				writeSync(fd, `${JSON.stringify({ reason, generation: this.identity.generation, at: new Date().toISOString() })}\n`);
			} finally {
				closeSync(fd);
			}
		} catch {
			// The latch holds either way; the parent revalidates and walks the tree itself.
		}
		return this.error();
	}
}
