import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "vendor", "waishnav-devspace");
const packages = join(root, "packages");
const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const expectedName = `waishnav-devspace-${packageJson.version}.tgz`;
const expectedPath = join(packages, expectedName);

if (!existsSync(join(source, "dist", "server.js"))) {
  throw new Error(`Portable core source is incomplete: ${source}`);
}

mkdirSync(packages, { recursive: true });
for (const name of readdirSync(packages)) {
  if (/^waishnav-devspace-.*\.tgz$/i.test(name)) rmSync(join(packages, name), { force: true });
}

const packer = join(root, "scripts", "pack-devspace-core.py");
const pythonCandidates = process.platform === "win32"
  ? [process.env.PYTHON, "python.exe", "python"]
  : [process.env.PYTHON, "python3", "python"];
let command;
for (const candidate of pythonCandidates.filter(Boolean)) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.status === 0) {
    command = candidate;
    break;
  }
}
if (!command) throw new Error("Python 3 is required to create the deterministic Portable core package.");
const args = [packer, "--source", source, "--output", expectedPath];

const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(String(result.stdout || ""));
  process.stderr.write(String(result.stderr || ""));
  throw new Error(`Portable core packer exited with code ${result.status}`);
}
if (!existsSync(expectedPath)) {
  throw new Error(`Portable core packer did not create the expected package: ${expectedPath}`);
}

const bytes = readFileSync(expectedPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const lockPath = join(root, "app", "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const dependency = lock.packages?.["node_modules/@waishnav/devspace"];
if (!dependency) throw new Error("app/package-lock.json has no @waishnav/devspace package entry.");
dependency.resolved = `file:../packages/${expectedName}`;
dependency.version = packageJson.version;
dependency.integrity = integrity;
lock.packages[""].dependencies["@waishnav/devspace"] = `file:../packages/${expectedName}`;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  package: expectedPath,
  version: packageJson.version,
  bytes: bytes.length,
  sha256,
  integrity,
}, null, 2));

