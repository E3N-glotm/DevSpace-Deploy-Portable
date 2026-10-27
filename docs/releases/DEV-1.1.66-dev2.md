# DevSpace Portable 1.1.66 dev2

Development preview built from the same E-drive source tree as dev1. This is
not a stable GitHub release and must not replace a live Portable installation.

## Background public health and desktop status

- Root cause: the desktop retained successful public HTTPS evidence for only
  two minutes, while the main-process 20-second background timer checked local
  MCP health only. Minimized/hidden renderers suspend their foreground
  five-second public checks, causing a false amber status on return.
- Verify public OAuth metadata and unauthenticated MCP response every 60 seconds
  from the persistent Electron main process even when the window is hidden.
  Concurrent foreground requests are coalesced; this does not restart the
  tunnel or launch a fresh manager process.
- Keep an expired previously successful result distinct as a neutral stale
  state, not as a new connection failure. A successful new probe restores
  green; multiple confirmed unexpected HTTP contract responses correctly
  produce red even if the previous success was recent. Timeouts do not count
  toward confirmed HTTP failures.
- Reconcile status publications with the monitor's newest evidence; drop
  outdated configuration results and ignore older renderer status timestamps.
  Cancel and invalidate superseded URL probes, including A->B->A changes.

## Verification

- Unit tests cover hidden-window success expiry, background re-verification,
  explicit HTTP outages, timeout-versus-HTTP failure thresholds, coalesced
  probes, configuration changes and stale-response races.
- Source and build checks run locally; no production D-drive instance is
  modified, and GitHub stable releases remain unchanged.
- Production dependency audit is **not clean** on the audit database checked
  on 2026-10-27: 7 reported advisories (4 moderate, 3 high), including
  upstream `undici` 8.x where npm reported no available fix. Dependency
  remediation is outside this health-indicator-only development iteration;
  it must be re-evaluated before promoting any 1.1.66 build to stable.
