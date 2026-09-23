import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = readFileSync(resolve(root,
  "vendor/waishnav-devspace/dist/ui/assets/runtime-enhancements.js"), "utf8");

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.open = false;
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { return this.listeners.get("click")?.({ target: this, defaultPrevented: false }); }
}

function makeCard(host, storage, generation = 7) {
  const window = {
    openai: host,
    __DEVSPACE_CONTINUATION_SURFACE__: { kind: "continuation-anchor", anchorMountGeneration: generation },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    addEventListener() {},
  };
  const sandbox = {
    window, navigator: { language: "zh-CN" },
    document: {
      querySelector() { return null; },
      createElement(tag) { return new FakeElement(tag); },
    },
    queueMicrotask, console,
  };
  runInNewContext(`${source}\n;globalThis.cardTest = {
    disclosureKey, readDisclosureChoice, writeDisclosureChoice, preserveDisclosure,
    addCardDisplayActions, buildContinuationCard, state
  };`, sandbox, { filename: "runtime-enhancements.js", timeout: 2000 });
  return sandbox.cardTest;
}

const storage = new Map();
const calls = [];
const host = {
  widgetState: { otherComponent: { unchanged: true } },
  setWidgetState(next) { calls.push(next); }, // Simulate delayed Host state delivery.
  async requestDisplayMode(args) { assert.equal(args.mode, "fullscreen"); calls.push(args); },
};
const card = makeCard(host, storage);
const privateKey = "runtime:node --password=secret-do-not-persist";
card.writeDisclosureChoice(privateKey, true);
card.writeDisclosureChoice("continuation:task:7", false);
assert.equal(calls.length, 2);
const snapshot = calls.at(-1);
assert.equal(snapshot.otherComponent.unchanged, true);
assert.equal(snapshot.devspaceCardV1.scope, "continuation-anchor:7");
assert.equal(Object.keys(snapshot.devspaceCardV1.disclosure).length, 2,
  "rapid state writes must not overwrite an earlier disclosure choice");
assert.equal(JSON.stringify(snapshot).includes("secret-do-not-persist"), false);
assert.equal(card.readDisclosureChoice(privateKey), true);
assert.equal(card.readDisclosureChoice("continuation:task:7"), false);

host.widgetState = snapshot;
const restored = makeCard(host, new Map(), 7);
const panel = new FakeElement("details");
restored.preserveDisclosure(panel, "continuation:task:7", true);
assert.equal(panel.open, false);
assert.equal(makeCard(host, new Map(), 8).readDisclosureChoice("continuation:task:7"), undefined,
  "a new card generation must not inherit the previous generation's UI state");

// The in-place DOM reconciler keeps the old <details> event listener. It must
// consume the new generation's DOM identity rather than saving the old key.
panel.setAttribute("data-devspace-disclosure-key", restored.disclosureKey("continuation:task:8"));
panel.open = true;
panel.listeners.get("click")({
  target: { closest(tag) { return tag === "summary" ? { parentElement: panel } : null; } },
  defaultPrevented: false,
});
assert.equal(restored.readDisclosureChoice("continuation:task:8"), false,
  "reconciled cards must bind the current generation's disclosure preference");

const plainHost = makeCard(undefined, storage);
plainHost.writeDisclosureChoice("plain-host", true);
assert.equal(makeCard(undefined, storage).readDisclosureChoice("plain-host"), true,
  "non-ChatGPT MCP hosts must use sessionStorage fallback");

const body = new FakeElement("div");
const beforeFullscreen = calls.length;
card.addCardDisplayActions(body, panel);
const button = body.children[0].children[0];
assert.equal(calls.length, beforeFullscreen, "rendering must never trigger fullscreen");
await button.click();
assert.equal(calls.length, beforeFullscreen + 1);
assert.equal(button.disabled, false);

const inlineStorage = new Map();
const fallback = makeCard({}, inlineStorage);
const inlinePanel = new FakeElement("details");
inlinePanel.setAttribute("data-devspace-disclosure-key", fallback.disclosureKey("continuation:inline:7"));
const inlineBody = new FakeElement("div");
fallback.addCardDisplayActions(inlineBody, inlinePanel);
await inlineBody.children[0].children[0].click();
assert.equal(inlinePanel.open, true);
assert.match(inlineBody.children[0].children[1].textContent, /不支持全屏/);
assert.equal(makeCard({}, inlineStorage).readDisclosureChoice("continuation:inline:7"), true,
  "inline fallback must preserve its expanded state when the Host does not support fullscreen");

const declined = makeCard({ async requestDisplayMode() { throw new Error("Host declined"); } }, new Map());
const declinedPanel = new FakeElement("details");
const declinedBody = new FakeElement("div");
declined.addCardDisplayActions(declinedBody, declinedPanel);
await declinedBody.children[0].children[0].click();
assert.equal(declinedPanel.open, true);
assert.equal(declinedBody.children[0].children[0].disabled, false);

// Optional bridge calls can fail after the synchronous click handler returns.
// The inline preference must still work and a rejected Host promise must not
// escape as an unhandled rejection.
const rejectingStorage = new Map();
const rejectingHost = makeCard({
  widgetState: {},
  setWidgetState() { return Promise.reject(new Error("Host disposed the widget")); },
}, rejectingStorage);
rejectingHost.writeDisclosureChoice("disconnected-host", true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(makeCard(undefined, rejectingStorage).readDisclosureChoice("disconnected-host"), true);

card.state.continuationTask = {
  id: "task-smoke", state: "RUNNING",
  requiredMilestones: ["verify", "deploy"], completedMilestones: ["verify"],
};
const beforeBuild = calls.length;
const tree = card.buildContinuationCard();
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return undefined;
}
const progress = find(tree, (item) => item.className === "devspace-milestone-progress");
assert.ok(progress);
assert.equal(progress.attributes["aria-valuemax"], "2");
assert.equal(progress.attributes["aria-valuenow"], "1");
assert.equal(progress.children[0].style.width, "50%");
assert.equal(calls.length, beforeBuild, "rendering a milestone card must not issue Host actions");

console.log(JSON.stringify({
  hostWidgetState: true, rapidStateWritesPreserved: true, noSensitivePersistence: true,
  generationScopedState: true, nonChatGptFallback: true, fullscreenOnUserClick: true,
  fullscreenUnavailableFallback: true, rejectedHostStateFallback: true,
  accessibleMilestoneProgress: true,
  renderingDoesNotTriggerHostActions: true,
}));
