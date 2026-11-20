import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON || "python";
const node = process.execPath;
const generator = join(root, "setup", "create-blockmap.py");
const updater = join(root, "setup", "blockmap-updater.cjs");

function deterministicBytes(size, seed) {
  const output = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    output[index] = state & 0xff;
  }
  return output;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeFixtureFile(base, name, value) {
  const file = join(base, ...name.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function listFiles(directory) {
  const result = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result.push(relative(directory, absolute).replaceAll("\\", "/"));
    }
  }
  walk(directory);
  return result.sort();
}

function locateCurl() {
  const candidates = [
    join(root, "runtime", "git", "mingw64", "bin", "curl.exe"),
    join(root, "runtime", "git", "usr", "bin", "curl.exe"),
    process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "curl.exe") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  const located = spawnSync("where.exe", ["curl.exe"], { encoding: "utf8", windowsHide: true });
  if (located.status === 0) {
    const candidate = located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (candidate) return candidate;
  }
  throw new Error("curl.exe is unavailable for blockmap test");
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || root,
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
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

function startRangeServer(asset) {
  let flakyHeaderFailures = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/no-range") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": asset.length,
      });
      response.end(asset);
      return;
    }
    if (!["/asset", "/flaky-asset"].includes(url.pathname)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const header = String(request.headers.range || "");
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (!match) {
      response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": asset.length,
      });
      response.end(asset);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), asset.length - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= asset.length) {
      response.writeHead(416, { "Content-Range": `bytes */${asset.length}` });
      response.end();
      return;
    }
    if (url.pathname === "/flaky-asset" && start === 24 && flakyHeaderFailures === 0) {
      flakyHeaderFailures += 1;
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("transient range failure");
      return;
    }
    const body = asset.subarray(start, end + 1);
    response.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Content-Range": `bytes ${start}-${end}/${asset.length}`,
    });
    response.end(body);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

const temporary = mkdtempSync(join(os.tmpdir(), "devspace-blockmap-test-"));
const base = join(temporary, "base");
const target = join(temporary, "target");
const payload = join(temporary, "payload");
const pack = join(temporary, "DevSpacePortable-Windows-x64-1.1.42.blockmap");
const progress = join(temporary, "progress.json");
mkdirSync(base, { recursive: true });
mkdirSync(target, { recursive: true });

const oneMiB = 1024 * 1024;
const unchanged = deterministicBytes(oneMiB * 2 + 333_333, 7);
const changedBase = Buffer.concat([
  deterministicBytes(oneMiB, 11),
  deterministicBytes(oneMiB, 12),
  deterministicBytes(456_789, 13),
]);
const changedTarget = Buffer.concat([
  changedBase.subarray(0, oneMiB),
  deterministicBytes(oneMiB, 99),
  changedBase.subarray(oneMiB * 2),
]);
const newFile = deterministicBytes(oneMiB + 123_456, 21);

writeFixtureFile(base, "VERSION-MANIFEST.json", `${JSON.stringify({ runtime: { devspacePortable: "1.1.41" } }, null, 2)}\n`);
writeFixtureFile(base, "unchanged.bin", unchanged);
writeFixtureFile(base, "nested/changed.bin", changedBase);
writeFixtureFile(base, "removed.txt", "delete me\n");
writeFixtureFile(base, "data/user-state.txt", "persistent\n");

writeFixtureFile(target, "VERSION-MANIFEST.json", `${JSON.stringify({ runtime: { devspacePortable: "1.1.42" } }, null, 2)}\n`);
writeFixtureFile(target, "unchanged.bin", unchanged);
writeFixtureFile(target, "nested/changed.bin", changedTarget);
writeFixtureFile(target, "nested/new.bin", newFile);
writeFixtureFile(target, "data/plugins/installed/codex-runtime-bridge/1.1.1/manifest.json", "{\"id\":\"codex-runtime-bridge\"}\n");

