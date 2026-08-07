"use strict";

/**
 * DevSpace Portable Console Server
 *
 * 长驻 HTTP API 进程，复用 portable-manager.cjs 的命令函数，避免"每次点按启动一个 node.exe"。
 *
 * 安全边界：
 * - 仅监听 127.0.0.1，不暴露公网（远程访问需通过 MCP server 的隧道反代，留待阶段 4）
 * - 写操作（POST/PUT/DELETE）需携带 X-Console-Lease header，匹配 data/run/ui-session.json 的 leaseId
 * - 读操作（GET）与 UI 租约生命周期操作（/api/ui/open|heartbeat|close）不需要 leaseId
 *
 * 进程归属：
 * - 由 C# 壳（DevSpace-Portable.exe）spawn，生命周期绑定
 * - 启动后写 data/run/console-server.json（pid + port + startedAt）
 * - SIGINT/SIGTERM 时清理该文件
 *
 * 启动：node setup/console-server.cjs [--port 7677]
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const manager = require("./portable-manager.cjs");

const DEFAULT_PORT = 7677;
const HOST = "127.0.0.1";
const LEASE_HEADER = "x-console-lease";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CONSOLE_UI_DIST = path.join(__dirname, "console-ui", "dist");
const CONSOLE_SERVER_STATE_FILE = path.join(manager.RUN_DIR, "console-server.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/**
 * 已知写操作路径集合。仅这些路径会触发 leaseId 校验。
 * 未匹配路径直接 404，避免"先 auth 后 404"导致 401 泄露路径存在性。
 */
