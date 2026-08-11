# DevSpace Portable 1.1.32

## Scope

1.1.32 fixes the remaining standalone updater launch crash from 1.1.31 and unifies the native Windows brand icon. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Root cause of the 1.1.31 update-window crash

The 1.1.31 main UI stores the Portable root with a trailing directory separator. It then manually constructed a Windows command line similar to:

```text
--root "D:\DevSpacePortable\" --current "1.1.31" --parent-ui 1234
```

On Windows, a backslash immediately before a closing quote participates in command-line escaping. The closing quote was therefore not reliably interpreted as the end of the root argument. Windows `.NET Runtime` event 1026 on the affected installation recorded the resulting failure as:

```text
System.ArgumentException
  at System.IO.Path.GetFullPathInternal(...)
  at DevSpacePortableUpdater.UpdateForm.ResolveRoot(...)
  at DevSpacePortableUpdater.UpdateForm..ctor(...)
```

The outer process exit code surfaced in the UI as `-532462766` (`0xE0434352`, CLR exception).

## Fix

- The sibling `Update.exe` no longer receives redundant `--root` or `--current` arguments. Its executable directory is the Portable root and `VERSION-MANIFEST.json` is the version authority; the main UI only supplies the parent UI PID required for the later transactional handoff.
- The updater's remaining child-process argument construction uses full Windows quoting semantics: embedded quotes and runs of backslashes before a quote or end-of-argument are escaped correctly.
- `Update.exe` now has a top-level startup exception boundary. Unexpected launch-state errors are shown in a native error dialog and return a controlled non-zero exit code instead of terminating as an unhandled CLR exception.
- The existing visible-window validation remains: the main UI still detects immediate updater exit and a 7-second no-window timeout.

## Native icon unification

The previous build did not assign a DevSpace icon to all WinForms surfaces, leaving Windows to show generic .NET/application icons in the title bar, taskbar and tray.

1.1.32 adds a single `BrandIconFactory` that draws the same blue-purple rounded-square / white `D` mark used by the control center. The same implementation is used by:

- the main DevSpace Portable window;
- the standalone Update window;
- file-diff, full-content and diagnostic windows;
- close-choice, prompt and first-deploy dialogs;
- the system tray icon;
- the in-window brand mark.

## Validation requirements

- Native UI and updater compile successfully with the shared brand source.
- `Update.exe --self-test` verifies that the brand icon can be created.
- The standalone-updater contract verifies that the main UI launch path contains no `--root`/`--current` arguments and retains only `--parent-ui`.
- The updater contract verifies backslash-aware Windows argument quoting.
- Full Portable source/regression tests and release-build integrity checks must pass before tagging v1.1.32.

## Upgrade note for 1.1.31

Because the bug is in the 1.1.31 main UI's launch command, users whose **button** still crashes the updater can start the existing `Update.exe` directly from the Portable directory once. Direct launch does not contain the malformed main-UI root argument and can be used to reach 1.1.32. No OAuth reset or MCP tool rescan is required.
