# Product areas

The area map for this repo. `code-review-chain` labels deferred findings from it, and the next-work rule answers "what's next for <area>?" from it.

## Schema

Each area lists one or more tracker labels, each with its path globs; the area covers the union of those globs. A file path matches at most one area. A label belongs to exactly one area. Never map a triage category, state, priority, or pull-request label to an area. An issue is in an area when it carries any of the area's labels, unless milestone wins places it elsewhere.

A feature milestone's description starts with `Area: <area>` and `Priority: P1|P2|P3`, naming one area below. Milestone wins: an issue in an open milestone is in that milestone's `Area:` only, whatever its labels. Its labels still record where the code lives.

## Glob dialect

Every glob in this map, label globs and risky path globs alike, uses this dialect.

- Paths are POSIX, relative to the repository root, with no leading `./`. Matching is case-sensitive.
- `*` matches within one path segment; `**` matches zero or more whole segments, but a trailing `/**` needs at least one segment after it, so `src/crm/**` does not match `src/crm` itself.
- `?`, `[...]`, and `{a,b}` behave as in Node's `path.matchesGlob`, which is the reference matcher for everything except dot-named segments.
- The wildcard characters are `*`, `?`, `[`, and `{`.
- Negation (`!`) and extglob patterns are not part of the dialect and must not be used.
- Unlike in Node, wildcards also match dot-named segments, so `.github/**` and `**/*.yml` cover `.github/workflows/a.yml`, and `src/**` covers `src/.config/a.ts`. `?` and `[...]` never match a segment's leading dot, so a glob meant to match a dot-named segment by its leading character writes that dot literally (`.env*`, not `?env`).

| Glob | Path | Matches |
|---|---|---|
| `src/crm/*` | `src/crm/meetings/page.tsx` | no |
| `src/crm/**` | `src/crm/meetings/page.tsx` | yes |
| `**/*.yml` | `.github/workflows/a.yml` | yes |
| `.env*` | `.env.local` | yes |
| `src/crm/**` | `src/crm` | no |
| `src/**` | `src/.config/a.ts` | yes |
| `?env` | `.env` | no |

## Areas

### Trust and authority

| Label | Path globs |
|---|---|
| `area:trust` | `src/trusted-launch/**`, `src/routing/**`, `src/spawn/**` |

### Child launch

| Label | Path globs |
|---|---|
| `area:launch` | `src/launch/**`, `src/agents/**` |

### Runtime and sessions

| Label | Path globs |
|---|---|
| `area:runtime` | `src/runtime/**`, `src/session/**`, `src/subagents.ts`, `src/index.ts`, `src/types.ts`, `src/artifact-storage.ts`, `src/auto-exit.ts` |

### Tools

| Label | Path globs |
|---|---|
| `area:tools` | `src/tools/**` |

### Multiplexers

| Label | Path globs |
|---|---|
| `area:mux` | `src/mux/**`, `src/mux.ts` |

### Verification fleet

| Label | Path globs |
|---|---|
| `area:verification` | `src/vf/**` |

## Risky path globs

A pull request that touches any of these globs, or fixes an issue carrying the label mapped to the `P1` role, is opened without auto-merge, and the user merges it. Other pull requests get auto-merge only when the readiness flag in `docs/agents/issue-tracker.md` says `yes`. While this list names no glob, every pull request counts as risky. List this repo's globs for migrations, auth, billing, RLS or tenant scoping, permissions, and secrets handling.

- `src/trusted-launch/**`
- `src/routing/**`
- `src/spawn/policy.ts`
- `src/launch/policy.ts`
- `src/tools/policy.ts`
- `src/tools/tool-names.ts`
- `src/runtime/orchestrator-policy.ts`
- `src/launch/child-env.ts`
- `src/launch/env-capsule.ts`
- `src/launch/env.ts`
- `src/launch/prep.ts`
- `src/launch/child-command.ts`
- `src/launch/background.ts`
- `src/launch/resume*.ts`
- `src/launch/extensions.ts`
- `src/runtime/resume-service.ts`
- `src/tools/subagent-routing.ts`
- `src/tools/subagent-launch.ts`
- `src/vf/apply.ts`
- `src/vf/worktrees.ts`
- `src/vf/run/launch.ts`
- `src/vf/supervisor/main.ts`
- `src/vf/verifier/bridge.ts`
- `package.json`
- `bun.lock`
