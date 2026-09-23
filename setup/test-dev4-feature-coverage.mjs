import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {fileURLToPath} from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>readFileSync(join(root,p),"utf8");
const old=read("setup/native/DevSpacePortableApp.cs");
const next=read("ui-next/src/App.tsx")+read("ui-next/src/Operations.tsx")+
  read("ui-next/electron/main.cjs")+read("ui-next/electron/preload.cjs");
const actions=[...new Set([...old.matchAll(/RunJsonAsync\(\s*"([^"]+)"/g)].map(m=>m[1]))].sort();
const backendWorkerOnly=new Set(["ui-runtime-poll"]);
const missing=actions.filter(name=>!backendWorkerOnly.has(name)&&!next.includes(name));
assert.deepEqual(missing,[],
  "Existing WinForms manager actions must retain an equivalent new UI or main-process entrypoint");
assert.ok(next.includes("ensureComputerUseLease")&&read("setup/portable-manager.cjs").includes("ensureComputerUseBroker"),
  "Desktop control must retain the existing session-scoped broker despite replacing WinForms");
assert.ok(!next.includes("openLegacy(") && !next.includes("DevSpace-Portable-Next.exe"),
  "New UI must not invoke a second old control center");
const aliases=read("setup/build-native-ui.cjs");
assert.ok(aliases.includes('NEXT_IS_DEFAULT ? "DevSpacePortableNextLauncher.cs" : "DevSpacePortableApp.cs"'),
  "Dev4 default shortcut must start Electron instead of compiling the old control center");
const css=read("ui-next/src/styles.css").toLowerCase();
const palette=[
  ["#14263e","#ffffff"],["#415875","#ffffff"],
  ["#d1dff2","#101f38"],["#c5d2e8","#101f38"],
  ["#165635","#e9f9ef"],["#831b25","#fff0f2"],
];
function luminance(hex) {
  const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255);
  const lin=rgb.map(c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4));
  return .2126*lin[0]+.7152*lin[1]+.0722*lin[2];
}
for(const [foreground,background] of palette) {
  assert.ok(css.includes(foreground),"Missing contrast token: "+foreground);
  assert.ok((Math.max(luminance(foreground),luminance(background))+.05)/
    (Math.min(luminance(foreground),luminance(background))+.05)>=4.5,
    "Contrast below WCAG AA normal-text threshold: "+foreground+" on "+background);
}
console.log(JSON.stringify({
  historicalManagerActions:actions.length,substitutedDesktopActions:actions.length-backendWorkerOnly.size,
  backendWorkerOnly:[...backendWorkerOnly],missingActions:missing,
  legacyUiEntrypoints:0,contrastPairs:palette.length,
}));
