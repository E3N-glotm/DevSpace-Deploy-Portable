# DevSpace Portable 1.1.34

## Scope

1.1.34 fixes the remaining semantic and UI problems in **会话与回退** and changes online update downloads to a verified mirror-first policy. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Frozen historical review records

1.1.33 prevented high-frequency empty monitor sessions from evicting meaningful rollback sessions, but historical details were still calculated by comparing an old session baseline against the **current live workspace**. If later work changed the same files again, reverted them, or restored them to the older baseline, a previously modified session could therefore display `0 / +0 -0` even though that session had made real changes.

1.1.34 freezes the session's own historical result immediately after every successful structured file mutation. The persisted record contains bounded file metadata, line statistics, and a compact historical patch. Future sessions no longer rewrite the meaning of an older session.

For pre-1.1.34 sessions that did not persist file-level historical details, migration preserves the last known non-zero summary where possible. History that an older build already physically deleted cannot be reconstructed.

## Read-only session persistence

Read-only workspace opens, SSH/GPU monitoring commands, reconnects, and other shell-only rounds no longer create durable review-session directories by themselves. Shell activity is still covered by the normal event/audit journal, but a durable rollback session is created only after a structured file baseline exists or the user explicitly preserves a session.

The native history page now hides empty sessions by default and provides **显示空会话** for diagnostics. Existing disposable empty records from affected builds are cleaned automatically.

## Bounded storage without deleting history

The sparse rollback limits remain bounded:

- maximum tracked paths per session: 2048;
- maximum stored file size: 4 MiB;
- maximum stored rollback payload per session: 32 MiB;
- maximum aggregate review state: 512 MiB;
- maximum rollback safety snapshots: 5;
- maximum persisted historical patch: 1 MiB per session.

When the 512 MiB aggregate limit is reached, DevSpace no longer deletes the whole historical session first. It releases the oldest rollback object payload while preserving the lightweight session summary/file history. Under pressure, oversized historical patch text may be compacted further while file and line statistics remain. Such a session remains reviewable but is explicitly marked as no longer rollback-capable.

This separates two concerns: long-lived history stays small, while rollback snapshots remain strictly bounded.

## Verified mirror-first updater

Large GitHub Release assets now use the following network policy:

1. obtain version, asset size, and SHA-256 metadata from official GitHub only;
2. if Windows system proxy is enabled, respect it before direct/TUN transports;
3. download the ZIP from the configured GitHub mirror first (`ghproxy.net` by default);
4. if the mirror fails, immediately fall back to the official GitHub Release URL;
5. verify the downloaded size and the official SHA-256 before extraction or apply.

The default mirror list can be overridden with `DEVSPACE_GITHUB_MIRRORS` using semicolon/comma/newline-separated HTTPS prefixes. Mirror URLs never become a trust source: they transport bytes only.

Mirror failure is deliberately bounded. With a system proxy enabled, a mirror receives at most one system-proxy attempt and one direct attempt before DevSpace moves to the official endpoint. This prevents a dead mirror from adding long repeated delays.

## Regression and live validation

- verified a recorded file change remains visible after the live file is later restored to its pre-session contents;
- verified repeated read-only workspace opens do not create durable review sessions;
- verified older disposable monitor-session metadata is removed while meaningful rollback sessions survive;
- verified online update metadata is obtained from official GitHub with the current Windows system proxy;
- verified the 1.1.32 -> 1.1.33 incremental ZIP downloads successfully through `ghproxy.net`, with the official GitHub SHA-256 `de75fdfaead47c3d1e813c4d86b7b67dbd54d2c49e4885c1cc8f32eebef26a0d`;
- forced an unreachable mirror and verified automatic fallback to the official GitHub asset, followed by the same SHA-256 validation.

## Compatibility

- Portable version: 1.1.34;
- DevSpace server capability version: 1.1.34;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- OAuth reset: not required;
- ChatGPT tool rescan: not required.
