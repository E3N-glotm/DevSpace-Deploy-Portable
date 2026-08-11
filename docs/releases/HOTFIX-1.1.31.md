# DevSpace Portable 1.1.31

## Summary

1.1.31 focuses on update reliability, local-only status semantics, and long-running server stability. It fixes three user-visible regressions and removes several unbounded in-memory retention paths that could eventually push the DevSpace Node process to V8's heap limit and surface as an upstream 502.

Portable Protocol remains **1.5** and the top-level MCP schema is unchanged.

## Update window launch reliability

The native control center previously called `Process.Start(Update.exe)` and immediately reported success. That only proved that Windows accepted process creation; it did not prove that a visible updater window appeared. A second updater instance could also exit because of the updater mutex while the already-running window remained behind other windows.

The launch path now:

1. checks for an already-running `Update.exe` whose executable path exactly belongs to the current Portable and activates that window;
2. launches the updater with normal shell/window semantics;
3. waits for input-idle/window creation and confirms a non-zero main window handle;
4. restores and foregrounds the window;
5. reports immediate process exit or a seven-second visible-window timeout back in the main UI instead of silently succeeding.

## Proxy-independent update checks

The old updater could become trapped between a system proxy that accepted TCP connections but failed GitHub TLS traffic and a direct path that was temporarily unavailable. Proxy health was therefore too closely coupled to one local port/listener state.

1.1.31 treats each outbound path independently:

- direct/TUN .NET transport is attempted without inheriting a system proxy;
- direct curl explicitly clears ambient proxy variables and uses `--noproxy *`;
- Windows system proxy/PAC is read dynamically and used as a fallback;
- explicit HTTP/HTTPS/SOCKS environment/WinINET proxy candidates are discovered dynamically, including arbitrary local ports;
- metadata failures refresh the current proxy/network candidates and retry once;
- no v2ray, Clash, sing-box or other vendor process names are used in updater policy.

GitHub's Release API now supplies the preferred check metadata whenever asset `digest` values are available. The updater derives the expected full-package and matching incremental-package SHA-256 directly from those GitHub asset records. If the anonymous GitHub API is rate-limited, returns 403/429, or is otherwise unavailable, the updater switches to the independent `releases/latest/download/update-manifest.json` Release-asset path and reconstructs the same validated release metadata from that file. Older GitHub API responses without asset digests also fall back to the published manifest.

Downloaded packages continue to require exact expected size and SHA-256 before staging or installation.

## Public tunnel idle state

A deliberately disabled public tunnel is not the same condition as an active/healthy tunnel. It now reports state `idle` and is rendered amber in the native dashboard. The local MCP, local OAuth/HTTP and file checks may still produce an overall healthy result because this state represents an intentional local-only deployment rather than a fault.

## Overview ReferenceError

`statusText()` referenced `internetProxy` without creating its own snapshot. `dashboardStatus()` had a correctly scoped variable, which is why the periodic cards could continue working while overview/deploy output failed with a JavaScript `ReferenceError`.

`statusText()` now calls the same read-only `windowsInternetProxyState()` helper locally before rendering proxy diagnostics. Automated dashboard tests execute both `dashboard-status` and `status` so this scope regression cannot silently return.

## Node heap / 502 root-cause hardening

The fix does **not** increase `--max-old-space-size`. Instead it bounds the state that a long-running server is allowed to retain.

- A Streamable HTTP MCP session owns a complete MCP server/tool registration graph. Abandoned sessions can occur when clients reconnect without sending a clean close. The registry now retains at most 32 sessions and reaps sessions idle for one hour instead of keeping them for 24 hours.
- Workspace objects are a 64-entry hot cache. Persisted workspace sessions remain authoritative and evicted entries are restored on demand.
- Review checkpoint state is a 32-entry hot cache. Review JSON/object storage on disk remains authoritative.
- Live command/process sessions are capped at 128 and each retained head/tail output buffer is capped at 512k characters.
- The output buffer no longer uses repeated `Array.from(string)` allocations to count/slice Unicode code points. It uses bounded native string slices and avoids concatenating retained history when the incoming chunk already fills the tail budget.
- Active file watchers are capped at 64.
- Pending OAuth authorization codes are expired/pruned and capped at 256.
- Recursive nested `AGENTS.md`/`CLAUDE.md` discovery is bounded to 2 seconds, 25,000 directory entries, 2,048 directories and 16 levels. This prevents `open_workspace` on large dataset trees from performing an effectively unbounded metadata walk.

These limits turn reconnect storms, long-running training logs, repeated workspace opens and very large dataset roots into bounded resource use instead of allowing heap growth to continue until V8 terminates the Node process.

The release validation also includes a 10,000-session reconnect-storm regression: only 32 transports remain retained and 9,968 are closed. A separate large-directory smoke test opened a synthetic workspace containing about 30,000 files in roughly 0.2 seconds with no sustained heap growth, confirming that nested context discovery terminates under its work budget instead of walking indefinitely.

## Compatibility

- Existing `data/`, sessions, reviews, memories, plugins, OAuth state and logs remain preserved by the updater.
- The local MCP/public tunnel lifecycle separation from 1.1.29 and owned-only ngrok Agent inspection from 1.1.30 remain unchanged.
- No system proxy, DNS, route, VPN adapter or third-party process is modified during normal operation.
- No OAuth re-authorization or MCP tool re-scan is required for this release.
