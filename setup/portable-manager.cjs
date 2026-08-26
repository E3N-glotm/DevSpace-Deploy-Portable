"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const http = require("http");
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
const DASHBOARD_PUBLIC_PROBE_FILE = path.join(RUN_DIR, "dashboard-public-probe.json");
const PROXY_REPAIR_BACKUP_FILE = path.join(STATE_DIR, "network-proxy-repair-backup.json");
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
const REMOTE_AGENT_STORE_FILE = path.join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "remote-agent-store.js");
const PORTABLE_UPDATER_FILE = path.join(ROOT, "setup", "portable-updater.ps1");
const UPDATE_STAGING_ROOT = path.join(ROOT, ".update-staging");
const UPDATE_REPOSITORY = "E3N-glotm/DevSpace-Deploy-Portable";
const BUNDLED_PLUGIN_ROOT = path.join(ROOT, "setup", "bundled-plugins");
const INSTALLED_PLUGIN_ROOT = path.join(DATA_DIR, "plugins", "installed");
const TASK_MCP = "DevSpace Portable MCP Server";
const TASK_TUNNEL = "DevSpace Portable Tunnel";
const LEGACY_TASK_NGROK = "DevSpace Portable ngrok Tunnel";
const PORTABLE_VERSION = "1.1.48";
const UI_LEASE_TTL_MS = 90_000;
const LOCAL_SERVICE_START_TIMEOUT_MS = 45_000;
const TUNNEL_START_TIMEOUT_MS = 45_000;
const SERVICE_START_ATTEMPTS = 3;
const PORTABLE_STOP_TIMEOUT_MS = 20_000;
const DASHBOARD_PUBLIC_PROBE_SUCCESS_TTL_MS = 15_000;
const DASHBOARD_PUBLIC_PROBE_FAILURE_TTL_MS = 2_000;
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

