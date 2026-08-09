"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const dns = require("dns").promises;
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_DIR = process.env.DEVSPACE_PORTABLE_CONFIG_DIR
  ? path.resolve(process.env.DEVSPACE_PORTABLE_CONFIG_DIR)
  : path.join(DATA_DIR, "config");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");
const NGROK_CONFIG = path.join(CONFIG_DIR, "ngrok.yml");
const CLOUDFLARE_TOKEN_FILE = path.join(CONFIG_DIR, "cloudflare.token");
const DEPLOYMENT_FILE = path.join(CONFIG_DIR, "deployment.json");
const STATE_DIR = process.env.DEVSPACE_PORTABLE_STATE_DIR
  ? path.resolve(process.env.DEVSPACE_PORTABLE_STATE_DIR)
  : path.join(DATA_DIR, "state");
const RUN_DIR = process.env.DEVSPACE_PORTABLE_RUN_DIR
  ? path.resolve(process.env.DEVSPACE_PORTABLE_RUN_DIR)
  : path.join(DATA_DIR, "run");
const MCP_PID_FILE = path.join(RUN_DIR, "devspace.pid");
const TUNNEL_PID_FILE = path.join(RUN_DIR, "tunnel.pid");
const NGROK_PID_FILE = path.join(RUN_DIR, "ngrok.pid");
const TUNNEL_SUPERVISOR_PID_FILE = path.join(RUN_DIR, "tunnel-supervisor.pid");
const TUNNEL_NETWORK_STATE_FILE = path.join(RUN_DIR, "tunnel-network.json");
const TUNNEL_STOP_FILE = path.join(RUN_DIR, "tunnel.stop");
const UI_LEASE_FILE = path.join(RUN_DIR, "ui-session.json");
const COMPUTER_USE_DIR = path.join(RUN_DIR, "computer-use");
const COMPUTER_USE_REQUESTS = path.join(COMPUTER_USE_DIR, "requests");
const COMPUTER_USE_RESPONSES = path.join(COMPUTER_USE_DIR, "responses");
const COMPUTER_USE_BROKER_FILE = path.join(COMPUTER_USE_DIR, "broker.json");
const COMPUTER_USE_BROKER_SCRIPT = path.join(ROOT, "setup", "computer-use-broker.cjs");
const COMPUTER_USE_HELPER = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "helpers", "computer-use.ps1");
const COMPUTER_USE_CAPTURE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "helpers", "computer-use-capture.exe");
const COMPUTER_USE_INPUT = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "helpers", "computer-use-input.exe");
const POWERSHELL_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const REPORTS_DIR = path.join(ROOT, "reports");
const CHECKSUM_FILE = path.join(ROOT, "SHA256SUMS.txt");
const NODE_EXE = path.join(ROOT, "runtime", "node", "node.exe");
const BASH_EXE = path.join(ROOT, "runtime", "git", "bin", "bash.exe");
const CURL_EXE = path.join(ROOT, "runtime", "git", "mingw64", "bin", "curl.exe");
const NGROK_EXE = path.join(ROOT, "runtime", "ngrok", "ngrok.exe");
const CLOUDFLARED_EXE = path.join(ROOT, "runtime", "cloudflared", "cloudflared.exe");
const CLOUDFLARED_VERSION = "2026.7.3";
const CLOUDFLARED_DOWNLOAD_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;
const CLOUDFLARED_SHA256 = "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841";
const CLI_FILE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "cli.js");
const PLUGIN_ADMIN_FILE = path.join(ROOT, "app", "plugin-admin.mjs");
const REVIEW_MANAGER_FILE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "review-checkpoints.js");
const DATABASE_CLIENT_FILE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "db", "client.js");
const MEMORY_STORE_FILE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "memory-store.js");
const PORTABLE_UPDATER_FILE = path.join(ROOT, "setup", "portable-updater.ps1");
const UPDATE_STAGING_ROOT = path.join(ROOT, ".update-staging");
const UPDATE_REPOSITORY = "E3N-glotm/DevSpace-Deploy-Portable";
const BUNDLED_PLUGIN_ROOT = path.join(ROOT, "setup", "bundled-plugins");
const INSTALLED_PLUGIN_ROOT = path.join(DATA_DIR, "plugins", "installed");
const TASK_MCP = "DevSpace Portable MCP Server";
const TASK_TUNNEL = "DevSpace Portable Tunnel";
const LEGACY_TASK_NGROK = "DevSpace Portable ngrok Tunnel";
const PORTABLE_VERSION = "1.1.22";
const UI_LEASE_TTL_MS = 90_000;
const LOCAL_SERVICE_START_TIMEOUT_MS = 45_000;
const TUNNEL_START_TIMEOUT_MS = 45_000;
const SERVICE_START_ATTEMPTS = 3;
const PORTABLE_STOP_TIMEOUT_MS = 20_000;
const COMPUTER_USE_STALE_MS = 5 * 60_000;
const COMPUTER_USE_CLEANUP_INTERVAL_MS = 30_000;
let lastComputerUseCleanupAt = 0;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return "";
  return String(process.argv[index + 1] || "");
}

const REQUEST_FILE = argumentValue("--input-file");
const RESPONSE_FILE = argumentValue("--output-file");
const ERROR_FILE = argumentValue("--error-file");
const FILE_ENCODING = argumentValue("--file-encoding") || "utf16le";

for (const file of [RESPONSE_FILE, ERROR_FILE]) {
  if (file) fs.rmSync(file, { force: true });
}

function writeOutput(text) {
  const value = String(text ?? "");
  if (RESPONSE_FILE) {
    fs.mkdirSync(path.dirname(RESPONSE_FILE), { recursive: true });
    fs.appendFileSync(RESPONSE_FILE, value, { encoding: FILE_ENCODING });
    return;
  }
  process.stdout.write(value);
}

function writeError(text) {
  const value = String(text ?? "");
  if (ERROR_FILE) {
    fs.mkdirSync(path.dirname(ERROR_FILE), { recursive: true });
    fs.appendFileSync(ERROR_FILE, value, { encoding: FILE_ENCODING });
    return;
  }
  process.stderr.write(value);
}

function fail(message, code = 1) {
  writeError(String(message).trim() + "\n");
  process.exit(code);
}

function normalizeTunnelProvider(value) {
  const provider = String(value || "ngrok").trim().toLowerCase();
  if (!new Set(["ngrok", "cloudflare"]).has(provider)) {
    throw new Error(`Unsupported tunnel provider: ${provider}`);
  }
  return provider;
}

function normalizeToolMode(value) {
  const mode = String(value || "full").trim().toLowerCase();
  if (!new Set(["minimal", "full", "codex"]).has(mode)) {
    throw new Error(`Unsupported DevSpace tool mode: ${mode}`);
  }
  return mode;
}

function normalizeAccessProfile(value) {
  const profile = String(value || "workspace").trim().toLowerCase();
  if (!new Set(["workspace", "full-access", "custom"]).has(profile)) {
    throw new Error(`Unsupported DevSpace access profile: ${profile}`);
  }
  return profile;
}