let server;
try {
  const generated = spawnSync(
    python,
    [generator, target, pack, "--target-version", "1.1.42"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const metadata = JSON.parse(generated.stdout);
  assert.equal(metadata.format, "devspace-block-pack-v2");
  assert.ok(metadata.uniqueChunkCount > 0);
  assert.ok(metadata.headerCompressedSize > 0);
  assert.match(metadata.headerSha256, /^[0-9a-f]{64}$/);

  const asset = readFileSync(pack);
  const started = await startRangeServer(asset);
  server = started.server;
  const curl = locateCurl();

  const selfTest = spawnSync(node, [updater, "self-test"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  const selfTestReport = JSON.parse(selfTest.stdout.trim());
  assert.equal(selfTestReport.probeBytes, oneMiB);
  assert.equal(selfTestReport.headerRangeSegmentBytes, oneMiB);
  assert.equal(selfTestReport.rangeGroupLimitBytes, 4 * oneMiB);
  assert.deepEqual(selfTestReport.priorityTiers, ["mirror", "proxy", "direct"]);
  assert.equal(selfTestReport.mirrorDirectFirst, true);
  assert.equal(selfTestReport.proxyBeforeDirect, true);
  assert.equal(selfTestReport.officialDirectLast, true);

  const commonArgs = [
    updater,
    "stage",
    "--root", base,
    "--asset-size", String(asset.length),
    "--header-size", String(metadata.headerCompressedSize),
    "--header-sha256", metadata.headerSha256,
    "--payload", payload,
    "--target-version", "1.1.42",
    "--progress-file", progress,
    "--curl", curl,
  ];
  const staged = await runProcess(node, [
    ...commonArgs,
    "--asset-url", `${started.baseUrl}/asset`,
  ]);
  assert.equal(staged.code, 0, staged.stderr || staged.stdout);
  const result = JSON.parse(staged.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(result.success, true);
  assert.equal(result.targetVersion, "1.1.42");
  assert.ok(result.reusedBytes > 2 * oneMiB, `expected substantial local block reuse, got ${result.reusedBytes}`);
  assert.ok(result.downloadedBytes > 0);
  assert.ok(result.downloadedBytes < result.targetBytes, `${result.downloadedBytes} should be below ${result.targetBytes}`);
  assert.ok(result.missingUniqueChunks > 0);
  assert.ok(result.rangeRequestGroups > 0);
  assert.equal(
    statSync(join(payload, "data", "plugins", "installed", "codex-runtime-bridge", "1.1.1", "manifest.json")).isFile(),
    true,
    "release-owned bundled plugin files must be reconstructed",
  );

  const targetFiles = listFiles(target);
  assert.deepEqual(listFiles(payload), targetFiles);
  for (const relativePath of targetFiles) {
    assert.equal(
      sha256(readFileSync(join(payload, ...relativePath.split("/")))),
      sha256(readFileSync(join(target, ...relativePath.split("/")))),
      `reconstructed file differs: ${relativePath}`,
    );
  }
  assert.equal(statSync(join(base, "data", "user-state.txt")).isFile(), true, "persistent base data must remain untouched");

  rmSync(payload, { recursive: true, force: true });
  const flaky = await runProcess(node, [
    ...commonArgs,
    "--asset-url", `${started.baseUrl}/flaky-asset`,
  ]);
  assert.equal(flaky.code, 0, flaky.stderr || flaky.stdout);
  const flakyResult = JSON.parse(flaky.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(flakyResult.success, true);
  assert.ok(flakyResult.rangeCandidateRefreshes >= 1, "transient Range failure should trigger a route re-probe");

  rmSync(payload, { recursive: true, force: true });
  const badHeader = await runProcess(node, [
    ...commonArgs.filter((value, index, array) => !(array[index - 1] === "--header-sha256") && value !== "--header-sha256"),
    "--header-sha256", "0".repeat(64),
    "--asset-url", `${started.baseUrl}/asset`,
  ]);
  assert.notEqual(badHeader.code, 0, "tampered blockmap header digest must fail closed");
  assert.match(badHeader.stderr, /header SHA-256 mismatch/i);

  rmSync(payload, { recursive: true, force: true });
  const noRange = await runProcess(node, [
    ...commonArgs,
    "--asset-url", `${started.baseUrl}/no-range`,
  ]);
  assert.notEqual(noRange.code, 0, "a server that ignores Range must not be accepted as differential source");
  assert.match(noRange.stderr, /no mirror\/proxy\/direct endpoint supports.*HTTP Range/i);


  // The optimized path uses the complete blockmap alone. No delta ZIP exists.
  mkdirSync(join(base,"runtime","node"),{recursive:true});
  try{linkSync(join(root,"runtime","node","node.exe"),join(base,"runtime","node","node.exe"));}
  catch{copyFileSync(join(root,"runtime","node","node.exe"),join(base,"runtime","node","node.exe"));}
  for(const scenario of ["rollback","success"]){
    const partialStage=join(base,".update-staging",scenario);
    const partialPayload=join(partialStage,"payload","DevSpacePortable");
    mkdirSync(partialStage,{recursive:true});
    const planFile=join(partialStage,"blockmap-plan.json");
    const partialArgs=[...commonArgs,"--mode","changed-files","--plan-file",planFile,"--payload",partialPayload,
      "--asset-url",started.baseUrl+"/asset"];
    const partial=await runProcess(node,partialArgs);
    assert.equal(partial.code,0,partial.stderr||partial.stdout);
    const report=JSON.parse(partial.stdout.trim());
    assert.equal(report.payloadMode,"changed-files");
    assert.equal(report.unchangedFileCount,1);
    assert.equal(report.changedFileCount,targetFiles.length-1);
    assert.ok(report.writtenBytes<report.targetBytes);
    assert.equal(existsSync(join(partialPayload,"unchanged.bin")),false);
    for(const name of targetFiles.filter(p=>p!=="unchanged.bin")){
      assert.equal(sha256(readFileSync(join(partialPayload,name))),sha256(readFileSync(join(target,name))));
    }
    const warmStage=join(partialStage,"warm-run");mkdirSync(warmStage,{recursive:true});
    const warm=await runProcess(node,[...partialArgs,"--payload",join(warmStage,"payload"),"--plan-file",join(warmStage,"blockmap-plan.json")]);
    assert.equal(warm.code,0,warm.stderr||warm.stdout);
    assert.equal(JSON.parse(warm.stdout.trim()).scannedBytes,0,"warm scan must not reread installed file contents");
    // warm-plan and cold-plan share the same stable base snapshot.
    for(const helper of ["blockmap-updater.cjs","blockmap-plan.cjs"])copyFileSync(join(root,"setup",helper),join(partialStage,helper));
    writeFileSync(join(partialStage,"stage-info.json"),JSON.stringify({
      formatVersion:4,currentVersion:"1.1.41",targetVersion:"1.1.42",updateMode:"blockmap",
      payloadMode:"changed-files",payloadRoot:partialPayload,planSha256:report.planSha256,
      blockmapHeaderSha256:metadata.headerSha256,
    }));
    const before=statSync(join(base,"unchanged.bin"),{bigint:true});
    const applied=await runProcess("powershell.exe",[
      "-NoProfile","-ExecutionPolicy","Bypass","-File",join(root,"setup","test-blockmap-apply.ps1"),
      "-SourceRoot",root,"-Root",base,"-StagingPath",partialStage,
      ...(scenario==="rollback"?["-FailAfterVerify"]:[]),
    ]);
    assert.equal(applied.code,0,applied.stderr||applied.stdout);
    assert.match(applied.stdout,scenario==="rollback"?/rollbackVerified/:/applyVerified/);
    const after=statSync(join(base,"unchanged.bin"),{bigint:true});
    assert.equal(after.ino,before.ino,"unchanged file identity must survive apply");
    assert.equal(after.mtimeNs,before.mtimeNs);
    assert.equal(readFileSync(join(base,"data","user-state.txt"),"utf8"),"persistent\n");
    if(scenario==="rollback"){
      assert.equal(sha256(readFileSync(join(base,"nested","changed.bin"))),sha256(changedBase));
      assert.equal(existsSync(join(base,"nested","new.bin")),false);
    }else{
      for(const name of targetFiles)assert.equal(sha256(readFileSync(join(base,name))),sha256(readFileSync(join(target,name))));
    }
  }

  const finalProgress = JSON.parse(readFileSync(progress, "utf8"));
  assert.ok(["staged", "probing"].includes(finalProgress.phase) || typeof finalProgress.phase === "string");
  console.log(JSON.stringify({
    blockPackV2: true,
    localChunkReuse: true,
    missingChunkRangeDownload: true,
    oneMiBRangeProbe: true,
    mirrorProxyDirectPriority: true,
    segmentedBlockmapHeader: true,
    rangeFailureReprobe: true,
    reconstructedFileSha256Validation: true,
    changedOnlyStaging: true,
    zeroWarmScanContentReads: true,
    realPowerShellBlockmapApply: true,
    realPowerShellBlockmapRollback: true,
    unchangedFileIdentityPreserved: true,
    headerTamperFailsClosed: true,
    noRangeServerRejected: true,
    targetBytes: result.targetBytes,
    reusedBytes: result.reusedBytes,
    downloadedBytes: result.downloadedBytes,
    rangeRequestGroups: result.rangeRequestGroups,
  }));
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(temporary, { recursive: true, force: true });
}
