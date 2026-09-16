# pi-subagents baseline capability and gap report

## Purpose and authority

This report satisfies Drover-Insights/pi-subagents#2. It records the current fork baseline before the enforcement work required by Drover-Insights/pi-config#11 begins. It does not authorize a role, change runtime behavior, or claim conformance with that specification.

The hardened specification in Drover-Insights/pi-config#11 is authoritative. Its predecessor, pi-config#10, is provenance only and was not used as an independent requirement source.

## Baseline identity

| Item | Recorded value |
| --- | --- |
| Repository | `Drover-Insights/pi-subagents` |
| Baseline commit | `9e9a28401b461384991ad63043db56bd7c995b74` |
| Baseline version | `2.9.1` |
| Baseline branch when inspected | `origin/main` |
| Node | `v24.19.0` |
| Bun | `1.3.10` |
| npm | `11.17.0` |
| Validation time | `2026-09-16T19:02:01Z` |

The baseline commit is the code identity assessed below. The report commit intentionally follows it and changes documentation only.

## Baseline validation

Dependencies were installed with:

```sh
bun install --frozen-lockfile
```

The exact baseline validation command was:

```sh
bunx tsc --noEmit && npm test
```

Result: pass, exit status 0.

- TypeScript completed without diagnostics.
- The test runner reported 1,173 tests in 183 suites.
- 1,168 tests passed, 5 were skipped, and none failed, were cancelled, or were marked todo.
- Test duration reported by Node was 109,158.562951 ms.
- The working tree remained clean after dependency installation and validation.

Four skipped tests are environment-dependent tmux integration cases. The fifth is a live DeepSeek verifier probe that skips when `DEEPSEEK_API_KEY` is absent. The recorded five-skip result therefore assumes the tmux cases are unavailable in the test environment and `DEEPSEEK_API_KEY` is unset; a differently configured environment can produce another skip count or make a live provider request. Other live terminal and provider scripts were not run. They require explicit opt-ins and, for live Pi requests, a user-selected model. Therefore this baseline proves the checked-in type and ordinary test contracts, not real provider routing, OS confinement, or live terminal behavior.

## Supported runtime capabilities

### Launch and coordination

The baseline supports:

- named agent definitions discovered from project `.pi/agents/` and the configured global agent directory;
- background child processes and interactive child terminal surfaces;
- asynchronous and synchronous launches, including mixed-batch barriers and forced waiting in headless or one-shot parent sessions;
- standalone, lineage-only, and forked child sessions, plus optional ephemeral sessions;
- child resume with optional follow-up tasks;
- multiple child launches with an in-process spawn-width ceiling;
- optional nested spawning with depth, width, visibility, and target-agent restrictions;
- wall-clock and idle timeouts, warning-threshold interruption, report-only restart, and SIGTERM/SIGKILL escalation for background process groups;
- `terminate` and `continue` parent-close policies;
- terminal backends for Herdr, cmux, tmux, zellij, and WezTerm;
- result delivery by synchronous tool result or later parent steer;
- an optional LLM-as-a-verifier flow with candidate Git worktrees, a detached supervisor, durable run manifests, candidate snapshots, winner selection, and guarded application to a clean source tree; and
- opt-in `task-expansion: shell`, which executes shell placeholders from the child's effective cwd in the parent process before child launch, using the parent process environment plus `PI_WORKSPACE`.

Primary implementation seams include `src/tools/subagent-tools.ts`, `src/launch/background.ts`, `src/launch/interactive.ts`, `src/runtime/resume-service.ts`, `src/runtime/shutdown.ts`, `src/mux/`, and `src/vf/`.

### Current routing policy

The Drover fork already contains a launch-time routing policy in `src/routing/policy.ts`, connected through `src/tools/model-routing.ts` and `src/tools/subagent-tools.ts`.

It currently:

- applies the routing policy only to the migration-era child names `pilot-scout`, `pilot-worker`, `pilot-reviewer`, `pilot-frontier-critic`, and `pilot-frontier-engineer`; named agents outside this set bypass the routing policy entirely;
- rejects `pilot-controller` as a child;
- requires a capability class and risk for those names;
- validates the known launch mode, risk, and escalation-reason values;
- rejects caller model and thinking overrides for routing-enabled names;
- rejects role and capability-class mismatches before child launch;
- selects fixed model and thinking values;
- validates a policy-selected model and thinking level against Pi's available model registry during launch planning;
- returns a structured `policy_rejected` result for policy rejection before spawn-width reservation, process creation, or terminal creation.

