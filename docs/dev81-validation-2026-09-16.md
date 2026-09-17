# DevSpace Portable 1.1.59 dev81 validation

## Scope

dev81 addresses the real two-hour monitoring failure where `ui/message` was accepted by the ChatGPT Host but the resumed assistant never performed the mandatory `continuation_task status` ACK and instead emitted a short ordinary final response. It also closes the independently observed sender asset-revision drift where an older Workspace App iframe could remain ACTIVE under the same protocol epoch.

## Safety model

- Transport acceptance is not execution confirmation.
- The short delivery ACK health deadline never authorizes visible retransmission.
- Missing ACK enters an explicit execution-unconfirmed state.
- Automatic replacement is allowed only after exact turn-end evidence or the existing strict clustered Host-cutoff safety boundary; this avoids interrupting a slow but still-live model.
- Recovery supersedes the ambiguous generation and mints a new delivery token; a late assistant holding the old token must self-suppress.
- Sender protocol epoch and current concrete Workspace App asset revision are both authority fences. A stale revision cannot bind, heartbeat, claim or deliver even if its coarse protocol epoch matches.
- Rebinding a current revision reuses the existing immutable conversation-card generation.

## Focused regression status before full source regression

- `setup/test-continuation-guard.mjs`: PASS, including no-ACK direct-final recovery and late-token self-suppression.
- `setup/test-resident-turn-recovery.mjs`: PASS, 18 fixtures.
- `setup/test-assistant-turn-completion-contract.mjs`: PASS.
- `setup/test-continuation-architecture.mjs`: PASS.
- `setup/test-continuation-wire-contract.mjs`: PASS, `ACK_BYTES=7185`.
- Canonical core was repacked and a clean `npm ci --ignore-scripts` + `npm rebuild better-sqlite3` completed successfully before focused regression.

Full source regression, manifest/hash verification, D-live deployment and real Host acceptance remain release gates and must be recorded only after they actually pass.
