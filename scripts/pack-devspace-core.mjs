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

let command;
let args;
if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
  command = process.execPath;
  args = [process.env.npm_execpath, "pack", source, "--pack-destination", packages, "--ignore-scripts"];
} else {
  const bundledNpmCli = join(root, "runtime", "node", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledNpmCli)) {
    command = process.execPath;
    args = [bundledNpmCli, "pack", source, "--pack-destination", packages, "--ignore-scripts"];
  } else {
    command = process.platform === "win32" ? "npm.cmd" : "npm";
    args = ["pack", source, "--pack-destination", packages, "--ignore-scripts"];
  }
}

const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  shell: process.platform === "win32" && /\.cmd$/i.test(command),
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(String(result.stdout || ""));
  process.stderr.write(String(result.stderr || ""));
  throw new Error(`npm pack exited with code ${result.status}`);
}
if (!existsSync(expectedPath)) {
  throw new Error(`npm pack did not create the expected package: ${expectedPath}`);
}

const bytes = readFileSync(expectedPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const lockPath = join(root, "app", "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const dependency = lock.packages?.["node_modules/@waishnav/devspace"];
if (!dependency) throw new Error("app/package-lock.json has no @waishnav/devspace package entry.");
dependency.resolved = `file:../packages/${expectedName}`;
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

