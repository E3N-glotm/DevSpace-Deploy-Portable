#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const zlib = require("node:zlib");

const MAGIC = Buffer.from("DSPBLK2\n", "ascii");
const PRELUDE_SIZE = 24;
const DEFAULT_MIRRORS = [
  "https://ghproxy.net/",
  "https://gh-proxy.com/",
  "https://github.moeyy.xyz/",
  "https://gh-proxy.net/",
];
const PERSISTENT_ROOTS = new Set(["data", "logs", "reports"]);
const ALLOWED_PERSISTENT_PREFIXES = ["data/plugins/installed/codex-runtime-bridge/"];
const PROBE_SIZE = 1024 * 1024;
const PROBE_TIMEOUT_SECONDS = 12;
const HEADER_RANGE_SEGMENT_SIZE = 1024 * 1024;
const RANGE_GROUP_LIMIT = 4 * 1024 * 1024;
const RANGE_MIN_TIMEOUT_SECONDS = 30;
const RANGE_MAX_TIMEOUT_SECONDS = 180;

function fail(message) {
  const error = new Error(message);
  error.isBlockmapError = true;
  throw error;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "mirror") {
      if (!Array.isArray(result.mirror)) result.mirror = [];
      if (i + 1 >= argv.length) fail("--mirror requires a value");
      result.mirror.push(argv[++i]);
      continue;
    }
    if (i + 1 >= argv.length) fail(`${token} requires a value`);
    result[key] = argv[++i];
  }
  return result;
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    fail(`--${name} is required`);
  }
  return String(value);
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(digest.digest("hex")));
  });
}

function safeRelative(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || /^[A-Za-z]:/.test(normalized)) fail(`unsafe blockmap path: ${value}`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`unsafe blockmap path: ${value}`);
  }
  const lower = normalized.toLowerCase();
  if (
    PERSISTENT_ROOTS.has(parts[0].toLowerCase())
    && !ALLOWED_PERSISTENT_PREFIXES.some((prefix) => lower.startsWith(prefix))
  ) {
    fail(`blockmap may not write persistent path: ${normalized}`);
  }
  return parts.join("/");
}

function mkdirp(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function atomicJson(file, value) {
  if (!file) return;
  mkdirp(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function createProgressWriter(file) {
  return (phase, message, details = {}) => {
    const bytesReceived = Number(details.bytesReceived || 0);
    const bytesTotal = Number(details.bytesTotal || 0);
    const speed = Number(details.speedBytesPerSecond || 0);
    const percent = bytesTotal > 0 ? Math.max(0, Math.min(100, (bytesReceived * 100) / bytesTotal)) : 0;
    const eta = speed > 1 && bytesTotal > bytesReceived ? Math.ceil((bytesTotal - bytesReceived) / speed) : -1;
    atomicJson(file, {
      phase,
      message,
      bytesReceived,
      bytesTotal,
      percent: Math.round(percent * 10) / 10,
      speedBytesPerSecond: Math.round(speed),
      etaSeconds: eta,
      transport: details.transport || "blockmap-range",
      reusedBytes: Number(details.reusedBytes || 0),
      targetBytes: Number(details.targetBytes || 0),
      updatedAt: new Date().toISOString(),
    });
  };
}

function createDiagnosticLogger(file) {
  const target = file ? path.resolve(file) : "";
  return (message) => {
    if (!target) return;
    mkdirp(path.dirname(target));
    const line = `[${new Date().toISOString()}] Blockmap ${message}\n`;
    fs.appendFileSync(target, line, "utf8");
  };
}

function normalizeMirror(value) {
  try {
    const uri = new URL(String(value).trim());
    if (uri.protocol !== "https:" || uri.username || uri.password) return null;
    return uri.href.endsWith("/") ? uri.href : `${uri.href}/`;
  } catch {
    return null;
  }
}

function mirrorPrefixes(args) {
  const configured = Array.isArray(args.mirror) && args.mirror.length > 0
    ? args.mirror
    : String(process.env.DEVSPACE_GITHUB_MIRRORS || "")
        .split(/[;,\r\n]+/)
        .filter(Boolean);
  const values = configured.length > 0 ? configured : DEFAULT_MIRRORS;
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeMirror(value);
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      result.push(normalized);
    }
  }
  return result;
}

function validateAssetUrl(assetUrl) {
  let parsed;
  try {
    parsed = new URL(assetUrl);
  } catch {
    fail(`invalid blockmap URL: ${assetUrl}`);
  }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !loopbackHttp) fail("blockmap URL must use HTTPS (loopback HTTP is allowed only for local tests)");
  return { parsed, loopbackHttp };
}

