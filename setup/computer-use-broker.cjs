"use strict";

const fs = require("fs");
const path = require("path");
const manager = require("./portable-manager.cjs");

const ROOT = path.resolve(__dirname, "..");
const leaseId = String(process.argv[2] || process.env.DEVSPACE_COMPUTER_USE_LEASE_ID || "").trim();
const pollIntervalMs = 40;
let stopping = false;
let lastStateWriteAt = 0;
let announcedRunning = false;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function updateState(extra = {}, force = false) {
  const now = Date.now();
  if (!force && now - lastStateWriteAt < 1_000) return;
  lastStateWriteAt = now;
  const prior = manager.readJson(manager.COMPUTER_USE_BROKER_FILE, {});
  manager.writeJson(manager.COMPUTER_USE_BROKER_FILE, {
    formatVersion: 1,
    leaseId,
    pid: process.pid,
    startedAt: prior.startedAt || new Date().toISOString(),
    lastLoopAt: new Date().toISOString(),
    pollIntervalMs,
    transport: "local-file-queue",
    ...extra,
  });
}

function stop() {
  stopping = true;
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

async function main() {
  if (!leaseId) throw new Error("Computer Use broker requires a UI lease id.");
  process.chdir(ROOT);
  updateState({ status: "starting" }, true);
  while (!stopping) {
    const lease = manager.readJson(manager.UI_LEASE_FILE, null);
    const active = lease
      && lease.leaseId === leaseId
      && Date.parse(String(lease.expiresAt || "")) > Date.now();
    if (!active) break;
    const result = manager.processComputerUseRequests(lease);
    updateState({
      status: "running",
      processed: result.processed,
      failed: result.failed,
    }, !announcedRunning || Boolean(result.processed || result.failed));
    announcedRunning = true;
    await sleep(result.processed || result.failed ? 1 : pollIntervalMs);
  }
}

main()
  .catch((error) => {
    try {
      updateState({ status: "failed", error: String(error?.message || error).slice(-2_000) }, true);
    } catch {}
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      const state = manager.readJson(manager.COMPUTER_USE_BROKER_FILE, null);
      if (state?.pid === process.pid && state?.leaseId === leaseId) {
        fs.rmSync(manager.COMPUTER_USE_BROKER_FILE, { force: true });
      }
    } catch {}
  });
