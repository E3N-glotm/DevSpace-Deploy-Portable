# DevSpace Portable 1.1.26

## Scope

1.1.26 replaces the 1.1.25 product-specific full-session tunnel pause with a
vendor-neutral network-path adaptation policy. The public MCP tunnel and the
local MCP service remain independent: starting a VPN/TUN client no longer
causes DevSpace to intentionally remove public MCP access. Portable Protocol
remains 1.5 and the top-level MCP schema is unchanged.

## Root cause corrected

1.1.25 treated the presence of named EasyConnect/Sangfor client processes as a
persistent reason to stop the public tunnel child. That protected the VPN
session by removing DevSpace traffic, but it also guaranteed that remote MCP
would be unavailable for the whole VPN session. The behavior was therefore an
over-isolation policy rather than general coexistence.

1.1.26 removes all VPN/TUN product, process, service, and adapter-name checks
from the tunnel lifecycle. An installed or running third-party application is
never by itself a pause condition.

## Vendor-neutral network-path adaptation

The supervisor now observes only objective, read-only Windows network state:

1. Collect connected IPv4 default routes from the ActiveStore.
2. Build a stable signature from interface index/alias, next hop, route metric,
   and interface metric.
3. Keep the existing public tunnel running while a new signature is still
   transient.
4. Accept a path change only after consecutive observations and a minimum
   settling interval.
5. Reconnect only the ngrok/cloudflared `ChildProcess` created and retained by
   the current supervisor.

Short route jitter therefore does not churn a healthy tunnel. A stable change,
such as entering or leaving a VPN/TUN route, causes one owned-tunnel reconnect
so the provider can bind through the Windows-selected path.

## Proxy and routing behavior

- A user-explicit ngrok `proxy_url` remains authoritative. A healthy proxy is
  passed only to the ngrok child.
- If that explicit proxy is a local endpoint and is not listening, DevSpace
  waits for it instead of silently selecting a different egress path.
- Without an explicit proxy, inherited `HTTP_PROXY`, `HTTPS_PROXY`, and
  `ALL_PROXY` values are removed from the tunnel child. Windows routing,
  including a transparent TUN route, selects the actual path.
- Cloudflared continues to manage its own provider connection while the same
  default-route signature is used only to trigger a settled owned-child
  reconnect.

DevSpace never writes WinINET/WinHTTP configuration, registry values, routes,
network adapters, VPN/TUN configuration, or third-party process state.

## Independent readiness and recovery

The start workflow no longer stops the local MCP service merely because the
public provider did not become healthy inside the initial readiness window. If
the tunnel supervisor is alive, the local service and supervisor remain
running, the provider continues retrying, and the UI reports the public path as
recovering.

The dashboard always performs public HTTP/OAuth checks. Multiple active default
routes are informational rather than a vendor-name-based conflict. When local
MCP is healthy but the public provider remains unreachable, the UI explains
that a VPN, TUN, firewall, or enterprise network policy may be blocking the
provider and suggests either allowing the provider or configuring an
independent outbound proxy.

## Hard isolation boundary

An unelevated portable application cannot guarantee a physically independent
egress path when an arbitrary full-tunnel VPN or enterprise endpoint policy
controls all host traffic. If policy blocks ngrok/cloudflare, true independent
egress requires one of the following external conditions:

- the network administrator allows the selected tunnel provider;
- the user supplies an independently reachable outbound proxy or relay; or
- an explicitly administered, privileged per-interface routing/WFP policy is
  deployed outside DevSpace.

DevSpace does not silently install or modify privileged routing policy.

## Validation

Release acceptance covers:

- direct/system-routed, explicit-proxy, unavailable-explicit-proxy, and
  cloudflared network modes;
- two-observation route-change debounce and cancellation of transient route
  jitter;
- absence of vendor/process discovery and absence of route, proxy, registry,
  adapter, or third-party process mutation;
- generic multi-default-route dashboard output and public-path restriction
  guidance;
- native UI compilation, source regression, release build, update-manifest
  validation, and multi-size visual acceptance.

## Compatibility

- Existing `tunnelNetworkCompatibility` configuration remains valid; its UI
  meaning is now “public tunnel network adaptation.”
- Portable Protocol remains 1.5.
- No OAuth reset or ChatGPT tool rescan is required when updating from 1.1.25.
