# DevSpace Portable 1.1.59 dev69 validation

Date: 2026-09-14

## Trigger

The dev68 40-minute real Host-cutoff validation failed before the expected Host cutoff path. The new manual round inherited an expired wall-clock deadline from the previous validation. Its execution generation was closed by `task-terminal:wall-clock-budget`; later canonical recovery restored the legacy task to `RUNNING` while the active execution projection was no longer schedulable, producing the observed `supervisor scanned=0`. The same recovery also carried the previous validation's `verdict=PASS` into the new run.

## dev69 state-machine changes

- A new milestone/workset plan recomputes its wall-clock budget instead of inheriting an expired deadline.
- A fresh workset preserves conversation-lifetime evidence but removes workset-scoped validation evidence such as verdict, delivery/ACK receipts, event sequence IDs, doctor results, and source/live hashes.
- Terminal cleanup archives active worksets in addition to closing continuation generations and clearing the active card pointer. A terminal workset therefore cannot be selected later as the authoritative active projection.
- Terminal reactivation and active-plan replacement both start from sanitized lifetime evidence and a fresh deadline policy.

## Regression coverage

`setup/test-continuation-guard.mjs` now covers an expired historical bounded run with PASS evidence followed by a fresh timeout-recovery workset. The test requires:

- the new task projection is RUNNING without the expired deadline;
- the historical PASS verdict is absent;
- the old workset is ARCHIVED;
- a different fresh workset is RUNNING and has a scheduling cursor;
- the supervisor sweep sees the fresh workset (`scanned > 0`).

The focused continuation guard, Assistant Turn Completion Contract, continuation architecture, and wire-contract regressions must all pass against the packaged/installed core before D-live deployment.

## Acceptance boundary

Passing these regressions proves the lifecycle bug is fixed in the packaged runtime. It does not by itself prove the final real Host automatic-continuation E2E or synthetic work-duration requirement; those remain separate live acceptance tests after dev69 is deployed.
