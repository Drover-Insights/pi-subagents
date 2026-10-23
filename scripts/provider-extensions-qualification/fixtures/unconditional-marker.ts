/** Fixture-owned unconditional extension: records that and when it loaded. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function unconditionalMarker() {
	const evidence = process.env.QUAL_EVIDENCE_DIR;
	if (!evidence) return;
	appendFileSync(
		join(evidence, "extension-loads.jsonl"),
		`${JSON.stringify({ pid: process.pid, extension: "fixture-unconditional-marker", at: new Date().toISOString() })}\n`,
	);
}
