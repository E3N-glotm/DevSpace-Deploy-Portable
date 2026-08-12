import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    readlink,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createTwoFilesPatch, diffLines } from "diff";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const FORMAT_VERSION = 4;
const SESSION_DIRECTORY = "review-sessions-v4";
const LEGACY_DIRECTORIES = ["review-sessions-v3", "review-repositories-v3"];
const MAX_TRACKED_FILES = 2048;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_STORED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_STATE_BYTES = 512 * 1024 * 1024;
const MAX_EMPTY_SESSION_DIRECTORIES = 30;
const MAX_SAFETY_SNAPSHOTS = 5;
const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const SAMPLE_BYTES = 64 * 1024;
const MAX_CACHED_REVIEW_STATES = 32;
const cleanupScheduled = new Set();

export function createReviewCheckpointManager(options = {}) {
    const stateDir = options.stateDir ?? join(process.cwd(), ".devspace-state");
    const sessionReviewEnabled = options.sessionReviewEnabled !== false;
    const states = new Map();
    scheduleLegacyCleanup(stateDir);

    async function ensureState(workspaceId, root) {
        const absoluteRoot = resolve(root);
        let state = states.get(workspaceId);
        if (!state || state.root !== absoluteRoot) {
            state = await loadOrCreateSession(stateDir, workspaceId, absoluteRoot);
        }
        // Session JSON/object storage on disk is authoritative. Keep only a
        // bounded LRU of hot review states so repeated workspace opens cannot
        // grow the DevSpace Node heap without limit.
        states.delete(workspaceId);
        states.set(workspaceId, state);
        while (states.size > MAX_CACHED_REVIEW_STATES) {
            const oldestId = states.keys().next().value;
            if (!oldestId)
                break;
            states.delete(oldestId);
        }
        return state;
    }

    const manager = {
        async initializeWorkspace({ workspaceId, root }) {
            const state = await ensureState(workspaceId, root);
            state.status = "active";
            state.updatedAt = new Date().toISOString();
            await saveSession(stateDir, state);
            await pruneReviewState(stateDir, state.sessionId);
            return publicSession(state);
        },

        async beginUiSession({ workspaceId, root }) {
            const state = await ensureState(workspaceId, root);
            return sessionIdentity(state);
        },

        async beforeMutation({ workspaceId, root, paths = [], kind = "structured" }) {
            if (!sessionReviewEnabled)
                return { active: false, reason: "Session review is disabled" };
            const state = await ensureState(workspaceId, root);
            const requestedPaths = [...new Set((Array.isArray(paths) ? paths : [])
                .map((item) => normalizeTrackedPath(state.root, item))
                .filter(Boolean))];
            if (requestedPaths.length === 0) {
                if (kind === "shell") {
                    state.shellMutationObserved = true;
                    addLimitation(state,
                        "An arbitrary shell mutation was allowed without declared paths. " +
                        "Review and rollback cover only paths explicitly captured by structured file tools.");
                    state.updatedAt = new Date().toISOString();
                    await saveSession(stateDir, state);
                    await pruneReviewState(stateDir, state.sessionId);
                }
                return { ...sessionIdentity(state), trackedPaths: Object.keys(state.tracked ?? {}).length };
            }
            if (Object.keys(state.tracked ?? {}).length + requestedPaths.length > MAX_TRACKED_FILES) {
                throw new Error(`Session review refuses to track more than ${MAX_TRACKED_FILES} paths in one workspace session.`);
            }
            state.tracked ??= {};
            for (const trackedPath of requestedPaths) {
                if (state.tracked[trackedPath])
                    continue;
                const captured = await captureDescriptor(stateDir, state, trackedPath, true);
                state.tracked[trackedPath] = {
                    baseline: captured.descriptor,
                    lastShown: captured.descriptor,
                };
            }
            if (!state.baselineCreatedAt)
                state.baselineCreatedAt = new Date().toISOString();
            state.updatedAt = new Date().toISOString();
            await pruneObjects(stateDir, state);
            await saveSession(stateDir, state);
            await pruneReviewState(stateDir, state.sessionId);
            return { ...sessionIdentity(state), trackedPaths: Object.keys(state.tracked).length };
        },

        async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
            const state = await ensureState(workspaceId, root);
            const comparison = await compareTrackedPaths(
                stateDir,
                state,
                since === "workspace_open" ? "baseline" : "lastShown",
                markReviewed,
            );
            if (markReviewed) {
                state.updatedAt = new Date().toISOString();
                await pruneObjects(stateDir, state);
            }
            state.lastReview = comparison.summary;
            await saveSession(stateDir, state);
            return reviewResult(comparison, since);
        },

        async sessionReview({ workspaceId, root }) {
            const state = await ensureState(workspaceId, root);
            if (!sessionReviewEnabled)
                return inactiveSessionReview("Session review is disabled");
            const comparison = await compareTrackedPaths(stateDir, state, "baseline", false);
            state.lastReview = comparison.summary;
            state.updatedAt = new Date().toISOString();
            await saveSession(stateDir, state);
            return sessionReviewResult(state, comparison);
        },

        async rollbackSession({ workspaceId, root, confirmation, forcePartial = false }) {
            const state = await ensureState(workspaceId, root);
            return rollbackState(stateDir, state, confirmation, Boolean(forcePartial));
        },
    };
    return manager;
}

