# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: write title and body to `TITLE_FILE` and `BODY_FILE` with a non-shell write operation, then run `gh issue create --title "$(cat "$TITLE_FILE")" --body-file "$BODY_FILE"`.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments --jq '{number, title, body, labels: [.labels[].name], comments: [.comments[].body]}'`. `--jq` filters only `--json` output; `--comments` alone prints formatted text that `jq` cannot parse.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: write comment text to `COMMENT_FILE`, then run `gh issue comment <number> --body-file "$COMMENT_FILE"`.
- **Apply / remove labels**: `gh issue edit <number> --add-label <label>` / `--remove-label <label>`
- **Close with an explanation**: write the explanation to `COMMENT_FILE`, post it with `gh issue comment <number> --body-file "$COMMENT_FILE"`, then close separately with `gh issue close <number>`.

Never put issue-derived title, body, comment, or note text directly in a shell command literal or
heredoc. An attacker-controlled line can terminate a heredoc delimiter. Use the harness's file-write
operation to create `TITLE_FILE`, `BODY_FILE`, and `COMMENT_FILE`, then pass those files to `gh`.
Command-substitution output is not reparsed by the shell. Never use `eval` or construct a shell
command from issue-derived text.

Run `gh` from the current repository and let it infer the repository automatically. Never print
or inspect raw remote URLs.

Exception: the `autopilot` skill's lane driver, `run-lane.mjs`, pins the repository at start,
before any session runs, because a session can edit the git and gh config that inference reads.
It has gh resolve origin's fetch and push URLs without printing them, then names that repository
in every `gh` call and pushes to the pinned push URL. It files deferred
findings through `file-findings.mjs`, which names the repository its caller pins with `--repo`
in every `gh` call.

The `reap-worktree` skill's merged-worktree sweep, `reap-merged.sh`, and its open-PR guard in the
linked-worktree retirement block hold the same exception for their pull-request lookups, because
gh's default repository may not be the one whose `origin` refs they check. Both run
`scripts/origin-repo.sh`, which reads origin's fetch URL without printing it, drops any
credentials, maps an ssh host alias, and has gh resolve the URL; they name that repository in
each lookup. When it cannot be resolved, they run no lookup.

Everything else, including next work, keeps letting gh infer the repository.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Auto-merge readiness

**Auto-merge ready:** no

_(`build-ticket` reads this flag. When the line is absent or its value is anything but `yes`, agents never enable auto-merge and the user merges every pull request by hand.)_

Set it to `yes` only after every condition below holds:

- the repository's CI checks are required, and they include its test suite; with migrations, they also include the migration-order check, a migration apply from scratch, and the generated-types check
- "require branches to be up to date" and "allow auto-merge" are on
- the update workflow has passed its acceptance test
- the update workflow skips `ready-for-human` PRs
- the build proof status is required: branch protection requires the `drover/build-proof` status

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`outrider`/`task` for new tickets). Existing `wayfinder:grilling` labels are a legacy alias for `outrider`: include both in discovery and frontier queries, and resolve both with `outrider` plus `domain-modeling`. Do not relabel or rewrite existing tickets or migrate tracker data automatically. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/{owner}/{repo}/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/{owner}/{repo}/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). `gh issue view` does not render dependencies: read blockers with `gh api --paginate 'repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by'`, and keep any prose `Blocked by` line mirroring the native dependencies. Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: write the answer to `COMMENT_FILE`, then run `gh issue comment <n> --body-file "$COMMENT_FILE"` and `gh issue close <n>` separately, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Next work

Answer "what's next for <area>?" with this order, so every harness gives the same answer. `<area>` is an area in `docs/agents/product-areas.md`, or `Unassigned`. Use the label strings that `docs/agents/triage-labels.md` maps to the `needs-agent`, `ready-for-agent`, and priority roles, and substitute them for `needs-agent` and `ready-for-agent` in the reads below.

**Area membership.** Milestone wins: an issue in an open milestone is in the area named by the milestone description's `Area:` line only, whatever its labels. An open milestone whose description has no `Area:` line, more than one, or one that names no area in `docs/agents/product-areas.md`, places its issues and PRs in `Unassigned`, and every answer flags the milestone. Any other issue is in an area when it carries any of that area's labels. A pull request copies the area labels and milestone of the issue it closes, so the same rule places it. `Unassigned` is a queryable area: every ready issue and `needs-agent` PR that these rules place in no named area. Without `docs/agents/product-areas.md`, there are no named areas: every issue and PR is in `Unassigned`, and no milestone is flagged for its `Area:` line.