The hard-coded baseline routes are:

| Baseline request | Baseline route |
| --- | --- |
| literal Scout | `openai-codex/gpt-5.6-luna`, Low |
| code-graph Scout | `openai-codex/gpt-5.6-terra`, Low |
| Worker | `openai-codex/gpt-5.6-terra`, Medium |
| Reviewer | `openai-codex/gpt-5.6-sol`, Medium |
| Frontier Critic | `anthropic/claude-fable-5-1`, High |
| Frontier Engineer | `openai-codex/gpt-6-astra`, XHigh |

The policy result becomes an internal `policyRoute` that model-callable input cannot supply directly. Launch metadata records the resulting model and thinking value. These are planned values, not an enforced effective route: freeform agent `flags` are appended later and can supply conflicting model or thinking arguments.

### Resource loading

Agent frontmatter can select or restrict:

- model and thinking;
- tools and denied tools;
- extensions;
- Skills and injected Skills;
- context-file discovery;
- inherited append-system content;
- project trust;
- child environment variables and denied inherited variables;
- cwd, session mode, lifecycle, timeout, and spawning behavior.

For extensions, `all` preserves normal Pi discovery, `none` disables normal extensions, and an allowlist launches with `--no-extensions` followed by selected extension arguments. The package force-loads its internal completion helper and conditionally reloads its own extension when nested spawning is granted. Configured package installations may be reused through Pi's settings and package manager.

For Skills, `all` preserves discovery, `none` passes `--no-skills`, and an allowlist resolves named Skills into explicit launch arguments. Project context files remain enabled unless `no-context-files: true` is set. Project agent definitions override global definitions.

Freeform agent `flags` are appended after generated model, approval, tool, extension, and Skill arguments. Their last-wins behavior can widen or replace those generated selections. The frontmatter controls above are therefore operational configuration, not an authorization boundary, whenever freeform flags are permitted.

### Session and resume state

The baseline writes version 1 launch metadata into the child session JSONL. It records model, thinking, tools, denied tools, Skills, extensions, cwd, trust, context settings, mode, lifecycle, environment policy, timeouts, and spawn grants.

Resume uses the persisted launch mode when present. It preserves many original launch fields, reapplies denied environment patterns, and narrows nested-spawn authority against the current caller. Only spawn budget, spawnable agents, and denied tools are anchored to the first metadata entry. Later syntactically minimal metadata entries are shallow-merged over other fields and can replace model, thinking, flags, cwd, or other launch state without proving that frontmatter allowed an override. Duplicate in-process resume of the same session file is rejected.

### Process and terminal lifecycle

Background launches use detached child process groups. Stop and timeout paths signal the process group, with SIGKILL escalation on timeout. Interactive launches create a backend surface and send a Pi command into it. Watchers observe session files, exit sidecars, sentinels, process state, or terminal state and route a result to the parent.

Herdr and zellij placement code tracks surfaces selected by the current parent process and avoids reusing unrelated panes when placing siblings. Herdr command errors are represented explicitly in its adapter. Parent shutdown can terminate or detach children according to frontmatter.

### Existing isolation mechanisms

The baseline has useful narrowing controls, but they are not a security sandbox:

- background launches default to `--no-approve`;
- interactive launches default to `--no-approve` unless frontmatter grants project trust;
- tools, extensions, Skills, context files, environment names, nested spawning, and cwd can be narrowed when no later freeform flag conflicts with the generated arguments;
- routing input for recognized `pilot-*` names is checked before process or terminal creation;
- background processes run in their own process group;
- verified fan-out creates one Git worktree and branch per candidate and requires a clean source tree before creation;
- verified fan-out uses a detached supervisor and durable atomic manifests for that feature's run state;
- winner application uses a clean-base compare-and-swap and exact tree check.

The README correctly states that tool and extension controls, and verified-fan-out worktrees, are not sandboxes. All ordinary children still execute as the same OS user and can reach anything allowed to that user unless an external boundary prevents it.

