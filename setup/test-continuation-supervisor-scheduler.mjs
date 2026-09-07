import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createContinuationSupervisorScheduler } from "../vendor/waishnav-devspace/dist/continuation-supervisor.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reasons = [];
let sweepCount = 0;
const runtimeState = {
  continuationSupervisorSweep() {
    sweepCount += 1;
    return {
      ready: sweepCount === 1
        ? [{ conversationScopeId: "scope:test", worksetId: "workset:test", generation: 7 }]
        : [],
      deliveryAckRetryDue: [],
    };
  },
};

const supervisor = createContinuationSupervisorScheduler({
  runtimeState,
  intervalMs: 20,
  claimRecoveryGraceMs: 2,
  onSweep(_sweep, reason) {
    reasons.push(reason);
  },
});

supervisor.start();
assert.equal(reasons[0], "startup", "startup must immediately recover durable expired continuation state");

const scheduled = supervisor.scheduleClaimRecovery({
  accepted: true,
  deliveryToken: randomUUID(),
  claimDueAt: new Date(Date.now() + 35).toISOString(),
});
assert.equal(scheduled, true, "accepted sender claim must register an exact lease recovery timer");
assert.equal(supervisor.pendingClaimRecoveryCount, 1);

await sleep(90);

assert.ok(reasons.includes("interval"), "resident interval sweep must run without App traffic");
assert.ok(reasons.includes("sender-claim-lease"), "expired sender claim must trigger an independent recovery sweep");
assert.equal(supervisor.pendingClaimRecoveryCount, 0, "claim recovery timer must self-clean after firing");

const beforeStop = sweepCount;
supervisor.stop();
await sleep(50);
assert.equal(sweepCount, beforeStop, "stopped supervisor must not continue sweeping");

console.log(JSON.stringify({
  ok: true,
  sweepCount,
  reasons,
}, null, 2));
