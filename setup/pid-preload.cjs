"use strict";

const fs = require("fs");
const path = require("path");

const pidFile = process.env.DEVSPACE_PID_FILE;
if (!pidFile) throw new Error("DEVSPACE_PID_FILE is required.");

fs.mkdirSync(path.dirname(pidFile), { recursive: true });
fs.writeFileSync(pidFile, `${process.pid}\n`, "ascii");

function removeOwnPidFile() {
  try {
    if (fs.readFileSync(pidFile, "ascii").trim() === String(process.pid)) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

process.once("exit", removeOwnPidFile);
