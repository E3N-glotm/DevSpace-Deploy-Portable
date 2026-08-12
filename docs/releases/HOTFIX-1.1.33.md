# DevSpace Portable 1.1.33

## Scope

1.1.33 fixes a review-history retention bug exposed by high-frequency read-only sessions and adds native export of the currently selected plugin package. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Root cause: modification history could become zero or disappear

The sparse review backend introduced in 1.1.11 correctly replaced the old unbounded whole-workspace shadow Git design, but its garbage collection still used one global directory-count limit:

```text
MAX_SESSION_DIRECTORIES = 30
```

Every workspace open created a `review-sessions-v4/<session>/session.json` directory, including read-only monitoring rounds with no tracked mutation baseline. Frequent VGSP/LC-PiSA-SR monitoring therefore consumed the same 30-directory budget as real mutation sessions. Once the count exceeded 30, the oldest directory was removed regardless of whether it contained rollback baselines. The native UI then had no review metadata for that round, so earlier modification counts could become `0` or disappear.

The affected installation reproduced the condition directly: `D:\DevSpacePortable\data\state\review-sessions-v4` contained exactly 30 sessions while newer read-only monitoring rounds were continuously being added.

## Fix

The count limit is now applied only to disposable empty sessions. A session is count-prunable only when it is not pinned and has all of the following:

- no tracked baseline paths;
- no rollback safety snapshots;
- no observed arbitrary shell mutation;
- no recorded file changes.

The UI still keeps up to 30 recent empty/read-only rounds for useful session history, but meaningful review/rollback sessions do not participate in that count and therefore cannot be pushed out merely by monitor/reconnect churn.

The bounded-storage safety model is unchanged:

- maximum tracked paths per session: 2048;
- maximum stored file size: 4 MiB;
- maximum stored review payload per session: 32 MiB;
- maximum aggregate review state: 512 MiB;
- maximum rollback safety snapshots: 5.

If the 512 MiB aggregate cap is genuinely reached, storage-pressure GC still runs. It removes disposable empty sessions first, then the oldest unpinned meaningful sessions, and pinned sessions only as a last resort. The current session is never removed by its own initialization/mutation path.

## Plugin package export

The native **插件管理** page now includes **导出当前选中插件包**. The action exports the exact version selected in the version selector as a complete ZIP package that can be installed again through the existing **安装插件** flow.

Export behavior:

- the destination must be a `.zip` outside `data/plugins/installed`;
- the source plugin tree is scanned with the existing file-count/size/symlink safety policy;
- the archive is created through a temporary file and atomically moved into place;
- archive entries are re-listed and validated;
- a package-root `manifest.json` is required;
- the UI reports the exported version, path, and SHA-256.

The release builder also treats the bundled `codex-runtime-bridge` as a
mandatory ZIP invariant. Every future full Portable ZIP is required to contain
the plugin at `data/plugins/installed/codex-runtime-bridge/<version>/`; the
build fails if its manifest, runtime, keep-awake helper, or Skill payload is
missing. Incremental update ZIPs always carry the corresponding
`setup/bundled-plugins/codex-runtime-bridge/` seed payload even when unchanged
from the base version, while user-persistent `data/`, `logs/`, and `reports/`
remain excluded from delta replacement.

## Regression coverage

- create one meaningful review session with a real tracked baseline and changed file;
- inject more than 30 empty/read-only sessions representing affected-build monitor history;
- open another 40 read-only rounds;
- verify that the meaningful review session and its rollback details still exist while the disposable subset remains bounded;
- export a plugin ZIP through the Portable manager interface;
- uninstall the plugin;
- reinstall it from the exported ZIP and verify it is discovered correctly.

## Compatibility

- Portable version: 1.1.33;
- DevSpace server capability version: 1.1.33;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- OAuth reset: not required;
- ChatGPT tool rescan: not required.
