"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const [, , logFile, executable, ...args] = process.argv;
if (!logFile || !executable) {
  process.stderr.write("Usage: logged-launcher.cjs <log-file> <executable> [args...]\n");
  process.exit(2);
}

fs.mkdirSync(path.dirname(logFile), { recursive: true });
const logFd = fs.openSync(logFile, "a");
const child = childProcess.spawn(executable, args, {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["ignore", logFd, logFd],
  env: process.env,
});

let closing = false;
function forward(signal) {
  if (closing) return;
  closing = true;
  try { child.kill(signal); } catch {}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => forward(signal));
}

child.on("error", (error) => {
  try { fs.writeSync(logFd, `\n[launcher-error] ${error.stack || error.message || error}\n`); } catch {}
  try { fs.closeSync(logFd); } catch {}
  process.exit(1);
});

child.on("exit", (code, signal) => {
  try { fs.closeSync(logFd); } catch {}
  if (signal) process.exit(1);
  process.exit(Number.isInteger(code) ? code : 1);
});
