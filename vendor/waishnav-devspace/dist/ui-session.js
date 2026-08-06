import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_LEASE_TIMEOUT_MS = 20_000;

export class UiSessionLease {
    leaseFile;
    constructor(config) {
        const portableRoot = process.env.DEVSPACE_PORTABLE_ROOT;
        this.leaseFile = process.env.DEVSPACE_UI_LEASE_FILE
            ? resolve(process.env.DEVSPACE_UI_LEASE_FILE)
            : portableRoot
                ? join(resolve(portableRoot), "data", "run", "ui-session.json")
                : join(config.stateDir, "ui-session.json");
    }
    status() {
        if (!existsSync(this.leaseFile)) {
            return { active: false, reason: "local UI is closed", leaseFile: this.leaseFile };
        }
        try {
            const value = JSON.parse(readFileSync(this.leaseFile, "utf8"));
            const expiresAtMs = Date.parse(String(value.expiresAt ?? ""));
            const lastHeartbeatAtMs = Date.parse(String(value.lastHeartbeatAt ?? ""));
            const active = Boolean(value.leaseId)
                && value.closedAt === undefined
                && Number.isFinite(expiresAtMs)
                && expiresAtMs > Date.now()
                && (!Number.isFinite(lastHeartbeatAtMs)
                    || Date.now() - lastHeartbeatAtMs <= DEFAULT_LEASE_TIMEOUT_MS * 2);
            return {
                active,
                reason: active ? undefined : "local UI heartbeat expired",
                leaseId: value.leaseId,
                openedAt: value.openedAt,
                lastHeartbeatAt: value.lastHeartbeatAt,
                expiresAt: value.expiresAt,
                leaseFile: this.leaseFile,
            };
        }
        catch (error) {
            return {
                active: false,
                reason: `invalid local UI lease: ${error instanceof Error ? error.message : String(error)}`,
                leaseFile: this.leaseFile,
            };
        }
    }
    requireActive(capability) {
        const status = this.status();
        if (!status.active) {
            throw new Error(`${capability} is available only while the local DevSpace Portable UI is open (${status.reason ?? "inactive lease"}).`);
        }
        return status;
    }
}

