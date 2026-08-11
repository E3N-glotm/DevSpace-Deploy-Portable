# DevSpace Portable 1.1.25

> Superseded by 1.1.26: the named-client full-session pause documented below
> was removed because it necessarily disabled public MCP for the whole VPN
> session. This file remains the historical record of the 1.1.25 release.

## Scope

1.1.25 adds a general EasyConnect/Sangfor coexistence boundary, corrects
dashboard state convergence, and removes fixed-size review bottlenecks in the
native control center. Portable Protocol remains 1.5 and the top-level MCP
schema is unchanged.

## EasyConnect session isolation

The tunnel supervisor now treats an active EasyConnect/Sangfor client session
as a persistent isolation condition instead of a short negotiation window.

- The local MCP service remains available on its configured loopback port.
- Only the public tunnel child process owned by the DevSpace supervisor is
  paused and later recreated.
- Isolation lasts for the full Sangfor client session; there is no fixed
  20-second resume timer that can reintroduce a competing public connection.
- The dashboard skips public HTTP/OAuth probes while isolation is expected and
  reports a warning state rather than a false outage.
- Manual direct/proxy tunnel behavior remains unchanged when no Sangfor session
  is present or when compatibility is explicitly disabled.

This is deliberately an application-level boundary. DevSpace never terminates
or restarts EasyConnect, Sangfor, v2rayN, sing-box, or any other third-party
process. It does not modify WinINET/WinHTTP settings, registry values, network
adapters, routes, or third-party configuration files.

## Read-only TUN conflict diagnosis

The status path can identify the combination of an active Sangfor client and a
different active TUN adapter that owns an IPv4 default route. The UI explains
that this may be a route-competition condition and that DevSpace has not
modified it. This diagnostic is read-only and is not tied to a specific local
installation path or one named proxy product.

The isolation guarantees that DevSpace does not keep its own public tunnel in
the Sangfor session. It cannot guarantee that EasyConnect will remain logged in
when an independent third-party TUN rebuilds the machine's default route or the
VPN server revokes access authorization while DevSpace is stopped.

## Dashboard convergence

Dashboard indicators now require two consecutive failed refreshes before
moving from a previously healthy state to red/stopped. The first failure is a
visible verification warning. If the whole status command fails, all cards show
a verification warning instead of preserving stale red values. The unused
recent-operations card has been removed.

## Resizable review UI

- Selected-file diffs open in a sizable, maximizable window.
- The diff window includes rollback and restore-before-rollback actions.
- Memory full-content previews open in a sizable, maximizable window.
- Session file selection and memory selection synchronize with their open
  windows.
- The logs/diagnostics page uses a draggable split container.

## Validation

Release acceptance requires:

- network coexistence tests proving full-session isolation and confirming that
  no registry or third-party process mutation is present;
- dashboard tests for expected isolation, external TUN warnings, transient
  failure debounce, and removal of recent operations;
- native UI compilation plus workflow tests for the two resizable dialogs,
  rollback/restore actions, and draggable log layout;
- full source regression, release build, update-manifest validation, and
  multi-size native UI acceptance.

## Compatibility

- Portable Protocol remains 1.5.
- Existing configuration keeps `tunnelNetworkCompatibility` enabled unless the
  user explicitly disabled it.
- No OAuth reset or ChatGPT tool rescan is required when updating from 1.1.24.
