import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app");
const AGENT_ROOT = join(APP, "node_modules", "@earendil-works", "pi-coding-agent");
const ROOT_LOCK_PATH = join(APP, "package-lock.json");
const AGENT_PACKAGE_PATH = join(AGENT_ROOT, "package.json");
const AGENT_SHRINKWRAP_PATH = join(AGENT_ROOT, "npm-shrinkwrap.json");
const UNDICI_PACKAGE_PATH = join(AGENT_ROOT, "node_modules", "undici", "package.json");
const EXPECTED_UNDICI = "8.10.0";
const ROOT_AGENT_KEY = "node_modules/@earendil-works/pi-coding-agent";
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
const installedUndici = readJson(UNDICI_PACKAGE_PATH);
const rootLock = readJson(ROOT_LOCK_PATH);

assertVersion("pi-coding-agent package dependency", agentPackage.dependencies?.undici);
assertVersion("pi-coding-agent shrinkwrap dependency", shrinkwrap.packages?.[""]?.dependencies?.undici);
assertVersion("pi-coding-agent shrinkwrap node", shrinkwrap.packages?.["node_modules/undici"]?.version);
assertVersion("installed nested undici", installedUndici.version);

const agentLockNode = rootLock.packages?.[ROOT_AGENT_KEY];
const shrinkwrapNode = shrinkwrap.packages?.["node_modules/undici"];
if (!agentLockNode || !shrinkwrapNode) {
  throw new Error("Root package lock or pi-coding-agent shrinkwrap is missing the expected package node.");
}
agentLockNode.dependencies = { ...agentLockNode.dependencies, undici: EXPECTED_UNDICI };
rootLock.packages[ROOT_UNDICI_KEY] = { ...shrinkwrapNode };

writeFileSync(ROOT_LOCK_PATH, `${JSON.stringify(rootLock, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  package: agentPackage.dependencies.undici,
  shrinkwrap: shrinkwrap.packages[""].dependencies.undici,
  installed: installedUndici.version,
  rootLock: rootLock.packages[ROOT_UNDICI_KEY].version,
}));
