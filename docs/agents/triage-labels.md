# Triage Labels

The skills speak in terms of two category roles, five state roles, three priority roles with an optional fourth, `P0`, and one pull-request role. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in Drover skills     | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `bug`                      | `bug`                | A defect or regression                   |
| `enhancement`              | `enhancement`        | A new or improved capability             |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| `P1`                       | `P1`                 | Confirmed high or critical severity      |
| `P2`                       | `P2`                 | Plausible high or critical, or confirmed medium |
| `P3`                       | `P3`                 | Everything else                          |
| `needs-agent`              | `needs-agent`        | Pull request taken off auto-merge after a conflict or failed required check |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. Every triaged request must have exactly one category label: the mapping for `bug` or the mapping for `enhancement`, never both. Filed findings, the deferred review findings that `code-review-chain` files as issues, also carry exactly one priority label. Only `code-review-chain` assigns them. Triage preserves them. Noted findings, the P3 and judgment findings it does not file, get no issue and no labels: their priority stays in the deferred-findings record and the review report. The `needs-agent` label marks pull requests only, never issues: it is the failure queue of the update workflow, and the `needs-agent:` comment is the event record. The `ready-for-human` label may also mark a pull request that `needs-agent` recovery capped after three recovery attempts; it stays the one state role, not a second pull-request role. The `P0` priority role is optional and ranks above `P1`: add a `P0` row only when the tracker ranks some issues above P1. Without it, nothing ranks above P1, and a milestone's `Priority: P0` line is flagged and ranks as P3. Every right-hand-column mapping, the optional `P0` row included, must be pairwise distinct across category, state, priority, and pull-request roles. Reject any customization that reuses a mapped label.

Edit the right-hand column to match whatever vocabulary you actually use.
