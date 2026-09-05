package com.devspace.agent;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.concurrent.atomic.AtomicBoolean;

public final class DevSpaceAgentService extends Service {
    static final String ACTION_START = "com.devspace.agent.action.START";
    static final String ACTION_STOP = "com.devspace.agent.action.STOP";
    static final String EXTRA_START_REASON = "startReason";

    private static final String CHANNEL_ID = "devspace_mobile_mcp";
    private static final int NOTIFICATION_ID = 14301;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile McpHttpServer mcpServer;
    private volatile CloudflareTunnelManager tunnelManager;
    private volatile NgrokTunnelManager ngrokTunnelManager;
    private AgentConfig config;
    private RootShell rootShell;
    private PowerManager.WakeLock wakeLock;

    @Override public void onCreate() {
        super.onCreate();
        config = new AgentConfig(this);
        rootShell = new RootShell();
        createNotificationChannel();
        ServiceRuntimeStatus.reset("服务进程已就绪，尚未启动 MCP");
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            config.serviceRequested(false);
            stopAgent();
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, notification("正在启动", "准备启动独立 MCP/OAuth Server"));
        String reason = intent == null ? "system" : intent.getStringExtra(EXTRA_START_REASON);
        startAgent(reason == null || reason.isEmpty() ? "manual" : reason);
        return config.startOnBoot() ? START_STICKY : START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        stopAgent();
        super.onDestroy();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // Without explicit boot persistence the foreground service belongs to
        // the app task: Home keeps the task in background, while swiping the
        // task away tears down MCP and both tunnel runtimes.
        if (!config.startOnBoot()) {
            config.serviceRequested(false);
            stopAgent();
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    private synchronized void startAgent(String runMode) {
        if (running.get()) return;
        running.set(true);
        if (config.keepWakeLock()) acquireWakeLock();
        try {
            config.validateTunnelSelection();
            if (config.publicBaseUrl().isEmpty()) throw new IllegalStateException("请先配置 Android 独立 Public Base URL");
            if (!config.ownerPasswordConfigured()) throw new IllegalStateException("请先配置 Owner Password");
            config.serviceRequested(true);
            cleanupTunnelResidue();
            boolean rootGranted = rootShell.isRootAvailable();
            ServiceRuntimeStatus.starting(runMode, config.tunnelProvider(), config.publicBaseUrl());
            ServiceRuntimeStatus.root(rootGranted);
            McpHttpServer current = new McpHttpServer(this, config, rootShell,
                    (state, detail) -> onState(state, detail, rootShell.isRootAvailable()));
            mcpServer = current;
            current.start();
            ServiceRuntimeStatus.mcpReady();
            CloudflareTunnelManager tunnel = new CloudflareTunnelManager(this, config, rootShell,
                    (state, detail) -> onTunnelState("cloudflare", state, detail));
            tunnelManager = tunnel;
            tunnel.start();
            NgrokTunnelManager ngrok = new NgrokTunnelManager(this, config, rootShell,
                    (state, detail) -> onTunnelState("ngrok", state, detail));
            ngrokTunnelManager = ngrok;
            ngrok.start();
            if (!config.cloudflareTunnelEnabled() && !config.ngrokTunnelEnabled()) {
                onState("MCP 已启动", "仅本机监听；公网 Tunnel 未启用", rootShell.isRootAvailable());
            }
        } catch (Throwable error) {
            running.set(false);
            config.serviceRequested(false);
            NgrokTunnelManager ngrok = ngrokTunnelManager;
            ngrokTunnelManager = null;
            if (ngrok != null) ngrok.close();
            CloudflareTunnelManager tunnel = tunnelManager;
            tunnelManager = null;
            if (tunnel != null) tunnel.close();
            McpHttpServer current = mcpServer;
            mcpServer = null;
            if (current != null) current.close();
            cleanupTunnelResidue();
            releaseWakeLock();
            String message = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
            ServiceRuntimeStatus.error(message);
            onState("启动失败", message, rootShell.isRootAvailable());
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private synchronized void stopAgent() {
        boolean wasRunning = running.getAndSet(false);
        if (wasRunning) ServiceRuntimeStatus.stopping("正在关闭 MCP、ngrok 与 Cloudflare");
        NgrokTunnelManager ngrok = ngrokTunnelManager;
        ngrokTunnelManager = null;
        if (ngrok != null) ngrok.close();
        CloudflareTunnelManager tunnel = tunnelManager;
        tunnelManager = null;
        if (tunnel != null) tunnel.close();
        McpHttpServer current = mcpServer;
        mcpServer = null;
        if (current != null) current.close();
        cleanupTunnelResidue();
        releaseWakeLock();
        ServiceRuntimeStatus.reset("MCP 与公网 Tunnel 均已停止");
        onState("服务已停止", "MCP 与公网 Tunnel 均已停止", rootShell != null && rootShell.isRootAvailable());
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    public void onState(String state, String detail, boolean rootGranted) {
        config.runtimeState(state, detail, rootGranted);
        ServiceRuntimeStatus.root(rootGranted);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && running.get()) manager.notify(NOTIFICATION_ID, notification(state, detail));
    }

    private void onTunnelState(String provider, String state, String detail) {
        String normalized = state == null ? "" : state;
        if (normalized.contains("已在线") || normalized.contains("已启动")) {
            ServiceRuntimeStatus.tunnelReady(detail);
        } else if (normalized.contains("正在") || normalized.contains("连接")) {
            ServiceRuntimeStatus.tunnelStarting(detail);
        } else if (normalized.contains("失败") || normalized.contains("错误")
                || normalized.contains("异常") || normalized.contains("退出")) {
            ServiceRuntimeStatus.tunnelProblem((provider == null ? "Tunnel" : provider) + " · " + detail);
        }
        onState(state, detail, rootShell != null && rootShell.isRootAvailable());
    }

    private void cleanupTunnelResidue() {
        if (rootShell == null) return;
        String root = "/data/local/tmp/devspace-mobile";
        String command = "for f in " + ShellEscaper.quote(root + "/ngrok.pid") + " "
                + ShellEscaper.quote(root + "/cloudflared.pid") + "; do "
                + "[ -f \"$f\" ] || continue; pid=$(cat \"$f\" 2>/dev/null || true); "
                + "case \"$pid\" in ''|*[!0-9]*) ;; *) "
                + "cmd=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null || true); "
                + "case \"$cmd\" in *devspace-mobile/ngrok-android-sdk*|*devspace-mobile/cloudflared-*) kill \"$pid\" 2>/dev/null || true ;; esac ;; esac; "
                + "rm -f \"$f\"; done; rm -f " + ShellEscaper.quote(root + "/tunnel.token");
        try { rootShell.exec(command, null, 10, 128 * 1024); } catch (Exception ignored) {}
    }

    private Notification notification(String state, String detail) {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID);
        return builder
                .setSmallIcon(com.devspace.agent.R.drawable.ic_devspace)
                .setContentTitle("DevSpace Mobile · " + state)
                .setContentText(detail == null || detail.isEmpty() ? "Standalone MCP Server" : detail)
                .setContentIntent(pending)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(com.devspace.agent.R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(com.devspace.agent.R.string.channel_description));
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        if (!config.keepWakeLock()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DevSpaceMobile:McpServer");
        wakeLock.setReferenceCounted(false);
        // The owner explicitly enables this foreground MCP/tunnel service for
        // continuous screen-off control. stopAgent()/onDestroy() always releases it.
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

}
