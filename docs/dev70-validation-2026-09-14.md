# DevSpace 1.1.59 dev70 validation — 2026-09-14

## Why dev70 is required

The dev69 real Host-cutoff test proved that the automatic recovery chain can
cross a genuine ChatGPT Host turn boundary without a simulated timeout:

- learned Host cutoff inferred: `2026-09-14T02:45:21.025Z`;
- generation 5 READY created at the same time;
- delivery authorized: `02:46:46.643Z`;
- `ui/message` accepted: `02:47:00.650Z`;
- synthetic turn ACK: `02:47:15.946Z`;
- delivery work baseline: `297`;
- four post-ACK substantive DevSpace operations reached count `301`.

That chain is a real E2E PASS for Host hard-cut recovery. However, the resumed
synthetic turn then emitted a normal final after its last substantive operation
at `02:47:58.841Z`, only about **42.9 seconds after ACK**, while runnable
milestones still remained and the Task Contract still reported
`syntheticWorkMustContinue=true` / `finalResponseAllowed=false`. No legal
`turn-complete` event closed that synthetic turn. Therefore the user's
manual-like work-duration requirement is a dev69 FAIL even though trigger and
delivery succeeded.

The 40-minute external monitor itself survived the Host cut and the synthetic
resume. `dev69-real-40m-e2e` started at `02:21:35.417Z` and exited normally with
code 0 after `2,416,026 ms` (about 40m16s), so durable process survival is PASS.

## Sender observation

The doctor snapshot that reported `ACTIVE=2 / staleHeartbeatCount=1` did not
represent two senders competing for the current conversation. SQLite inspection
showed one ACTIVE sender for the current conversation scope and one stale ACTIVE
sender belonging to a different conversation scope. Generation 5 was delivered
by the current conversation's authorized sender and ACKed successfully. This is
global sender-cleanup hygiene, not the cause of the short synthetic turn.

## dev70 behavior change

dev70 keeps the existing four-operation post-ACK requirement only as an
anti-idle floor. It no longer permits an unfinished synthetic turn to yield once
that floor is met.

When the current owner is synthetic and required milestones remain incomplete,
`turn-complete` (including the cached-schema `checkpoint` compatibility
signature) now fails closed with:

`synthetic-turn-runnable-milestones-remain`

The coordinator context also explicitly forbids a normal final whenever
`finalResponseAllowed=false` or `syntheticWorkMustContinue=true`. The synthetic
turn must continue substantive work until one of these legitimate boundaries:

1. all required milestones are complete;
2. work becomes genuinely non-runnable and is persisted as `waitingExternal`,
   pause, cancel, or fail;
3. the Host genuinely truncates the turn again.

No fixed number of minutes and no learned Host-budget percentage is introduced.
The policy remains milestone-driven and therefore adapts to whatever Host turn
budget is available.

## Focused regression result

After packing the dev70 core and installing it into the E-drive test runtime,
the following passed:

- `setup/test-assistant-turn-completion-contract.mjs`;
- `setup/test-continuation-guard.mjs`;
- `setup/test-continuation-architecture.mjs`;
- `setup/test-continuation-wire-contract.mjs`;
- `setup/test-runtime-cards.mjs`;
- `setup/test-release-migration-contract.mjs`;
- `setup/test-blockmap-update.mjs`.

The ATCC test explicitly proves that four post-ACK substantive operations do
not unlock a runnable synthetic stage boundary, while ordinary manual
cached-schema completion compatibility remains valid.

## Acceptance status

- Real Host cutoff detection and READY creation: PASS on dev69.
- Sender authorization, `ui/message`, synthetic ACK: PASS on dev69.
- 40-minute durable monitor survival: PASS on dev69.
- Synthetic work duration / manual-like sustained execution: FAIL on dev69.
- dev70 code and focused regression for preventing the early synthetic final:
  PASS.
- dev70 real Host-cutoff work-duration E2E: pending after live deployment; do
  not promote this item to final PASS until a new real synthetic turn proves it.
