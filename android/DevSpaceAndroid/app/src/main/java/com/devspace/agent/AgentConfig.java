package com.devspace.agent;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

final class AgentConfig {
    private static final String PREFS = "devspace_agent";

    private final Context context;
    private final SharedPreferences prefs;
    private final SecureStore secureStore;

    AgentConfig(Context context) {
        this.context = context.getApplicationContext();
        prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        secureStore = new SecureStore(this.context);
    }

    String serverUrl() { return prefs.getString("server_url", ""); }
    void serverUrl(String value) { prefs.edit().putString("server_url", normalizeServer(value)).apply(); }

    String publicBaseUrl() { return serverUrl(); }
    void publicBaseUrl(String value) { serverUrl(value); }

    int localPort() { return Math.max(1024, Math.min(65535, prefs.getInt("local_port", 7676))); }
    void localPort(int value) { prefs.edit().putInt("local_port", Math.max(1024, Math.min(65535, value))).apply(); }

    String ownerPassword() { return secureStore.get("owner_password"); }
    void ownerPassword(String value) {
        if (value != null && !value.trim().isEmpty()) secureStore.put("owner_password", value);
    }
    boolean ownerPasswordConfigured() { return !ownerPassword().isEmpty(); }

    boolean fullAccess() { return prefs.getBoolean("standalone_full_access", false); }
    void fullAccess(boolean value) { prefs.edit().putBoolean("standalone_full_access", value).apply(); }

    String standaloneWritableRootsText() {
        return prefs.getString("standalone_writable_roots", defaultWritableRoots());
    }
    void standaloneWritableRootsText(String value) {
        prefs.edit().putString("standalone_writable_roots", value == null ? "" : value.trim()).apply();
    }
    List<String> standaloneWritableRoots() {
        List<String> result = new ArrayList<>();
        for (String line : standaloneWritableRootsText().split("[\\r\\n,;]+")) {
            String value = line.trim();
            if (!value.isEmpty()) result.add(value);
        }
        return result;
    }

    String standaloneAccessMode() { return fullAccess() ? "full-access" : "scoped"; }

    String signingSecret() {
        String existing = secureStore.get("standalone_signing_secret");
        if (!existing.isEmpty()) return existing;
        byte[] random = new byte[32];
        new java.security.SecureRandom().nextBytes(random);
        String generated = android.util.Base64.encodeToString(random, android.util.Base64.NO_WRAP);
        secureStore.put("standalone_signing_secret", generated);
        return generated;
    }

    String oauthClientsJson() { return secureStore.get("standalone_oauth_clients"); }
    void oauthClientsJson(String value) { secureStore.put("standalone_oauth_clients", value); }

    String oauthRefreshTokensJson() { return secureStore.get("standalone_oauth_refresh_tokens"); }
    void oauthRefreshTokensJson(String value) { secureStore.put("standalone_oauth_refresh_tokens", value); }

    String cloudflareTunnelToken() { return secureStore.get("cloudflare_tunnel_token"); }
    void cloudflareTunnelToken(String value) {
        if (value == null || value.trim().isEmpty()) secureStore.remove("cloudflare_tunnel_token");
        else secureStore.put("cloudflare_tunnel_token", value.trim());
    }
    boolean cloudflareTunnelConfigured() { return !cloudflareTunnelToken().isEmpty(); }
    boolean cloudflareTunnelEnabled() { return prefs.getBoolean("cloudflare_tunnel_enabled", false); }
    void cloudflareTunnelEnabled(boolean value) { prefs.edit().putBoolean("cloudflare_tunnel_enabled", value).apply(); }

    String ngrokAuthToken() { return secureStore.get("ngrok_auth_token"); }
    void ngrokAuthToken(String value) {
        if (value == null || value.trim().isEmpty()) secureStore.remove("ngrok_auth_token");
        else secureStore.put("ngrok_auth_token", value.trim());
    }
    boolean ngrokConfigured() { return !ngrokAuthToken().isEmpty(); }
    boolean ngrokTunnelEnabled() { return prefs.getBoolean("ngrok_tunnel_enabled", false); }
    void ngrokTunnelEnabled(boolean value) { prefs.edit().putBoolean("ngrok_tunnel_enabled", value).apply(); }