function proxyCandidates(args) {
  const values = [];
  if (args.proxy) values.push(String(args.proxy));
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    if (process.env[key]) values.push(process.env[key]);
  }
  const result = [];
  const seen = new Set();
  for (const raw of values) {
    let value = String(raw || "").trim();
    if (!value) continue;
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
    try {
      const uri = new URL(value);
      if (!["http:", "https:", "socks5:"].includes(uri.protocol) || uri.username || uri.password || !uri.hostname) continue;
      value = uri.href.replace(/\/$/, "");
    } catch {
      continue;
    }
    if (!seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      result.push(value);
    }
    if (result.length >= 2) break;
  }
  return result;
}

function buildRangeCandidateTiers(assetUrl, args) {
  const { parsed, loopbackHttp } = validateAssetUrl(assetUrl);
  if (loopbackHttp) {
    return [{
      name: "direct",
      label: "本地/官方直连",
      candidates: [{ url: assetUrl, source: "official", proxy: "", transport: "official/direct" }],
    }];
  }

  const proxies = proxyCandidates(args);
  const tiers = [];
  if (parsed.hostname.toLowerCase() === "github.com") {
    const mirrors = mirrorPrefixes(args).map((prefix) => ({
      url: `${prefix}${assetUrl}`,
      source: `mirror:${new URL(prefix).hostname}`,
      proxy: "",
      transport: `mirror:${new URL(prefix).hostname}/direct`,
    }));
    if (mirrors.length > 0) tiers.push({ name: "mirror", label: "镜像站", candidates: mirrors });
  }
  if (proxies.length > 0) {
    tiers.push({
      name: "proxy",
      label: "Windows/显式代理",
      candidates: proxies.map((proxy) => ({
        url: assetUrl,
        source: "official",
        proxy,
        transport: "official/proxy",
      })),
    });
  }
  tiers.push({
    name: "direct",
    label: "官方直连",
    candidates: [{ url: assetUrl, source: "official", proxy: "", transport: "official/direct" }],
  });
  return tiers;
}

