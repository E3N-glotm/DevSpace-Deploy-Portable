# Upstream provenance

- Upstream repository: `https://github.com/Waishnav/devspace`
- Upstream package baseline: `@waishnav/devspace@1.0.7`
- Pinned upstream release commit: `b5b4ab62a8718e1186aef815538741d9402f92ba`
- Upstream license: MIT (`LICENSE` in this directory)

This directory is the maintained Portable fork consumed by the Windows
distribution. It contains the published ESM package layout plus Portable
changes. Do not edit the generated installation under `app/node_modules`;
modify this directory, run `npm run core:pack`, and reinstall `app/`.

The Portable project currently maintains the published `dist/` package as its
controlled integration surface. A future cleanup may port all changes back to
the upstream TypeScript source tree, but until that migration is complete this
directory is the authoritative reviewable source used by Releases.

Portable 1.1.38 selectively synchronized the upstream 1.0.6/1.0.7 workspace
reuse contract instead of replacing this maintained fork wholesale. Imported
upstream behavior includes ChatGPT conversation-scoped checkout reuse, SQLite
conversation bindings, concurrent duplicate-open coalescing, compact new
workspace IDs, stale-binding recovery, and actionable unknown-ID guidance.
Portable-specific review journaling, OAuth, permissions, plugins, Memories,
Computer Use, session history, updater and native UI behavior remain the local
authoritative implementation.

