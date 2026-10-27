# DevSpace Portable 1.1.66 — Stable Release

Official stable promotion of the 1.1.66 development series, including the
features of dev1 and the public health-monitoring fixes of dev2.

## Remote Linux Agents and explicit Memories

- Scoped SSH deployments now accept explicit Linux writable directories,
  independent of the Agent installation directory. Multiple authorized roots
  can be edited, validated and re-enrolled without silently changing scope.
- Explicit workspace Memories can bind to an actual subdirectory using a
  Windows folder picker or absolute path. Server-side authorization checks
  resolve physical paths, block symlink/junction escape, and retain the
  configured access boundary.

## First-run setup and connectivity

- Improve first-run deployment retry/timeout diagnostics and avoid repeating a
  successful initial save on retry. A successfully started local MCP is not
  incorrectly reported as failed merely while Cloudflare tunnel ingress is
  still propagating.
- Electron background public verification continues while its window is
  minimized or hidden; an expired successful probe is represented as stale
  telemetry rather than a confirmed outage.
- Concurrent public checks share one probe, discard superseded URL/config
  results, and preserve the newest checked status. Consecutive explicit HTTP
  contract failures still turn the indicator red; transport timeouts alone do
  not prove loss of active MCP sessions.

## Production dependency audit

- Refresh pinned/transitive runtime dependencies to fixed advisory versions:
  undici 8.12.3, body-parser 2.4.0, ip-address 10.7.5, zod 4.6.7.
- Production audit and the complete regression suite are release gates;
  advisories are not ignored or suppressed.

## Upgrade behavior

- Updates preserve existing user configuration, secrets, OAuth clients,
  persistent state, remote Agent identities, and user logs. Installing this
  release must be a separate user-confirmed operation.
