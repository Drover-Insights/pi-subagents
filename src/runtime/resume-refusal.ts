import type { TrustedResumeRejection } from "../trusted-launch/contract.ts";

/** A resume refused before any child process or surface was created. */
export class ResumeRefusal extends Error {
	readonly reason: TrustedResumeRejection | "trusted_session";
	constructor(reason: TrustedResumeRejection | "trusted_session", message: string) {
		super(message);
		this.name = "ResumeRefusal";
		this.reason = reason;
	}
}
