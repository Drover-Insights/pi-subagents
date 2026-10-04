/** Supported public entrypoint of the trusted extension launch seam. */
export {
	TRUSTED_LAUNCH_REGISTRY_KEY,
	TRUSTED_LAUNCH_VERSION,
	type TrustedLaunchMode,
	type TrustedLaunchRejection,
	type TrustedLaunchRequestV1,
	type TrustedLaunchResultV1,
	type TrustedSubagentsDescriptor,
	type TrustedSubagentsResolution,
} from "./contract.ts";
export { resolveTrustedSubagents } from "./registry.ts";