function normalizePermissionSettings(value, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const prior = fallback && typeof fallback === "object" ? fallback : {};
  const profile = normalizeAccessProfile(input.profile || prior.profile || "workspace");
  const custom = {
    profile,
    allowExternalPaths: Boolean(input.allowExternalPaths ?? prior.allowExternalPaths),
    allowArbitraryCommands: Boolean(input.allowArbitraryCommands ?? prior.allowArbitraryCommands),
    allowShellMutation: Boolean(input.allowShellMutation ?? prior.allowShellMutation),
    allowNetworkAccess: Boolean(input.allowNetworkAccess ?? prior.allowNetworkAccess ?? true),
    allowCredentialAccess: Boolean(input.allowCredentialAccess ?? prior.allowCredentialAccess),
    allowComputerUse: Boolean(input.allowComputerUse ?? prior.allowComputerUse),
    allowInteractiveProcesses: Boolean(input.allowInteractiveProcesses ?? prior.allowInteractiveProcesses ?? true),
    allowPersistentProcesses: Boolean(input.allowPersistentProcesses ?? prior.allowPersistentProcesses ?? true),
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
  return custom;
}

function normalizeFeatureSettings(value, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const prior = fallback && typeof fallback === "object" ? fallback : {};
  return {
    computerUse: Boolean(input.computerUse ?? prior.computerUse ?? false),
    memories: Boolean(input.memories ?? prior.memories ?? true),
    hooks: Boolean(input.hooks ?? prior.hooks ?? true),
    uiSessionReview: Boolean(input.uiSessionReview ?? prior.uiSessionReview ?? true),
  };
}

function selectedTunnelProvider() {
  return normalizeTunnelProvider(readJson(DEPLOYMENT_FILE, {}).tunnelProvider || "ngrok");
}

function selectedToolMode() {
  return normalizeToolMode(readJson(DEPLOYMENT_FILE, {}).toolMode || "full");
}

function selectedPermissions() {
  const deployment = readJson(DEPLOYMENT_FILE, {});
  const config = readJson(CONFIG_FILE, {});
  return normalizePermissionSettings(deployment.permissions || config.permissions || { profile: "workspace" });
}

function selectedFeatures() {
  const deployment = readJson(DEPLOYMENT_FILE, {});
  const config = readJson(CONFIG_FILE, {});
  return normalizeFeatureSettings(deployment.features || config.features || {});
}

function computerUseRuntimeEnabled() {
  const permissions = selectedPermissions();
  const features = selectedFeatures();
  return Boolean(features.computerUse && permissions.allowComputerUse);
}

function ensureRuntime(provider = selectedTunnelProvider()) {
  const requirements = [
    ["Node", NODE_EXE],
    ["Git Bash", BASH_EXE],
    ["DevSpace CLI", CLI_FILE],
    ...(provider === "ngrok" ? [["ngrok", NGROK_EXE]] : [["cloudflared", CLOUDFLARED_EXE]]),
  ];
  for (const [label, file] of requirements) {
    if (!fs.existsSync(file)) fail(`${label} is missing: ${file}`);
  }
}

function seedBundledPlugins() {
  const seeded = [];
  const preserved = [];
  if (!fs.existsSync(BUNDLED_PLUGIN_ROOT)) return { seeded, preserved };
  fs.mkdirSync(INSTALLED_PLUGIN_ROOT, { recursive: true });
  for (const pluginEntry of fs.readdirSync(BUNDLED_PLUGIN_ROOT, { withFileTypes: true })) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginSource = path.join(BUNDLED_PLUGIN_ROOT, pluginEntry.name);
    for (const versionEntry of fs.readdirSync(pluginSource, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue;
      const source = path.join(pluginSource, versionEntry.name);
      const manifest = path.join(source, "manifest.json");
      if (!fs.existsSync(manifest)) continue;
      const destination = path.join(INSTALLED_PLUGIN_ROOT, pluginEntry.name, versionEntry.name);
      if (fs.existsSync(destination)) {
        preserved.push(`${pluginEntry.name}@${versionEntry.name}`);
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const incoming = `${destination}.incoming-${process.pid}`;
      fs.rmSync(incoming, { recursive: true, force: true });
      fs.cpSync(source, incoming, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
      fs.renameSync(incoming, destination);
      seeded.push(`${pluginEntry.name}@${versionEntry.name}`);
    }
  }
  return { seeded, preserved };
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function ensureCloudflaredRuntime() {
  if (fs.existsSync(CLOUDFLARED_EXE)) {
    const existing = fs.readFileSync(CLOUDFLARED_EXE);
    if (sha256Buffer(existing) === CLOUDFLARED_SHA256) return false;
    throw new Error(
      `Existing cloudflared binary failed the pinned SHA-256 check: ${CLOUDFLARED_EXE}. ` +
      `Expected ${CLOUDFLARED_SHA256}. Remove or replace it before continuing.`,
    );
  }

  let buffer = null;
  let fetchFailure = "";
  try {
    const response = await fetch(CLOUDFLARED_DOWNLOAD_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(120000),
      headers: { "user-agent": `DevSpacePortable/${PORTABLE_VERSION}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    fetchFailure = error?.cause?.message || error?.message || String(error);
  }

  if (!buffer) {
    const curlExe = path.join(ROOT, "runtime", "git", "mingw64", "bin", "curl.exe");
    const temporary = `${CLOUDFLARED_EXE}.download-${process.pid}`;
    if (fs.existsSync(curlExe)) {
      fs.mkdirSync(path.dirname(CLOUDFLARED_EXE), { recursive: true });
      const curl = runProgram(curlExe, [
        "--fail", "--location", "--silent", "--show-error",
        "--connect-timeout", "20", "--max-time", "180",
        "--output", temporary,
        CLOUDFLARED_DOWNLOAD_URL,
      ], { ignoreExitCode: true, outputEncoding: "utf-8", timeout: 190000 });
      if (curl.status === 0 && fs.existsSync(temporary)) buffer = fs.readFileSync(temporary);
      else fetchFailure = `${fetchFailure}; bundled curl failed (${curl.status}): ${curl.output}`;
      fs.rmSync(temporary, { force: true });
    }
  }

  if (!buffer) {
    throw new Error(
      `Unable to download cloudflared ${CLOUDFLARED_VERSION}: ${fetchFailure || "unknown network error"}. ` +
      `Download ${CLOUDFLARED_DOWNLOAD_URL} manually to ${CLOUDFLARED_EXE}.`,
    );
  }
  const actual = sha256Buffer(buffer);
  if (actual !== CLOUDFLARED_SHA256) {
    throw new Error(`cloudflared SHA-256 mismatch: expected ${CLOUDFLARED_SHA256}, received ${actual}`);
  }
  fs.mkdirSync(path.dirname(CLOUDFLARED_EXE), { recursive: true });
  writeAtomic(CLOUDFLARED_EXE, buffer);
  const versionCheck = runProgram(CLOUDFLARED_EXE, ["--version"], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (versionCheck.status !== 0 || !versionCheck.output.includes(CLOUDFLARED_VERSION)) {
    fs.rmSync(CLOUDFLARED_EXE, { force: true });
    throw new Error(`Downloaded cloudflared failed its version check: ${versionCheck.output || "no output"}`);
  }
  return true;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeAtomic(file, content, encoding = "utf8") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, encoding);
  fs.renameSync(temporary, file);
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFiles(files) {
  const existing = files.filter((file) => fs.existsSync(file));
  if (existing.length === 0) return null;
  const backupDir = path.join(path.dirname(CONFIG_DIR), "backup", timestamp());
  fs.mkdirSync(backupDir, { recursive: true });
  for (const file of existing) {
    fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  }
  restrictAcl(backupDir);
  return backupDir;
}

function currentWindowsUser() {
  const domain = String(process.env.USERDOMAIN || "").trim();
  const user = String(process.env.USERNAME || "").trim();
  return domain && user ? `${domain}\\${user}` : user || currentUserSid();
}

function restrictAcl(target) {
  if (!fs.existsSync(target)) return;
  const userSid = currentUserSid();
  const isDirectory = fs.statSync(target).isDirectory();
  const permission = isDirectory ? "(OI)(CI)(F)" : "(F)";
  const args = [
    target,
    "/inheritance:r",
    "/grant:r",
    `*${userSid}:${permission}`,
    `*S-1-5-18:${permission}`,
    `*S-1-5-32-544:${permission}`,
  ];
  const result = runProgram("icacls.exe", args, { ignoreExitCode: true });
  if (result.status !== 0) {
    throw new Error(`Unable to restrict ACL for ${target}: ${result.output}`);
  }
}

function normalizePublicBaseUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) throw new Error("Public domain is required.");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Public URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Public URL must not contain credentials, query text, or fragments.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Public URL must be the origin only, without /mcp or another path.");
  }
  return url.origin;
}

function normalizeRoots(values) {
  const roots = [];
  for (const item of Array.isArray(values) ? values : []) {
    const value = String(item || "").trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved)) throw new Error(`Allowed root does not exist: ${resolved}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Allowed root is not a directory: ${resolved}`);
    if (!roots.some((root) => root.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  }
  if (roots.length === 0) throw new Error("Enter at least one existing allowed root.");
  return roots;
}

function validateNgrokToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (!/^[A-Za-z0-9_.-]{10,}$/.test(token)) {
    throw new Error("ngrok Authtoken contains unexpected characters or is too short.");
  }
  return token;
}

function existingNgrokToken() {
  if (!fs.existsSync(NGROK_CONFIG)) return "";
  const text = fs.readFileSync(NGROK_CONFIG, "utf8");
  const match = text.match(/^\s*authtoken:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return match ? match[1].trim() : "";
}

function validateCloudflareToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (token.length < 40 || /\s/.test(token)) {
    throw new Error("Cloudflare Tunnel Token is too short or contains whitespace.");
  }
  return token;
}

function existingCloudflareToken() {
  if (!fs.existsSync(CLOUDFLARE_TOKEN_FILE)) return "";
  return fs.readFileSync(CLOUDFLARE_TOKEN_FILE, "utf8").trim();
}

function existingNgrokNetworkOptions() {
  if (!fs.existsSync(NGROK_CONFIG)) return { proxyUrl: "", connectCasHost: false };
  const text = fs.readFileSync(NGROK_CONFIG, "utf8");
  const proxyMatch = text.match(/^\s*proxy_url:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  const casMatch = text.match(/^\s*connect_cas:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return {
    proxyUrl: proxyMatch ? proxyMatch[1].trim() : "",
    connectCasHost: Boolean(casMatch && casMatch[1].trim().toLowerCase() === "host"),
  };
}

function normalizeNgrokProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const url = new URL(raw);
  if (!["http:", "https:", "socks5:"].includes(url.protocol)) {
    throw new Error("ngrok proxy must use http://, https://, or socks5://.");
  }
  if (!url.hostname) throw new Error("ngrok proxy URL must include a host.");
  if (url.username || url.password) {
    throw new Error("Do not embed proxy credentials in the URL; use a trusted local proxy without URL credentials.");
  }
  if (url.search || url.hash) throw new Error("ngrok proxy URL must not contain query text or fragments.");
  return url.href.replace(/\/$/, "");
}

async function readStdinJson() {
  if (REQUEST_FILE) {
    if (!fs.existsSync(REQUEST_FILE)) return {};
    const text = fs.readFileSync(REQUEST_FILE, FILE_ENCODING).replace(/^\uFEFF/, "");
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function configure(input) {
  const priorDeployment = readJson(DEPLOYMENT_FILE, {});
  const priorProvider = normalizeTunnelProvider(priorDeployment.tunnelProvider || "ngrok");
  const tunnelProvider = normalizeTunnelProvider(input.tunnelProvider || priorProvider);
  const priorToolMode = normalizeToolMode(priorDeployment.toolMode || "full");
  const toolMode = normalizeToolMode(input.toolMode || priorToolMode);
  const permissions = normalizePermissionSettings(input.permissions, priorDeployment.permissions);
  const features = normalizeFeatureSettings(input.features, priorDeployment.features);
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
  const providerUrls = {
    ngrok: String(priorDeployment.providerUrls?.ngrok || "").trim(),
    cloudflare: String(priorDeployment.providerUrls?.cloudflare || "").trim(),
  };
  if (!providerUrls[priorProvider] && priorDeployment.publicBaseUrl) {
    providerUrls[priorProvider] = String(priorDeployment.publicBaseUrl).trim();
  }
  providerUrls[tunnelProvider] = publicBaseUrl;
  const port = Number(input.port || 7676);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be an integer from 1024 to 65535.");
  }
  const permissionMode = input.allowAllFixedDrives ? "all-drive-roots" : "selected-roots";
  const allowedRoots = normalizeRoots(permissionMode === "all-drive-roots" ? fixedDrives() : input.allowedRoots);
  const priorAuth = readJson(AUTH_FILE, {});
  let ownerToken = String(input.ownerToken || "").trim();
  let generatedOwnerToken = false;
  if (!ownerToken) ownerToken = String(priorAuth.ownerToken || "").trim();
  if (!ownerToken) {
    ownerToken = crypto.randomBytes(32).toString("base64url");
    generatedOwnerToken = true;
  }
  if (ownerToken.length < 16) throw new Error("Owner Password must contain at least 16 characters.");

  let ngrokToken = validateNgrokToken(input.ngrokToken);
  if (!ngrokToken) ngrokToken = existingNgrokToken();
  const ngrokProxyUrl = normalizeNgrokProxyUrl(input.ngrokProxyUrl);
  const ngrokConnectCasHost = Boolean(input.ngrokConnectCasHost);
  const tunnelNetworkCompatibility = input.tunnelNetworkCompatibility !== false;
  if (tunnelProvider === "ngrok" && !ngrokToken) {
    throw new Error("Enter an ngrok Authtoken for the first ngrok deployment.");
  }

  let cloudflareToken = validateCloudflareToken(input.cloudflareToken);
  if (!cloudflareToken) cloudflareToken = existingCloudflareToken();
  if (tunnelProvider === "cloudflare" && !cloudflareToken) {
    throw new Error("Enter a Cloudflare named Tunnel Token for the first Cloudflare deployment.");
  }

  if (tunnelProvider === "cloudflare") await ensureCloudflaredRuntime();
  ensureRuntime(tunnelProvider);
  const bundledPlugins = seedBundledPlugins();

  backupFiles([CONFIG_FILE, AUTH_FILE, NGROK_CONFIG, CLOUDFLARE_TOKEN_FILE, DEPLOYMENT_FILE]);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  writeJson(CONFIG_FILE, {
    host: "127.0.0.1",
    port,
    allowedRoots,
    publicBaseUrl,
    stateDir: STATE_DIR,
    subagents: false,
    permissions,
    features,
  });
  writeJson(AUTH_FILE, { ownerToken });
  if (ngrokToken) {
    const ngrokAgentLines = [
      `  authtoken: ${JSON.stringify(ngrokToken)}`,
      ...(ngrokProxyUrl ? [`  proxy_url: ${JSON.stringify(ngrokProxyUrl)}`] : []),
      ...(ngrokConnectCasHost ? ["  connect_cas: host"] : []),
    ];
    writeAtomic(NGROK_CONFIG, `version: "3"\nagent:\n${ngrokAgentLines.join("\n")}\n`);
  }
  if (cloudflareToken) writeAtomic(CLOUDFLARE_TOKEN_FILE, `${cloudflareToken}\n`);
  writeJson(DEPLOYMENT_FILE, {
    formatVersion: 5,
    tunnelProvider,
    toolMode,
    permissions,
    features,
    providerUrls,
    publicBaseUrl,
    port,
    permissionMode,
    ngrokProxyConfigured: Boolean(ngrokProxyUrl),
    tunnelNetworkCompatibility,
    ngrokConnectCasHost,
    cloudflaredVersion: tunnelProvider === "cloudflare" ? CLOUDFLARED_VERSION : null,
    taskNames: { mcp: TASK_MCP, tunnel: TASK_TUNNEL },
    configuredAt: new Date().toISOString(),
  });
  for (const item of [CONFIG_DIR, AUTH_FILE, NGROK_CONFIG, CLOUDFLARE_TOKEN_FILE, STATE_DIR, RUN_DIR]) restrictAcl(item);

  return {
    ok: true,
    tunnelProvider,
    toolMode,
    permissions,
    features,
    bundledPlugins,
    providerUrls,
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl}/mcp`,
    port,
    allowedRoots,
    permissionMode,
    ngrokProxyUrl,
    tunnelNetworkCompatibility,
    ngrokConnectCasHost,
    cloudflaredVersion: tunnelProvider === "cloudflare" ? CLOUDFLARED_VERSION : null,
    configDir: CONFIG_DIR,
    authFile: AUTH_FILE,
    generatedOwnerToken,
    ownerToken: generatedOwnerToken ? ownerToken : null,
    preservedOAuthState: fs.existsSync(path.join(STATE_DIR, "devspace.sqlite")),
  };
}

function setComputerUse(input) {
  const enabled = Boolean(input?.enabled);
  const deployment = readJson(DEPLOYMENT_FILE, {});
  const config = readJson(CONFIG_FILE, null);
  const permissions = normalizePermissionSettings(
    deployment.permissions || config?.permissions || { profile: "workspace" },
  );
  if (enabled && !permissions.allowComputerUse) {
    throw new Error("Computer Use requires full-access or a custom profile that allows desktop control.");
  }
  const features = normalizeFeatureSettings(
    { ...(deployment.features || config?.features || {}), computerUse: enabled },
    deployment.features || config?.features || {},
  );

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  backupFiles([DEPLOYMENT_FILE, ...(config ? [CONFIG_FILE] : [])]);
  writeJson(DEPLOYMENT_FILE, { ...deployment, features });
  if (config) writeJson(CONFIG_FILE, { ...config, features });

  const currentLease = readJson(UI_LEASE_FILE, null);
  let broker;
  if (!enabled) {
    broker = { ...stopComputerUseBroker(), ready: false, running: false, disabled: true, reason: "disabled" };
  } else if (currentLease?.leaseId && Date.parse(String(currentLease.expiresAt || "")) > Date.now()) {
    broker = ensureComputerUseBroker(currentLease);
  } else {
    broker = { ready: false, running: false, reason: "no-active-ui" };
  }
  return { ok: true, enabled, computerUseEnabled: enabled, features, broker };
}

function uiLeaseValue(existing = {}) {
  const now = new Date();
  const uiPid = Number(process.env.DEVSPACE_NATIVE_UI_PID || existing.uiPid || 0);
  const nativeQueueWorker = process.env.DEVSPACE_NATIVE_UI_QUEUE_WORKER === "1"
    || Boolean(existing.nativeQueueWorker);
  return {
    formatVersion: 1,
    leaseId: existing.leaseId || crypto.randomUUID(),
    uiPid: Number.isInteger(uiPid) && uiPid > 0 ? uiPid : null,
    nativeQueueWorker,
    openedAt: existing.openedAt || now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + UI_LEASE_TTL_MS).toISOString(),
    portableVersion: PORTABLE_VERSION,
  };
}

function openUiLease() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(COMPUTER_USE_REQUESTS, { recursive: true });
  fs.mkdirSync(COMPUTER_USE_RESPONSES, { recursive: true });
  const current = readJson(UI_LEASE_FILE, null);
  const callerPid = Number(process.env.DEVSPACE_NATIVE_UI_PID || 0);
  const currentActive = Boolean(current?.leaseId && Date.parse(String(current.expiresAt || "")) > Date.now());
  const sameUi = currentActive && Number(current?.uiPid || 0) === callerPid && callerPid > 0;
  if (!sameUi && current?.leaseId) {
    cancelComputerUseRequests(current.leaseId);
    stopComputerUseBroker(current.leaseId);
  }
  const lease = uiLeaseValue(sameUi ? current : {});
  writeJson(UI_LEASE_FILE, lease);
  restrictAcl(UI_LEASE_FILE);
  restrictAcl(COMPUTER_USE_DIR);
  if (!computerUseRuntimeEnabled()) {
    stopComputerUseBroker();
    return {
      ...lease,
      computerUseEnabled: false,
      broker: { ready: false, running: false, disabled: true, reason: "disabled" },
    };
  }
  return { ...lease, computerUseEnabled: true, broker: ensureComputerUseBroker(lease) };
}

function brokerErrorText(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/((?:password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
    .slice(-8_000);
}

function cleanupComputerUseBroker() {
  const now = Date.now();
  if (now - lastComputerUseCleanupAt < COMPUTER_USE_CLEANUP_INTERVAL_MS) return;
  lastComputerUseCleanupAt = now;
  for (const directory of [COMPUTER_USE_REQUESTS, COMPUTER_USE_RESPONSES]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      try {
        if (now - fs.statSync(file).mtimeMs > COMPUTER_USE_STALE_MS) fs.rmSync(file, { recursive: true, force: true });
      } catch {}
    }
  }
}

function writeComputerUseResponse(requestId, value) {
  writeJson(path.join(COMPUTER_USE_RESPONSES, `${requestId}.json`), {
    formatVersion: 1,
    requestId,
    completedAt: new Date().toISOString(),
    ...value,
  });
}

function parseLastJsonLine(output, label) {
  const line = String(output || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return {};
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${brokerErrorText(line)}`);
  }
}

function runComputerInput(request, inputFile, outputFile) {
  const actionPayload = {
    ...request,
    payload: {
      ...(request.payload || {}),
      screenshotAfter: false,
    },
  };
  if (fs.existsSync(COMPUTER_USE_INPUT)) {
    const payload = actionPayload.payload;
    const args = ["--action", String(payload.action || "")];
    if (Number.isInteger(payload.x)) args.push("--x", String(payload.x));
    if (Number.isInteger(payload.y)) args.push("--y", String(payload.y));
    if (Number.isInteger(payload.delta)) args.push("--delta", String(payload.delta));
    if (Number.isInteger(payload.delayMs)) args.push("--delay", String(payload.delayMs));
    for (const key of Array.isArray(payload.keys) ? payload.keys : []) {
      args.push("--key", String(key));
    }
    const textFile = `${inputFile}.text-utf8`;
    if (String(payload.action || "") === "type_text") {
      fs.writeFileSync(textFile, String(payload.text || ""), { encoding: "utf8", mode: 0o600 });
      args.push("--text-file", textFile);
    }
    try {
      const result = childProcess.spawnSync(COMPUTER_USE_INPUT, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        throw new Error(brokerErrorText(result.error?.message || result.stderr || `Computer Use native input helper exited with ${result.status}`));
      }
      return {
        metadata: parseLastJsonLine(result.stdout, "Computer Use native input helper"),
        stderr: brokerErrorText(result.stderr),
      };
    } finally {
      fs.rmSync(textFile, { force: true });
    }
  }
  writeJson(inputFile, actionPayload);
  const result = childProcess.spawnSync(POWERSHELL_EXE, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    COMPUTER_USE_HELPER,
    "-InputFile",
    inputFile,
    "-OutputFile",
    outputFile,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(brokerErrorText(result.error?.message || result.stderr || `Computer Use input helper exited with ${result.status}`));
  }
  return {
    metadata: parseLastJsonLine(result.stdout, "Computer Use input helper"),
    stderr: brokerErrorText(result.stderr),
  };
}

function captureComputerScreen(imageFile) {
  if (!fs.existsSync(COMPUTER_USE_CAPTURE)) {
    throw new Error(`Desktop capture helper is missing: ${COMPUTER_USE_CAPTURE}`);
  }
  fs.rmSync(imageFile, { force: true });
  const result = childProcess.spawnSync(COMPUTER_USE_CAPTURE, [imageFile], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error || !fs.existsSync(imageFile)) {
    fs.rmSync(imageFile, { force: true });
    throw new Error(brokerErrorText(result.error?.message || result.stderr || `Desktop capture helper exited with ${result.status}`));
  }
  return {
    metadata: parseLastJsonLine(result.stdout, "Desktop capture helper"),
    stderr: brokerErrorText(result.stderr),
  };
}

function processComputerUseRequests(lease) {
  cleanupComputerUseBroker();
  if (!fs.existsSync(COMPUTER_USE_HELPER)) return { processed: 0, failed: 0, error: "input helper missing" };
  fs.mkdirSync(COMPUTER_USE_REQUESTS, { recursive: true });
  fs.mkdirSync(COMPUTER_USE_RESPONSES, { recursive: true });
  let processed = 0;
  let failed = 0;
  const requests = fs.readdirSync(COMPUTER_USE_REQUESTS)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .sort()
    .slice(0, 4);
  for (const name of requests) {
    const requestId = name.slice(0, -5);
    const source = path.join(COMPUTER_USE_REQUESTS, name);
    const working = path.join(COMPUTER_USE_REQUESTS, `${name}.working-${process.pid}`);
    try {
      fs.renameSync(source, working);
    } catch {
      continue;
    }
    try {
      const request = readJson(working, {});
      if (request.requestId !== requestId || request.leaseId !== lease.leaseId) {
        writeComputerUseResponse(requestId, { success: false, error: "Computer Use request does not match the active local UI lease." });
        failed += 1;
        continue;
      }
      const imageFile = path.join(COMPUTER_USE_RESPONSES, `${requestId}.png`);
      const actionInputFile = path.join(COMPUTER_USE_REQUESTS, `${requestId}.action-${process.pid}.json`);
      const action = String(request.payload?.action || "");
      let metadata = { action, screenshot: false };
      let stderr = "";
      try {
        if (action !== "snapshot") {
          const inputResult = runComputerInput(request, actionInputFile, imageFile);
          metadata = { ...metadata, ...inputResult.metadata, action };
          stderr = inputResult.stderr;
        }
        if (request.payload?.screenshotAfter !== false) {
          const captureResult = captureComputerScreen(imageFile);
          metadata = { ...metadata, ...captureResult.metadata, action, screenshot: true };
          stderr = [stderr, captureResult.stderr].filter(Boolean).join("\n");
        }
      } finally {
        fs.rmSync(actionInputFile, { force: true });
      }
      if (metadata.screenshot && !fs.existsSync(imageFile)) {
        throw new Error("Computer Use capture helper did not produce the requested screenshot.");
      }
      writeComputerUseResponse(requestId, {
        success: true,
        metadata,
        stderr,
      });
      processed += 1;
    } catch (error) {
      writeComputerUseResponse(requestId, { success: false, error: brokerErrorText(error?.message || error) });
      failed += 1;
    } finally {
      fs.rmSync(working, { force: true });
    }
  }
  return { processed, failed };
}

function cancelComputerUseRequests(leaseId = null) {
  if (!fs.existsSync(COMPUTER_USE_REQUESTS)) return 0;
  let cancelled = 0;
  for (const name of fs.readdirSync(COMPUTER_USE_REQUESTS).filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(COMPUTER_USE_REQUESTS, name);
    try {
      const request = readJson(file, {});
      if (leaseId && request.leaseId !== leaseId) continue;
      writeComputerUseResponse(request.requestId, { success: false, error: "The local DevSpace Portable UI was closed." });
      fs.rmSync(file, { force: true });
      cancelled += 1;
    } catch {}
  }
  return cancelled;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function computerUseBrokerStatus(leaseId = null) {
  const state = readJson(COMPUTER_USE_BROKER_FILE, null);
  if (!state || !Number.isInteger(Number(state.pid))) {
    return { ready: false, running: false, reason: "not-started" };
  }
  const pid = Number(state.pid);
  const running = processExists(pid);
  const matchesLease = !leaseId || state.leaseId === leaseId;
  const initialized = state.status === "running";
  return {
    ...state,
    pid,
    running,
    ready: running && matchesLease && initialized,
    reason: !running
      ? "process-exited"
      : !matchesLease
        ? "lease-mismatch"
        : initialized
          ? null
          : "starting",
  };
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function recordedComputerUseBrokerProcess(state) {
  const pid = Number(state?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let processInfo = null;
  try {
    processInfo = portableProcessSnapshot().find((item) => item.pid === pid) || null;
  } catch {
    return null;
  }
  if (!processInfo) return null;
  const normalizedExecutable = String(processInfo.executablePath || "").replace(/\\/g, "/").toLowerCase();
  const normalizedNode = NODE_EXE.replace(/\\/g, "/").toLowerCase();
  const normalizedCommand = String(processInfo.commandLine || "").replace(/\\/g, "/").toLowerCase();
  const normalizedBrokerScript = COMPUTER_USE_BROKER_SCRIPT.replace(/\\/g, "/").toLowerCase();
  const leaseId = String(state?.leaseId || "").trim().toLowerCase();
  if (normalizedExecutable !== normalizedNode) return null;
  if (!normalizedCommand.includes(normalizedBrokerScript)) return null;
  if (leaseId && !normalizedCommand.includes(leaseId)) return null;
  return processInfo;
}

function stopComputerUseBroker(leaseId = null) {
  const state = readJson(COMPUTER_USE_BROKER_FILE, null);
  if (!state || (leaseId && state.leaseId !== leaseId)) {
    return { stopped: false, reason: state ? "lease-mismatch" : "not-started" };
  }
  const pid = Number(state.pid);
  const brokerProcess = processExists(pid) ? recordedComputerUseBrokerProcess(state) : null;
  if (brokerProcess) {
    childProcess.spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  }
  fs.rmSync(COMPUTER_USE_BROKER_FILE, { force: true });
  if (!brokerProcess && processExists(pid)) {
    return {
      stopped: false,
      pid: Number.isInteger(pid) ? pid : null,
      staleRecordRemoved: true,
      reason: "pid-identity-mismatch",
    };
  }
  return { stopped: true, pid: Number.isInteger(pid) ? pid : null };
}

function startComputerUseBroker(lease) {
  if (!fs.existsSync(COMPUTER_USE_BROKER_SCRIPT)) {
    return { ready: false, running: false, reason: "broker-script-missing" };
  }
  if ((!fs.existsSync(COMPUTER_USE_INPUT) && !fs.existsSync(COMPUTER_USE_HELPER))
      || !fs.existsSync(COMPUTER_USE_CAPTURE)) {
    return { ready: false, running: false, reason: "computer-use-helper-missing" };
  }
  const existing = computerUseBrokerStatus(lease.leaseId);
  if (existing.ready) return existing;
  stopComputerUseBroker();
  fs.mkdirSync(COMPUTER_USE_DIR, { recursive: true });
  const child = childProcess.spawn(NODE_EXE, [COMPUTER_USE_BROKER_SCRIPT, lease.leaseId], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_ROOT: ROOT,
      DEVSPACE_COMPUTER_USE_LEASE_ID: lease.leaseId,
    },
  });
  child.unref();
  const state = {
    formatVersion: 1,
    leaseId: lease.leaseId,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    lastLoopAt: null,
    pollIntervalMs: 40,
    transport: "local-file-queue",
    status: "starting",
  };
  writeJson(COMPUTER_USE_BROKER_FILE, state);
  restrictAcl(COMPUTER_USE_BROKER_FILE);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = computerUseBrokerStatus(lease.leaseId);
    if (status.ready) return status;
    if (!status.running) return status;
    sleepSync(25);
  }
  return computerUseBrokerStatus(lease.leaseId);
}

function ensureComputerUseBroker(lease) {
  if (lease?.nativeQueueWorker && processExists(Number(lease.uiPid))) {
    stopComputerUseBroker();
    return {
      ready: true,
      running: true,
      status: "running",
      pid: Number(lease.uiPid),
      leaseId: lease.leaseId,
      transport: "native-ui-file-queue",
      reason: null,
    };
  }
  const status = computerUseBrokerStatus(lease.leaseId);
  return status.ready ? status : startComputerUseBroker(lease);
}

function heartbeatUiLease(input) {
  const current = readJson(UI_LEASE_FILE, null);
  if (!current || !current.leaseId || current.leaseId !== String(input.leaseId || "")) {
    const recovered = openUiLease();
    return { ...recovered, recovered: true };
  }
  const lease = uiLeaseValue(current);
  writeJson(UI_LEASE_FILE, lease);
  if (!computerUseRuntimeEnabled()) {
    stopComputerUseBroker();
    return {
      ...lease,
      computerUseEnabled: false,
      broker: { ready: false, running: false, disabled: true, reason: "disabled" },
    };
  }
  return { ...lease, computerUseEnabled: true, broker: ensureComputerUseBroker(lease) };
}

function closeUiLease(input) {
  const current = readJson(UI_LEASE_FILE, null);
  if (current && current.leaseId === String(input.leaseId || "")) {
    const cancelledComputerUse = cancelComputerUseRequests(current.leaseId);
    const broker = stopComputerUseBroker(current.leaseId);
    fs.rmSync(UI_LEASE_FILE, { force: true });
    return { closed: true, leaseId: current.leaseId, cancelledComputerUse, broker };
  }
  return { closed: false, leaseId: input.leaseId || null };
}

function uiLeaseStatus() {
  const current = readJson(UI_LEASE_FILE, null);
  if (!current) return { active: false, reason: "closed" };
  const active = Date.parse(String(current.expiresAt || "")) > Date.now();
  return {
    ...current,
    active,
    reason: active ? null : "heartbeat expired",
    computerUseEnabled: computerUseRuntimeEnabled(),
    broker: computerUseRuntimeEnabled()
      ? computerUseBrokerStatus(current.leaseId)
      : { ready: false, running: false, disabled: true, reason: "disabled" },
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function currentUserSid() {
  const whoamiExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  const output = runProgram(whoamiExe, ["/user", "/fo", "csv", "/nh"]).output.trim();
  const quoted = Array.from(output.matchAll(/"([^"]*)"/g), (match) => match[1]);
  const sid = quoted[quoted.length - 1];
  if (!/^S-1-/.test(sid || "")) throw new Error(`Unable to resolve current user SID: ${output}`);
  return sid;
}

function taskXml(description, commandFile, delay) {
  const sid = currentUserSid();
  const launcher = path.join(ROOT, "scripts", "hidden-launch.vbs");
  const argumentsText = `//B //NoLogo "${launcher}" "${commandFile}"`;
  const delayXml = delay ? `\n      <Delay>${delay}</Delay>` : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>${xmlEscape(currentWindowsUser())}</Author><Description>${xmlEscape(description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(sid)}</UserId>${delayXml}</LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xmlEscape(argumentsText)}</Arguments><WorkingDirectory>${xmlEscape(ROOT)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

let cachedWindowsTextEncoding = null;

function windowsTextEncoding() {
  if (cachedWindowsTextEncoding) return cachedWindowsTextEncoding;
  const configured = String(process.env.DEVSPACE_WINDOWS_TEXT_ENCODING || "").trim().toLowerCase();
  if (configured) {
    cachedWindowsTextEncoding = configured;
    return cachedWindowsTextEncoding;
  }
  const result = childProcess.spawnSync("cmd.exe", ["/d", "/c", "chcp"], {
    cwd: ROOT,
    encoding: null,
    windowsHide: true,
    timeout: 3000,
  });
  const digits = Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)])
    .toString("latin1")
    .match(/\b(\d{3,5})\b/);
  const labels = {
    65001: "utf-8",
    936: "gbk",
    950: "big5",
    932: "shift_jis",
    949: "euc-kr",
    1252: "windows-1252",
  };
  cachedWindowsTextEncoding = labels[digits?.[1]] || "utf-8";
  return cachedWindowsTextEncoding;
}

function decodeProgramOutput(value, requestedEncoding = "windows") {
  if (!value) return "";
  if (typeof value === "string") return value;
  const buffer = Buffer.from(value);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  const sampleLength = Math.min(buffer.length, 200);
  let oddNulls = 0;
  for (let index = 1; index < sampleLength; index += 2) if (buffer[index] === 0) oddNulls += 1;
  if (sampleLength >= 8 && oddNulls > sampleLength / 6) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  const encoding = requestedEncoding === "windows" ? windowsTextEncoding() : requestedEncoding;
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function runProgram(file, args, options = {}) {
  const { ignoreExitCode = false, outputEncoding = "windows", ...spawnOptions } = options;
  const result = childProcess.spawnSync(file, args, {
    cwd: ROOT,
    encoding: null,
    windowsHide: true,
    ...spawnOptions,
  });
  const output = `${decodeProgramOutput(result.stdout, outputEncoding)}${decodeProgramOutput(result.stderr, outputEncoding)}`.trim();
  if (!ignoreExitCode && result.status !== 0) {
    throw new Error(`${path.basename(file)} ${args.join(" ")} failed (${result.status}): ${output}`);
  }
  return { status: result.status, output };
}

function runPortableUpdater(action, extraArguments = []) {
  if (!fs.existsSync(PORTABLE_UPDATER_FILE)) {
    throw new Error(`Portable updater is missing: ${PORTABLE_UPDATER_FILE}`);
  }
  const result = runProgram(POWERSHELL_EXE, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", PORTABLE_UPDATER_FILE,
    "-Action", action,
    "-Root", ROOT,
    "-Repository", UPDATE_REPOSITORY,
    "-CurrentVersion", PORTABLE_VERSION,
    ...extraArguments,
  ], {
    outputEncoding: "utf-8",
    timeout: action === "Stage" ? 3_900_000 : 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = String(result.output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) throw new Error(`Portable updater returned invalid output: ${result.output}`);
  try {
    return JSON.parse(jsonLine);
  } catch {
    throw new Error(`Portable updater returned invalid JSON: ${jsonLine}`);
  }
}

function launchPortableUpdate(input = {}) {
  const stagingPath = path.resolve(String(input.stagingPath || ""));
  const allowedPrefix = `${path.resolve(UPDATE_STAGING_ROOT)}${path.sep}`;
  if (!stagingPath.startsWith(allowedPrefix)) {
    throw new Error("stagingPath is outside the Portable update staging directory.");
  }
  const stagedUpdater = path.join(stagingPath, "portable-updater.ps1");
  const stageInfo = path.join(stagingPath, "stage-info.json");
  if (!fs.existsSync(stagedUpdater) || !fs.existsSync(stageInfo)) {
    throw new Error("The staged updater or stage metadata is missing.");
  }
  const uiPid = Number(input.uiPid || 0);
  if (!Number.isInteger(uiPid) || uiPid <= 0) throw new Error("uiPid must be a positive integer.");
  const ackFile = path.join(stagingPath, "apply-launch-ack.json");
  fs.rmSync(ackFile, { force: true });
  const updateTaskName = `DevSpace Portable Update ${crypto.randomBytes(16).toString("hex")}`;
  const taskXmlFile = path.join(stagingPath, "apply-task.xml");
  const taskArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", stagedUpdater,
    "-Action", "Apply",
    "-Root", ROOT,
    "-Repository", UPDATE_REPOSITORY,
    "-CurrentVersion", PORTABLE_VERSION,
    "-StagingPath", stagingPath,
    "-UiPid", String(uiPid),
    "-LaunchAckPath", ackFile,
    "-UpdateTaskName", updateTaskName,
  ];
  const quoteArgument = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const taskArgumentText = taskArgs.map(quoteArgument).join(" ");
  const sid = currentUserSid();
  const taskXmlContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>${xmlEscape(currentWindowsUser())}</Author><Description>One-shot DevSpace Portable transactional update controller.</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="Author"><UserId>${xmlEscape(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>6</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(POWERSHELL_EXE)}</Command><Arguments>${xmlEscape(taskArgumentText)}</Arguments><WorkingDirectory>${xmlEscape(ROOT)}</WorkingDirectory></Exec></Actions>
</Task>`;
  writeAtomic(taskXmlFile, `\uFEFF${taskXmlContent}`, "utf16le");
  runProgram("schtasks.exe", ["/create", "/tn", updateTaskName, "/xml", taskXmlFile, "/f"]);
  try {
    runProgram("schtasks.exe", ["/run", "/tn", updateTaskName]);
  } catch (error) {
    runProgram("schtasks.exe", ["/delete", "/tn", updateTaskName, "/f"], { ignoreExitCode: true });
    throw error;
  }
  const deadline = Date.now() + 12_000;
  let acknowledgement = null;
  while (Date.now() < deadline) {
    acknowledgement = readJson(ackFile, null);
    if (acknowledgement?.acknowledged && Number(acknowledgement.updaterPid) > 0) break;
    sleepSync(100);
  }
  if (!acknowledgement?.acknowledged || Number(acknowledgement.updaterPid) <= 0) {
    runProgram("schtasks.exe", ["/end", "/tn", updateTaskName], { ignoreExitCode: true });
    const taskStatus = runProgram("schtasks.exe", ["/query", "/tn", updateTaskName, "/v", "/fo", "list"], { ignoreExitCode: true }).output;
    runProgram("schtasks.exe", ["/delete", "/tn", updateTaskName, "/f"], { ignoreExitCode: true });
    const updateLogTail = safeLogTail(path.join(ROOT, "logs", "update.log"), 20);
    const launchError = [
      taskStatus ? `Task Scheduler state:\n${taskStatus}` : "",
      updateLogTail ? `Recent updater log:\n${updateLogTail}` : "",
    ].filter(Boolean).join("\n\n") || "No updater acknowledgement was written.";
    throw new Error(`Detached updater failed to acknowledge launch. The control center remains open and the staged update was not applied.\n${launchError}`);
  }
  return {
    launched: true,
    updaterPid: Number(acknowledgement.updaterPid),
    stagingPath,
    uiPid,
    acknowledged: true,
    acknowledgement,
    updateTaskName,
  };
}

function runPluginAdmin(command, payload = {}) {
  if (!fs.existsSync(PLUGIN_ADMIN_FILE)) {
    throw new Error(`Plugin admin runtime is missing: ${PLUGIN_ADMIN_FILE}`);
  }
  const result = runProgram(NODE_EXE, [PLUGIN_ADMIN_FILE, command], {
    input: JSON.stringify(payload),
    outputEncoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.output || "{}");
  } catch {
    throw new Error(`Plugin admin returned invalid JSON: ${result.output}`);
  }
}

async function runReviewAdmin(action, payload = {}) {
  if (!fs.existsSync(REVIEW_MANAGER_FILE)) {
    throw new Error(`Review-session runtime is missing: ${REVIEW_MANAGER_FILE}`);
  }
  const moduleUrl = `${pathToFileURL(REVIEW_MANAGER_FILE).href}?mtime=${fs.statSync(REVIEW_MANAGER_FILE).mtimeMs}`;
  const reviewModule = await import(moduleUrl);
  return reviewModule.reviewAdmin({ stateDir: STATE_DIR, action, payload });
}

async function runMemoryAdmin(action, payload = {}) {
  if (!fs.existsSync(DATABASE_CLIENT_FILE) || !fs.existsSync(MEMORY_STORE_FILE)) {
    throw new Error("Memory runtime is missing from the bundled DevSpace package.");
  }
  const databaseModule = await import(`${pathToFileURL(DATABASE_CLIENT_FILE).href}?mtime=${fs.statSync(DATABASE_CLIENT_FILE).mtimeMs}`);
  const memoryModule = await import(`${pathToFileURL(MEMORY_STORE_FILE).href}?mtime=${fs.statSync(MEMORY_STORE_FILE).mtimeMs}`);
  const database = databaseModule.openDatabase(STATE_DIR);
  try {
    const store = new memoryModule.MemoryStore(database.sqlite);
    if (action === "list") {
      return {
        memories: store.list({
          workspaceRoot: payload.workspaceRoot || undefined,
          includeGlobal: payload.includeGlobal !== false,
          query: payload.query || undefined,
          limit: payload.limit || 200,
        }),
      };
    }
    if (action === "upsert") {
      const scope = payload.scope === "global" ? "global" : "workspace";
      let workspaceRoot;
      if (scope === "workspace") {
        workspaceRoot = path.resolve(String(payload.workspaceRoot || ""));
        const config = readJson(CONFIG_FILE, {});
        const allowed = (config.allowedRoots || []).map((root) => path.resolve(String(root)).toLowerCase());
        if (!allowed.includes(workspaceRoot.toLowerCase())) {
          throw new Error("Workspace-scoped Memories created from the Portable UI must use one configured allowed root.");
        }
      }
      return {
        memory: store.upsert({
          id: payload.id || undefined,
          scope,
          workspaceRoot,
          title: payload.title,
          content: payload.content,
          tags: Array.isArray(payload.tags) ? payload.tags : [],
          allowSensitive: false,
        }),
      };
    }
    if (action === "delete") {
      return { memory: store.delete(String(payload.id || "")) };
    }
    throw new Error(`Unsupported memory admin action: ${action}`);
  } finally {
    database.close();
  }
}

function installTasks() {
  const provider = selectedTunnelProvider();
  ensureRuntime(provider);
  if (!fs.existsSync(CONFIG_FILE) || !fs.existsSync(AUTH_FILE)) {
    throw new Error("Save configuration before installing tasks.");
  }
  if (provider === "ngrok" && !fs.existsSync(NGROK_CONFIG)) {
    throw new Error("ngrok configuration is missing. Save the ngrok configuration first.");
  }
  if (provider === "cloudflare" && !existingCloudflareToken()) {
    throw new Error("Cloudflare Tunnel Token is missing. Save the Cloudflare configuration first.");
  }
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const mcpXml = path.join(REPORTS_DIR, "portable-mcp-task.xml");
  const tunnelXml = path.join(REPORTS_DIR, "portable-tunnel-task.xml");
  writeAtomic(mcpXml, `\uFEFF${taskXml("Portable DevSpace MCP server through bundled Git Bash.", path.join(ROOT, "scripts", "start-devspace.cmd"), "")}`, "utf16le");
  writeAtomic(tunnelXml, `\uFEFF${taskXml("Portable selected tunnel provider for DevSpace MCP.", path.join(ROOT, "scripts", "start-tunnel.cmd"), "PT15S")}`, "utf16le");
  stopServices({ leaveDisabled: true });
  runProgram("schtasks.exe", ["/delete", "/tn", LEGACY_TASK_NGROK, "/f"], { ignoreExitCode: true });
  runProgram("schtasks.exe", ["/create", "/tn", TASK_MCP, "/xml", mcpXml, "/f"]);
  runProgram("schtasks.exe", ["/create", "/tn", TASK_TUNNEL, "/xml", tunnelXml, "/f"]);
  return `Portable user-level scheduled tasks were installed for ${provider}.`;
}

function taskCommand(action, task, ignoreExitCode = false) {
  return runProgram("schtasks.exe", [`/${action}`, "/tn", task], { ignoreExitCode });
}

function taskDefinition(task) {
  const result = runProgram("schtasks.exe", ["/query", "/tn", task, "/xml"], { ignoreExitCode: true });
  return result.status === 0 ? String(result.output || "") : "";
}

function taskOwnedByRoot(task) {
  const definition = taskDefinition(task);
  if (!definition) return false;
  const normalizedRoot = ROOT.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const normalizedDefinition = definition.replace(/\\/g, "/").toLowerCase();
  return normalizedDefinition.includes(normalizedRoot + "/scripts/")
    || normalizedDefinition.includes(normalizedRoot + "/devspace-portable.cmd")
    || normalizedDefinition.includes(normalizedRoot + "/devspace-portable.exe");
}

function requireOwnedTask(task) {
  if (!taskExists(task)) throw new Error(`Portable scheduled task is not installed: ${task}`);
  if (!taskOwnedByRoot(task)) {
    throw new Error(`Refusing to operate scheduled task ${task}: its action does not belong to ${ROOT}.`);
  }
}

function endOwnedTask(task) {
  if (taskOwnedByRoot(task)) taskCommand("end", task, true);
}

function taskEnabled(task) {
  const definition = taskDefinition(task);
  if (!definition) return false;
  const match = definition.match(/<Settings>[\s\S]*?<Enabled>\s*(true|false)\s*<\/Enabled>[\s\S]*?<\/Settings>/i);
  return !match || match[1].toLowerCase() === "true";
}

function setOwnedTaskEnabled(task, enabled) {
  if (!taskOwnedByRoot(task)) return false;
  runProgram("schtasks.exe", ["/change", "/tn", task, enabled ? "/enable" : "/disable"], { ignoreExitCode: false });
  return true;
}

function processImageName(pid) {
  const result = childProcess.spawnSync("tasklist.exe", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const firstLine = String(result.stdout || "").trim().split(/\r?\n/, 1)[0] || "";
  const match = firstLine.match(/^"([^"]+)"/);
  return match ? match[1].toLowerCase() : "";
}

function listenerPids(port) {
  const result = childProcess.spawnSync("netstat.exe", ["-ano", "-p", "TCP"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pattern = new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.match(pattern))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

function stopRecordedProcess(pidFile, expectedImage, requiredListenerPort = null) {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  const image = processImageName(pid);
  if (!image) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  const owned = portableProcessSnapshot().some((item) => item.pid === pid);
  const expectedImageMatches = image === expectedImage.toLowerCase();
  const listenerMatches = requiredListenerPort === null || listenerPids(requiredListenerPort).includes(pid);
  // PID files can survive crashes and Windows can later reuse the numeric PID.
  // Never terminate a merely same-named process unless it is still directly
  // attributable to this Portable root.
  if (!owned || !expectedImageMatches || !listenerMatches) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  runProgram("taskkill.exe", ["/pid", String(pid), "/f"], { ignoreExitCode: true });
  fs.rmSync(pidFile, { force: true });
}

function tunnelProcessSpec(provider = selectedTunnelProvider()) {
  return provider === "cloudflare"
    ? { provider, image: "cloudflared.exe", executable: CLOUDFLARED_EXE, logFile: path.join(ROOT, "logs", "cloudflared.log") }
    : { provider, image: "ngrok.exe", executable: NGROK_EXE, logFile: path.join(ROOT, "logs", "ngrok.log") };
}

function stopRecordedTunnelProcess() {
  for (const pidFile of [TUNNEL_PID_FILE, NGROK_PID_FILE]) {
    if (!fs.existsSync(pidFile)) continue;
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.rmSync(pidFile, { force: true });
      continue;
    }
    const image = processImageName(pid);
    if (!image) {
      fs.rmSync(pidFile, { force: true });
      continue;
    }
    const owned = portableProcessSnapshot().some((item) => item.pid === pid);
    if (!owned || !new Set(["ngrok.exe", "cloudflared.exe"]).has(image)) {
      fs.rmSync(pidFile, { force: true });
      continue;
    }
    runProgram("taskkill.exe", ["/pid", String(pid), "/f"], { ignoreExitCode: true });
    fs.rmSync(pidFile, { force: true });
  }
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function portableProcessSnapshot() {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=[IO.Path]::GetFullPath(${powershellLiteral(ROOT)}).TrimEnd('\\')`,
    "$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)",
    "$wrappers=@('cmd.exe','wscript.exe','cscript.exe','powershell.exe','pwsh.exe','bash.exe','sh.exe')",
    "$owned=@($all | Where-Object {$exe=[string]$_.ExecutablePath;$cmd=[string]$_.CommandLine;$name=([string]$_.Name).ToLowerInvariant();($exe -and $exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or (($wrappers -contains $name) -and $cmd -and $cmd.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)})",
    "$owned | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join(";");
  const result = childProcess.spawnSync(POWERSHELL_EXE, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to enumerate Portable-owned processes: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  const text = String(result.stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    name: String(item.Name || ""),
    executablePath: String(item.ExecutablePath || ""),
    commandLine: String(item.CommandLine || ""),
  })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
}

function cleanupRunState() {
  for (const file of [
    MCP_PID_FILE,
    TUNNEL_PID_FILE,
    NGROK_PID_FILE,
    TUNNEL_SUPERVISOR_PID_FILE,
    TUNNEL_NETWORK_STATE_FILE,
    TUNNEL_STOP_FILE,
    UI_LEASE_FILE,
    COMPUTER_USE_BROKER_FILE,
  ]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(COMPUTER_USE_REQUESTS, { recursive: true, force: true });
  fs.rmSync(COMPUTER_USE_RESPONSES, { recursive: true, force: true });
}

function stopPortableOwnedProcesses(excludePids = []) {
  const environmentExcludePids = String(process.env.DEVSPACE_STOP_EXCLUDE_PID || "")
    .split(/[;,\s]+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const excluded = new Set([
    process.pid,
    process.ppid,
    Number(process.env.DEVSPACE_NATIVE_UI_PID || 0),
    ...environmentExcludePids,
    ...excludePids,
  ].map(Number).filter((pid) => Number.isInteger(pid) && pid > 0));
  const killed = [];
  const eligible = (processes) => {
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const expandedExcluded = new Set(excluded);
    for (const pid of [...excluded]) {
      let current = byPid.get(pid);
      const visited = new Set();
      while (current && !visited.has(current.pid)) {
        visited.add(current.pid);
        expandedExcluded.add(current.pid);
        if (Number.isInteger(current.parentPid) && current.parentPid > 0) expandedExcluded.add(current.parentPid);
        current = byPid.get(current.parentPid);
      }
    }
    return processes.filter((item) => {
      let current = item;
      const visited = new Set();
      while (current && !visited.has(current.pid)) {
        if (expandedExcluded.has(current.pid)) return false;
        visited.add(current.pid);
        current = byPid.get(current.parentPid);
      }
      return true;
    });
  };
  const deadline = Date.now() + PORTABLE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = portableProcessSnapshot();
    const byPid = new Map(snapshot.map((item) => [item.pid, item]));
    const depth = (item) => {
      let value = 0;
      let current = item;
      const visited = new Set();
      while (current && byPid.has(current.parentPid) && !visited.has(current.pid)) {
        visited.add(current.pid);
        value += 1;
        current = byPid.get(current.parentPid);
      }
      return value;
    };
    const processes = eligible(snapshot)
      .sort((left, right) => depth(right) - depth(left));
    if (!processes.length) break;
    for (const item of processes) {
      // Do not use taskkill /T here. DevSpace can launch arbitrary user tools
      // as children of the MCP server; recursively killing the process tree can
      // terminate unrelated applications such as VPN/proxy clients. Every
      // Portable wrapper/runtime process is identified by its own executable or
      // command line referencing ROOT, so terminate those owned PIDs directly
      // and leave unrelated descendants alone.
      runProgram("taskkill.exe", ["/pid", String(item.pid), "/f"], { ignoreExitCode: true });
      killed.push({ pid: item.pid, name: item.name, executablePath: item.executablePath });
    }
    sleepSync(400);
  }
  const remaining = eligible(portableProcessSnapshot());
  return { killed, remaining, excluded: [...excluded] };
}

function stopOrphanedComputerUseBrokers() {
  const stopped = [];
  for (const item of portableProcessSnapshot()) {
    if (!/computer-use-broker\.cjs/i.test(item.commandLine)) continue;
    if (item.pid === process.pid || item.pid === process.ppid) continue;
    runProgram("taskkill.exe", ["/pid", String(item.pid), "/f"], { ignoreExitCode: true });
    stopped.push(item.pid);
  }
  return stopped;
}

function stopServices(options = {}) {
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  writeAtomic(TUNNEL_STOP_FILE, "stop\n");
  const managedTasks = [TASK_TUNNEL, TASK_MCP].filter((task) => taskOwnedByRoot(task));
  const enabledBeforeStop = new Map(managedTasks.map((task) => [task, taskEnabled(task)]));
  for (const task of managedTasks) setOwnedTaskEnabled(task, false);
  for (const task of [TASK_TUNNEL, LEGACY_TASK_NGROK, TASK_MCP]) endOwnedTask(task);
  const lease = readJson(UI_LEASE_FILE, null);
  stopComputerUseBroker();
  stopOrphanedComputerUseBrokers();
  cancelComputerUseRequests(lease?.leaseId || null);
  stopRecordedTunnelProcess();
  stopRecordedProcess(MCP_PID_FILE, "node.exe", Number(deployment.port || 7676));
  const processResult = stopPortableOwnedProcesses(options.excludePids || []);
  cleanupRunState();
  const remainingPids = new Set(processResult.remaining.map((item) => item.pid));
  const listenerRemaining = listenerPids(Number(deployment.port || 7676)).filter((pid) => remainingPids.has(pid));
  if (processResult.remaining.length || listenerRemaining.length) {
    const details = [
      ...processResult.remaining.map((item) => `${item.pid} ${item.name} ${item.executablePath}`),
      ...listenerRemaining.map((pid) => `${pid} still listens on 127.0.0.1:${deployment.port || 7676}`),
    ];
    throw new Error(`Portable stop could not terminate these owned processes within ${PORTABLE_STOP_TIMEOUT_MS / 1000} seconds:\n${details.join("\n")}`);
  }
  if (!options.leaveDisabled) {
    for (const [task, wasEnabled] of enabledBeforeStop.entries()) {
      if (wasEnabled) setOwnedTaskEnabled(task, true);
    }
  }
  return `Portable DevSpace, tunnel, Computer Use Broker, and ${processResult.killed.length} Portable-owned process(es) were stopped. No background service PID remains.`;
}

function shutdownServices() {
  // "Stop all and exit" is a terminal user action. Keep any existing tasks
  // disabled so they cannot race the UI shutdown or immediately recreate
  // background processes while the user is trying to remove the Portable
  // directory. Unlike disableServices(), this also works after tasks were
  // already uninstalled.
  const message = stopServices({ leaveDisabled: true });
  for (const task of [TASK_TUNNEL, TASK_MCP]) {
    if (taskOwnedByRoot(task)) setOwnedTaskEnabled(task, false);
  }
  return `${message}\nPortable scheduled tasks, when present, remain disabled after the control center exits.`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateStartConfiguration(provider, deployment, config) {
  const publicBaseUrl = normalizePublicBaseUrl(config.publicBaseUrl || deployment.publicBaseUrl);
  const configuredPort = Number(config.port || deployment.port || 7676);
  if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
    throw new Error("Saved local port is invalid. Save the configuration again.");
  }
  if (!fs.existsSync(AUTH_FILE) || String(readJson(AUTH_FILE, {}).ownerToken || "").length < 16) {
    throw new Error("Owner Password is missing or invalid. Save the configuration again.");
  }
  if (provider === "ngrok" && !existingNgrokToken()) {
    throw new Error("ngrok Authtoken is missing. Save a real token before starting.");
  }
  if (provider === "cloudflare" && !existingCloudflareToken()) {
    throw new Error("Cloudflare Tunnel Token is missing. Save a real token before starting.");
  }
  return { publicBaseUrl, port: configuredPort };
}

async function localServiceReady(port) {
  const metadata = await probeUrl(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, 2500);
  const authorization = await probeUrl(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, 2500);
  return metadata.status === 200 && authorization.status === 200;
}

async function publicServiceReady(publicBaseUrl) {
  const metadata = await probeUrl(`${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`, 5000);
  const authorization = await probeUrl(`${publicBaseUrl}/.well-known/oauth-authorization-server`, 5000);
  return metadata.status === 200 && authorization.status === 200;
}

async function waitForCondition(timeoutMs, condition, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await condition();
    if (last?.ready) return last;
    await delay(intervalMs);
  }
  return last ?? { ready: false, reason: "not-checked" };
}

async function startLocalService(port) {
  let lastReason = "not attempted";
  for (let attempt = 1; attempt <= SERVICE_START_ATTEMPTS; attempt += 1) {
    endOwnedTask(TASK_MCP);
    stopRecordedProcess(MCP_PID_FILE, "node.exe", port);
    taskCommand("run", TASK_MCP);
    const result = await waitForCondition(LOCAL_SERVICE_START_TIMEOUT_MS, async () => ({
      ready: await localServiceReady(port),
      attempt,
    }));
    if (result.ready) return result;
    lastReason = `attempt ${attempt} did not expose both local OAuth metadata endpoints`;
    endOwnedTask(TASK_MCP);
    stopRecordedProcess(MCP_PID_FILE, "node.exe", port);
    await delay(750);
  }
  throw new Error(`DevSpace local service failed after ${SERVICE_START_ATTEMPTS} attempts: ${lastReason}. Check logs\\devspace.log.`);
}

async function startPublicTunnel(provider, publicBaseUrl, port) {
  const spec = tunnelProcessSpec(provider);
  let last = { ready: false, reason: "not attempted" };
  for (let attempt = 1; attempt <= SERVICE_START_ATTEMPTS; attempt += 1) {
    endOwnedTask(TASK_TUNNEL);
    stopRecordedTunnelProcess();
    fs.rmSync(TUNNEL_STOP_FILE, { force: true });
    taskCommand("run", TASK_TUNNEL);
    last = await waitForCondition(TUNNEL_START_TIMEOUT_MS, async () => {
      const network = readJson(TUNNEL_NETWORK_STATE_FILE, null);
      const publicReady = await publicServiceReady(publicBaseUrl);
      if (provider === "ngrok") {
        const agent = await ngrokAgentState(publicBaseUrl);
        return {
          ready: Boolean(publicReady && agent.matchingTunnel),
          attempt,
          publicReady,
          agentReachable: agent.reachable,
          matchingTunnel: agent.matchingTunnel,
          networkMode: network?.mode || "unknown",
          proxySource: network?.proxySource || "none",
        };
      }
      return { ready: publicReady, attempt, publicReady };
    }, 1000);
    if (last.ready) return last;
    endOwnedTask(TASK_TUNNEL);
    stopRecordedTunnelProcess();
    await delay(1000);
  }
  const providerHint = provider === "cloudflare"
    ? `Verify that ${publicBaseUrl} routes to http://127.0.0.1:${port}.`
    : "Verify that the configured domain belongs to the same ngrok account as the Authtoken.";
  const logTail = safeLogTail(spec.logFile, 30);
  throw new Error(
    `${provider} failed after ${SERVICE_START_ATTEMPTS} attempts to publish ${publicBaseUrl}.\n` +
    `${providerHint}\nLast readiness: ${JSON.stringify(last)}\n\n` +
    `Recent ${provider} log:\n${logTail || `(no ${provider} log output)`}`,
  );
}

async function startServices() {
  const provider = selectedTunnelProvider();
  ensureRuntime(provider);
  seedBundledPlugins();
  const missingTasks = [TASK_MCP, TASK_TUNNEL].filter((task) => !taskExists(task));
  if (missingTasks.length) {
    throw new Error(
      `Portable scheduled tasks are not installed: ${missingTasks.join(", ")}. ` +
      "Save the configuration and install the tasks before starting services.",
    );
  }
  requireOwnedTask(TASK_MCP);
  requireOwnedTask(TASK_TUNNEL);
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  const config = readJson(CONFIG_FILE, {});
  const expected = validateStartConfiguration(provider, deployment, config);
  const existingLocal = await localServiceReady(expected.port);
  const existingPublic = existingLocal && await publicServiceReady(expected.publicBaseUrl);
  const existingAgent = provider !== "ngrok" || (await ngrokAgentState(expected.publicBaseUrl)).matchingTunnel;
  if (existingLocal && existingPublic && existingAgent) {
    return `Portable DevSpace and ${provider} are already healthy; no restart was required.\nOwner Password file (auth.json): ${AUTH_FILE}`;
  }
  stopServices();
  try {
    await startLocalService(expected.port);
    const tunnelStart = await startPublicTunnel(provider, expected.publicBaseUrl, expected.port);
    if (tunnelStart?.deferred) {
      return `Portable DevSpace local MCP started successfully. Public ${provider} tunnel is intentionally paused while Sangfor VPN is negotiating and will resume automatically after the VPN route stabilizes.\n` +
        `Owner Password file (auth.json): ${AUTH_FILE}`;
    }
    return `Portable DevSpace and ${provider} started successfully on the first requested operation; local and public OAuth metadata are healthy.\n` +
      `Owner Password file (auth.json): ${AUTH_FILE}`;
  } catch (error) {
    try { stopServices(); } catch {}
    throw error;
  }
}

async function enableServices() {
  requireOwnedTask(TASK_MCP);
  requireOwnedTask(TASK_TUNNEL);
  runProgram("schtasks.exe", ["/change", "/tn", TASK_MCP, "/enable"]);
  runProgram("schtasks.exe", ["/change", "/tn", TASK_TUNNEL, "/enable"]);
  return await startServices();
}

function disableServices() {
  requireOwnedTask(TASK_MCP);
  requireOwnedTask(TASK_TUNNEL);
  stopServices({ leaveDisabled: true });
  setOwnedTaskEnabled(TASK_TUNNEL, false);
  setOwnedTaskEnabled(TASK_MCP, false);
  return "Portable tasks were stopped and disabled for future logins.";
}

function uninstallTasks() {
  stopServices({ leaveDisabled: true });
  for (const task of [TASK_TUNNEL, LEGACY_TASK_NGROK, TASK_MCP]) {
    if (taskOwnedByRoot(task)) {
      runProgram("schtasks.exe", ["/delete", "/tn", task, "/f"], { ignoreExitCode: true });
    }
  }
  // A task host may outlive schtasks /delete briefly. Run one more direct-PID
  // cleanup pass after deletion and fail closed if a Portable-owned process is
  // still alive. This guarantees that, after the UI/manager processes exit,
  // the installation directory is not held open by a hidden launcher chain.
  sleepSync(300);
  const finalProcesses = stopPortableOwnedProcesses();
  cleanupRunState();
  if (finalProcesses.remaining.length) {
    const details = finalProcesses.remaining.map((item) => `${item.pid} ${item.name} ${item.executablePath}`);
    throw new Error(`Portable scheduled tasks were deleted but background processes remain:\n${details.join("\n")}`);
  }
  return "Portable scheduled tasks were removed. No Portable background process remains; configuration and OAuth data were preserved.";
}

function taskExists(task) {
  return runProgram("schtasks.exe", ["/query", "/tn", task], { ignoreExitCode: true }).status === 0;
}

function readRecordedPid(pidFile) {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function recordedProcessStatus(pidFile, expectedImage, requiredListenerPort = null) {
  const pid = readRecordedPid(pidFile);
  if (!pid) return { pid: null, image: "", running: false, listenerMatch: false };
  const image = processImageName(pid);
  const running = image === expectedImage.toLowerCase();
  const listenerMatch = running && requiredListenerPort !== null ? listenerPids(requiredListenerPort).includes(pid) : running;
  return { pid, image, running, listenerMatch };
}

function redactSecrets(text) {
  let safe = String(text || "");
  for (const secret of [existingNgrokToken(), existingCloudflareToken(), readJson(AUTH_FILE, {}).ownerToken]) {
    if (secret && String(secret).length >= 8) safe = safe.split(String(secret)).join("[REDACTED]");
  }
  return safe
    .replace(/(authtoken\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(tunnel[_ -]?token\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function safeLogTail(file, count) {
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return redactSecrets(lines.slice(-count).join("\n")).trim();
}

function normalizeOutboundProxyUrl(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "socks5:"].includes(url.protocol)) return "";
    if (!url.hostname || !url.port || url.username || url.password) return "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function parseWindowsProxyServer(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.includes("=") && !raw.includes(";")) return normalizeOutboundProxyUrl(raw);
  const entries = new Map();
  for (const item of raw.split(";")) {
    const [key, ...rest] = item.split("=");
    if (!key || !rest.length) continue;
    entries.set(key.trim().toLowerCase(), rest.join("=").trim());
  }
  for (const key of ["https", "http", "socks", "socks5"]) {
    if (!entries.has(key)) continue;
    const protocol = key.startsWith("socks") ? "socks5" : "http";
    const candidate = normalizeOutboundProxyUrl(`${protocol}://${entries.get(key)}`);
    if (candidate) return candidate;
  }
  return "";
}

function winInetProxyCandidate() {
  const result = runProgram("reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (result.status !== 0) return null;
  const enabledMatch = result.output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  const serverMatch = result.output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  if (!enabledMatch || Number.parseInt(enabledMatch[1], 16) === 0 || !serverMatch) return null;
  const proxyUrl = parseWindowsProxyServer(serverMatch[1]);
  return proxyUrl ? { url: proxyUrl, source: "wininet" } : null;
}

function inheritedProxyCandidates() {
  const values = [];
  const seen = new Set();
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    const url = normalizeOutboundProxyUrl(process.env[name]);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    values.push({ url, source: `env:${name}` });
  }
  return values;
}

function localProxyHealthy(proxyUrl) {
  if (!proxyUrl) return false;
  let parsed;
  try { parsed = new URL(proxyUrl); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return true;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return false;
  const result = runProgram("netstat.exe", ["-ano", "-p", "TCP"], { ignoreExitCode: true });
  if (result.status !== 0) return false;
  const escaped = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\[::1\\]|::):${escaped}\\s+\\S+\\s+LISTENING`, "i").test(result.output);
}

function outboundProbeCandidates() {
  const values = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate?.url) return;
    const key = candidate.url.toLowerCase();
    if (seen.has(key) || !localProxyHealthy(candidate.url)) return;
    seen.add(key);
    values.push(candidate);
  };
  const configured = existingNgrokNetworkOptions().proxyUrl;
  if (configured) add({ url: normalizeOutboundProxyUrl(configured), source: "ngrok-config" });
  add(winInetProxyCandidate());
  for (const candidate of inheritedProxyCandidates()) add(candidate);
  values.push({ url: "", source: "direct" });
  return values;
}

function curlProbe(url, timeoutMs, candidate) {
  if (!fs.existsSync(CURL_EXE)) return null;
  const timeoutSeconds = Math.max(2, Math.ceil(timeoutMs / 1000));
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--connect-timeout", String(Math.min(6, timeoutSeconds)),
    "--max-time", String(timeoutSeconds),
    "--dump-header", "-",
    "--output", "NUL",
    "--write-out", "\n__DEVSPACE_HTTP__%{http_code}|%{content_type}\n",
  ];
  if (candidate?.url) args.push("--proxy", candidate.url);
  else args.push("--proxy", "", "--noproxy", "*");
  args.push(url);
  const result = childProcess.spawnSync(CURL_EXE, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs + 2_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
    },
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "").trim();
  const marker = stdout.match(/__DEVSPACE_HTTP__(\d{3})\|([^\r\n]*)/);
  if (result.status !== 0 || !marker) {
    return {
      status: 0,
      error: stderr || `curl exit ${result.status ?? "unknown"}`,
      contentType: "",
      server: "",
      ngrokErrorCode: "",
      transport: candidate?.source || "direct",
    };
  }
  const headerBlocks = stdout.split(/\r?\n\r?\n/).filter((block) => /^HTTP\//i.test(block.trim()));
  const headers = headerBlocks.length ? headerBlocks[headerBlocks.length - 1] : "";
  const header = (name) => {
    const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return match ? match[1].trim() : "";
  };
  return {
    status: Number(marker[1]),
    error: "",
    contentType: marker[2] || header("content-type"),
    server: header("server"),
    ngrokErrorCode: header("ngrok-error-code"),
    transport: candidate?.source || "direct",
  };
}

async function probeUrl(url, timeoutMs = 20000) {
  let parsed;
  try { parsed = new URL(url); } catch { return { status: 0, error: "invalid URL", contentType: "", server: "", ngrokErrorCode: "", transport: "none" }; }
  const local = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname.toLowerCase());
  if (local) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (response.body) await response.body.cancel();
      return {
        status: response.status,
        error: "",
        contentType: response.headers.get("content-type") || "",
        server: response.headers.get("server") || "",
        ngrokErrorCode: response.headers.get("ngrok-error-code") || "",
        transport: "loopback",
      };
    } catch (error) {
      const cause = error?.cause;
      const code = cause?.code || error?.code || error?.name || "FETCH_ERROR";
      const message = cause?.message || error?.message || String(error);
      return { status: 0, error: `${code}: ${message}`, contentType: "", server: "", ngrokErrorCode: "", transport: "loopback" };
    }
  }
  const errors = [];
  for (const candidate of outboundProbeCandidates()) {
    const result = curlProbe(url, timeoutMs, candidate);
    if (!result) break;
    if (result.status > 0) return result;
    errors.push(`${candidate.source}: ${result.error}`);
  }
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (response.body) await response.body.cancel();
    return {
      status: response.status,
      error: "",
      contentType: response.headers.get("content-type") || "",
      server: response.headers.get("server") || "",
      ngrokErrorCode: response.headers.get("ngrok-error-code") || "",
      transport: "node-direct-fallback",
    };
  } catch (error) {
    const cause = error?.cause;
    const code = cause?.code || error?.code || error?.name || "FETCH_ERROR";
    const message = cause?.message || error?.message || String(error);
    errors.push(`node-direct: ${code}: ${message}`);
    return { status: 0, error: errors.join("; "), contentType: "", server: "", ngrokErrorCode: "", transport: "failed" };
  }
}

function formatProbe(probe) {
  const details = [];
  if (probe.error) details.push(`error=${probe.error}`);
  if (probe.contentType) details.push(`content-type=${probe.contentType}`);
  if (probe.server) details.push(`server=${probe.server}`);
  if (probe.ngrokErrorCode) details.push(`ngrok-error=${probe.ngrokErrorCode}`);
  if (probe.transport) details.push(`transport=${probe.transport}`);
  return `HTTP ${probe.status}${details.length ? ` (${details.join(", ")})` : ""}`;
}

async function ngrokAgentState(expectedPublicUrl) {
  const tunnels = [];
  const apiPorts = [];
  const errors = [];
  const observations = await Promise.all(Array.from({ length: 10 }, async (_unused, index) => {
    const port = 4040 + index;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/tunnels`, { signal: AbortSignal.timeout(750) });
      if (response.status !== 200) return { port, reachable: false, tunnels: [] };
      const body = await response.json();
      return {
        port,
        reachable: true,
        tunnels: Array.isArray(body.tunnels) ? body.tunnels.map((item) => ({
          publicUrl: String(item.public_url || "").replace(/\/$/, ""),
          target: String(item.config?.addr || ""),
          protocol: String(item.proto || ""),
          apiPort: port,
        })) : [],
      };
    } catch (error) {
      return { port, reachable: false, tunnels: [], error: error?.message || String(error) };
    }
  }));
  for (const observation of observations) {
    if (observation.reachable) apiPorts.push(observation.port);
    else if (observation.error && !/fetch failed|aborted|timeout/i.test(observation.error)) {
      errors.push(`${observation.port}: ${observation.error}`);
    }
    tunnels.push(...observation.tunnels);
  }
  return {
    reachable: apiPorts.length > 0,
    matchingTunnel: tunnels.some((item) => item.publicUrl.toLowerCase() === String(expectedPublicUrl).toLowerCase()),
    tunnels,
    apiPorts,
    errors,
  };
}

async function statusText() {
  const lines = [];
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676, tunnelProvider: "ngrok" });
  const config = readJson(CONFIG_FILE, {});
  const provider = normalizeTunnelProvider(deployment.tunnelProvider || "ngrok");
  const toolMode = normalizeToolMode(deployment.toolMode || "full");
  const permissions = normalizePermissionSettings(deployment.permissions || config.permissions || { profile: "workspace" });
  const spec = tunnelProcessSpec(provider);
  const port = Number(deployment.port || config.port || 7676);
  const mcp = recordedProcessStatus(MCP_PID_FILE, "node.exe", port);
  let tunnel = recordedProcessStatus(TUNNEL_PID_FILE, spec.image);
  if (!tunnel.pid && provider === "ngrok") tunnel = recordedProcessStatus(NGROK_PID_FILE, spec.image);
  const tunnelNetwork = readJson(TUNNEL_NETWORK_STATE_FILE, null);
  const publicUrl = String(config.publicBaseUrl || "").replace(/\/$/, "");
  const publicProbe = publicUrl
    ? await probeUrl(`${publicUrl}/.well-known/oauth-protected-resource/mcp`, 5000)
    : { status: 0, error: "public URL not configured" };
  lines.push(
    `=== DevSpace Portable MCP Server ===\n` +
    `Tool mode: ${toolMode}\n` +
    `Access profile: ${permissions.profile}\n` +
    `External paths: ${permissions.allowExternalPaths ? "allowed" : "workspace only"}\n` +
    `Arbitrary commands: ${permissions.allowArbitraryCommands ? "allowed" : "coding workflow"}\n` +
    `Interactive/persistent processes: ${permissions.allowInteractiveProcesses ? "yes" : "no"}/${permissions.allowPersistentProcesses ? "yes" : "no"}\n` +
    `Task installed: ${taskExists(TASK_MCP) ? "yes" : "no"}\n` +
    `Recorded PID: ${mcp.pid ?? "none"}\n` +
    `Process running: ${mcp.running ? "yes" : "no"}\n` +
    `Own listener 127.0.0.1:${port}: ${mcp.listenerMatch ? "yes" : "no"}\n` +
    `Owner Password file (auth.json): ${AUTH_FILE}`,
  );
  let tunnelDetails =
    `=== DevSpace Portable Tunnel ===\n` +
    `Provider: ${provider}\n` +
    `Task installed: ${taskExists(TASK_TUNNEL) ? "yes" : "no"}\n` +
    `Recorded PID: ${tunnel.pid ?? "none"}\n` +
    `Process running: ${tunnel.running ? "yes" : "no"}\n` +
    `Public OAuth metadata: ${formatProbe(publicProbe)}`;
  if (provider === "ngrok") {
    const agent = await ngrokAgentState(publicUrl);
    tunnelDetails +=
      `\nAgent API: ${agent.reachable ? `reachable on ${agent.apiPorts.join(", ")}` : "unreachable on 4040-4049"}` +
      `\nConfigured public tunnel active: ${agent.matchingTunnel ? "yes" : "no"}` +
      `\nObserved tunnels: ${agent.tunnels.length ? agent.tunnels.map((item) => `${item.publicUrl} -> ${item.target}`).join("; ") : "none"}`;
    if (tunnelNetwork) {
      tunnelDetails +=
        `\nNetwork policy: ${tunnelNetwork.policy || "non-invasive"}` +
        `\nNetwork compatibility: ${tunnelNetwork.compatibility === false ? "disabled" : "enabled"}` +
        `\nNetwork mode: ${tunnelNetwork.mode || "unknown"}` +
        `\nNetwork reason: ${tunnelNetwork.reason || "unknown"}` +
        `\nProxy source: ${tunnelNetwork.proxySource || "none"}` +
        `\nTunnel supervisor PID: ${tunnelNetwork.supervisorPid || "none"}`;
    }
  } else {
    tunnelDetails += `\nPinned cloudflared: ${CLOUDFLARED_VERSION}`;
  }
  lines.push(tunnelDetails);
  const allListeners = listenerPids(port);
  lines.push(`=== TCP :${port} ===\nListener PIDs: ${allListeners.length ? allListeners.join(", ") : "none"}`);
  return lines.join("\n\n");
}

function dashboardIndicator(state, title, detail, extra = {}) {
  return { state, title, detail, ...extra };
}

async function dashboardStatus() {
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676, tunnelProvider: "ngrok" });
  const config = readJson(CONFIG_FILE, {});
  const provider = normalizeTunnelProvider(deployment.tunnelProvider || "ngrok");
  const port = Number(deployment.port || config.port || 7676);
  const publicUrl = String(config.publicBaseUrl || "").replace(/\/$/, "");
  const spec = tunnelProcessSpec(provider);
  const mcp = recordedProcessStatus(MCP_PID_FILE, "node.exe", port);
  let tunnel = recordedProcessStatus(TUNNEL_PID_FILE, spec.image);
  if (!tunnel.pid && provider === "ngrok") tunnel = recordedProcessStatus(NGROK_PID_FILE, spec.image);
  const tunnelNetwork = readJson(TUNNEL_NETWORK_STATE_FILE, null);
  const [localMetadata, localMcp, publicMetadata, publicMcp, agent] = await Promise.all([
    probeUrl(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, 2500),
    probeUrl(`http://127.0.0.1:${port}/mcp`, 2500),
    publicUrl ? probeUrl(`${publicUrl}/.well-known/oauth-protected-resource/mcp`, 4500) : Promise.resolve({ status: 0, error: "public URL not configured", transport: "none" }),
    publicUrl ? probeUrl(`${publicUrl}/mcp`, 4500) : Promise.resolve({ status: 0, error: "public URL not configured", transport: "none" }),
    provider === "ngrok" ? ngrokAgentState(publicUrl) : Promise.resolve({ reachable: tunnel.running, matchingTunnel: tunnel.running, tunnels: [], apiPorts: [], errors: [] }),
  ]);

  const mcpTaskInstalled = taskExists(TASK_MCP);
  const mcpTaskEnabled = mcpTaskInstalled && taskEnabled(TASK_MCP);
  const tunnelTaskInstalled = taskExists(TASK_TUNNEL);
  const tunnelTaskEnabled = tunnelTaskInstalled && taskEnabled(TASK_TUNNEL);
  const serviceReady = mcp.running && mcp.listenerMatch && localMetadata.status === 200 && localMcp.status === 401;
  const tunnelReady = tunnel.running && publicMetadata.status === 200 && publicMcp.status === 401 && (provider !== "ngrok" || agent.matchingTunnel);
  const criticalFiles = [
    "DevSpace-Portable.exe",
    "VERSION-MANIFEST.json",
    "SHA256SUMS.txt",
    "runtime\\node\\node.exe",
    "setup\\portable-manager.cjs",
    "setup\\portable-updater.ps1",
  ];
  const missingFiles = criticalFiles.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  let installedVersion = "unknown";
  try { installedVersion = String(readJson(path.join(ROOT, "VERSION-MANIFEST.json"), {}).runtime?.devspacePortable || "unknown"); } catch {}
  const filesReady = missingFiles.length === 0 && installedVersion === PORTABLE_VERSION;

  const serviceState = serviceReady ? (mcpTaskEnabled ? "ready" : "warning") : (mcp.running ? "warning" : "stopped");
  const serviceTitle = serviceReady ? (mcpTaskEnabled ? "服务已就绪" : "服务已运行，计划任务未启用") : (mcp.running ? "服务正在恢复" : "服务未运行");
  const tunnelState = tunnelReady ? (tunnelTaskEnabled ? "ready" : "warning") : (tunnel.running ? "warning" : "stopped");
  const tunnelTitle = tunnelReady ? (tunnelTaskEnabled ? "公网隧道已就绪" : "隧道已运行，计划任务未启用") : (tunnel.running ? "公网隧道正在恢复" : "公网隧道未运行");
  const httpReady = localMetadata.status === 200 && localMcp.status === 401 && publicMetadata.status === 200 && publicMcp.status === 401;
  const httpState = httpReady ? "ready" : (localMetadata.status === 200 ? "warning" : "error");
  const httpTitle = httpReady ? "HTTP / OAuth 验证正常" : (localMetadata.status === 200 ? "本地正常，公网验证异常" : "本地 HTTP 验证异常");
  const networkMode = String(tunnelNetwork?.mode || "unknown");
  const networkSource = String(tunnelNetwork?.proxySource || "none");
  const networkState = tunnelNetwork?.paused ? "warning" : "ready";
  const networkTitle = tunnelNetwork?.paused ? "公网出站正在等待可用代理" : "网络共存策略正常";

  const indicators = {
    service: dashboardIndicator(
      serviceState,
      serviceTitle,
      serviceReady ? `MCP 监听 127.0.0.1:${port} · PID ${mcp.pid ?? "-"}` : `监听=${mcp.listenerMatch ? "yes" : "no"} · 本地 OAuth=${localMetadata.status || 0}`,
      { pid: mcp.pid, listener: mcp.listenerMatch, taskInstalled: mcpTaskInstalled, taskEnabled: mcpTaskEnabled },
    ),
    tunnel: dashboardIndicator(
      tunnelState,
      tunnelTitle,
      tunnelReady ? `${provider} · 公网 OAuth HTTP 200 · PID ${tunnel.pid ?? "-"}` : `${provider} · 公网 OAuth=${publicMetadata.status || 0} · 进程=${tunnel.running ? "running" : "stopped"}`,
      { pid: tunnel.pid, taskInstalled: tunnelTaskInstalled, taskEnabled: tunnelTaskEnabled, provider },
    ),
    http: dashboardIndicator(
      httpState,
      httpTitle,
      `本地 ${localMetadata.status}/${localMcp.status} · 公网 ${publicMetadata.status}/${publicMcp.status} · ${publicMetadata.transport || "unknown"}`,
      { localMetadata, localMcp, publicMetadata, publicMcp },
    ),
    files: dashboardIndicator(
      filesReady ? "ready" : "error",
      filesReady ? "核心文件与版本正常" : "核心文件或版本需要检查",
      filesReady ? `DevSpace Portable ${installedVersion} · 关键文件齐全` : `版本=${installedVersion} · 缺失=${missingFiles.length ? missingFiles.join(", ") : "none"}`,
      { installedVersion, missingFiles },
    ),
    network: dashboardIndicator(
      networkState,
      networkTitle,
      `非侵入式网络策略 · mode=${networkMode} · proxy=${networkSource}`,
      { mode: networkMode, proxySource: networkSource, policy: tunnelNetwork?.policy || "non-invasive", reason: tunnelNetwork?.reason || "unknown" },
    ),
  };
  const values = Object.values(indicators);
  const overallState = values.some((item) => item.state === "error")
    ? "error"
    : values.some((item) => item.state === "stopped")
      ? "stopped"
      : values.some((item) => item.state === "warning")
        ? "warning"
        : "ready";
  return {
    portableVersion: PORTABLE_VERSION,
    protocolVersion: "1.5",
    refreshedAt: new Date().toISOString(),
    overall: dashboardIndicator(
      overallState,
      overallState === "ready" ? "DevSpace 已就绪" : overallState === "warning" ? "DevSpace 可用，但存在需要关注的状态" : overallState === "stopped" ? "DevSpace 部分服务未运行" : "DevSpace 状态异常",
      overallState === "ready" ? "本地服务、公网隧道、HTTP/OAuth 与核心文件均通过轻量检查。" : "打开“详细信息”查看验证、隧道、文件和日志。",
    ),
    indicators,
  };
}

async function testEndpoints() {
  const config = readJson(CONFIG_FILE);
  if (!config) throw new Error("Portable configuration does not exist.");
  const local = `http://127.0.0.1:${config.port}`;
  const checks = [
    [200, `${local}/.well-known/oauth-protected-resource/mcp`],
    [200, `${local}/.well-known/oauth-authorization-server`],
    [401, `${local}/mcp`],
    [200, `${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`],
    [200, `${config.publicBaseUrl}/.well-known/oauth-authorization-server`],
    [401, `${config.publicBaseUrl}/mcp`],
  ];
  const results = [];
  let failures = 0;
  for (const [expected, url] of checks) {
    const probe = await probeUrl(url);
    const ok = probe.status === expected;
    if (!ok) failures += 1;
    results.push(
      `${ok ? "PASS" : "FAIL"} expected=${expected} actual=${probe.status} ${url}` +
      `${probe.error ? ` error=${probe.error}` : ""}` +
      `${probe.ngrokErrorCode ? ` ngrok-error=${probe.ngrokErrorCode}` : ""}`,
    );
  }
  const provider = selectedTunnelProvider();
  const logName = provider === "cloudflare" ? "cloudflared.log" : "ngrok.log";
  const report = `${results.join("\n")}\nfailures=${failures}${failures ? `\nRun 'diagnose' and inspect logs\\${logName}.` : ""}\n`;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, "latest-http-test.txt"), report, "utf8");
  writeOutput(report);
  if (failures) process.exitCode = 1;
}

