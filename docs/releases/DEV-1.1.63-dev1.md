# DevSpace Portable 1.1.63 dev1

1.1.63 dev1 starts from the 1.1.62 stable line and restores live health
visibility on the Remote Servers page of the Next UI.

## Remote server heartbeat status

- Registered Linux Agents again show an explicit status indicator beside the
  server name.
- `online` and `online-recent` are shown as green/healthy.
- `offline`, unknown and error states are shown as red.
- Revoked credentials are shown as gray rather than being confused with a
  transient service failure.
- The page silently refreshes `remote-agent-list` every five seconds while
  it is visible, so heartbeat transitions appear without requiring the manual
  Refresh Status button.
- Background refreshes are coalesced and do not toggle the page's busy state,
  preventing button flicker and overlapping status requests.

## Validation

- React/TypeScript production build passes.
- UI test suite includes focused coverage for health-color mapping and
  five-second visibility-aware polling.
- Electron navigation smoke and source-tree verification pass.
- The existing 1.1.62 continuation defaults remain unchanged: automatic
  continuation is opt-in and the default tool mode remains `codex`.