## Gaps against the hardened specification

### 1. No canonical external policy contract

The routing policy is TypeScript embedded in package source. It does not load policy through Pi's configured agent directory and has no schema version, supported schema range, strict policy parser, generation identity, compatibility pair, or resource manifest. The fork's checksum-bound conformance report is separate release evidence that `pi-config` must accept; it is not a required runtime policy input.

Unknown values inside a recognized `pilot-*` routing request reject, but unknown or ordinary agent names bypass this policy entirely. There is no equivalent fail-closed validation for an external policy document, unknown enforcement-affecting policy fields, or unrecognized role identities.

### 2. Canonical identities and role states are absent

The baseline recognizes `pilot-*` names directly. It does not implement the canonical IDs `controller`, `scout`, `worker`, `reviewer`, `frontier-critic`, and `frontier-engineer`, nor an explicit non-overlapping migration alias map.

It has no `disabled`, `pilot`, `selective`, or `automated` state machine. It has no distinction between explicit Controller launch and policy-selected launch. It does not bind pilot launches to approved immutable case records.

### 3. The frontier routes contradict the specification

The baseline actively resolves both frontier roles instead of disabling them. Frontier Critic uses stock `anthropic/claude-fable-5-1` at High instead of the approved `pi-claude-code-provider/fable` path at Medium. Frontier Engineer uses XHigh instead of Low.

The baseline also accepts both background and interactive mode for routing-enabled roles. It has no initial policy rule that rejects all interactive launches. When the parent lacks a UI or mux, an interactive request is evaluated by routing as interactive and later forced to background without policy reevaluation.

### 4. No transition graph, ceiling, or Max authorization model

The baseline implements fixed route selection only. It has no role-state transition graph, escalation edges, per-role ceiling, one-rung enforcement, policy-selected automation triggers, or human-issued one-launch Max authorization. It does reject direct model and thinking overrides for `pilot-*` roles, but that is not the specified transition system.

The initial policy also requires every child to reject recursive spawning. The baseline instead applies generic frontmatter-driven spawn depth, width, visibility, and target-agent rules. A project definition for a pilot child can grant spawning, and the routing policy does not inspect caller identity or impose an unconditional no-recursion rule.

### 5. Launch-time selection is not a common request gate

Routing is evaluated during the `subagent` tool call. The selected route is then passed to a child Pi process. Later freeform flags can replace the selected model or thinking, and a requested interactive mode can be converted to background after that decision. The package does not revalidate active generation authorization, role state, capability, effective mode, resource snapshot, or requested versus effective route immediately before every child model request.

Resume can adopt model, thinking, flags, and other state from mutable later session metadata without re-running the Drover routing policy or intersecting authority with a current canonical policy. Interactive UI changes are not mediated by a common policy request gate.

The optional verifier flow is a separate model-execution path. Its configured verifier backend performs capability-probe and scoring calls directly through the verifier bridge, outside the launch routing policy and without the common request gate required by the hardened specification.

### 6. Requested and effective route evidence is incomplete

Launch planning checks that the policy-selected model exists and that the requested thinking level is supported. Runtime state records the planned model reference. There is no provider-issued or Pi-issued receipt proving the effective provider, model, and effort at each request, no policy-generation field, and no full route receipt covering role, capability, mode, tools, extensions, Skills, and operational state.

The package does not detect provider-side normalization after launch. It does not own provider fallback behavior or prove that an adapter failure cannot substitute another provider.

### 7. Resource containment defaults are ambient and mutable

Extensions and Skills default to `all`. Project context discovery defaults on. Agent definitions can come from project or global directories, with project definitions overriding global ones. Freeform `flags` are appended after generated arguments and can override generated model, thinking, tool, extension, Skill, context, and approval arguments.

Allowlisted extension package sources may resolve through current mutable settings and installed paths. Resources are not bound to immutable hashes or a generation manifest, and load order is not validated against a canonical resource inventory. Parent grants, role grants, and generation grants are not intersected as one authorization decision.

The internal completion helper is loaded, but the baseline has no policy-owned mandatory workspace boundary, reviewed Herdr-only resource set, subscription-provider identity, or fail-closed resource integrity check.

