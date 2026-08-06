import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { openDatabase } from "./db/client.js";
import { redactValue } from "./redaction.js";

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MATURITIES = new Set(["stable", "experimental", "deprecated"]);
const RESERVED_PLUGIN_SLOT_COUNT = 16;
const MAX_PLUGIN_PACKAGE_FILES = 20_000;
const MAX_PLUGIN_PACKAGE_BYTES = 1024 * 1024 * 1024;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function parseManifest(path) {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const manifest = JSON.parse(text);
    validateManifest(manifest, path);
    return { manifest, text, hash: sha256(text) };
}

function validateManifest(manifest, path = "manifest.json") {
    if (!manifest || typeof manifest !== "object")
        throw new Error(`Plugin manifest must be an object: ${path}`);
    if (!PLUGIN_ID_PATTERN.test(String(manifest.id ?? "")))
        throw new Error(`Invalid plugin id in ${path}.`);
    if (typeof manifest.version !== "string" || manifest.version.trim().length === 0)
        throw new Error(`Plugin version is required in ${path}.`);
    if (manifest.maturity !== undefined && !MATURITIES.has(manifest.maturity))
        throw new Error(`Invalid plugin maturity in ${path}.`);
    if (manifest.skillRoots !== undefined && (!Array.isArray(manifest.skillRoots) || !manifest.skillRoots.every((item) => typeof item === "string")))
        throw new Error(`skillRoots must be an array of strings in ${path}.`);
    if (manifest.tools !== undefined && !Array.isArray(manifest.tools))
        throw new Error(`tools must be an array in ${path}.`);
    validateDependencies(manifest.dependencies, path);
    const names = new Set();
    for (const tool of manifest.tools ?? []) {
        if (!tool || typeof tool !== "object" || !TOOL_NAME_PATTERN.test(String(tool.name ?? "")))
            throw new Error(`Invalid plugin tool name in ${path}.`);
        if (names.has(tool.name))
            throw new Error(`Duplicate plugin tool ${tool.name} in ${path}.`);
        names.add(tool.name);
        const hasArgv = Array.isArray(tool.argv) && tool.argv.length > 0 && tool.argv.every((item) => typeof item === "string");
        const hasCommand = typeof tool.command === "string" && tool.command.trim().length > 0;
        if (hasArgv === hasCommand)
            throw new Error(`Plugin tool ${tool.name} must define exactly one of argv or command.`);
        if (tool.env !== undefined && (!tool.env || typeof tool.env !== "object" || Array.isArray(tool.env)))
            throw new Error(`Plugin tool ${tool.name} env must be an object.`);
    }
    return manifest;
}

function validateDependencies(dependencies, path) {
    if (dependencies === undefined)
        return;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
        throw new Error(`dependencies must be an object in ${path}.`);
    for (const field of ["platforms", "executables", "optionalExecutables", "environment", "files"]) {
        const value = dependencies[field];
        if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)))
            throw new Error(`dependencies.${field} must be an array of non-empty strings in ${path}.`);
    }
}

function expandEnvironmentPath(value) {
    let expanded = String(value ?? "");
    expanded = expanded.replace(/%([^%]+)%/g, (_match, name) => process.env[name] ?? `%${name}%`);
    expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? `\${${name}}`);
    if (expanded === "~")
        return homedir();
    if (expanded.startsWith(`~${sep}`) || expanded.startsWith("~/") || expanded.startsWith("~\\"))
        return join(homedir(), expanded.slice(2));
    return expanded;
}

function executableExists(name) {
    const expanded = expandEnvironmentPath(name);
    if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\"))
        return existsSync(resolve(expanded));
    const command = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe") : "/bin/sh";
    const args = process.platform === "win32" ? [expanded] : ["-lc", `command -v -- ${JSON.stringify(expanded)}`];
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    return result.status === 0;
}

