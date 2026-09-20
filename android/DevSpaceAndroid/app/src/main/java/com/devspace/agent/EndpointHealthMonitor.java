package com.devspace.agent;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Checks the actual local and public MCP HTTP endpoints, not PID existence.
 * Runs only while the user-requested foreground service is active.
 */
final class EndpointHealthMonitor implements AutoCloseable {
    interface Listener {
        void onProbe(boolean localOk, boolean publicOk, String network, String issue);
        void onNetworkLost();
        void onNetworkChanged(String detail);
    }

    private final AgentConfig config;
    private final Listener listener;
    private final ConnectivityManager connectivity;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "devspace-endpoint-health");
        thread.setDaemon(true);
        return thread;
    });
    private volatile boolean active;
    private volatile Network currentNetwork;
    private volatile int failedPublicProbes;
    private volatile long lastReconnectAt;

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            if (!active) return;
            Network previous = currentNetwork;
            currentNetwork = network;
            worker.execute(() -> {
                if (!active) return;
                if (previous != null && !previous.equals(network)) {
                    failedPublicProbes = 0;
                    listener.onNetworkChanged("默认网络已切换为 " + currentNetworkName() + "，重新建立公网隧道");
                }
                runProbe();
            });
        }

        @Override public void onLost(Network network) {
            if (!active || !network.equals(currentNetwork)) return;
            currentNetwork = null;
            worker.execute(() -> { if (active) listener.onNetworkLost(); });
        }
    };

    EndpointHealthMonitor(Context context, AgentConfig config, Listener listener) {
        this.config = config;
        this.listener = listener;
        this.connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    synchronized void start() {
        if (active) return;
        active = true;
        if (connectivity != null) {
            currentNetwork = connectivity.getActiveNetwork();
            connectivity.registerDefaultNetworkCallback(networkCallback);
        }
        worker.scheduleWithFixedDelay(this::runProbe, 0, 20, TimeUnit.SECONDS);
    }

    private void runProbe() {
        if (!active) return;
        String network = currentNetworkName();
        StringBuilder error = new StringBuilder();
        boolean local = check("http://127.0.0.1:" + config.localPort() + "/health", "local", error);
        boolean publicEnabled = !"none".equals(config.tunnelProvider());
        boolean remote = !publicEnabled || (local && checkPublicMcp(config.publicBaseUrl() + "/mcp", error));
        listener.onProbe(local, remote, network, error.toString());
        if (!active || !publicEnabled || "offline".equals(network)) return;
        if (remote) {
            failedPublicProbes = 0;
        } else if (++failedPublicProbes >= 3 && config.tunnelAutoReconnect()
                && System.currentTimeMillis() - lastReconnectAt > 90_000L) {
            lastReconnectAt = System.currentTimeMillis();
            failedPublicProbes = 0;
            listener.onNetworkChanged("连续三次公网端到端探测失败（" + network + "），尝试切换传输协议并重连");
        }
    }

    private boolean check(String endpoint, String kind, StringBuilder error) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(4_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Cache-Control", "no-cache");
            if (connection.getResponseCode() != 200) {
                error.append(kind).append(" /health HTTP ").append(connection.getResponseCode()).append("; ");
                return false;
            }
            try (InputStream stream = connection.getInputStream()) {
                byte[] bytes = new byte[256];
                int size = stream.read(bytes);
                if (size > 0 && "DevSpace Mobile".equals(
                        new JSONObject(new String(bytes, 0, size, StandardCharsets.UTF_8)).optString("service"))) {
                    return true;
                }
            }
            error.append(kind).append(" /health 响应身份不匹配; ");
        } catch (Exception failure) {
            error.append(kind).append(" /health: ").append(failure.getClass().getSimpleName()).append("; ");
        } finally {
            if (connection != null) connection.disconnect();
        }
        return false;
    }

    private boolean checkPublicMcp(String endpoint, StringBuilder error) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(4_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Cache-Control", "no-cache");
            int code = connection.getResponseCode();
            if (code == 405) {
                try (InputStream stream = connection.getErrorStream()) {
                    if (stream != null) {
                        byte[] bytes = new byte[64];
                        int size = stream.read(bytes);
                        if (size > 0 && new String(bytes, 0, size, StandardCharsets.UTF_8)
                                .contains("Method not allowed")) return true;
                    }
                }
            }
            error.append("public /mcp HTTP ").append(code).append(" 或服务响应不匹配; ");
        } catch (Exception failure) {
            error.append("public /mcp: ").append(failure.getClass().getSimpleName()).append("; ");
        } finally {
            if (connection != null) connection.disconnect();
        }
        return false;
    }

    private String currentNetworkName() {
        if (connectivity == null) return "unknown";
        Network network = connectivity.getActiveNetwork();
        if (network == null) return "offline";
        NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
        if (caps == null) return "unknown";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "VPN";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "Wi-Fi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "Mobile";
        return "Other";
    }

    @Override public synchronized void close() {
        if (!active) return;
        active = false;
        if (connectivity != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
        worker.shutdownNow();
    }
}
