# DevSpace 1.1.59 dev72

## Scope

dev72 addresses the remaining continuation-latency race observed during the
real dev71 normal-stage-boundary acceptance run. dev71 successfully produced
the compact `synthetic-ack-v1` ticket and the resumed model performed
substantive DevSpace work, but the same delivery generation was delayed after
a sibling Workspace App iframe rebound sender ownership while the original
sender already held a valid `CLAIMED` generation.

## Runtime rule

`bindContinuationSender()` now preserves the current sender and its claimed
generation only when all of the following remain true:

- the sender belongs to the current MCP server boot;
- sender protocol epoch matches the current runtime;
- sender/card mount generations match;
- sender lease state is `ACTIVE`;
- sender heartbeat is no older than the 90-second sender/card lease; and
- the generation's 45-second `CLAIMED` lease has not expired.

A competing same-card iframe is then rejected with
`sender-claim-owned-by-live-sender` and the existing claim deadline. The bind
does not rewrite the card sender, generation state, or delivery token.

Protection intentionally disappears when the claim expires, heartbeat becomes
stale, the MCP service restarts, protocol/card generation changes, or the
sender lease is inactive. Those cases retain the existing replacement-sender
recovery path, including release of a pre-delivery claim back to `READY`.
Manual takeover remains authoritative and is unchanged.

## Regression coverage

The continuation guard now exercises three sender-rebind cases directly:

1. a healthy sender with a live claim cannot be stolen by a sibling iframe;
2. the same generation becomes replaceable after its claim deadline expires;
3. a sender with a stale heartbeat becomes replaceable even while its
   generation claim deadline is still in the future.

The ATCC suite continues to cover manual takeover and exact-turn ownership;
architecture and wire suites continue to cover sender restart/rebind,
generation identity, compact synthetic ACK, selective tool discovery, and the
model-side work floor.

## Acceptance boundary

Passing source regressions establishes only the state-machine safety boundary.
After D-live deployment, dev72 still requires a real normal-stage-end run that
measures `READY -> claim -> send -> synthetic ACK` without simulated timeout.
The latency fix is not accepted until that live path completes promptly and
the resumed synthetic turn performs substantive work. Hard-cut recovery is a
separate acceptance path and must not be inferred from this test.
