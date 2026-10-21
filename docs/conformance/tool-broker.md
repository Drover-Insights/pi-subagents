# Boundary evidence: tool broker

Part of the managed-generation conformance report; see `package-conformance-report.md` in this directory for identity, test command, results and evidence classes.

## Claim

A managed child's model-callable tools run through a broker in an OS sandbox, not as the child's own process with its own environment. The sandbox starts from an empty environment, isolates every namespace, has no network, and cannot reach host credentials, processes, sockets or the trusted runtime. A read-only role's repository and Git metadata are bound read-only. A host that cannot provide the sandbox rejects every managed launch; there is no in-process fallback.

## Expected rejection

- `test/routing/tool-policy.test.ts`: "rejects a managed child whose sandbox would expose a protected path such as the home directory"
- `test/broker/sandbox-plan.test.ts`: "rejects roots that contain a protected ancestor such as home, or the filesystem root"
- `test/broker/sandbox-plan.test.ts`: "rejects roots that equal, contain, or sit inside a protected path"
- `test/broker/sandbox-plan.test.ts`: "rejects a symlink alias whose real path is protected"
- `test/broker/sandbox-plan.test.ts`: "rejects a .git file that points anywhere but a linked worktree of a real repository"

## Operational failure

- `test/routing/tool-policy.test.ts`: "a host that cannot provide the tool sandbox rejects every managed launch before any launch"
- `test/broker/brokered-tools.test.ts`: "a malformed broker config leaves every model tool failing closed"
- `test/broker/brokered-tools.test.ts`: "an aborted read stops its sandbox, and endless output is cut off"
- `test/broker/broker-env.test.ts`: "reads only an exact, known config and reports anything else as malformed"
- `test/broker/sandbox-escape.test.ts`: "kills every descendant, including detached ones, when a command times out"

## Enforcement breach (attempts that must stay contained)

Credential-blind tools:

- `test/broker/sandbox-escape.test.ts`: "cannot reach credentials by absolute path, relative traversal, or symlink alias"
- `test/broker/sandbox-escape.test.ts`: "sees an empty environment with no terminal, provider, or control variables"
- `test/broker/sandbox-escape.test.ts`: "cannot see host processes or read the trusted runtime's memory or environment"
- `test/broker/sandbox-escape.test.ts`: "has no network, not even the host's loopback"
- `test/broker/sandbox-escape.test.ts`: "cannot reach a host abstract unix socket or one inside its own repository"
- `test/broker/sandbox-escape.test.ts`: "denies vsock, keyrings, ptrace, process memory calls, io_uring, and nested user namespaces"
- `test/broker/brokered-tools.test.ts`: "the brokered edit preview never reads files in the trusted process"
- `test/broker/brokered-tools.test.ts`: "deactivates any active built-in tool the broker does not provide, powershell included"

Read-only confinement:

- `test/broker/sandbox-escape.test.ts`: "read-only work cannot modify the repository, shared Git metadata, or the parent checkout"
- `test/broker/brokered-tools.test.ts`: "read-only tools read the repository and nothing outside it"
- `test/broker/brokered-tools.test.ts`: "read-only tools cannot write, and bash runs confined without session variables"
- `test/broker/sandbox-plan.test.ts`: "binds a read-only role's repository and Git metadata read-only and nothing writable"

## Broker installation

- `test/broker/brokered-tools.test.ts`: "the completion helper every child loads first installs the broker"
- `test/broker/brokered-tools.test.ts`: "an unmanaged child keeps Pi's own tools"
- `test/broker/sandbox-plan.test.ts`: "isolates every namespace, drops all authority, and starts from an empty environment"
- `test/broker/broker-env.test.ts`: "sets the broker config on every managed launch and clears it on every other"
- `test/routing/tool-policy.test.ts`: "a managed launch carries the broker mode its tool allowlist implies"
- `test/runtime/managed-child-requests.test.ts`: "relaunches a managed timeout wrap-up with its tool broker config"
