import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Browser-only regression; pass an installed playwright-core directory.
// This keeps browser tooling outside the Portable production dependency tree.
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(process.argv[2]));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const assets = resolve("vendor/waishnav-devspace/dist/ui/assets");
const script = await readFile(resolve(assets, "runtime-enhancements.js"), "utf8");
const css = (await Promise.all(["workspace-app-CvhbU3tQ.css", "runtime-enhancements.css", "runtime-timeline.css"]
  .map(name => readFile(resolve(assets, name), "utf8")))).join("\n");
await page.route("https://devspace-card.test/**", route => route.fulfill({
  contentType: "text/html", body: '<html><head></head><body><main id="app"></main></body></html>'
}));
async function boot() {
  await page.goto("https://devspace-card.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script, type: "module" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}
const task = { id: "task-ui-regression", anchorMountGeneration: 1, state: "RUNNING",
  objective: "Keep explicit folding during progress", requiredMilestones: ["first", "second"],
  completedMilestones: [], continuationMode: "completion-driven", continuationCount: 0 };
async function notify(value) {
  await page.evaluate(task => {
    window.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { _meta: { tool: "continuation_anchor" }, structuredContent: { task } } }, "*");
  }, value);
  await page.waitForFunction(() => !!document.querySelector(".continuation-card"));
}
async function update(value) {
  await page.evaluate(task => window.dispatchEvent(new CustomEvent("devspace:continuation-task", { detail: task })), value);
}
const panel = () => page.locator(".continuation-card");
try {
  await boot();
  await notify(task);
  assert.equal(await panel().evaluate(node => node.open), true);
  await panel().locator(":scope > summary").click();
  assert.equal(await panel().evaluate(node => node.open), false);
  const height = await panel().evaluate(node => node.getBoundingClientRect().height);
  // Distinct progress updates must retain collapse and the visible height.
  for (let i = 0; i < 20; i++) {
    await update({ ...task, continuationCount: i, turnLeaseExpiresAt: String(i) });
    assert.equal(await panel().evaluate(node => node.open), false);
    assert.equal(await panel().evaluate(node => node.getBoundingClientRect().height), height);
  }
  // Duplicate snapshots must keep the actual DOM node, not just look identical.
  await update(task);
  await panel().evaluate(node => { window.savedPanel = node; });
  for (let i = 0; i < 10; i++) await update(task);
  assert.equal(await panel().evaluate(node => node === window.savedPanel), true);
  // Exercise the native click/update race before the deferred toggle event.
  await panel().evaluate((node, task) => {
    node.querySelector("summary").click();
    window.dispatchEvent(new CustomEvent("devspace:continuation-task", { detail: { ...task, continuationCount: 30 } }));
  }, task);
  assert.equal(await panel().evaluate(node => node.open), true);
  await panel().locator(":scope > summary").click();
  await boot();
  await notify(task);
  assert.equal(await panel().evaluate(node => node.open), false, "same immutable card rehydrates collapsed");
  await update({ ...task, anchorMountGeneration: 2 });
  assert.equal(await panel().evaluate(node => node.open), true, "new manual card has its own disclosure choice");
  await update({ ...task, anchorMountGeneration: 3, state: "SUCCEEDED", completedMilestones: ["first", "second"] });
  assert.equal(await panel().evaluate(node => node.open), false, "completed cards default to collapsed");
  // Repeat tool results, including deferred renders, must not reopen the card.
  await update({ ...task, anchorMountGeneration: 4 });
  await panel().locator(":scope > summary").click();
  await notify({ ...task, anchorMountGeneration: 4 });
  await page.waitForTimeout(250);
  assert.equal(await panel().evaluate(node => node.open), false);
  assert.deepEqual(errors, []);
  console.log("PASS browser disclosure: progress, stable height, duplicate DOM identity, click race, rehydrate, generation isolation, terminal default, repeated tool results");

  // Exercise the shipped SDK, bootstrap and its real size-changed messages in
  // an iframe. The parent is a deterministic test Host, not a live ChatGPT session.
  const { workspaceAppHtml } = await import("../app/node_modules/@waishnav/devspace/dist/server.js");
  const shippedScript = await readFile(resolve("app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js"), "utf8");
  const integratedHtml = workspaceAppHtml({ publicBaseUrl: "https://devspace-card.test" })
    .replace(shippedScript.replace(/<\/script/gi, "<\\/script"), script.replace(/<\/script/gi, "<\\/script"));
  await page.route("https://devspace-card.test/embedded", route => route.fulfill({ contentType: "text/html", body: integratedHtml }));
  const hostHtml = '<html><body><iframe id="card" src="/embedded" style="width:750px;border:0"></iframe></body></html>';
  await page.route("https://devspace-card.test/host", route => route.fulfill({ contentType: "text/html", body: hostHtml }));
  await page.addInitScript(() => {
    if (window.parent !== window) return;
    window.sizeHistory = [];
    window.hostMethods = [];
    window.addEventListener("message", event => {
      const message = event.data;
      if (message?.jsonrpc !== "2.0") return;
      window.hostMethods.push(message.method || "response");
      if (message.method === "ui/initialize") {
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params.protocolVersion,
          hostInfo: { name: "disclosure-test-host", version: "1.0" },
          hostCapabilities: { serverTools: {} },
          hostContext: { theme: "dark", toolInfo: { tool: {
            name: "continuation_anchor", inputSchema: { type: "object", properties: {} }
          } } }
        } }, "*");
      } else if (message.method === "ui/notifications/size-changed") {
        window.sizeHistory.push(message.params.height);
        document.querySelector("iframe").style.height = message.params.height + "px";
      } else if (message.id !== undefined) {
        event.source.postMessage({ jsonrpc: "2.0", id: message.id,
          result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } }, "*");
      }
    });
  });
  await page.goto("https://devspace-card.test/host");
  const frame = page.frameLocator("#card");
  await frame.locator("#app").waitFor();
  await page.waitForTimeout(300);
  async function hostNotify(value) {
    await page.evaluate(task => document.querySelector("iframe").contentWindow.postMessage({
      jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { _meta: { tool: "continuation_anchor" }, structuredContent: { task } }
    }, "*"), value);
  }
  const bootstrapText = await frame.locator("#app").innerText();
  await hostNotify({ ...task, anchorMountGeneration: 5 });
  const embeddedPanel = frame.locator(".continuation-card");
  await embeddedPanel.waitFor();
  await embeddedPanel.locator(":scope > summary").click();
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => window.sizeHistory.length > 0),
    "the SDK must actually send size notifications before checking stability: " + JSON.stringify({
      methods: await page.evaluate(() => window.hostMethods),
      bootstrapText,
      app: await embeddedPanel.evaluate(() => ({
        available: !!window.__DEVSPACE_MCP_APP__,
        host: window.__DEVSPACE_MCP_APP__?.getHostContext?.(),
        initialized: window.__DEVSPACE_MCP_APP__?._initializedSent,
        options: window.__DEVSPACE_MCP_APP__?.options,
      }))
    }));
  await page.evaluate(() => { window.sizeHistory = []; });
  for (let i = 0; i < 10; i++) {
    await hostNotify({ ...task, anchorMountGeneration: 5, continuationCount: i });
    await page.waitForTimeout(40);
    assert.equal(await embeddedPanel.evaluate(node => node.open), false);
  }
  await page.waitForTimeout(300);
  const sizes = await page.evaluate(() => window.sizeHistory);
  assert.ok(new Set(sizes).size <= 1, "collapsed integrated card must not oscillate Host iframe height: " + JSON.stringify(sizes));
  assert.deepEqual(errors, []);
  console.log("PASS integrated iframe SDK bootstrap, repeated results and stable Host size notifications", JSON.stringify(sizes));
} finally { await browser.close(); }
