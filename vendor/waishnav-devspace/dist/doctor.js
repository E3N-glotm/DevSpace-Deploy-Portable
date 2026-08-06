import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { databasePath } from "./db/client.js";

function nowIso() {
    return new Date().toISOString();
}

function check(id, category, status, summary, details = {}, remediation) {
    return {
        id,
        category,
        status,
        summary,
        details,
        issues: status === "ok" ? [] : [{ severity: status, cause: summary }],
        remediation: remediation ?? null,
    };
}

function run(executable, args = []) {
    const result = spawnSync(executable, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
    });
    return {
        status: result.status,
        stdout: (result.stdout ?? "").trim(),
        stderr: (result.stderr ?? "").trim(),
        error: result.error?.message,
    };
}

function findOnPath(name) {
    const executable = process.platform === "win32" ? "where.exe" : "which";
    const result = run(executable, [name]);
    return result.status === 0
        ? result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
        : [];
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}

function portableRoot() {
    const configured = process.env.DEVSPACE_PORTABLE_ROOT;
    if (configured)
        return resolve(configured);
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    return dirname(packageRoot);
}

function permissionSnapshot(value) {
    if (!value)
        return undefined;
    return {
        profile: value.profile,
        allowExternalPaths: Boolean(value.allowExternalPaths),
        allowArbitraryCommands: Boolean(value.allowArbitraryCommands),
        allowShellMutation: Boolean(value.allowShellMutation),
        allowNetworkAccess: Boolean(value.allowNetworkAccess),
        allowCredentialAccess: Boolean(value.allowCredentialAccess),
        allowInteractiveProcesses: Boolean(value.allowInteractiveProcesses),
        allowPersistentProcesses: Boolean(value.allowPersistentProcesses),
    };
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export async function runDoctor(config, processSessions) {
    const generatedAt = nowIso();
    const checks = {};
    const root = portableRoot();
    const manifest = readJson(join(root, "VERSION-MANIFEST.json"));
    const deployment = readJson(join(root, "data", "config", "deployment.json"));
    const configuredPermissions = permissionSnapshot(config.permissions);
    const deployedPermissions = permissionSnapshot(deployment?.permissions);

    checks["runtime.provenance"] = check("runtime.provenance", "runtime", "ok", "runtime provenance resolved", {
        portableRoot: root,
        portableVersion: process.env.DEVSPACE_PORTABLE_VERSION ?? manifest?.release ?? "unknown",
        nodeExecutable: process.execPath,
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        pid: process.pid,
    });

    const permissionMatch = !deployedPermissions || sameJson(configuredPermissions, deployedPermissions);
    checks["config.permissions"] = check("config.permissions", "config", permissionMatch ? "ok" : "fail", permissionMatch
        ? `permission profile ${config.permissions.profile} is internally consistent`
        : "deployment and runtime permission settings differ", {
        runtime: configuredPermissions,
        deployment: deployedPermissions ?? "unavailable",
    }, "Open Portable Setup, save the intended permission profile, and restart DevSpace.");

    const stateDatabase = databasePath(config.stateDir);
    if (!existsSync(stateDatabase)) {
        checks["state.database"] = check("state.database", "state", "fail", "state database is missing", { path: stateDatabase }, "Start DevSpace once with a writable state directory.");
    }
    else {
        const sqliteExecutable = findOnPath("sqlite3.exe")[0] ?? findOnPath("sqlite3")[0];
        if (sqliteExecutable) {
            const integrity = run(sqliteExecutable, [stateDatabase, "pragma integrity_check;"]);
            checks["state.database"] = check("state.database", "state", integrity.status === 0 && integrity.stdout === "ok" ? "ok" : "warning", integrity.stdout === "ok" ? "SQLite integrity check passed" : "SQLite integrity could not be confirmed", {
                path: stateDatabase,
                result: integrity.stdout || integrity.stderr || integrity.error || "unknown",
            }, "Stop DevSpace, back up data/state, then run an SQLite integrity check from a trusted sqlite3 build.");
        }
        else {
            checks["state.database"] = check("state.database", "state", "ok", "state database exists", { path: stateDatabase, integrityCheck: "sqlite3 executable not bundled" });
        }
    }

    const nodePaths = findOnPath("node.exe");
    const npmPaths = findOnPath("npm.cmd");
    const gitPaths = findOnPath("git.exe");
    const sshPaths = findOnPath("ssh.exe");
    const expectedNode = resolve(root, "runtime", "node", "node.exe").toLowerCase();
    const selectedNode = nodePaths[0]?.toLowerCase();
    const pathOk = selectedNode === expectedNode;
    checks["runtime.path"] = check("runtime.path", "runtime", pathOk ? "ok" : "warning", pathOk
        ? "portable Node is first on PATH"
        : "another Node installation is first on PATH", {
        selectedNode: nodePaths[0] ?? "missing",
        expectedNode: resolve(root, "runtime", "node", "node.exe"),
        nodeCandidates: nodePaths,
        npmCandidates: npmPaths,
        gitCandidates: gitPaths,
        sshCandidates: sshPaths,
        pathEntries: (process.env.PATH ?? "").split(delimiter).length,
    }, "Start DevSpace through DevSpace-Portable.cmd so the portable runtime is prepended to PATH.");

    let ptyStatus = "ok";
    let ptySummary = "node-pty module is installed";
    try {
        const nodePty = await import("node-pty");
        if (typeof nodePty.spawn !== "function") {
            ptyStatus = "fail";
            ptySummary = "node-pty does not expose spawn";
        }
    }
    catch (error) {
        ptyStatus = "fail";
        ptySummary = error instanceof Error ? error.message : String(error);
    }
    checks["runtime.pty"] = check("runtime.pty", "runtime", ptyStatus, ptySummary, {
        terminalType: process.env.TERM ?? "unset",
        interactivePermission: config.permissions.allowInteractiveProcesses,
    }, "Reinstall the bundled DevSpace package and verify the node-pty optional dependency.");

    const processSummary = processSessions.registrySummary();
    checks["process.registry"] = check("process.registry", "process", "ok", "process registry is available", {
        stateDir: config.stateDir,
        statuses: processSummary,
        liveSessions: processSessions.liveCount(),
    });

    const failed = Object.values(checks).filter((item) => item.status === "fail").length;
    const warnings = Object.values(checks).filter((item) => item.status === "warning").length;
    const suggestedFixes = Object.values(checks)
        .filter((item) => item.status !== "ok" && item.remediation)
        .map((item) => ({ checkId: item.id, severity: item.status, action: item.remediation }));
    return {
        schemaVersion: 1,
        generatedAt,
        overallStatus: failed > 0 ? "fail" : warnings > 0 ? "warning" : "ok",
        summary: {
            total: Object.keys(checks).length,
            ok: Object.values(checks).filter((item) => item.status === "ok").length,
            warnings,
            failed,
        },
        suggestedFixes,
        checks,
    };
}