function resolveCurl(root, explicit) {
  const candidates = [
    explicit,
    path.join(root, "runtime", "git", "mingw64", "bin", "curl.exe"),
    path.join(root, "runtime", "git", "usr", "bin", "curl.exe"),
    "curl.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith("curl.exe") && path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  fail("curl.exe is unavailable for blockmap differential downloads");
}

function runCurl(curl, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(curl, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function curlEnvironment() {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete env[key];
  }
  return env;
}

function rangeCurlArgs(candidate, start, end, output, timeoutSeconds, writeOut = "") {
  const expectedBytes = end - start + 1;
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--fail",
    "--connect-timeout", "4",
    "--max-time", String(timeoutSeconds),
    "--range", `${start}-${end}`,
    "--max-filesize", String(expectedBytes),
    "--output", output,
  ];
  if (candidate.proxy) args.push("--proxy", candidate.proxy);
  else args.push("--noproxy", "*");
  if (writeOut) args.push("--write-out", writeOut);
  args.push(candidate.url);
  return args;
}

async function probeCandidate(curl, candidate, temporaryRoot, sampleBytes) {
  const file = path.join(temporaryRoot, `probe-${crypto.randomUUID()}.bin`);
  const expectedBytes = sampleBytes;
  const started = Date.now();
  try {
    const result = await runCurl(
      curl,
      rangeCurlArgs(candidate, 0, expectedBytes - 1, file, PROBE_TIMEOUT_SECONDS, "%{http_code}|%{time_starttransfer}|%{time_total}|%{speed_download}|%{size_download}"),
      { env: curlEnvironment() },
    );
    const elapsedMs = Date.now() - started;
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const fields = result.stdout.trim().split("|");
    const status = Number(fields[0] || 0);
    const ttfb = Number(fields[1] || 999);
    const total = Number(fields[2] || 999);
    const speed = Number(fields[3] || 0);
    if (result.code !== 0 || status !== 206 || size !== expectedBytes) {
      return { ...candidate, ok: false, error: result.stderr.trim() || `HTTP ${status}, ${size} bytes`, elapsedMs };
    }
    return { ...candidate, ok: true, status, ttfb, total, speed, elapsedMs };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function sortHealthyCandidates(healthy) {
  healthy.sort((left, right) => {
    if (Number(right.speed) !== Number(left.speed)) return Number(right.speed) - Number(left.speed);
    const totalDelta = Number(left.total) - Number(right.total);
    if (Math.abs(totalDelta) > 0.02) return totalDelta;
    return Number(left.ttfb) - Number(right.ttfb);
  });
  return healthy;
}

async function selectRangeCandidates(curl, assetUrl, assetSize, args, temporaryRoot, progress, log, minimumTierIndex = 0) {
  const tiers = buildRangeCandidateTiers(assetUrl, args);
  const diagnostics = [];
  const sampleBytes = Math.max(1, Math.min(PROBE_SIZE, assetSize));
  for (let tierIndex = minimumTierIndex; tierIndex < tiers.length; tierIndex += 1) {
    const tier = tiers[tierIndex];
    progress("probing", `测速更新线路：镜像站 → 代理 → 官方直连；当前 ${tier.label}`, { transport: `probe:${tier.name}` });
    const probes = await Promise.all(tier.candidates.map((candidate) => probeCandidate(curl, candidate, temporaryRoot, sampleBytes)));
    for (const probe of probes) {
      if (probe.ok) {
        log(`probe PASS tier=${tier.name} source=${probe.source} proxied=${Boolean(probe.proxy)} bytes=${sampleBytes} total=${Number(probe.total).toFixed(3)}s speed=${Math.round(Number(probe.speed || 0))}B/s`);
      } else {
        const error = String(probe.error || "range probe failed").replace(/[\r\n]+/g, " ").slice(0, 500);
        log(`probe FAIL tier=${tier.name} source=${probe.source} proxied=${Boolean(probe.proxy)} bytes=${sampleBytes} error=${error}`);
        diagnostics.push(`${probe.transport}: ${error}`);
      }
    }
    const healthy = sortHealthyCandidates(probes.filter((item) => item.ok));
    if (healthy.length > 0) {
      log(`selected tier=${tier.name} source=${healthy[0].source} proxied=${Boolean(healthy[0].proxy)} speed=${Math.round(Number(healthy[0].speed || 0))}B/s`);
      return { candidates: healthy, tierIndex, tierName: tier.name, tierCount: tiers.length };
    }
  }
  fail(`no mirror/proxy/direct endpoint supports a bounded ${sampleBytes}-byte HTTP Range probe. ${diagnostics.slice(0, 16).join("; ")}`);
}

function rangeTimeoutSeconds(candidate, expectedBytes) {
  const measured = Number(candidate.speed || 0);
  const conservativeSpeed = measured > 0 ? Math.max(32 * 1024, measured * 0.5) : 128 * 1024;
  const estimated = Math.ceil(expectedBytes / conservativeSpeed) + 15;
  return Math.max(RANGE_MIN_TIMEOUT_SECONDS, Math.min(RANGE_MAX_TIMEOUT_SECONDS, estimated));
}

function applyRouteSelection(routeState, selected) {
  routeState.candidates = selected.candidates;
  routeState.tierIndex = selected.tierIndex;
  routeState.tierName = selected.tierName;
  routeState.tierCount = selected.tierCount;
}

async function reprobeCurrentRouteTier(curl, routeState) {
  const previousTier = routeState.tierIndex;
  const selected = await selectRangeCandidates(
    curl,
    routeState.assetUrl,
    routeState.assetSize,
    routeState.args,
    routeState.temporaryRoot,
    routeState.progress,
    routeState.log,
    previousTier,
  );
  applyRouteSelection(routeState, selected);
  routeState.refreshes += 1;
  routeState.sameTierReprobeUsed = selected.tierIndex === previousTier;
  routeState.log(`range re-probe selected tier=${routeState.tierName} refreshes=${routeState.refreshes}`);
  return true;
}

async function advanceRouteTier(curl, routeState) {
  const nextTier = routeState.tierIndex + 1;
  if (nextTier >= routeState.tierCount) return false;
  const selected = await selectRangeCandidates(
    curl,
    routeState.assetUrl,
    routeState.assetSize,
    routeState.args,
    routeState.temporaryRoot,
    routeState.progress,
    routeState.log,
    nextTier,
  );
  applyRouteSelection(routeState, selected);
  routeState.refreshes += 1;
  routeState.sameTierReprobeUsed = false;
  routeState.log(`range failover selected next tier=${routeState.tierName} refreshes=${routeState.refreshes}`);
  return true;
}

async function downloadRange(curl, routeState, start, end, output) {
  const expectedBytes = end - start + 1;
  const errors = [];
  for (;;) {
    for (const candidate of routeState.candidates) {
      const temporary = path.join(routeState.temporaryRoot, `range-${crypto.randomUUID()}.part`);
      const timeoutSeconds = rangeTimeoutSeconds(candidate, expectedBytes);
      try {
        const result = await runCurl(
          curl,
          rangeCurlArgs(candidate, start, end, temporary, timeoutSeconds, "%{http_code}|%{time_total}|%{speed_download}|%{size_download}"),
          { env: curlEnvironment() },
        );
        const fields = result.stdout.trim().split("|");
        const status = Number(fields[0] || 0);
        const size = fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
        if (result.code !== 0 || status !== 206 || size !== expectedBytes) {
          const error = result.stderr.trim() || `HTTP ${status}, expected ${expectedBytes}, got ${size}`;
          errors.push(`${candidate.transport}: ${error}`);
          routeState.log(`range FAIL tier=${routeState.tierName} source=${candidate.source} proxied=${Boolean(candidate.proxy)} bytes=${start}-${end} timeout=${timeoutSeconds}s error=${error.replace(/[\r\n]+/g, " ").slice(0, 500)}`);
          continue;
        }
        mkdirp(path.dirname(output));
        fs.renameSync(temporary, output);
        return candidate;
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    if (!routeState.sameTierReprobeUsed) {
      routeState.log(`all candidates failed for tier=${routeState.tierName} range=${start}-${end}; re-probing before failover`);
      await reprobeCurrentRouteTier(curl, routeState);
      continue;
    }
    routeState.log(`re-probed tier=${routeState.tierName} still failed for range=${start}-${end}; moving to the next priority tier`);
    routeState.sameTierReprobeUsed = false;
    if (!(await advanceRouteTier(curl, routeState))) break;
  }
  fail(`HTTP Range ${start}-${end} failed through all ranked endpoints: ${errors.join("; ")}`);
}

async function readHeader(curl, routeState, assetSize, expectedHeaderSize, expectedHeaderSha256, temporaryRoot, progress) {
  if (!Number.isSafeInteger(assetSize) || assetSize <= PRELUDE_SIZE) fail("blockmap asset size is invalid");
  const preludeFile = path.join(temporaryRoot, "blockmap-prelude.bin");
  await downloadRange(curl, routeState, 0, PRELUDE_SIZE - 1, preludeFile);
  const prelude = fs.readFileSync(preludeFile);
  if (!prelude.subarray(0, 8).equals(MAGIC)) fail("blockmap prelude magic is invalid");
  const compressedSize = Number(prelude.readBigUInt64LE(8));
  const rawSize = Number(prelude.readBigUInt64LE(16));
  if (!Number.isSafeInteger(compressedSize) || compressedSize <= 0 || compressedSize !== expectedHeaderSize) {
    fail(`blockmap header size mismatch: manifest ${expectedHeaderSize}, pack ${compressedSize}`);
  }
  if (!Number.isSafeInteger(rawSize) || rawSize <= 0 || rawSize > 128 * 1024 * 1024) fail("blockmap raw header size is invalid");
  if (PRELUDE_SIZE + compressedSize >= assetSize) fail("blockmap header overlaps or exceeds its data payload");

  const headerFile = path.join(temporaryRoot, "blockmap-header.bin");
  fs.rmSync(headerFile, { force: true });
  const segmentCount = Math.ceil(compressedSize / HEADER_RANGE_SEGMENT_SIZE);
  let receivedHeaderBytes = 0;
  const headerStarted = Date.now();
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const relativeStart = segmentIndex * HEADER_RANGE_SEGMENT_SIZE;
    const relativeEnd = Math.min(compressedSize, relativeStart + HEADER_RANGE_SEGMENT_SIZE) - 1;
    const absoluteStart = PRELUDE_SIZE + relativeStart;
    const absoluteEnd = PRELUDE_SIZE + relativeEnd;
    const segmentFile = path.join(temporaryRoot, `blockmap-header-${String(segmentIndex + 1).padStart(3, "0")}.part`);
    const candidate = await downloadRange(curl, routeState, absoluteStart, absoluteEnd, segmentFile);
    const segment = fs.readFileSync(segmentFile);
    fs.appendFileSync(headerFile, segment);
    receivedHeaderBytes += segment.length;
    fs.rmSync(segmentFile, { force: true });
    const elapsedSeconds = Math.max(0.001, (Date.now() - headerStarted) / 1000);
    progress("blockmap-header", `下载 Blockmap 索引 ${segmentIndex + 1}/${segmentCount}`, {
      bytesReceived: receivedHeaderBytes,
      bytesTotal: compressedSize,
      speedBytesPerSecond: receivedHeaderBytes / elapsedSeconds,
      transport: candidate.transport,
    });
  }
  const compressed = fs.readFileSync(headerFile);
  const actualHeaderSha256 = sha256Buffer(compressed);
  if (actualHeaderSha256 !== expectedHeaderSha256) {
    fail(`blockmap header SHA-256 mismatch: expected ${expectedHeaderSha256}, got ${actualHeaderSha256}`);
  }
  let raw;
  try {
    raw = zlib.inflateSync(compressed);
  } catch (error) {
    fail(`blockmap header decompression failed: ${error.message}`);
  }
  if (raw.length !== rawSize) fail(`blockmap raw header size mismatch: expected ${rawSize}, got ${raw.length}`);
  let header;
  try {
    header = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`blockmap header JSON is invalid: ${error.message}`);
  }
  if (header.schemaVersion !== 2 || header.format !== "devspace-block-pack-v2") fail("unsupported blockmap format");
  return { header, dataOffset: PRELUDE_SIZE + compressedSize };
}

function validateHeader(header, targetVersion) {
  if (String(header.targetVersion || "") !== targetVersion) fail(`blockmap header targetVersion does not match ${targetVersion}`);
  if (!Array.isArray(header.files) || !header.chunks || typeof header.chunks !== "object") fail("blockmap header has no files/chunks index");
  if (!Number.isSafeInteger(Number(header.blockSize)) || Number(header.blockSize) <= 0 || Number(header.blockSize) > 8 * 1024 * 1024) {
    fail("blockmap blockSize is invalid");
  }
  const files = [];
  let totalBytes = 0;
  const seenPaths = new Set();
  for (const item of header.files) {
    const relative = safeRelative(item.path);
    if (seenPaths.has(relative.toLowerCase())) fail(`duplicate blockmap file path: ${relative}`);
    seenPaths.add(relative.toLowerCase());
    const size = Number(item.size);
    const sha256 = String(item.sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/.test(sha256) || !Array.isArray(item.blocks)) {
      fail(`invalid blockmap file metadata: ${relative}`);
    }
    let blockBytes = 0;
    const blocks = [];
    for (const block of item.blocks) {
      const hash = String(block.sha256 || "").toLowerCase();
      const blockSize = Number(block.size);
      if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(blockSize) || blockSize <= 0 || blockSize > Number(header.blockSize)) {
        fail(`invalid block metadata for ${relative}`);
      }
      const chunk = header.chunks[hash];
      if (!chunk) fail(`block ${hash} for ${relative} is absent from chunks index`);
      if (Number(chunk.size) !== blockSize) fail(`block size mismatch for ${relative}: ${hash}`);
      blocks.push({ hash, size: blockSize, offset: blockBytes });
      blockBytes += blockSize;
    }
    if (blockBytes !== size) fail(`file block sizes do not reconstruct ${relative}`);
    totalBytes += size;
    files.push({ path: relative, size, sha256, blocks });
  }
  if (Number(header.targetTotalBytes) !== totalBytes) fail("blockmap targetTotalBytes does not match the files index");
  const versionManifest = files.find((item) => item.path.toLowerCase() === "version-manifest.json");
  if (!versionManifest) fail("blockmap target has no VERSION-MANIFEST.json");
  return { files, totalBytes, targetVersion };
}

function readChunk(handle, offset, size) {
  const buffer = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const amount = fs.readSync(handle, buffer, read, size - read, offset + read);
    if (amount <= 0) return null;
    read += amount;
  }
  return buffer;
}

function analyzeLocalReuse(root, files, progress) {
  const reusable = new Map();
  const blockSources = new Map();
  let reusedBytes = 0;
  let scannedBytes = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const installed = path.join(root, ...file.path.split("/"));
    if (!fs.existsSync(installed) || !fs.statSync(installed).isFile()) continue;
    const handle = fs.openSync(installed, "r");
    try {
      const localSize = fs.fstatSync(handle).size;
      for (const block of file.blocks) {
        if (block.offset + block.size > localSize) continue;
        const raw = readChunk(handle, block.offset, block.size);
        if (!raw) continue;
        scannedBytes += raw.length;
        if (sha256Buffer(raw) === block.hash && !reusable.has(block.hash)) {
          reusable.set(block.hash, { path: installed, offset: block.offset, size: block.size });
        }
      }
    } finally {
      fs.closeSync(handle);
    }
    if (fileIndex % 500 === 0) {
      progress("analyzing", `分析本地可复用文件块 ${fileIndex + 1}/${files.length}`, {
        bytesReceived: scannedBytes,
        bytesTotal: Number(files.reduce((sum, item) => sum + item.size, 0)),
        transport: "local-sha256",
      });
    }
  }
  for (const file of files) {
    for (const block of file.blocks) {
      const source = reusable.get(block.hash);
      if (source) {
        blockSources.set(block.hash, source);
        reusedBytes += block.size;
      }
    }
  }
  return { reusable, blockSources, reusedBytes };
}

