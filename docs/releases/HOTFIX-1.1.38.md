# DevSpace Portable 1.1.38

## Scope

1.1.38 selectively synchronizes the maintained Portable core with upstream `@waishnav/devspace` 1.0.6/1.0.7. It does **not** replace the Portable fork with the upstream npm package. The release imports the upstream conversation-aware workspace reuse contract while preserving the local bounded review journal, vendor-neutral OAuth, full-access permission model, plugins, explicit Memories, Computer Use, persistent session history, updater hardening and native Windows control center.

Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Upstream baseline

- upstream repository: `Waishnav/devspace`;
- previous Portable compatibility baseline: 1.0.5;
- new compatibility baseline: 1.0.7;
- pinned upstream release commit: `b5b4ab62a8718e1186aef815538741d9402f92ba`.

The upstream 1.0.6 release introduced the substantive workspace changes; 1.0.7 mainly tightened the reuse-first model contract and made unknown workspace IDs easier to recover from.

## Conversation-aware checkout reuse

When the MCP host supplies `_meta["openai/session"]`, `open_workspace` now treats that value as an opaque conversation scope. For checkout mode, DevSpace builds a canonical project target key and persists:

```text
conversation scope + checkout target -> workspace session
```

in SQLite.

Repeating `open_workspace` for the same project in the same supported ChatGPT conversation returns the existing workspaceId instead of creating another checkout session. The first open provides the full project bootstrap (AGENTS/CLAUDE files, nested instruction locations, skills, agent profiles, explicit Memories and diagnostics). A reused open suppresses that duplicated bootstrap payload and tells the model to continue with the existing workspaceId.

Hosts that do not provide `openai/session` retain the existing explicit-workspace behavior.

## Persistent binding and restart recovery

The local database adds migration 9, `workspace-conversation-bindings`, with a composite primary key over conversation scope and target key plus a foreign key to `workspace_sessions`.

Because the binding is stored in the same SQLite state as persisted workspace sessions, reuse survives:

- MCP transport reconnects;
- DevSpace process restarts;
- bounded in-memory workspace cache eviction.

Before reusing a binding, DevSpace verifies that the session is active, remains checkout mode, resolves to an allowed/current-user-accessible root according to the Portable permission profile, and that the root still exists as a directory. Invalid bindings are removed and replaced by a fresh checkout session.

## Concurrent duplicate-open coalescing

Multiple identical checkout opens for one conversation can arrive concurrently. 1.1.38 keeps a bounded in-memory map of pending conversation/target opens and shares the same Promise while the first open is in progress. This prevents one UI/model retry burst from generating several persisted sessions for the same conversation and project.

The pending entry is always removed in `finally`, so failures do not poison later opens.

## Worktree isolation is unchanged

Conversation reuse applies only to checkout mode. `mode="worktree"` remains an explicit request for a new isolated managed worktree and therefore still creates a fresh workspace every time.

## Compact workspace IDs

New sessions use:

```text
ws_<10 hexadecimal characters>
```

instead of a full UUID. This reduces repeated model-facing context overhead. Existing persisted UUID-style workspace IDs are not rewritten and remain valid; this is deliberately a forward-only format change rather than a destructive migration.

## Actionable unknown-ID recovery

When a workspaceId cannot be found in the hot cache or persisted session store, the error now explicitly instructs the host/model to reopen the target project or worktree and continue with the newly returned ID. This imports the practical 1.0.7 contract tightening without changing workspace mechanics.

## Why upstream review/UI files were not copied wholesale

The upstream 1.0.6 release also changed review checkpoints and the embedded workspace/tool-card UI. Portable has independently evolved those areas much further:

- bounded sparse-journal-v4 review state;
- frozen historical per-session diffs;
- 512 MiB aggregate review storage ceiling;
- lightweight history retention separated from rollback payload retention;
- empty monitor-session suppression;
- safety snapshots and explicit rollback confirmation;
- Portable-specific plugin, Memory and lifecycle activity rendering.

Replacing those files with upstream versions would regress existing Portable guarantees. 1.1.38 therefore keeps the local implementations and only ports upstream behavior that can be merged without changing those semantics. Existing review regression tests continue to cover session/root recovery boundaries.

## 1.1.33 rescue compatibility across the core package rename

Moving the maintained core baseline from 1.0.5 to 1.0.7 changes the inert source archive under `packages/` from `waishnav-devspace-1.0.5.tgz` to `waishnav-devspace-1.0.7.tgz`. A direct Explorer-style extraction cannot delete the old archive.

The rescue builder now has one deliberately narrow exception to its no-deletion rule: an old `packages/waishnav-devspace-<version>.tgz` may remain when the target Release contains a different-version archive from the same package family. This file is not executed by the Portable runtime; `app/package.json`, `app/package-lock.json`, and installed `app/node_modules` all point at the target core. Any other target-side deletion still causes rescue generation to fail closed.

## Regression coverage

1.1.38 adds a dedicated upstream-workspace-reuse regression covering:

- parsing `openai/session` only when it is a non-empty string;
- first checkout open creating a compact workspaceId;
- same conversation + same checkout returning that same ID;
- duplicate bootstrap being suppressed on reuse;
- different conversations remaining isolated;
- concurrent duplicate opens coalescing to one session;
- binding reuse after closing/reopening the SQLite store and WorkspaceRegistry;
- archived/stale binding recovery creating a new workspace;
- actionable unknown workspaceId errors.

The full Portable regression suite still covers OAuth, plugin export/install, Computer Use, updater/recovery, release layout, review/session rollback, Memories, network isolation, native UI and production dependency audit.

## Compatibility

- Portable version: 1.1.38;
- maintained upstream core baseline: 1.0.7;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- OAuth reset: not required;
- ChatGPT tool rescan: not required;
- old persisted workspace IDs: remain valid;
- `codex-runtime-bridge`: remains mandatory in formal full/incremental Release packages.
