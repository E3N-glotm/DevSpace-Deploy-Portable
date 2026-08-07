import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumFileBytes = 95 * 1024 * 1024;
const required = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "VERSION-MANIFEST.json",
  "vendor/waishnav-devspace/package.json",
  "vendor/waishnav-devspace/dist/server.js",
  "setup/native/DevSpacePortableApp.cs",
  "setup/portable-updater.ps1",
  "scripts/pack-devspace-core.mjs",
  "scripts/pack-devspace-core.py",
];

const forbiddenTrackedPatterns = [
  /^runtime\//,
  /^app\/node_modules\//,
  /^data\//,
  /^logs\//,
  /^reports\//,
  /^packages\/.*\.tgz$/i,
  /^release-assets\/(?!README\.md$)/,
  /^DevSpacePortable-Windows-x64-.*\.zip$/i,
  /^SHA256SUMS\.txt$/i,
  /^DevSpace-Portable\.exe$/i,
  /^[0-9a-f-]{20,}_DevSpace-Portable\.exe$/i,
];

function gitFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
    return output.split("\0").filter(Boolean).map((value) => value.replaceAll("\\", "/"));
  } catch {
    return [];
  }
}

function sourceFiles() {
  const excluded = new Set([".git", ".idea", ".vs", ".vscode", "runtime", "data", "logs", "reports", "node_modules"]);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (excluded.has(entry.name) || rel === "app/node_modules") continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (forbiddenTrackedPatterns.some((pattern) => pattern.test(rel))) continue;
        files.push(rel);
      }
    }
  }
  return files;
}

for (const file of required) {
  if (!existsSync(join(root, file))) throw new Error(`Required source file is missing: ${file}`);
}

const tracked = gitFiles();
const files = tracked.length ? tracked : sourceFiles();
const forbidden = files.filter((file) => forbiddenTrackedPatterns.some((pattern) => pattern.test(file)));
if (forbidden.length) {
  throw new Error(`Forbidden generated or sensitive paths are tracked:\n${forbidden.join("\n")}`);
}

let totalBytes = 0;
let largest = { path: "", bytes: 0 };
for (const file of files) {
  const full = join(root, file);
  if (!existsSync(full)) continue;
  const stat = lstatSync(full);
  if (!stat.isFile()) continue;
  totalBytes += stat.size;
  if (stat.size > largest.bytes) largest = { path: file, bytes: stat.size };
  if (stat.size > maximumFileBytes) {
    throw new Error(`Tracked file exceeds 95 MiB: ${file} (${stat.size} bytes)`);
  }
}

const sensitiveFiles = files.filter((file) => /(^|\/)(auth\.json|ngrok\.ya?ml|cloudflare\.token|devspace\.sqlite)$/i.test(file));
if (sensitiveFiles.length) {
  throw new Error(`Credential or state files are tracked:\n${sensitiveFiles.join("\n")}`);
}

const manifest = JSON.parse(readFileSync(join(root, "VERSION-MANIFEST.json"), "utf8"));
if (!String(manifest.release || "").startsWith("DevSpacePortable-Windows-x64-")) {
  throw new Error("VERSION-MANIFEST.json contains an invalid release name.");
}

console.log(JSON.stringify({
  checkedFiles: files.length,
  totalBytes,
  largest,
  release: manifest.release,
  portableVersion: manifest.runtime?.devspacePortable,
  forbiddenTrackedPaths: 0,
  sensitiveTrackedFiles: 0,
}, null, 2));

