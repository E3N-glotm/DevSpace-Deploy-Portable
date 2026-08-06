import { basename } from "node:path";
import { spawnSync } from "node:child_process";
const defaultProcessTreeRuntime = {
    platform: process.platform,
    killGroup: (pid, signal) => process.kill(-pid, signal),
    killWindowsTree: (pid) => {
        const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        });
        return !result.error && result.status === 0;
    },
};
const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);
export function resolveShellCommand(command, platform = process.platform, environment = process.env) {
    if (platform === "win32") {
        return {
            executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
            args: ["/d", "/s", "/c", command],
        };
    }
    const configuredShell = environment.SHELL;
    const shellName = configuredShell ? basename(configuredShell) : "";
    if (configuredShell && LOGIN_SHELLS.has(shellName)) {
        return { executable: configuredShell, args: ["-lc", command] };
    }
    if (configuredShell && POSIX_SHELLS.has(shellName)) {
        return { executable: configuredShell, args: ["-c", command] };
    }
    return { executable: "/bin/sh", args: ["-c", command] };
}
export function terminateProcessTree(child, signal, detached, runtime = defaultProcessTreeRuntime) {
    if (runtime.platform === "win32" && child.pid) {
        if (runtime.killWindowsTree(child.pid))
            return;
    }
    else if (detached && child.pid) {
        try {
            runtime.killGroup(child.pid, signal);
            return;
        }
        catch (error) {
            if (error.code === "ESRCH")
                return;
        }
    }
    child.kill(signal);
}