**Reads.** Read every match: `--paginate` follows every page, so never stop at a default list limit. When the `needs-agent` PR read or the ready-issue read fails on any page, give no ordering: report the failed read instead of answering from a partial list. A failed capacity read, the assigned-issue read included, keeps the ordering and makes every lane head's capacity `UNKNOWN`, as under Build-scope capacity. A failed blocker read skips only its issue, as below. When a PR's details read fails, it waits with reason `read-failed` and the answer reports the failed read; ready issues are still ordered. `gh` fills in `{owner}/{repo}` from the current repository.

- The label map and area map, from the default branch's tip, never from the local checkout, so a stale worktree gives current answers: `gh api repos/{owner}/{repo}/contents/docs/agents/<file> -H 'Accept: application/vnd.github.raw'` for `triage-labels.md`, then `product-areas.md`. A 404 for `product-areas.md` means the repository has no area map. Any other failure, or an area map that maps a label to two areas, repeats an area, names an area `Unassigned`, keeps the template's placeholder area or label, or names no area, gives no ordering.
- Wayfinder maps: `gh api --paginate 'repos/{owner}/{repo}/issues?state=all&labels=wayfinder:map&per_page=100' --jq '.[] | .number'`. When it fails, give no ordering.
- `needs-agent` PRs: `gh api --paginate 'repos/{owner}/{repo}/issues?state=open&labels=needs-agent&per_page=100' --jq '.[] | select(.pull_request) | {number, labels: [.labels[].name], milestone: (.milestone | if . then {number, state, description} else null end)}'`
- Details of each `needs-agent` PR in the area: `gh pr view <number> --json isCrossRepository,headRefOid`, and its comments, oldest first: `gh api --paginate 'repos/{owner}/{repo}/issues/<number>/comments?per_page=100' --jq '.[] | .body | @json'`, one JSON string per comment.
- Ready, unassigned issues: `gh api --paginate 'repos/{owner}/{repo}/issues?state=open&labels=ready-for-agent&assignee=none&per_page=100' --jq '.[] | select(.pull_request | not) | {number, body, parent_issue_url, labels: [.labels[].name], milestone: (.milestone | if . then {number, state, description} else null end)}'`
- Blockers of each ready issue in the area: `gh api --paginate repos/{owner}/{repo}/issues/<number>/dependencies/blocked_by --jq '.[] | {repository: .repository.full_name, number, state, state_reason, closed_at}'`. A blocker is closed as completed when `state` is `closed` and `state_reason` is `completed`. Each ordered issue carries its last blocker to close, by `closed_at`, or none when it has no native blocker.
- Open dependents of each ready issue in the area, and of each dependent in turn, for the lane view: `gh api --paginate repos/<repository>/issues/<number>/dependencies/blocking --jq '.[] | select(.state == "open") | select(.pull_request | not) | {repository: .repository.full_name, number, title}'`. For a ready issue, `<repository>` is `{owner}/{repo}`; for a dependent, it is the `repository` the previous read returned for it.
- Assigned open issues, including non-ready ones, for current claim holds: `gh api --paginate 'repos/{owner}/{repo}/issues?state=open&assignee=*&per_page=100'`. A failed or incomplete read cannot establish free capacity.
- All open pull requests, including drafts, with every page of their structured `closingIssuesReferences`, and current issue metadata for each same-repository closing reference. A zero-reference or foreign-only PR holds no local issue. An incomplete page, GraphQL response error, missing linked issue, or unresolved repository identity makes capacity unknown, never free. The one exception is a `FORBIDDEN` null closing-reference node: the login can read this repository, so that node is foreign and holds nothing. Branch names and PR body text are not capacity associations.

**Order.**

1. Open `needs-agent` PRs in the area that recovery can take, whatever their assignee, oldest PR number first. A `needs-agent` PR waits on a human instead when it comes from a fork, reason `fork`; when its latest `needs-agent:` comment is a recovery stop naming its current head commit, reason `recovery-stopped`; or when its details cannot be read, reason `read-failed`. A fork is `fork` whatever its comments. A comment is a `needs-agent:` comment when its body starts `needs-agent:` after any leading whitespace, and a recovery stop when it starts `needs-agent: recovery stopped <sha>`; the stop names the head only when `<sha>` is the full head commit. A stopped PR is takeable again once its head commit changes or a newer `needs-agent:` comment that is not a recovery stop follows the stop; any other comment leaves it waiting.
2. Then open issues in the area that carry `ready-for-agent`, have no assignee, and whose every native blocker is closed as completed.
3. Sort those issues. Issues in an open milestone come first. Rank each milestone by the `Priority:` line in its description, P0, P1, P2, P3, where P0 counts only when the P0 role is mapped; a milestone without exactly one `Priority:` line whose value is a mapped priority role ranks as P3 and is flagged in the answer. Order milestones by that rank, then by milestone number ascending; never use due dates. An issue whose milestone is closed sorts as outside any milestone. Within a milestone, and among issues outside any milestone, sort by the issue's priority label: P0, P1, P2, P3, then no priority, then issue number ascending. An issue with more than one priority label ranks by the highest and is flagged.

