import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "devspace-computer-use-batch-"));
const runDir = join(temporary, "run");
const requestDir = join(runDir, "computer-use", "requests");
const responseDir = join(runDir, "computer-use", "responses");
mkdirSync(requestDir, { recursive: true });
mkdirSync(responseDir, { recursive: true });
process.env.DEVSPACE_PORTABLE_ROOT = ROOT;
process.env.DEVSPACE_PORTABLE_RUN_DIR = runDir;

const { performComputerAction } = await import("../app/node_modules/@waishnav/devspace/dist/computer-use.js");
const leaseId = "test-batch-lease";

async function wait(milliseconds) {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function mockWorker() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const files = (await import("node:fs/promises")).readdir(requestDir).catch(() => []);
    for (const name of await files) {
      if (!name.endsWith(".json")) continue;
      const request = JSON.parse(readFileSync(join(requestDir, name), "utf8"));
      assert.equal(request.leaseId, leaseId);
      assert.equal(request.payload.action, "sequence");
      assert.equal(request.payload.steps.length, 20);
      const id = request.requestId;
      writeFileSync(join(responseDir, `${id}.json`), JSON.stringify({
        formatVersion: 1,
        requestId: id,
        success: true,
        metadata: {
          action: "sequence",
          steps: request.payload.steps.length,
          screenshot: false,
          inputBackend: "native-ui-sendinput",
          queueWaitMs: 1,
          inputElapsedMs: 2,
          totalElapsedMs: 3,
        },
        stderr: "",
      }));
      return;
    }
    await wait(2);
  }
  throw new Error("Mock Computer Use worker did not receive a request.");
}

try {
  const worker = mockWorker();
  const steps = Array.from({ length: 20 }, () => ({ action: "move", x: 100, y: 100 }));
  const startedAt = performance.now();
  const result = await performComputerAction({ action: "sequence", steps }, { leaseId });
  await worker;
  const elapsedMs = Math.round(performance.now() - startedAt);
  assert.equal(result.metadata.action, "sequence");
  assert.equal(result.metadata.steps, 20);
  assert.equal(result.metadata.inputBackend, "native-ui-sendinput");
  assert.equal(result.image, undefined);
  assert.ok(elapsedMs < 500, `batch protocol took ${elapsedMs} ms`);
console.log(`DevSpace 1.1.22 Computer Use batch protocol test passed in ${elapsedMs} ms.`);
}
finally {
  rmSync(temporary, { recursive: true, force: true });
}