    String ngrokApiKey() { return secureStore.get("ngrok_api_key"); }
    void ngrokApiKey(String value) {
        if (value == null || value.trim().isEmpty()) secureStore.remove("ngrok_api_key");
        else secureStore.put("ngrok_api_key", value.trim());
    }
    boolean ngrokApiKeyConfigured() { return !ngrokApiKey().isEmpty(); }

    boolean tunnelAutoReconnect() { return prefs.getBoolean("tunnel_auto_reconnect", true); }
    void tunnelAutoReconnect(boolean value) { prefs.edit().putBoolean("tunnel_auto_reconnect", value).apply(); }

    boolean verboseTunnelLogs() { return prefs.getBoolean("verbose_tunnel_logs", true); }
    void verboseTunnelLogs(boolean value) { prefs.edit().putBoolean("verbose_tunnel_logs", value).apply(); }

    boolean keepWakeLock() { return prefs.getBoolean("keep_wake_lock", true); }
    void keepWakeLock(boolean value) { prefs.edit().putBoolean("keep_wake_lock", value).apply(); }

    boolean allowScreenControl() { return prefs.getBoolean("allow_screen_control", true); }
    void allowScreenControl(boolean value) { prefs.edit().putBoolean("allow_screen_control", value).apply(); }

    boolean allowAppManagement() { return prefs.getBoolean("allow_app_management", true); }
    void allowAppManagement(boolean value) { prefs.edit().putBoolean("allow_app_management", value).apply(); }

    boolean allowFileWrite() { return prefs.getBoolean("allow_file_write", true); }
    void allowFileWrite(boolean value) { prefs.edit().putBoolean("allow_file_write", value).apply(); }

    String tunnelProvider() {
        if (ngrokTunnelEnabled()) return "ngrok";
        if (cloudflareTunnelEnabled()) return "cloudflare";
        return "none";
    }

    void validateTunnelSelection() {
        if (cloudflareTunnelEnabled() && ngrokTunnelEnabled()) {
            throw new IllegalStateException("Cloudflare Tunnel 和 ngrok Tunnel 不能同时启用");
        }
    }

    void clearStandaloneOAuthState() {
        secureStore.remove("standalone_oauth_clients");
        secureStore.remove("standalone_oauth_refresh_tokens");
        secureStore.remove("standalone_signing_secret");
    }

    void clearNgrokCredentials() {
        secureStore.remove("ngrok_auth_token");
        secureStore.remove("ngrok_api_key");
        prefs.edit().putBoolean("ngrok_tunnel_enabled", false).apply();
    }

    boolean startOnBoot() { return prefs.getBoolean("start_on_boot", false); }
    void startOnBoot(boolean value) {
        prefs.edit().putBoolean("start_on_boot", value).apply();
        ComponentName receiver = new ComponentName(context, BootReceiver.class);
        int state = value
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        context.getPackageManager().setComponentEnabledSetting(receiver, state, PackageManager.DONT_KILL_APP);
    }

    boolean serviceRequested() { return prefs.getBoolean("service_requested", false); }
    void serviceRequested(boolean value) { prefs.edit().putBoolean("service_requested", value).apply(); }

    void packageReplaceEvent(String status, String error) {
        prefs.edit()
                .putLong("last_package_replaced_at", System.currentTimeMillis())
                .putString("last_package_replace_status", status == null ? "" : status)
                .putString("last_package_replace_error", error == null ? "" : error)
                .commit();
    }

    String lastState() { return prefs.getString("last_state", "服务未启动"); }
    String lastError() { return prefs.getString("last_error", ""); }
    boolean rootGranted() { return prefs.getBoolean("root_granted", false); }

    void runtimeState(String state, String error, boolean rootGranted) {
        prefs.edit()
                .putString("last_state", state == null ? "" : state)
                .putString("last_error", error == null ? "" : error)
                .putBoolean("root_granted", rootGranted)
                .apply();
    }

    static String normalizeServer(String value) {
        String text = value == null ? "" : value.trim();
        while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
        if (text.endsWith("/mcp")) text = text.substring(0, text.length() - 4);
        return text;
    }

    @SuppressWarnings("deprecation")
    private static String defaultWritableRoots() {
        String external = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
        return external + "/DevSpace\n/data/local/tmp/devspace";
    }

}
