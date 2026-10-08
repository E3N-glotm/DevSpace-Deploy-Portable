# DevSpace Portable 1.1.63

1.1.63 promotes the validated 1.1.63 dev1/dev2 line to stable.

## Remote server health

- Registered Linux Agents again expose explicit live health indicators.
- `online` and `online-recent` render green, offline/error states render red,
  and revoked credentials render gray.
- The Remote Servers page silently refreshes heartbeat state every five seconds
  while visible, without toggling the page busy state or stacking requests.

## Home connectivity health

- The Local MCP overview card now has an explicit green/red health light.
- The Public Mode card no longer permanently reports "connectivity not verified".
- While Home is visible, DevSpace verifies the configured public endpoint every
  five seconds using the OAuth protected-resource metadata endpoint (HTTP 200)
  and unauthenticated MCP endpoint (HTTP 401).
- Public health is green when both expected responses are observed, red after a
  completed failure, amber while verification is pending, and gray in local-only
  mode.
- Background main-process status refresh remains local/passive; public probes are
  limited to visible Home-page status refreshes.
- Public endpoint probes now use an eight-second network window instead of the
  two-second local MCP timeout. A single outbound DNS/TLS/proxy delay never
  turns an actively used public MCP endpoint red: recent successful verification
  is retained for up to two minutes, and transport-only failures show an
  amber **unverified** state rather than claiming the tunnel is offline.
- Repeated explicit OAuth/MCP HTTP-contract failures are distinguished from
  timeout/transport uncertainty; endpoint changes reset previous evidence.

## Updater reliability

- Fixed a Windows Electron PID-reuse race in the transactional updater. Already
  validated Portable UI process objects are now stopped directly instead of
  re-opening the numeric PID after another UI process exits.
- Existing rollback, strict ownership checks, service recovery and persistent
  configuration preservation remain in place.
- For legacy shallow update bridges, the compact launcher detects the pending
  `legacy-upgrade-bootstrap.json` marker and invokes the same-version full
  repair **before** requiring Electron runtime files. Windows process detection
  additionally attempts a compatible WMI fallback after CIM failure, while
  retaining strict process ownership and fail-closed behavior.

## Defaults retained from 1.1.62

- Automatic continuation remains opt-in and disabled by default.
- The default tool mode remains `codex`.

## Validation

- React/TypeScript production build and the UI test suite pass.
- Electron navigation, dashboard status, public-probe concurrency, network
  isolation, updater recovery and source-tree verification pass.
- Public endpoint acceptance was checked against the configured live hostname
  before promotion.
- Production dependency pins were refreshed to patched `fast-uri 3.1.7`,
  `ip-address 10.7.2` and `undici 8.10.2`; the production npm audit is clean.
- Release CI now hydrates the Electron runtime and builds the Next UI before
  release-layout acceptance, so a clean GitHub runner exercises the same
  installed UI payload as the local release build.