function missingChunks(header, files, reusable) {
  const missing = new Map();
  for (const file of files) {
    for (const block of file.blocks) {
      if (reusable.has(block.hash) || missing.has(block.hash)) continue;
      const chunk = header.chunks[block.hash];
      const offset = Number(chunk.offset);
      const compressedSize = Number(chunk.compressedSize);
      const size = Number(chunk.size);
      const encoding = String(chunk.encoding || "");
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(compressedSize) || compressedSize <= 0 || compressedSize > 16 * 1024 * 1024) {
        fail(`invalid packed chunk offset/size: ${block.hash}`);
      }
      if (!Number.isSafeInteger(size) || size <= 0 || size !== block.size || !["raw", "zlib"].includes(encoding)) {
        fail(`invalid packed chunk metadata: ${block.hash}`);
      }
      missing.set(block.hash, { hash: block.hash, offset, compressedSize, size, encoding });
    }
  }
  return [...missing.values()].sort((left, right) => left.offset - right.offset);
}

function groupChunks(chunks) {
  const groups = [];
  let current = null;
  for (const chunk of chunks) {
    const end = chunk.offset + chunk.compressedSize;
    if (
      current
      && chunk.offset === current.end
      && end - current.start <= RANGE_GROUP_LIMIT
    ) {
      current.chunks.push(chunk);
      current.end = end;
      continue;
    }
    current = { start: chunk.offset, end, chunks: [chunk] };
    groups.push(current);
  }
  return groups;
}

