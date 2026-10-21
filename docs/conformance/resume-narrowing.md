# Boundary evidence: resume narrowing

Part of the managed-generation conformance report; see `package-conformance-report.md` in this directory for identity, test command, results and evidence classes.

## Claim

A managed child resumes only from the authority snapshot its launch recorded in the trusted state store, never from metadata the child appended to its own session. A resume narrows extensions and tools to what the current policy and definition still grant, and never widens them. A widening or unverifiable resume, a writer resume, a resume of an expired pilot case, and a resume whose recorded directory now leads elsewhere are refused before any child process exists. Parent-authorized requests to a running managed child are blocked once the launch authority (generation, route, grants, pilot case) has changed. Every stop and resume is gated on revalidated ownership.

## Expected rejection

- `test/runtime/managed-resume.test.ts`: "refuses every widening or unverifiable resume before any child process exists"
- `test/runtime/managed-resume.test.ts`: "refuses to resume a writer, whose lease authorized a single launch"
- `test/runtime/managed-resume.test.ts`: "refuses a managed session the parent never recorded a snapshot for"
- `test/runtime/managed-resume.test.ts`: "refuses to resume a pilot launch once its case expired"
- `test/runtime/managed-resume.test.ts`: "refuses a resume whose recorded working directory now leads elsewhere"
- `test/runtime/managed-child-requests.test.ts`: "refuses to resume a managed child whose launch recorded no authority snapshot"
- `test/trusted-launch/resume-authority.test.ts`: "refuses a directory whose access was revoked"
- `test/trusted-launch/resume.test.ts`: "refuses a mismatched directory without falling back to an ordinary resume"

## Resume revocation

- `test/runtime/managed-child-requests.test.ts`: "blocks a timeout wrap-up request after the policy generation changed"
- `test/runtime/managed-child-requests.test.ts`: "blocks a timeout wrap-up request after the role's route or state changed"
- `test/runtime/managed-child-requests.test.ts`: "blocks a timeout wrap-up request after the role's grants or interaction modes changed"
- `test/runtime/managed-child-requests.test.ts`: "blocks a timeout wrap-up request after the pilot case expired"
- `test/runtime/managed-resume.test.ts`: "narrows extensions to what the current policy still grants, keeping safety resources"
- `test/runtime/managed-resume.test.ts`: "narrows tools to what the current definition still grants and never widens them"
- `test/runtime/managed-resume.test.ts`: "narrows to the current definition: refuses a disabled one, applies its deny-tools, and keeps tool name case"

## Operational failure

- `test/runtime/managed-lifecycle.test.ts`: "refuses to resume when the latest owner record cannot be read"
- `test/runtime/managed-lifecycle.test.ts`: "releases the claim of a resume that failed before its child started, so a retry can run"
- `test/runtime/managed-recovery.test.ts`: "lists a session whose snapshot no longer verifies"
- `test/runtime/managed-recovery.test.ts`: "keeps a session blocked after a parent died between claiming and recording a generation"

## Enforcement breach (attempts that must stay contained)

- `test/runtime/managed-resume.test.ts`: "resumes from the snapshot alone, ignoring launch metadata the child appended to its session"
- `test/runtime/managed-resume.test.ts`: "refuses an alias session that has no snapshot even when only a non-metadata entry names its agent"
- `test/runtime/managed-lifecycle.test.ts`: "finds the snapshot through a symlinked session path, so an alias cannot resume unmanaged"
- `test/runtime/managed-lifecycle.test.ts`: "lets exactly one of two concurrent resumes of a session start a child"
- `test/runtime/managed-lifecycle.test.ts`: "refuses to resume while an earlier generation's group survives its exited leader"
- `test/trusted-launch/resume-authority.test.ts`: "refuses a session that gained a later launch metadata entry"

## Lifecycle ownership

- `test/trusted-launch/resume.test.ts`: "a disposed descriptor refuses to resume"
- `test/runtime/managed-lifecycle.test.ts`: "records the launch's durable owner: its token and its process's stable identity"
- `test/runtime/managed-lifecycle.test.ts`: "stops a managed child whose ownership revalidates"
- `test/runtime/managed-lifecycle.test.ts`: "leaves the process untouched and says why when the ownership token does not revalidate"
- `test/runtime/managed-lifecycle.test.ts`: "refuses a recorded pid whose kernel start time differs, as after pid reuse"
- `test/runtime/managed-lifecycle.test.ts`: "never signals a reaped leader's pid once another process holds it"
- `test/runtime/managed-recovery.test.ts`: "lists an orphan, a child still running after its parent died, and keeps its resume blocked"

## Terminal ownership

- `test/trusted-launch/terminate.test.ts`: "stops exactly the named run once and reports terminated once its group is proven gone"
- `test/trusted-launch/terminate.test.ts`: "never falls back to a name or another run when the runtime id is not owned here"
- `test/trusted-launch/terminate.test.ts`: "takes its launch identity from what the runtime recorded, never from the child-writable session file"
- `test/trusted-launch/terminate-contract.test.ts`: "accepts only exact trusted identities, never a pid, pane, name, or free text"
- `test/trusted-launch/terminate-lifecycle.test.ts`: "ends only the exact run, leaves unrelated runs and sessions running, then reports it already terminal"
- `test/runtime/managed-recovery.test.ts`: "closes only the surface a managed child's snapshot recorded"
- `test/trusted-launch/extension-wiring.test.ts`: "publishes a terminate that stops only runs this session owns, through its own stop path"
