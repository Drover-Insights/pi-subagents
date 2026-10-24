import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChildSessionStorage } from "../../src/session/child-session-storage.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import {
	ASSISTANT_MSG,
	assert,
	createTestDir,
	describe,
	getEntries,
	it,
	join,
	MODEL_CHANGE,
	readFileSync,
	SESSION_HEADER,
	USER_MSG,
	writeFileSync,
} from "../support/index.ts";

function launchMetadata(cwd: string): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: "2026-06-01T00:00:00.000Z",
		name: "child-audit",
		title: "Child audit",
		sessionTitle: "[scout] Child audit",
		agent: "scout",
		mode: "background",
		sessionMode: "fork",
		parentClosePolicy: "terminate",
		async: true,
		model: "provider/model",
		thinking: "high",
		modelRef: "provider/model:high",
		allowModelOverride: true,
		modelSource: "launch-override",
		tools: "read,bash",
		skills: "none",
		denyTools: ["bash"],
		extensions: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: cwd,
		cwd,
		boundarySystemPrompt: true,
	};
}

describe("child session storage", () => {
	it("seeds a child session and persists launch facts through one module", async () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const storage = new ChildSessionStorage(child);
		const metadata = launchMetadata(dir);

		storage.seed("fork", parent, dir, {
			sessionName: metadata.sessionTitle,
			activeLeafId: "asst-001",
		});
		storage.writeModelState(metadata);
		await storage.writeLaunchMetadataWhenReady(metadata, 0);
		storage.writeExtensionEntry(metadata.extensions);

		const entries = getEntries(child) as Array<Record<string, unknown>>;
		assert.equal(entries[0].type, "session");
		assert.equal(entries[0].parentSession, parent);
		assert.equal(entries[0].name, metadata.sessionTitle);
		assert.equal(
			entries.some((entry) => entry.type === "model_change"),
			true,
		);
		assert.equal(
			entries.some((entry) => entry.type === "thinking_level_change"),
			true,
		);
		assert.deepEqual(storage.readLaunchMetadata(), metadata);
		assert.deepEqual(storage.readExtensionEntry(), []);
	});

	it("strips inherited subagent rosters from fork seeds", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent-roster.jsonl");
		const child = join(dir, "child-roster.jsonl");
		const roster = {
			type: "custom_message",
			customType: "subagent_roster",
			id: "roster-001",
			parentId: "asst-001",
			content: "hidden agent names",
		};
		writeFileSync(
			parent,
			`${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG, roster].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);

		new ChildSessionStorage(child).seed("fork", parent, dir, { activeLeafId: roster.id });

		const seeded = readFileSync(child, "utf8");
		assert.doesNotMatch(seeded, /subagent_roster/);
		assert.doesNotMatch(seeded, /hidden agent names/);
	});

	it("keeps a parent compaction's kept turns when its first kept entry is a roster", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent-compacted.jsonl");
		const child = join(dir, "child-compacted.jsonl");
		const entries = [
			SESSION_HEADER,
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "summarized turn" } },
			{ type: "custom_message", customType: "subagent_roster", id: "r1", parentId: "m1", content: "hidden agent names" },
			{ type: "message", id: "m2", parentId: "r1", message: { role: "user", content: "kept turn" } },
			{ type: "compaction", id: "c1", parentId: "m2", summary: "compacted history", firstKeptEntryId: "r1", tokensBefore: 10 },
			{ type: "message", id: "m3", parentId: "c1", message: { role: "user", content: "after compaction" } },
		];
		writeFileSync(parent, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

		new ChildSessionStorage(child).seed("fork", parent, dir, { activeLeafId: "m3" });

		const context = SessionManager.open(child, undefined, dir).buildSessionContext();
		const texts = context.messages.map((m) => JSON.stringify(m));
		assert.ok(texts.some((t) => t.includes("kept turn")), "kept turn survives the fork seed");
		assert.ok(texts.some((t) => t.includes("after compaction")));
		assert.ok(!texts.some((t) => t.includes("hidden agent names")), "roster stays out of child context");
	});

	it("keeps a mid-branch roster's id and link as a non-context entry so no context is truncated", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent-mid.jsonl");
		const child = join(dir, "child-mid.jsonl");
		// message → roster → message → leaf: dropping the roster must not orphan the rest.
		const msg1 = { type: "message", id: "m1", parentId: null, message: { role: "user", content: "first" } };
		const roster = { type: "custom_message", customType: "subagent_roster", id: "r1", parentId: "m1", content: "x" };
		const msg2 = { type: "message", id: "m2", parentId: "r1", message: { role: "assistant", content: "second" } };
		const leaf = { type: "message", id: "m3", parentId: "m2", message: { role: "user", content: "third" } };
		writeFileSync(parent, `${[SESSION_HEADER, msg1, roster, msg2, leaf].map((e) => JSON.stringify(e)).join("\n")}\n`);

		new ChildSessionStorage(child).seed("fork", parent, dir, { activeLeafId: "m3" });

		const entries = readFileSync(child, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
		const kept = byId.get("r1");
		assert.equal(kept?.type, "custom", "roster becomes a non-context entry");
		assert.equal(kept?.parentId, "m1");
		assert.equal(kept?.content, undefined, "roster content stripped");
		assert.equal(byId.get("m2")?.parentId, "r1");
		assert.equal(byId.get("m3")?.parentId, "m2");
		// Every entry's parentId resolves to a retained entry (or null) — no dangling refs.
		for (const e of byId.values()) {
			if (e.parentId != null) assert.ok(byId.has(e.parentId), `dangling parentId ${e.parentId}`);
		}
	});
});
