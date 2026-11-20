"use strict";
// Only callers with an explicit ephemeral-state allowlist may use this reader.
// Preserve the invalid bytes without renaming a concurrent writer's new file.
const fs = require("node:fs");
const crypto = require("node:crypto");
function readRuntimeJson(file, fallback) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  try { return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const backup = `${file}.corrupt-${digest}`;
    try {
      fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600, flush: true });
      console.warn(`Recovered corrupt volatile state: ${require("node:path").basename(file)}`);
    } catch (failure) { if (failure.code !== "EEXIST") throw failure; }
    return fallback;
  }
}
module.exports = {readRuntimeJson};
