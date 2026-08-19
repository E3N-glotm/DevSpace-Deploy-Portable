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

function gitEolRows() {
  try {
    const output = execFileSync("git", ["ls-files", "--eol", "-z"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function validateWorkingTreeEol() {
  const rows = gitEolRows();
  if (!rows.length) return { checked: 0, mismatches: [] };

  const mismatches = [];
  let checked = 0;
  for (const row of rows) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const metadata = row.slice(0, tab).trim();
    const path = row.slice(tab + 1).replaceAll("\\", "/");
    const tokens = metadata.split(/\s+/);
    const working = tokens.find((token) => token.startsWith("w/"))?.slice(2) || "";
    const attributes = metadata.includes("attr/") ? metadata.slice(metadata.indexOf("attr/") + 5) : "";
    let expected = "";
    if (/\beol=lf\b/.test(attributes)) expected = "lf";
    if (/\beol=crlf\b/.test(attributes)) expected = "crlf";
    if (!expected) continue;

    checked += 1;
    // Git reports w/none for an empty or single-line text file with no line
    // endings. That is compatible with either declared EOL policy.
    if (working !== expected && working !== "none") {
      mismatches.push({ path, expected, actual: working || "unknown" });
    }
  }
  return { checked, mismatches };
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

const eol = validateWorkingTreeEol();
if (eol.mismatches.length) {
  const preview = eol.mismatches
    .slice(0, 40)
    .map(({ path, expected, actual }) => `${path}: expected ${expected}, working tree is ${actual}`)
    .join("\n");
  throw new Error(
    "Tracked files do not match their .gitattributes EOL policy. " +
    "Re-materialize the checkout before packing a Portable release:\n" +
    preview,
  );
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
  explicitEolFilesChecked: eol.checked,
  eolMismatches: 0,
}, null, 2));

