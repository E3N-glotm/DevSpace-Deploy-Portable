# DevSpace 1.1.59 dev73 validation

Date: 2026-09-14

## Trigger

dev72 restored real hard-cut continuation through synthetic ACK and substantive work, but the live generation still missed the requested latency boundary: `READY -> claim` was 29.061 s, `READY -> send` was 41.560 s, and `READY -> synthetic ACK` was 68.928 s. The same acceptance task also exposed a separate terminal-state defect: all five required milestones were durably completed while the Task Contract remained `RUNNING` because checkpoint auto-seal accepted only `completion-driven`, whereas the live validation task used `timeout-recovery`.

## Terminal-state correction

A verified checkpoint with every required milestone complete now auto-seals both `completion-driven` and `timeout-recovery` tasks. Terminal cleanup continues to archive the active workset/generation and clear the active card workset pointer. `resident` mode remains excluded because completion of one monitored stage is not equivalent to completion of the long-lived resident task.

The regression requires a timeout-recovery task to transition from RUNNING to SUCCEEDED at 1/1 completion, report `taskIncomplete=false`, leave no RUNNING workset or active workset pointer, and reject subsequent continuation claims.

## READY-to-send latency changes

The coordinator already had a 2 s logical supervisor tick and EventSource wake, but the live Host still took 29.061 s to claim READY. dev73 removes two sources of avoidable scheduling latency without weakening continuation authority:

- SSE wake frames are explicitly flushed and the endpoint emits `X-Accel-Buffering: no` so tiny READY wake frames are not intentionally left to response/proxy buffering.
- A streamed `fetch()` reader runs as an independent wake hedge alongside EventSource. Both transports only request an authoritative supervisor reconciliation; neither carries task/delivery authority, and duplicate wake hints remain safe behind single-flight reconciliation plus generation CAS.
- Advisory model-context hydration begins in parallel with the durable generation claim instead of serializing after claim. The final `authorize-delivery` CAS still runs after both settle and immediately before the irreversible Host send, preserving manual-takeover fencing.

## Regression boundary

Focused E-side regressions must pass for continuation guard, ATCC, continuation architecture, and wire contract before version finalization. The final packaged bytes must then pass the standard seven-test focused suite before D-live deployment.

Passing these regressions proves the intended state-machine and transport ordering, not the real Host latency. Final acceptance still requires a new real continuation with no simulated timeout and measured `READY -> claim -> authorize -> send -> synthetic ACK`, target `<10 s` and fallback `<=45 s`, plus resumed substantive work.
