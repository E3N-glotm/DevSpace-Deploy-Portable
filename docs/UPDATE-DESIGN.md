# Application and network lifecycle design through 1.1.29

## Goal

Version 1.1.16 keeps the public GitHub Releases update flow introduced in
1.1.15 and adds file-level incremental packages with automatic full-package
fallback while preserving configuration, OAuth state, plugins, sessions, and
rollback safety.

The first implementation uses a detached updater, a staging directory and a
same-volume backup around a controlled restart. It never replaces files while
the native UI is still running.

## Implemented in 1.1.29: strict lifecycle separation and non-interference

1. Local MCP and the public tunnel are separate lifecycle units. Installing or
   starting the local service does not start the tunnel, does not require a
   tunnel runtime/token, and does not stop/restart an already running tunnel.
   A freshly installed tunnel task is disabled until explicitly started, while
   task repair/update preserves an existing enabled/disabled tunnel choice.
2. The three-second homepage refresh is public-network passive. It probes only
   loopback endpoints and reads local task/PID/agent state. Public OAuth/HTTP
   requests are reserved for explicit user diagnostics; the homepage may only
   display a cached result from such a diagnostic.
3. Interface/address/route topology remains observable, but topology changes no
   longer terminate or reconnect the public tunnel. The provider keeps its own
   connection across VPN/TUN/Wi-Fi route changes; the supervisor intervenes
   only when its own child exits or its own explicit proxy configuration
   changes/becomes unavailable.
4. The tunnel child removes inherited HTTP/HTTPS/ALL proxy environment
   variables. Only a user-explicit DevSpace tunnel proxy is injected. WinINET
   system proxy switches therefore do not silently become tunnel dependencies;
   transparent TUN routing is still naturally selected by Windows.
5. The dashboard can read WinINET proxy state and warn when an enabled loopback
   proxy points to a port that is no longer listening. Repair is never automatic:
   a separate confirmed action stores a rollback backup and disables only that
   stale proxy setting.
6. Normal runtime paths remain vendor-neutral and do not mutate proxy settings,
   WinHTTP, DNS, routes, interface metrics, VPN/TUN adapters, or third-party
   processes. An enterprise policy that intentionally blocks a tunnel provider
   still requires allowlisting or a truly independent user-supplied egress.

## Implemented in 1.1.28: non-blocking status and a topology quiet window

> The active topology quiet/reconnect behavior in this historical section is
> superseded by the 1.1.29 non-interference model above. Public probes are also
> no longer part of the automatic homepage refresh.

1. Loopback MCP probes use a direct local HTTP request and never depend on an
   ambient proxy. Public curl probes run as asynchronous child processes, so a
   slow proxy or public route cannot block the Node event loop until the local
   probe's timeout expires.
2. Local dashboard state refreshes every three seconds. Successful public
   verification is cached for fifteen seconds, while a failed result expires
   after two seconds so the next UI cycle can show recovery instead of keeping
   a stale red result. Operations and the Details dialog request an immediate
   dashboard refresh when they complete.
3. The supervisor creates one signature from every connected IPv4 interface,
   its active addresses, and all of its active routes. On the first signature
   change it immediately stops only its owned public-tunnel child and suppresses
   all DevSpace public health probes. Local MCP remains running. The tunnel and
   public probes resume only after the complete topology has been unchanged for
   fifteen seconds, and every additional change restarts that quiet window.
4. The tunnel never adopts an ambient WinINET or inherited environment proxy.
   A user-explicit ngrok `proxy_url` remains authoritative; otherwise the agent
   uses Windows system routing. This avoids relying on an ngrok agent proxy
   feature that is not available on every account tier.
5. Dashboard public checks follow the supervisor's selected egress exactly;
   they do not try an explicit proxy and then fall back to a direct path.
6. The policy remains vendor-neutral and read-only: no client/process/adapter
   names are inspected, and DevSpace does not write proxy settings, registry,
   routes, adapters, or third-party state. A remote VPN authorization rejection
   remains an administrator/server issue rather than something a local tunnel
   process can override.

## Implemented in 1.1.27: transactional task reconciliation and recovery

1. A configured Portable installation no longer assumes that its two Task
   Scheduler definitions survived until Apply. After target files and the
   target version manifest are verified, the target manager recreates the MCP
   and tunnel tasks before starting services.
2. Task definitions are treated as reproducible deployment state. User data,
   OAuth state, logs, reports, plugins, and sessions remain persistent and are
   never replaced by task reconciliation.
3. If target service startup fails, Apply stops the partial runtime, restores
   every moved old path, then uses the restored manager to recreate the old
   task definitions and restart the old services.
4. Rollback results distinguish file restoration from service restoration and
   retain the backup when recovery is incomplete. A failure to reopen the UI
   does not roll back an otherwise completed program and service transaction.
