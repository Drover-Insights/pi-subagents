import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reader for the canonical Drover routing contract that pi-config installs in
 * Pi's agent directory. pi-config owns the contract; this package reads it as
 * the child runtime and rejects anything it cannot enforce exactly.
 */

type RoutingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type RoutingInteractionMode = "synchronous" | "background" | "interactive";

type FixedRoute = Readonly<{
	provider: string;
	model: string;
	effort: RoutingEffort;
}>;

type RoutingRole = Readonly<{
	state: string;
	childLaunch: boolean;
	modes: readonly string[];
	allowedInteractionModes: readonly RoutingInteractionMode[];
	resourceGrant: string;
	routes: Readonly<Record<string, FixedRoute>>;
}>;

type PilotCase = Readonly<{
	role: string;
	capabilityClass: string;
	artifact: string;
	route: FixedRoute;
	resourceGrant: string;
	attempts: Readonly<{ allowed: number }>;
	retry: string;
	expires: string;
	acceptance: readonly string[];
}>;

type ExtensionIdentity = Readonly<{
	source: string;
	files: readonly Readonly<{ path: string; sha256: string }>[];
}>;

export type CanonicalRoutingPolicy = Readonly<{
	schemaVersion: number;
	generation: string;
	schemaCompatibility: Readonly<{
		controller: Readonly<{ minimum: number; maximum: number }>;
		childRuntime: Readonly<{ minimum: number; maximum: number }>;
	}>;
	defaultRole: string;
	canonicalRoles: readonly string[];
	aliases: Readonly<Record<string, string>>;
	operationalStates: readonly string[];
	capabilityClasses: Readonly<Record<string, Readonly<Record<string, never>>>>;
	interactionModes: readonly RoutingInteractionMode[];
	resourceGrants: Readonly<Record<string, Readonly<{ skills: readonly string[]; projectResources: boolean }>>>;
	roles: Readonly<Record<string, RoutingRole>>;
	pilotCases: Readonly<Record<string, PilotCase>>;
	extensionCatalog: Readonly<Record<string, ExtensionIdentity>>;
	mandatoryExtensions: readonly string[];
	extensionGrants: Readonly<Record<string, readonly string[]>>;
	guardrails: Readonly<{
		allowProviderFallback: false;
		allowRouteNormalization: false;
		allowRecursiveSpawning: false;
		allowMaxEffort: false;
		allowInteractiveLaunch: false;
	}>;
}>;

export type CanonicalPolicyState =
	| { status: "absent" }
	| { status: "invalid"; message: string }
	| { status: "loaded"; policy: CanonicalRoutingPolicy };

const CANONICAL_POLICY_FILE = "drover-model-routing.json";

/** Schema versions this package can enforce as the child runtime. */
const CHILD_RUNTIME_SCHEMA_MINIMUM = 3;
const CHILD_RUNTIME_SCHEMA_MAXIMUM = 3;