export async function reviewAdmin({ stateDir, action, payload = {} }) {
    if (!stateDir)
        throw new Error("reviewAdmin requires stateDir");
    scheduleLegacyCleanup(stateDir);
    if (action === "list") {
        const sessions = await loadAllSessions(stateDir);
        return {
            sessions: sessions
                .filter((item) => payload.includeHidden || !item.hidden)
                .filter((item) => payload.includeArchived || item.status !== "archived")
                .sort(sessionSort)
                .map(publicSession),
        };
    }
    const sessionId = String(payload.sessionId || "");
    if (!sessionId)
        throw new Error("sessionId is required");
    const state = await loadSessionById(stateDir, sessionId);
    if (!state)
        throw new Error(`Review session not found: ${sessionId}`);
    if (action === "details") {
        const comparison = existsSync(state.root)
            ? await compareTrackedPaths(stateDir, state, "baseline", false)
            : emptyComparison(state.limitations ?? []);
        state.lastReview = comparison.summary;
        state.updatedAt = new Date().toISOString();
        await saveSession(stateDir, state);
        const review = sessionReviewResult(state, comparison);
        return {
            session: publicSession(state),
            summary: comparison.summary,
            files: comparison.files,
            patch: comparison.patch,
            confirmationToken: confirmationToken(state),
            canRollback: review.canRollback,
            rollbackCoverage: review.rollbackCoverage,
            limitations: review.limitations,
            safetySnapshots: state.safetySnapshots ?? [],
        };
    }
    if (action === "update") {
        if (payload.title !== undefined) {
            const title = String(payload.title || "").trim();
            state.title = title || basename(state.root);
        }
        if (payload.pinned !== undefined)
            state.pinned = Boolean(payload.pinned);
        if (payload.hidden !== undefined)
            state.hidden = Boolean(payload.hidden);
        if (payload.status !== undefined) {
            const status = String(payload.status);
            if (!new Set(["active", "completed", "archived"]).has(status))
                throw new Error(`Unsupported review-session status: ${status}`);
            state.status = status;
        }
        state.updatedAt = new Date().toISOString();
        await saveSession(stateDir, state);
        return { session: publicSession(state) };
    }
    if (action === "rollback") {
        return rollbackState(stateDir, state, String(payload.confirmation || ""), Boolean(payload.forcePartial));
    }
    if (action === "restore-safety") {
        return restoreSafetySnapshot(stateDir, state, payload);
    }
    throw new Error(`Unsupported reviewAdmin action: ${action}`);
}

