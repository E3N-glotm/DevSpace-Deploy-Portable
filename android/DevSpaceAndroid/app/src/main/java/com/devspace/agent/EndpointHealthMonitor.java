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
    private static final long NETWORK_SETTLE_GRACE_MS = 12_000L;
    private static final long[] NETWORK_REPROBE_DELAYS_MS = {3_000L, 7_000L, 13_000L};
    private static final long FAILURE_REPROBE_DELAY_MS = 3_000L;
    private static final long RECONNECT_COOLDOWN_MS = 20_000L;

    interface Listener {
        void onProbe(boolean localOk, boolean publicOk, String network, String issue);
        void onNetworkLost();
        void onNetworkChanged(String detail);
    }

    interface TunnelSignal {
        boolean hasCloudflareEdge();
    }

    private final AgentConfig config;
    private final TunnelSignal tunnelSignal;
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
    private volatile long networkSettlingUntil;
    private volatile int networkEpoch;

    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            if (!active) return;
            Network previous = currentNetwork;
            currentNetwork = network;
            worker.execute(() -> {
                if (!active) return;
                if (previous != null && !previous.equals(network)) {
                    failedPublicProbes = 0;
                    int epoch = ++networkEpoch;
                    networkSettlingUntil = System.currentTimeMillis() + NETWORK_SETTLE_GRACE_MS;
                    listener.onNetworkChanged("默认网络已切换为 " + currentNetworkName()
                            + "，等待路由稳定并重新建立公网隧道");
                    scheduleNetworkReprobes(epoch);
                    return;
                }
                runProbe();
            });
        }

        @Override public void onLost(Network network) {
            if (!active || !network.equals(currentNetwork)) return;
            currentNetwork = null;
            networkEpoch++;
            networkSettlingUntil = 0L;
            worker.execute(() -> { if (active) listener.onNetworkLost(); });
        }
    };

    EndpointHealthMonitor(Context context, AgentConfig config,
                          TunnelSignal tunnelSignal, Listener listener) {
        this.config = config;
        this.tunnelSignal = tunnelSignal;
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
        String provider = config.tunnelProvider();
        boolean publicEnabled = !"none".equals(provider);
        boolean cloudflareEdge = "cloudflare".equals(provider)
                && tunnelSignal != null && tunnelSignal.hasCloudflareEdge();
        // A phone reaching its own Cloudflare hostname is a hairpin/self-access
        // test, not an external reachability test. Box/VPN/DNS policy can break
        // that path while the edge tunnel remains fully reachable from outside.
        // For Cloudflare, a verified local MCP plus a registered edge connection
        // is authoritative. Do not even perform the hairpin request while an
        // edge is registered; it is only a fallback before edge registration.
        boolean selfPublic = false;
        boolean remote;
        if (!publicEnabled) {
            remote = true;
        } else if (!local) {
            remote = false;
        } else if ("cloudflare".equals(provider)) {
            // cloudflared already owns edge reconnection/backoff. Treat its
            // registered edge set as the authoritative Cloudflare signal and
            // never turn a phone->own-hostname hairpin failure into a process
            // restart. Killing cloudflared while it is recovering creates a
            // self-sustaining 530 -> SIGTERM -> STARTING loop.
            remote = cloudflareEdge;
        } else {
            selfPublic = checkPublicMcp(config.publicBaseUrl() + "/mcp", error);
            remote = selfPublic;
        }
        if (remote && cloudflareEdge) error.setLength(0);
        long now = System.currentTimeMillis();
        if (publicEnabled && local && !remote && now < networkSettlingUntil) {
            // Route/DNS/TProxy rebuilds can briefly interrupt the public path
            // while Android is switching the default network. Keep the UI in
            // "connecting" instead of promoting one transient failure to a
            // DEGRADED/ERROR state; the scheduled fast probes below confirm
            // recovery before the normal 20s cadence resumes.
            failedPublicProbes = 0;
            return;
        }
        if (publicEnabled && local && !remote) {
            int failures = ++failedPublicProbes;
            if (failures == 1) {
                int epoch = networkEpoch;
                worker.schedule(() -> {
                    if (active && epoch == networkEpoch) runProbe();
                }, FAILURE_REPROBE_DELAY_MS, TimeUnit.MILLISECONDS);
                return;
            }
            if ("cloudflare".equals(provider)) {
                // Do not actively restart a live cloudflared process because
                // its edge set is temporarily empty. Its own reconnect loop
                // is more informed about QUIC/HTTP2 transport state and edge
                // backoff. Surface CONNECTING/DEGRADED state only.
                listener.onProbe(local, false, network,
                        "Cloudflare edge 尚未注册；等待 cloudflared 自主重连");
                return;
            }
            if (config.tunnelAutoReconnect()
                    && now - lastReconnectAt >= RECONNECT_COOLDOWN_MS) {
                lastReconnectAt = now;
                failedPublicProbes = 0;
                int epoch = ++networkEpoch;
                networkSettlingUntil = now + NETWORK_SETTLE_GRACE_MS;
                listener.onNetworkChanged("公网端到端连续探测失败（" + network
                        + "），快速重建 Cloudflare 隧道");
                scheduleNetworkReprobes(epoch);
                return;
            }
        }
        if (remote) networkSettlingUntil = 0L;
        listener.onProbe(local, remote, network, error.toString());
        if (!active || !publicEnabled || "offline".equals(network)) return;
        if (remote) {
            failedPublicProbes = 0;
        }
    }

    private void scheduleNetworkReprobes(int epoch) {
        for (long delay : NETWORK_REPROBE_DELAYS_MS) {
            worker.schedule(() -> {
                if (active && epoch == networkEpoch) runProbe();
            }, delay, TimeUnit.MILLISECONDS);
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