const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ROUTE_COMPONENT = /^[a-z0-9][a-z0-9.-]*$/;
const EFFORTS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);
/** The tier guardrails.allowMaxEffort gates. Pi names it xhigh, not max. */
const MAX_EFFORT = "xhigh";
const INTERACTION_MODES = new Set<string>(["synchronous", "background", "interactive"]);
/** The role states launch authorization knows how to enforce. */
const OPERATIONAL_STATES = ["disabled", "pilot", "selective", "automated"];
/** Skill words the launcher reads as selection grammar rather than a Skill name. */
const RESERVED_SKILL_NAMES = new Set(["all", "none"]);
const GIT_SOURCE = /^git:github\.com\/((?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?@)[A-Za-z0-9_.-]+)@[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** The child route guard: without it a child loses its fixed-route admission check. */
const ROUTE_GUARD_EXTENSION = "drover-model-routing";
/** The package that provides subagent spawning; no child role may be granted it. */
const SPAWNING_REPOSITORY = "drover-insights/pi-subagents";
/** The safety resources every child loads, in order, with the source each must come from. */
const MANDATORY_EXTENSIONS = [
	["subagent-completion", SPAWNING_REPOSITORY],
	["workspace-boundary", "pi-config"],
] as const;

/** Read the canonical policy from `agentDir`; never throws. */
export function loadCanonicalPolicy(agentDir: string): CanonicalPolicyState {
	let text: string;
	try {
		text = readFileSync(join(agentDir, CANONICAL_POLICY_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
		return { status: "invalid", message: `Routing policy is unreadable: ${(error as Error).message}` };
	}
	try {
		return { status: "loaded", policy: parseCanonicalPolicy(JSON.parse(text) as unknown) };
	} catch (error) {
		return { status: "invalid", message: (error as Error).message };
	}
}

/** The GitHub repository a source names, as GitHub resolves it, or pi-config. */
function sourceRepository(source: string): string {
	if (source === "pi-config") return source;
	return (GIT_SOURCE.exec(source)?.[1] ?? "").toLowerCase().replace(/\.git$/, "");
}

function safePath(path: unknown): boolean {
	return (
		typeof path === "string" &&
		path.split("/").every((segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== "..")
	);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedFields = new Set(allowed);
	for (const field of Object.keys(value)) {
		if (!allowedFields.has(field)) throw new Error(`${label} has unknown field ${field}.`);
	}
	for (const field of allowed) {
		if (!Object.hasOwn(value, field)) throw new Error(`${label} is missing field ${field}.`);
	}
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		throw new Error(`${label} must be a canonical kebab-case ID.`);
	}
	return value;
}

function identifierList(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	const result = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
	if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate IDs.`);
	return result;
}

function exactKeys(actual: Record<string, unknown>, expected: readonly string[], label: string): void {
	const expectedSet = new Set(expected);
	for (const key of Object.keys(actual)) {
		identifier(key, `${label} key`);
		if (!expectedSet.has(key)) throw new Error(`${label} references unknown ID ${key}.`);
	}
	for (const key of expected) {
		if (!Object.hasOwn(actual, key)) throw new Error(`${label} is missing ${key}.`);
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	return value;
}

function parseFixedRoute(value: unknown, label: string): FixedRoute {
	const route = record(value, label);
	fields(route, ["provider", "model", "effort"], label);
	if (typeof route.provider !== "string" || !ROUTE_COMPONENT.test(route.provider)) {
		throw new Error(`${label} provider is invalid.`);
	}
	if (typeof route.model !== "string" || !ROUTE_COMPONENT.test(route.model)) {
		throw new Error(`${label} model is invalid.`);
	}
	if (!EFFORTS.has(route.effort as string)) throw new Error(`${label} effort is invalid.`);
	// Every guardrail is pinned false, so the max tier is always disabled.
	if (route.effort === MAX_EFFORT) {
		throw new Error(`${label} cannot use the ${MAX_EFFORT} effort while it is disabled.`);
	}
	return route as FixedRoute;
}

function sameRoute(left: FixedRoute, right: FixedRoute | undefined): boolean {
	return (
		right !== undefined &&
		left.provider === right.provider &&
		left.model === right.model &&
		left.effort === right.effort
	);
}

function parseSchemaCompatibility(policy: Record<string, unknown>): void {
	const compatibility = record(policy.schemaCompatibility, "schemaCompatibility");
	fields(compatibility, ["controller", "childRuntime"], "schemaCompatibility");
	for (const runtime of ["controller", "childRuntime"] as const) {
		const range = record(compatibility[runtime], `schemaCompatibility.${runtime}`);
		fields(range, ["minimum", "maximum"], `schemaCompatibility.${runtime}`);
		if (
			!Number.isInteger(range.minimum) ||
			!Number.isInteger(range.maximum) ||
			(range.minimum as number) > (range.maximum as number)
		) {
			throw new Error(`schemaCompatibility.${runtime} has an invalid schema range.`);
		}
	}
	const child = compatibility.childRuntime as { minimum: number; maximum: number };
	if (child.minimum > CHILD_RUNTIME_SCHEMA_MAXIMUM || child.maximum < CHILD_RUNTIME_SCHEMA_MINIMUM) {
		throw new Error(
			`schemaCompatibility.childRuntime ${child.minimum}..${child.maximum} does not admit this package's ` +
				`supported range ${CHILD_RUNTIME_SCHEMA_MINIMUM}..${CHILD_RUNTIME_SCHEMA_MAXIMUM}.`,
		);
	}
	const minimum = Math.max(child.minimum, CHILD_RUNTIME_SCHEMA_MINIMUM);
	const maximum = Math.min(child.maximum, CHILD_RUNTIME_SCHEMA_MAXIMUM);
	if (
		!Number.isInteger(policy.schemaVersion) ||
		(policy.schemaVersion as number) < minimum ||
		(policy.schemaVersion as number) > maximum
	) {
		throw new Error(
			`Routing policy schemaVersion ${String(policy.schemaVersion)} is outside the supported range ${minimum}..${maximum}.`,
		);
	}
}

function parseRoles(
	policy: Record<string, unknown>,
	canonicalRoles: readonly string[],
	capabilitySet: ReadonlySet<string>,
	resourceGrants: Record<string, unknown>,
): Record<string, unknown> {
	const operationalStateSet = new Set(identifierList(policy.operationalStates, "operationalStates"));
	if (
		operationalStateSet.size !== OPERATIONAL_STATES.length ||
		OPERATIONAL_STATES.some((state) => !operationalStateSet.has(state))
	) {
		throw new Error(`operationalStates must be exactly ${OPERATIONAL_STATES.join(", ")}.`);
	}
	const roles = record(policy.roles, "roles");
	exactKeys(roles, canonicalRoles, "roles");
	for (const [name, roleValue] of Object.entries(roles)) {
		const role = record(roleValue, `Role ${name}`);
		fields(
			role,
			["state", "childLaunch", "modes", "allowedInteractionModes", "resourceGrant", "routes"],
			`Role ${name}`,
		);
		const state = identifier(role.state, `Role ${name} state`);
		if (!operationalStateSet.has(state)) throw new Error(`Role ${name} references unknown operational state ${state}.`);
		if (typeof role.childLaunch !== "boolean") throw new Error(`Role ${name} childLaunch must be boolean.`);
		const modes = identifierList(role.modes, `Role ${name} modes`);
		for (const mode of modes) {
			if (!capabilitySet.has(mode)) throw new Error(`Role ${name} references unknown capability class ${mode}.`);
		}
		for (const interactionMode of identifierList(role.allowedInteractionModes, `Role ${name} allowedInteractionModes`)) {
			if (!INTERACTION_MODES.has(interactionMode)) {
				throw new Error(`Role ${name} references unknown interaction mode ${interactionMode}.`);
			}
			if (interactionMode === "interactive") {
				throw new Error(`Role ${name} cannot grant interactive launches while they are disabled.`);
			}
		}
		const resourceGrant = identifier(role.resourceGrant, `Role ${name} resourceGrant`);
		if (!Object.hasOwn(resourceGrants, resourceGrant)) {
			throw new Error(`Role ${name} references unknown resource grant ${resourceGrant}.`);
		}
		const grantSkills = (resourceGrants[resourceGrant] as { skills: string[] }).skills;
		if (role.childLaunch === true && grantSkills.includes("*")) {
			throw new Error(`Role ${name} is a child role and cannot use the all-Skills grant ${resourceGrant}.`);
		}
		const grantProjectResources = (resourceGrants[resourceGrant] as { projectResources: boolean }).projectResources;
		if (role.childLaunch === true && state === "pilot" && (grantSkills.length > 0 || grantProjectResources)) {
			throw new Error(
				`Role ${name} is a pilot role and cannot use resource grant ${resourceGrant}, which enables Skills or project resources.`,
			);
		}
		const routes = record(role.routes, `Role ${name} routes`);
		exactKeys(routes, modes, `Role ${name} routes`);
		for (const [capability, routeValue] of Object.entries(routes)) {
			parseFixedRoute(routeValue, `Route ${name}/${capability}`);
		}
	}
	return roles;
}

function parsePilotCases(
	policy: Record<string, unknown>,
	roles: Record<string, unknown>,
	capabilitySet: ReadonlySet<string>,
): void {
	const pilotCases = record(policy.pilotCases, "pilotCases");
	for (const [name, pilotCaseValue] of Object.entries(pilotCases)) {
		identifier(name, "pilotCases key");
		const pilotCase = record(pilotCaseValue, `Pilot case ${name}`);
		fields(
			pilotCase,
			["role", "capabilityClass", "artifact", "route", "resourceGrant", "attempts", "retry", "expires", "acceptance"],
			`Pilot case ${name}`,
		);
		const roleName = identifier(pilotCase.role, `Pilot case ${name} role`);
		if (!Object.hasOwn(roles, roleName)) throw new Error(`Pilot case ${name} role must be canonical.`);
		const role = roles[roleName] as { state: string; modes: string[]; routes: Record<string, FixedRoute> };
		if (role.state === "disabled") throw new Error(`Pilot case ${name} names disabled role ${roleName}.`);
		const capability = identifier(pilotCase.capabilityClass, `Pilot case ${name} capabilityClass`);
		if (!capabilitySet.has(capability) || !role.modes.includes(capability)) {
			throw new Error(`Pilot case ${name} capabilityClass is not granted by role ${roleName}.`);
		}
		nonEmptyString(pilotCase.artifact, `Pilot case ${name} artifact`);
		const route = parseFixedRoute(pilotCase.route, `Pilot case ${name} route`);
		if (!sameRoute(route, role.routes[capability])) {
			throw new Error(`Pilot case ${name} route must equal the role fixed route.`);
		}
		if (pilotCase.resourceGrant !== (role as unknown as { resourceGrant: string }).resourceGrant) {
			throw new Error(`Pilot case ${name} resourceGrant must equal the role resourceGrant.`);
		}
		const attempts = record(pilotCase.attempts, `Pilot case ${name} attempts`);
		fields(attempts, ["allowed"], `Pilot case ${name} attempts`);
		if (!Number.isInteger(attempts.allowed) || (attempts.allowed as number) <= 0) {
			throw new Error(`Pilot case ${name} attempts are invalid.`);
		}
		nonEmptyString(pilotCase.retry, `Pilot case ${name} retry`);
		if (Number.isNaN(Date.parse(nonEmptyString(pilotCase.expires, `Pilot case ${name} expires`)))) {
			throw new Error(`Pilot case ${name} expires must be a timestamp.`);
		}
		if (
			!Array.isArray(pilotCase.acceptance) ||
			pilotCase.acceptance.length === 0 ||
			!pilotCase.acceptance.every((entry) => typeof entry === "string" && entry.length > 0)
		) {
			throw new Error(`Pilot case ${name} acceptance must be a non-empty array of non-empty strings.`);
		}
	}
}

function parseExtensions(policy: Record<string, unknown>, canonicalRoles: readonly string[], defaultRole: string): void {
	const extensionCatalog = record(policy.extensionCatalog, "extensionCatalog");
	for (const [name, entryValue] of Object.entries(extensionCatalog)) {
		identifier(name, "extensionCatalog key");
		const entry = record(entryValue, `Extension ${name}`);
		fields(entry, ["source", "files"], `Extension ${name}`);
		if (typeof entry.source !== "string" || (entry.source !== "pi-config" && !GIT_SOURCE.test(entry.source))) {
			throw new Error(`Extension ${name} source must be pi-config or an exact Git commit.`);
		}
		if (!Array.isArray(entry.files) || entry.files.length === 0) {
			throw new Error(`Extension ${name} files must be a non-empty array.`);
		}
		const paths = entry.files.map((fileValue, index) => {
			const file = record(fileValue, `Extension ${name} files[${index}]`);
			fields(file, ["path", "sha256"], `Extension ${name} files[${index}]`);
			if (!safePath(file.path)) {
				throw new Error(`Extension ${name} files[${index}] path must be a safe relative path.`);
			}
			if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
				throw new Error(`Extension ${name} files[${index}] sha256 must be a lowercase hex digest.`);
			}
			return file.path;
		});
		if (new Set(paths).size !== paths.length) throw new Error(`Extension ${name} files must not contain duplicate paths.`);
	}
	const catalogued = (id: string, label: string): void => {
		if (!Object.hasOwn(extensionCatalog, id)) throw new Error(`${label} references unknown extension ${id}.`);
	};
	const repositoryOf = (id: string): string => sourceRepository((extensionCatalog[id] as { source: string }).source);

	const mandatoryExtensions = identifierList(policy.mandatoryExtensions, "mandatoryExtensions");
	const mandatoryIds = MANDATORY_EXTENSIONS.map(([id]) => id);
	if (mandatoryExtensions.join() !== mandatoryIds.join()) {
		throw new Error(`mandatoryExtensions must be exactly ${mandatoryIds.join(", ")}.`);
	}
	for (const [id, repository] of MANDATORY_EXTENSIONS) {
		catalogued(id, "mandatoryExtensions");
		if (repositoryOf(id) !== repository) throw new Error(`Extension ${id} source must be ${repository}.`);
	}

	const extensionGrants = record(policy.extensionGrants, "extensionGrants");
	exactKeys(
		extensionGrants,
		canonicalRoles.filter((role) => role !== defaultRole),
		"extensionGrants",
	);
	for (const [role, grantValue] of Object.entries(extensionGrants)) {
		const grant = identifierList(grantValue, `extensionGrants.${role}`);
		for (const id of grant) {
			catalogued(id, `extensionGrants.${role}`);
			if (mandatoryExtensions.includes(id)) {
				throw new Error(`extensionGrants.${role} must not list mandatory extension ${id}.`);
			}
			if (repositoryOf(id) === SPAWNING_REPOSITORY) {
				throw new Error(`extensionGrants.${role} must not grant subagent spawning support through ${id}.`);
			}
			if ((extensionCatalog[id] as { source: string }).source !== "pi-config") {
				throw new Error(
					`extensionGrants.${role} must not grant ${id}, whose catalog source is a Git commit rather than a verified local file.`,
				);
			}
		}
		if (!grant.includes(ROUTE_GUARD_EXTENSION)) {
			throw new Error(`extensionGrants.${role} must grant the ${ROUTE_GUARD_EXTENSION} route guard.`);
		}
	}
}