async function diagnoseText() {
  const config = readJson(CONFIG_FILE);
  if (!config) throw new Error("Portable configuration does not exist.");
  const publicUrl = String(config.publicBaseUrl || "").replace(/\/$/, "");
  const hostname = new URL(publicUrl).hostname;
  const lines = [await statusText(), "", "=== DNS ==="];
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    lines.push(`${hostname}: ${addresses.map((item) => item.address).join(", ") || "no addresses"}`);
  } catch (error) {
    lines.push(`${hostname}: FAILED ${error.code || error.name}: ${error.message}`);
  }
  lines.push("", "=== HTTP probes ===");
  for (const url of [
    `http://127.0.0.1:${config.port}/.well-known/oauth-protected-resource/mcp`,
    `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
    `${publicUrl}/.well-known/oauth-authorization-server`,
    `${publicUrl}/mcp`,
  ]) {
    lines.push(`${url}\n  ${formatProbe(await probeUrl(url))}`);
  }
  const provider = selectedTunnelProvider();
  if (provider === "ngrok") {
    const configCheck = runProgram(NGROK_EXE, ["config", "check", "--config", NGROK_CONFIG], { ignoreExitCode: true });
    lines.push("", "=== ngrok config check ===", `Exit code: ${configCheck.status}`, redactSecrets(configCheck.output || "(no output)"));
    lines.push("", "=== Recent ngrok log ===", safeLogTail(path.join(ROOT, "logs", "ngrok.log"), 50) || "(no ngrok log output)");
  } else {
    const versionCheck = runProgram(CLOUDFLARED_EXE, ["--version"], { ignoreExitCode: true, outputEncoding: "utf-8" });
    lines.push("", "=== cloudflared runtime ===", `Exit code: ${versionCheck.status}`, versionCheck.output || "(no output)");
    lines.push("", "=== Cloudflare route requirement ===", `${publicUrl} must be a published application route to http://127.0.0.1:${config.port}.`);
    lines.push("", "=== Recent cloudflared log ===", safeLogTail(path.join(ROOT, "logs", "cloudflared.log"), 50) || "(no cloudflared log output)");
  }
  return lines.join("\n");
}

