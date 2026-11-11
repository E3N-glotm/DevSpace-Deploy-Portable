#!/usr/bin/env python3
"""No /proc/<pid>/cmdline streaming in tunnel lifecycle code.

The old Android toybox 'tr' watcher could spin >200 billion zero-byte read
syscalls after its /proc/<old-pid>/cmdline target disappeared. The replacement
checks a bounded /proc/<pid>/stat start-time fingerprint once per 15 seconds,
guards PID file ownership, and identifies actual tunnel binaries via exe.
"""
from pathlib import Path

src = Path(__file__).resolve().parents[1] / 'app/src/main/java/com/devspace/agent'
c = (src / 'CloudflareTunnelManager.java').read_text('utf-8')
n = (src / 'NgrokTunnelManager.java').read_text('utf-8')
s = (src / 'DevSpaceAgentService.java').read_text('utf-8')

for label, source in [('cloudflare', c), ('ngrok', n)]:
    for required in [
        'host_start=$(awk \'{print $22}\' /proc/',
        'current_start=$(awk \'{print $22}\' /proc/',
        'sleep 15; done;',
        'if [ \\"$current_start\\" != \\"$host_start\\" ]; then ',
        'host_comm=$(cat /proc/',
        'String shortProcess = hostProcess.startsWith("com.")',
        'String alternateComm = hostProcess.substring',
        'if [ \\"$(cat ',
        'readlink /proc/$pid/exe',
    ]:
        assert required in source, (label, required)
    assert "tr '\\\\000'" not in source, label
    assert "/cmdline" not in source.replace(
        '// /proc/<pid>/cmdline is a pseudo-file: on some Android builds', ''
    ), label
    assert 'sleep 1; done;' not in source, label
    print(f'PASS {label}: bounded identity, low-duty watchdog, verified cleanup')

assert "tr '\\\\0'" not in s
assert "readlink /proc/$pid/exe" in s
assert '*/ngrok.pid:*/devspace-mobile/ngrok-android-sdk-*' in s
assert '*/cloudflared.pid:*/devspace-mobile/cloudflared-*' in s
print('PASS service: stop/cleanup use exe identity; no unsafe proc streaming')

print('DEVSPACE_MOBILE_WATCHDOG_CPU_REGRESSION_PASS')