5. The PowerShell backend emits a one-line JSON failure object and a concise
   final stderr line. This preserves the real failure for old Update.exe
   controllers, while 1.1.27 prefers structured output and the progress file
   over PowerShell metadata such as `FullyQualifiedErrorId`.

## Implemented in 1.1.26: vendor-neutral network-path adaptation

> The keep-running debounce behavior in this historical section is superseded
> by the 1.1.29 strict non-interference model above.

1. The 1.1.25 full-session pause keyed to named client processes is removed.
   Tunnel lifecycle decisions no longer identify a VPN/TUN vendor, process,
   service, or adapter name.
2. The supervisor reads connected IPv4 default routes from the Windows active
   route store and creates a stable signature from route/interface identity
   and metrics. This is observation only.
3. A new signature must remain stable across consecutive polls before action.
   During that window the existing public tunnel stays running. A settled
   change reconnects only the tunnel `ChildProcess` owned by the supervisor.
4. A user-explicit ngrok proxy remains authoritative. Without one, ambient
   proxy variables are isolated from the tunnel child and the current Windows
   route, including a transparent TUN route, selects egress.
5. Public readiness failure no longer tears down a healthy local MCP service.
   The tunnel supervisor remains enabled and can recover when the path becomes
   usable.
6. Multiple active default routes are informational. The dashboard always
   tests public access and explains provider blocking without writing routes,
   proxy settings, adapters, registry values, or third-party state.

The application cannot create a truly independent physical egress when a
full-tunnel or enterprise endpoint policy blocks all provider traffic. That
case requires administrator allowlisting or a user-supplied independent
proxy/relay; DevSpace does not silently install privileged route/WFP policy.

## Implemented in 1.1.24: standalone Update.exe and target-file delta semantics

1. The main control center no longer owns the long-running update workflow.
   `Check for updates` starts root-level `Update.exe`, which performs check,
   stage, progress display, confirmation, and installation independently.
2. Before replacement begins, `Update.exe` copies itself outside the Portable
   root into `%TEMP%/DevSpacePortableUpdater/<guid>/Update.exe`. The temporary
   controller verifies that the supplied UI PID still resolves to this
   installation's `DevSpace-Portable.exe`, closes that UI, and then invokes the
   transactional PowerShell Apply backend directly. The normal 1.1.24 path
   does not require Task Scheduler.
3. `file-delta-v1` changed entries contain complete target files, not binary
   patches. A changed file's base SHA-256 is therefore diagnostic only in
   1.1.24: local drift or a missing old file no longer forces a full package.
   The downloaded target file and the final installed file are still verified
   against the release-pinned SHA-256.
4. Deletions remain strict because deleting a locally modified file is not
   equivalent to replacing it with a manifest-pinned target. `data`, `logs`,
   and `reports` remain excluded from incremental mutation.
5. The older manager `update-check`, `update-stage`, and `update-launch`
   commands remain available for backwards compatibility and bootstrap from
   pre-1.1.24 installations.

## Implemented in 1.1.23: review density and first-run credential usability

1. Session-title groups are collapsed by default, with explicit per-group
   `▶/▼` state and global expand/collapse controls. Search temporarily reveals
   matching child sessions without permanently rewriting the user's expanded
   group state.
2. Group header rows are not valid review-session selections, so expanding a
   group cannot accidentally enter the review/rollback workflow.
3. The first-run Owner Password dialog shows both the generated secret and the
   exact `auth.json` path. Each value has its own clipboard action.
4. The network ownership boundary from 1.1.22 remains unchanged: these UI
   changes do not inspect, start, stop, reconfigure, or repair third-party VPN
   clients.

## Implemented in 1.1.22: non-invasive networking and acknowledged apply

1. Public health probes and GitHub update requests now enumerate explicit
   outbound paths instead of inheriting an arbitrary stale proxy. A local
   WinINET/environment proxy is used only when its loopback listener is
   actually reachable; otherwise it is skipped and curl uses an explicit
   direct/TUN path with inherited proxy variables removed.
2. The ngrok supervisor no longer observes EasyConnect/Sangfor processes,
   Sangfor VNIC state, or other third-party VPN adapters. A healthy tunnel is
   never stopped merely because a VPN client is logging in or changing state.
   Network-path selection happens when the Portable-owned tunnel child starts
   or must naturally reconnect.
3. The ngrok child is isolated from ambient WinINET and inherited
   `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` settings. Only a user-explicit ngrok
   `proxy_url` is forwarded to the agent. This prevents "v2rayN system proxy
   started first" from silently forcing the ngrok agent through an outbound
   proxy path. With transparent TUN active, the direct ngrok socket can still
   be routed by the TUN layer naturally. No WinINET, WinHTTP, route, adapter,
   EasyConnect, or v2rayN setting is changed by DevSpace.
