export class McpSessionRegistry {
    sessions = new Map();
    now;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
    }
    get size() {
        return this.sessions.size;
    }
    register(sessionId, transport) {
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
        });
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
