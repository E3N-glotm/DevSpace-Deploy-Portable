# DevSpace Portable dev85 validation — 2026-09-16

## Trigger

After dev84 was fully regressed and deployed, a real generation-24 milestone card mounted successfully and kept an ACTIVE sender lease on the new dev84 server boot, but the durable card row still reported sender asset revision `31d80bb2ae2b0218`, the dev83 Workspace App revision. The dev84 server expected `05e24990cf3811d9`. Therefore the dev84 coordinator fix had not actually reached the browser iframe and a continuation test at that point would only have retested cached dev83 frontend code.

## dev85 change

- Keep the statically registered `continuation_anchor` descriptor on the proven primary revisioned Workspace App URI.
- On each successful `continuation_anchor`, publish a standards-first result resource URI that includes both the current Workspace App revision and the exact card generation.
- Do not publish result-level `openai/outputTemplate`; that legacy identity remains descriptor-owned to avoid the dev15 double-template/unmounted-shell failure mode.
- Prevent the generic sender-capability wrapper from silently restoring result-level `openai/outputTemplate` for `continuation_anchor`.
- The generation-specific URI remains backed by the existing compatibility ResourceTemplate and `workspaceAppSurfaceBootstrap()` recognizes its anchor generation.

## Focused evidence

- Red test: updated `setup/test-continuation-guard.mjs` failed on dev84 because `continuation_anchor` did not return a generation-specific resource hint.
- Green test after implementation: `setup/test-continuation-guard.mjs` exit 0.
- Focused compatibility suite: continuation architecture, wire contract, runtime cards and milestone-card lifecycle exit 0.

## Remaining gates

dev85 is not accepted until all of the following are true:

1. Full source regression passes.
2. Manifest/source hash gate passes.
3. D-live is upgraded from dev84 to dev85 with a rollback snapshot.
4. A fresh real milestone card reports `sender_asset_revision` equal to the dev85 server's `expectedAssetRevision`.
5. Only then run the real automatic continuation acceptance: model-signed incomplete-stage handoff → READY → sender claim → authorize-delivery → `ui/message` accepted → synthetic status ACK → at least four substantive post-ACK DevSpace operations.

No Host timeout, ACK, sender row, or lifecycle event may be fabricated for this acceptance.