4. `file-delta-v1` still rejects arbitrary local drift, but a small allowlist
   of deterministic Release build products (`SHA256SUMS.txt`,
   `VERSION-MANIFEST.json`, lockfiles and the packed core TGZ) may differ
   between a local build and the GitHub Actions canonical build because the
   delta contains the complete replacement file. Persistent paths and normal
   program/source files remain strictly base-hash checked; deletes remain
   strict as well.
5. Apply launch no longer means "spawn requested". The manager creates a
   one-shot, least-privilege Task Scheduler controller and waits for the
   independent updater to write `apply-launch-ack.json` with its PID and target
   version. The UI closes only after that ACK. Missing ACK leaves the current
   UI/version running and reports Task Scheduler/updater diagnostics.
6. The native dashboard reads a structured, lightweight `dashboard-status`
   command every seven seconds. Destructive/expensive checks stay out of this
   poll; full `status`, HTTP validation, tunnel diagnosis, checksum validation
   and log tails are available from the separate Details dialog.

The one-shot update task deletes itself after successful apply or rollback.
The Portable Protocol remains 1.5.

## Implemented in 1.1.21: VPN/proxy tunnel coexistence

> Superseded in 1.1.22: the Sangfor/EasyConnect process/VNIC negotiation
> observer described below was removed after it proved too coupled to a
> third-party VPN lifecycle. It is retained here only as historical design
> documentation for the 1.1.21 release.

The local MCP listener and the public tunnel now have deliberately separate
network lifecycles. A lightweight tunnel supervisor owns only the bundled
ngrok/cloudflared child and observes network state without changing Windows
network configuration.

For ngrok, the default compatibility mode follows these rules:

1. If Sangfor/EasyConnect is present but its Sangfor VNIC is not connected,
   keep the public tunnel paused while VPN login is negotiating.
2. After the VNIC reports connected, wait for a short route-settling window
   before launching the tunnel.
3. Prefer an explicit ngrok `proxy_url` when configured.
4. Otherwise, if WinINET currently exposes a healthy local proxy endpoint,
   launch the tunnel through that proxy rather than forcing direct egress.
5. On a VPN/proxy state transition, restart only the Portable-owned tunnel
   child. The MCP server and unrelated software are untouched.
6. Never mutate WinINET, WinHTTP, routes, adapters, or third-party processes.

The supervisor publishes `tunnel-network.json` so the UI/status path can
distinguish an intentional compatibility pause from a tunnel failure. A stop
sentinel prevents the supervisor from racing an explicit DevSpace shutdown.

## Implemented in 1.1.20: startup PID identity safety

Opening the native control center creates or refreshes a UI lease. That path
also retires any compatibility Computer Use Broker left by an older UI lease.
Prior to 1.1.20 the broker state contained a numeric PID and the retirement
path treated a currently-live process with that PID as the broker without
revalidating its identity. Because Windows reuses PIDs, a stale broker record
could therefore point at an unrelated application by the time the next UI was
opened.

1. Broker retirement now resolves the PID through the same direct Portable
   process inventory used by strict shutdown.
2. The process executable must exactly equal the current Portable bundled
   `runtime/node/node.exe`.
3. Its command line must contain the current root's
   `setup/computer-use-broker.cjs` path.
4. If the broker state contains a lease id, the same lease id must appear in
   the live broker command line.
5. If any check cannot be proven, only the stale state record is deleted; the
   live PID is left untouched.
6. A dedicated regression writes an unrelated live `PING.EXE` PID into a
   stale broker record and verifies both `ui-open` and `ui-close` preserve that
   process.

This startup rule is intentionally stricter than name-only process matching:
opening the DevSpace UI must never terminate VPN, proxy, IDE, shell, or other
third-party software solely because Windows reused an old broker PID.

## Implemented in 1.1.19: observable and network-isolated downloads

1. GitHub metadata, manifests and ZIP assets use the bundled Git `curl.exe` as
   the primary transport instead of waiting on multiple long Windows
   PowerShell web-request attempts.
2. The first request respects the process's current proxy environment. A
   failed proxy-aware request is retried directly with `--noproxy '*'`; this is
   a per-request decision and never changes WinINET, WinHTTP, EasyConnect,
   v2rayN, or another system/network application.
3. Downloads use bounded connect timeouts plus curl low-speed detection so a
   connected but stalled transfer fails visibly instead of waiting for the
   overall hour-scale timeout.
4. Partial ZIPs are resumed with `--continue-at -`. If the CDN rejects the
   Range resume, the updater performs one clean direct retry from zero.
5. `data/state/update-progress.json` is atomically refreshed during the update
   with phase, byte counts, percent, speed, ETA, transport, and timestamp.
