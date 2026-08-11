import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
const MAX_ACTIVE_WATCHES = 64;

export class FileWatchManager {
    runtimeState;
    watches = new Map();
    constructor(runtimeState) {
        this.runtimeState = runtimeState;
    }
    start(input) {
        const watchId = input.watchId?.trim() || `watch_${randomUUID()}`;
        if (this.watches.has(watchId))
            throw new Error(`Watch is already active: ${watchId}`);
        if (this.watches.size >= MAX_ACTIVE_WATCHES)
            throw new Error(`DevSpace refuses to retain more than ${MAX_ACTIVE_WATCHES} active file watches.`);
        let watcher;
        try {
            watcher = watch(input.path, { recursive: input.recursive !== false, persistent: false }, (eventType, filename) => {
                const changedPath = filename ? String(filename) : input.path;
                this.runtimeState.appendEvent({
                    kind: "fs.changed",
                    subject: watchId,
                    workspaceId: input.workspaceId,
                    payload: { eventType, changedPath, watchedPath: input.path },
                });
            });
        }
        catch (error) {
            throw new Error(`Unable to watch ${input.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        watcher.on("error", (error) => {
            this.runtimeState.appendEvent({
                kind: "fs.watch.error",
                subject: watchId,
                workspaceId: input.workspaceId,
                payload: { path: input.path, error: error.message },
            });
        });
        const record = {
            watchId,
            workspaceId: input.workspaceId,
            path: input.path,
            recursive: input.recursive !== false,
            startedAt: new Date().toISOString(),
            watcher,
        };
        this.watches.set(watchId, record);
        this.runtimeState.upsertWatch(record);
        const sequence = this.runtimeState.appendEvent({
            kind: "fs.watch.started",
            subject: watchId,
            workspaceId: input.workspaceId,
            payload: { path: input.path, recursive: record.recursive },
        });
        return { ...record, watcher: undefined, sequence };
    }
    stop(watchId) {
        const record = this.watches.get(watchId);
        if (!record)
            throw new Error(`Unknown active watch: ${watchId}`);
        record.watcher.close();
        this.watches.delete(watchId);
        this.runtimeState.stopWatch(watchId);
        const sequence = this.runtimeState.appendEvent({
            kind: "fs.watch.stopped",
            subject: watchId,
            workspaceId: record.workspaceId,
            payload: { path: record.path },
        });
        return { watchId, stopped: true, sequence };
    }
    list(input = {}) {
        return this.runtimeState.listWatches(input).map((record) => ({
            ...record,
            attached: this.watches.has(record.watchId),
        }));
    }
    poll(input) {
        return this.runtimeState.pollEvents({
            afterSequence: input.afterSequence,
            subject: input.watchId,
            workspaceId: input.workspaceId,
            limit: input.limit,
        });
    }
    close() {
        for (const record of this.watches.values())
            record.watcher.close();
        this.watches.clear();
    }
}
