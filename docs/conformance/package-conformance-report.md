# pi-subagents managed-generation conformance report

## Purpose and authority

This report satisfies Drover-Insights/pi-subagents#9. It is the completed-implementation conformance report that Drover-Insights/pi-config#11 requires before `pi-config` accepts a fork identity for generation staging and promotion. It follows the baseline in `BASELINE-CAPABILITY-GAP-REPORT.md` and covers the enforcement built in Drover-Insights/pi-subagents#3 through #8.

The report is release evidence. It is not a runtime policy input and changes no runtime behavior.

## Package identity

| Item | Value |
| --- | --- |
| Package repository | `git:github.com/Drover-Insights/pi-subagents` |
| Package version | `2.9.1` |
| Conformance input | `managed-generation-conformance.json` at the checkout root |
| Report `package.commit` | `HEAD`: the clean checkout commit pi-config's stager validates and pins |

Validated commit: `pending`

The validated commit is the exact clean fork commit on which the test command below was run. The report commit follows it and changes only the conformance artifacts. While the validated commit reads `pending`, this report covers no commit, and the conformance input's `test.result` is `pending`, which pi-config's stager refuses. A commit is covered by this report only when this binding check exits 0 in a clean checkout of it, with `<validated>` replaced by the commit above:

```sh
git merge-base --is-ancestor <validated> HEAD &&
git diff --quiet <validated> HEAD -- ':/' ':(top,exclude)managed-generation-conformance.json' ':(top,exclude)docs/conformance'
```

The check fails closed: any change outside the conformance artifacts after the validated commit, including a merge that brings in other work, means the recorded result no longer covers that commit, and the tests must be rerun and this report re-recorded.

Land the validated commit and the report commit with a merge commit or a fast-forward, never a squash, so the validated commit stays reachable. Pin the report commit itself, or a later commit that passes the binding check; a merge commit passes only when the default branch had not moved since the validated commit.

pi-config's stager reads only `managed-generation-conformance.json`; it trusts `test.result` and neither reads this file nor runs the binding check. The binding is therefore enforced by the review below, not by staging.

## Supported policy schema

`supportedPolicySchema` is `3..3`. It equals `CHILD_RUNTIME_SCHEMA_RANGE` in `src/routing/canonical-policy.ts`, the range the canonical policy parser enforces for the child runtime. `test/routing/canonical-policy.test.ts`: "rejects a schema version or child runtime range this package cannot read" proves schemas outside it are rejected.

## Resource-loading contract

