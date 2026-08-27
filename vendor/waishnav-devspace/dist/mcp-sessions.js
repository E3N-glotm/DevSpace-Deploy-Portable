export class McpSessionRegistry {
    sessions = new Map();
    now;
    maxSessions;
    hardMaxSessions;
    minRetentionMs;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.maxSessions = Math.max(1, Number(options.maxSessions ?? 32));
        this.hardMaxSessions = Math.max(this.maxSessions, Number(options.hardMaxSessions ?? this.maxSessions * 3));
        this.minRetentionMs = Math.max(0, Number(options.minRetentionMs ?? 2 * 60_000));
    }
    get size() {
        return this.sessions.size;
    }
    register(sessionId, transport) {
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
            inFlight: 0,
        });
        void this.trimTo(this.maxSessions, sessionId);
    }
    get(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }
    acquire(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.lastActivityAt = this.now();
        entry.inFlight += 1;
        let released = false;
        return {
            transport: entry.transport,
            release: () => {
                if (released)
                    return;
                released = true;
                const current = this.sessions.get(sessionId);
                if (!current || current !== entry)
                    return;
                current.inFlight = Math.max(0, current.inFlight - 1);
                current.lastActivityAt = this.now();
                // Capacity pressure may have been deferred while every old
                // session was serving a request. Re-evaluate after the request
                // finishes, but never synchronously close from the request path.
                void this.trimTo(this.maxSessions);
            },
        };
    }
    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }
    async closeIdle(idleTimeoutMs) {
        const cutoff = this.now() - idleTimeoutMs;
        const idleSessions = [];
        for (const [sessionId, entry] of this.sessions) {
            if (entry.inFlight > 0 || entry.lastActivityAt > cutoff)
                continue;
            this.sessions.delete(sessionId);
            idleSessions.push({ sessionId, transport: entry.transport });
        }
        return closeSessions(idleSessions);
    }
    async trimTo(maxSessions = this.maxSessions, preserveSessionId) {
        const limit = Math.max(1, Number(maxSessions));
        if (this.sessions.size <= limit)
            return [];
        const now = this.now();
        const candidates = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
            .filter((entry) => entry.sessionId !== preserveSessionId)
            .filter((entry) => entry.inFlight === 0)
            .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
        const removed = [];
        // The soft limit is deliberately not an immediate LRU guillotine.
        // ChatGPT can create a burst of fresh MCP sessions while a Workspace
        // App still expects to reuse an older-but-recent session. Preserve that
        // reconnect grace window and prune only genuinely old, quiescent
        // sessions first.
        const retained = [];
        while (this.sessions.size > limit && candidates.length > 0) {
            const entry = candidates.shift();
            if (now - entry.lastActivityAt < this.minRetentionMs) {
                retained.push(entry);
                continue;
            }
            if (!entry || !this.sessions.delete(entry.sessionId))
                continue;
            removed.push({ sessionId: entry.sessionId, transport: entry.transport });
        }
        // Keep memory bounded even under a pathological reconnect storm. The
        // hard limit is higher than the steady-state target, and still never
        // evicts a request that is currently in flight.
        const hardCandidates = [...retained, ...candidates]
            .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
        while (this.sessions.size > this.hardMaxSessions && hardCandidates.length > 0) {
            const entry = hardCandidates.shift();
            if (!entry || !this.sessions.delete(entry.sessionId))
                continue;
            removed.push({ sessionId: entry.sessionId, transport: entry.transport });
        }
        return closeSessions(removed);
    }
    async closeAll() {
        const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        return closeSessions(sessions);
    }
}
async function closeSessions(sessions) {
    return Promise.all(sessions.map(async ({ sessionId, transport }) => {
        try {
            await transport.close();
            return { sessionId };
        }
        catch (error) {
            return { sessionId, error };
        }
    }));
}
