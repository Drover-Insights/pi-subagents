import { createHash } from "node:crypto";
import type { WorkReporter } from "../runtime/work-reporting.ts";
import { runHerdrJsonAsync } from "./herdr.ts";

const TOKEN = "pi_subagents_work_v1";
const SOURCE = "pi-subagents:work-v1";
const TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

type SessionContext = { mode: string; sessionManager: { getSessionFile(): string | undefined } };
type HerdrCall = (args: string[], env: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Open an optional reporter only inside the owning TUI pane. No socket paths or native dependencies. */
export async function createHerdrWorkReporter(
	ctx: SessionContext,
	environment: NodeJS.ProcessEnv = process.env,
	run: HerdrCall = runHerdrJsonAsync,
): Promise<WorkReporter | undefined> {
	const session = ctx.sessionManager.getSessionFile();
	const preference = environment.PI_SUBAGENT_MUX?.trim().toLowerCase();
	if (ctx.mode !== "tui" || environment.HERDR_ENV !== "1" || !environment.HERDR_PANE_ID || !session) return;
	if (preference && preference !== "herdr") return;
	// An interactive child must name its own surface; headless children cannot
	// borrow their parent's inherited pane context, even under custom flags.
	if (environment.PI_SUBAGENT_NAME && environment.PI_SUBAGENT_SURFACE !== environment.HERDR_PANE_ID) return;
	const env = { ...environment };
	try {
		const status = await run(["status", "server", "--json"], env);
		// Protocol 22 is the verified source-scoped TTL contract. Older servers
		// remain fully usable for launches, just without optional work metadata.
		if (status.running !== true || status.compatible !== true || typeof status.protocol !== "number" || status.protocol < 22) return;
		const current = await run(["pane", "current", "--current"], env);
		const pane = record(current.result) && record(current.result.pane) ? current.result.pane.pane_id : undefined;
		if (typeof pane !== "string" || !pane) return;
		return makeReporter(pane, session, (args) => run(args, env));
	} catch {
		// Optional reporting must never break Pi or child launches.
		return;
	}
}

function makeReporter(pane: string, session: string, call: (args: string[]) => Promise<unknown>): WorkReporter {
	let stopped = false;
	let stopping: Promise<void> | undefined;
	let count = 0;
	let lastCount: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending = Promise.resolve();
	// Herdr normalizes token values to 80 characters. A full SHA-256 digest
	// keeps session ownership without transporting an unbounded path.
	const sessionHash = createHash("sha256").update(session, "utf8").digest("base64url");
	const prefix = ["pane", "report-metadata", pane, "--source", SOURCE, "--ttl-ms", String(TTL_MS)];

	function enqueue(refresh = false): Promise<void> {
		pending = pending.then(async () => {
			if (stopped || (!refresh && lastCount === count)) return;
			const value = count;
			try {
				await call([...prefix, "--token", `${TOKEN}=${sessionHash}:${value}:${Date.now() + TTL_MS}`]);
				lastCount = value;
			} catch {
				// Fail open. Only an outstanding-work heartbeat retries, at most
				// once per interval; zero stops renewal and stale metadata expires.
			}
		}).catch(() => {});
		return pending;
	}

	function renew(): void {
		timer = setTimeout(() => {
			timer = undefined;
			void enqueue(true).then(() => { if (!stopped && count > 0 && !timer) renew(); });
		}, HEARTBEAT_MS);
		timer.unref?.();
	}

	return {
		publish(value) {
			if (stopped) return pending;
			count = value;
			if (count > 0 && !timer) renew();
			if (count === 0 && timer) { clearTimeout(timer); timer = undefined; }
			return enqueue();
		},
		stop() {
			if (stopping) return stopping;
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			stopping = pending.then(async () => {
				try { await call([...prefix, "--clear-token", TOKEN]); } catch {}
			});
			return stopping;
		},
	};
}
