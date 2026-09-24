# DevSpace Portable 1.1.62 dev5 — clear file scope and operation rights

Source iteration is restricted to E:\program\Python\DevSpaceDeploy. The
installed D:\DevSpacePortable dev2 stays untouched during dev5 development;
no additional C-drive checkout/worktree is created.

## Permission model

- The initial wizard, Settings and Workspaces show the same explicit file
  access scope: **Selected working directories** or **All accessible
  directories**. The former requires one or more existing user-selected
  directories. The latter removes the internal workspace-path restriction,
  including for other local/network locations the Windows user can access.
  The detected fixed drive roots are used for workspace discovery. This
  option does not grant Windows ACL privileges or bypass the OS.
- A second independent section controls operation rights: Standard, All
  operations or Custom. Selecting All operations does not change file scope.
  The UI explicitly warns that arbitrary shell commands and desktop control
  may access files outside the internal file-tool sandbox regardless of the
  directory scope selected. Do not describe it as an OS-level sandbox.
- The effective backend permission profile is **custom**, with
  allowExternalPaths determined exclusively by fileScopeMode for the new UI.
  This avoids legacy workspace/full-access preset normalization silently
  overriding the selected directory boundary. Older clients without the
  explicit scope field retain their legacy behavior.
- The config persists selectedRoots and operationMode separately while
  all-directory access is active. Switching back to selected restores the
  previously selected projects, not the inferred C:\ and D:\ drive roots.
  A disconnected previously selected volume does not block switching to
  all-directory mode; it must exist again before selected mode is saved.
- Home, Settings, setup review and Workspaces display the **effective**
  directory scope; a legacy config with allowExternalPaths=true is shown as
  all-directory scope even if an old permissionMode label says selected.
  Saving settings remains separate from applying/restarting the service.

## Visual fix and acceptance

- The dark homepage's Service Management secondary button has fixed
  white-on-navy foreground/background, separate hover and keyboard-focus
  states. The actual computed Chromium contrast is checked in Electron
  navigation smoke, rather than relying only on CSS text inspection.
- Isolated E-drive real Manager tests cover selected+all operations,
  all directories+standard operations, persistence across switching modes,
  and legacy effective access display. Electron IPC validation independently
  enforces the same separation; no renderer-only security decisions.
- Tests and full release verification must complete before distributing.
  dev5 packaging alone does not constitute a D-live upgrade or acceptance of
  Remote Agent, Computer Use, or multi-round automatic continuation.

## 2026-09-24 user-reported interrupted ChatGPT response

The attached screenshot shows a task card still marked RUNNING after the
ChatGPT response stops. A read-only D-live dev2 inspection in the subsequent
manual turn showed assistant_turn_state=GENERATING and no signed completion
or authenticated Host timeout/teardown for that preceding response. The
Host capability inventory exposes neither assistant-final nor a turn-scoped
response-stream-failure event to the embedded MCP App. Tool-result/iframe
teardown and ordinary card heartbeat are not proof that the model turn ended.

Consequently, an automatic silent-timeout retry from within this App risks
duplicating messages or interrupting an active ChatGPT turn. Dev5 retains
fail-closed completion-driven handoff: a signed model turn-complete or a
verified current-turn Host timeout can trigger automatic continuation, but
an unconfirmed network interruption cannot safely be upgraded into one.
This limitation is **not fixed by dev5**, and one successful dev2 synthetic
turn does not establish interruption recovery reliability. A native Host
turn-final/error notification (with current-turn identity) or an explicit
user-confirmed recovery action is needed for safe recovery in this case.