async function downloadMissingChunks(curl, routeState, header, dataOffset, chunks, cacheRoot, temporaryRoot, progress, reusedBytes, targetBytes) {
  mkdirp(cacheRoot);
  const groups = groupChunks(chunks);
  const totalCompressedBytes = chunks.reduce((sum, chunk) => sum + chunk.compressedSize, 0);
  let downloadedBytes = 0;
  const started = Date.now();
  let transport = routeState.candidates[0].transport;
  let selectedCandidate = routeState.candidates[0];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const rangeFile = path.join(temporaryRoot, `group-${String(groupIndex + 1).padStart(5, "0")}.bin`);
    const absoluteStart = dataOffset + group.start;
    const absoluteEnd = dataOffset + group.end - 1;
    const candidate = await downloadRange(curl, routeState, absoluteStart, absoluteEnd, rangeFile);
    transport = candidate.transport;
    selectedCandidate = candidate;
    const packed = fs.readFileSync(rangeFile);
    for (const chunk of group.chunks) {
      const relativeOffset = chunk.offset - group.start;
      const encoded = packed.subarray(relativeOffset, relativeOffset + chunk.compressedSize);
      let raw;
      try {
        raw = chunk.encoding === "zlib" ? zlib.inflateSync(encoded) : Buffer.from(encoded);
      } catch (error) {
        fail(`chunk decompression failed for ${chunk.hash}: ${error.message}`);
      }
      if (raw.length !== chunk.size) fail(`chunk size mismatch after decompression: ${chunk.hash}`);
      if (sha256Buffer(raw) !== chunk.hash) fail(`chunk SHA-256 mismatch after Range download: ${chunk.hash}`);
      fs.writeFileSync(path.join(cacheRoot, chunk.hash), raw);
    }
    downloadedBytes += packed.length;
    fs.rmSync(rangeFile, { force: true });
    const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1000);
    progress("downloading", `差分下载缺失块 ${groupIndex + 1}/${groups.length}`, {
      bytesReceived: downloadedBytes,
      bytesTotal: totalCompressedBytes,
      speedBytesPerSecond: downloadedBytes / elapsedSeconds,
      transport,
      reusedBytes,
      targetBytes,
    });
  }
  return { downloadedBytes, totalCompressedBytes, transport, groupCount: groups.length, selectedCandidate };
}

