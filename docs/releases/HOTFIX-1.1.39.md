# DevSpace Portable 1.1.39

## Scope

1.1.39 adds the final Remote Workspace Backend to the maintained Windows Portable control plane. The public MCP/OAuth endpoint remains on Windows; enrolled Linux hosts run a lightweight outbound Agent and are opened with `devspace://<agent-id-or-name>/absolute/linux/path`. After `open_workspace`, the same workspaceId is used by the existing file, search, patch, process, file-watch and review tools.

Portable Protocol remains 1.5. The top-level MCP tool schema changes because remote backend metadata is added to `open_workspace` and `session_restore_safety` is introduced, so clients should Refresh / Scan Tools after upgrading.

## Enrollment and trust boundary

- Native Windows UI adds **Remote server / Linux Agent** management.
- Enrollment tokens are cryptographically random, stored only as SHA-256 hashes, expire after 15 minutes by default and can be consumed once.
- Successful enrollment issues a separate persistent Agent secret, also stored only as a hash on the control plane.
- The generated Ubuntu command verifies the installer SHA-256 before execution; the installer independently verifies the Agent script SHA-256 before enrollment.
- The Agent service refuses to run as root. Its systemd unit uses `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only` and explicit `ReadWritePaths` for state plus configured allowed roots.
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

## Remote review and safety restore

Remote workspaces use the existing Windows-side `sparse-journal-v4` review store instead of creating a second review repository on Linux. Structured mutations capture only the explicitly affected paths through the Agent. Existing 32 MiB per-session and 512 MiB aggregate review-state ceilings remain unchanged.

`session_rollback` can restore remote tracked paths through the currently authenticated Agent and creates the same pre-rollback safety snapshot as a local workspace. 1.1.39 adds `session_restore_safety` so that snapshot can also be restored through the active MCP session. Arbitrary shell side effects remain explicitly outside complete rollback coverage.

The native control center retains remote history visibility, but intentionally does not perform an out-of-process remote rollback without an authenticated live Agent connection; it directs the user to the MCP rollback tools instead.

## Regression coverage

The dedicated Remote Workspace Backend regression uses a real local HTTP/WebSocket control-plane path with a protocol-level Linux Agent fixture. It covers one-time enrollment, persistent Agent authentication, remote workspace open/reuse and SQLite recovery, path-escape rejection, chunked read/write, sparse review, rollback, safety restore, GPU status, bounded reconnect waiting, ambiguous sent-RPC failure and Agent revocation. The source suite also checks the formal `devspace serve` CLI wiring so the Agent WebSocket handler cannot be omitted from the Portable startup path.

Linux Agent Python and installer syntax are validated without modifying or connecting to a production Linux host. The Agent contains an additional dependency-free `self-test` command for Linux-side filesystem, transfer, process and status validation when installed on a target host.

## Compatibility

- Portable version: 1.1.39;
- maintained upstream core baseline: 1.0.7;
- Linux Agent protocol: 1;
- Linux Agent version: 1.0.0;
- Portable Protocol: 1.5;
- top-level MCP tool schema: changed;
- OAuth reset: not required;
- ChatGPT tool rescan: required/recommended after upgrade;
- local workspace behavior: preserved;
- existing persisted local workspace IDs: remain valid;
- `codex-runtime-bridge`: remains mandatory in formal full/incremental Release packages.
