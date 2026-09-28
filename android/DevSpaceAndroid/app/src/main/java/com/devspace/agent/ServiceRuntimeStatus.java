package com.devspace.agent;

import org.json.JSONObject;

final class ServiceRuntimeStatus {
    enum State { STOPPED, STARTING, RUNNING, DEGRADED, ERROR, STOPPING }

    private static State state = State.STOPPED;
    private static String headline = "服务已停止";
    private static String detail = "MCP 与公网 Tunnel 均未运行";
    private static String runMode = "manual";
    private static String provider = "none";
    private static String mcpState = "stopped";
    private static String tunnelState = "stopped";
    private static String rootState = "unknown";
    private static String publicBaseUrl = "";
    private static String lastError = "";
    private static String lastProbeError = "";
    private static String lastTunnelDiagnostic = "";
    private static String activeNetwork = "unknown";
    private static long lastProbeAt = 0L;
    private static long lastHealthyAt = 0L;
    private static long startedAt = 0L;
    private static long updatedAt = System.currentTimeMillis();

    private ServiceRuntimeStatus() {}

    static synchronized void reset(String reason) {
        state = State.STOPPED;
        headline = "服务已停止";
        detail = reason == null || reason.isEmpty() ? "MCP 与公网 Tunnel 均未运行" : reason;
        runMode = "manual";
        provider = "none";
        mcpState = "stopped";
        tunnelState = "stopped";
        lastError = "";
        lastProbeError = "";
        lastTunnelDiagnostic = "";
        activeNetwork = "unknown";
        lastProbeAt = 0L;
        lastHealthyAt = 0L;
        startedAt = 0L;
        updatedAt = System.currentTimeMillis();
    }

    static synchronized void starting(String mode, String currentProvider, String url) {
        state = State.STARTING;
        headline = "正在启动";
        detail = "正在初始化本地 MCP 与公网入口";
        runMode = mode == null || mode.isEmpty() ? "manual" : mode;
        provider = currentProvider == null || currentProvider.isEmpty() ? "none" : currentProvider;
        mcpState = "starting";
        tunnelState = "none".equals(provider) ? "disabled" : "starting";
        publicBaseUrl = url == null ? "" : url;
        lastError = "";
        lastProbeError = "";
        lastTunnelDiagnostic = "";
        lastProbeAt = 0L;
        lastHealthyAt = 0L;
        startedAt = System.currentTimeMillis();
        updatedAt = startedAt;
    }

    static synchronized void root(boolean ok) {
        rootState = ok ? "ready" : "missing";
        updatedAt = System.currentTimeMillis();
    }

    static synchronized void mcpReady() {
        mcpState = "ready";
        recompute();
    }

    static synchronized void probe(boolean localOk, boolean publicOk, boolean publicEnabled,
                                   String network, String issue) {
        if (state == State.STOPPED || state == State.STOPPING || state == State.ERROR) return;
        lastProbeAt = System.currentTimeMillis();
        activeNetwork = network == null ? "unknown" : network;
        lastProbeError = issue == null ? "" : issue;
        mcpState = localOk ? "ready" : "error";
        tunnelState = publicEnabled ? (publicOk ? "ready" : "error") : "disabled";
        if (localOk && (!publicEnabled || publicOk)) {
            lastHealthyAt = lastProbeAt;
            lastError = "";
            detail = publicEnabled ? "本地 MCP 与公网 Tunnel 健康已验证" : "本地 MCP 已验证；公网未启用";
        } else {
            lastError = lastProbeError.isEmpty() ? "端到端连接检测失败" : lastProbeError;
            detail = lastError;
        }
        recompute();
    }

    static synchronized void networkLost(String issue) {
        if (state == State.STOPPED || state == State.STOPPING || state == State.ERROR) return;
        activeNetwork = "offline";
        if (!"disabled".equals(tunnelState)) tunnelState = "error";
        lastProbeError = issue;
        lastError = issue;
        detail = issue;
        recompute();
    }

    static synchronized void tunnelDiagnostic(String line) {
        if (line == null) return;
        lastTunnelDiagnostic = line.length() > 380 ? line.substring(0, 380) : line;
    }

    static synchronized void tunnelReady(String message) {
        tunnelState = "ready";
        if (message != null && !message.isEmpty()) detail = message;
        recompute();
    }

    static synchronized void tunnelStarting(String message) {
        tunnelState = "starting";
        if (message != null && !message.isEmpty()) detail = message;
        recompute();
    }

    static synchronized void tunnelProblem(String message) {
        tunnelState = "error";
        lastError = message == null || message.isEmpty() ? "Tunnel 运行异常" : message;
        detail = lastError;
        recompute();
    }

    static synchronized void error(String message) {
        state = State.ERROR;
        headline = "启动失败";
        lastError = message == null || message.isEmpty() ? "未知错误" : message;
        detail = lastError;
        updatedAt = System.currentTimeMillis();
    }

    static synchronized void stopping(String reason) {
        state = State.STOPPING;
        headline = "正在停止";
        detail = reason == null || reason.isEmpty() ? "正在关闭 MCP 与 Tunnel" : reason;
        updatedAt = System.currentTimeMillis();
    }

    private static void recompute() {
        if ("ready".equals(mcpState) && ("ready".equals(tunnelState) || "disabled".equals(tunnelState))) {
            state = State.RUNNING;
            headline = "运行正常";
            if ("disabled".equals(tunnelState)) detail = "本地 MCP 正常；公网 Tunnel 未启用";
        } else if (("ready".equals(mcpState) && "error".equals(tunnelState))
                || "error".equals(mcpState)) {
            state = State.DEGRADED;
            headline = "连接异常";
        } else if ("ready".equals(mcpState)) {
            state = State.STARTING;
            headline = "MCP 已就绪，Tunnel 连接中";
        }
        updatedAt = System.currentTimeMillis();
    }

    static synchronized JSONObject json() {
        try {
            // An old green status must never survive missed callbacks, a
            // stalled probe thread, screen-off doze or a network change.
            long now = System.currentTimeMillis();
            if ((state == State.RUNNING || state == State.DEGRADED)
                    && (lastProbeAt == 0L || now - lastProbeAt > 60_000L)) {
                state = State.DEGRADED;
                headline = "连接状态待验证";
                if (!"disabled".equals(tunnelState)) tunnelState = "unknown";
                mcpState = "unknown";
            }
            return new JSONObject()
                    .put("state", state.name())
                    .put("headline", headline)
                    .put("detail", detail)
                    .put("runMode", runMode)
                    .put("provider", provider)
                    .put("mcpState", mcpState)
                    .put("tunnelState", tunnelState)
                    .put("rootState", rootState)
                    .put("publicBaseUrl", publicBaseUrl)
                    .put("lastError", lastError)
                    .put("lastProbeError", lastProbeError)
                    .put("lastTunnelDiagnostic", lastTunnelDiagnostic)
                    .put("activeNetwork", activeNetwork)
                    .put("lastProbeAt", lastProbeAt)
                    .put("lastHealthyAt", lastHealthyAt)
                    .put("startedAt", startedAt)
                    .put("updatedAt", updatedAt)
                    .put("uptimeMs", startedAt == 0L ? 0L : Math.max(0L, System.currentTimeMillis() - startedAt));
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }
}
