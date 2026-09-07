const DEFAULT_INTERVAL_MS = 5_000;
const CLAIM_RECOVERY_GRACE_MS = 50;

function safeDelayUntil(iso, graceMs = CLAIM_RECOVERY_GRACE_MS) {
    const dueAt = Date.parse(String(iso || ""));
    if (!Number.isFinite(dueAt))
        return undefined;
    return Math.max(0, dueAt - Date.now() + Math.max(0, Number(graceMs) || 0));
}

/**
 * Run the durable continuation supervisor independently of any Workspace App
 * iframe lifecycle. The runtime state machine remains the sole authority for
 * whether a generation is eligible to advance; this scheduler only makes sure
 * already-authorized deadlines are actually revisited.
 */
export function createContinuationSupervisorScheduler(options = {}) {
    const runtimeState = options.runtimeState;
    if (!runtimeState || typeof runtimeState.continuationSupervisorSweep !== "function")
        throw new Error("continuation supervisor requires runtimeState.continuationSupervisorSweep");
    const enabled = typeof options.enabled === "function" ? options.enabled : () => true;
    const intervalMs = Math.max(10, Number(options.intervalMs || DEFAULT_INTERVAL_MS));
    const claimRecoveryGraceMs = Math.max(0, Number(options.claimRecoveryGraceMs ?? CLAIM_RECOVERY_GRACE_MS));
    const onSweep = typeof options.onSweep === "function" ? options.onSweep : () => {};
    const onError = typeof options.onError === "function" ? options.onError : () => {};
    let intervalTimer;
    let stopped = false;
    const claimRecoveryTimers = new Map();

    const run = (reason = "manual") => {
        if (stopped || !enabled())
            return undefined;
        try {
            const sweep = runtimeState.continuationSupervisorSweep();
            onSweep(sweep, reason);
            return sweep;
        }
        catch (error) {
            onError(error, reason);
            return undefined;
        }
    };

    const scheduleClaimRecovery = (claim = {}) => {
        if (stopped || !claim?.accepted || !claim?.deliveryToken || !claim?.claimDueAt)
            return false;
        const delayMs = safeDelayUntil(claim.claimDueAt, claimRecoveryGraceMs);
        if (delayMs === undefined)
            return false;
        const token = String(claim.deliveryToken);
        const previous = claimRecoveryTimers.get(token);
        if (previous)
            clearTimeout(previous);
        const timer = setTimeout(() => {
            claimRecoveryTimers.delete(token);
            run("sender-claim-lease");
        }, delayMs);
        timer.unref?.();
        claimRecoveryTimers.set(token, timer);
        return true;
    };

    const start = () => {
        if (stopped || intervalTimer)
            return;
        // Recover an already-expired CLAIMED generation immediately after a
        // service restart instead of waiting for a future App request or the
        // first periodic tick.
        run("startup");
        intervalTimer = setInterval(() => run("interval"), intervalMs);
        intervalTimer.unref?.();
    };

    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = undefined;
        }
        for (const timer of claimRecoveryTimers.values())
            clearTimeout(timer);
        claimRecoveryTimers.clear();
    };

    return {
        run,
        start,
        stop,
        scheduleClaimRecovery,
        get pendingClaimRecoveryCount() {
            return claimRecoveryTimers.size;
        },
    };
}
