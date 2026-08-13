# DevSpace Portable 1.1.37

## Scope

1.1.37 fixes a native WinForms layout crash when opening `AI / MCP OAuth 客户端`. The failure is UI-only; OAuth registration, storage and MCP protocol behavior are unchanged. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Root cause

`OAuthClientsDialog.BuildUi()` previously created its vertical `SplitContainer` with fixed values during object initialization:

```text
SplitterDistance = 610
Panel1MinSize = 420
Panel2MinSize = 390
```

WinForms can create and lay out the child control while its `ClientSize` is still a small transient value. This is especially visible during the first Dock pass, parent resizing, and DPI scaling. At that point the requested splitter position may not satisfy:

```text
Panel1MinSize <= SplitterDistance <= usable width - Panel2MinSize
```

WinForms then throws before the OAuth dialog is shown, which surfaced in the native control center as the red error banner reported by the user.

## Fix

The release introduces a shared `SafeSplitLayout` helper. It:

- does not assign a fixed `SplitterDistance` in the object initializer;
- waits for live `ClientSize` information and recalculates on handle creation, parent changes and size changes;
- subtracts `SplitterWidth` before computing the usable extent;
- clamps the target split against the current safe range;
- temporarily sets both panel minimums to zero when the control is too small to satisfy the intended minimums;
- restores the design minimums once enough room exists;
- falls back to a minimum-free clamped split if WinForms reports a transient range exception during layout.

The OAuth dialog now also uses `AutoScaleMode.Dpi`.

## Wider hardening

The same unsafe initialization pattern existed in other native pages. 1.1.37 migrates these to the same helper:

- plugin management horizontal split;
- explicit Memories vertical split;
- logs and diagnostics horizontal split.

This prevents the same class of error from reappearing when those pages are opened at unusual window sizes or DPI scales.

## Regression coverage

The native UI self-test now creates both vertical and horizontal split containers and drives them through transient dimensions that include values far below their intended panel minimums. It also constructs the real `OAuthClientsDialog` and drives its splitter through widths of 120, 240, 480, 820, 940, 1180 and 1800 pixels.

Every sample verifies that the effective `SplitterDistance` remains inside the current `Panel1MinSize` / `Panel2MinSize` bounds. The existing native UI heartbeat test now requires this layout self-test to pass.

## Compatibility

- Portable version: 1.1.37;
- DevSpace server capability version: 1.1.37;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- OAuth reset: not required;
- existing manual and DCR clients: preserved.
