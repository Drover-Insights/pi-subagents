# Boundary evidence: pilot attempts

Part of the managed-generation conformance report; see `package-conformance-report.md` in this directory for identity, test command, results and evidence classes.

## Claim

A pilot role launches only for a named, matching, unexpired pilot case. Each launch reserves an attempt in a durable store with a write-once route receipt before the child starts, then commits it. Exhausted cases, replayed launch ids and crash states never yield an extra attempt. Consumption is keyed by case id and survives a generation change and rollback. A refund happens only with proof the child never ran.

## Expected rejection

- `test/routing/tool-policy.test.ts`: "a pilot role launches only for a named, matching, unexpired pilot case"
- `test/routing/pilot-attempt-launch.test.ts`: "an exhausted case rejects the launch and consumes nothing more"
- `test/routing/pilot-attempt-launch.test.ts`: "a replayed launch id launches nothing and is counted once, even when attempts remain"
- `test/routing/pilot-attempt-launch.test.ts`: "a missing Controller model is a preflight rejection that writes nothing"
- `test/routing/pilot-attempt-launch.test.ts`: "a route provider with no runtime identity is a preflight rejection that writes nothing"
- `test/routing/pilot-attempt-store.test.ts`: "reserves at most the allowed attempts and refuses the next as exhausted"
- `test/routing/pilot-attempt-store.test.ts`: "a replayed launch id is refused even after its reservation was refunded"

## Operational failure

- `test/routing/pilot-attempt-launch.test.ts`: "a Claude route whose CLI cannot report its version is a preflight rejection"
- `test/routing/pilot-attempt-launch.test.ts`: "a failed launch without proof it never started stays consumed for recovery; later siblings are refunded"
- `test/routing/pilot-attempt-launch.test.ts`: "a confined bootstrap that may still run stays consumed for recovery"
- `test/routing/pilot-attempt-store.test.ts`: "crash states count as consumed: no outcome, an empty outcome, a garbage outcome, stray temporary files"
- `test/routing/pilot-attempt-store.test.ts`: "an unreadable reservation counts as consumed and is reported"
- `test/routing/pilot-attempt-store.test.ts`: "a gap in the reservation numbers makes the store unavailable rather than reusing a number"

## Enforcement breach (attempts that must stay contained)

- `test/routing/pilot-attempt-launch.test.ts`: "no tool sandbox can be rooted in the store, and no sandboxed tool can write its records"
- `test/routing/pilot-attempt-store.test.ts`: "a handle from another reservation cannot settle this one"
- `test/routing/pilot-attempt-store.test.ts`: "a case record that changed under the same case id is refused and writes nothing"
- `test/routing/pilot-attempt-store.test.ts`: "the store refuses directories other users can reach or that are symlinks"
- `test/routing/pilot-attempt-store.test.ts`: "a reservation record linked by hand under a used number is never overwritten"
- `test/routing/pilot-attempt-store.test.ts`: "concurrent processes never reserve more than the allowed attempts"

## Pilot accounting

- `test/routing/pilot-attempt-launch.test.ts`: "a pilot launch reserves its attempt with a write-once receipt, then commits it"
- `test/routing/pilot-attempt-launch.test.ts`: "consumption survives a generation change and a rollback to the earlier generation"
- `test/routing/pilot-attempt-launch.test.ts`: "a Claude route records the Claude CLI and the non-secret instance identity in the receipt"
- `test/routing/pilot-attempt-store.test.ts`: "a refunded attempt frees one reservation; a committed one never does"
- `test/routing/pilot-attempt-store.test.ts`: "the receipt is written in the reservation and never rewritten"
- `test/routing/tool-policy.test.ts`: "reserves pilot attempts only after every child of the call is authorized"
- `test/runtime/managed-resume.test.ts`: "resumes a pilot launch under its committed launch id, consuming and restoring nothing"
- `test/trusted-launch/launcher.test.ts`: "reserves and commits a pilot attempt under the trusted request id, and refuses its replay"