6. The native UI polls this state every 500 ms and shows download speed and
   phase transitions while `update-stage` is still running.
7. Incremental/full selection, size/SHA-256 checks, base-hash drift detection,
   archive traversal protection, persistent-data exclusions and transactional
   rollback are unchanged.

1.1.19 also narrows process ownership during update/shutdown. Portable stop no
longer recursively inherits ownership into every child of the MCP process and
no longer uses `taskkill /T` for the normal owned-process cleanup. This keeps
third-party applications launched through DevSpace outside the Portable
shutdown boundary unless their own executable/launcher command is actually
part of the current Portable root.

## Implemented in 1.1.16: incremental first, full fallback

1. Each Release still contains the complete `DevSpacePortable-Windows-x64-<version>.zip`.
2. The release workflow additionally compares the new full ZIP with the latest
   stable full ZIP and generates
   `DevSpacePortable-Update-<from>-to-<to>.zip`.
3. The incremental package uses `file-delta-v1`: only changed/new files are
   included, while deleted paths are listed explicitly in `delta-manifest.json`.
4. `update-manifest.json` schema 2 advertises both the complete asset and one or
   more `incrementalAssets` keyed by exact `fromVersion`.
5. The updater first selects a delta whose `fromVersion` exactly equals the
   installed version. Before staging it verifies asset size/SHA-256, archive
   paths, every changed target file, and the installed SHA-256 of every file
   the delta will replace or delete.
6. Missing delta assets, malformed packages, SHA-256 mismatches, unsafe paths,
   or local drift in a touched base file automatically switch the same update
   attempt to the complete ZIP.
7. Incremental apply backs up and replaces only touched paths; complete apply
   retains the 1.1.15 top-level payload replacement behavior. Both modes share
   the same rollback, service restart, and persistent-data exclusions.
8. Users several versions behind can update without a chain of intermediate
   deltas: if no exact delta exists, the updater downloads the current full ZIP.
9. The updater shipped in 1.1.15 predates schema-2 `incrementalAssets`, so an
   already-installed 1.1.15 client still performs one complete-package update
   to 1.1.16. Incremental-first selection becomes effective for subsequent
   releases once the installed updater is 1.1.16 or newer.

## Implemented in 1.1.15

1. Query the public repository's latest stable Release without requiring a
   GitHub token.
2. Download `update-manifest.json` and the versioned Windows ZIP.
3. Verify Release/tag consistency, archive name, expected size and SHA-256.
4. Reject archive entries outside the `DevSpacePortable/` root or containing
   traversal components.
5. Extract to `.update-staging/<version>-<id>` and start a detached updater.
6. Stop the current Portable services while excluding the detached controller.
7. Back up the current application payload, replace it, verify the embedded
   version, restart services and reopen the UI.
8. Preserve `data/`, `logs/` and `reports/`; restore the previous application
   payload automatically if any apply or restart step fails.
9. Refuse application-level overwrite when the current directory contains
   `.git`, so source checkouts continue to use normal Git workflows.

## Future target layout

```text
DevSpacePortable/
├─ DevSpace-Launcher.exe
├─ DevSpace-Updater.exe
├─ current.json
├─ versions/
│  ├─ 1.1.14/
│  └─ 1.1.15/
├─ data/
├─ logs/
└─ update-cache/
```

`data/` and `logs/` remain outside versioned application directories. The
launcher reads `current.json` and starts the selected version.

## Future version-directory protocol

1. Read the latest stable GitHub Release and `update-manifest.json`.
2. Compare semantic versions and updater compatibility.
3. Download the ZIP to `update-cache/`.
4. Verify expected size, SHA-256, and a detached Ed25519 signature.
5. Extract to `versions/<version>.tmp` and verify the internal manifest.
6. Back up `data/state/devspace.sqlite` and configuration metadata.
7. Stop only processes owned by the current Portable installation.
8. Atomically rename the new directory and switch `current.json`.
9. Start the new version and run local listener, OAuth metadata, MCP, tunnel,
   plugin, and database-migration health checks.
10. If health checks fail, switch `current.json` back and restore the database
    backup.

## Security requirements

- HTTPS alone is not the trust boundary; the updater must verify a signature
  with an embedded public key.
- Release signing keys must not be stored in the repository or on a general
  self-hosted runner.
- Downgrades require explicit confirmation unless performed by automatic
  failure rollback.
- Update code must reject paths escaping the staging directory and must not
  follow archive links.
- A Release that changes the MCP top-level schema must clearly tell the user
  that the ChatGPT App definition needs refreshing.

## Channels

The manifest should support `stable`, `beta`, and `nightly`, with `stable` as
the default. Automatic installation should initially remain opt-in; background
checks may notify without silently replacing the active version.
