# DevSpace Portable 1.1.40

## Scope

1.1.40 is the updater migration checkpoint and Remote Workspace recovery release. It changes the updater from a single exact `fromVersion -> latest` delta lookup into a transactional multi-Release incremental planner, adds SSH-assisted Remote Agent recovery to the native control center, and adds native MCP image/PDF attachment reads so workspace media no longer needs a local Codex/subagent conversion path.

Portable Protocol remains 1.5. The top-level MCP tool schema changes because `read_attachment` is added, so MCP clients should Refresh / Scan Tools after upgrading.

## 1.1.32-1.1.39 migration to 1.1.40

Installed 1.1.32-1.1.39 updaters predate the new chain planner and only know how to select one exact delta whose `fromVersion` equals the installed version and whose `toVersion` equals the latest stable Release. 1.1.40 therefore publishes one migration delta for each supported installed version:

- `DevSpacePortable-Update-1.1.32-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.33-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.34-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.35-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.36-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.37-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.38-to-1.1.40.zip`
- `DevSpacePortable-Update-1.1.39-to-1.1.40.zip`

These ZIPs are generated from the already-published canonical full Releases by the GitHub Release workflow. They are Release assets only and are not committed to the Git repository. 1.1.40 also retains the historical 1.1.33 direct-extract rescue overlay for the known pre-1.1.36 apply-path failure mode.

The migration deltas deliberately do not require removal of an older
`packages/waishnav-devspace-<semver>.tgz` archive. Historical same-version
repacks could leave a byte-different copy of that generated core archive on an
otherwise valid installation. Older updaters treat a hash mismatch on a file
listed in `deletedFiles` as a hard safety failure, which would unnecessarily
force a full-package fallback. The target `app/package-lock.json` references
the new core archive, so an older TGZ is inert and may safely remain. Ordinary
deleted program files continue to require an exact base hash.

## Incremental chain from 1.1.40 onward

After the migration checkpoint, a normal Release only needs its previous-version delta. The 1.1.40+ updater reads uploaded SHA-256/size metadata from stable GitHub Release assets, builds a directed graph of valid `file-delta-v1` edges, and selects the byte-minimal path from the installed version to the latest stable version.

The latest `update-manifest.json` also carries forward the validated historical edge graph. A jump update therefore normally needs only the latest small manifest to discover older adjacent deltas. Enumerating historical GitHub Releases remains a bounded compatibility fallback when that manifest cannot be fetched or does not contain a complete path. The delta ZIP bytes themselves remain attached to their original Releases and are never copied into Git or duplicated onto every new Release.

For example, a machine that remains on 1.1.40 while 1.1.43 is current may select:

`1.1.40 -> 1.1.41 -> 1.1.42 -> 1.1.43`

All selected packages are downloaded and verified while DevSpace remains running. The updater then stops the Portable-owned runtime once and applies the entire chain under one backup transaction. Intermediate versions are not launched. If any package is missing, malformed, discontinuous, hash-invalid, contains an unsafe path, fails deletion-base validation, or does not produce its declared intermediate `VERSION-MANIFEST`, the transaction rolls back to the original installed version. The existing complete ZIP remains the final fallback.

This removes the need for each future latest Release to carry a growing matrix of old-version deltas while preserving one-click incremental upgrades for 1.1.40+ installations that skip Releases.

## Remote Workspace Agent SSH rescue

The Linux Agent lifecycle remains layered:

1. systemd hosts use the enabled `devspace-agent.service` and recover automatically after a host reboot;
2. non-systemd/container environments keep the existing ordinary-user `nohup` mode, which survives SSH logout but cannot by itself survive a container lifecycle restart;
3. 1.1.40 adds an SSH rescue channel in the Windows control center for an enrolled Agent that is offline.

The **Remote server / Linux Agent** page now stores server host/IP, SSH port, username and an optional password. Passwords are never written in plaintext. They are protected with Windows DPAPI for the current Windows user and stored under Portable `data/`; the password is passed to OpenSSH only through the child-process environment and a dedicated `DevSpace-SshAskPass.exe` helper. The password is not appended to the SSH argument list, remote shell command, DevSpace logs or Agent configuration.

