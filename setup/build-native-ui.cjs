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
  },
  {
    source: path.join(ROOT, "setup", "native", "DevSpaceUpdaterApp.cs"),
    output: path.join(ROOT, "Update.exe"),
  },
];
const WEBVIEW2_LIB = path.join(ROOT, "setup", "native", "lib", "webview2", "lib", "net462");
const WEBVIEW2_WINFORMS_DLL = path.join(WEBVIEW2_LIB, "Microsoft.Web.WebView2.WinForms.dll");
const WEBVIEW2_CORE_DLL = path.join(WEBVIEW2_LIB, "Microsoft.Web.WebView2.Core.dll");
const WEBVIEW2_LOADER_X64 = path.join(
  ROOT,
  "setup",
  "native",
  "lib",
  "webview2",
  "runtimes",
  "win-x64",
  "native",
  "WebView2Loader.dll",
);

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

for (const target of TARGETS) {
  if (!fs.existsSync(target.source)) throw new Error(`Native UI source was not found: ${target.source}`);
}
if (!fs.existsSync(WEBVIEW2_WINFORMS_DLL)) {
  throw new Error(
    `Microsoft.Web.WebView2.WinForms.dll was not found at ${WEBVIEW2_WINFORMS_DLL}. ` +
    `Download the NuGet package (see setup/native/lib/webview2/README).`,
  );
}
if (!fs.existsSync(WEBVIEW2_LOADER_X64)) {
  throw new Error(`WebView2Loader.dll (win-x64) was not found at ${WEBVIEW2_LOADER_X64}.`);
}

// 编译器选择：优先 VS Roslyn（支持最新 C# 语法），fallback 到 .NET Framework 自带 csc.exe（C# 5）
let compiler = null;
let langVersion = "latest";
if (fs.existsSync(VSWHERE)) {
  const vsRoot = run(VSWHERE, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.Component.MSBuild",
    "-property", "installationPath",
  ]).split(/\r?\n/).filter(Boolean)[0];
  if (vsRoot) {
    const roslynCsc = path.join(vsRoot, "MSBuild", "Current", "Bin", "Roslyn", "csc.exe");
    if (fs.existsSync(roslynCsc)) compiler = roslynCsc;
  }
}
if (!compiler) {
  const frameworkCsc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  if (fs.existsSync(frameworkCsc)) {
    compiler = frameworkCsc;
    langVersion = "5"; // .NET Framework 4 csc.exe 最高支持 C# 5（async/await）
  }
}
if (!compiler) {
  throw new Error("C# compiler was not found. Install Visual Studio Build Tools or ensure .NET Framework csc.exe exists.");
}

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
// WebView2 托管程序集（Core + WinForms 适配器）
references.push(WEBVIEW2_CORE_DLL, WEBVIEW2_WINFORMS_DLL);

const compilerArgs = [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/debug-",
  `/langversion:${langVersion}`,
];
// /deterministic+ 仅 Roslyn 支持，.NET Framework 4 自带 csc.exe 不识别
if (langVersion === "latest") compilerArgs.push("/deterministic+");

for (const target of TARGETS) {
  const targetArgs = [...compilerArgs, `/out:${target.output}`, ...references.map((reference) => `/reference:${reference}`), target.source];
  run(compiler, targetArgs);
  const stat = fs.statSync(target.output);
  console.log(`Created ${target.output} (${stat.size} bytes)`);
}

// 把 WebView2Loader.dll (本机) 复制到输出目录，否则 WebView2 运行时初始化失败。
fs.copyFileSync(WEBVIEW2_LOADER_X64, path.join(ROOT, "WebView2Loader.dll"));
// 把 WebView2 托管程序集复制到输出目录，运行时需要与 exe 同目录。
fs.copyFileSync(WEBVIEW2_CORE_DLL, path.join(ROOT, "Microsoft.Web.WebView2.Core.dll"));
fs.copyFileSync(WEBVIEW2_WINFORMS_DLL, path.join(ROOT, "Microsoft.Web.WebView2.WinForms.dll"));
console.log(`Copied WebView2Loader.dll -> ${path.join(ROOT, "WebView2Loader.dll")}`);
console.log(`Copied Microsoft.Web.WebView2.Core.dll -> ${path.join(ROOT, "Microsoft.Web.WebView2.Core.dll")}`);
console.log(`Copied Microsoft.Web.WebView2.WinForms.dll -> ${path.join(ROOT, "Microsoft.Web.WebView2.WinForms.dll")}`);
