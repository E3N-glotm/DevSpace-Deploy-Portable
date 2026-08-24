import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
function parsePort(value) {
    if (value === undefined || value === "")
        return 7676;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PORT: ${value}`);
    }
    return port;
}
function parseAllowedRoots(value) {
    if (Array.isArray(value)) {
        const roots = value.map((entry) => entry.trim()).filter(Boolean);
        return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
    }
    const rawRoots = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
    return roots.map((root) => resolve(expandHomePath(root)));
}
function parseAllowedHosts(value, derivedHosts) {
    if (Array.isArray(value)) {
        return normalizeAllowedHosts(value, derivedHosts);
    }
    const rawHosts = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    return normalizeAllowedHosts(rawHosts, derivedHosts);
}
function normalizeAllowedHosts(rawHosts, derivedHosts) {
    const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
    if (hosts.includes("*"))
        return ["*"];
    return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}
function parseBoolean(value) {
    return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}
function booleanConfigValue(value, fallback) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === "boolean")
        return value;
    return parseBoolean(String(value));
}
function parsePermissionProfile(value) {
    const profile = String(value ?? "workspace").trim().toLowerCase();
    if (profile === "workspace" || profile === "full-access" || profile === "custom")
        return profile;
    throw new Error(`Invalid DEVSPACE_PERMISSION_PROFILE: ${value}`);
}
function parsePermissions(env, filePermissions = {}) {
    const profile = parsePermissionProfile(env.DEVSPACE_PERMISSION_PROFILE ?? filePermissions.profile);
    const custom = {
        allowExternalPaths: booleanConfigValue(env.DEVSPACE_ALLOW_EXTERNAL_PATHS ?? filePermissions.allowExternalPaths, false),
        allowArbitraryCommands: booleanConfigValue(env.DEVSPACE_ALLOW_ARBITRARY_COMMANDS ?? filePermissions.allowArbitraryCommands, false),
        allowShellMutation: booleanConfigValue(env.DEVSPACE_ALLOW_SHELL_MUTATION ?? filePermissions.allowShellMutation, false),
        allowNetworkAccess: booleanConfigValue(env.DEVSPACE_ALLOW_NETWORK_ACCESS ?? filePermissions.allowNetworkAccess, true),
        allowCredentialAccess: booleanConfigValue(env.DEVSPACE_ALLOW_CREDENTIAL_ACCESS ?? filePermissions.allowCredentialAccess, false),
        allowComputerUse: booleanConfigValue(env.DEVSPACE_ALLOW_COMPUTER_USE ?? filePermissions.allowComputerUse, false),
        allowInteractiveProcesses: booleanConfigValue(env.DEVSPACE_ALLOW_INTERACTIVE_PROCESSES ?? filePermissions.allowInteractiveProcesses, true),
        allowPersistentProcesses: booleanConfigValue(env.DEVSPACE_ALLOW_PERSISTENT_PROCESSES ?? filePermissions.allowPersistentProcesses, true),
    };
    if (profile === "full-access") {
        return {
            profile,
            allowExternalPaths: true,
            allowArbitraryCommands: true,
            allowShellMutation: true,
            allowNetworkAccess: true,
            allowCredentialAccess: true,
            allowComputerUse: true,
            allowInteractiveProcesses: true,
            allowPersistentProcesses: true,
        };
    }
    if (profile === "workspace") {
        return {
            profile,
            allowExternalPaths: false,
            allowArbitraryCommands: false,
            allowShellMutation: false,
            allowNetworkAccess: true,
            allowCredentialAccess: false,
            allowComputerUse: false,
            allowInteractiveProcesses: true,
            allowPersistentProcesses: true,
        };
    }
    return { profile, ...custom };
}
function parseFeatures(env, fileFeatures = {}) {
    return {
        computerUse: booleanConfigValue(env.DEVSPACE_COMPUTER_USE ?? fileFeatures.computerUse, false),
        memories: booleanConfigValue(env.DEVSPACE_MEMORIES ?? fileFeatures.memories, true),
        hooks: booleanConfigValue(env.DEVSPACE_HOOKS ?? fileFeatures.hooks, true),
        uiSessionReview: booleanConfigValue(env.DEVSPACE_UI_SESSION_REVIEW ?? fileFeatures.uiSessionReview, true),
        continuationGuard: booleanConfigValue(env.DEVSPACE_CONTINUATION_GUARD ?? fileFeatures.continuationGuard, true),
    };
}
function parseToolMode(env) {
    const mode = env.DEVSPACE_TOOL_MODE;
    if (mode === "minimal" || mode === "full" || mode === "codex")
        return mode;
    if (mode)
        throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);
    if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
        return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
    }
    return "minimal";
}
function parseLogLevel(value) {
    if (!value || value === "info")
        return "info";
    if (["silent", "error", "warn", "debug"].includes(value))
        return value;
    throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}
function parseLogFormat(value) {
    if (!value || value === "json")
        return "json";
    if (value === "pretty")
        return "pretty";
    throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}
function parsePathList(value) {
    return (value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? []);
}
function parseStringList(value, fallback) {
    const entries = value
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return entries && entries.length > 0 ? entries : fallback;
}
function parsePositiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}
function parseLoggingConfig(env) {
    return {
        level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
        format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
        requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
        assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
        toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
        shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
        trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
    };
}
function parseWidgetMode(value) {
    // A Workspace App iframe on every ordinary MCP tool produces one ChatGPT
    // activity card per tool call. Keep that legacy behaviour available only
    // when the owner explicitly opts into `full`; the normal Portable default
    // is the consolidated `show_changes` renderer plus the explicit
    // continuation_anchor App.
    if (!value || value === "changes")
        return "changes";
    if (value === "off" || value === "full")
        return value;
    throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}
function parseRequiredSecret(value, name) {
    const secret = value?.trim();
    if (!secret) {
        throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
    }
    if (secret.length < 16) {
        throw new Error(`${name} must be at least 16 characters long.`);
    }
    return secret;
}
function parseOAuthConfig(env, ownerToken) {
    return {
        ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
        accessTokenTtlSeconds: parsePositiveInteger(env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS"),
        refreshTokenTtlSeconds: parsePositiveInteger(env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS, DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS, "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS"),
        scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
        allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
            "chatgpt.com",
            "localhost",
            "127.0.0.1",
        ]),
    };
}
function defaultStateDir() {
    return join(homedir(), ".local", "share", "devspace");
}
function defaultWorktreeRoot() {
    return join(homedir(), ".devspace", "worktrees");
}
function defaultAgentDir() {
    return join(homedir(), ".codex");
}
export function loadConfig(env = process.env) {
    const files = loadDevspaceFiles(env);
    const host = env.HOST ?? files.config.host ?? "127.0.0.1";
    const port = parsePort(env.PORT ?? files.config.port);
    const publicBaseUrl = parsePublicBaseUrl(env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port));
    const derivedAllowedHosts = [
        "localhost",
        "127.0.0.1",
        "::1",
        host,
        new URL(publicBaseUrl).hostname,
        ...(files.config.allowedHosts ?? []),
    ];
    return {
        host,
        port,
        oauth: parseOAuthConfig(env, files.auth.ownerToken),
        allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
        allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
        publicBaseUrl,
        toolMode: parseToolMode(env),
        permissions: parsePermissions(env, files.config.permissions),
        features: parseFeatures(env, files.config.features),
        widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
        stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
        worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
        artifactsEnabled: env.DEVSPACE_ARTIFACTS === undefined
            ? files.config.artifactsEnabled === true
            : parseBoolean(env.DEVSPACE_ARTIFACTS),
        artifactMaxFileBytes: parsePositiveInteger(env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes), DEFAULT_ARTIFACT_MAX_FILE_BYTES, "DEVSPACE_ARTIFACT_MAX_FILE_BYTES"),
        skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
        skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
        devspaceSkillsDir: devspaceSkillsDir(env),
        devspaceAgentsDir: devspaceAgentsDir(env),
        subagents: env.DEVSPACE_SUBAGENTS === undefined
            ? files.config.subagents === true
            : parseBoolean(env.DEVSPACE_SUBAGENTS),
        agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
        logging: parseLoggingConfig(env),
    };
}
function numberConfigValue(value) {
    return value === undefined ? undefined : String(value);
}
function parsePublicBaseUrl(value) {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
}
function localPublicBaseUrl(host, port) {
    const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
        ? `[${publicHost}]`
        : publicHost;
    return `http://${formattedHost}:${port}`;
}
