import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneCanonicalRepairBackups } from "../vendor/waishnav-devspace/dist/db/state-maintenance.js";

const root = mkdtempSync(join(tmpdir(), "devspace-state-maintenance-"));
try {
  const protectedFiles = [
    "devspace.sqlite",
    "devspace.sqlite-wal",
    "devspace.sqlite-shm",
    "other-backup.sqlite",
    "devspace-before-canonical-repair-not-a-timestamp.sqlite",
  ];
  for (const name of protectedFiles) writeFileSync(join(root, name), Buffer.from("protected"));

  const backups = [
    "devspace-before-canonical-repair-2026-09-02T10-00-00-000Z.sqlite",
    "devspace-before-canonical-repair-2026-09-02T11-00-00-000Z.sqlite",
    "devspace-before-canonical-repair-2026-09-02T12-00-00-000Z.sqlite",
    "devspace-before-canonical-repair-2026-09-02T13-00-00-000Z.sqlite",
    "devspace-before-canonical-repair-2026-09-02T14-00-00-000Z.sqlite",
  ];
  backups.forEach((name, index) => {
    const path = join(root, name);
    writeFileSync(path, Buffer.alloc(10, index + 1));
    const timestamp = new Date(`2026-09-02T${String(10 + index).padStart(2, "0")}:00:00Z`);
    utimesSync(path, timestamp, timestamp);
  });

  const result = pruneCanonicalRepairBackups(root, { maxCount: 3, maxBytes: 25 });
  assert.equal(result.matchedCount, 5);
  assert.equal(result.keptCount, 2, "byte cap should remove older backups even before count cap is reached");
  assert.equal(result.keptBytes, 20);
  assert.equal(result.removedCount, 3);
  assert.deepEqual(result.kept, backups.slice(-2).reverse(), "newest matching backups must be retained first");

  const remaining = new Set(readdirSync(root));
  for (const name of protectedFiles) {
    assert.ok(remaining.has(name), `${name} must never be touched by canonical-repair retention`);
    assert.equal(statSync(join(root, name)).size, Buffer.byteLength("protected"));
  }
  for (const name of backups.slice(0, 3)) assert.ok(!remaining.has(name), `${name} should be pruned`);
  for (const name of backups.slice(-2)) assert.ok(remaining.has(name), `${name} should be retained`);

  const oversized = "devspace-before-canonical-repair-2026-09-02T15-00-00-000Z.sqlite";
  writeFileSync(join(root, oversized), Buffer.alloc(30, 7));
  const timestamp = new Date("2026-09-02T15:00:00Z");
  utimesSync(join(root, oversized), timestamp, timestamp);
  const oversizedResult = pruneCanonicalRepairBackups(root, { maxCount: 1, maxBytes: 20 });
  assert.equal(oversizedResult.keptCount, 1);
  assert.deepEqual(oversizedResult.kept, [oversized], "the newest snapshot is always retained even when it alone exceeds the cap");
  assert.equal(oversizedResult.removedCount, 2);

  console.log("PASS: canonical-repair backup retention is count/size bounded and preserves authoritative state files");
}
finally {
  rmSync(root, { recursive: true, force: true });
}
