# Boundary evidence: extension allowlist

Part of the managed-generation conformance report; see `package-conformance-report.md` in this directory for identity, test command, results and evidence classes.

## Claim

A policy-managed child loads exactly its verified schema 3 resource inventory and nothing Pi could discover. The `-e` list is the completion helper, then the workspace boundary, then the role's grant in declared order. Extension, context-file, Skill, prompt-template and theme discovery and project-local resources are disabled. Every catalogued file of every loaded resource is hashed before launch. A Git-sourced grant, a project definition that would shadow a policy alias, a pilot grant that enables Skills or project resources, and a route provider that the child could not load are rejected before any child process exists.

## Expected rejection

- `test/routing/canonical-policy.test.ts`: "rejects extension grants that drop the route guard or grant subagent spawning"
- `test/routing/canonical-policy.test.ts`: "rejects a granted extension whose catalog source is a Git commit rather than a local file"
- `test/routing/canonical-policy.test.ts`: "rejects a pilot role whose resource grant enables Skills or project resources"
- `test/routing/canonical-policy.test.ts`: "rejects a child role that uses the all-Skills grant"
- `test/routing/tool-policy.test.ts`: "rejects a non-pilot child role whose resource grant enables Skills or project resources"
- `test/routing/tool-policy.test.ts`: "rejects a route whose provider is neither built into Pi nor defined in models.json"
- `test/launch/policy-launch.test.ts`: "refuses a managed agent defined only in the project"
- `test/launch/policy-launch.test.ts`: "refuses a managed definition that gained forbidden launch fields after authorization"

## Operational failure

- `test/launch/policy-launch.test.ts`: "refuses a managed launch whose definition can no longer be read"
- `test/runtime/managed-child-requests.test.ts`: "blocks a managed timeout wrap-up that lost its verified inventory"

## Enforcement breach (attempts that must stay contained)

- `test/routing/tool-policy.test.ts`: "a missing or altered catalogued extension file rejects the whole call before any launch"
- `test/routing/tool-policy.test.ts`: "rejects a completion helper catalog entry that is not the file the launcher loads"
- `test/launch/policy-launch.test.ts`: "reads a managed definition only from the global agent directory"
- `test/launch/policy-launch.test.ts`: "keeps a caller Skill field out of discovery and launch metadata"
- `test/runtime/managed-child-requests.test.ts`: "blocks a managed timeout wrap-up whose catalogued files changed since launch"

## Exact resources

- `test/launch/policy-launch.test.ts`: "loads exactly the verified inventory with every discovery path disabled"
- `test/launch/policy-launch.test.ts`: "re-verifies the inventory before building the child argv"
- `test/launch/real-pi-launch.test.ts`: "loads exactly the verified inventory and nothing Pi could discover"
- `test/runtime/managed-child-requests.test.ts`: "relaunches a managed timeout wrap-up with exactly the verified inventory and no discovery"
- `test/routing/completion-extension-pin.test.ts`: "the completion extension still matches the hash the routing policy pins"

The real-`pi` test runs the package's `pi` binary against a local fake provider that records requests, with an ambient extension, settings package, context files, Skill and prompt template present, and asserts that altering one catalogued byte produces zero requests.