**Test SSH** validates the endpoint. **One-click recover / install Agent** first searches the existing user-state and legacy `/var/lib/devspace-agent` locations and tries to restart the existing identity. On real systemd hosts it prefers the existing user service or a passwordless administrative service restart; otherwise it starts the existing Python Agent with the persisted `config.json`. Only when the server reports that Agent files are not installed does the UI generate a new short-lived enrollment and execute the same SHA-256-verified installer command that remains visible for manual use.

An optional **automatic SSH recovery** setting is evaluated by the main control center even while it is minimized to the tray. Offline enrolled Agents with a saved opt-in SSH profile are retried with a two-minute per-Agent backoff. Background failures stay quiet; the explicit Remote Agent page remains the diagnostic surface and the copyable manual command remains the final fallback.

SSH rescue does not replace the outbound Agent architecture. Normal Remote Workspace I/O continues to use the Agent WebSocket; SSH is only the recovery/bootstrap channel.

## Native image and PDF attachments

1.1.40 adds the top-level read-only MCP tool `read_attachment`.

- PNG, JPEG, WebP and GIF are returned as native MCP `image` content blocks.
- PDF and SVG are returned as embedded MCP `resource` blocks with their original MIME type and bytes.
- Local and Remote Workspace files use the same contract; remote bytes are read through the authenticated Agent chunk transport.
- The ordinary `read` tool auto-detects the same media extensions and routes them through the native attachment path as well. This prevents an image/PDF read from silently falling through to a local Codex Runtime, OCR, `pdftotext`, or subagent conversion merely because the caller chose `read` instead of `read_attachment`.
- No local model invocation is part of this path. Inline MCP attachments are currently bounded to 32 MiB to prevent an individual tool result from exhausting the server/tunnel response budget; an oversize attachment fails explicitly and instructs the caller not to fall back to a local model.

The existing generated-artifact preview path is unchanged and continues to return small image previews alongside normal mutation results.

## Native input hit targets and Remote Agent layout

The rounded native input field used by the control center is visually taller than the Windows single-line TextBox hosted inside it. Earlier builds could leave part of that visible field owned only by the surrounding Panel. The pointer then became a normal arrow and clicking that lower region did not place a caret.

1.1.40 fixes this in both shared input host implementations. Single-line TextBox editors are explicitly vertically centered, while ComboBox and NumericUpDown controls keep the full available host height required by their native/owner-drawn rendering. The full rounded host forwards pointer activation to the real child control. Text fields also map the host click back to a caret position. This affects configuration fields, OAuth client fields and Remote Agent SSH/enrollment fields consistently rather than applying a page-specific workaround.

The Remote Agent page also no longer relies on card space that is barely sufficient at one DPI. Its explanatory labels have dedicated vertical space and the dialog scrolls on shorter displays, preventing the SSH rescue hint and the no-sudo installation note from being clipped by a rounded card boundary.

## Regression coverage

1.1.40 adds a real two-step updater transaction fixture. It verifies that the same file can change in multiple consecutive deltas without overwriting the original rollback backup, validates an intermediate `VERSION-MANIFEST`, exercises deletion-base protection at the correct intermediate state, and forces a second-step failure to prove that the complete chain rolls back to the original 1.1.40 bytes.

The online updater contract additionally checks Release-graph discovery, carry-forward graph manifests, byte-minimal path planning, chain staging and chain application markers. Native UI builds now compile the dedicated SSH askpass helper, and the native layout self-test verifies Remote Agent hints/buttons, lower-half text-field hit targets and an unclipped owner-drawn ComboBox. Runtime-card tests validate native image blocks and embedded PDF resources.

## Compatibility

- Portable version: 1.1.40;
- maintained upstream core baseline: 1.0.7;
- Linux Agent protocol: 1;
- Linux Agent version: 1.0.0;
- Portable Protocol: 1.5;
- migration floor for one-click exact delta to 1.1.40: 1.1.32;
- future updater model: historical adjacent-delta chain plus full-ZIP fallback;
- Remote Agent normal transport: outbound authenticated WebSocket;
- Remote Agent rescue transport: OpenSSH, opt-in per saved server profile;
- saved SSH password protection: Windows DPAPI, current-user scope;
- native attachment inline ceiling: 32 MiB per file;
- top-level MCP tool schema: changed;
- OAuth reset: not required;
- ChatGPT tool rescan: required/recommended after upgrade;
- `codex-runtime-bridge`: remains available for coding/subagent workloads but is not used by native image/PDF attachment reads.