function evaluateDependencies(pluginVersion) {
    const dependencies = pluginVersion.manifest.dependencies ?? {};
    const base = dirname(pluginVersion.manifestPath);
    const missing = {
        platforms: [],
        executables: [],
        optionalExecutables: [],
        environment: [],
        files: [],
    };
    const platforms = dependencies.platforms ?? [];
    if (platforms.length > 0 && !platforms.includes(process.platform))
        missing.platforms.push(process.platform);
    for (const executable of dependencies.executables ?? []) {
        if (!executableExists(executable))
            missing.executables.push(executable);
    }
    for (const executable of dependencies.optionalExecutables ?? []) {
        if (!executableExists(executable))
            missing.optionalExecutables.push(executable);
    }
    for (const name of dependencies.environment ?? []) {
        if (!process.env[name])
            missing.environment.push(name);
    }
    for (const file of dependencies.files ?? []) {
        const expanded = expandEnvironmentPath(file);
        const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
        if (!existsSync(candidate))
            missing.files.push(file);
    }
    const blocked = missing.platforms.length > 0
        || missing.executables.length > 0
        || missing.environment.length > 0
        || missing.files.length > 0;
    const degraded = !blocked && missing.optionalExecutables.length > 0;
    return {
        status: blocked ? "blocked" : degraded ? "degraded" : "ready",
        missing,
        checkedAt: new Date().toISOString(),
    };
}

function versionSort(left, right) {
    const leftValid = semver.valid(left.version);
    const rightValid = semver.valid(right.version);
    if (leftValid && rightValid)
        return semver.rcompare(leftValid, rightValid);
    return right.version.localeCompare(left.version, undefined, { numeric: true });
}

function rowToVersion(row) {
    return {
        id: row.plugin_id,
        version: row.version,
        manifestPath: row.manifest_path,
        manifest: JSON.parse(row.manifest_json),
        contentHash: row.content_hash,
        maturity: row.maturity,
        discoveredAt: row.discovered_at,
        lastSeenAt: row.last_seen_at,
    };
}

