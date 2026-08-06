import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");
const AGENT_ROOT = join(APP, "node_modules", "@earendil-works", "pi-coding-agent");
const ROOT_LOCK_PATH = join(APP, "package-lock.json");
const AGENT_PACKAGE_PATH = join(AGENT_ROOT, "package.json");
const AGENT_SHRINKWRAP_PATH = join(AGENT_ROOT, "npm-shrinkwrap.json");
const ROOT_UNDICI_ROOT = join(APP, "node_modules", "undici");
const ROOT_UNDICI_PACKAGE_PATH = join(ROOT_UNDICI_ROOT, "package.json");
const NESTED_UNDICI_ROOT = join(AGENT_ROOT, "node_modules", "undici");
const UNDICI_PACKAGE_PATH = join(AGENT_ROOT, "node_modules", "undici", "package.json");
const EXPECTED_UNDICI = "8.10.0";
const ROOT_AGENT_KEY = "node_modules/@earendil-works/pi-coding-agent";
const ROOT_DIRECT_UNDICI_KEY = "node_modules/undici";
const ROOT_UNDICI_KEY = `${ROOT_AGENT_KEY}/node_modules/undici`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function assertVersion(label, value) {
  if (value !== EXPECTED_UNDICI) {
    throw new Error(`${label} must be ${EXPECTED_UNDICI}; received ${value ?? "missing"}.`);
  }
}

const agentPackage = readJson(AGENT_PACKAGE_PATH);
const shrinkwrap = readJson(AGENT_SHRINKWRAP_PATH);
const rootInstalledUndici = readJson(ROOT_UNDICI_PACKAGE_PATH);
const rootLock = readJson(ROOT_LOCK_PATH);

// npm overrides install the hardened nested package, but npm intentionally
// leaves the depended-on package's published package.json and shrinkwrap
// metadata unchanged. A clean npm ci therefore starts with an 8.5.0 metadata
// declaration even though node_modules/undici is correctly resolved to 8.10.0.
// Normalize those local runtime metadata files and replace the shrinkwrap-
// pinned nested package with the separately locked root dependency. This
// avoids a network operation in the hardening step and remains deterministic.
assertVersion("installed root undici", rootInstalledUndici.version);

const agentLockNode = rootLock.packages?.[ROOT_AGENT_KEY];
const hardenedLockNode = rootLock.packages?.[ROOT_DIRECT_UNDICI_KEY];
const shrinkwrapRoot = shrinkwrap.packages?.[""];
if (!agentLockNode || !hardenedLockNode || !shrinkwrapRoot) {
  throw new Error("Root package lock or pi-coding-agent shrinkwrap is missing the expected package node.");
}
assertVersion("root package-lock nested undici", hardenedLockNode.version);

rmSync(NESTED_UNDICI_ROOT, { recursive: true, force: true });
cpSync(ROOT_UNDICI_ROOT, NESTED_UNDICI_ROOT, { recursive: true, force: true });
const installedUndici = readJson(UNDICI_PACKAGE_PATH);
assertVersion("installed nested undici", installedUndici.version);

agentPackage.dependencies = { ...agentPackage.dependencies, undici: EXPECTED_UNDICI };
shrinkwrapRoot.dependencies = { ...shrinkwrapRoot.dependencies, undici: EXPECTED_UNDICI };
shrinkwrap.packages["node_modules/undici"] = { ...hardenedLockNode };
agentLockNode.dependencies = { ...agentLockNode.dependencies, undici: EXPECTED_UNDICI };

writeFileSync(AGENT_PACKAGE_PATH, `${JSON.stringify(agentPackage, null, 2)}\n`, "utf8");
writeFileSync(AGENT_SHRINKWRAP_PATH, `${JSON.stringify(shrinkwrap, null, 2)}\n`, "utf8");
writeFileSync(ROOT_LOCK_PATH, `${JSON.stringify(rootLock, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  package: agentPackage.dependencies.undici,
  shrinkwrap: shrinkwrap.packages[""].dependencies.undici,
  installed: installedUndici.version,
  rootLock: rootLock.packages[ROOT_UNDICI_KEY].version,
}));
