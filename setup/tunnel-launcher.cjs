"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.resolve(__dirname, "..");
const pidFile = process.env.TUNNEL_PID_FILE;
if (!pidFile) throw new Error("TUNNEL_PID_FILE is required.");

const requestedExecutable = path.resolve(String(process.argv[2] || ""));
const allowedExecutables = new Set([
  path.join(root, "runtime", "ngrok", "ngrok.exe").toLowerCase(),
  path.join(root, "runtime", "cloudflared", "cloudflared.exe").toLowerCase(),
]);
if (!allowedExecutables.has(requestedExecutable.toLowerCase())) {
  throw new Error(`Refusing unapproved tunnel executable: ${requestedExecutable}`);
}
if (!fs.existsSync(requestedExecutable)) {
  throw new Error(`Tunnel executable is missing: ${requestedExecutable}`);
}

fs.mkdirSync(path.dirname(pidFile), { recursive: true });
const child = childProcess.spawn(requestedExecutable, process.argv.slice(3), {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
fs.writeFileSync(pidFile, `${child.pid}\n`, "ascii");

function removeOwnPidFile() {
  try {
    if (fs.readFileSync(pidFile, "ascii").trim() === String(child.pid)) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

child.once("error", (error) => {
  removeOwnPidFile();
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  removeOwnPidFile();
  if (signal) process.stderr.write(`Tunnel process exited after signal ${signal}\n`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});
