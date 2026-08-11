# DevSpace Portable 1.1.30

## Summary

1.1.30 fixes a P0 third-party isolation bug in ngrok Agent discovery. The previous dashboard implementation attempted to discover a local ngrok Agent by sending HTTP requests to every port from `127.0.0.1:4040` through `4049`. That behavior was unsafe because these ports are not reserved for DevSpace or ngrok.

Portable Protocol remains **1.5** and the top-level MCP schema is unchanged.

## Reproduced failure

The failure was isolated with repeated A/B tests. Local MCP alone remained stable. A directly launched DevSpace ngrok tunnel remained stable for multiple minutes. Starting the native UI caused the enterprise VPN session to be terminated on a later heartbeat. Headless `ui-open` remained stable, while repeated `dashboard-status` calls reproduced the termination.

The final single-variable reproduction showed that the enterprise VPN's own local service occupied ports in the historical ngrok Agent range while DevSpace's ngrok Agent occupied a different port. Repeating only the old `4040-4049 /api/tunnels` discovery traffic reproduced the VPN session termination. This established that the problem was the localhost discovery scan, not the ngrok public tunnel itself.

## Root cause

`ngrokAgentState()` assumed that the ngrok Agent API could be found by probing a fixed range of localhost ports. The dashboard called this function on its normal refresh cycle, and tunnel startup/readiness paths also reused it.

That approach violated the Portable isolation contract: a localhost TCP port does not establish process ownership. Any unrelated application may legitimately listen on the same port.

## Fix

The discovery path is now ownership-gated:

1. enumerate running `ngrok.exe` processes without contacting any network endpoint;
2. require the executable path to exactly match the current Portable's bundled `runtime/ngrok/ngrok.exe`;
3. require the process to be attributable to the current Portable through a recorded tunnel/ngrok PID or the current Portable's ngrok config path in its command line;
4. read the Windows TCP listener table;
5. retain only LISTEN ports whose owning PID belongs to those verified ngrok processes;
6. query `/api/tunnels` only on those owned listener ports.

If ownership cannot be proven, DevSpace reports the Agent state as unavailable. It does **not** fall back to scanning a guessed port range.

## Scope

Because the same `ngrokAgentState()` implementation is shared, the fix applies to:

- the native dashboard's periodic `dashboard-status` refresh;
- tunnel startup checks for an already-running matching endpoint;
- tunnel readiness verification;
- status/diagnostic text that reads the local ngrok Agent API.

The public tunnel itself, local MCP, system routes, DNS, WinINET/WinHTTP settings, VPN adapters and third-party processes are unchanged.

## Regression contract

Automated checks now require that:

- ngrok Agent discovery contains no fixed `4040-4049` scan;
- discovery starts from a verified DevSpace-owned ngrok process;
- the bundled executable path and Portable config ownership are checked;
- listener discovery filters the TCP table by verified owned PID before any HTTP request;
- homepage public-network probing remains passive unless explicitly requested by the user;
- normal network logic remains vendor-neutral and does not contain EasyConnect/Sangfor-specific lifecycle code.

## Upgrade behavior

The update does not change configuration format, OAuth state, MCP schema or Portable Protocol. Existing users can update in place. Persistent `data/`, plugins, sessions, reviews and logs remain preserved by the existing updater.
