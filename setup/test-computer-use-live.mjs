import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { captureDesktop } from "../app/node_modules/@waishnav/devspace/dist/computer-use.js";

const setupDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(setupDir, "..");
const managerFile = resolve(setupDir, "portable-manager.cjs");
const count = Number(process.argv[2] || 5);
if (!Number.isInteger(count) || count < 1 || count > 20) {
  throw new Error("Capture count must be an integer from 1 to 20.");
}

const statusResult = spawnSync(process.execPath, [managerFile, "ui-status", "--ascii-json"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 20_000,
});
if (statusResult.status !== 0) throw new Error(statusResult.stderr || "Unable to read local UI lease.");
const lease = JSON.parse(statusResult.stdout);
if (!lease.active || !lease.leaseId) {
  throw new Error("Open Portable-Setup.hta from the Windows desktop before running this live test.");
}

process.env.DEVSPACE_PORTABLE_ROOT = root;
const captures = [];
for (let index = 0; index < count; index += 1) {
  const startedAt = performance.now();
  const result = await captureDesktop({ leaseId: lease.leaseId });
  const elapsedMs = Math.round(performance.now() - startedAt);
  const image = result.image;
  if (!image || image.length < 8 || image.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) {
    throw new Error(`Capture ${index + 1} did not return a valid PNG.`);
  }
  if (!result.metadata?.width || !result.metadata?.height || result.metadata.screenshot !== true) {
    throw new Error(`Capture ${index + 1} returned incomplete metadata.`);
  }
  captures.push({
    index: index + 1,
    width: result.metadata.width,
    height: result.metadata.height,
    outputs: result.metadata.outputs,
    backend: result.metadata.backend,
    fallbackFrom: result.metadata.fallbackFrom || null,
    elapsedMs,
    bytes: image.length,
    sha256: createHash("sha256").update(image).digest("hex"),
    stderr: result.stderr,
  });
}

const helper = await readFile(resolve(root, "app/node_modules/@waishnav/devspace/dist/helpers/computer-use-capture.exe"));
console.log(JSON.stringify({
  leaseIdPrefix: lease.leaseId.slice(0, 8),
  count,
  helperBytes: helper.length,
  helperSha256: createHash("sha256").update(helper).digest("hex"),
  broker: lease.broker || null,
  averageElapsedMs: Math.round(captures.reduce((sum, item) => sum + item.elapsedMs, 0) / captures.length),
  captures,
}, null, 2));