### 8. Model-directed tools are not credential-blind

Built-in and extension tools execute inside the child Pi runtime under the child's OS permissions. Tool allowlists and denied tools narrow names but do not isolate native tools from runtime memory, filesystem credentials, control state, sockets, network, or provider endpoints.

Children inherit the parent environment by default. `deny-env` is optional and filters named variables only. Interactive launch capsules intentionally contain the deny-filtered parent environment and are protected only by same-user filesystem permissions until consumed. Before either child mode starts, opt-in shell task expansion executes task-controlled commands in the parent process with the full parent environment, not the child's deny-filtered environment.

There is no restricted executor or broker for all model-directed tools, no minimal credential-free environment by default, and no host IPC, network, process-memory, or descendant boundary.

### 9. Read-only roles are not technically read-only

A role can omit `edit` and `write` while retaining `bash`, extension tools, or other mutation paths. Tests and subprocesses can write files or run hooks. An agent with shell task expansion enabled can also execute task-supplied commands before the child and its tool restrictions exist. The package provides no read-only filesystem confinement or constrained inspection-command broker with isolated scratch output.

### 10. Ordinary writers are not confined or reserved

For ordinary launches, cwd is a path resolved from input or frontmatter. The package does not verify canonical repository identity, distinct parent and child worktrees, assigned branch, HEAD, write root, or permitted Git metadata. It does not create a process-level filesystem boundary around that cwd. Opt-in task expansion can mutate that cwd before a child process is created or a writer lease could be checked.

Spawn-width accounting is an in-memory concurrency limit, not a repository/worktree lease. Two parents can launch writers into the same worktree. There is no lease keyed by repository and worktree identity, no stable execution-group ownership, and no fail-closed host-support check.

Verified fan-out worktrees do not close this gap. They apply only to the optional verifier flow, share repository Git metadata, and are explicitly documented as non-sandboxed.

### 11. Durable trusted runtime state is incomplete

Ordinary running-child ownership is held in in-memory maps. Session metadata, task artifacts, sidecars, and interactive environment capsules are stored in locations the same OS user and ordinary child tools can generally access.

The verified-fan-out supervisor has atomic manifests and a PID/heartbeat lease for its own runs, but that store is not a general trusted state service for launches, policy snapshots, writer leases, pilot attempts, terminal ownership, or audit records. Its PID liveness check is not the specified stable execution-group identity.

### 12. Pilot-case authorization and attempt accounting are absent

The request includes a free-form dispatch tool call ID, capability class, risk, and optional escalation reason. There is no immutable approved case registry binding task and artifact identity, attempts, retry policy, expiration, tools, resources, and acceptance checks.

There is no atomic durable reservation, commit, refund, resume, rollback, concurrency, or replay protocol for pilot attempts.

### 13. Resume metadata is mutable and not integrity-bound

Launch metadata is plain JSONL in the child session. The child runs as the same user and can write its session. Resume anchors spawn budget, spawnable agents, and denied tools to the first metadata entry, but shallow-merges other fields from later minimally validated entries. A child can therefore append model, thinking, flags, cwd, or other launch-state changes without relying on caller override permission. No cryptographic integrity check protects the snapshot.

Resume does not bind resource hashes, policy generation, trust, route, write root, process group, or terminal ownership to an immutable authority record. It does not intersect the snapshot with current policy, reject policy revocation, or prohibit every authority broadening channel.

### 14. Side-effect phases do not match the specification

Routing rejection for recognized pilot names happens before spawn-width reservation and execution launch, which is a useful preflight property. After that point, launch preparation can execute task-supplied shell commands with parent credentials, then create session files, metadata, task or prompt artifacts, extension sidecars, and environment capsules before the child process is committed. Interactive launch can create a surface before command delivery completes.

Batch children launch sequentially after one aggregate slot reservation. If a later child fails during planning or launch, already-started children remain running while the tool throws and releases only the unlaunched slots, so the caller receives no successful-launch result for those surviving children.

The baseline has no formal preflight, confined-bootstrap, and launch-commit state machine. It cannot prove that bootstrap prevents repository writes and model requests, atomically commits an entire batch, releases only revalidated owned resources, or enters recovery on uncertain ownership.

