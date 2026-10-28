import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const iconDir = path.join(root, "setup", "assets");
const ico = fs.readFileSync(path.join(iconDir, "devspace-portable.ico"));
const png = fs.readFileSync(path.join(iconDir, "devspace-portable.png"));
assert.equal(ico.readUInt16LE(0), 0, "ICO header reserved");
assert.equal(ico.readUInt16LE(2), 1, "Windows ICO icon resource");
const count = ico.readUInt16LE(4);
assert.ok(count >= 8, "The Windows icon must include multiple native DPI sizes");
const sizes = new Set();
for (let i = 0; i < count; i++) {
  const offset = 6 + i * 16;
  const size = (value) => value === 0 ? 256 : value;
  const width = size(ico[offset]);
  const height = size(ico[offset + 1]);
  assert.equal(width, height);
  const bytes = ico.readUInt32LE(offset + 8);
  const start = ico.readUInt32LE(offset + 12);
  assert.ok(bytes > 50 && start + bytes <= ico.length, "ICO frame bounds");
  sizes.add(width);
}
for (const expected of [16, 20, 24, 32, 40, 48, 64, 128, 256])
  assert.ok(sizes.has(expected), `Missing ${expected}px DPI icon frame`);
assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(png.readUInt32BE(16), 256);
assert.equal(png.readUInt32BE(20), 256);

const main = fs.readFileSync(path.join(root, "ui-next", "electron", "main.cjs"), "utf8");
const nativeBuilder = fs.readFileSync(path.join(root, "setup", "build-native-ui.cjs"), "utf8");
assert.match(main, /icon: BRAND_ICON_ICO/, "Electron window must show branded taskbar icon");
assert.match(main, /nativeImage\.createFromPath\(BRAND_ICON_ICO\)/,
  "Tray must use the multi-size branded icon, not the launcher file icon");
assert.doesNotMatch(main, /app\.getFileIcon\(/, "Do not fall back to generic Windows executable icon");
assert.match(nativeBuilder, /\/win32icon:/, "The compiled launcher must embed a real icon resource");
console.log("Windows native EXE, Electron taskbar, tray, and multi-DPI icon contract passed.");