async function rollbackState(stateDir, state, confirmation, forcePartial) {
    if (confirmation !== confirmationToken(state))
        throw new Error(`Confirmation must exactly equal: ${confirmationToken(state)}`);
    const comparison = await compareTrackedPaths(stateDir, state, "baseline", false);
    if (comparison.summary.files === 0) {
        return { restored: 0, paths: [], partial: false, checkpointId: state.sessionId };
    }
    const safetyPaths = {};
    const restorable = [];
    const unsupported = [];
    for (const file of comparison.files) {
        const tracked = state.tracked?.[file.path];
        if (!tracked || !descriptorRestorable(tracked.baseline)) {
            unsupported.push(file.path);
            continue;
        }
        const current = await captureDescriptor(stateDir, state, file.path, true);
        if (!descriptorRestorable(current.descriptor)) {
            unsupported.push(file.path);
            continue;
        }
        safetyPaths[file.path] = current.descriptor;
        restorable.push(file.path);
    }
    if (unsupported.length && !forcePartial) {
        throw new Error(
            "Rollback would be partial because some changed paths exceed the bounded review snapshot policy: " +
            `${unsupported.join(", ")}. Retry with forcePartial=true only after reviewing these paths.`,
        );
    }
    if (!restorable.length)
        throw new Error("No changed path has a complete bounded baseline and safety snapshot.");
    const snapshotId = `safety_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const safety = { id: snapshotId, createdAt: new Date().toISOString(), paths: safetyPaths };
    state.safetySnapshots = [safety, ...(state.safetySnapshots ?? [])].slice(0, MAX_SAFETY_SNAPSHOTS);
    for (const trackedPath of restorable) {
        await restoreDescriptor(stateDir, state, trackedPath, state.tracked[trackedPath].baseline);
        state.tracked[trackedPath].lastShown = state.tracked[trackedPath].baseline;
    }
    state.lastReview = { files: unsupported.length, additions: 0, removals: 0 };
    state.updatedAt = new Date().toISOString();
    state.lastRollbackAt = state.updatedAt;
    await pruneObjects(stateDir, state);
    await saveSession(stateDir, state);
    return {
        restored: restorable.length,
        paths: restorable,
        skipped: unsupported,
        partial: unsupported.length > 0,
        checkpointId: state.sessionId,
        safetySnapshot: { id: safety.id, createdAt: safety.createdAt, paths: Object.keys(safety.paths) },
    };
}

async function restoreSafetySnapshot(stateDir, state, payload) {
    const snapshotId = String(payload.snapshotId || "");
    const snapshot = (state.safetySnapshots ?? []).find((item) => item.id === snapshotId);
    if (!snapshot)
        throw new Error(`Safety snapshot not found: ${snapshotId}`);
    if (String(payload.confirmation || "") !== `RESTORE ${snapshotId}`)
        throw new Error(`Confirmation must exactly equal: RESTORE ${snapshotId}`);
    const restored = [];
    for (const [trackedPath, descriptor] of Object.entries(snapshot.paths ?? {})) {
        if (!descriptorRestorable(descriptor))
            continue;
        await restoreDescriptor(stateDir, state, trackedPath, descriptor);
        restored.push(trackedPath);
    }
    state.updatedAt = new Date().toISOString();
    await saveSession(stateDir, state);
    return { restored: restored.length, paths: restored, snapshotId, session: publicSession(state) };
}

async function loadOrCreateSession(stateDir, workspaceId, root) {
    const existing = await loadSessionById(stateDir, workspaceId);
    if (existing && existing.root === root)
        return normalizeState(existing);
    const now = new Date().toISOString();
    const state = normalizeState({
        formatVersion: FORMAT_VERSION,
        sessionId: workspaceId,
        workspaceId,
        root,
        title: basename(root),
        status: "active",
        pinned: false,
        hidden: false,
        createdAt: now,
        updatedAt: now,
        tracked: {},
        limitations: [],
        safetySnapshots: [],
        storedBytes: 0,
        shellMutationObserved: false,
    });
    await saveSession(stateDir, state);
    return state;
}

function normalizeState(state) {
    return {
        ...state,
        formatVersion: FORMAT_VERSION,
        tracked: state.tracked && typeof state.tracked === "object" ? state.tracked : {},
        limitations: Array.isArray(state.limitations) ? state.limitations : [],
        safetySnapshots: Array.isArray(state.safetySnapshots) ? state.safetySnapshots : [],
        storedBytes: Number(state.storedBytes || 0),
        shellMutationObserved: Boolean(state.shellMutationObserved),
    };
}

async function saveSession(stateDir, state) {
    const file = sessionFile(stateDir, state.sessionId);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rm(file, { force: true });
    await rename(temporary, file);
}

async function loadSessionById(stateDir, sessionId) {
    const file = sessionFile(stateDir, sessionId);
    if (!existsSync(file))
        return null;
    try {
        const value = JSON.parse(await readFile(file, "utf8"));
        return value?.formatVersion === FORMAT_VERSION ? normalizeState(value) : null;
    }
    catch {
        return null;
    }
}

async function loadAllSessions(stateDir) {
    const directory = join(stateDir, SESSION_DIRECTORY);
    if (!existsSync(directory))
        return [];
    const sessions = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const file = join(directory, entry.name, "session.json");
        try {
            const value = JSON.parse(await readFile(file, "utf8"));
            if (value?.formatVersion === FORMAT_VERSION)
                sessions.push(normalizeState(value));
        }
        catch {
            // Damaged internal review metadata is ignored instead of blocking the UI.
        }
    }
    return sessions;
}

function sessionKey(sessionId) {
    return createHash("sha256").update(String(sessionId)).digest("hex");
}

function sessionDirectory(stateDir, sessionId) {
    return join(stateDir, SESSION_DIRECTORY, sessionKey(sessionId));
}

function sessionFile(stateDir, sessionId) {
    return join(sessionDirectory(stateDir, sessionId), "session.json");
}

function objectFile(stateDir, state, objectKey) {
    return join(sessionDirectory(stateDir, state.sessionId), "objects", `${objectKey}.gz`);
}

function normalizeTrackedPath(root, value) {
    const text = String(value ?? "").trim();
    if (!text)
        return "";
    const absolute = isAbsolute(text) ? resolve(text) : resolve(root, text);
    const rel = relative(root, absolute);
    if (!rel || rel === ".")
        return "";
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`Review path escapes the workspace: ${text}`);
    return rel.split(sep).join("/");
}

function absoluteTrackedPath(state, trackedPath) {
    return resolve(state.root, trackedPath.split("/").join(sep));
}

async function captureDescriptor(stateDir, state, trackedPath, persist) {
    const target = absoluteTrackedPath(state, trackedPath);
    let information;
    try {
        information = await lstat(target);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return { descriptor: { exists: false, type: "missing", stored: true }, content: Buffer.alloc(0) };
        throw error;
    }
    if (information.isSymbolicLink()) {
        const linkTarget = await readlink(target);
        return {
            descriptor: {
                exists: true,
                type: "symlink",
                linkTarget,
                stored: true,
                size: Buffer.byteLength(linkTarget),
                mtimeMs: information.mtimeMs,
            },
            content: Buffer.from(linkTarget, "utf8"),
        };
    }
    if (!information.isFile()) {
        return {
            descriptor: {
                exists: true,
                type: information.isDirectory() ? "directory" : "special",
                stored: false,
                size: information.size,
                mtimeMs: information.mtimeMs,
                reason: "unsupported-file-type",
            },
        };
    }
    const sampledHash = await sampleFileHash(target, information.size);
    if (information.size > MAX_FILE_BYTES) {
        return {
            descriptor: {
                exists: true,
                type: "file",
                stored: false,
                size: information.size,
                mtimeMs: information.mtimeMs,
                sampledHash,
                reason: `file-exceeds-${MAX_FILE_BYTES}-bytes`,
            },
        };
    }
    const content = await readFile(target);
    const hash = createHash("sha256").update(content).digest("hex");
    const text = looksLikeText(content);
    const descriptor = {
        exists: true,
        type: "file",
        stored: false,
        size: information.size,
        mtimeMs: information.mtimeMs,
        sampledHash,
        sha256: hash,
        text,
    };
    if (persist) {
        const stored = await storeObject(stateDir, state, hash, content);
        descriptor.stored = stored;
        descriptor.object = stored ? hash : undefined;
        descriptor.reason = stored ? undefined : `session-storage-cap-${MAX_SESSION_STORED_BYTES}-bytes`;
    }
    return { descriptor, content };
}

async function sampleFileHash(file, size) {
    const handle = await open(file, "r");
    try {
        const firstLength = Math.min(size, SAMPLE_BYTES);
        const lastLength = Math.min(Math.max(0, size - firstLength), SAMPLE_BYTES);
        const first = Buffer.alloc(firstLength);
        if (firstLength)
            await handle.read(first, 0, firstLength, 0);
        const last = Buffer.alloc(lastLength);
        if (lastLength)
            await handle.read(last, 0, lastLength, Math.max(0, size - lastLength));
        return createHash("sha256")
            .update(String(size))
            .update(first)
            .update(last)
            .digest("hex");
    }
    finally {
        await handle.close();
    }
}

async function storeObject(stateDir, state, hash, content) {
    const file = objectFile(stateDir, state, hash);
    if (existsSync(file))
        return true;
    const compressed = await gzipAsync(content, { level: 6 });
    if (Number(state.storedBytes || 0) + compressed.length > MAX_SESSION_STORED_BYTES) {
        addLimitation(state, `This session reached its ${MAX_SESSION_STORED_BYTES}-byte bounded review storage cap.`);
        return false;
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, compressed, { mode: 0o600 });
    try {
        await rename(temporary, file);
    }
    catch (error) {
        await rm(temporary, { force: true });
        if (!existsSync(file))
            throw error;
    }
    state.storedBytes = Number(state.storedBytes || 0) + compressed.length;
    return true;
}

async function readDescriptorContent(stateDir, state, descriptor) {
    if (!descriptor?.exists)
        return Buffer.alloc(0);
    if (descriptor.type === "symlink")
        return Buffer.from(String(descriptor.linkTarget || ""), "utf8");
    if (!descriptor.stored || !descriptor.object)
        return null;
    try {
        return await gunzipAsync(await readFile(objectFile(stateDir, state, descriptor.object)));
    }
    catch {
        return null;
    }
}

function looksLikeText(content) {
    const sample = content.subarray(0, Math.min(content.length, 64 * 1024));
    if (sample.includes(0))
        return false;
    const decoded = sample.toString("utf8");
    const replacementCount = [...decoded].filter((character) => character === "�").length;
    return replacementCount <= Math.max(1, decoded.length / 1000);
}

function descriptorsEqual(left, right) {
    if (!left || !right)
        return false;
    if (Boolean(left.exists) !== Boolean(right.exists) || left.type !== right.type)
        return false;
    if (!left.exists)
        return true;
    if (left.type === "symlink")
        return left.linkTarget === right.linkTarget;
    if (left.sha256 && right.sha256)
        return left.sha256 === right.sha256;
    if (left.sampledHash && right.sampledHash)
        return left.sampledHash === right.sampledHash;
    return left.size === right.size && Math.trunc(left.mtimeMs || 0) === Math.trunc(right.mtimeMs || 0);
}

async function compareTrackedPaths(stateDir, state, baseField, persistCurrent) {
    const files = [];
    const patches = [];
    for (const trackedPath of Object.keys(state.tracked ?? {}).sort()) {
        const tracked = state.tracked[trackedPath];
        const before = tracked?.[baseField] ?? tracked?.baseline;
        const current = await captureDescriptor(stateDir, state, trackedPath, persistCurrent);
        if (descriptorsEqual(before, current.descriptor)) {
            if (persistCurrent)
                tracked.lastShown = current.descriptor;
            continue;
        }
        const record = await buildFileRecord(stateDir, state, trackedPath, before, current);
        files.push(record.file);
        if (record.patch)
            patches.push(record.patch);
        if (persistCurrent)
            tracked.lastShown = current.descriptor;
    }
    let patch = patches.join("\n");
    if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES)
        patch = `[Diff omitted because it exceeded ${MAX_PATCH_BYTES} bytes.]`;
    return {
        files,
        summary: summarizeFiles(files),
        patch,
        limitations: [...(state.limitations ?? [])],
    };
}

async function buildFileRecord(stateDir, state, trackedPath, before, current) {
    const after = current.descriptor;
    const type = !before?.exists && after.exists
        ? "new"
        : before?.exists && !after.exists
            ? "deleted"
            : before?.type !== after.type
                ? "type-change"
                : "change";
    const beforeContent = await readDescriptorContent(stateDir, state, before);
    const afterContent = current.content ?? await readDescriptorContent(stateDir, state, after);
    if (beforeContent !== null && afterContent !== null
        && (before?.text !== false) && (after?.text !== false)
        && before?.type !== "directory" && after?.type !== "directory") {
        const beforeText = beforeContent.toString("utf8");
        const afterText = afterContent.toString("utf8");
        const stats = lineStats(beforeText, afterText);
        return {
            file: { path: trackedPath, type, ...stats },
            patch: createTwoFilesPatch(
                `a/${trackedPath}`,
                `b/${trackedPath}`,
                beforeText,
                afterText,
                "",
                "",
                { context: 3 },
            ),
        };
    }
    return {
        file: {
            path: trackedPath,
            type,
            additions: 0,
            removals: 0,
            binary: true,
            rollbackSupported: descriptorRestorable(before),
        },
        patch: `[Binary, large, or unsupported path changed: ${trackedPath}]`,
    };
}

function lineStats(before, after) {
    let additions = 0;
    let removals = 0;
    for (const part of diffLines(before, after)) {
        const count = Number(part.count || 0);
        if (part.added)
            additions += count;
        if (part.removed)
            removals += count;
    }
    return { additions, removals };
}

function descriptorRestorable(descriptor) {
    if (!descriptor)
        return false;
    if (!descriptor.exists)
        return true;
    if (descriptor.type === "symlink")
        return typeof descriptor.linkTarget === "string";
    return descriptor.type === "file" && Boolean(descriptor.stored && descriptor.object);
}

async function restoreDescriptor(stateDir, state, trackedPath, descriptor) {
    const target = absoluteTrackedPath(state, trackedPath);
    if (!descriptor.exists) {
        await rm(target, { recursive: true, force: true });
        return;
    }
    await mkdir(dirname(target), { recursive: true });
    if (descriptor.type === "symlink") {
        await rm(target, { recursive: true, force: true });
        await symlink(descriptor.linkTarget, target);
        return;
    }
    const content = await readDescriptorContent(stateDir, state, descriptor);
    if (content === null)
        throw new Error(`Review object is unavailable for ${trackedPath}.`);
    const temporary = `${target}.devspace-restore-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, content);
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
}

