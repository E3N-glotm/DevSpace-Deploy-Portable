"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const VSWHERE = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
const REFERENCE_ROOT_CANDIDATES = [
  "C:\\Program Files (x86)\\Reference Assemblies\\Microsoft\\Framework\\.NETFramework\\v4.8",
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319",
];
const TARGETS = [
  {
    source: path.join(ROOT, "setup", "native", "DevSpacePortableApp.cs"),
    output: path.join(ROOT, "DevSpace-Portable.exe"),
    target: "winexe",
    shared: true,
  },
  {
    source: path.join(ROOT, "setup", "native", "DevSpaceUpdaterApp.cs"),
    output: path.join(ROOT, "Update.exe"),
    target: "winexe",
    shared: true,
  },
  {
    source: path.join(ROOT, "setup", "native", "DevSpaceSshAskPass.cs"),
    output: path.join(ROOT, "DevSpace-SshAskPass.exe"),
    target: "exe",
    shared: false,
  },
];
const SHARED_SOURCES = [
  path.join(ROOT, "setup", "native", "DevSpaceBrandIcon.cs"),
];

function run(file, args) {
  const result = childProcess.spawnSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout || ""));
    process.stderr.write(String(result.stderr || ""));
    throw new Error(`${path.basename(file)} exited with code ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

if (!fs.existsSync(VSWHERE)) throw new Error(`vswhere.exe was not found: ${VSWHERE}`);
for (const target of TARGETS) {
  if (!fs.existsSync(target.source)) throw new Error(`Native UI source was not found: ${target.source}`);
}
for (const source of SHARED_SOURCES) {
  if (!fs.existsSync(source)) throw new Error(`Shared native UI source was not found: ${source}`);
}

const vsRoot = run(VSWHERE, [
  "-latest",
  "-products", "*",
  "-requires", "Microsoft.Component.MSBuild",
  "-property", "installationPath",
]).split(/\r?\n/).filter(Boolean)[0];
if (!vsRoot) throw new Error("Visual Studio Build Tools were not found.");

const compiler = path.join(vsRoot, "MSBuild", "Current", "Bin", "Roslyn", "csc.exe");
if (!fs.existsSync(compiler)) throw new Error(`Roslyn compiler was not found: ${compiler}`);

const referenceRoot = REFERENCE_ROOT_CANDIDATES.find((candidate) =>
  fs.existsSync(path.join(candidate, "System.Windows.Forms.dll")),
);
if (!referenceRoot) {
  throw new Error(`No usable .NET Framework reference directory was found. Checked: ${REFERENCE_ROOT_CANDIDATES.join(", ")}`);
}

const references = [
  "mscorlib.dll",
  "System.dll",
  "System.Core.dll",
  "System.Drawing.dll",
  "System.Security.dll",
  "System.Web.Extensions.dll",
  "System.Windows.Forms.dll",
].map((name) => path.join(referenceRoot, name));
for (const reference of references) {
  if (!fs.existsSync(reference)) throw new Error(`.NET Framework 4.8 reference was not found: ${reference}`);
}

for (const target of TARGETS) {
  run(compiler, [
    "/nologo",
    `/target:${target.target}`,
    "/platform:x64",
    "/optimize+",
    "/deterministic+",
    "/debug-",
    "/langversion:latest",
    `/out:${target.output}`,
    ...references.map((reference) => `/reference:${reference}`),
    ...(target.shared ? SHARED_SOURCES : []),
    target.source,
  ]);

  const stat = fs.statSync(target.output);
  console.log(`Created ${target.output} (${stat.size} bytes)`);
}
