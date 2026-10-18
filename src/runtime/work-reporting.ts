import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrWorkReporter } from "../mux/herdr-work.ts";
import { outstandingWork } from "./outstanding-work.ts";

/**
 * How far the advisory report reached: `degraded` while the latest write was
 * not acknowledged, `unknown` when the final clear was not, so stale metadata
 * may stay until its TTL expires.
 */
export type ReportDelivery = "pending" | "delivered" | "degraded" | "unknown";

/** Optional transport for session-scoped delegated-work facts, never native agent status. */
export interface WorkReporter {
	publish(count: number): Promise<void>;
	stop(): Promise<void>;
	delivery(): ReportDelivery;
	/** Call `listener` on every delivery change, including those of writes the reporter makes on its own. */
	watchDelivery?(listener: (state: ReportDelivery) => void): void;
}

/** Bind reporting to Pi lifecycle without creating resources in the extension factory. */
export function registerOutstandingWorkReporting(
	pi: ExtensionAPI,
	connect: (ctx: ExtensionContext) => Promise<WorkReporter | undefined> = (ctx) => createHerdrWorkReporter(ctx),
	onDelivery: (state: ReportDelivery) => void = () => {},
) {
	let reported: ReportDelivery = "pending";
	// Advisory telemetry: each change of its delivery state is surfaced, never acted on.
	function reportDelivery(): void {
		const state = reporter?.delivery();
		if (state === undefined || state === reported) return;
		reported = state;
		onDelivery(state);
	}
	let ready: Promise<void> = Promise.resolve();
	let reporter: WorkReporter | undefined;
	let unsubscribe: (() => void) | undefined;
	let stopped = true;
	let pending: Promise<void> = Promise.resolve();

	function publish(): Promise<void> {
		// Read the current count when this serialized write runs, not when queued.
		pending = pending.then(async () => {
			if (!stopped) await reporter?.publish(outstandingWork.count);
			reportDelivery();
		}).catch(() => {});
		return pending;
	}

	async function flush(): Promise<void> {
		await ready;
		await publish();
		reportDelivery();
	}

	pi.on("tool_result", async () => { await flush(); });
	pi.on("context", (event) => { if (!stopped) outstandingWork.consume(event.messages); });
	pi.on("agent_settled", async (_event, ctx) => {
		if (!stopped && ctx.isIdle()) outstandingWork.settle();
		await flush();
	});

	return {
		start(ctx: ExtensionContext): Promise<void> {
			stopped = false;
			unsubscribe = outstandingWork.subscribe(() => { void publish(); });
			ready = connect(ctx).then(async (connected) => {
				if (stopped) { await connected?.stop(); return; }
				reporter = connected;
				if (!reporter) { unsubscribe?.(); outstandingWork.reset(); return; }
				reporter.watchDelivery?.(() => reportDelivery());
				await publish();
			}).catch(() => { unsubscribe?.(); outstandingWork.reset(); });
			return ready;
		},
		async stop(): Promise<void> {
			stopped = true;
			unsubscribe?.();
			unsubscribe = undefined;
			await ready;
			await pending;
			await reporter?.stop();
			reportDelivery();
			reporter = undefined;
			reported = "pending";
			outstandingWork.reset();
		},
	};
}
