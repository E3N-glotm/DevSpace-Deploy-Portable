# DevSpace Portable 1.1.28

## Scope

1.1.28 fixes two independent defects: the native homepage could falsely mark a
healthy local MCP service red, and a DevSpace public tunnel could remain active
while VPN/TUN software was still rebuilding Windows interfaces, addresses and
routes. Portable Protocol remains 1.5 and the top-level MCP schema is unchanged.

## Homepage false-red root cause

The dashboard started two loopback `fetch()` calls and two public curl probes
inside one `Promise.all`. The public implementation used `spawnSync`, so each
curl blocked the Node event loop even though it appeared inside an async
function. While the event loop was blocked, the healthy loopback responses
could not be processed and their 2.5-second abort timers expired. The result
was the contradictory state seen in the field: own listener present and public
`200/401`, but local `0/0` and a red homepage.

The corrected pipeline:

- performs loopback checks with a direct `node:http` request;
- launches public curl checks asynchronously and concurrently;
- refreshes local state every three seconds;
- caches successful public verification for fifteen seconds but expires a
  failed result after two seconds, using the public URL, tunnel PIDs, egress
  mode and route generation as the cache identity;
- requests an immediate homepage refresh after deployment actions and Details
  dialog checks complete;
- shows a review/warning state, not a red failure, when a listener is present
  but one transport observation is incomplete.

## Vendor-neutral network quiet window

When network adaptation is enabled, the supervisor builds one read-only
signature from every connected IPv4 interface, its active addresses and all
active routes. It does not inspect a VPN, proxy or TUN product name.

The first topology change immediately stops only the tunnel child owned by the
supervisor and suppresses every DevSpace public health probe. The local MCP
service remains running. The tunnel and probes resume only after the whole
topology has been unchanged for fifteen seconds; a later change restarts the
quiet window. This covers split-route VPNs that never replace the default route.

ngrok does not inherit or auto-adopt WinINET/environment proxies. Only a
user-explicit `proxy_url` selects proxy egress; otherwise the child uses Windows
system routing. This is deliberate because ngrok agent proxy support is not
available on every account tier (`ERR_NGROK_9009` was reproduced on a Free
account). Dashboard probes use the same explicit selection and never hop to a
different path after a timeout.

DevSpace still never changes WinINET, WinHTTP, registry values, routes,
adapters, VPN configuration or third-party processes.

## VPN evidence boundary

The inspected third-party client was not terminated by DevSpace. Its own log
recorded a server shutdown message and an authorization rejection before the
client initiated logout. The same server reason existed in historical logs
across earlier Portable versions. A local application cannot repair a remote
account/access authorization decision. This release removes DevSpace's
public traffic during Windows network transitions, which is the in-scope
coexistence risk; a repeated server authorization rejection must be resolved by
the VPN administrator.

## Regression coverage

- slow local proxy fault injection proves public curl timeouts cannot starve
  loopback `200/401` processing;
- dashboard source checks enforce asynchronous curl, direct loopback probing,
  three-second local refresh and bounded public caching;
- tunnel self-tests cover system routing, explicit proxy, cloudflared, UTF-8
  BOM configuration, split-route/address observation, immediate quiescence and
  the fifteen-second stable window;
- quiet-window dashboard tests prove local `200/401` remains visible while all
  public probes are suppressed;
- network tests assert no vendor/process discovery and no registry, route,
  adapter or third-party process mutation.
- release layout regression excludes the extensionless source-local `true`
  test output that was accidentally present in the 1.1.27 local package.

## Compatibility

- 1.1.27 to 1.1.28 uses file-delta-v1 incremental update first with full ZIP
  fallback;
- `data`, `logs` and `reports` remain persistent;
- no OAuth reset or MCP tool rescan is required.
