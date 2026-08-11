export class McpSessionRegistry {
    sessions = new Map();
    now;
    maxSessions;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.maxSessions = Math.max(1, Number(options.maxSessions ?? 32));
    }
    get size() {
        return this.sessions.size;
    }
    register(sessionId, transport) {
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
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
    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }
    async closeIdle(idleTimeoutMs) {
        const cutoff = this.now() - idleTimeoutMs;
        const idleSessions = [];
        for (const [sessionId, entry] of this.sessions) {
            if (entry.lastActivityAt > cutoff)
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
        const candidates = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, ...entry }))
            .filter((entry) => entry.sessionId !== preserveSessionId)
            .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
        const removed = [];
        while (this.sessions.size > limit && candidates.length > 0) {
            const entry = candidates.shift();
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