async function pruneObjects(stateDir, state) {
    const keep = new Set();
    const addDescriptor = (descriptor) => {
        if (descriptor?.object)
            keep.add(descriptor.object);
    };
    for (const tracked of Object.values(state.tracked ?? {})) {
        addDescriptor(tracked.baseline);
        addDescriptor(tracked.lastShown);
    }
    for (const snapshot of state.safetySnapshots ?? []) {
        for (const descriptor of Object.values(snapshot.paths ?? {}))
            addDescriptor(descriptor);
    }
    const directory = join(sessionDirectory(stateDir, state.sessionId), "objects");
    if (!existsSync(directory)) {
        state.storedBytes = 0;
        return;
    }
    let storedBytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".gz"))
            continue;
        const key = entry.name.slice(0, -3);
        const file = join(directory, entry.name);
        if (!keep.has(key)) {
            await rm(file, { force: true });
            continue;
        }
        try {
            storedBytes += (await stat(file)).size;
        }
        catch {
            // A concurrently removed object is ignored.
        }
    }
    state.storedBytes = storedBytes;
}

function scheduleLegacyCleanup(stateDir) {
    const key = resolve(stateDir).toLowerCase();
    if (cleanupScheduled.has(key))
        return;
    cleanupScheduled.add(key);
    void quarantineLegacyReviewState(stateDir).catch(() => {});
}

