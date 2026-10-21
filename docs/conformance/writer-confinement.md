# Boundary evidence: writer confinement

Part of the managed-generation conformance report; see `package-conformance-report.md` in this directory for identity, test command, results and evidence classes.

## Claim

A write-capable managed child launches only into a linked worktree that is distinct from the parent checkout, holding a durable per-worktree lease. It runs as the init of its own PID namespace (its execution group), and its lease is released only once that group is proven empty. A host that cannot confine a writer rejects it before any child or lease exists. Read-only children need no worktree and cannot write.

## Expected rejection

- `test/routing/writer-launch.test.ts`: "rejects a writer outside a valid worktree before any child or lease exists"
- `test/routing/writer-launch.test.ts`: "a writer called through the subagent tool cannot name a worktree, so it is rejected before any lease exists"
- `test/routing/writer-launch.test.ts`: "a pane writer or a verified fan-out writer has no supervised group and is rejected"
- `test/routing/writer-launch.test.ts`: "a held lease rejects a second writer into the same worktree, creating no new record"
- `test/routing/writer-launch.test.ts`: "two writers of one call naming the same worktree are rejected before any lease exists"
- `test/broker/writer-worktree.test.ts`: "rejects the main checkout, the parent's own checkout, and a subdirectory of a worktree"
- `test/broker/writer-worktree.test.ts`: "rejects a worktree of another repository"
- `test/launch/writer-background-launch.test.ts`: "refuses to run a writer anywhere but its leased worktree"

## Operational failure

- `test/routing/writer-launch.test.ts`: "a host that cannot confine a writer rejects it before any child or lease exists"
- `test/routing/writer-launch.test.ts`: "a spawn that throws releases the lease"
- `test/broker/writer-spawn.test.ts`: "a host whose identity inputs cannot be read cannot confine a writer"
- `test/broker/writer-spawn.test.ts`: "a child cannot start when its group cannot be recorded"
- `test/broker/writer-lease.test.ts`: "a zombie init, an unreadable /proc, or no recorded group keeps the lease held and marked for recovery"
- `test/broker/writer-lease.test.ts`: "an unreadable group record keeps the lease held instead of throwing"
- `test/broker/writer-lease.test.ts`: "a spawn that may have left an unrecorded writer keeps the lease held for good"

## Enforcement breach (attempts that must stay contained)

- `test/routing/writer-launch.test.ts`: "a worktree that changes between acquiring the lease and revalidating releases the lease and rejects"
- `test/broker/sandbox-escape.test.ts`: "a writer can change its working tree but no Git metadata, link, or other checkout"
- `test/broker/sandbox-escape.test.ts`: "a writer in a main checkout cannot replace or redirect its .git directory"
- `test/broker/sandbox-escape.test.ts`: "read-only work cannot modify the repository, shared Git metadata, or the parent checkout"
- `test/broker/writer-worktree.test.ts`: "rejects a symlinked path whose real path differs"
- `test/broker/writer-worktree.test.ts`: "rejects a branch that the main HEAD or another worktree's HEAD also names"
- `test/broker/sandbox-plan.test.ts`: "rejects a linked worktree whose commondir or gitdir back-link was redirected"
- `test/broker/writer-escape.test.ts`
- `test/broker/writer-spawn.test.ts`: "a setsid descendant and a running tool sandbox keep the writer's lease held until the init exits, even with its launcher killed"

## Execution-group leases

- `test/broker/writer-lease.test.ts`: "acquires one durable lease per worktree in a private directory, binding the launch to it"
- `test/broker/writer-lease.test.ts`: "releases only once the recorded group is proven empty, and never deletes a record"
- `test/broker/writer-lease.test.ts`: "a later launch reclaims a lease only when its supervisor is dead and its group is proven empty"
- `test/broker/writer-lease.test.ts`: "two processes racing for the same worktree: exactly one acquires the lease"
- `test/broker/writer-group.test.ts`: "a live init in another PID namespace than the one recorded is an anomaly, not proof"
- `test/broker/writer-spawn.test.ts`: "records the group before the child runs, and the child is the init of its own PID namespace"
- `test/routing/writer-launch.test.ts`: "leases are all or nothing: one held lease releases the others and launches nothing"
- `test/routing/writer-launch.test.ts`: "two parents in separate processes racing for one worktree: one holds the lease, the other is rejected as held"
- `test/launch/writer-background-launch.test.ts`: "runs the writer as the init of its own PID namespace and releases its lease once the group is proven empty"
- `test/runtime/writer-timeout-restart.test.ts`: "refuses to start the next generation while the previous one is not proven empty"

## Read-only confinement

- `test/routing/writer-launch.test.ts`: "a read-only managed child does not need a worktree"
- `test/broker/sandbox-plan.test.ts`: "binds a read-only role's repository and Git metadata read-only and nothing writable"
- `test/broker/brokered-tools.test.ts`: "read-only tools cannot write, and bash runs confined without session variables"