function normalizeDynamicToolName(pluginId, toolName) {
    return `plugin_${pluginId.replace(/[^a-zA-Z0-9_]/g, "_")}_${toolName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function assertPluginId(pluginId) {
    if (!PLUGIN_ID_PATTERN.test(String(pluginId ?? "")))
        throw new Error(`Invalid plugin id: ${pluginId}`);
}

function pathIsInside(root, candidate) {
    const value = relative(root, candidate);
    return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function archiveEntryIsSafe(value) {
    const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized === "." || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized))
        return false;
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    return !normalized.split("/").some((part) => part === ".."
        || part === "."
        || part.length === 0
        || /[:\u0000-\u001f]/.test(part)
        || /[. ]$/.test(part)
        || reserved.test(part));
}

function tarExecutable() {
    const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (!existsSync(systemTar))
        throw new Error("Windows bsdtar is required to install ZIP plugins.");
    return systemTar;
}

function runTar(args, description) {
    const result = spawnSync(tarExecutable(), args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
        throw new Error(`${description} failed (${result.status}): ${output || "no output"}`);
    }
    return String(result.stdout ?? "");
}

function extractZip(source, destination) {
    const entries = runTar(["-tf", source], "Plugin archive listing")
        .split(/\r?\n/)
        .filter((entry) => entry && !/^\.\/?$/.test(entry));
    if (entries.length === 0)
        throw new Error("Plugin ZIP is empty.");
    if (entries.length > MAX_PLUGIN_PACKAGE_FILES)
        throw new Error(`Plugin ZIP contains too many entries (${entries.length}).`);
    const unsafe = entries.find((entry) => !archiveEntryIsSafe(entry));
    if (unsafe)
        throw new Error(`Plugin ZIP contains an unsafe path: ${unsafe}`);
    const normalizedEntries = new Set();
    for (const entry of entries) {
        const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
        if (normalizedEntries.has(normalized))
            throw new Error(`Plugin ZIP contains duplicate Windows paths: ${entry}`);
        normalizedEntries.add(normalized);
    }
    runTar(["-xf", source, "-C", destination], "Plugin archive extraction");
}

function scanPluginTree(root) {
    const stack = [root];
    let files = 0;
    let bytes = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const candidate = join(current, entry.name);
            const metadata = lstatSync(candidate);
            if (metadata.isSymbolicLink())
                throw new Error(`Plugin packages may not contain symbolic links or junctions: ${candidate}`);
            if (metadata.isDirectory()) {
                stack.push(candidate);
                continue;
            }
            if (!metadata.isFile())
                throw new Error(`Plugin packages may only contain regular files and directories: ${candidate}`);
            files += 1;
            bytes += metadata.size;
            if (files > MAX_PLUGIN_PACKAGE_FILES)
                throw new Error(`Plugin package contains more than ${MAX_PLUGIN_PACKAGE_FILES} files.`);
            if (bytes > MAX_PLUGIN_PACKAGE_BYTES)
                throw new Error("Plugin package exceeds the 1 GiB safety limit.");
        }
    }
    return { files, bytes };
}

function findPluginManifestDirectory(root) {
    const manifests = [];
    const queue = [{ directory: root, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        const manifestPath = join(current.directory, "manifest.json");
        if (existsSync(manifestPath) && statSync(manifestPath).isFile())
            manifests.push(current.directory);
        if (current.depth >= 3)
            continue;
        for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
            if (entry.isDirectory())
                queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
        }
    }
    if (manifests.length !== 1)
        throw new Error(`Plugin package must contain exactly one manifest.json within three directory levels; found ${manifests.length}.`);
    return manifests[0];
}

function slotNumber(value) {
    const slot = Number(value);
    if (!Number.isInteger(slot) || slot < 1 || slot > RESERVED_PLUGIN_SLOT_COUNT)
        throw new Error(`Plugin slot must be an integer from 1 to ${RESERVED_PLUGIN_SLOT_COUNT}.`);
    return slot;
}

export class PluginManager {
    database;
    runtimeState;
    root;
    constructor(config, runtimeState) {
        this.database = openDatabase(config.stateDir);
        this.runtimeState = runtimeState;
        this.root = resolve(process.env.DEVSPACE_PLUGIN_ROOT ?? join(dirname(config.stateDir), "plugins", "installed"));
        this.refresh();
    }
    refresh() {
        const now = new Date().toISOString();
        const discovered = [];
        if (existsSync(this.root)) {
            for (const pluginDirectory of readdirSync(this.root, { withFileTypes: true })) {
                if (!pluginDirectory.isDirectory())
                    continue;
                const pluginRoot = join(this.root, pluginDirectory.name);
                for (const versionDirectory of readdirSync(pluginRoot, { withFileTypes: true })) {
                    if (!versionDirectory.isDirectory())
                        continue;
                    const manifestPath = join(pluginRoot, versionDirectory.name, "manifest.json");
                    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile())
                        continue;
                    try {
                        const parsed = parseManifest(manifestPath);
                        if (parsed.manifest.id !== pluginDirectory.name || parsed.manifest.version !== versionDirectory.name)
                            throw new Error("Plugin directory id/version must match the manifest.");
                        discovered.push({
                            id: parsed.manifest.id,
                            version: parsed.manifest.version,
                            manifestPath,
                            manifest: parsed.manifest,
                            hash: parsed.hash,
                        });
                    }
                    catch (error) {
                        this.runtimeState?.appendEvent({
                            kind: "plugin.invalid",
                            subject: pluginDirectory.name,
                            payload: { path: manifestPath, error: error instanceof Error ? error.message : String(error) },
                        });
                    }
                }
            }
        }
        const upsert = this.database.sqlite.prepare(`
      insert into plugin_versions (
        plugin_id, version, manifest_path, manifest_json, content_hash,
        maturity, discovered_at, last_seen_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(plugin_id, version) do update set
        manifest_path=excluded.manifest_path,
        manifest_json=excluded.manifest_json,
        content_hash=excluded.content_hash,
        maturity=excluded.maturity,
        last_seen_at=excluded.last_seen_at
    `);
        const ensureState = this.database.sqlite.prepare(`
      insert into plugin_state (plugin_id, enabled, selected_version, updated_at)
      values (?, ?, ?, ?)
      on conflict(plugin_id) do nothing
    `);
        const transaction = this.database.sqlite.transaction(() => {
            for (const item of discovered) {
                upsert.run(item.id, item.version, item.manifestPath, JSON.stringify(item.manifest), item.hash, item.manifest.maturity ?? "experimental", now, now);
            }
            const grouped = new Map();
            for (const item of discovered) {
                const versions = grouped.get(item.id) ?? [];
                versions.push(item);
                grouped.set(item.id, versions);
            }
            for (const [pluginId, versions] of grouped) {
                versions.sort(versionSort);
                const selected = versions[0];
                ensureState.run(pluginId, selected.manifest.enabledByDefault ? 1 : 0, selected.version, now);
                const currentState = this.database.sqlite.prepare("select selected_version from plugin_state where plugin_id=?").get(pluginId);
                if (!versions.some((item) => item.version === currentState?.selected_version)) {
                    this.database.sqlite.prepare("update plugin_state set selected_version=?, updated_at=? where plugin_id=?")
                        .run(selected.version, now, pluginId);
                }
            }
            const discoveredKeys = new Set(discovered.map((item) => `${item.id}\u0000${item.version}`));
            const deleteVersion = this.database.sqlite.prepare("delete from plugin_versions where plugin_id=? and version=?");
            for (const row of this.database.sqlite.prepare("select plugin_id, version from plugin_versions").all()) {
                if (!discoveredKeys.has(`${row.plugin_id}\u0000${row.version}`))
                    deleteVersion.run(row.plugin_id, row.version);
            }
            this.database.sqlite.prepare("delete from plugin_state where not exists (select 1 from plugin_versions where plugin_versions.plugin_id=plugin_state.plugin_id)").run();
            this.database.sqlite.prepare("delete from plugin_slots where not exists (select 1 from plugin_state where plugin_state.plugin_id=plugin_slots.plugin_id)").run();
        });
        transaction();
        this.runtimeState?.appendEvent({ kind: "plugin.cache.refreshed", payload: { root: this.root, discovered: discovered.length } });
        return this.list();
    }
    list() {
        const versions = this.database.sqlite.prepare("select * from plugin_versions order by plugin_id, version").all().map(rowToVersion);
        const states = new Map(this.database.sqlite.prepare("select * from plugin_state").all().map((row) => [row.plugin_id, row]));
        const grouped = new Map();
        for (const version of versions) {
            const entries = grouped.get(version.id) ?? [];
            entries.push(version);
            grouped.set(version.id, entries);
        }
        return [...grouped.entries()].map(([id, entries]) => {
            entries.sort(versionSort);
            const state = states.get(id);
            const selected = entries.find((item) => item.version === state?.selected_version) ?? entries[0];
            const dependencyStatus = selected ? evaluateDependencies(selected) : { status: "blocked", missing: {}, checkedAt: new Date().toISOString() };
            return {
                id,
                name: selected?.manifest.name ?? id,
                description: selected?.manifest.description,
                enabled: Boolean(state?.enabled),
                selectedVersion: selected?.version,
                maturity: selected?.maturity ?? "experimental",
                versions: entries.map((item) => ({
                    version: item.version,
                    contentHash: item.contentHash,
                    manifestPath: item.manifestPath,
                    lastSeenAt: item.lastSeenAt,
                })),
                tools: (selected?.manifest.tools ?? []).map((tool) => normalizeDynamicToolName(id, tool.name)),
                dispatchTools: (selected?.manifest.tools ?? []).map((tool) => ({
                    name: tool.name,
                    title: tool.title,
                    description: tool.description,
                    readOnly: tool.readOnly === true,
                    maturity: tool.maturity ?? selected?.manifest.maturity ?? "experimental",
                })),
                skillRoots: selected?.manifest.skillRoots ?? [],
                dependencies: selected?.manifest.dependencies ?? {},
                dependencyStatus,
            };
        }).sort((left, right) => left.id.localeCompare(right.id));
    }
    read(pluginId) {
        const summary = this.list().find((item) => item.id === pluginId);
        if (!summary)
            throw new Error(`Unknown plugin: ${pluginId}`);
        const selected = this.selectedVersion(pluginId);
        return { ...summary, manifest: redactValue(selected.manifest), manifestPath: selected.manifestPath };
    }
    selectedVersion(pluginId) {
        const state = this.database.sqlite.prepare("select * from plugin_state where plugin_id=?").get(pluginId);
        const rows = this.database.sqlite.prepare("select * from plugin_versions where plugin_id=?").all(pluginId).map(rowToVersion).sort(versionSort);
        if (rows.length === 0)
            throw new Error(`Unknown plugin: ${pluginId}`);
        return rows.find((row) => row.version === state?.selected_version) ?? rows[0];
    }
    setEnabled(pluginId, enabled, selectedVersion) {
        const selected = selectedVersion
            ? this.database.sqlite.prepare("select * from plugin_versions where plugin_id=? and version=?").get(pluginId, selectedVersion)
            : undefined;
        if (selectedVersion && !selected)
            throw new Error(`Unknown plugin version: ${pluginId}@${selectedVersion}`);
        const fallback = this.selectedVersion(pluginId);
        const version = selectedVersion ?? fallback.version;
        this.database.sqlite.prepare(`
      insert into plugin_state (plugin_id, enabled, selected_version, updated_at)
      values (?, ?, ?, ?)
      on conflict(plugin_id) do update set
        enabled=excluded.enabled,
        selected_version=excluded.selected_version,
        updated_at=excluded.updated_at
    `).run(pluginId, enabled ? 1 : 0, version, new Date().toISOString());
        this.runtimeState?.appendEvent({
            kind: enabled ? "plugin.enabled" : "plugin.disabled",
            subject: pluginId,
            payload: {
                version,
                hotReloaded: true,
                reconnectRequired: false,
                dynamicToolRefreshRequired: false,
            },
        });
        return {
            ...this.read(pluginId),
            hotReloaded: true,
            reconnectRequired: false,
            dynamicToolRefreshRequired: false,
        };
    }
    installFromPath(sourcePath, options = {}) {
        const source = resolve(String(sourcePath ?? ""));
        if (!existsSync(source))
            throw new Error(`Plugin source does not exist: ${source}`);
        if (pathIsInside(this.root, source))
            throw new Error("Plugin installation source must be outside data/plugins/installed.");
        mkdirSync(this.root, { recursive: true });
        const stagingBase = join(dirname(this.root), ".staging");
        mkdirSync(stagingBase, { recursive: true });
        const operationId = randomUUID();
        const stage = join(stagingBase, `install-${operationId}`);
        const unpacked = join(stage, "payload");
        let incoming;
        let backup;
        mkdirSync(unpacked, { recursive: true });
        try {
            const metadata = statSync(source);
            if (metadata.isDirectory()) {
                cpSync(source, unpacked, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
            }
            else if (metadata.isFile() && basename(source).toLowerCase() === "manifest.json") {
                cpSync(dirname(source), unpacked, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
            }
            else if (metadata.isFile() && extname(source).toLowerCase() === ".zip") {
                extractZip(source, unpacked);
            }
            else {
                throw new Error("Plugin source must be a directory, manifest.json, or ZIP archive.");
            }
            const packageStats = scanPluginTree(unpacked);
            const packageRoot = findPluginManifestDirectory(unpacked);
            const parsed = parseManifest(join(packageRoot, "manifest.json"));
            const pluginId = parsed.manifest.id;
            const version = parsed.manifest.version;
            assertPluginId(pluginId);
            if (pluginId.includes(sep) || version.includes("/") || version.includes("\\") || version === "." || version === "..")
                throw new Error("Plugin id/version cannot contain path separators.");
            const pluginDirectory = resolve(this.root, pluginId);
            const destination = resolve(pluginDirectory, version);
            if (!pathIsInside(this.root, destination))
                throw new Error("Resolved plugin destination escaped the plugin root.");
            mkdirSync(pluginDirectory, { recursive: true });
            incoming = join(pluginDirectory, `.incoming-${version}-${operationId}`);
            renameSync(packageRoot, incoming);
            if (existsSync(destination)) {
                if (!options.replace)
                    throw new Error(`Plugin ${pluginId}@${version} is already installed. Enable replace to overwrite this exact version.`);
                backup = join(pluginDirectory, `.backup-${version}-${operationId}`);
                renameSync(destination, backup);
            }
            try {
                renameSync(incoming, destination);
                incoming = undefined;
            }
            catch (error) {
                if (backup && existsSync(backup) && !existsSync(destination))
                    renameSync(backup, destination);
                throw error;
            }
            if (backup) {
                rmSync(backup, { recursive: true, force: true });
                backup = undefined;
            }
            this.refresh();
            this.runtimeState?.appendEvent({
                kind: "plugin.installed",
                subject: pluginId,
                payload: { version, replace: Boolean(options.replace), files: packageStats.files, bytes: packageStats.bytes },
            });
            return {
                ...this.read(pluginId),
                installedVersion: version,
                replaced: Boolean(options.replace),
                packageStats,
                reconnectRequired: false,
            };
        }
        finally {
            if (incoming)
                rmSync(incoming, { recursive: true, force: true });
            if (backup)
                rmSync(backup, { recursive: true, force: true });
            rmSync(stage, { recursive: true, force: true });
        }
    }
    uninstall(pluginId, version) {
        assertPluginId(pluginId);
        const pluginRoot = resolve(this.root, pluginId);
        const target = version ? resolve(pluginRoot, String(version)) : pluginRoot;
        if (!pathIsInside(this.root, target))
            throw new Error("Resolved plugin uninstall path escaped the plugin root.");
        if (version && (String(version).includes("/") || String(version).includes("\\") || version === "." || version === ".."))
            throw new Error("Plugin version cannot contain path separators.");
        const existed = existsSync(target);
        rmSync(target, { recursive: true, force: true });
        if (version && existsSync(pluginRoot) && readdirSync(pluginRoot).length === 0)
            rmSync(pluginRoot, { recursive: true, force: true });
        const plugins = this.refresh();
        this.runtimeState?.appendEvent({
            kind: "plugin.uninstalled",
            subject: pluginId,
            payload: { version: version ?? null, existed },
        });
        return {
            pluginId,
            version: version ?? null,
            removed: existed,
            remaining: plugins.find((plugin) => plugin.id === pluginId) ?? null,
            reconnectRequired: false,
        };
    }
    slots() {
        const bindings = new Map(this.database.sqlite.prepare("select * from plugin_slots order by slot").all().map((row) => [row.slot, row]));
        const plugins = new Map(this.list().map((plugin) => [plugin.id, plugin]));
        return Array.from({ length: RESERVED_PLUGIN_SLOT_COUNT }, (_unused, index) => {
            const slot = index + 1;
            const row = bindings.get(slot);
            if (!row)
                return { slot, name: `plugin_slot_${String(slot).padStart(2, "0")}`, bound: false, status: "unbound" };
            const plugin = plugins.get(row.plugin_id);
            let status = "ready";
            if (!plugin)
                status = "plugin-missing";
            else if (!plugin.enabled)
                status = "plugin-disabled";
            else if (plugin.selectedVersion !== row.plugin_version)
                status = "version-changed";
            else {
                const selected = this.selectedVersion(row.plugin_id);
                if (selected.contentHash !== row.plugin_content_hash)
                    status = "content-changed";
                else if (!(selected.manifest.tools ?? []).some((tool) => tool.name === row.tool_name))
                    status = "tool-missing";
            }
            return {
                slot,
                name: `plugin_slot_${String(slot).padStart(2, "0")}`,
                bound: true,
                status,
                pluginId: row.plugin_id,
                pluginVersion: row.plugin_version,
                contentHash: row.plugin_content_hash,
                toolName: row.tool_name,
                readOnly: Boolean(row.read_only),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            };
        });
    }
    bindSlot(slotValue, pluginId, toolName) {
        const slot = slotNumber(slotValue);
        const tool = this.resolveTool(pluginId, toolName);
        const selected = this.selectedVersion(pluginId);
        const now = new Date().toISOString();
        this.database.sqlite.prepare(`
      insert into plugin_slots (
        slot, plugin_id, plugin_version, plugin_content_hash,
        tool_name, read_only, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(slot) do update set
        plugin_id=excluded.plugin_id,
        plugin_version=excluded.plugin_version,
        plugin_content_hash=excluded.plugin_content_hash,
        tool_name=excluded.tool_name,
        read_only=excluded.read_only,
        updated_at=excluded.updated_at
    `).run(slot, pluginId, selected.version, selected.contentHash, toolName, tool.readOnly === true ? 1 : 0, now, now);
        this.runtimeState?.appendEvent({
            kind: "plugin.slot.bound",
            subject: `plugin_slot_${String(slot).padStart(2, "0")}`,
            payload: { pluginId, pluginVersion: selected.version, contentHash: selected.contentHash, toolName },
        });
        return this.slots()[slot - 1];
    }
    unbindSlot(slotValue) {
        const slot = slotNumber(slotValue);
        const removed = this.database.sqlite.prepare("delete from plugin_slots where slot=?").run(slot).changes > 0;
        this.runtimeState?.appendEvent({
            kind: "plugin.slot.unbound",
            subject: `plugin_slot_${String(slot).padStart(2, "0")}`,
            payload: { removed },
        });
        return { slot, name: `plugin_slot_${String(slot).padStart(2, "0")}`, bound: false, status: "unbound", removed };
    }
    resolveSlot(slotValue) {
        const slot = slotNumber(slotValue);
        const binding = this.slots()[slot - 1];
        if (!binding.bound)
            throw new Error(`Reserved plugin slot ${slot} is not bound. Configure it in the local DevSpace Portable UI.`);
        if (binding.status !== "ready")
            throw new Error(`Reserved plugin slot ${slot} is not executable (${binding.status}). Rebind it in the local DevSpace Portable UI.`);
        const tool = this.resolveTool(binding.pluginId, binding.toolName);
        if (tool.pluginVersion !== binding.pluginVersion)
            throw new Error(`Reserved plugin slot ${slot} version changed. Rebind it in the local UI.`);
        return { ...tool, reservedSlot: slot, reservedSlotName: binding.name };
    }
    enabledVersions() {
        return this.list().filter((item) => item.enabled).map((item) => this.selectedVersion(item.id));
    }
    enabledSkillRoots() {
        const roots = [];
        for (const plugin of this.enabledVersions()) {
            const base = dirname(plugin.manifestPath);
            for (const root of plugin.manifest.skillRoots ?? []) {
                const expanded = expandEnvironmentPath(root);
                const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
                if (existsSync(absolute) && !roots.includes(absolute))
                    roots.push(absolute);
            }
        }
        return roots;
    }
    resolveTool(pluginId, toolName) {
        const plugin = this.selectedVersion(pluginId);
        const state = this.database.sqlite.prepare("select * from plugin_state where plugin_id=?").get(pluginId);
        if (!state?.enabled)
            throw new Error(`Plugin ${pluginId} is disabled.`);
        const dependencyStatus = evaluateDependencies(plugin);
        if (dependencyStatus.status === "blocked")
            throw new Error(`Plugin ${pluginId}@${plugin.version} has unsatisfied required dependencies: ${JSON.stringify(dependencyStatus.missing)}.`);
        const tool = (plugin.manifest.tools ?? []).find((item) => item.name === toolName);
        if (!tool)
            throw new Error(`Unknown plugin tool: ${pluginId}/${toolName}`);
        return {
            pluginId: plugin.id,
            pluginVersion: plugin.version,
            dependencyStatus,
            manifestPath: plugin.manifestPath,
            maturity: tool.maturity ?? plugin.manifest.maturity ?? "experimental",
            registeredName: normalizeDynamicToolName(plugin.id, tool.name),
            ...tool,
        };
    }
    dynamicTools() {
        const tools = [];
        for (const plugin of this.enabledVersions()) {
            for (const tool of plugin.manifest.tools ?? []) {
                tools.push({
                    pluginId: plugin.id,
                    pluginVersion: plugin.version,
                    manifestPath: plugin.manifestPath,
                    maturity: tool.maturity ?? plugin.manifest.maturity ?? "experimental",
                    registeredName: normalizeDynamicToolName(plugin.id, tool.name),
                    ...tool,
                });
            }
        }
        return tools;
    }
    close() {
        this.database.close();
    }
}

export { validateManifest as validatePluginManifest, normalizeDynamicToolName, RESERVED_PLUGIN_SLOT_COUNT };
