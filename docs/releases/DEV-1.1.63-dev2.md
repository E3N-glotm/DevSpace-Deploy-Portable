# DevSpace Portable 1.1.63 dev2

1.1.63 dev2 extends the dev1 Remote Servers health indicators to the main
overview and replaces the previous permanent "connectivity not verified"
message with an actual public MCP verification.

## Home health cards

- The Local MCP card now has an explicit green/red health light.
- The Public Mode card now has a state light and reports the configured
  provider separately from its connectivity result.
- Public connectivity is verified against the configured HTTPS endpoint using
  the OAuth protected-resource metadata endpoint (expected HTTP 200) and the
  MCP endpoint without credentials (expected HTTP 401).
- Healthy public MCP is green; a completed failed verification is red; the
  initial in-flight state is amber; local-only mode is gray.

## Refresh policy

- While the Home page is visible, status is refreshed every five seconds.
- Public network probing is performed only by explicit renderer status
  refreshes, including the Home page visibility-aware refresh loop.
- The existing background main-process status timer remains local/passive, so
  navigating away from Home or hiding the window does not create periodic
  public traffic.
- Refresh requests are coalesced in the renderer to avoid overlapping probes.

## Validation

- Focused tests cover the two health lights, removal of the hard-coded
  "connectivity not verified" label, five-second visible-page polling, and
  the expected 200/401 public verification contract.
- The existing dev1 Remote Servers five-second heartbeat display remains
  unchanged.
