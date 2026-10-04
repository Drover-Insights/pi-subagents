import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import { validateTrustedResumeAuthority } from "../../src/trusted-launch/resume-authority.ts";
import { assert, createTestDir } from "../support/index.ts";
import { trustedSessionFixture } from "../support/trusted-sessions.ts";

describe("trusted resume authority", () => {
	it("accepts a session whose persisted directory still matches its launch", () => {
		const fixture = trustedSessionFixture();
		const result = validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.cwd, fixture.cwd);
		assert.deepEqual(result.metadata.trustedLaunch, fixture.provenance);
		assert.equal(result.metadata.name, "task-worker");
	});

	it("accepts a session launched by an earlier descriptor generation", () => {
		const fixture = trustedSessionFixture({ generation: "generation-before-restart" });
		const result = validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected);
		assert.equal(result.ok, true);
	});

	function assertRefused(
		result: ReturnType<typeof validateTrustedResumeAuthority>,
		reason: string,
	): void {
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, reason, result.message);
	}

	it("refuses a missing session file", () => {
		const fixture = trustedSessionFixture();
		rmSync(fixture.sessionFile);
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "session_not_found");
	});

	it("refuses a session that no trusted extension launched", () => {
		const fixture = trustedSessionFixture({ trusted: false });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "not_trusted");
	});

	it("refuses provenance from an unsupported descriptor version", () => {
		const fixture = trustedSessionFixture({ version: "pi-subagents.trusted-launch/v0" });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "unsupported_provenance");
	});

	it("refuses a resume that names another launch request", () => {
		const fixture = trustedSessionFixture();
		assertRefused(
			validateTrustedResumeAuthority(fixture.sessionFile, { ...fixture.expected, launchRequestId: "op_other" }),
			"launch_request_mismatch",
		);
	});

	it("refuses a session that gained a later launch metadata entry", () => {
		const elsewhere = createTestDir();
		const fixture = trustedSessionFixture({ laterEntryCwd: elsewhere });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "metadata_divergent");
	});

	it("refuses a caller directory that differs from the persisted one", () => {
		const fixture = trustedSessionFixture();
		assertRefused(
			validateTrustedResumeAuthority(fixture.sessionFile, { ...fixture.expected, effectiveCwd: createTestDir() }),
			"effective_cwd_mismatch",
		);
	});

	it("refuses a session header recorded in another directory", () => {
		const fixture = trustedSessionFixture({ headerCwd: createTestDir() });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "session_identity_mismatch");
	});

	it("refuses a directory that was moved away", () => {
		const fixture = trustedSessionFixture();
		renameSync(fixture.cwd, `${fixture.cwd}-moved`);
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_missing");
	});

	it("refuses a directory that was removed", () => {
		const fixture = trustedSessionFixture();
		rmSync(fixture.cwd, { recursive: true });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_missing");
	});

	it("refuses a directory replaced by a file", () => {
		const fixture = trustedSessionFixture();
		rmSync(fixture.cwd, { recursive: true });
		writeFileSync(fixture.cwd, "");
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_invalid");
	});

	it("refuses a directory replaced by a symlink that escapes elsewhere", () => {
		const fixture = trustedSessionFixture();
		const elsewhere = createTestDir();
		rmSync(fixture.cwd, { recursive: true });
		symlinkSync(elsewhere, fixture.cwd);
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_noncanonical");
	});

	it("refuses a persisted directory that is not canonical", () => {
		const root = createTestDir();
		const real = join(root, "real");
		mkdirSync(real);
		symlinkSync(real, join(root, "link"));
		const fixture = trustedSessionFixture({ cwd: join(root, "link") });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_noncanonical");
	});

	it("refuses a relative persisted directory", () => {
		const fixture = trustedSessionFixture({ cwd: "relative/dir" });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_invalid");
	});

	it("refuses a directory with a path component replaced by a file", () => {
		const fixture = trustedSessionFixture();
		const nested = join(fixture.cwd, "nested");
		mkdirSync(nested);
		const nestedFixture = trustedSessionFixture({ cwd: nested });
		rmSync(fixture.cwd, { recursive: true });
		writeFileSync(fixture.cwd, "");
		assertRefused(
			validateTrustedResumeAuthority(nestedFixture.sessionFile, nestedFixture.expected),
			"effective_cwd_missing",
		);
	});

	it("refuses a directory replaced by a symlink loop", () => {
		const fixture = trustedSessionFixture();
		rmSync(fixture.cwd, { recursive: true });
		symlinkSync(fixture.cwd, fixture.cwd);
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_noncanonical");
	});

	it("refuses a session whose agent blocks a resume after its timeout", () => {
		const fixture = trustedSessionFixture();
		writeSubagentTimeoutSidecar(fixture.sessionFile, { kind: "timeout", blocksResume: true });
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "resume_denied");
	});

	it("refuses a session holding a line it cannot parse as damaged, not untrusted", () => {
		const fixture = trustedSessionFixture();
		appendFileSync(fixture.sessionFile, "{\"type\":\"custom\",\"customType\":\n");
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "metadata_divergent");
	});

	it("refuses a later launch metadata entry the strict reader would skip", () => {
		const fixture = trustedSessionFixture();
		appendFileSync(
			fixture.sessionFile,
			`${JSON.stringify({ type: "custom", customType: "pi-subagents_launch_metadata", data: { version: 2, cwd: "/" } })}\n`,
		);
		assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "metadata_divergent");
	});

	it("refuses a session file named through a symlink", () => {
		const fixture = trustedSessionFixture();
		const alias = join(createTestDir(), "alias.jsonl");
		symlinkSync(fixture.sessionFile, alias);
		assertRefused(validateTrustedResumeAuthority(alias, fixture.expected), "session_identity_mismatch");
	});

	it("refuses a session file it cannot read", { skip: process.getuid?.() === 0 }, () => {
		const fixture = trustedSessionFixture();
		chmodSync(fixture.sessionFile, 0o000);
		try {
			assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "session_not_found");
		} finally {
			chmodSync(fixture.sessionFile, 0o644);
		}
	});

	it("refuses a directory whose access was revoked", { skip: process.getuid?.() === 0 }, () => {
		const fixture = trustedSessionFixture();
		chmodSync(fixture.cwd, 0o000);
		try {
			assertRefused(validateTrustedResumeAuthority(fixture.sessionFile, fixture.expected), "effective_cwd_revoked");
		} finally {
			chmodSync(fixture.cwd, 0o755);
		}
	});
});
