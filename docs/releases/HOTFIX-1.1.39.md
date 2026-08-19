# DevSpace Portable 1.1.39

> 2026-08-19 repack revision 2: the 1.1.39 Release assets were rebuilt in place again after a real containerized Ubuntu host confirmed two additional defects: the installer assumed systemd was PID 1, and the generated one-line command exited the user's interactive SSH shell. The Remote Agent dialog was also rebuilt without its custom rounded SurfacePanel/FieldHost layers after real resize screenshots showed persistent repaint ghosts. The version and Portable Protocol remain unchanged; these replacement assets supersede all earlier 1.1.39 binaries.

## Scope

1.1.39 adds the final Remote Workspace Backend to the maintained Windows Portable control plane. The public MCP/OAuth endpoint remains on Windows; enrolled Linux hosts run a lightweight outbound Agent and are opened with `devspace://<agent-id-or-name>/absolute/linux/path`. After `open_workspace`, the same workspaceId is used by the existing file, search, patch, process, file-watch and review tools.

Portable Protocol remains 1.5. The top-level MCP tool schema changes because remote backend metadata is added to `open_workspace` and `session_restore_safety` is introduced, so clients should Refresh / Scan Tools after upgrading.

## Enrollment and trust boundary

- Native Windows UI adds **Remote server / Linux Agent** management.
- Enrollment tokens are cryptographically random and stored only as SHA-256 hashes. They expire after 15 minutes by default. The first accepted hello reserves the enrollment and creates the Agent identity; until the Linux Agent confirms durable credential persistence, the same token has a bounded 2-minute recovery window.
- A recovery hello reuses the same Agent ID but rotates to a fresh Agent secret, invalidating any secret that may have been returned on an earlier interrupted attempt. After the Linux Agent atomically persists the credentials it sends an explicit enrollment confirmation and the control plane immediately deletes the enrollment row.
- The Python Agent performs up to three bounded enrollment attempts for transport/TLS failures and now reports WebSocket close code/reason instead of only a generic close message.
- Successful enrollment issues a separate persistent Agent secret, stored only as a hash on the control plane. The short recovery mechanism does not store plaintext Agent secrets in SQLite.
- The generated Ubuntu command verifies the installer SHA-256 before execution; the installer independently verifies the Agent script SHA-256 before enrollment.
- The Agent service refuses to run as root. Its systemd unit uses `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only` and explicit `ReadWritePaths` for state plus configured allowed roots.
- Reinstall/re-enrollment temporarily stops an already-active `devspace-agent.service` before the enrollment handshake so a stale service cannot race with the new identity; if enrollment fails, the installer attempts to restore the previously active service.
- The installer now detects whether PID 1 is actually systemd. Only a real systemd host receives the systemd unit. Docker/LXC/other non-systemd environments automatically use an ordinary-user `nohup` fallback with a guarded PID file and private log under `/var/lib/devspace-agent`; the Agent survives SSH logout instead of failing after a successful enrollment because `systemctl` cannot reach a bus.
- The generated one-line install command now runs its cleanup/exit-code logic inside a subshell. It still returns the installer status to the terminal but no longer executes `exit` against the user's interactive SSH shell.
- Agent WebSocket upgrades obey the same Host allowlist/public hostname boundary used by the control plane.
- Revoked Agents are rejected for new RPC and existing connections are closed by heartbeat validation.

## Transparent remote workspace tools

Remote checkout/worktree sessions persist their backend and Agent identity in SQLite. Conversation-aware checkout reuse from 1.1.38 therefore also works for remote projects.

Remote backends cover:

- read/write/edit and Codex-style `apply_patch`;
- grep/glob/list and generated-artifact previews;
- `exec_command`, `write_stdin`, process list/attach/kill, PTY and persistent processes;
- file watch start/poll/stop/list;
- lifecycle hooks;
- remote worktree creation;
- system/GPU status returned during `open_workspace`.

The model does not need to fall back to SSH/SFTP simply because the workspace resides on Linux.

## Bounded transfer and reconnect semantics

Large files are transferred as 512 KiB chunks with per-chunk SHA-256 and a whole-file SHA-256. Compressible chunks use gzip-base64; unchanged chunks can be reused during delta writes. A single RPC frame remains bounded to 8 MiB.

If an Agent is briefly offline, a request that has not yet been transmitted can wait for a bounded reconnect grace period. Once an RPC frame has been sent, a disconnect rejects the pending call. DevSpace never blindly replays an ambiguous remote mutation.

The Agent also bounds directory enumeration, grep candidates/results, file watches, process registry size, concurrent RPC handlers, structured review capture size and text-read output.

