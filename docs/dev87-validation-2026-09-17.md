# DevSpace Portable dev87 validation — 2026-09-17

## Trigger

dev86 fixed the synthetic ACK wording and passed live wire/source validation, but the subsequent long synthetic acceptance exposed a stricter lifecycle failure.

Real generation 6:

- claim: `2026-09-17T02:40:36.952Z`
- delivered: `2026-09-17T02:40:44.830Z`
- ACK: `2026-09-17T02:41:38.019Z`
- substantive baseline: `289`
- last substantive activity: `2026-09-17T03:03:47.850Z`
- substantive count at last activity: `344`
- close: `2026-09-17T03:06:52.027Z`
- close reason: `synthetic-active-orphan-inferred`

At close time the task still had `hostTimeoutSamples=0` and `lastHostSignal=connected`. No model-signed `turn-complete` had been recorded. The server therefore created replacement generation 7 from DevSpace tool silence rather than either of the two user-approved continuation authorities.

Generation 7 was then claimed and delivered at `03:06:55.725Z` / `03:07:01.549Z` but never produced the mandatory first synthetic status ACK before the user manually took over at `03:20:51.020Z`.

## Root cause

`syntheticActiveOrphanFallback()` treated an ACKed synthetic turn with enough prior tool cadence and a derived quiet window as ended. This cannot distinguish a genuinely ended Host turn from minutes of model reasoning or response generation that simply performs no DevSpace call. The Apps transport has no authoritative "assistant is still generating" bit, while `continuationModelRequestInFlight()` only covers an MCP request currently executing.

Therefore any cadence/quiet threshold remains structurally unsafe for completion-driven/resident continuation, regardless of whether the minimum quiet time is 90 seconds, 3 minutes, or longer.

## dev87 change

- Remove `syntheticActiveOrphanFallback()` as a continuation-authority source.
- Stop creating new `assistant_turn_state=ORPHANED` rows from cadence/tool silence.
- Stop emitting READY generations from synthetic quiet inference.
- Retain read/revocation compatibility for ORPHANED rows already persisted by older dev builds, so live upgrade does not corrupt historical state.
- Keep manual takeover, model-signed stage completion, explicit Host timeout, and clustered learned-cutoff fallback unchanged.
- Keep learned-cutoff fallback separate from ordinary silence: it still requires at least two distinct tightly clustered confirmed cutoff observations and fires only after the historical cutoff plus adaptive margin for the exact current turn lease.

## UI finding

The user's fresh screenshot again showed a synthetic user message followed by many tool-call cards but no standalone progress text. Generation 6 database evidence proves the turn was doing real work. The current ChatGPT Host does not reliably render assistant text fragments between tool calls as independent transcript bubbles before the assistant turn finishes. dev87 therefore does not shorten turns or manufacture periodic finals merely to create visible text; the single milestone card and tool-call cards remain the live work indicators.

## Focused validation

- `setup/test-continuation-guard.mjs`: PASS after replacing the old orphan-authority assertions with fail-closed assertions.
- `setup/test-assistant-turn-completion-contract.mjs`: PASS.
- `setup/test-continuation-architecture.mjs`: PASS.

## Remaining gates

Before dev87 can be accepted on D-live:

1. finalize dev87 identity and rebuild/reinstall the canonical core package in the E-drive checkout;
2. run wire regression against the canonical dev87 package;
3. run full source regression and source-tree/manifest hash gates;
4. create an E-drive rollback snapshot and deploy incrementally to `D:\DevSpacePortable`;
5. re-run doctor/live hash checks;
6. perform a real long synthetic acceptance. Ordinary tool silence must not create a new generation; continuation may occur only through model-signed stage completion or Host-cutoff recovery.

No Host timeout, ACK, generation, lifecycle event, or UI-visible progress event may be fabricated for acceptance.