async function quarantineLegacyReviewState(stateDir) {
    await mkdir(stateDir, { recursive: true });
    const entries = existsSync(stateDir) ? await readdir(stateDir, { withFileTypes: true }) : [];
    const candidates = [
        ...LEGACY_DIRECTORIES.map((name) => join(stateDir, name)),
        ...entries
            .filter((entry) => entry.isDirectory() && /^review-(?:sessions|repositories)-v3\.obsolete-/.test(entry.name))
            .map((entry) => join(stateDir, entry.name)),
    ];
    for (const source of candidates) {
        if (!existsSync(source))
            continue;
        let quarantined = source;
        if (!/\.obsolete-/.test(basename(source))) {
            quarantined = `${source}.obsolete-${Date.now()}-${randomUUID().slice(0, 8)}`;
            try {
                await rename(source, quarantined);
            }
            catch {
                quarantined = source;
            }
        }
        void rm(quarantined, { recursive: true, force: true }).catch(() => {});
    }
}

async function pruneReviewState(stateDir, currentSessionId) {
    const sessions = await loadAllSessions(stateDir);
    const records = [];
    for (const session of sessions) {
        const directory = sessionDirectory(stateDir, session.sessionId);
        records.push({
            session,
            directory,
            size: await directorySize(directory),
        });
    }
    records.sort((left, right) => String(left.session.updatedAt || "").localeCompare(String(right.session.updatedAt || "")));
    let total = records.reduce((sum, item) => sum + item.size, 0);

    const removed = new Set();
    let emptyCount = records.filter((record) => countPrunableEmptySession(record.session)).length;

    // Keep recent read-only history visible, but bound only those disposable
    // sessions by count. Meaningful review/rollback sessions are deliberately
    // excluded so monitor/reconnect churn can no longer evict real changes.
    for (const record of records) {
        if (emptyCount <= MAX_EMPTY_SESSION_DIRECTORIES)
            break;
        if (record.session.sessionId === currentSessionId)
            continue;
        if (!countPrunableEmptySession(record.session))
            continue;
        await rm(record.directory, { recursive: true, force: true });
        removed.add(record.session.sessionId);
        total -= record.size;
        emptyCount -= 1;
    }

    if (total <= MAX_TOTAL_STATE_BYTES)
        return;

    // The 512 MiB aggregate cap remains a hard safety boundary. Under genuine
    // storage pressure, prefer evicting the oldest unpinned meaningful session;
    // pinned sessions are considered only as a last resort. The current session
    // is never removed by its own initialization/mutation path.
    const retained = records
        .filter((record) => !removed.has(record.session.sessionId))
        .filter((record) => record.session.sessionId !== currentSessionId)
        .sort((left, right) => {
            const leftPriority = storagePressurePriority(left.session);
            const rightPriority = storagePressurePriority(right.session);
            if (leftPriority !== rightPriority)
                return leftPriority - rightPriority;
            return String(left.session.updatedAt || "").localeCompare(String(right.session.updatedAt || ""));
        });
    for (const record of retained) {
        if (total <= MAX_TOTAL_STATE_BYTES)
            break;
        await rm(record.directory, { recursive: true, force: true });
        total -= record.size;
    }
}

