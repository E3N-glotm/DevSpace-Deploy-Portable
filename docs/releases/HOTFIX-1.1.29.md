# DevSpace Portable 1.1.29

## Summary

1.1.29 changes the network coexistence model from “observe topology and actively quiet/reconnect the public tunnel” to **strict lifecycle separation and non-interference**. The local MCP service and the public tunnel are now independent components. Installing or starting the local MCP does not create public tunnel traffic, and third-party route/interface changes do not cause DevSpace to churn its own tunnel connection.

Portable Protocol remains **1.5**. The top-level MCP schema is unchanged, so existing ChatGPT/Codex OAuth and tool scans do not need to be recreated solely for this update.

## Problem addressed

Two user-visible failure modes motivated this release:

1. A traditional local proxy could be closed while Windows still had an enabled loopback system proxy such as `127.0.0.1:<port>`. Applications that honor WinINET/system proxy settings could then report a network error even though direct network access was healthy.
2. “Start DevSpace” historically meant “start local MCP and public tunnel together”. On machines running enterprise/private VPN software, this could create additional public tunnel connections and health-check traffic at the same time the VPN was establishing or maintaining its session. Even though DevSpace did not modify the VPN, the two lifecycles were unnecessarily coupled.

The release treats these as separate concerns rather than adding vendor-specific exceptions.

## Local MCP and public tunnel are independent

The native control center now exposes separate actions:

- **Save and deploy local MCP**
- **Start local MCP**
- **Restart local MCP**
- **Start public tunnel**
- **Restart public tunnel**
- **Stop public tunnel**

`start-local` requires only the bundled Node/Git/DevSpace runtime and a valid local owner credential. It does **not** require a tunnel runtime or a tunnel token.

Task installation still creates both owned Task Scheduler definitions so later tunnel startup remains simple. A fresh install keeps the tunnel task disabled, while task repair/update preserves the pre-existing tunnel enabled/disabled choice. This prevents local deployment or an update from creating public traffic as a side effect when the user intentionally left the tunnel off.

Stopping the public tunnel does not stop local MCP. Starting/restarting the public tunnel does not restart local MCP.

## Homepage is passive with respect to the public network

The three-second dashboard refresh now performs only local/read-only operations:

- loopback OAuth/MCP probes against `127.0.0.1`;
- owned task and PID checks;
- local ngrok agent API inspection where applicable;
- read-only route/interface status and system-proxy diagnostics.

The homepage no longer periodically accesses the configured public DevSpace hostname. Public HTTP/OAuth verification is an explicit diagnostic action from the Details dialog. A previous explicit verification may be displayed from cache, but the dashboard does not refresh that cache by sending public traffic.

This removes background public connection churn while an enterprise VPN is logging in, changing routes, or maintaining its session.

## Third-party topology changes no longer restart the tunnel

The tunnel supervisor still observes connected IPv4 interfaces, addresses and routes for diagnostics, but a signature change is now recorded as `topology-changed-no-restart`.

It does **not**:

- stop the tunnel when a VPN/TUN interface appears;
- wait for a quiet window;
- reconnect the tunnel because a route changed;
- identify or special-case a VPN/proxy vendor.

The tunnel child is managed only for DevSpace-owned reasons, including:

- the child actually exits;
- the user explicitly stops/restarts the tunnel;
- the user changes DevSpace's explicit tunnel proxy configuration;
- an explicitly configured local tunnel proxy becomes unavailable, in which case DevSpace pauses its own tunnel rather than silently falling back to another path.

## Traditional proxy coexistence

The tunnel child environment removes inherited proxy variables:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- `http_proxy`
- `https_proxy`
- `all_proxy`
- `NGROK_PROXY`

Only a proxy explicitly configured for the DevSpace tunnel is injected into the child process. Therefore a normal Windows system-proxy switch made by v2ray/Clash/sing-box does not automatically become a DevSpace tunnel dependency.

Transparent TUN software remains different: if it installs system routing that captures ordinary sockets, Windows will naturally route DevSpace traffic through that TUN. DevSpace does not attempt to bypass or rewrite that system routing.

## Stale loopback system-proxy diagnostics

1.1.29 adds a read-only check for this state:

- Windows `ProxyEnable` is enabled;
- `ProxyServer` points to localhost/loopback;
- the corresponding TCP port is no longer listening.

This is reported as a stale loopback proxy because it can make browser-based login pages and other WinINET-aware applications fail after the proxy application exits.

DevSpace does **not** repair this automatically. The Details dialog provides an explicit repair action. If the user confirms it, DevSpace:

1. saves the previous proxy state under `data/state`;
2. disables `ProxyEnable` only;
3. notifies Windows that Internet settings changed;
4. provides a corresponding restore action.

That explicit repair action does not modify routes, DNS, VPN adapters or third-party processes.

## Non-interference boundary

Normal DevSpace runtime paths do not write:

- WinINET/system proxy settings;
- WinHTTP proxy settings;
- DNS settings;
- route table entries;
- interface metrics;
- VPN/TUN adapters;
- third-party process state.

Network coexistence logic contains no product-name decisions for EasyConnect/Sangfor, v2ray, Clash, sing-box, WireGuard, OpenVPN, AnyConnect, GlobalProtect or similar products.

There is one unavoidable platform boundary: a user-mode application cannot guarantee an independent physical egress if an enterprise VPN/firewall/server policy intentionally blocks ngrok/cloudflared or terminates a VPN session when such traffic exists. In that situation DevSpace can keep local MCP completely independent, and the public tunnel can use a user-supplied independent proxy/relay if available, but DevSpace will not install privileged route/WFP bypasses or override a remote access policy.

## Regression coverage

1.1.29 adds or updates automated checks for:

- local MCP startup without tunnel runtime/token dependency;
- tunnel task disabled by default after task installation;
- update/task-repair preserving the pre-existing tunnel enabled/disabled state;
- independent local/tunnel start and stop operations;
- zero active public homepage probes;
- route/interface changes recorded without tunnel restart;
- inherited proxy environment scrubbing;
- explicit tunnel proxy preservation with no fallback to another path;
- vendor-neutral source contract;
- no route/adapter/DNS/system-proxy mutation in normal tunnel operation;
- updater task-repair and rollback behavior remaining intact.

## Upgrade behavior

The existing incremental updater remains preferred. Persistent configuration, OAuth state, plugins, sessions, reviews and logs remain outside replaceable program files.

After upgrading, task repair preserves whether the tunnel was enabled before the update. The compatibility `start` path always restores local MCP but starts the public tunnel only when that preserved task state is enabled. A tunnel that was deliberately disabled before updating remains disabled afterward.