/** Validate a decoded policy document; throws on anything this package cannot enforce exactly. */
function parseCanonicalPolicy(input: unknown): CanonicalRoutingPolicy {
	const policy = record(input, "Routing policy");
	fields(
		policy,
		[
			"schemaVersion",
			"generation",
			"schemaCompatibility",
			"defaultRole",
			"canonicalRoles",
			"aliases",
			"operationalStates",
			"capabilityClasses",
			"resourceGrants",
			"roles",
			"pilotCases",
			"extensionCatalog",
			"mandatoryExtensions",
			"extensionGrants",
			"interactionModes",
			"guardrails",
		],
		"Routing policy",
	);
	if (
		typeof policy.generation !== "string" ||
		!ROUTE_COMPONENT.test(policy.generation) ||
		policy.generation.length > 64
	) {
		throw new Error("Routing policy generation must be a bounded single-line identifier.");
	}
	parseSchemaCompatibility(policy);

	const canonicalRoles = identifierList(policy.canonicalRoles, "canonicalRoles");
	const canonicalRoleSet = new Set(canonicalRoles);
	const defaultRole = identifier(policy.defaultRole, "defaultRole");
	if (defaultRole !== "controller" || !canonicalRoleSet.has(defaultRole)) {
		throw new Error("defaultRole must remain the canonical controller role, never a child role.");
	}

	const aliases = record(policy.aliases, "aliases");
	for (const [alias, targetValue] of Object.entries(aliases)) {
		identifier(alias, "Alias");
		const target = identifier(targetValue, `Alias ${alias} target`);
		if (canonicalRoleSet.has(alias)) throw new Error(`Alias ${alias} overlaps a canonical role.`);
		if (!canonicalRoleSet.has(target)) throw new Error(`Alias ${alias} must point directly to a canonical role.`);
	}

	const capabilityClasses = record(policy.capabilityClasses, "capabilityClasses");
	for (const [name, definitionValue] of Object.entries(capabilityClasses)) {
		identifier(name, "Capability class");
		fields(record(definitionValue, `Capability class ${name}`), [], `Capability class ${name}`);
	}
	const capabilitySet = new Set(Object.keys(capabilityClasses));
	if (capabilitySet.size === 0) throw new Error("capabilityClasses must not be empty.");

	const interactionModes = identifierList(policy.interactionModes, "interactionModes");
	if (
		interactionModes.length !== INTERACTION_MODES.size ||
		interactionModes.some((mode) => !INTERACTION_MODES.has(mode))
	) {
		throw new Error("interactionModes must define the supported interaction modes.");
	}

	const guardrails = record(policy.guardrails, "guardrails");
	fields(
		guardrails,
		[
			"allowProviderFallback",
			"allowRouteNormalization",
			"allowRecursiveSpawning",
			"allowMaxEffort",
			"allowInteractiveLaunch",
		],
		"guardrails",
	);
	for (const guardrail of Object.keys(guardrails)) {
		if (guardrails[guardrail] !== false) throw new Error(`guardrails.${guardrail} must be false.`);
	}

	const resourceGrants = record(policy.resourceGrants, "resourceGrants");
	for (const [name, grantValue] of Object.entries(resourceGrants)) {
		identifier(name, "Resource grant");
		const grant = record(grantValue, `Resource grant ${name}`);
		fields(grant, ["skills", "projectResources"], `Resource grant ${name}`);
		const allSkills = Array.isArray(grant.skills) && grant.skills.length === 1 && grant.skills[0] === "*";
		if (
			!Array.isArray(grant.skills) ||
			(!allSkills &&
				!grant.skills.every(
					(skill) => typeof skill === "string" && IDENTIFIER.test(skill) && !RESERVED_SKILL_NAMES.has(skill),
				))
		) {
			throw new Error(`Resource grant ${name} skills must be ["*"] or Skill identifiers other than all and none.`);
		}
		if (typeof grant.projectResources !== "boolean") {
			throw new Error(`Resource grant ${name} projectResources must be boolean.`);
		}
	}

	const roles = parseRoles(policy, canonicalRoles, capabilitySet, resourceGrants);
	parsePilotCases(policy, roles, capabilitySet);
	parseExtensions(policy, canonicalRoles, defaultRole);

	return deepFreeze(structuredClone(policy)) as CanonicalRoutingPolicy;
}