const WRITE_PATHS = new Set([
  "/api/configure",
  "/api/computer-use",
  "/api/services/install-tasks",
  "/api/services/uninstall-tasks",
  "/api/services/start",
  "/api/services/stop",
  "/api/services/restart",
  "/api/services/enable",
  "/api/services/disable",
  "/api/cloudflared/install",
  "/api/plugins/refresh",
  "/api/plugins/install",
  "/api/plugins/enable",
  "/api/plugins/disable",
  "/api/plugins/uninstall",
  "/api/plugins/slot-bind",
  "/api/plugins/slot-unbind",
  "/api/sessions/details",
  "/api/sessions/update",
  "/api/sessions/rollback",
  "/api/sessions/restore-safety",
  "/api/memories/upsert",
  "/api/memories/delete",
  "/api/update/stage",
  "/api/update/launch",
]);

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      args.port = parseInt(argv[++i], 10);
    } else if (a.startsWith("--port=")) {
      args.port = parseInt(a.slice("--port=".length), 10);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid port: ${args.port}`);
  }
  return args;
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 校验写操作的 leaseId。
 * 失败闭门：当前 UI 租约不存在、过期或 header 不匹配 → 401。
 */
function authorizeWrite(req) {
  const status = manager.uiLeaseStatus();
  const currentLease = status && status.leaseId;
  if (!currentLease) {
    return { ok: false, status: 401, error: "UI lease not active" };
  }
  const provided = req.headers[LEASE_HEADER];
  if (!provided || provided !== currentLease) {
    return { ok: false, status: 401, error: "Invalid or missing X-Console-Lease" };
  }
  return { ok: true };
}

function safeStaticPath(requestPath) {
  // 去掉 query/hash，防 ../ 越界
  const clean = requestPath.split("?")[0].split("#")[0];
  const normalized = path.normalize(clean).replace(/^[/\\]+/, "");
  const resolved = path.resolve(CONSOLE_UI_DIST, normalized);
  if (resolved !== CONSOLE_UI_DIST && !resolved.startsWith(CONSOLE_UI_DIST + path.sep)) {
    return null;
  }
  return resolved;
}

function serveStatic(req, res, requestPath) {
  if (!fs.existsSync(CONSOLE_UI_DIST)) {
    writeJson(res, 503, {
      error: "console-ui not built",
      hint: "Run: npm run build --prefix setup/console-ui",
    });
    return;
  }
  const filePath = safeStaticPath(requestPath);
  if (!filePath) {
    writeJson(res, 403, { error: "Forbidden path" });
    return;
  }
  // SPA fallback：未匹配文件的路径回 index.html
  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    const indexHtml = path.join(CONSOLE_UI_DIST, "index.html");
    if (!fs.existsSync(indexHtml)) {
      writeJson(res, 404, { error: "index.html missing" });
      return;
    }
    target = indexHtml;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      writeJson(res, 404, { error: `Cannot read file: ${err.message}` });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
      "content-length": data.length,
    });
    res.end(data);
  });
}

/**
 * 路由分发。
 * @returns {Promise<true>} 若已处理则返回 true，否则返回 false 表示未匹配
 */
async function route(req, res, method, requestPath) {
  // ===== 静态资源 =====
  if (method === "GET" && (requestPath === "/" || requestPath === "/index.html")) {
    serveStatic(req, res, "/index.html");
    return true;
  }
  if (method === "GET" && requestPath.startsWith("/assets/")) {
    serveStatic(req, res, requestPath);
    return true;
  }

  // ===== API =====
  if (!requestPath.startsWith("/api/")) {
    return false;
  }

  // --- 读操作（无需 leaseId） ---
  if (method === "GET" && requestPath === "/api/status") {
    writeText(res, 200, await manager.statusText());
    return true;
  }
  if (method === "GET" && requestPath === "/api/config") {
    writeJson(res, 200, manager.showConfig());
    return true;
  }
  if (method === "GET" && requestPath === "/api/drives") {
    writeJson(res, 200, manager.fixedDrives());
    return true;
  }
  if (method === "GET" && requestPath === "/api/ui/lease") {
    writeJson(res, 200, manager.uiLeaseStatus());
    return true;
  }
  if (method === "GET" && requestPath === "/api/diagnose") {
    writeText(res, 200, await manager.diagnoseText());
    return true;
  }
  if (method === "GET" && requestPath === "/api/verify-files") {
    writeText(res, 200, await manager.verifyFiles());
    return true;
  }
  if (method === "GET" && requestPath === "/api/plugins") {
    writeJson(res, 200, manager.runPluginAdmin("list"));
    return true;
  }
  if (method === "GET" && requestPath === "/api/sessions") {
    writeJson(res, 200, await manager.runReviewAdmin("list", {}));
    return true;
  }
  if (method === "GET" && requestPath === "/api/memories") {
    writeJson(res, 200, await manager.runMemoryAdmin("list", {}));
    return true;
  }
  if (method === "GET" && requestPath === "/api/logs") {
    writeJson(res, 200, manager.logPaths());
    return true;
  }
  if (method === "GET" && requestPath === "/api/processes") {
    writeJson(res, 200, { processes: manager.portableProcessSnapshot() });
    return true;
  }
  if (method === "GET" && requestPath === "/api/update/check") {
    writeJson(res, 200, manager.runPortableUpdater("Check"));
    return true;
  }

  // --- UI 租约生命周期（无需 leaseId，因为可能尚未建立租约） ---
  if (method === "POST" && requestPath === "/api/ui/open") {
    writeJson(res, 200, manager.openUiLease());
    return true;
  }
  if (method === "POST" && requestPath === "/api/ui/heartbeat") {
    writeJson(res, 200, manager.heartbeatUiLease(await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/ui/close") {
    writeJson(res, 200, manager.closeUiLease(await readBody(req)));
    return true;
  }

  // --- 日志读取（GET，无需 leaseId） ---
  if (method === "GET" && requestPath === "/api/logs/devspace") {
    const paths = manager.logPaths();
    return serveLogTail(res, paths.devspace);
  }
  if (method === "GET" && requestPath === "/api/logs/tunnel") {
    const paths = manager.logPaths();
    return serveLogTail(res, paths.tunnel);
  }

  // --- 写操作（需 leaseId） ---
  // 仅对已知写路径校验 leaseId，未匹配路径直接 404（避免泄露"需 auth"信号）
  const isKnownWrite = method === "POST" && WRITE_PATHS.has(requestPath);
  if (isKnownWrite) {
    const auth = authorizeWrite(req);
    if (!auth.ok) {
      writeJson(res, auth.status, { error: auth.error });
      return true;
    }
  }

  if (method === "POST" && requestPath === "/api/configure") {
    writeJson(res, 200, await manager.configure(await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/computer-use") {
    writeJson(res, 200, manager.setComputerUse(await readBody(req)));
    return true;
  }

  // 服务管理
  if (method === "POST" && requestPath === "/api/services/install-tasks") {
    writeText(res, 200, manager.installTasks());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/uninstall-tasks") {
    writeText(res, 200, manager.uninstallTasks());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/start") {
    writeText(res, 200, await manager.startServices());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/stop") {
    writeText(res, 200, manager.stopServices());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/restart") {
    manager.stopServices();
    writeText(res, 200, await manager.startServices());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/enable") {
    writeText(res, 200, await manager.enableServices());
    return true;
  }
  if (method === "POST" && requestPath === "/api/services/disable") {
    writeText(res, 200, manager.disableServices());
    return true;
  }
  if (method === "POST" && requestPath === "/api/cloudflared/install") {
    const installed = await manager.ensureCloudflaredRuntime();
    writeText(res, 200, `${installed ? "Installed" : "Verified"} cloudflared.`);
    return true;
  }

  // 插件管理
  if (method === "POST" && requestPath === "/api/plugins/refresh") {
    writeJson(res, 200, {
      bundledPlugins: manager.seedBundledPlugins(),
      ...manager.runPluginAdmin("refresh"),
    });
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/install") {
    writeJson(res, 200, manager.runPluginAdmin("install", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/enable") {
    writeJson(res, 200, manager.runPluginAdmin("enable", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/disable") {
    writeJson(res, 200, manager.runPluginAdmin("disable", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/uninstall") {
    writeJson(res, 200, manager.runPluginAdmin("uninstall", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/slot-bind") {
    writeJson(res, 200, manager.runPluginAdmin("bind-slot", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/plugins/slot-unbind") {
    writeJson(res, 200, manager.runPluginAdmin("unbind-slot", await readBody(req)));
    return true;
  }

  // 会话审阅
  if (method === "POST" && requestPath === "/api/sessions/details") {
    writeJson(res, 200, await manager.runReviewAdmin("details", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/sessions/update") {
    writeJson(res, 200, await manager.runReviewAdmin("update", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/sessions/rollback") {
    writeJson(res, 200, await manager.runReviewAdmin("rollback", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/sessions/restore-safety") {
    writeJson(res, 200, await manager.runReviewAdmin("restore-safety", await readBody(req)));
    return true;
  }

  // Memory
  if (method === "POST" && requestPath === "/api/memories/upsert") {
    writeJson(res, 200, await manager.runMemoryAdmin("upsert", await readBody(req)));
    return true;
  }
  if (method === "POST" && requestPath === "/api/memories/delete") {
    writeJson(res, 200, await manager.runMemoryAdmin("delete", await readBody(req)));
    return true;
  }

  // 更新
  if (method === "POST" && requestPath === "/api/update/stage") {
    writeJson(res, 200, manager.runPortableUpdater("Stage"));
    return true;
  }
  if (method === "POST" && requestPath === "/api/update/launch") {
    writeJson(res, 200, manager.launchPortableUpdate(await readBody(req)));
    return true;
  }

  return false;
}

function serveLogTail(res, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    writeText(res, 200, "");
    return true;
  }
  fs.stat(filePath, (err, stat) => {
    if (err) {
      writeText(res, 200, "");
      return;
    }
    const maxBytes = 256 * 1024; // 末尾 256 KiB
    const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const stream = fs.createReadStream(filePath, { start, encoding: "utf8" });
    let buf = "";
    stream.on("data", (chunk) => { buf += chunk; });
    stream.on("end", () => {
      writeText(res, 200, buf);
    });
    stream.on("error", () => {
      writeText(res, 200, "");
    });
  });
  return true;
}

function writeServerState(port) {
  try {
    if (!fs.existsSync(manager.RUN_DIR)) {
      fs.mkdirSync(manager.RUN_DIR, { recursive: true });
    }
    manager.writeJson(CONSOLE_SERVER_STATE_FILE, {
      pid: process.pid,
      port,
      host: HOST,
      startedAt: new Date().toISOString(),
      version: manager.PORTABLE_VERSION,
    });
  } catch (err) {
    console.error(`[console-server] failed to write state: ${err.message}`);
  }
}

function clearServerState() {
  try {
    if (fs.existsSync(CONSOLE_SERVER_STATE_FILE)) {
      fs.unlinkSync(CONSOLE_SERVER_STATE_FILE);
    }
  } catch (err) {
    console.error(`[console-server] failed to clear state: ${err.message}`);
  }
}

async function handleRequest(req, res) {
  const method = req.method || "GET";
  const urlObj = new URL(req.url, `http://${HOST}`);
  const requestPath = urlObj.pathname;

  // CORS：本机仅，但允许任意 Origin（便于远程浏览器未来访问 /console）
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", `${LEASE_HEADER}, content-type`);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const handled = await route(req, res, method, requestPath);
    if (!handled) {
      writeJson(res, 404, { error: `Not found: ${method} ${requestPath}` });
    }
  } catch (err) {
    const msg = err && err.stack ? err.stack : String(err);
    console.error(`[console-server] ${method} ${requestPath} failed: ${msg}`);
    writeJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const tester = http.createServer();
      tester.once("error", (err) => {
        if (err.code === "EADDRINUSE" && port < 65535) {
          tester.close(() => tryPort(port + 1));
        } else {
          reject(err);
        }
      });
      tester.once("listening", () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, HOST);
    };
    tryPort(start);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const port = await findFreePort(args.port);

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`[console-server] unhandled: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) {
        writeJson(res, 500, { error: "Internal error" });
      }
    });
  });

  server.on("error", (err) => {
    console.error(`[console-server] server error: ${err.stack || err}`);
    clearServerState();
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    writeServerState(port);
    console.log(`[console-server] listening on http://${HOST}:${port} (pid ${process.pid})`);
    if (port !== args.port) {
      console.log(`[console-server] port ${args.port} in use, fell back to ${port}`);
    }
  });

  const shutdown = (signal) => {
    console.log(`[console-server] ${signal} received, shutting down`);
    server.close(() => {
      clearServerState();
      process.exit(0);
    });
    // 强制退出兜底（5s）
    setTimeout(() => {
      console.error("[console-server] forced exit after timeout");
      clearServerState();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  void main();
}

module.exports = {
  parseArgs,
  route,
  authorizeWrite,
  CONSOLE_SERVER_STATE_FILE,
  LEASE_HEADER,
};