function copyRange(sourceFile, sourceOffset, size, output) {
  const handle = fs.openSync(sourceFile, "r");
  try {
    const buffer = readChunk(handle, sourceOffset, size);
    if (!buffer || buffer.length !== size) fail(`local reusable chunk disappeared: ${sourceFile}`);
    fs.writeSync(output, buffer);
    return buffer;
  } finally {
    fs.closeSync(handle);
  }
}

function reconstructFiles(payload, files, reusable, cacheRoot, progress, reusableRawBytes, targetBytes) {
  mkdirp(payload);
  let writtenBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const target = path.join(payload, ...file.path.split("/"));
    mkdirp(path.dirname(target));
    const temporary = `${target}.tmp-${process.pid}`;
    const output = fs.openSync(temporary, "w");
    const digest = crypto.createHash("sha256");
    try {
      for (const block of file.blocks) {
        let raw;
        const source = reusable.get(block.hash);
        if (source) {
          const sourceHandle = fs.openSync(source.path, "r");
          try {
            raw = readChunk(sourceHandle, source.offset, source.size);
          } finally {
            fs.closeSync(sourceHandle);
          }
          if (!raw || raw.length !== block.size || sha256Buffer(raw) !== block.hash) {
            fail(`reused local chunk changed during reconstruction: ${file.path} ${block.hash}`);
          }
        } else {
          const cached = path.join(cacheRoot, block.hash);
          if (!fs.existsSync(cached)) fail(`missing downloaded chunk cache: ${block.hash}`);
          raw = fs.readFileSync(cached);
          if (raw.length !== block.size || sha256Buffer(raw) !== block.hash) fail(`cached chunk failed verification: ${block.hash}`);
        }
        fs.writeSync(output, raw);
        digest.update(raw);
        writtenBytes += raw.length;
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
    const actualSize = fs.statSync(temporary).size;
    const actualHash = digest.digest("hex");
    if (actualSize !== file.size || actualHash !== file.sha256) {
      fs.rmSync(temporary, { force: true });
      fail(`reconstructed target verification failed: ${file.path}`);
    }
    fs.renameSync(temporary, target);
    if (index % 250 === 0 || index === files.length - 1) {
      progress("reconstructing", `重组并校验目标文件 ${index + 1}/${files.length}`, {
        bytesReceived: writtenBytes,
        bytesTotal: targetBytes,
        transport: "local-reuse+blockmap",
        reusedBytes: reusableRawBytes,
        targetBytes,
      });
    }
  }
  return writtenBytes;
}

async function stage(args) {
  const root = path.resolve(requireArg(args, "root"));
  const payload = path.resolve(requireArg(args, "payload"));
  const assetUrl = requireArg(args, "asset-url");
  const assetSize = Number(requireArg(args, "asset-size"));
  const headerSize = Number(requireArg(args, "header-size"));
  const headerSha256 = requireArg(args, "header-sha256").toLowerCase();
  const targetVersion = requireArg(args, "target-version");
  const progress = createProgressWriter(args["progress-file"] ? path.resolve(args["progress-file"]) : "");
  const log = createDiagnosticLogger(args["log-file"] ? path.resolve(args["log-file"]) : "");
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) fail(`invalid target version: ${targetVersion}`);
  if (!/^[0-9a-f]{64}$/.test(headerSha256)) fail("blockmap header SHA-256 is invalid");
  if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) fail("blockmap header size is invalid");

  const curl = resolveCurl(root, args.curl);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devspace-blockmap-"));
  const cacheRoot = path.join(temporaryRoot, "chunks");
  try {
    const selected = await selectRangeCandidates(curl, assetUrl, assetSize, args, temporaryRoot, progress, log, 0);
    const routeState = {
      assetUrl,
      assetSize,
      args,
      temporaryRoot,
      progress,
      log,
      candidates: selected.candidates,
      tierIndex: selected.tierIndex,
      tierName: selected.tierName,
      tierCount: selected.tierCount,
      refreshes: 0,
      sameTierReprobeUsed: false,
    };
    const { header, dataOffset } = await readHeader(curl, routeState, assetSize, headerSize, headerSha256, temporaryRoot, progress);
    const validated = validateHeader(header, targetVersion);
    progress("analyzing", "分析当前安装文件并计算可复用块", {
      bytesReceived: 0,
      bytesTotal: validated.totalBytes,
      transport: "local-sha256",
      targetBytes: validated.totalBytes,
    });
    const reuse = analyzeLocalReuse(root, validated.files, progress);
    const missing = missingChunks(header, validated.files, reuse.reusable);
    const uniqueTargetChunks = new Set(validated.files.flatMap((file) => file.blocks.map((block) => block.hash))).size;
    const missingRawBytes = missing.reduce((sum, item) => sum + item.size, 0);
    const reusableRawBytes = Math.max(0, validated.totalBytes - missingRawBytes);

    let download = {
      downloadedBytes: 0,
      totalCompressedBytes: 0,
      transport: routeState.candidates[0].transport,
      groupCount: 0,
      selectedCandidate: routeState.candidates[0],
    };
    if (missing.length > 0) {
      download = await downloadMissingChunks(
        curl,
        routeState,
        header,
        dataOffset,
        missing,
        cacheRoot,
        temporaryRoot,
        progress,
        reusableRawBytes,
        validated.totalBytes,
      );
    }

    fs.rmSync(payload, { recursive: true, force: true });
    mkdirp(payload);
    const writtenBytes = reconstructFiles(
      payload,
      validated.files,
      reuse.reusable,
      cacheRoot,
      progress,
      reusableRawBytes,
      validated.totalBytes,
    );

    const versionManifestPath = path.join(payload, "VERSION-MANIFEST.json");
    let versionManifest;
    try {
      versionManifest = JSON.parse(fs.readFileSync(versionManifestPath, "utf8"));
    } catch (error) {
      fail(`reconstructed VERSION-MANIFEST.json is invalid: ${error.message}`);
    }
    if (String(versionManifest?.runtime?.devspacePortable || "") !== targetVersion) {
      fail(`reconstructed version manifest does not report ${targetVersion}`);
    }

    progress("staged", "Blockmap 差分包已重组并完成逐文件 SHA-256 校验", {
      bytesReceived: download.downloadedBytes,
      bytesTotal: download.totalCompressedBytes,
      transport: download.transport,
      reusedBytes: reusableRawBytes,
      targetBytes: validated.totalBytes,
    });
    return {
      success: true,
      format: "devspace-block-pack-v2",
      targetVersion,
      targetFileCount: validated.files.length,
      targetBytes: validated.totalBytes,
      uniqueTargetChunks,
      missingUniqueChunks: missing.length,
      downloadedBytes: download.downloadedBytes,
      compressedMissingBytes: download.totalCompressedBytes,
      reusedBytes: reusableRawBytes,
      writtenBytes,
      rangeRequestGroups: download.groupCount,
      selectedTransport: download.transport,
      selectedSource: download.selectedCandidate.source,
      selectedProxy: Boolean(download.selectedCandidate.proxy),
      selectedPriorityTier: routeState.tierName,
      rangeCandidateRefreshes: routeState.refreshes,
      rangeCandidates: routeState.candidates.slice(0, 8).map((item) => ({
        source: item.source,
        proxied: Boolean(item.proxy),
        ttfb: item.ttfb,
        total: item.total,
        speed: item.speed,
      })),
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function selfTest() {
  const tiers = buildRangeCandidateTiers(
    "https://github.com/example/example/releases/download/v1.0.0/example.blockmap",
    {
      mirror: ["https://mirror.example/"],
      proxy: "http://127.0.0.1:10809",
    },
  );
  return {
    probeBytes: PROBE_SIZE,
    probeTimeoutSeconds: PROBE_TIMEOUT_SECONDS,
    headerRangeSegmentBytes: HEADER_RANGE_SEGMENT_SIZE,
    rangeGroupLimitBytes: RANGE_GROUP_LIMIT,
    priorityTiers: tiers.map((tier) => tier.name),
    mirrorDirectFirst: tiers[0]?.name === "mirror" && tiers[0].candidates.every((candidate) => !candidate.proxy),
    proxyBeforeDirect: tiers.findIndex((tier) => tier.name === "proxy") < tiers.findIndex((tier) => tier.name === "direct"),
    officialDirectLast: tiers.at(-1)?.name === "direct",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] || "stage";
  let result;
  if (action === "self-test") result = selfTest();
  else if (action === "stage") result = await stage(args);
  else fail(`unsupported blockmap updater action: ${action}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`DevSpace blockmap error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