- The package loads through Pi's package autoload, with no extension filter (`extensionLoading.autoload: true`).
- `package.json` declares the one Pi extension, `src/index.ts`. The conformance input lists both files with their sha256.
- A policy-managed child loads exactly: the completion helper `src/tools/subagent-done.ts` (pinned by pi-config's `extensionCatalog["subagent-completion"]`), then the workspace boundary, then the role's extension grant in declared order. Extension, context-file, Skill, prompt-template and theme discovery and project-local resources are disabled. `extension-allowlist.md` holds the evidence.

## Checksum binding

`managed-generation-conformance.json` records the sha256 of every listed resource and evidence file. pi-config's stager verifies each one against the committed blob of the pinned commit. Inside this repository, `test/conformance/managed-generation-conformance.test.ts` keeps the conformance input true to the tree: its exact shape, its schema range against the code, every hash, the required evidence ids, and that every test cited here exists, is run by the test command, and still has the cited title.

| Evidence id | File |
| --- | --- |
| `package-conformance-report` | `docs/conformance/package-conformance-report.md` (this file) |
| `extension-allowlist` | `docs/conformance/extension-allowlist.md` |
| `writer-confinement` | `docs/conformance/writer-confinement.md` |
| `resume-narrowing` | `docs/conformance/resume-narrowing.md` |
| `tool-broker` | `docs/conformance/tool-broker.md` |
| `pilot-attempts` | `docs/conformance/pilot-attempts.md` |

## Test command and results

The exact complete test command is:

```sh
npx tsc --noEmit && npm test
```

It is the repository's validation gate (`AGENTS.md`), with `npx` in place of `bunx` because the validation host has no Bun; both run the `typescript` devDependency.

Results: pending

The recorded result covers only the tests that ran. Some cited suites skip on a host without bubblewrap (`/usr/bin/bwrap`) or Python, and `node --test` still exits 0, so the run lists every skipped test below; a result in which any cited test was skipped does not support that test's claim.

## Evidence classes

Each boundary document, and each requirement section below, sorts its negative evidence into these classes:

- **Expected rejection**: a request the policy or contract forbids is refused before any child process, session, lease or attempt exists, with a reason that names what was refused.
- **Operational failure**: the host or its state cannot support a safe launch (no sandbox, unreadable record, a spawn that throws, a CLI that cannot report its version). The package fails closed and visibly, and keeps leases and attempts held or consumed when it cannot prove nothing ran.
- **Enforcement breach**: an attempt to get around a boundary (altered bytes, a shadowing definition, smuggled fields, sandbox escapes, forged session metadata, racing processes). Each test asserts the attempt stays contained; a failure of any of them is an enforcement breach and blocks this report.

Other sections, such as **Enforced behaviour** below and **Exact resources** or **Pilot accounting** in the boundary documents, hold positive evidence: the enforced behaviour itself on an authorized path.

## Requirement matrix

| Requirement | Classes | Evidence |
| --- | --- | --- |
| Policy enforcement | enforced behaviour, expected rejection, operational failure | below; `extension-allowlist.md` |
| Request enforcement | enforced behaviour, expected rejection, enforcement breach | below; `resume-narrowing.md` |
| Exact resources | enforcement breach | `extension-allowlist.md` |
| Effective routes and effort | enforced behaviour, expected rejection | below |
| No fallback | expected rejection, operational failure | below |
| Credential-blind tools | enforcement breach | `tool-broker.md` |
| Read-only confinement | enforcement breach | `tool-broker.md`, `writer-confinement.md` |
| Writer isolation | expected rejection, operational failure, enforcement breach | `writer-confinement.md` |
| Execution-group leases | operational failure, enforcement breach | `writer-confinement.md` |
| Pilot accounting | expected rejection, operational failure, enforcement breach | `pilot-attempts.md` |
| Resume revocation | expected rejection | `resume-narrowing.md` |
| Lifecycle ownership | operational failure, enforcement breach | `resume-narrowing.md` |
| Terminal ownership | enforcement breach | `resume-narrowing.md` |
| Visible failures | expected rejection, operational failure | below |

### Policy enforcement

Enforced behaviour:

- `test/routing/canonical-policy.test.ts`: "loads the canonical policy from the Pi agent directory as an immutable contract"
- `test/trusted-launch/launcher.test.ts`: "composes with policy-bound authorization"

Expected rejection:

- `test/routing/canonical-policy.test.ts`: "rejects enforcement-affecting unknown and missing fields"
- `test/routing/canonical-policy.test.ts`: "rejects operational states this package cannot enforce"
- `test/routing/tool-policy.test.ts`: "rejects Controller children and disabled roles"
- `test/routing/tool-policy.test.ts`: "one rejected child rejects the whole batch before any child launches"
- `test/routing/tool-policy.test.ts`: "rejects managed definitions that grant recursive spawning or freeform flags"

Operational failure:

- `test/routing/tool-policy.test.ts`: "an invalid canonical policy rejects every child launch before any launch"

### Request enforcement

Enforced behaviour:

- `test/runtime/managed-child-requests.test.ts`: "lets a timeout wrap-up request through while the launch authority still holds"

Expected rejection:

- `test/routing/tool-policy.test.ts`: "requires a capability class the role grants, without normalization"
- `test/routing/tool-policy.test.ts`: "rejects interaction modes the role does not permit, judged on the effective launch mode"

Enforcement breach (attempts that must stay contained):

- `test/routing/tool-policy.test.ts`: "strips a smuggled policy launch from model-callable input"
- `test/routing/tool-policy.test.ts`: "strips a smuggled effective cwd and trusted provenance from model-callable input"
- `test/routing/tool-policy.test.ts`: "authorizes the mode the child launches in, not a smuggled background field"
- `test/routing/tool-policy.test.ts`: "rejects managed definitions that redirect the child runtime through env or cwd"

### Effective routes and effort

Enforced behaviour:

- `test/routing/tool-policy.test.ts`: "an authorized pilot launch reserves its attempt and carries the policy launch and route evidence"
- `test/routing/tool-policy.test.ts`: "routes each capability class of a multi-route role to its own fixed route"
- `test/launch/policy-launch.test.ts`: "loads exactly the verified inventory with every discovery path disabled"

Expected rejection:

- `test/routing/tool-policy.test.ts`: "rejects caller model and thinking overrides for managed roles"
- `test/routing/canonical-policy.test.ts`: "rejects guardrails, efforts, and interaction grants the contract forbids"
- `test/routing/canonical-policy.test.ts`: "rejects pilot cases whose route differs from the role's fixed route"

### No fallback

Expected rejection:

- `test/routing/tool-policy.test.ts`: "rejects a route whose provider is neither built into Pi nor defined in models.json"
- `test/trusted-launch/resume.test.ts`: "refuses a mismatched directory without falling back to an ordinary resume"
- `test/trusted-launch/terminate.test.ts`: "never falls back to a name or another run when the runtime id is not owned here"

Operational failure:

- `test/routing/tool-policy.test.ts`: "a host that cannot provide the tool sandbox rejects every managed launch before any launch"
- `test/routing/writer-launch.test.ts`: "a host that cannot confine a writer rejects it before any child or lease exists"

### Visible failures

Expected rejection:

- `test/routing/tool-policy.test.ts`: "a missing or altered catalogued extension file rejects the whole call before any launch"
- `test/runtime/managed-lifecycle.test.ts`: "leaves the process untouched and says why when the ownership token does not revalidate"

Operational failure:

- `test/runtime/managed-lifecycle.test.ts`: "leaves a refused stop untouched: the watcher, the slot and the record stay, and the caller is told"
- `test/runtime/managed-recovery.test.ts`: "leaves a child whose stop is refused untouched at parent exit, and reports it"
- `test/runtime/background-watch.test.ts`: "shows the parent the child's stderr when it exited before its prompt reached the model"
- `test/trusted-launch/launcher.test.ts`: "does not claim a child was stopped when stopping it failed"
- `test/trusted-launch/terminate-contract.test.ts`: "reports a malformed terminator response as unknown, never as an end"
- `test/routing/pilot-attempt-store.test.ts`: "an unreadable reservation counts as consumed and is reported"

## Not covered by the recorded command

The test command runs no live model provider and opens no real terminal multiplexer pane. Interactive pane placement and the live end-to-end behaviour exercised by the `test:e2e-live-*`, `test:frontmatter-*` and `test:live-herdr-*` scripts are outside this report's recorded result and are not claimed here. Process-level ownership and termination are covered with real process groups (`test/trusted-launch/terminate-lifecycle.test.ts`), and exact resource loading with the real `pi` binary against a local fake provider (`test/launch/real-pi-launch.test.ts`).

## Separation from pi-config

No implementation or report content here is sourced from or written into `pi-config`. The only input taken from it is the conformance input's shape and required evidence ids, read from its stager (`scripts/stage-managed-generation.mjs`) and `docs/managed-generations.md`; every claim and citation above comes from this repository's code and tests. Nothing in this change writes outside this repository.

## Review before acceptance

`pi-config` must not accept or stage this fork identity until this report's pull request has been reviewed and merged, and the reviewer has run the binding check above against the commit to be pinned and recorded that commit's full sha and the check's exit status in a review comment on that pull request. pi-config's acceptance cites that comment.
