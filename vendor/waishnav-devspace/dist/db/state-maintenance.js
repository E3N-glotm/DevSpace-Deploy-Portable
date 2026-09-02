import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CANONICAL_REPAIR_BACKUP_PATTERN = /^devspace-before-canonical-repair-[0-9TZ._-]+\.sqlite$/;
export const DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_COUNT = 3;
export const DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_BYTES = 512 * 1024 * 1024;

export function pruneCanonicalRepairBackups(stateDir, options = {}) {
    const maxCount = Math.max(1, Math.trunc(Number(options.maxCount ?? DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_COUNT)) || DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_COUNT);
    const maxBytes = Math.max(1, Math.trunc(Number(options.maxBytes ?? DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_BYTES)) || DEFAULT_CANONICAL_REPAIR_BACKUP_MAX_BYTES);
    const candidates = readdirSync(stateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && CANONICAL_REPAIR_BACKUP_PATTERN.test(entry.name))
        .map((entry) => {
        const path = join(stateDir, entry.name);
        const stat = statSync(path);
        return { name: entry.name, path, size: stat.size, mtimeMs: stat.mtimeMs };
    })
        .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    const kept = [];
    const removed = [];
    let keptBytes = 0;
    for (const candidate of candidates) {
        // Always preserve the newest repair snapshot even if it alone exceeds the
        // byte cap. Every older snapshot must satisfy both count and byte budgets.
        const fitsCount = kept.length < maxCount;
        const fitsBytes = keptBytes + candidate.size <= maxBytes;
        if (kept.length === 0 || (fitsCount && fitsBytes)) {
            kept.push(candidate);
            keptBytes += candidate.size;
            continue;
        }
        unlinkSync(candidate.path);
        removed.push(candidate);
    }
    return {
        matchedCount: candidates.length,
        keptCount: kept.length,
        keptBytes,
        removedCount: removed.length,
        removedBytes: removed.reduce((total, entry) => total + entry.size, 0),
        kept: kept.map((entry) => entry.name),
        removed: removed.map((entry) => entry.name),
    };
}