async function sha256File(file, size = null) {
  const fileSize = Number.isFinite(size) ? Number(size) : fs.statSync(file).size;
  if (fileSize <= 8 * 1024 * 1024) {
    const content = await fs.promises.readFile(file);
    return crypto.createHash("sha256").update(content).digest("hex");
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyFiles() {
  if (!fs.existsSync(CHECKSUM_FILE)) throw new Error("SHA256SUMS.txt is missing.");
  const entries = fs.readFileSync(CHECKSUM_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-fA-F]{64})  (.+)$/);
      if (!match) throw new Error(`Invalid checksum line: ${line}`);
      return { expected: match[1].toLowerCase(), relative: match[2] };
    });
  const failures = [];
  let nextIndex = 0;
  const workerCount = Math.min(16, entries.length);
  async function verifyWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      const file = path.resolve(ROOT, entry.relative.replaceAll("/", path.sep));
      if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
        failures.push(`${entry.relative}: path escapes the portable root`);
        continue;
      }
      if (!fs.existsSync(file)) {
        failures.push(`${entry.relative}: missing`);
        continue;
      }
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        failures.push(`${entry.relative}: missing`);
        continue;
      }
      try {
        const actual = await sha256File(file, stat.size);
        if (actual !== entry.expected) failures.push(`${entry.relative}: checksum mismatch`);
      } catch (error) {
        failures.push(`${entry.relative}: ${String(error?.message || error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => verifyWorker()));
  failures.sort();
  if (failures.length) {
    throw new Error(`Checksum verification failed (${failures.length}):\n${failures.slice(0, 20).join("\n")}`);
  }
  return `Checksum verification passed: ${entries.length} files.`;
}

function showConfig() {
  const config = readJson(CONFIG_FILE, {});
  const deployment = readJson(DEPLOYMENT_FILE, {});
  const ngrokNetwork = existingNgrokNetworkOptions();
  const tunnelProvider = normalizeTunnelProvider(deployment.tunnelProvider || "ngrok");
  const providerUrls = {
    ngrok: String(deployment.providerUrls?.ngrok || "").trim(),
    cloudflare: String(deployment.providerUrls?.cloudflare || "").trim(),
  };
  if (!providerUrls[tunnelProvider] && config.publicBaseUrl) providerUrls[tunnelProvider] = config.publicBaseUrl;
  return {
    configured: fs.existsSync(CONFIG_FILE) && fs.existsSync(AUTH_FILE),
    tunnelProvider,
    toolMode: normalizeToolMode(deployment.toolMode || "full"),
    permissions: normalizePermissionSettings(deployment.permissions || config.permissions || { profile: "workspace" }),
    features: normalizeFeatureSettings(deployment.features || config.features || {}),
    portableVersion: PORTABLE_VERSION,
    protocolVersion: "1.5",
    uiLease: uiLeaseStatus(),
    providerUrls,
    publicBaseUrl: config.publicBaseUrl || "",
    port: config.port || 7676,
    allowedRoots: config.allowedRoots || [],
    permissionMode: deployment.permissionMode || "selected-roots",
    hasOwnerToken: Boolean(readJson(AUTH_FILE, {}).ownerToken),
    hasNgrokToken: Boolean(existingNgrokToken()),
    hasCloudflareToken: Boolean(existingCloudflareToken()),
    ngrokProxyUrl: ngrokNetwork.proxyUrl,
    tunnelNetworkCompatibility: deployment.tunnelNetworkCompatibility !== false,
    ngrokConnectCasHost: ngrokNetwork.connectCasHost,
    cloudflaredInstalled: fs.existsSync(CLOUDFLARED_EXE),
    cloudflaredVersion: CLOUDFLARED_VERSION,
    configDir: CONFIG_DIR,
    authFile: AUTH_FILE,
    stateDir: config.stateDir || STATE_DIR,
    pluginRoot: path.join(DATA_DIR, "plugins", "installed"),
    mcpUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/mcp` : "",
  };
}

