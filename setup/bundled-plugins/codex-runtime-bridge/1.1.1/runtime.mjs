import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const command = args.shift();
const options = parseOptions(args);

try {
  const result = await dispatch(command, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}

async function dispatch(name, input) {
  switch (name) {
    case "inventory":
      return codexInventory();
    case "shell-snapshot":
      return shellSnapshot(required(input, "workspace"));
    case "checkpoint-list":
      return checkpointList(required(input, "workspace"));
    case "checkpoint-create":
      return checkpointCreate(required(input, "workspace"), required(input, "name"));
    case "checkpoint-restore":
      return checkpointRestore(required(input, "workspace"), required(input, "checkpoint"), required(input, "confirm"));
    default:
      throw new Error(`Unknown codex-runtime-bridge command: ${name}`);
  }
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--"))
      throw new Error(`Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(input, name) {
  const value = input[name];
  if (!value)
    throw new Error(`Missing required option --${name}`);
  return value;
}

function run(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error)
    throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${basename(executable)} exited with code ${result.status}: ${output || "no output"}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function where(name) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const result = run(join(systemRoot, "System32", "where.exe"), [name], { allowFailure: true, timeout: 5_000 });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
}

function runCodex(argv, options = {}) {
  const codex = where("codex.cmd")[0] ?? where("codex.exe")[0];
  if (!codex)
    return { available: false, status: null, stdout: "", stderr: "Codex was not found on PATH." };
  if (codex.toLowerCase().endsWith(".cmd")) {
    const npmRoot = dirname(codex);
    const script = join(npmRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
    const localNode = join(npmRoot, "node.exe");
    const node = where("node.exe")[0] ?? where("node")[0];
    if (!node)
      return { available: false, path: codex, status: null, stdout: "", stderr: "Node.js was not found on PATH." };
    const hostEnvironment = {
      ...process.env,
      ...(process.env.DEVSPACE_HOST_PATH ? { PATH: process.env.DEVSPACE_HOST_PATH } : {}),
      TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      NPM_CONFIG_PREFIX: npmRoot,
      npm_config_prefix: npmRoot,
    };
    const result = run(localNode === node ? localNode : node, [script, ...argv], { ...options, env: hostEnvironment, allowFailure: true });
    return { available: true, path: codex, ...result };
  }
  return { available: true, path: codex, ...run(codex, argv, { ...options, allowFailure: true }) };
}

function codexInventory() {
  const versionResult = runCodex(["--version"]);
  const featuresResult = runCodex(["features", "list"], { timeout: 15_000 });
  const pluginsResult = runCodex(["plugin", "list"], { timeout: 30_000 });
  const doctorResult = runCodex(["doctor", "--json"], { timeout: 60_000 });
  const doctor = parseJson(doctorResult.stdout);
  const checks = doctor?.checks ?? {};
  const checkValues = Object.values(checks);
  const failures = checkValues
    .filter((check) => check?.status === "fail")
    .map(doctorCheckSummary);
  const advisories = checkValues
    .filter((check) => check?.status === "warning")
    .map(doctorCheckSummary);
  return {
    generatedAt: new Date().toISOString(),
    available: versionResult.available,
    executable: versionResult.path ?? null,
    version: versionResult.stdout.trim() || null,
    enabledFeatures: parseFeatures(featuresResult.stdout).filter((feature) => feature.enabled && feature.maturity !== "removed"),
    installedPlugins: parseInstalledPlugins(pluginsResult.stdout),
    doctor: doctor ? {
      overallStatus: failures.length ? "fail" : advisories.length ? "ok-with-advisories" : "ok",
      sourceOverallStatus: doctor.overallStatus,
      failingChecks: failures,
      advisories,
    } : {
      overallStatus: "unavailable",
      failingChecks: [],
      error: doctorResult.stderr.trim() || "doctor output was not valid JSON",
    },
  };
}

function doctorCheckSummary(check) {
  return {
    id: check.id,
    status: check.status,
    summary: check.summary,
    remediation: check.remediation ?? null,
  };
}

function parseFeatures(output) {
  return output.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\S+)\s{2,}(.+?)\s{2,}(true|false)$/);
    return match ? { id: match[1], maturity: match[2].trim(), enabled: match[3] === "true" } : null;
  }).filter(Boolean);
}

function parseInstalledPlugins(output) {
  const plugins = [];
  let marketplace = null;
  for (const line of output.split(/\r?\n/)) {
    const marketplaceMatch = line.match(/^Marketplace `([^`]+)`/);
    if (marketplaceMatch) {
      marketplace = marketplaceMatch[1];
      continue;
    }
    const match = line.match(/^(\S+@\S+)\s+installed, enabled\s+(\S+)\s+(.+)$/);
    if (match)
      plugins.push({ id: match[1], marketplace, version: match[2], path: match[3].trim() });
  }
  return plugins;
}

function shellSnapshot(workspaceValue) {
  const workspace = resolve(workspaceValue);
  const selectedEnvironment = {};
  for (const name of ["PATH", "PATHEXT", "COMSPEC", "SystemRoot", "USERPROFILE", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "NO_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    const value = process.env[name];
    if (value !== undefined)
      selectedEnvironment[name] = redactEnvironmentValue(name, value);
  }
  const gitStatus = run("git", ["status", "--short", "--branch"], { cwd: workspace, allowFailure: true, timeout: 10_000 });
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    executables: Object.fromEntries(["node", "npm.cmd", "git", "ssh", "python", "py", "conda", "codex.cmd"].map((name) => [name, where(name)])),
    environment: selectedEnvironment,
    git: {
      available: gitStatus.status === 0,
      status: gitStatus.stdout.trim() || gitStatus.stderr.trim(),
    },
  };
}

function secretName(name) {
  return /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key)/i.test(name);
}

function redactEnvironmentValue(name, value) {
  if (secretName(name)) return "<redacted>";
  if (!/(?:^|_)(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "<redacted>";
    if (parsed.password) parsed.password = "<redacted>";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/[^/@\s]+@/, "://<redacted>@").replace(/[?#].*$/, "");
  }
}

function ensureGitWorkspace(workspaceValue) {
  const workspace = resolve(workspaceValue);
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, allowFailure: true, timeout: 10_000 });
  if (result.status !== 0)
    throw new Error(`Workspace is not a Git repository: ${workspace}`);
  return { workspace, gitRoot: result.stdout.trim() };
}

function checkpointList(workspaceValue) {
  const { gitRoot } = ensureGitWorkspace(workspaceValue);
  const result = run("git", ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(objectname)%09%(creatordate:iso8601)%09%(subject)", "refs/devspace/checkpoints"], { cwd: gitRoot });
  const checkpoints = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, commit, createdAt, ...subject] = line.split("\t");
    return { id: ref.replace(/^devspace\/checkpoints\//, ""), ref: `refs/${ref}`, commit, createdAt, subject: subject.join("\t") };
  });
  return { gitRoot, checkpoints };
}

function checkpointCreate(workspaceValue, name) {
  const { gitRoot } = ensureGitWorkspace(workspaceValue);
  const id = createCheckpoint(gitRoot, name);
  const commit = run("git", ["rev-parse", `refs/devspace/checkpoints/${id}`], { cwd: gitRoot }).stdout.trim();
  return { gitRoot, id, ref: `refs/devspace/checkpoints/${id}`, commit };
}

function checkpointRestore(workspaceValue, checkpoint, confirm) {
  const { gitRoot } = ensureGitWorkspace(workspaceValue);
  if (confirm !== checkpoint)
    throw new Error("checkpoint_restore requires confirm to exactly match checkpoint.");
  const safeId = checkpointId(checkpoint);
  const targetRef = `refs/devspace/checkpoints/${safeId}`;
  const target = run("git", ["rev-parse", "--verify", `${targetRef}^{commit}`], { cwd: gitRoot }).stdout.trim();
  const safetyId = createCheckpoint(gitRoot, `auto-before-restore-${safeId}`);
  const current = snapshotCommit(gitRoot, "DevSpace current state before checkpoint restore");
  const patch = run("git", ["diff", "--binary", "--no-color", current, target], { cwd: gitRoot, maxBuffer: 128 * 1024 * 1024 }).stdout;
  if (patch) {
    run("git", ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { cwd: gitRoot, input: patch, maxBuffer: 128 * 1024 * 1024 });
    run("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: gitRoot, input: patch, maxBuffer: 128 * 1024 * 1024 });
  }
  return {
    gitRoot,
    restoredCheckpoint: safeId,
    targetCommit: target,
    safetyCheckpoint: safetyId,
    changed: Boolean(patch),
    note: "The working tree was restored. Git HEAD was not moved and the existing index was not rewritten.",
  };
}

function createCheckpoint(gitRoot, name) {
  const base = checkpointId(name);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const id = `${base}-${timestamp}`;
  const commit = snapshotCommit(gitRoot, `DevSpace checkpoint ${id}`);
  run("git", ["update-ref", `refs/devspace/checkpoints/${id}`, commit], { cwd: gitRoot });
  return id;
}

function checkpointId(value) {
  const id = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  if (!id)
    throw new Error("Checkpoint name must contain letters, numbers, dot, underscore, or hyphen.");
  return id;
}

function snapshotCommit(gitRoot, message) {
  const temporary = mkdtempSync(join(tmpdir(), "devspace-checkpoint-"));
  const indexPath = join(temporary, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
  try {
    const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: gitRoot, env }).stdout.trim();
    run("git", ["read-tree", "HEAD"], { cwd: gitRoot, env });
    run("git", ["add", "-A", "--", "."], { cwd: gitRoot, env });
    const tree = run("git", ["write-tree"], { cwd: gitRoot, env }).stdout.trim();
    return run("git", ["commit-tree", tree, "-p", head, "-m", message], { cwd: gitRoot, env }).stdout.trim();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
