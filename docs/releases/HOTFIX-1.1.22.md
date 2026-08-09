# DevSpace Portable 1.1.22

1.1.22 concentrates on three failures observed in 1.1.20/1.1.21: stale local
proxy settings could make GitHub checks or public readiness appear hung;
incremental updates could fall back to a 500+ MB full ZIP because a locally
built Portable and the GitHub Actions canonical build had different generated
artifacts; and a staged update could close the control center without proving
that the independent Apply process had actually taken over. It also replaces
the 1.1.21 Sangfor-specific tunnel lifecycle with a non-invasive networking
policy and redesigns the native homepage around automatic live indicators.

## Network coexistence

The tunnel supervisor no longer inspects or reacts to EasyConnect/Sangfor
processes or network adapters. In particular, 1.1.22 contains no
EasyConnect/Sangfor/VNIC process-state polling and no periodic "VPN state
changed -> kill/restart ngrok" loop.

At tunnel launch or a natural tunnel-child reconnect, ngrok is isolated from
ambient WinINET and inherited `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` values.
Only a user-explicit ngrok `proxy_url` is forwarded to the agent; otherwise the
agent uses a direct socket. This matters because ngrok treats outbound-agent
proxying as a distinct capability, and automatically inheriting a v2rayN
system proxy can make an otherwise healthy tunnel fail. Transparent TUN mode
still works because the TUN layer can route that direct socket without DevSpace
injecting an ngrok proxy setting.

DevSpace does not edit WinINET, WinHTTP, Windows routes, VPN/TUN adapters,
EasyConnect, v2rayN, sing-box, or their processes.

Public OAuth/HTTP readiness uses the same explicit proxy/direct policy through
the bundled curl runtime instead of relying on Node `fetch()` to reach the
public endpoint directly. This allows DevSpace to start normally when v2rayN
system proxy is already active.

## GitHub update transport

Metadata, manifest and ZIP requests enumerate healthy proxy candidates and
then the explicit direct/TUN path. Inherited proxy environment variables are
removed from the curl child so `--noproxy '*'` cannot still be undermined by a
stale `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` value.

Downloads retain:

- bounded connect timeout;
- low-speed stall detection;
- partial-file resume;
- real-time byte/speed/ETA reporting;
- one clean retry when a CDN rejects a resumed partial file;
- size and SHA-256 validation.

## Incremental update compatibility

`file-delta-v1` remains incremental-first with a full ZIP fallback. 1.1.22
recognizes that a local release build and GitHub Actions may legitimately
produce different bytes for a narrow set of generated release artifacts even
when both identify as the same Portable version. Since the delta already
carries the complete replacement file, base drift is accepted only for:

- `SHA256SUMS.txt`;
- `VERSION-MANIFEST.json`;
- `app/package-lock.json`;
- `app/node_modules/.package-lock.json`;
- `packages/waishnav-devspace-*.tgz`.

All ordinary program/source files still require the exact expected base
SHA-256. Deleted files remain strict. `data/`, `logs/` and `reports/` remain
forbidden incremental targets. This keeps drift protection while avoiding a
full-package fallback caused solely by build-generated metadata.

## Apply takeover acknowledgement

1.1.21 and earlier considered a detached `spawn()` call sufficient proof that
Apply had launched. If that PowerShell process failed before executing the
updater, the UI could close while the installation remained on the old
version.

1.1.22 registers a unique one-shot, least-privilege Task Scheduler controller
for Apply. The independent updater validates the stage and writes
`apply-launch-ack.json` containing its own PID, target version, update mode and
timestamp. The native UI only closes after the manager has read this ACK. If
the ACK is absent, the task is ended/removed, the UI remains open, and Task
Scheduler plus updater-log diagnostics are surfaced. The transient task also
deletes itself after successful apply or rollback.

Transactional same-volume backup, target manifest verification, service
restart and rollback behavior are retained.

## Native dashboard

The status/deployment homepage no longer depends on a manual **Refresh
status** button. It now refreshes a lightweight structured status approximately
every seven seconds and displays rounded activity cards with colored dots for:

- overall DevSpace state;
- local MCP service;
- public tunnel;
- HTTP/OAuth checks;
- critical release files/version;
- outbound network policy;
- Computer Use.

The existing diagnostic depth is not removed. A new **Details** dialog contains
the full status output, HTTP validation, tunnel diagnosis, file verification,
DevSpace/tunnel/update log tails, Task Scheduler shortcut and log-directory
shortcut. Heavy checksum verification therefore runs only on demand rather
than on every dashboard refresh.

## Regression coverage

The 1.1.22 source suite adds or extends checks for:

- isolation of ambient v2rayN/system proxy settings from the ngrok child;
- explicit ngrok `proxy_url` compatibility when intentionally configured;
- dead loopback proxy skipping in GitHub/public HTTP probes;
- transparent-TUN direct mode;
- absence of Sangfor/EasyConnect/VNIC polling in the tunnel supervisor;
- no WinINET registry mutation;
- GitHub dead-proxy skipping and explicit direct/TUN fallback;
- generated-build-artifact drift tolerance while preserving ordinary drift
  protection;
- Task Scheduler Apply ACK success and pre-ACK failure rejection;
- automatic homepage indicators and relocation of detailed diagnostics out of
  the homepage.

Portable Protocol remains **1.5** and the top-level MCP schema is unchanged.