function ensureLocalRuntime() {
  const requirements = [
    ["Node", NODE_EXE],
    ["Git Bash", BASH_EXE],
    ["DevSpace CLI", CLI_FILE],
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

async function runContinuationAdmin(action, payload = {}) {
  if (!fs.existsSync(DATABASE_CLIENT_FILE)) {
    throw new Error("Continuation runtime is missing from the bundled DevSpace package.");
  }
  const databaseModule = await import(`${pathToFileURL(DATABASE_CLIENT_FILE).href}?mtime=${fs.statSync(DATABASE_CLIENT_FILE).mtimeMs}`);
  const database = databaseModule.openDatabase(STATE_DIR);
  const parse = (value, fallback) => {
    try { return JSON.parse(String(value || "")); } catch { return fallback; }
  };
  const taskFromRow = (row) => {
    const required = parse(row.required_milestones_json, []);
    const completed = parse(row.completed_milestones_json, []);
    const rawMode = String(row.continuation_mode || "compat").toLowerCase();
    const continuationMode = rawMode === "resident" ? "resident"
      : (rawMode === "timeout-recovery" || rawMode === "explicit-long") ? "timeout-recovery"
        : "compat";
    return {
      id: row.id,
      workspaceId: row.workspace_id || "",
      objective: row.objective,
      state: row.state,
      continuationMode,
      requiredMilestones: required,
      completedMilestones: completed,
      evidence: parse(row.evidence_json, {}),
      continuationCount: Number(row.continuation_count || 0),
      maxContinuations: Number(row.max_continuations || 0),
      noProgressCount: Number(row.no_progress_count || 0),
      maxNoProgress: Number(row.max_no_progress || 0),
      continuationPending: [1, 3, 4, 5].includes(Number(row.continuation_pending || 0)),
      continuationWakePending: [2, 3, 4].includes(Number(row.continuation_pending || 0)),
      continuationDeliveryAwaitingAck: [4, 5].includes(Number(row.continuation_pending || 0)),
      ownerLocked: Boolean(row.owner_locked),
      ownerLockedAt: row.owner_locked_at || "",
      ownerControlNote: row.owner_control_note || "",
      waitingReason: row.waiting_reason || "",
      terminalReason: row.terminal_reason || "",
      deadlineAt: row.deadline_at || "",
      turnStartedAt: row.turn_started_at || "",
      lastModelActivityAt: row.last_model_activity_at || "",
      observedTurnBudgetMs: Number(row.observed_turn_budget_ms || 0),
      recommendedContinueAfterMs: Number(row.recommended_continue_after_ms || 0),
      hostTimeoutSamples: Number(row.host_timeout_samples || 0),
      confirmedTurnLimitMs: Number(row.confirmed_turn_limit_ms || 0),
      confirmedTurnLimitAt: row.confirmed_turn_limit_at || "",
      confirmedTurnLimitSource: row.confirmed_turn_limit_source || "",
      lastHostSignal: row.last_host_signal || "",
      lastActivityAt: row.last_activity_at || row.updated_at,
      lastContinuationAt: row.last_continuation_at || "",
      lastSendAttemptAt: row.last_send_attempt_at || "",
      lastSendResult: parse(row.last_send_result, {}),
      watchProcessHandles: parse(row.watch_process_handles_json, []),
      progressCompleted: completed.length,
      progressRequired: required.length,
      progressPercent: required.length ? Math.min(100, Math.round(completed.length * 100 / required.length)) : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  try {
    if (action === "list") {
      const limit = Math.max(1, Math.min(Number(payload.limit || 200), 1000));
      const includeTerminal = payload.includeTerminal !== false;
      const where = includeTerminal ? "" : "where state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED')";
      const rows = database.sqlite.prepare(`select * from continuation_tasks ${where} order by updated_at desc limit ?`).all(limit);
      return {
        tasks: rows.map(taskFromRow),
        activeCount: rows.filter((row) => !new Set(['SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED']).has(row.state)).length,
      };
    }
    const requestedIds = Array.isArray(payload.taskIds) ? payload.taskIds : [payload.taskId];
    const taskIds = [...new Set(requestedIds.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 300);
    if (!taskIds.length) throw new Error("taskId or taskIds is required.");
    const rows = taskIds.map((taskId) => database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId));
    const missing = taskIds.filter((taskId, index) => !rows[index]);
    if (missing.length) throw new Error(`Continuation task not found: ${missing.join(", ")}`);
    const now = new Date().toISOString();
    const terminalStates = new Set(["SUCCEEDED", "FAILED_TERMINAL", "CANCELLED_BY_USER", "ABORTED_NO_PROGRESS", "BUDGET_EXHAUSTED"]);
    const resumableStates = new Set(["PAUSED_BY_USER", "WAITING_EXTERNAL", "WAITING_SUPERVISOR", "FAILED_RETRYABLE"]);
    const skipped = [];
    const deletedIds = [];
    const transaction = database.sqlite.transaction(() => {
      for (let index = 0; index < taskIds.length; index += 1) {
        const taskId = taskIds[index];
        const row = rows[index];
        if (action === "lock" || action === "unlock") {
          const locked = action === "lock" ? 1 : 0;
          database.sqlite.prepare(`
            update continuation_tasks set owner_locked=?, owner_locked_at=?, owner_control_note=?, updated_at=? where id=?
          `).run(locked, locked ? now : null, locked ? "Locked by Portable owner UI." : "Unlocked by Portable owner UI.", now, taskId);
        }
        else if (action === "pause") {
          if (terminalStates.has(row.state) || row.state === "PAUSED_BY_USER") {
            skipped.push({ taskId, reason: terminalStates.has(row.state) ? "task-terminal" : "already-paused" });
            continue;
          }
          database.sqlite.prepare(`
            update continuation_tasks set state='PAUSED_BY_USER', waiting_reason='Paused by Portable owner UI.',
              continuation_pending=0, owner_control_note='Paused explicitly by Portable owner UI.', updated_at=? where id=?
          `).run(now, taskId);
        }
        else if (action === "stop") {
          if (terminalStates.has(row.state)) {
            skipped.push({ taskId, reason: "task-terminal" });
            continue;
          }
          database.sqlite.prepare(`
            update continuation_tasks set state='CANCELLED_BY_USER', terminal_reason='owner-stopped',
              continuation_pending=0, watch_process_handles_json='[]', waiting_reason=null,
              owner_control_note='Stopped explicitly by Portable owner UI.', updated_at=? where id=?
          `).run(now, taskId);
        }
        else if (action === "resume") {
          if (!resumableStates.has(row.state)) {
            skipped.push({ taskId, reason: terminalStates.has(row.state) ? "task-terminal" : "task-not-resumable" });
            continue;
          }
          database.sqlite.prepare(`
            update continuation_tasks set state='RUNNING', terminal_reason=null, waiting_reason=null,
              continuation_pending=0, turn_started_at=?, owner_control_note='Resumed explicitly by Portable owner UI.', updated_at=? where id=?
          `).run(now, now, taskId);
        }
        else if (action === "delete") {
          database.sqlite.prepare("delete from continuation_tasks where id=?").run(taskId);
          deletedIds.push(taskId);
        }
        else {
          throw new Error(`Unsupported continuation admin action: ${action}`);
        }
      }
    });
    transaction();
    const tasks = taskIds
      .filter((taskId) => !deletedIds.includes(taskId))
      .map((taskId) => database.sqlite.prepare("select * from continuation_tasks where id=?").get(taskId))
      .filter(Boolean)
      .map(taskFromRow);
    return {
      task: tasks.length === 1 ? tasks[0] : undefined,
      tasks,
      deletedIds,
      skipped,
      affected: taskIds.length - skipped.length,
      accepted: true,
    };
  } finally {
    database.close();
  }
}

function normalizeOAuthRedirectUris(value) {
  const input = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();
  for (const item of input) {
    const text = String(item || "").trim();
    if (!text) continue;
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`Invalid OAuth redirect URI: ${text}`);
    }
    if (parsed.hash || parsed.username || parsed.password) {
      throw new Error(`OAuth redirect URI may not contain credentials or a fragment: ${text}`);
    }
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname);
    if (loopback) {
      if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
        throw new Error(`Loopback OAuth redirect URI must use HTTP or HTTPS: ${text}`);
      }
    } else if (parsed.protocol !== "https:") {
      const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
      const unsafeSchemes = new Set(["http", "file", "data", "javascript", "vbscript", "ftp"]);
      if (unsafeSchemes.has(scheme) || !scheme.includes(".") || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
        throw new Error(`Remote OAuth redirect URI must use HTTPS or a reverse-domain private URI scheme: ${text}`);
      }
    }
    const normalized = parsed.href;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (result.length < 1) throw new Error("At least one OAuth redirect URI is required.");
  if (result.length > 16) throw new Error("At most 16 OAuth redirect URIs may be registered for one client.");
  return result;
}

function safeOAuthClientRecord(client, issuedAt) {
  const clientId = String(client?.client_id || "");
  return {
    clientId,
    clientName: String(client?.client_name || clientId || "Unnamed MCP client"),
    redirectUris: Array.isArray(client?.redirect_uris) ? client.redirect_uris.map((value) => String(value)) : [],
    tokenEndpointAuthMethod: String(client?.token_endpoint_auth_method || "none"),
    grantTypes: Array.isArray(client?.grant_types) ? client.grant_types.map((value) => String(value)) : [],
    responseTypes: Array.isArray(client?.response_types) ? client.response_types.map((value) => String(value)) : [],
    issuedAt: Number(client?.client_id_issued_at || issuedAt || 0),
    secretPresent: Boolean(client?.client_secret),
    manual: clientId.startsWith("devspace-manual-"),
  };
}

async function runOAuthClientAdmin(action, payload = {}) {
  if (!fs.existsSync(DATABASE_CLIENT_FILE)) {
    throw new Error("OAuth client database runtime is missing from the bundled DevSpace package.");
  }
  const databaseModule = await import(`${pathToFileURL(DATABASE_CLIENT_FILE).href}?mtime=${fs.statSync(DATABASE_CLIENT_FILE).mtimeMs}`);
  const database = databaseModule.openDatabase(STATE_DIR);
  try {
    if (action === "list") {
      const rows = database.sqlite
        .prepare("select client_id, client_json, issued_at from oauth_clients order by issued_at desc limit 500")
        .all();
      return {
        clients: rows.map((row) => {
          let client;
          try { client = JSON.parse(String(row.client_json || "{}")); }
          catch { client = { client_id: row.client_id, client_name: "Invalid OAuth client record" }; }
          return safeOAuthClientRecord(client, row.issued_at);
        }),
      };
    }
    if (action === "create") {
      const clientName = String(payload.clientName || "External MCP client").trim();
      if (!clientName || clientName.length > 120) throw new Error("OAuth client name must contain 1-120 characters.");
      const redirectUris = normalizeOAuthRedirectUris(payload.redirectUris || payload.redirectUri);
      const now = Math.floor(Date.now() / 1000);
      const clientSecret = crypto.randomBytes(32).toString("base64url");
      const client = {
        client_id: `devspace-manual-${crypto.randomUUID()}`,
        client_secret: clientSecret,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      database.sqlite
        .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
        .run(client.client_id, JSON.stringify(client), now);
      return {
        client: safeOAuthClientRecord(client, now),
        clientSecret,
        secretShownOnce: true,
      };
    }
    if (action === "rotate-secret") {
      const clientId = String(payload.clientId || "").trim();
      if (!clientId.startsWith("devspace-manual-")) {
        throw new Error("Only manually managed OAuth clients may rotate their secret from the Portable UI.");
      }
      const row = database.sqlite
        .prepare("select client_json, issued_at from oauth_clients where client_id = ?")
        .get(clientId);
      if (!row) throw new Error("OAuth client was not found.");
      const client = JSON.parse(String(row.client_json || "{}"));
      const clientSecret = crypto.randomBytes(32).toString("base64url");
      client.client_secret = clientSecret;
      client.client_secret_expires_at = 0;
      client.token_endpoint_auth_method = "client_secret_post";
      const rotate = database.sqlite.transaction(() => {
        database.sqlite.prepare("update oauth_clients set client_json = ? where client_id = ?").run(JSON.stringify(client), clientId);
        database.sqlite.prepare("delete from oauth_access_tokens where client_id = ?").run(clientId);
        database.sqlite.prepare("delete from oauth_refresh_tokens where client_id = ?").run(clientId);
      });
      rotate.immediate();
      return {
        client: safeOAuthClientRecord(client, row.issued_at),
        clientSecret,
        secretShownOnce: true,
        tokensRevoked: true,
      };
    }
    if (action === "delete") {
      const clientId = String(payload.clientId || "").trim();
      if (!clientId) throw new Error("OAuth client ID is required.");
      const result = database.sqlite.prepare("delete from oauth_clients where client_id = ?").run(clientId);
      if (result.changes !== 1) throw new Error("OAuth client was not found.");
      return { deleted: true, clientId, tokensRevoked: true };
    }
    throw new Error(`Unsupported OAuth client admin action: ${action}`);
  } finally {
    database.close();
  }
}

async function runRemoteAgentAdmin(action, payload = {}) {
  if (!fs.existsSync(REMOTE_AGENT_STORE_FILE)) {
    throw new Error("Remote Workspace Agent runtime is missing from the bundled DevSpace package.");
  }
  const moduleUrl = `${pathToFileURL(REMOTE_AGENT_STORE_FILE).href}?mtime=${fs.statSync(REMOTE_AGENT_STORE_FILE).mtimeMs}`;
  const remoteModule = await import(moduleUrl);
  const config = readJson(CONFIG_FILE, {});
  return remoteModule.remoteAgentAdmin({
    stateDir: STATE_DIR,
    action,
    payload,
    publicBaseUrl: String(config.publicBaseUrl || ""),
  });
}

function installTasks() {
  const provider = selectedTunnelProvider();
  ensureLocalRuntime();
  if (!fs.existsSync(CONFIG_FILE) || !fs.existsSync(AUTH_FILE)) {
    throw new Error("Save configuration before installing tasks.");
  }
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const preserveTunnelEnabled = taskOwnedByRoot(TASK_TUNNEL)
    ? taskEnabled(TASK_TUNNEL)
    : false;
  const mcpXml = path.join(REPORTS_DIR, "portable-mcp-task.xml");
  const tunnelXml = path.join(REPORTS_DIR, "portable-tunnel-task.xml");
  writeAtomic(mcpXml, `\uFEFF${taskXml("Portable DevSpace MCP server through bundled Git Bash.", path.join(ROOT, "scripts", "start-devspace.cmd"), "")}`, "utf16le");
  writeAtomic(tunnelXml, `\uFEFF${taskXml("Portable selected tunnel provider for DevSpace MCP.", path.join(ROOT, "scripts", "start-tunnel.cmd"), "PT15S")}`, "utf16le");
  stopServices({ leaveDisabled: true });
  runProgram("schtasks.exe", ["/delete", "/tn", LEGACY_TASK_NGROK, "/f"], { ignoreExitCode: true });
  runProgram("schtasks.exe", ["/create", "/tn", TASK_MCP, "/xml", mcpXml, "/f"]);
  runProgram("schtasks.exe", ["/create", "/tn", TASK_TUNNEL, "/xml", tunnelXml, "/f"]);
  // Fresh installs keep the tunnel opt-in. Task repair/update preserves an
  // existing tunnel-disabled choice instead of silently turning it back on.
  setOwnedTaskEnabled(TASK_TUNNEL, preserveTunnelEnabled);
  return `Portable user-level tasks were installed. Local MCP is available; the ${provider} tunnel task is ${preserveTunnelEnabled ? "enabled as before" : "disabled until explicitly started"}.`;
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
    // Exclude the snapshot PowerShell itself. Its -Command text necessarily
    // contains $root, so the wrapper heuristic would otherwise classify the
    // enumerator as Portable-owned and every retry would discover a brand-new
    // powershell.exe that only exists to perform the next snapshot.
    "$owned=@($all | Where-Object {$exe=[string]$_.ExecutablePath;$cmd=[string]$_.CommandLine;$name=([string]$_.Name).ToLowerInvariant();$processId=[int]$_.ProcessId;$processId -ne $PID -and (($exe -and $exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or (($wrappers -contains $name) -and $cmd -and $cmd.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0))})",
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
    DASHBOARD_PUBLIC_PROBE_FILE,
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

function stopLocalServiceOnly(options = {}) {
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  const port = Number(deployment.port || 7676);
  const owned = taskOwnedByRoot(TASK_MCP);
  const wasEnabled = owned && taskEnabled(TASK_MCP);
  if (owned) setOwnedTaskEnabled(TASK_MCP, false);
  endOwnedTask(TASK_MCP);
  stopRecordedProcess(MCP_PID_FILE, "node.exe", port);
  if (!options.leaveDisabled && owned && wasEnabled) setOwnedTaskEnabled(TASK_MCP, true);
  const remaining = recordedProcessStatus(MCP_PID_FILE, "node.exe", port);
  if (remaining.running || remaining.listenerMatch) {
    throw new Error(`Local MCP stop did not fully release 127.0.0.1:${port}.`);
  }
  return `Local MCP service stopped. Public tunnel state was left unchanged.`;
}

function cleanupTunnelRunStateOnly() {
  for (const file of [
    TUNNEL_PID_FILE,
    NGROK_PID_FILE,
    TUNNEL_SUPERVISOR_PID_FILE,
    TUNNEL_NETWORK_STATE_FILE,
    DASHBOARD_PUBLIC_PROBE_FILE,
  ]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

function stopPublicTunnelOnly(options = {}) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  writeAtomic(TUNNEL_STOP_FILE, "stop\n");
  const owned = taskOwnedByRoot(TASK_TUNNEL);
  const wasEnabled = owned && taskEnabled(TASK_TUNNEL);
  if (owned) setOwnedTaskEnabled(TASK_TUNNEL, false);
  endOwnedTask(TASK_TUNNEL);
  stopRecordedTunnelProcess();
  stopRecordedProcess(TUNNEL_SUPERVISOR_PID_FILE, "node.exe");
  cleanupTunnelRunStateOnly();
  if (!options.leaveDisabled && owned && wasEnabled) setOwnedTaskEnabled(TASK_TUNNEL, true);
  return `Public tunnel stopped. Local MCP service was left unchanged.`;
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

function validateLocalStartConfiguration(deployment, config) {
  const configuredPort = Number(config.port || deployment.port || 7676);
  if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
    throw new Error("Saved local port is invalid. Save the configuration again.");
  }
  if (!fs.existsSync(AUTH_FILE) || String(readJson(AUTH_FILE, {}).ownerToken || "").length < 16) {
    throw new Error("Owner Password is missing or invalid. Save the configuration again.");
  }
  return { port: configuredPort };
}

function validateTunnelStartConfiguration(provider, deployment, config) {
  const local = validateLocalStartConfiguration(deployment, config);
  const publicBaseUrl = normalizePublicBaseUrl(config.publicBaseUrl || deployment.publicBaseUrl);
  if (provider === "ngrok" && !existingNgrokToken()) {
    throw new Error("ngrok Authtoken is missing. Save a real token before starting.");
  }
  if (provider === "cloudflare" && !existingCloudflareToken()) {
    throw new Error("Cloudflare Tunnel Token is missing. Save a real token before starting.");
  }
  return { publicBaseUrl, port: local.port };
}

function validateStartConfiguration(provider, deployment, config) {
  return validateTunnelStartConfiguration(provider, deployment, config);
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
  endOwnedTask(TASK_TUNNEL);
  stopRecordedTunnelProcess();
  fs.rmSync(TUNNEL_STOP_FILE, { force: true });
  taskCommand("run", TASK_TUNNEL);
  const last = await waitForCondition(TUNNEL_START_TIMEOUT_MS, async () => {
    const network = readJson(TUNNEL_NETWORK_STATE_FILE, null);
    if (provider === "ngrok") {
      const agent = await ngrokAgentState(publicBaseUrl);
      const publicReady = agent.matchingTunnel ? await publicServiceReady(publicBaseUrl) : false;
      return {
        ready: Boolean(agent.matchingTunnel && publicReady),
        agentReachable: agent.reachable,
        matchingTunnel: agent.matchingTunnel,
        publicReady,
        networkMode: network?.mode || "unknown",
        networkReason: network?.reason || "unknown",
        proxySource: network?.proxySource || "none",
      };
    }
    const childStatus = recordedProcessStatus(TUNNEL_PID_FILE, spec.image);
    const publicReady = childStatus.running && network?.paused !== true
      ? await publicServiceReady(publicBaseUrl)
      : false;
    return {
      ready: Boolean(childStatus.running && network?.paused !== true && publicReady),
      childRunning: childStatus.running,
      publicReady,
      networkMode: network?.mode || "unknown",
      networkReason: network?.reason || "unknown",
    };
  }, 1000);
  if (last.ready) return last;
  const supervisor = recordedProcessStatus(TUNNEL_SUPERVISOR_PID_FILE, "node.exe");
  if (supervisor.running) {
    return {
      ...last,
      deferred: true,
      supervisorPid: supervisor.pid,
      reason: "public-tunnel-recovering-on-current-network-path",
    };
  }
  endOwnedTask(TASK_TUNNEL);
  stopRecordedTunnelProcess();
  const providerHint = provider === "cloudflare"
    ? `Verify that ${publicBaseUrl} routes to http://127.0.0.1:${port}.`
    : "Verify that the configured domain belongs to the same ngrok account as the Authtoken.";
  const logTail = safeLogTail(spec.logFile, 30);
  throw new Error(
    `${provider} could not start its tunnel supervisor for ${publicBaseUrl}.\n` +
    `${providerHint}\nLast readiness: ${JSON.stringify(last)}\n\n` +
    `Recent ${provider} log:\n${logTail || `(no ${provider} log output)`}`,
  );
}

async function startLocalOnly() {
  ensureLocalRuntime();
  seedBundledPlugins();
  if (!taskExists(TASK_MCP)) {
    throw new Error("Portable MCP scheduled task is not installed. Save the configuration and install tasks first.");
  }
  requireOwnedTask(TASK_MCP);
  if (!taskEnabled(TASK_MCP)) setOwnedTaskEnabled(TASK_MCP, true);
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  const config = readJson(CONFIG_FILE, {});
  const expected = validateLocalStartConfiguration(deployment, config);
  if (await localServiceReady(expected.port)) {
    return `Local MCP service is already healthy on 127.0.0.1:${expected.port}. Public tunnel was not touched.`;
  }
  await startLocalService(expected.port);
  return `Local MCP service started successfully on 127.0.0.1:${expected.port}. Public tunnel was not touched.`;
}

async function startTunnelOnly() {
  const provider = selectedTunnelProvider();
  ensureRuntime(provider);
  if (!taskExists(TASK_TUNNEL)) {
    throw new Error("Portable tunnel scheduled task is not installed. Save the configuration and install tasks first.");
  }
  requireOwnedTask(TASK_TUNNEL);
  if (!taskEnabled(TASK_TUNNEL)) setOwnedTaskEnabled(TASK_TUNNEL, true);
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  const config = readJson(CONFIG_FILE, {});
  const expected = validateTunnelStartConfiguration(provider, deployment, config);
  if (!(await localServiceReady(expected.port))) {
    throw new Error(`Local MCP is not healthy on 127.0.0.1:${expected.port}. Start the local MCP service first.`);
  }
  if (provider === "ngrok") {
    const currentAgent = await ngrokAgentState(expected.publicBaseUrl);
    if (currentAgent.matchingTunnel && await publicServiceReady(expected.publicBaseUrl)) {
      return `Public ngrok tunnel is already active. Local MCP was not restarted.`;
    }
  } else {
    const current = recordedProcessStatus(TUNNEL_PID_FILE, tunnelProcessSpec(provider).image);
    if (current.running && await publicServiceReady(expected.publicBaseUrl)) {
      return `Public ${provider} tunnel is already running. Local MCP was not restarted.`;
    }
  }
  const started = await startPublicTunnel(provider, expected.publicBaseUrl, expected.port);
  if (started?.deferred) {
    return `Public ${provider} tunnel supervisor started and will recover on the current Windows network path. Local MCP remained online.`;
  }
  return `Public ${provider} tunnel started without restarting the local MCP service.`;
}

async function startServices() {
  const provider = selectedTunnelProvider();
  ensureLocalRuntime();
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
  if (!taskEnabled(TASK_MCP)) setOwnedTaskEnabled(TASK_MCP, true);
  const tunnelEnabled = taskEnabled(TASK_TUNNEL);
  const deployment = readJson(DEPLOYMENT_FILE, { port: 7676 });
  const config = readJson(CONFIG_FILE, {});
  const localExpected = validateLocalStartConfiguration(deployment, config);
  const existingLocal = await localServiceReady(localExpected.port);
  if (!tunnelEnabled) {
    if (!existingLocal) await startLocalService(localExpected.port);
    return `Portable DevSpace local MCP is healthy. Public ${provider} tunnel remains disabled by user/task state and was not started.\nOwner Password file (auth.json): ${AUTH_FILE}`;
  }
  ensureRuntime(provider);
  const expected = validateTunnelStartConfiguration(provider, deployment, config);
  const existingTunnelProcess = provider === "ngrok"
    ? (await ngrokAgentState(expected.publicBaseUrl)).matchingTunnel
    : recordedProcessStatus(TUNNEL_PID_FILE, tunnelProcessSpec(provider).image).running;
  const existingTunnel = Boolean(existingTunnelProcess && await publicServiceReady(expected.publicBaseUrl));
  if (existingLocal && existingTunnel) {
    return `Portable DevSpace and ${provider} are already healthy; no restart was required.\nOwner Password file (auth.json): ${AUTH_FILE}`;
  }
  try {
    if (!existingLocal) await startLocalService(localExpected.port);
    const tunnelStart = existingTunnel ? { ready: true } : await startPublicTunnel(provider, expected.publicBaseUrl, expected.port);
    if (tunnelStart?.deferred) {
      return `Portable DevSpace local MCP started successfully. Public ${provider} tunnel remains enabled and will retry through the current Windows network path. If the active VPN, firewall, or network policy blocks ${provider}, allow that provider or configure an independent outbound proxy.\n` +
        `Owner Password file (auth.json): ${AUTH_FILE}`;
    }
    return `Portable DevSpace local MCP and ${provider} tunnel started successfully; local OAuth endpoints are healthy and the tunnel agent is active.\n` +
      `Owner Password file (auth.json): ${AUTH_FILE}`;
  } catch (error) {
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

function localProxyHealthy(proxyUrl) {
  if (!proxyUrl) return false;
  let parsed;
  try { parsed = new URL(proxyUrl); } catch { return false; }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return true;
  const port = Number(parsed.port || 0);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const result = runProgram("netstat.exe", ["-ano", "-p", "TCP"], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (result.status !== 0) return false;
  const escaped = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]|\\[::1\\]|::):${escaped}\\s+\\S+\\s+LISTENING`, "i").test(String(result.output || ""));
}

function windowsInternetProxyState() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const query = runProgram("reg.exe", ["query", key], { ignoreExitCode: true, outputEncoding: "utf-8" });
  const text = String(query.output || "");
  const enableMatch = text.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  const serverMatch = text.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  const enabled = Boolean(enableMatch && Number.parseInt(enableMatch[1], 16) !== 0);
  const rawServer = serverMatch ? serverMatch[1].trim() : "";
  let candidate = "";
  if (rawServer && !rawServer.includes("=") && !rawServer.includes(";")) {
    candidate = normalizeOutboundProxyUrl(rawServer);
  } else if (rawServer) {
    const entries = new Map();
    for (const item of rawServer.split(";")) {
      const [rawKey, ...rest] = item.split("=");
      if (!rawKey || !rest.length) continue;
      entries.set(rawKey.trim().toLowerCase(), rest.join("=").trim());
    }
    for (const protocol of ["https", "http", "socks", "socks5"]) {
      if (!entries.has(protocol)) continue;
      candidate = normalizeOutboundProxyUrl(`${protocol.startsWith("socks") ? "socks5" : "http"}://${entries.get(protocol)}`);
      if (candidate) break;
    }
  }
  let loopback = false;
  let localHealthy = true;
  let host = "";
  let port = 0;
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      port = Number(parsed.port || 0);
      loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
      localHealthy = !loopback || localProxyHealthy(candidate);
    } catch {}
  }
  return {
    enabled,
    rawServer,
    candidate,
    loopback,
    localHealthy,
    staleLoopback: Boolean(enabled && candidate && loopback && !localHealthy),
    host,
    port,
    source: "wininet-read-only",
  };
}

function notifyInternetSettingsChanged() {
  const script = [
    "$sig='[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'",
    "$t=Add-Type -MemberDefinition $sig -Name NativeInternetSettings -Namespace DevSpacePortable -PassThru",
    "$null=$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)",
    "$null=$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)",
  ].join(";");
  runProgram(POWERSHELL_EXE, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { ignoreExitCode: true });
}

function repairStaleLoopbackSystemProxy() {
  const state = windowsInternetProxyState();
  if (!state.staleLoopback) {
    throw new Error("Windows system proxy is not an enabled stale loopback proxy. No setting was changed.");
  }
  if (fs.existsSync(PROXY_REPAIR_BACKUP_FILE)) {
    throw new Error(`A previous system-proxy repair backup already exists: ${PROXY_REPAIR_BACKUP_FILE}. Restore it before creating another repair.`);
  }
  writeJson(PROXY_REPAIR_BACKUP_FILE, {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    proxyEnable: state.enabled ? 1 : 0,
    proxyServer: state.rawServer,
  });
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const result = runProgram("reg.exe", ["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (result.status !== 0) {
    try { fs.rmSync(PROXY_REPAIR_BACKUP_FILE, { force: true }); } catch {}
    throw new Error(`Failed to disable stale Windows system proxy: ${result.output || `exit ${result.status}`}`);
  }
  notifyInternetSettingsChanged();
  const after = windowsInternetProxyState();
  if (after.enabled) throw new Error("Windows system proxy still reports enabled after repair. The backup was preserved for manual recovery.");
  return {
    repaired: true,
    previousProxyServer: state.rawServer,
    backupFile: PROXY_REPAIR_BACKUP_FILE,
    message: "Disabled an enabled loopback Windows system proxy whose local listener was unavailable. No VPN, route, adapter, or third-party process was modified.",
  };
}

function restoreSystemProxyRepair() {
  const backup = readJson(PROXY_REPAIR_BACKUP_FILE, null);
  if (!backup || backup.formatVersion !== 1) throw new Error("No DevSpace system-proxy repair backup exists.");
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const server = String(backup.proxyServer || "");
  if (server) {
    const serverResult = runProgram("reg.exe", ["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", server, "/f"], { ignoreExitCode: true, outputEncoding: "utf-8" });
    if (serverResult.status !== 0) throw new Error(`Failed to restore ProxyServer: ${serverResult.output || `exit ${serverResult.status}`}`);
  }
  const enableResult = runProgram("reg.exe", ["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", String(Number(backup.proxyEnable || 0)), "/f"], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (enableResult.status !== 0) throw new Error(`Failed to restore ProxyEnable: ${enableResult.output || `exit ${enableResult.status}`}`);
  notifyInternetSettingsChanged();
  fs.rmSync(PROXY_REPAIR_BACKUP_FILE, { force: true });
  return {
    restored: true,
    message: "Restored the Windows system proxy settings saved by the previous DevSpace repair action.",
  };
}

function outboundProbeCandidates() {
  const tunnelNetwork = currentTunnelNetworkState();
  const configured = existingNgrokNetworkOptions().proxyUrl;
  if (configured) {
    return [{ url: normalizeOutboundProxyUrl(configured), source: "ngrok-config" }];
  }
  const explicitProxy = normalizeOutboundProxyUrl(tunnelNetwork?.proxyUrl);
  if (explicitProxy) {
    return [{ url: explicitProxy, source: String(tunnelNetwork?.proxySource || "tunnel-network") }];
  }
  if (tunnelNetwork) {
    // Dashboard verification follows the exact egress selected by the tunnel
    // supervisor. It never hops between an explicit proxy and the system path.
    return [{ url: "", source: "system-routed" }];
  }
  return [{ url: "", source: "direct" }];
}

function publicProbeSuppressionState(state = currentTunnelNetworkState()) {
  const updatedAtMs = Date.parse(String(state?.updatedAt || ""));
  const fresh = Boolean(process.env.DEVSPACE_TEST_TUNNEL_NETWORK_STATE)
    || (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= 0 && Date.now() - updatedAtMs < 30_000);
  const settling = String(state?.transition || "") === "network-path-quiescing"
    || String(state?.reason || "") === "network-path-settling";
  return {
    suppressed: fresh && settling && state?.publicProbesSuppressed === true,
    reason: "network path is settling; public probes are temporarily suppressed",
  };
}

function parseCurlProbeResult(stdout, stderr, status, candidate) {
  const marker = stdout.match(/__DEVSPACE_HTTP__(\d{3})\|([^\r\n]*)/);
  if (status !== 0 || !marker) {
    return {
      status: 0,
      error: stderr || `curl exit ${status ?? "unknown"}`,
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

function curlProbe(url, timeoutMs, candidate) {
  if (process.env.DEVSPACE_TEST_CURL_UNAVAILABLE === "1" || !fs.existsSync(CURL_EXE)) return null;
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
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let suppressed = false;
    let timer = null;
    let suppressionTimer = null;
    const finish = (status, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(suppressionTimer);
      if (suppressed) {
        const gate = publicProbeSuppressionState();
        resolve({
          status: 0,
          error: gate.reason,
          contentType: "",
          server: "",
          ngrokErrorCode: "",
          transport: "suppressed",
        });
        return;
      }
      const errorText = timedOut
        ? `curl exceeded ${timeoutMs + 1_500} ms`
        : [stderr.trim(), error].filter(Boolean).join("; ");
      resolve(parseCurlProbeResult(stdout, errorText, status, candidate));
    };
    let child;
    try {
      child = childProcess.spawn(CURL_EXE, args, {
        cwd: ROOT,
        windowsHide: true,
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
    } catch (error) {
      resolve(parseCurlProbeResult("", error?.message || String(error), null, candidate));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 2 * 1024 * 1024) stderr += chunk; });
    child.once("error", (error) => finish(null, error?.message || String(error)));
    child.once("close", (code) => finish(code));
    suppressionTimer = setInterval(() => {
      if (!publicProbeSuppressionState().suppressed) return;
      suppressed = true;
      try { child.kill(); } catch {}
    }, 250);
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs + 1_500);
  });
}

function loopbackProbe(parsed, timeoutMs) {
  return new Promise((resolve) => {
    const result = (status, error = "", headers = {}) => resolve({
      status,
      error,
      contentType: headers["content-type"] || "",
      server: headers.server || "",
      ngrokErrorCode: headers["ngrok-error-code"] || "",
      transport: "loopback",
    });
    if (parsed.protocol !== "http:") {
      result(0, `unsupported loopback protocol: ${parsed.protocol}`);
      return;
    }
    const request = http.request({
      protocol: "http:",
      hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      agent: false,
      headers: { Connection: "close", "User-Agent": `DevSpace-Portable/${PORTABLE_VERSION}` },
    }, (response) => {
      const headers = response.headers || {};
      response.resume();
      result(Number(response.statusCode || 0), "", headers);
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("loopback request timed out"), { code: "ETIMEDOUT" })));
    request.once("error", (error) => result(0, `${error?.code || "HTTP_ERROR"}: ${error?.message || error}`));
    request.end();
  });
}

async function probeUrl(url, timeoutMs = 20000) {
  let parsed;
  try { parsed = new URL(url); } catch { return { status: 0, error: "invalid URL", contentType: "", server: "", ngrokErrorCode: "", transport: "none" }; }
  const local = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname.toLowerCase());
  if (local) {
    return loopbackProbe(parsed, timeoutMs);
  }
  const probeGate = publicProbeSuppressionState();
  if (probeGate.suppressed) {
    return {
      status: 0,
      error: probeGate.reason,
      contentType: "",
      server: "",
      ngrokErrorCode: "",
      transport: "suppressed",
    };
  }
  const errors = [];
  let curlAvailable = false;
  const candidates = outboundProbeCandidates();
  for (const candidate of candidates) {
    const pending = curlProbe(url, timeoutMs, candidate);
    if (pending) curlAvailable = true;
    const result = pending ? await pending : null;
    if (!result) break;
    if (result.status > 0) return result;
    if (result.transport === "suppressed") return result;
    errors.push(`${candidate.source}: ${result.error}`);
  }
  if (curlAvailable) {
    return { status: 0, error: errors.join("; "), contentType: "", server: "", ngrokErrorCode: "", transport: "failed" };
  }
  const explicitProxy = candidates.find((candidate) => candidate?.url);
  if (explicitProxy) {
    return {
      status: 0,
      error: `${explicitProxy.source}: bundled curl unavailable; explicit proxy path was not bypassed`,
      contentType: "",
      server: "",
      ngrokErrorCode: "",
      transport: "failed",
    };
  }
  const controller = new AbortController();
  let fetchSuppressed = false;
  const fetchTimeout = setTimeout(() => controller.abort(), timeoutMs);
  const suppressionTimer = setInterval(() => {
    if (!publicProbeSuppressionState().suppressed) return;
    fetchSuppressed = true;
    controller.abort();
  }, 250);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
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
    if (fetchSuppressed) {
      const gate = publicProbeSuppressionState();
      return { status: 0, error: gate.reason, contentType: "", server: "", ngrokErrorCode: "", transport: "suppressed" };
    }
    const cause = error?.cause;
    const code = cause?.code || error?.code || error?.name || "FETCH_ERROR";
    const message = cause?.message || error?.message || String(error);
    errors.push(`node-direct: ${code}: ${message}`);
    return { status: 0, error: errors.join("; "), contentType: "", server: "", ngrokErrorCode: "", transport: "failed" };
  } finally {
    clearTimeout(fetchTimeout);
    clearInterval(suppressionTimer);
  }
}

