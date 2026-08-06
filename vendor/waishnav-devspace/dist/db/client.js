import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";
export function databasePath(stateDir) {
    return join(stateDir, "devspace.sqlite");
}
export function openDatabase(stateDir) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = databasePath(stateDir);
    const sqlite = new Database(path);
    chmodSync(path, 0o600);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);
    return {
        sqlite,
        db: createDrizzleDatabase(sqlite),
        close: () => sqlite.close(),
    };
}
function createDrizzleDatabase(sqlite) {
    return drizzle(sqlite, { schema });
}