function countPrunableEmptySession(state) {
    return !state?.pinned
        && Object.keys(state?.tracked ?? {}).length === 0
        && (state?.safetySnapshots ?? []).length === 0
        && !Boolean(state?.shellMutationObserved)
        && Number(state?.lastReview?.files || 0) === 0;
}

function storagePressurePriority(state) {
    if (countPrunableEmptySession(state))
        return 0;
    if (!state?.pinned)
        return 1;
    return 2;
}

async function directorySize(directory) {
    if (!existsSync(directory))
        return 0;
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory())
            total += await directorySize(file);
        else if (entry.isFile()) {
            try {
                total += (await stat(file)).size;
            }
            catch {
                // Ignore files removed during pruning.
            }
        }
    }
    return total;
}

function addLimitation(state, message) {
    state.limitations ??= [];
    if (!state.limitations.includes(message))
        state.limitations.push(message);
}

function summarizeFiles(files) {
    return files.reduce((summary, file) => ({
        files: summary.files + 1,
        additions: summary.additions + Number(file.additions || 0),
        removals: summary.removals + Number(file.removals || 0),
    }), { files: 0, additions: 0, removals: 0 });
}

function sessionIdentity(state) {
    return {
        active: true,
        persistent: true,
        sessionId: state.sessionId,
        checkpointId: state.sessionId,
        confirmationToken: confirmationToken(state),
        backend: "sparse-journal-v4",
    };
}