function dashboardPublicProbeFingerprint(publicUrl, provider, tunnel, tunnelSupervisor, tunnelNetwork) {
  return JSON.stringify({
    portableVersion: PORTABLE_VERSION,
    publicUrl,
    provider,
    tunnelPid: tunnel?.pid || null,
    supervisorPid: tunnelSupervisor?.pid || null,
    mode: tunnelNetwork?.mode || "unknown",
    proxyUrl: tunnelNetwork?.proxyUrl || "",
    status: tunnelNetwork?.status || "unknown",
    transition: tunnelNetwork?.transition || "unknown",
    appliedPathSignature: tunnelNetwork?.appliedPathSignature || "",
    reconnectCount: Number(tunnelNetwork?.reconnectCount || 0),
  });
}

async function dashboardPublicProbes(publicUrl, fingerprint, options = {}) {
  const empty = { status: 0, error: "public URL not configured", contentType: "", server: "", ngrokErrorCode: "", transport: "none" };
  if (!publicUrl) return { metadata: empty, mcp: empty, checkedAt: null, cached: false, ageMs: 0 };
  if (options.suppress === true) {
    const suppressed = {
      status: 0,
      error: String(options.reason || "network path is settling"),
      contentType: "",
      server: "",
      ngrokErrorCode: "",
      transport: "suppressed",
    };
    return { metadata: suppressed, mcp: suppressed, checkedAt: null, cached: false, suppressed: true, ageMs: 0 };
  }
  const now = Date.now();
  const cached = readJson(DASHBOARD_PUBLIC_PROBE_FILE, null);
  const checkedAtMs = Date.parse(String(cached?.checkedAt || ""));
  const cachedSuccess = cached?.metadata?.status === 200 && cached?.mcp?.status === 401;
  const cacheTtlMs = cachedSuccess
    ? DASHBOARD_PUBLIC_PROBE_SUCCESS_TTL_MS
    : DASHBOARD_PUBLIC_PROBE_FAILURE_TTL_MS;
  if (cached?.formatVersion === 1
      && cached.fingerprint === fingerprint
      && Number.isFinite(checkedAtMs)
      && now - checkedAtMs >= 0
      && now - checkedAtMs < cacheTtlMs
      && cached.metadata
      && cached.mcp) {
    return { metadata: cached.metadata, mcp: cached.mcp, checkedAt: cached.checkedAt, cached: true, ageMs: now - checkedAtMs };
  }
  const [metadata, mcp] = await Promise.all([
    probeUrl(`${publicUrl}/.well-known/oauth-protected-resource/mcp`, 4500),
    probeUrl(`${publicUrl}/mcp`, 4500),
  ]);
  const checkedAt = new Date().toISOString();
  const suppressed = metadata.transport === "suppressed" || mcp.transport === "suppressed";
  if (!suppressed) writeJson(DASHBOARD_PUBLIC_PROBE_FILE, { formatVersion: 1, fingerprint, checkedAt, metadata, mcp });
  return { metadata, mcp, checkedAt, cached: false, suppressed, ageMs: 0 };
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

function normalizeOwnedPath(value) {
  if (!value) return "";
  try {
    return path.resolve(String(value)).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  }
}

function runningNgrokProcesses() {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=(New-Object System.Text.UTF8Encoding($false))",
    "$OutputEncoding=[Console]::OutputEncoding",
    "$items=@(Get-CimInstance Win32_Process -Filter \"Name='ngrok.exe'\" | Select-Object ProcessId,Name,ExecutablePath,CommandLine)",
    "$items | ConvertTo-Json -Compress",
  ].join(";");
  const result = childProcess.spawnSync(POWERSHELL_EXE, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 6_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return [];
  const text = String(result.stdout || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.ProcessId),
      name: String(item.Name || ""),
      executablePath: String(item.ExecutablePath || ""),
      commandLine: String(item.CommandLine || ""),
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch {
    return [];
  }
}

function verifiedOwnedNgrokProcesses() {
  const expectedExecutable = normalizeOwnedPath(NGROK_EXE);
  const expectedConfig = normalizeOwnedPath(NGROK_CONFIG);
  const recordedPids = new Set([
    readRecordedPid(TUNNEL_PID_FILE),
    readRecordedPid(NGROK_PID_FILE),
  ].filter((pid) => Number.isInteger(pid) && pid > 0));
  return runningNgrokProcesses().filter((item) => {
    if (item.name.toLowerCase() !== "ngrok.exe") return false;
    if (normalizeOwnedPath(item.executablePath) !== expectedExecutable) return false;
    const commandLine = String(item.commandLine || "").replace(/\\/g, "/").toLowerCase();
    const configOwned = expectedConfig && commandLine.includes(expectedConfig);
    return recordedPids.has(item.pid) || configOwned;
  });
}

function ownedLoopbackListenerPorts(processes) {
  const allowedPids = new Set(processes.map((item) => item.pid));
  if (!allowedPids.size) return [];
  const result = runProgram("netstat.exe", ["-ano", "-p", "TCP"], { ignoreExitCode: true, outputEncoding: "utf-8" });
  if (result.status !== 0) return [];
  const ports = new Set();
  for (const line of String(result.output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const pid = Number(match[2]);
    if (!allowedPids.has(pid)) continue;
    const endpoint = match[1];
    let host = "";
    let rawPort = "";
    if (endpoint.startsWith("[")) {
      const closing = endpoint.lastIndexOf("]:");
      if (closing < 0) continue;
      host = endpoint.slice(1, closing).toLowerCase();
      rawPort = endpoint.slice(closing + 2);
    } else {
      const separator = endpoint.lastIndexOf(":");
      if (separator < 0) continue;
      host = endpoint.slice(0, separator).toLowerCase();
      rawPort = endpoint.slice(separator + 1);
    }
    if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host)) continue;
    const port = Number(rawPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

async function ngrokAgentState(expectedPublicUrl) {
  const tunnels = [];
  const apiPorts = [];
  const errors = [];
  const ownedProcesses = verifiedOwnedNgrokProcesses();
  const candidatePorts = ownedLoopbackListenerPorts(ownedProcesses);
  if (!ownedProcesses.length) {
    return {
      reachable: false,
      matchingTunnel: false,
      tunnels: [],
      apiPorts: [],
      errors: [],
      ownershipVerified: false,
      reason: "no-verified-devspace-ngrok-process",
    };
  }
  if (!candidatePorts.length) {
    return {
      reachable: false,
      matchingTunnel: false,
      tunnels: [],
      apiPorts: [],
      errors: [],
      ownershipVerified: true,
      ownedPids: ownedProcesses.map((item) => item.pid),
      reason: "verified-ngrok-has-no-loopback-listener",
    };
  }
  const observations = await Promise.all(candidatePorts.map(async (port) => {
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
    ownershipVerified: true,
    ownedPids: ownedProcesses.map((item) => item.pid),
    reason: apiPorts.length ? null : "verified-ngrok-agent-api-unreachable",
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
  const tunnelNetwork = currentTunnelNetworkState();
  const publicUrl = String(config.publicBaseUrl || "").replace(/\/$/, "");
  const publicProbeCache = readJson(DASHBOARD_PUBLIC_PROBE_FILE, null);
  const publicProbe = publicProbeCache?.metadata || {
    status: 0,
    error: "not actively probed by background status",
    transport: "passive",
  };
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
    `Last explicit public OAuth metadata: ${formatProbe(publicProbe)}`;
  if (provider === "ngrok") {
    const agent = await ngrokAgentState(publicUrl);
    tunnelDetails +=
      `\nAgent API: ${agent.reachable ? `verified DevSpace-owned listener on ${agent.apiPorts.join(", ")}` : `unavailable (${agent.reason || "no verified owned listener"})`}` +
      `\nConfigured public tunnel active: ${agent.matchingTunnel ? "yes" : "no"}` +
      `\nObserved tunnels: ${agent.tunnels.length ? agent.tunnels.map((item) => `${item.publicUrl} -> ${item.target}`).join("; ") : "none"}`;
  } else {
    tunnelDetails += `\nPinned cloudflared: ${CLOUDFLARED_VERSION}`;
  }
  if (tunnelNetwork) {
    tunnelDetails +=
      `\nNetwork policy: ${tunnelNetwork.policy || "non-invasive"}` +
      `\nNetwork compatibility: ${tunnelNetwork.compatibility === false ? "disabled" : "enabled"}` +
      `\nNetwork mode: ${tunnelNetwork.mode || "unknown"}` +
      `\nNetwork reason: ${tunnelNetwork.reason || "unknown"}` +
      `\nProxy source: ${tunnelNetwork.proxySource || "none"}` +
      `\nEgress policy: ${tunnelNetwork.egressPolicy || "system-route"}` +
      `\nCross-path fallback: ${tunnelNetwork.proxyUrl ? "disabled" : "not applicable (system-routed)"}` +
      `\nNetwork path source: ${tunnelNetwork.pathSource || "unknown"}` +
      `\nNetwork path signature: ${tunnelNetwork.pathSignature || "unavailable"}` +
      `\nApplied path signature: ${tunnelNetwork.appliedPathSignature || "unavailable"}` +
      `\nPath transition: ${tunnelNetwork.transition || "unknown"}` +
      `\nTopology counts (interfaces/addresses/routes): ${Number(tunnelNetwork.connectedInterfaceCount || 0)}/${Number(tunnelNetwork.addressCount || 0)}/${Number(tunnelNetwork.routeCount || 0)}` +
      `\nPublic probes suppressed: ${tunnelNetwork.publicProbesSuppressed === true ? "yes" : "no"}` +
      `\nOwned tunnel reconnects: ${Number(tunnelNetwork.reconnectCount || 0)}` +
      `\nTunnel supervisor PID: ${tunnelNetwork.supervisorPid || "none"}`;
  }
  const networkPath = networkPathState();
  const internetProxy = windowsInternetProxyState();
  tunnelDetails +=
    `\nActive IPv4 default routes: ${networkPath.defaultRouteCount}` +
    `\nRoute interfaces: ${networkPath.routes.length ? networkPath.routes.map((route) => `${route.interfaceAlias || route.ifIndex} (metric ${route.routeMetric + route.interfaceMetric})`).join(", ") : "unavailable"}` +
    `\nWindows system proxy: ${internetProxy.enabled ? internetProxy.rawServer || "enabled" : "disabled"}` +
    `\nStale loopback proxy: ${internetProxy.staleLoopback ? `yes (${internetProxy.host}:${internetProxy.port} is not listening)` : "no"}` +
    `\nVendor or process detection: none` +
    `\nThird-party mutation: never`;
  lines.push(tunnelDetails);
  const allListeners = listenerPids(port);
  lines.push(`=== TCP :${port} ===\nListener PIDs: ${allListeners.length ? allListeners.join(", ") : "none"}`);
  return lines.join("\n\n");
}

function cachedDashboardPublicProbes(publicUrl, fingerprint) {
  const empty = {
    status: 0,
    error: "not actively probed by homepage",
    contentType: "",
    server: "",
    ngrokErrorCode: "",
    transport: "passive",
  };
  if (!publicUrl) return { metadata: empty, mcp: empty, checkedAt: null, cached: false, passive: true, ageMs: 0 };
  const cached = readJson(DASHBOARD_PUBLIC_PROBE_FILE, null);
  if (cached?.formatVersion !== 1 || cached.fingerprint !== fingerprint || !cached.metadata || !cached.mcp) {
    return { metadata: empty, mcp: empty, checkedAt: null, cached: false, passive: true, ageMs: 0 };
  }
  const checkedAtMs = Date.parse(String(cached.checkedAt || ""));
  return {
    metadata: cached.metadata,
    mcp: cached.mcp,
    checkedAt: cached.checkedAt || null,
    cached: true,
    passive: true,
    ageMs: Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : 0,
  };
}

function dashboardIndicator(state, title, detail, extra = {}) {
  return { state, title, detail, ...extra };
}

function currentTunnelNetworkState() {
  if (process.env.DEVSPACE_TEST_TUNNEL_NETWORK_STATE) {
    try { return JSON.parse(process.env.DEVSPACE_TEST_TUNNEL_NETWORK_STATE); } catch {}
  }
  return readJson(TUNNEL_NETWORK_STATE_FILE, null);
}

function networkPathState() {
  if (process.env.DEVSPACE_TEST_NETWORK_PATH) {
    try { return JSON.parse(process.env.DEVSPACE_TEST_NETWORK_PATH); } catch {}
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=(New-Object System.Text.UTF8Encoding($false))",
    "$OutputEncoding=[Console]::OutputEncoding",
    "$interfaces=@(Get-NetIPInterface -AddressFamily IPv4 | Where-Object {$_.ConnectionState -eq 'Connected'})",
    "$connected=@{}",
    "foreach($item in $interfaces){$connected[[int]$item.InterfaceIndex]=$item}",
    "$routes=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore | Where-Object {$connected.ContainsKey([int]$_.ifIndex)} | ForEach-Object {$iface=$connected[[int]$_.ifIndex];[pscustomobject]@{ifIndex=[int]$_.ifIndex;interfaceAlias=[string]$_.InterfaceAlias;nextHop=[string]$_.NextHop;routeMetric=[int]$_.RouteMetric;interfaceMetric=[int]$iface.InterfaceMetric}})",
    "$ordered=@($routes | Sort-Object routeMetric,interfaceMetric,ifIndex,nextHop)",
    "[pscustomobject]@{defaultRouteCount=$ordered.Count;multipleDefaultRoutes=($ordered.Count -gt 1);routes=$ordered;source='read-only-active-default-routes'} | ConvertTo-Json -Compress -Depth 4",
  ].join(";");
  const result = childProcess.spawnSync(POWERSHELL_EXE, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 6_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return { defaultRouteCount: 0, multipleDefaultRoutes: false, routes: [], source: "unavailable" };
  try {
    const parsed = JSON.parse(String(result.stdout || "{}").trim() || "{}");
    const values = Array.isArray(parsed.routes) ? parsed.routes : parsed.routes ? [parsed.routes] : [];
    const routes = values.map((route) => ({
      ifIndex: Number(route.ifIndex || 0),
      interfaceAlias: String(route.interfaceAlias || ""),
      nextHop: String(route.nextHop || ""),
      routeMetric: Number(route.routeMetric || 0),
      interfaceMetric: Number(route.interfaceMetric || 0),
    }));
    return {
      defaultRouteCount: Number(parsed.defaultRouteCount ?? routes.length),
      multipleDefaultRoutes: Boolean(parsed.multipleDefaultRoutes ?? routes.length > 1),
      routes,
      source: String(parsed.source || "read-only-active-default-routes"),
    };
  } catch {
    return { defaultRouteCount: 0, multipleDefaultRoutes: false, routes: [], source: "unreadable" };
  }
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
  const tunnelSupervisor = recordedProcessStatus(TUNNEL_SUPERVISOR_PID_FILE, "node.exe");
  const tunnelNetwork = currentTunnelNetworkState();
  const networkPath = networkPathState();
  const internetProxy = windowsInternetProxyState();
  const publicProbeGate = publicProbeSuppressionState(tunnelNetwork);
  const networkPathQuiescing = publicProbeGate.suppressed;
  const publicFingerprint = dashboardPublicProbeFingerprint(publicUrl, provider, tunnel, tunnelSupervisor, tunnelNetwork);
  const [localResults, agent] = await Promise.all([
    Promise.all([
      probeUrl(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, 2500),
      probeUrl(`http://127.0.0.1:${port}/mcp`, 2500),
    ]),
    provider === "ngrok" ? ngrokAgentState(publicUrl) : Promise.resolve({ reachable: false, matchingTunnel: false, tunnels: [], apiPorts: [], errors: [] }),
  ]);
  const [localMetadata, localMcp] = localResults;
  const publicResults = cachedDashboardPublicProbes(publicUrl, publicFingerprint);
  const { metadata: publicMetadata, mcp: publicMcp } = publicResults;

  const mcpTaskInstalled = taskExists(TASK_MCP);
  const mcpTaskEnabled = mcpTaskInstalled && taskEnabled(TASK_MCP);
  const tunnelTaskInstalled = taskExists(TASK_TUNNEL);
  const tunnelTaskEnabled = tunnelTaskInstalled && taskEnabled(TASK_TUNNEL);
  const tunnelIntentionallyOff = tunnelTaskInstalled && !tunnelTaskEnabled && !tunnel.running && !tunnelSupervisor.running;
  const serviceReady = mcp.running && mcp.listenerMatch && localMetadata.status === 200 && localMcp.status === 401;
  const tunnelReady = tunnel.running && (provider !== "ngrok" || agent.matchingTunnel);
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

  const localProbeUncertain = mcp.running && mcp.listenerMatch
    && (localMetadata.status === 0 || localMcp.status === 0);
  const serviceState = serviceReady ? (mcpTaskEnabled ? "ready" : "warning") : (mcp.running ? "warning" : "stopped");
  const serviceTitle = serviceReady
    ? (mcpTaskEnabled ? "服务已就绪" : "服务已运行，计划任务未启用")
    : localProbeUncertain ? "服务正在复核" : (mcp.running ? "服务正在恢复" : "服务未运行");
  const proxyUnavailable = tunnelNetwork?.paused === true
    && String(tunnelNetwork?.reason || "") === "explicit-local-proxy-unavailable";
  const tunnelState = tunnelIntentionallyOff
    ? "idle"
    : proxyUnavailable || networkPathQuiescing ? "warning" : tunnelReady ? (tunnelTaskEnabled ? "ready" : "warning") : (tunnel.running || tunnelSupervisor.running ? "warning" : "stopped");
  const tunnelTitle = tunnelIntentionallyOff
    ? "公网隧道已按需关闭"
    : proxyUnavailable
    ? "公网隧道正在等待显式代理"
    : networkPathQuiescing
      ? "网络路径变化，公网隧道短暂静默"
      : tunnelReady ? (tunnelTaskEnabled ? "公网隧道已就绪" : "隧道已运行，计划任务未启用") : (tunnel.running || tunnelSupervisor.running ? "公网隧道正在恢复" : "公网隧道未运行");
  const localHttpReady = localMetadata.status === 200 && localMcp.status === 401;
  const cachedPublicVerified = publicMetadata.status === 200 && publicMcp.status === 401;
  const httpState = localHttpReady ? (tunnelReady || tunnelIntentionallyOff || networkPathQuiescing ? "ready" : "warning") : localProbeUncertain ? "warning" : "error";
  const httpTitle = localHttpReady
    ? (cachedPublicVerified ? "HTTP / OAuth 正常，公网曾验证" : "本地 HTTP / OAuth 正常")
    : localProbeUncertain ? "本地 HTTP 正在复核" : "本地 HTTP 验证异常";
  const networkMode = String(tunnelNetwork?.mode || "unknown");
  const networkSource = String(tunnelNetwork?.proxySource || "none");
  const publicPathBlocked = serviceReady && (tunnel.running || tunnelSupervisor.running) && !tunnelReady && !networkPathQuiescing;
  const routeStateAvailable = networkPath.defaultRouteCount > 0
    && !["unavailable", "unreadable"].includes(String(networkPath.source || ""));
  const networkState = internetProxy.staleLoopback || proxyUnavailable || networkPathQuiescing || publicPathBlocked
    ? "warning"
    : tunnelIntentionallyOff || tunnelNetwork || routeStateAvailable ? "ready" : "warning";
  const networkTitle = internetProxy.staleLoopback
    ? "检测到失效的本地系统代理"
    : proxyUnavailable
    ? "显式出站代理不可用"
    : networkPathQuiescing
      ? "检测到网络路径变化，正在等待稳定"
      : publicPathBlocked
        ? "公网隧道不可达，可能受当前网络策略限制"
        : tunnelIntentionallyOff ? "网络隔离状态正常" : tunnelNetwork ? "网络路径自适应正常" : routeStateAvailable ? "网络路径已读取，等待隧道运行" : "正在读取网络路径状态";
  const routeDetail = networkPath.multipleDefaultRoutes
    ? `检测到 ${networkPath.defaultRouteCount} 条活动默认路由；按 Windows 当前选路运行，不按软件名称干预`
    : `活动默认路由=${networkPath.defaultRouteCount}`;
  const networkDetail = internetProxy.staleLoopback
    ? `Windows 系统代理仍指向 ${internetProxy.host}:${internetProxy.port}，但该端口没有监听；关闭代理程序后，依赖系统代理的登录页可能无法联网。可在“详细信息”中显式修复并保留回滚备份。`
    : proxyUnavailable
    ? `ngrok 显式代理当前不可用；不会自动改走系统或 VPN 路径`
    : networkPathQuiescing
      ? `公网探测与 DevSpace 自有隧道已暂停，本地 MCP 保持运行；网络拓扑连续稳定 15 秒后恢复 · ${routeDetail}`
      : publicPathBlocked
        ? `当前 VPN、TUN、防火墙或企业网络策略可能阻止 ${provider}；请允许该服务，或为 ngrok 配置独立出站代理`
        : tunnelIntentionallyOff
          ? `公网隧道当前按需关闭；本地 MCP 独立运行，不产生 tunnel 公网连接 · ${routeDetail}`
        : !tunnelNetwork && routeStateAvailable
          ? `只读网络路径已就绪；启动公网隧道后将监测网卡、地址与路由变化并仅管理自有子进程 · ${routeDetail}`
          : `非侵入式自适应 · mode=${networkMode} · proxy=${networkSource} · ${routeDetail}`;

  const indicators = {
    service: dashboardIndicator(
      serviceState,
      serviceTitle,
      serviceReady ? `MCP 监听 127.0.0.1:${port} · PID ${mcp.pid ?? "-"}` : localProbeUncertain ? `监听=yes · 本地 HTTP 正在复核` : `监听=${mcp.listenerMatch ? "yes" : "no"} · 本地 OAuth=${localMetadata.status || 0}`,
      { pid: mcp.pid, listener: mcp.listenerMatch, taskInstalled: mcpTaskInstalled, taskEnabled: mcpTaskEnabled },
    ),
    tunnel: dashboardIndicator(
      tunnelState,
      tunnelTitle,
      tunnelIntentionallyOff
        ? `${provider} · 已禁用自动启动 · 本地 MCP 不受影响`
        : tunnelReady ? `${provider} · tunnel agent active · PID ${tunnel.pid ?? "-"}` : `${provider} · 子进程=${tunnel.running ? "running" : "stopped"} · supervisor=${tunnelSupervisor.running ? tunnelSupervisor.pid : "stopped"}`,
      { pid: tunnel.pid, supervisorPid: tunnelSupervisor.pid, taskInstalled: tunnelTaskInstalled, taskEnabled: tunnelTaskEnabled, provider },
    ),
    http: dashboardIndicator(
      httpState,
      httpTitle,
      cachedPublicVerified
        ? `本地 ${localMetadata.status}/${localMcp.status} · 最近主动公网验证 ${publicMetadata.status}/${publicMcp.status} · ${Math.ceil(publicResults.ageMs / 1000)}s 前`
        : `本地 ${localMetadata.status}/${localMcp.status} · 主页不主动访问公网；需要时在“详细信息”执行公网验证`,
      { localMetadata, localMcp, publicMetadata, publicMcp, publicVerification: { checkedAt: publicResults.checkedAt, cached: publicResults.cached, passive: true, ageMs: publicResults.ageMs } },
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
      networkDetail,
      {
        mode: networkMode,
        proxySource: networkSource,
        egressPolicy: tunnelNetwork?.egressPolicy || "system-route",
        crossPathFallback: tunnelNetwork?.crossPathFallback === false ? "disabled" : "not-applicable",
        policy: tunnelNetwork?.policy || "non-invasive",
        reason: tunnelNetwork?.reason || "unknown",
        transition: tunnelNetwork?.transition || "unknown",
        reconnectCount: Number(tunnelNetwork?.reconnectCount || 0),
        networkPath,
        internetProxy,
      },
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
      overallState === "ready"
        ? (tunnelIntentionallyOff
            ? "本地 MCP、HTTP/OAuth 与核心文件均正常；公网隧道按需关闭，不产生额外公网连接。"
            : "本地 MCP、公网隧道、HTTP/OAuth 与核心文件均通过轻量检查。")
        : "打开“详细信息”查看验证、隧道、文件和日志。",
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
    } else if (command === "start-local") {
      writeOutput(`${await startLocalOnly()}\n`);
    } else if (command === "start-tunnel") {
      writeOutput(`${await startTunnelOnly()}\n`);
    } else if (command === "stop") {
      writeOutput(stopServices() + "\n");
    } else if (command === "stop-local") {
      writeOutput(stopLocalServiceOnly({ leaveDisabled: true }) + "\n");
    } else if (command === "stop-tunnel") {
      writeOutput(stopPublicTunnelOnly({ leaveDisabled: true }) + "\n");
    } else if (command === "shutdown") {
      writeOutput(shutdownServices() + "\n");
    } else if (command === "restart") {
      stopServices();
      writeOutput(`${await startServices()}\n`);
    } else if (command === "restart-local") {
      stopLocalServiceOnly();
      writeOutput(`${await startLocalOnly()}\n`);
    } else if (command === "restart-tunnel") {
      stopPublicTunnelOnly();
      writeOutput(`${await startTunnelOnly()}\n`);
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
    } else if (command === "network-proxy-state") {
      stdoutJson({ ...windowsInternetProxyState(), repairBackupExists: fs.existsSync(PROXY_REPAIR_BACKUP_FILE), repairBackupFile: PROXY_REPAIR_BACKUP_FILE });
    } else if (command === "repair-stale-proxy") {
      stdoutJson(repairStaleLoopbackSystemProxy());
    } else if (command === "restore-proxy-repair") {
      stdoutJson(restoreSystemProxyRepair());
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
    } else if (command === "plugin-export") {
      stdoutJson(runPluginAdmin("export", await readStdinJson()));
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
    } else if (command === "continuation-list") {
      stdoutJson(await runContinuationAdmin("list", await readStdinJson()));
    } else if (command === "continuation-lock") {
      stdoutJson(await runContinuationAdmin("lock", await readStdinJson()));
    } else if (command === "continuation-unlock") {
      stdoutJson(await runContinuationAdmin("unlock", await readStdinJson()));
    } else if (command === "continuation-pause") {
      stdoutJson(await runContinuationAdmin("pause", await readStdinJson()));
    } else if (command === "continuation-stop") {
      stdoutJson(await runContinuationAdmin("stop", await readStdinJson()));
    } else if (command === "continuation-resume") {
      stdoutJson(await runContinuationAdmin("resume", await readStdinJson()));
    } else if (command === "continuation-delete") {
      stdoutJson(await runContinuationAdmin("delete", await readStdinJson()));
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
    } else if (command === "oauth-client-list") {
      stdoutJson(await runOAuthClientAdmin("list", await readStdinJson()));
    } else if (command === "oauth-client-create") {
      stdoutJson(await runOAuthClientAdmin("create", await readStdinJson()));
    } else if (command === "oauth-client-rotate-secret") {
      stdoutJson(await runOAuthClientAdmin("rotate-secret", await readStdinJson()));
    } else if (command === "oauth-client-delete") {
      stdoutJson(await runOAuthClientAdmin("delete", await readStdinJson()));
    } else if (command === "remote-agent-list") {
      stdoutJson(await runRemoteAgentAdmin("list", await readStdinJson()));
    } else if (command === "remote-agent-create-enrollment") {
      stdoutJson(await runRemoteAgentAdmin("create-enrollment", await readStdinJson()));
    } else if (command === "remote-agent-revoke") {
      stdoutJson(await runRemoteAgentAdmin("revoke", await readStdinJson()));
    } else if (command === "remote-agent-delete") {
      stdoutJson(await runRemoteAgentAdmin("delete", await readStdinJson()));
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
      writeOutput("Commands: configure set-computer-use show-config ui-open ui-heartbeat ui-close ui-status list-drives install-tasks start start-local start-tunnel stop stop-local stop-tunnel shutdown restart restart-local restart-tunnel enable disable uninstall-tasks status dashboard-status network-proxy-state repair-stale-proxy restore-proxy-repair test diagnose verify-files update-check update-stage update-launch install-cloudflared plugin-list plugin-refresh seed-bundled-plugins plugin-install plugin-export plugin-enable plugin-disable plugin-uninstall plugin-slot-bind plugin-slot-unbind review-list review-details review-update review-rollback review-restore-safety memory-list memory-upsert memory-delete oauth-client-list oauth-client-create oauth-client-rotate-secret oauth-client-delete remote-agent-list remote-agent-create-enrollment remote-agent-revoke remote-agent-delete log-paths portable-processes get\n");
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
