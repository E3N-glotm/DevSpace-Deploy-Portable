# DevSpace Portable 1.1.59 dev74 validation

## P0 target

dev74 addresses the synthetic execution-handoff regression reproduced by live generation 12: the synthetic turn successfully ACKed but issued zero substantive DevSpace operations and ended almost immediately.

## Root cause addressed

dev71 introduced a compact synthetic ACK. The durable task state stayed correct, but the ACK projection reduced the actionable task context to a generic work ticket. The full pre-final barrier only becomes visible after a later ordinary DevSpace tool call, leaving the ACK-to-first-tool interval unprotected. A resumed model could therefore acknowledge the turn and stop before performing any actual work.

## dev74 contract

- Successful synthetic ACK uses `synthetic-execution-v2`.
- The ACK restores the exact required/completed milestone ledger and `nextMilestone` while keeping historical evidence server-side.
- A machine-readable execution contract marks unfinished resumed work as same-turn work with final output forbidden.
- The first Host-visible text block is an execution handoff, before the JSON status payload.
- The handoff explicitly states that ACK/status is not substantive work and requires an immediate read/exec/edit/apply_patch/process attach operation.
- Generation-12 style ACK -> zero tools -> blank/early final is covered by wire and static guard regressions.

## Acceptance rule

Source regression is necessary but not sufficient. Final acceptance requires a D-live real automatic continuation that reaches synthetic ACK and then performs sustained substantive work, not merely the four-operation anti-idle floor. The resumed turn should again demonstrate manual-like working duration when runnable milestones remain. No GitHub Release is published during this validation.