## Native control-center repack fixes

The replacement 1.1.39 assets also rebuild the two newly exposed administration dialogs around the same visual components used by the main control center.

- **AI / MCP OAuth clients** no longer uses a `SplitContainer`. It uses responsive table columns and `SurfacePanel`, `FieldHost` and `ModernButton`, which removes the first-open `SplitterDistance` failure path entirely for this dialog.
- Manual-client creation and selected-client credentials are now separate information areas. Selecting an existing ChatGPT/Gemini DCR registration no longer overwrites the manual-client name/Redirect URI form, so a DCR Client ID cannot be mistaken for the credentials that Gemini is asking the user to create manually.
- Client Secret visibility has an explicit show/hide action. One-time secret semantics are stated next to the selected client, and create/rotate success messages are preserved after the list refresh.
- **Remote server / Linux Agent** was rebuilt a second time after real resize screenshots exposed rounded-border repaint ghosts. This dialog now contains no `SurfacePanel` and no `FieldHost`: it uses stable rectangular Panel/TextBox cards, a percentage-height Agent list, a fixed-height configuration area and the shared `ModernButton` palette. This removes stale rounded-border trails, overlapping controls and bottom-row clipping while preserving the main control-center typography and colors.
- Shared `SafeSplitLayout` now guards against re-entrant WinForms size/layout events and keeps a one-pixel safety margin when restoring panel minimums. Split-based plugin/Memory/log pages retain responsive behavior without assigning a boundary value that a nested DPI/Dock event can invalidate.

## Remote review and safety restore

Remote workspaces use the existing Windows-side `sparse-journal-v4` review store instead of creating a second review repository on Linux. Structured mutations capture only the explicitly affected paths through the Agent. Existing 32 MiB per-session and 512 MiB aggregate review-state ceilings remain unchanged.

`session_rollback` can restore remote tracked paths through the currently authenticated Agent and creates the same pre-rollback safety snapshot as a local workspace. 1.1.39 adds `session_restore_safety` so that snapshot can also be restored through the active MCP session. Arbitrary shell side effects remain explicitly outside complete rollback coverage.

The native control center retains remote history visibility, but intentionally does not perform an out-of-process remote rollback without an authenticated live Agent connection; it directs the user to the MCP rollback tools instead.

## Regression coverage

The dedicated Remote Workspace Backend regression uses a real local HTTP/WebSocket control-plane path with a protocol-level Linux Agent fixture. It covers first enrollment, interrupted-enrollment recovery with stable Agent ID and rotated secret, explicit confirmation/pruning, persistent Agent authentication, remote workspace open/reuse and SQLite recovery, path-escape rejection, chunked read/write, sparse review, rollback, safety restore, GPU status, bounded reconnect waiting, ambiguous sent-RPC failure and Agent revocation. The source suite also checks the formal `devspace serve` CLI wiring so the Agent WebSocket handler cannot be omitted from the Portable startup path.

Linux Agent Python and installer syntax are validated without modifying a production Linux host. The public ngrok endpoint was independently exercised with both Node `ws` and dependency-free Python TLS/WebSocket framing: HTTP 101 and the extended-length `hello_ack` carrying an Agent Secret were received successfully. The Agent contains an additional dependency-free `self-test` command for Linux-side filesystem, transfer, process and status validation when installed on a target host.

Native UI self-test verifies that the OAuth dialog contains no `SplitContainer`, uses the responsive surface-column structure, and that the remaining shared vertical/horizontal split layouts survive transient 120–1800 px widths and 90–980 px heights. The Remote Agent dialog additionally verifies that it contains zero `SurfacePanel`/`FieldHost` instances and lays out successfully at 980×720, 1080×760, 1180×820 and 1360×900.

## Compatibility

- Portable version: 1.1.39;
- maintained upstream core baseline: 1.0.7;
- Linux Agent protocol: 1;
- Linux Agent version: 1.0.0;
- enrollment recovery window: 120 seconds, until explicit confirmation;
- enrollment transport attempts: up to 3;
- Linux service mode: systemd when PID 1 is systemd; ordinary-user background fallback otherwise;
- generated install command: subshell-scoped, does not close the caller's interactive SSH shell;
- Portable Protocol: 1.5;
- top-level MCP tool schema: changed;
- OAuth reset: not required;
- ChatGPT tool rescan: required/recommended after upgrade;
- local workspace behavior: preserved;
- existing persisted local workspace IDs: remain valid;
- `codex-runtime-bridge`: remains mandatory in formal full/incremental Release packages.
