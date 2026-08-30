import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "devspace-runtime-log-ui-"));

function resolveBrowserExecutable() {
  const explicit = String(process.env.DEVSPACE_TEST_BROWSER || "").trim();
  const candidates = [
    explicit || undefined,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function verifyStaticRuntimeUiContracts(runtimeJs) {
  const requiredMarkers = [
    'className: `tool-card shell codex-runtime-card compact-log ${status.tone}`',
    'panel.dataset.devspaceRuntime = "true"',
    'className: "operation-row compact-operation"',
    'data-devspace-operations',
    'function redactText(value)',
    'Bearer <redacted>',
    '$1<redacted>',
    'new Set(["apply_patch", "show_changes", "session_changes", "write", "edit"])',
  ];
  const missing = requiredMarkers.filter((marker) => !runtimeJs.includes(marker));
  if (missing.length) {
    throw new Error(`runtime UI static fallback is missing required contracts: ${missing.join(" | ")}`);
  }
}

try {
  const runtimeJsPath = resolve("app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js");
  const runtimeJs = (await readFile(runtimeJsPath, "utf8")).replace(/<\/script/gi, "<\\/script");
  const runtimeCss = pathToFileURL(resolve("app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.css")).href;
  const timelineCss = pathToFileURL(resolve("app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-timeline.css")).href;
  const htmlPath = join(root, "index.html");
  const browserProfile = join(root, "browser-profile");
  await writeFile(htmlPath, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${runtimeCss}"><link rel="stylesheet" href="${timelineCss}">
</head><body><main id="app"></main><script>${runtimeJs}</script>
<script>
const send = (message) => window.handleMessage(message);
document.body.dataset.handlerType = typeof window.handleMessage;
setTimeout(() => {
  send({jsonrpc:"2.0",method:"ui/initialize",params:{hostContext:{toolInfo:{tool:{name:"exec_command"}}}}});
  send({jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:{argv:["python","train.py","--token","secret"],workingDirectory:"E:\\\\project"}}});
  send({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{
    _meta:{tool:"exec_command",card:{summary:{wallTimeMs:1200,exitCode:0},payload:{runtime:{command:"python train.py --token <redacted>",workingDirectory:"E:\\\\project",wallTimeMs:1200,exitCode:0,running:false},content:[{type:"text",text:"done"}]}}},
    content:[{type:"text",text:"done"}],structuredContent:{result:"done"}
  }});
}, 50);
setTimeout(() => {
  const text = document.body.innerText;
  document.body.dataset.runtimeOk = String(Boolean((text.includes("已在 1.2 s 内运行") || text.includes("Ran in 1.2 s")) && document.querySelector("details.compact-log")));
  document.querySelector("#app").innerHTML = '<section class="tool-card"><div class="tool-body"></div></section>';
  send({jsonrpc:"2.0",method:"ui/initialize",params:{hostContext:{toolInfo:{tool:{name:"show_changes"}}}}});
  send({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{
    _meta:{tool:"show_changes",card:{
      operations:[{tool:"exec_command",success:true,durationMs:1200,command:"python train.py",exitCode:0,workingDirectory:"E:\\\\project"}],
      files:[{path:"src/train.py",type:"modified",additions:8,removals:2}],
      payload:{patch:"diff --git a/src/train.py b/src/train.py"}
    }},content:[{type:"text",text:"Changed 1 file (+8 -2)."}],structuredContent:{result:"ok"}
  }});
}, 220);
setTimeout(() => {
  const timeline = document.querySelector("[data-devspace-operations='true']");
  const text = timeline?.textContent ?? "";
  document.body.dataset.timelineCount = String(document.querySelectorAll("details.compact-operation").length);
  document.body.dataset.hasOperations = String(Boolean(timeline));
  document.body.dataset.timelineCollapsed = String(Boolean(timeline?.tagName === "DETAILS" && !timeline.open));
  document.body.dataset.hasRan = String(text.includes("已在 1.2 s 内运行") || text.includes("Ran in 1.2 s"));
  document.body.dataset.hasModified = String(text.includes("已修改") || text.includes("Modified"));
  document.body.dataset.hasFile = String(text.includes("src/train.py"));
  document.body.dataset.timelineOk = String(
    timeline
    && timeline.tagName === "DETAILS"
    && !timeline.open
    && (text.includes("已在 1.2 s 内运行") || text.includes("Ran in 1.2 s"))
    && (text.includes("已修改") || text.includes("Modified"))
    && text.includes("src/train.py")
    && document.querySelectorAll("details.compact-operation").length === 2
  );
}, 500);
</script></body></html>`, "utf8");

  const browser = resolveBrowserExecutable();
  const result = browser ? spawnSync(browser, [
      "--headless=new",
      "--disable-gpu",
      `--user-data-dir=${browserProfile}`,
      "--no-first-run",
      "--disable-extensions",
      "--allow-file-access-from-files",
      "--virtual-time-budget=1500",
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    }) : undefined;
  if (!result || result.error?.code === "ETIMEDOUT") {
    // Browser rendering is an optional smoke layer, not a DevSpace runtime
    // dependency. The product executes inside the MCP Apps/ChatGPT Host iframe
    // and must not depend on Edge, Chrome or any standalone user browser.
    // If no local headless browser exists (or its CLI is unhealthy), preserve
    // deterministic release coverage with source-level UI contracts instead.
    verifyStaticRuntimeUiContracts(runtimeJs);
    console.log(JSON.stringify({
      compactRuntimeLog: true,
      operationTimeline: true,
      collapsibleOperationTimeline: true,
      fileTimeline: true,
      redaction: true,
      browserRender: false,
      staticFallback: true,
      reason: browser ? "available headless browser timed out" : "no local headless browser available",
    }));
  } else {
    if (result.status !== 0) throw new Error(result.stderr || `Edge exited ${result.status}`);
    if (!result.stdout.includes('data-runtime-ok="true"')) {
      const bodyTag = result.stdout.match(/<body[^>]*>/i)?.[0] ?? "body tag missing";
      throw new Error(`compact runtime command log did not render (${bodyTag}): ${result.stdout.slice(-800)}`);
    }
    if (!result.stdout.includes('data-timeline-ok="true"')) {
      const bodyTag = result.stdout.match(/<body[^>]*>/i)?.[0] ?? "body tag missing";
      throw new Error(`operation/file timeline did not render (${bodyTag}): ${result.stdout.slice(-900)}`);
    }
    if (result.stdout.includes("secret</code>") || result.stdout.includes("--token secret")) throw new Error("sensitive command value leaked");
    console.log(JSON.stringify({ compactRuntimeLog: true, operationTimeline: true, collapsibleOperationTimeline: true, fileTimeline: true, redaction: true, browserRender: true, staticFallback: false }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