**Skip and flag.** List every skipped issue in the answer with its reason.

- A wayfinder map or one of its tickets never heads a lane: skip a ready issue with a `wayfinder:` label, a sub-issue of a wayfinder map (`parent_issue_url`), or an issue whose body starts with `Part of #N` naming a wayfinder map. Planning work is decided on the map, not built from next work.
- When an issue's blockers cannot be read, skip it and say so. The rule fails closed.
- A blocker closed as not planned or duplicate does not count as completed: skip the dependent issue and flag it for re-triage, to retarget the edge to the duplicate's canonical issue or drop it.
- An issue whose body has a prose `Blocked by` list that names an `#N` with no matching native edge in the same repository: skip it and flag it until its edges are recorded natively. This includes a fallback `Blocked by:` line written where native dependencies are unavailable. `None` and review finding IDs such as `R1` never trigger this.

**Claim.** Before starting an issue, assign it: `gh issue edit <number> --add-assignee @me`. Skip assigned issues. Claims are advisory: every session shares one account, so a claim reduces duplicate work but is not a lock. Any agent may take a `needs-agent` PR regardless of its assignee.

**Migrations.** Take a migration issue only when no other open migration issue is assigned. Whether an issue is a migration issue is the agent's judgement.

**Build-scope capacity.** In the public next-work answer, each ready lane head carries a separate `capacity` disposition. `START` means offered by build scope, subject to the independent pending migration launch check. `WAITING` with reason `held` names every claim and open closing-PR holder; `WAITING` with reason `reserved` names the earlier offered ticket. `UNKNOWN` means a capacity read failed and no head is offered. In the JSON answer, each lane carries `capacity`: `{ status: "START" }`, `{ status: "WAITING", reason: "held", holders }` where each holder is `{ kind: "claim", issue }` or `{ kind: "pr", issue, pr }`, plus `reservedBy` when an earlier offered ticket also reserved one of its scopes, `{ status: "WAITING", reason: "reserved", reservedBy }`, or `{ status: "UNKNOWN" }`; an answer with an ordering carries a top-level `migrationGate` stating that the migration check is still pending. An open milestone is its own scope; otherwise all effective areas are scopes, or `Unassigned` if none. Walk eligible heads once in existing rank order: offer only when every scope is free, reserve all scopes of an offer, and never reserve a skipped head. An assigned open issue holds scopes irrespective of state label; an open closing PR holds its linked issue's current scopes even after unassignment or issue closure. Do not treat an issue's own claim or PR as another START offer. Holds are not native blocker edges. Re-read before launch and apply the migration gate independently.

**Lane view.** Show the answer as lanes. List the takeable `needs-agent` PRs first, in the order above, then the waiting ones as waiting on a human, oldest PR number first, each with its reason. Group the lanes by milestone, in the order above: each open milestone in its rank, then one group for issues outside any milestone. Within a group, give one lane per ready issue, in the order above. Beneath each ready issue, list the open issues that wait on it through native blockers, directly or through another dependent, in blocker order: each dependent after every issue it waits on within the lane, ties by issue number ascending. Identify each issue by its repository and number, and write an issue in another repository as `<repository>#N`. List each issue once per lane, and never read the dependents of an issue already listed, so a blocker cycle ends. Read each dependent's blockers with the blocker read above, in the dependent's repository, and mark the dependent `also waits on #N` for every open blocker outside this lane, including another lane's ready issue. A follow-up that waits on several lanes appears under each of them. When an issue's dependents cannot be read, keep the rest of its lane, leave out only that issue's own dependents, and say so. When a dependent's blockers cannot be read, show it unmarked and say so.

Lanes are computed from native dependencies at query time and never stored. A lane carries no predicted files: lanes may touch the same files. A lane expresses blocker order only: its `capacity` disposition under Build-scope capacity decides whether its ready issue is offered to start. The migration rule under Migrations still applies to each lane's ready issue.
