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
const SOURCE = path.join(ROOT, "setup", "native", "DevSpacePortableApp.cs");
const OUTPUT = path.join(ROOT, "DevSpace-Portable.exe");

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
if (!fs.existsSync(SOURCE)) throw new Error(`Native UI source was not found: ${SOURCE}`);

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
  "System.Web.Extensions.dll",
  "System.Windows.Forms.dll",
].map((name) => path.join(referenceRoot, name));
for (const reference of references) {
  if (!fs.existsSync(reference)) throw new Error(`.NET Framework 4.8 reference was not found: ${reference}`);
}

run(compiler, [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/deterministic+",
  "/debug-",
  "/langversion:latest",
  `/out:${OUTPUT}`,
  ...references.map((reference) => `/reference:${reference}`),
  SOURCE,
]);

const stat = fs.statSync(OUTPUT);
console.log(`Created ${OUTPUT} (${stat.size} bytes)`);