function fixedDrives() {
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) drives.push(root);
    } catch {}
  }
  return drives;
}

function getValue(name) {
  const config = readJson(CONFIG_FILE, {});
  if (name === "publicBaseUrl") return config.publicBaseUrl || "";
  if (name === "port") return String(config.port || 7676);
  if (name === "tunnelProvider") return selectedTunnelProvider();
  if (name === "toolMode") return selectedToolMode();
  if (name === "accessProfile") return selectedPermissions().profile;
  if (name === "computerUse") return String(selectedFeatures().computerUse);
  if (name === "ngrokConfigFile") return NGROK_CONFIG;
  if (name === "cloudflareTokenFile") return CLOUDFLARE_TOKEN_FILE;
  if (name === "tunnelPidFile") return TUNNEL_PID_FILE;
  throw new Error(`Unknown value: ${name}`);
}

function stdoutJson(value) {
  let output = JSON.stringify(value);
  if (process.argv.includes("--ascii-json")) {
    output = output.replace(/[\u007f-\uffff]/g, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  writeOutput(output);
}

async function main() {
  const command = process.argv[2] || "help";
  try {
    if (command === "configure") {
      stdoutJson(await configure(await readStdinJson()));
    } else if (command === "set-computer-use") {
      stdoutJson(setComputerUse(await readStdinJson()));
    } else if (command === "show-config") {
      stdoutJson(showConfig());
    } else if (command === "ui-open") {
      stdoutJson(openUiLease());
    } else if (command === "ui-heartbeat") {
      stdoutJson(heartbeatUiLease(await readStdinJson()));
    } else if (command === "ui-close") {
      stdoutJson(closeUiLease(await readStdinJson()));
    } else if (command === "ui-status") {
      stdoutJson(uiLeaseStatus());
    } else if (command === "list-drives") {
      stdoutJson(fixedDrives());
    } else if (command === "install-tasks") {
      writeOutput(installTasks() + "\n");
    } else if (command === "start") {
      writeOutput(`${await startServices()}\n`);
    } else if (command === "stop") {
      writeOutput(stopServices() + "\n");
    } else if (command === "shutdown") {
      writeOutput(shutdownServices() + "\n");
    } else if (command === "restart") {
      stopServices();
      writeOutput(`${await startServices()}\n`);
    } else if (command === "enable") {
      writeOutput(`${await enableServices()}\n`);
    } else if (command === "disable") {
      writeOutput(disableServices() + "\n");
    } else if (command === "uninstall-tasks") {
      writeOutput(uninstallTasks() + "\n");
    } else if (command === "status") {
      writeOutput(`${await statusText()}\n`);
    } else if (command === "dashboard-status") {
      stdoutJson(await dashboardStatus());
    } else if (command === "test") {
      await testEndpoints();
    } else if (command === "diagnose") {
      writeOutput(`${await diagnoseText()}\n`);
    } else if (command === "verify-files") {
      writeOutput(`${await verifyFiles()}\n`);
    } else if (command === "update-check") {
      stdoutJson(runPortableUpdater("Check"));
    } else if (command === "update-stage") {
      stdoutJson(runPortableUpdater("Stage"));
    } else if (command === "update-launch") {
      stdoutJson(launchPortableUpdate(await readStdinJson()));
    } else if (command === "install-cloudflared") {
      const installed = await ensureCloudflaredRuntime();
      writeOutput(`${installed ? "Installed" : "Verified"} cloudflared ${CLOUDFLARED_VERSION}.\n`);
    } else if (command === "plugin-list") {
      stdoutJson(runPluginAdmin("list"));
    } else if (command === "plugin-refresh") {
      stdoutJson({ bundledPlugins: seedBundledPlugins(), ...runPluginAdmin("refresh") });
    } else if (command === "seed-bundled-plugins") {
      stdoutJson(seedBundledPlugins());
    } else if (command === "plugin-install") {
      stdoutJson(runPluginAdmin("install", await readStdinJson()));
    } else if (command === "plugin-enable") {
      stdoutJson(runPluginAdmin("enable", await readStdinJson()));
    } else if (command === "plugin-disable") {
      stdoutJson(runPluginAdmin("disable", await readStdinJson()));
    } else if (command === "plugin-uninstall") {
      stdoutJson(runPluginAdmin("uninstall", await readStdinJson()));
    } else if (command === "plugin-slot-bind") {
      stdoutJson(runPluginAdmin("bind-slot", await readStdinJson()));
    } else if (command === "plugin-slot-unbind") {
      stdoutJson(runPluginAdmin("unbind-slot", await readStdinJson()));
    } else if (command === "review-list") {
      stdoutJson(await runReviewAdmin("list", await readStdinJson()));
    } else if (command === "review-details") {
      stdoutJson(await runReviewAdmin("details", await readStdinJson()));
    } else if (command === "review-update") {
      stdoutJson(await runReviewAdmin("update", await readStdinJson()));
    } else if (command === "review-rollback") {
      stdoutJson(await runReviewAdmin("rollback", await readStdinJson()));
    } else if (command === "review-restore-safety") {
      stdoutJson(await runReviewAdmin("restore-safety", await readStdinJson()));
    } else if (command === "memory-list") {
      stdoutJson(await runMemoryAdmin("list", await readStdinJson()));
    } else if (command === "memory-upsert") {
      stdoutJson(await runMemoryAdmin("upsert", await readStdinJson()));
    } else if (command === "memory-delete") {
      stdoutJson(await runMemoryAdmin("delete", await readStdinJson()));
    } else if (command === "log-paths") {
      const provider = selectedTunnelProvider();
      stdoutJson({
        devspace: path.join(ROOT, "logs", "devspace.log"),
        tunnel: path.join(ROOT, "logs", provider === "cloudflare" ? "cloudflared.log" : "ngrok.log"),
        directory: path.join(ROOT, "logs"),
      });
    } else if (command === "portable-processes") {
      stdoutJson({ processes: portableProcessSnapshot() });
    } else if (command === "get") {
      writeOutput(getValue(process.argv[3]) + "\n");
    } else {
      writeOutput("Commands: configure set-computer-use show-config ui-open ui-heartbeat ui-close ui-status list-drives install-tasks start stop shutdown restart enable disable uninstall-tasks status dashboard-status test diagnose verify-files update-check update-stage update-launch install-cloudflared plugin-list plugin-refresh seed-bundled-plugins plugin-install plugin-enable plugin-disable plugin-uninstall plugin-slot-bind plugin-slot-unbind review-list review-details review-update review-rollback review-restore-safety memory-list memory-upsert memory-delete log-paths portable-processes get\n");
    }
  } catch (error) {
    fail(error && error.stack ? error.stack : error);
  }
}

module.exports = {
  COMPUTER_USE_BROKER_FILE,
  UI_LEASE_FILE,
  processComputerUseRequests,
  readJson,
  uiLeaseStatus,
  writeJson,
};

if (require.main === module) {
  void main();
}
