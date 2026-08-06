"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.resolve(__dirname, "..");
const executable = path.join(root, "runtime", "ngrok", "ngrok.exe");
const pidFile = process.env.NGROK_PID_FILE;
if (!pidFile) throw new Error("NGROK_PID_FILE is required.");

fs.mkdirSync(path.dirname(pidFile), { recursive: true });
const child = childProcess.spawn(executable, process.argv.slice(2), {
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
  if (signal) process.stderr.write(`ngrok exited after signal ${signal}\n`);
  process.exitCode = Number.isInteger(code) ? code : 1;
});
