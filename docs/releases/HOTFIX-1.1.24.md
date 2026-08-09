# DevSpace Portable 1.1.24

## Scope

1.1.24 replaces the control-center-owned update experience with a dedicated
native `Update.exe` and adjusts `file-delta-v1` to match its actual payload
semantics. Portable Protocol remains 1.5.

## Why the prior update still downloaded a full package

The successful 1.1.22 -> 1.1.23 update on the maintainer machine first
downloaded the incremental package, but staging rejected it because the
installed copy of:

`app/node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node/README.md`

did not match the base SHA-256 recorded for the canonical 1.1.22 Release.
The updater therefore used its designed full-package fallback. The final
`update-result.json` recorded `updateMode = full`.

This exposed a mismatch between the delta format and the old preflight rule.
`file-delta-v1` does not apply a binary patch to the old bytes: every changed
entry already contains the complete new file. Requiring the old bytes to be
identical before replacing them caused harmless dependency/build drift to
turn a small update into a 500+ MB download.

## Standalone Update.exe

1.1.24 ships `Update.exe` in the Portable root.

- The main UI's `检查更新` button only launches `Update.exe` with the current
  Portable root, version, and main-UI PID.
- `Update.exe` owns GitHub Check, Stage, progress rendering, user confirmation,
  and install orchestration.
- Downloading does not close the main UI or stop MCP/tunnel services.
- Before Apply, the updater copies itself to
  `%TEMP%/DevSpacePortableUpdater/<guid>/Update.exe` so the root-level updater
  file is not locked during replacement.
- The temporary controller validates that the supplied UI PID still belongs to
  `<root>/DevSpace-Portable.exe` before closing it. PID reuse cannot cause an
  arbitrary third-party process to be terminated.
- The temporary controller invokes the existing transactional PowerShell Apply
  backend directly. It does not require a one-shot Task Scheduler task.
- Apply still uses same-volume backup, target-hash verification, rollback, and
  service/UI restart behavior already proven by the existing backend.

The legacy manager update commands and Task Scheduler launcher remain in the
package for compatibility with already-installed older versions, but they are
not the normal 1.1.24 UI path.

## Incremental drift policy

Changed files now use target-file replacement semantics:

- delta ZIP size and SHA-256 must match the GitHub Release manifest;
- every changed payload file must match its manifest size and SHA-256;
- safe relative-path validation still rejects traversal and drive/root paths;
- `data`, `logs`, and `reports` cannot be changed by the delta;
- a missing or locally different *changed* base file is recorded as accepted
  drift instead of forcing a full-package fallback;
- after Apply, every changed target file is hashed again and must equal the
  delta manifest target SHA-256;
- deleted files retain strict base-hash validation before deletion.

This preserves integrity while avoiding unnecessary full downloads caused by
local text normalization, locally built Release artifacts, or other benign
drift in files that the delta is going to replace completely anyway.

## Validation

Release acceptance requires:

- both `DevSpace-Portable.exe` and `Update.exe` compile as x64 .NET Framework
  WinForms applications;
- `Update.exe --self-test` confirms standalone launch, temporary out-of-tree
  Apply, progress polling, validated UI termination, and no Task Scheduler
  requirement in the new path;
- the main UI's Check function launches `Update.exe` and does not directly call
  `update-check`, `update-stage`, or `update-launch`;
- updater contract tests confirm changed-file drift tolerance and strict
  deletion drift protection;
- complete Portable source/runtime regression and production dependency audit;
- full ZIP and 1.1.23 -> 1.1.24 delta integrity verification.