function sessionReviewResult(state, comparison) {
    const unsupported = comparison.files
        .filter((file) => !descriptorRestorable(state.tracked?.[file.path]?.baseline))
        .map((file) => file.path);
    return {
        ...sessionIdentity(state),
        startedAt: state.createdAt,
        gitBacked: false,
        shadowRepository: false,
        shellRollbackUnsafe: Boolean(state.shellMutationObserved),
        rollbackCoverage: state.shellMutationObserved ? "tracked-paths-only" : "complete-for-tracked-paths",
        canRollback: comparison.summary.files > 0 && unsupported.length === 0,
        summary: comparison.summary,
        files: comparison.files,
        patch: comparison.patch,
        limitations: [
            ...(comparison.limitations ?? []),
            ...(unsupported.length ? [`Rollback snapshots are unavailable for: ${unsupported.join(", ")}`] : []),
        ],
        safetySnapshots: (state.safetySnapshots ?? []).map((item) => ({
            id: item.id,
            createdAt: item.createdAt,
            paths: Object.keys(item.paths ?? {}),
        })),
        storage: {
            storedBytes: Number(state.storedBytes || 0),
            sessionLimitBytes: MAX_SESSION_STORED_BYTES,
            totalStateLimitBytes: MAX_TOTAL_STATE_BYTES,
            trackedPaths: Object.keys(state.tracked ?? {}).length,
        },
    };
}

