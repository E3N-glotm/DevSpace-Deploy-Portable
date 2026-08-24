import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const uiRoot = resolve("vendor/waishnav-devspace/dist/ui");
const manifest = JSON.parse(await readFile(resolve(uiRoot, ".vite/manifest.json"), "utf8"));
const entry = manifest["workspace-app.html"];
if (!entry?.file) throw new Error("Vite manifest does not contain workspace-app.html.");
const target = resolve(uiRoot, entry.file);
const createdNeedle = "Y_=new v_({name:`devspace-tool-cards`,version:`0.4.0`},{}),Y_.ontoolresult=";
const createdReplacement = "Y_=new v_({name:`devspace-tool-cards`,version:`0.4.0`},{}),window.__DEVSPACE_MCP_APP__=Y_,window.__DEVSPACE_ATTACH_CONTINUATION__?.(Y_),Y_.ontoolresult=";
const connectedNeedle = "try{await Y_.connect();let e=Y_.getHostContext();";
const connectedReplacement = "try{await Y_.connect(),window.__DEVSPACE_CONTINUATION_CONNECTED__?.(Y_);let e=Y_.getHostContext();";
const teardownNeedle = "Y_.onteardown=async()=>(uv(),{});try{await Y_.connect()";
const teardownReplacement = "Y_.onteardown=async(e,t)=>(await window.__DEVSPACE_CONTINUATION_TEARDOWN__?.(Y_,e,t),uv(),{});try{await Y_.connect()";

let source = await readFile(target, "utf8");

function replaceOnce(needle, replacement, label) {
  if (source.includes(replacement)) return false;
  const first = source.indexOf(needle);
  const last = source.lastIndexOf(needle);
  if (first < 0) throw new Error(`Workspace App continuation patch anchor missing: ${label}`);
  if (first !== last) throw new Error(`Workspace App continuation patch anchor is not unique: ${label}`);
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
  return true;
}

const changed = [
  replaceOnce(createdNeedle, createdReplacement, "app-created"),
  replaceOnce(connectedNeedle, connectedReplacement, "app-connected"),
  replaceOnce(teardownNeedle, teardownReplacement, "app-teardown"),
].some(Boolean);

if (!source.includes("window.__DEVSPACE_ATTACH_CONTINUATION__?.(Y_)")) {
  throw new Error("Workspace App continuation created hook was not installed.");
}
if (!source.includes("window.__DEVSPACE_CONTINUATION_CONNECTED__?.(Y_)")) {
  throw new Error("Workspace App continuation connected hook was not installed.");
}
if (!source.includes("window.__DEVSPACE_CONTINUATION_TEARDOWN__?.(Y_,e,t)")) {
  throw new Error("Workspace App continuation teardown hook was not installed.");
}

if (changed) await writeFile(target, source, "utf8");
console.log(JSON.stringify({ target, changed }));