### 15. Lifecycle ownership is not durable enough

Background process-group signaling is stronger than signaling one PID, but ownership is not represented by a durable supervisor-owned execution group with stable start identity. Ordinary child state disappears when the parent process loses its in-memory registry.

Interactive surfaces are represented mainly by backend-specific string IDs and process-local placement maps. Stop and shutdown paths do not use a durable non-reused ownership token. Some cleanup errors are intentionally swallowed. There is no global recovery state that blocks dispatch while process or surface ownership is ambiguous.

### 16. Herdr reporting is not the specified acknowledged telemetry channel

The package has direct Herdr adapter error handling and placement ownership, but it does not implement the complete specification's acknowledged child-state protocol, durable degraded or unknown status, and strict separation between advisory telemetry and cleanup authorization across parent crashes and reloads.

### 17. No generation lease, activation lock, or containment protocol

The package has no managed-generation startup lease, shared global dispatch lock, transaction-owned validation mode, quiescence acknowledgement, containment state, or generation-aware request rejection. Existing parent and child processes can continue without knowledge of a `pi-config` activation transaction.

### 18. Current tests do not prove the required platform boundaries

The ordinary suite is broad and green, and it includes useful real subprocess and fake terminal coverage. It does not prove:

- canonical external schema loading and compatibility rejection;
- a common per-request gate, including verifier backend calls, or effective provider receipts;
- ambient resource discovery and freeform-flag suppression against a generation manifest;
- credential-blind native tools;
- read-only or writer filesystem confinement, including pre-launch shell task expansion;
- environment, IPC, network, process-memory, or descendant isolation;
- repository/worktree leases across independent parents;
- durable pilot attempt races and rollback behavior;
- integrity-bound resume and revocation;
- stable process and terminal ownership across crashes;
- generation locking, quiescence, containment, or transaction-owned validation.

The live scripts are opt-in and were not run for this report. Fake mux and process seams remain useful unit evidence but cannot establish the required host and provider behavior by themselves.

## Baseline assessment by specification boundary

| Boundary | Baseline status | Summary |
| --- | --- | --- |
| hard-coded role/class rejection | Partially supported | Rejects many malformed or mismatched `pilot-*` requests, but other agent names bypass routing |
| canonical policy schema | Missing | No external versioned contract or schema compatibility |
| initial role authorization | Contradicted | Frontier and interactive routes can resolve, and pilot children can receive recursive spawn grants |
| exact normal-role fixed routes | Partially supported | Source selection matches, but later freeform flags can replace the effective route |
| exact frontier routes | Contradicted | Wrong provider path and effort, and roles are enabled |
| common request gate | Missing | Policy is launch-time only and verifier calls use a separate direct backend path |
| immutable resource inventory | Missing | Ambient and mutable discovery plus freeform overrides remain available |
| credential-blind tool execution | Missing | Tools share child runtime and OS authority |
| read-only confinement | Missing | Tool naming and prompts do not prevent writes |
| writer confinement and lease | Missing | Optional verifier worktrees are not a general sandbox or lease |
| durable pilot attempts | Missing | No case registry or consumption ledger |
| immutable revocation-aware resume | Missing | Plain mutable session metadata, no current-policy intersection |
| process and terminal lifecycle | Partially supported | Strong operational features, but no durable stable ownership protocol |
| fail-closed generation lifecycle | Missing | No generation, activation, containment, or recovery integration |
| commit-bound package evidence | This report only | Baseline identity and ordinary validation are now recorded; implementation conformance remains future work |

## Implementation ownership and stop gate

This report records gaps only. It deliberately makes no enforcement change.

Fork-owned enforcement remains in Drover-Insights/pi-subagents#3 through #8. A separate completed-implementation conformance report is owned by Drover-Insights/pi-subagents#9. `pi-config` owns the canonical schema, generation, installer, parent enforcement, promotion record, and activation protocol.

No fork enforcement implementation ticket should begin until this report has been reviewed. Review should confirm at minimum:

1. the baseline commit and validation result are reproducible;
2. the capability inventory does not confuse operational controls with security confinement;
3. every material conflict with pi-config#11 is represented;
4. no proposed fix crosses the repository ownership boundary; and
5. the report itself changes documentation only.