function confirmationToken(state) {
    return `ROLLBACK ${state.sessionId}`;
}

function publicSession(state) {
    return {
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        root: state.root,
        title: state.title,
        status: state.status,
        pinned: Boolean(state.pinned),
        hidden: Boolean(state.hidden),
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        baselineCreatedAt: state.baselineCreatedAt ?? null,
        hasBaseline: Object.keys(state.tracked ?? {}).length > 0,
        summary: state.lastReview ?? { files: 0, additions: 0, removals: 0 },
        safetySnapshots: (state.safetySnapshots ?? []).map((item) => ({
            id: item.id,
            createdAt: item.createdAt,
            paths: Object.keys(item.paths ?? {}),
        })),
        backend: "sparse-journal-v4",
        trackedPaths: Object.keys(state.tracked ?? {}).length,
        storedBytes: Number(state.storedBytes || 0),
        shellMutationObserved: Boolean(state.shellMutationObserved),
    };
}

function sessionSort(left, right) {
    if (Boolean(left.pinned) !== Boolean(right.pinned))
        return left.pinned ? -1 : 1;
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
}

function reviewResult(comparison, since) {
    return {
        result: comparison.summary.files === 0
            ? `No tracked changes since ${since === "workspace_open" ? "workspace open" : "last shown changes"}.`
            : `Changed ${comparison.summary.files} tracked ${comparison.summary.files === 1 ? "file" : "files"} (+${comparison.summary.additions} -${comparison.summary.removals}).`,
        ...comparison,
    };
}

function emptyComparison(limitations = []) {
    return {
        summary: { files: 0, additions: 0, removals: 0 },
        files: [],
        patch: "",
        limitations,
    };
}

function inactiveSessionReview(reason) {
    return {
        active: false,
        reason,
        canRollback: false,
        summary: { files: 0, additions: 0, removals: 0 },
        files: [],
        patch: "",
        limitations: [],
    };
}
