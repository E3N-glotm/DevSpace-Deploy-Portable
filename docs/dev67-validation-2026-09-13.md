# dev67 validation checkpoint — 2026-09-13

This is a development checkpoint, not release or complete live acceptance.
Source: E:\program\Python\DevSpaceDeploy. Live: D:\DevSpacePortable.
Stable 1.1.59 remains prohibited. No GitHub Release is authorized by this checkpoint.

## Verified changes

- Learned-cutoff inference now writes continuation_due_at only to continuation_worksets, avoiding the missing-column SQLite failure.
- The watchdog also evaluates an already-ACKed synthetic owner; exact turn lease, current cutoff epoch, request/process guards and one READY generation remain required.
- A task cannot reuse cutoff samples from a profile epoch invalidated by later substantive model activity.
- Status reports non-secret deliveryDiagnostics (generation, delivery state/receipt time, ACK time and lease status). An expired tokenless claim retains turn-origin-handshake-required for wire compatibility and identifies expected-next-turn-lease-expired in diagnostics.
- Invalid ACK leases are diagnosed separately. Neither diagnostics nor late claims renew ownership or manufacture ACK.
- Footer space is reserved independently of insertion/removal; normal details expansion remains possible.
- Stable 1.1.59 guards and legacy bootstrap policy target 1.1.60. The 20-version bootstrap matrix covers selected released 1.1.36–1.1.58 versions. Future releases retain four direct bridges for 1.1.36–1.1.39 plus the baseline bridge, because those four clients cannot use the graph. Compatibility of 1.1.14–1.1.35 has not been established.

## Tests

Previous focused regression passed: ATCC, guard, wire contract, architecture, supervisor scheduler, milestone lifecycle, runtime cards, updater contract, updater long paths, update graph, update launch ACK and updater apply recovery. Legacy policy tests exercised actual historical 1.1.36/1.1.49/1.1.58 planner/extraction functions. Edge footer tests at 180/360/800 pixels preserved root height through footer removal/reinsertion and long text.

After adding ACK diagnostics, these seven checks passed again:
- test-continuation-architecture.mjs (late and invalid ACK lease, immutable ownership, normal tokenless ACK)
- test-continuation-wire-contract.mjs (strict response schema via actual MCP client)
- test-assistant-turn-completion-contract.mjs
- test-continuation-guard.mjs
- test-continuation-supervisor-scheduler.mjs
- test-milestone-card-lifecycle.mjs
- scripts/verify-source-tree.mjs

Core package: @waishnav/devspace 1.0.7.
SHA-256: 9a40f0b6e3ef9a9a7148811a4d0f7aaf6838209eceb8177f256084b6ec4eab45.
Metadata: 1.1.59 dev67. The core package was rebuilt; this does not assert a rebuilt full Portable ZIP.

## Generation 32 evidence and limits

Read-only inspection of the other conversation's persisted generation found:
- claimed_at: 2026-09-13T06:48:38.422Z
- delivery authorization event: 2026-09-13T06:48:42.852Z
- delivered_at: 2026-09-13T06:48:47.427Z
- state: DELIVERED
- turn_acked_at: null
- ACK lease/due_at: 2026-09-13T06:49:32.427Z

The user reports that the synthetic message appeared and that its first token-bearing tool call was blocked by the Host. The DevSpace receipt confirms the sender recorded transport acceptance; it does not prove model execution or establish the reason for a request missing from the server. No independent Host rejection trace was obtained in this checkpoint.

A tokenless compatibility claim already exists, but requires a confirmed delivery and an unexpired ACK lease. A status after the above deadline fails locally even if Host safety was not involved. Generation 32's original rejected status timestamp was not established, so expiry is a reproducible local explanation, not a proven replacement for the reported Host rejection.

The current request-meta adapter reads openai/session only. OpenAI documents that field as conversation correlation, not per-message synthetic-origin proof:
https://developers.openai.com/plugins/reference
The documented ui/message API sends a follow-up; it does not establish that a later model tool call belongs to that delivery:
https://developers.openai.com/plugins/build/chatgpt-ui

This checkpoint does not remove the token, extend an expired lease, invent a trusted metadata field, or bypass a Host rejection. Replacing the capability requires a supported, independently verified origin-binding mechanism; server-owned expected state alone does not prove which message initiated a request.

## Outstanding acceptance

A learned historical cutoff is an inference, not a verified Host event. Two clustered duration values cannot prove the current model has stopped, and a later operation can invalidate an obsolete regime only if that operation occurs before inference acts.

Still required: a real Host hard cutoff without an explicit event, inferred TIMED_OUT, unique READY, sender claim, accepted ui/message, actual synthetic status ACK, and at least four substantive DevSpace operations. Simulated test fixtures do not count. ChatGPT page scrolling also needs direct live visual acceptance beyond isolated Edge layout tests.

