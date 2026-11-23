package com.devspace.agent;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.text.InputType;
import android.widget.EditText;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private AgentConfig config;
    private WebView webView;
    private AlertDialog credentialDialog;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(com.devspace.agent.R.layout.activity_main);
        config = new AgentConfig(this);
        webView = findViewById(com.devspace.agent.R.id.webUi);
        configureWebView();
        requestNotificationPermission();
    }

    @Override protected void onResume() {
        super.onResume();
        pushState();
    }

    @Override protected void onDestroy() {
        if (credentialDialog != null) credentialDialog.dismiss();
        if (webView != null) {
            webView.removeJavascriptInterface("DevSpaceNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setDatabaseEnabled(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setVerticalScrollBarEnabled(true);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new UiBridge(), "DevSpaceNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return true;
            }
        });

        try {
            String html = readAsset("ui/index.html");
            webView.loadDataWithBaseURL("https://devspace.local/", html, "text/html", "UTF-8", null);
        } catch (Exception error) {
            webView.loadData("<h2>DevSpace UI load failed</h2><pre>" + html(error.getMessage()) + "</pre>",
                    "text/html", "UTF-8");
        }
    }

    private final class UiBridge {
        @JavascriptInterface public String getState() {
            return stateJson().toString();
        }

        @JavascriptInterface public String saveConfig(String raw) {
            try {
                JSONObject input = new JSONObject(raw == null ? "{}" : raw);
                config.publicBaseUrl(input.optString("publicBaseUrl", config.publicBaseUrl()));
                config.localPort(input.optInt("localPort", config.localPort()));
                String ownerPassword = input.optString("ownerPassword", "");
                if (!ownerPassword.isEmpty()) config.ownerPassword(ownerPassword);
                String ngrokToken = input.optString("ngrokToken", "");
                if (!ngrokToken.isEmpty()) config.ngrokAuthToken(ngrokToken);
                String ngrokApiKey = input.optString("ngrokApiKey", "");
                if (!ngrokApiKey.isEmpty()) config.ngrokApiKey(ngrokApiKey);
                String cloudflareToken = input.optString("cloudflareToken", "");
                if (!cloudflareToken.isEmpty()) config.cloudflareTunnelToken(cloudflareToken);

                config.fullAccess(input.optBoolean("fullAccess", config.fullAccess()));
                config.startOnBoot(input.optBoolean("startOnBoot", config.startOnBoot()));
                config.keepWakeLock(input.optBoolean("keepWakeLock", config.keepWakeLock()));
                config.allowScreenControl(input.optBoolean("allowScreenControl", config.allowScreenControl()));
                config.allowAppManagement(input.optBoolean("allowAppManagement", config.allowAppManagement()));
                config.allowFileWrite(input.optBoolean("allowFileWrite", config.allowFileWrite()));
                config.tunnelAutoReconnect(input.optBoolean("tunnelAutoReconnect", config.tunnelAutoReconnect()));
                config.verboseTunnelLogs(input.optBoolean("verboseTunnelLogs", config.verboseTunnelLogs()));
                config.standaloneWritableRootsText(input.optString("writableRoots", config.standaloneWritableRootsText()));
                config.ngrokTunnelEnabled(input.optBoolean("ngrokEnabled", config.ngrokTunnelEnabled()));
                config.cloudflareTunnelEnabled(input.optBoolean("cloudflareEnabled", config.cloudflareTunnelEnabled()));
                config.validateTunnelSelection();
                pushState();
                return ok("配置已保存").toString();
            } catch (Throwable error) {
                return fail(error).toString();
            }
        }

        @JavascriptInterface public String startServer() {
            try {
                config.validateTunnelSelection();
                if (config.publicBaseUrl().isEmpty()) throw new IllegalStateException("请先设置 Public Base URL");
                if (!config.ownerPasswordConfigured()) throw new IllegalStateException("请先设置 Owner Password");
                if (config.ngrokTunnelEnabled() && !config.ngrokConfigured()) {
                    throw new IllegalStateException("ngrok 已启用，但还没有 Authtoken");
                }
                if (config.cloudflareTunnelEnabled() && !config.cloudflareTunnelConfigured()) {
                    throw new IllegalStateException("Cloudflare 已启用，但还没有 Tunnel Token");
                }
                runOnUiThread(() -> {
                    Intent service = new Intent(MainActivity.this, DevSpaceAgentService.class)
                            .setAction(DevSpaceAgentService.ACTION_START)
                            .putExtra(DevSpaceAgentService.EXTRA_START_REASON, "manual");
                    startForegroundService(service);
                });
                return ok("启动请求已发送").toString();
            } catch (Throwable error) {
                return fail(error).toString();
            }
        }

        @JavascriptInterface public String stopServer() {
            ServiceRuntimeStatus.stopping("已发送停止请求");
            runOnUiThread(() -> startService(new Intent(MainActivity.this, DevSpaceAgentService.class)
                    .setAction(DevSpaceAgentService.ACTION_STOP)));
            return ok("停止请求已发送").toString();
        }

        @JavascriptInterface public String checkRoot() {
            new Thread(() -> {
                boolean granted = new RootShell().isRootAvailable();
                config.runtimeState(config.lastState(), config.lastError(), granted);
                ServiceRuntimeStatus.root(granted);
                JSONObject result = ok(granted ? "Root 已授权" : "未获得 Root；请在 Magisk / KernelSU / APatch 中允许 DevSpace Mobile");
                try { result.put("ok", granted); } catch (Exception ignored) {}
                pushEvent("rootCheck", result);
                pushState();
            }, "devspace-root-check").start();
            return ok("正在请求 / 检测 Root").toString();
        }

        @JavascriptInterface public String provisionNgrok(String raw) {
            try {
                JSONObject input = new JSONObject(raw == null ? "{}" : raw);
                String key = input.optString("apiKey", "").trim();
                if (!key.isEmpty()) config.ngrokApiKey(key);
                String effective = key.isEmpty() ? config.ngrokApiKey() : key;
                if (effective.isEmpty()) throw new IllegalStateException("请先粘贴 ngrok API Key");
                new Thread(() -> {
                    try {
                        JSONObject credential = NgrokApiClient.createTunnelCredential(effective, config.publicBaseUrl());
                        config.ngrokAuthToken(credential.getString("token"));
                        JSONObject result = ok("已通过 ngrok API 创建独立 Authtoken")
                                .put("credentialId", credential.optString("id", ""));
                        pushEvent("ngrokProvision", result);
                        pushState();
                    } catch (Throwable error) {
                        pushEvent("ngrokProvision", fail(error));
                    }
                }, "devspace-ngrok-provision").start();
                return ok("正在通过 ngrok API 创建 Authtoken").toString();
            } catch (Throwable error) {
                return fail(error).toString();
            }
        }

        @JavascriptInterface public String discoverNgrokDomains(String raw) {
            try {
                JSONObject input = new JSONObject(raw == null ? "{}" : raw);
                String key = input.optString("apiKey", "").trim();
                if (!key.isEmpty()) config.ngrokApiKey(key);
                String effective = key.isEmpty() ? config.ngrokApiKey() : key;
                if (effective.isEmpty()) throw new IllegalStateException("请先粘贴 ngrok API Key");
                new Thread(() -> {
                    try {
                        JSONArray domains = NgrokApiClient.listReservedDomains(effective);
                        pushEvent("ngrokDomains", ok("已读取 ngrok 域名").put("domains", domains));
                    } catch (Throwable error) {
                        pushEvent("ngrokDomains", fail(error));
                    }
                }, "devspace-ngrok-domains").start();
                return ok("正在读取 ngrok 域名").toString();
            } catch (Throwable error) {
                return fail(error).toString();
            }
        }

        @JavascriptInterface public String clearNgrok() {
            config.clearNgrokCredentials();
            pushState();
            return ok("已清除 ngrok Authtoken、API Key 并关闭 ngrok").toString();
        }

        @JavascriptInterface public String clearCloudflare() {
            config.cloudflareTunnelToken("");
            config.cloudflareTunnelEnabled(false);
            pushState();
            return ok("已清除 Cloudflare Tunnel Token").toString();
        }

        @JavascriptInterface public String clearOAuth() {
            config.clearStandaloneOAuthState();
            pushState();
            return ok("已清除 MCP OAuth 客户端状态").toString();
        }

        @JavascriptInterface public void openExternal(String target) {
            String url;
            if ("ngrok-api-key".equals(target)) url = "https://dashboard.ngrok.com/api-keys";
            else if ("ngrok-authtoken".equals(target)) url = "https://dashboard.ngrok.com/get-started/your-authtoken";
            else if ("ngrok-domains".equals(target)) url = "https://dashboard.ngrok.com/domains";
            else if ("cloudflare".equals(target)) url = "https://one.dash.cloudflare.com/";
            else return;
            runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
        }

        @JavascriptInterface public String copyCredential(String field) {
            String label = credentialLabel(field);
            if (label == null) return okFailure("不支持的凭据类型").toString();
            runOnUiThread(() -> {
                try {
                    if (isFinishing() || isDestroyed()) throw new IllegalStateException();
                    String value = "ownerPassword".equals(field)
                            ? config.ownerPassword() : config.cloudflareTunnelToken();
                    if (value.isEmpty()) {
                        pushEvent("credentialCopied", okFailure("请先设置 " + label));
                        return;
                    }
                    ClipboardManager manager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (manager == null) throw new IllegalStateException();
                    ClipData clip = ClipData.newPlainText(label, value);
                    if (Build.VERSION.SDK_INT >= 33) {
                        PersistableBundle extras = new PersistableBundle();
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                        clip.getDescription().setExtras(extras);
                    }
                    manager.setPrimaryClip(clip);
                    pushEvent("credentialCopied", ok(label + " 已复制"));
                } catch (Throwable error) {
                    pushEvent("credentialCopied", okFailure("无法复制凭据，请重试"));
                }
            });
            return ok("正在复制").toString();
        }

        @JavascriptInterface public String changeCredential(String field) {
            if (credentialLabel(field) == null) return okFailure("不支持的凭据类型").toString();
            runOnUiThread(() -> showCredentialDialog(field));
            return ok("正在打开凭据设置").toString();
        }

        @JavascriptInterface public String copyText(String value) {
            runOnUiThread(() -> {
                ClipboardManager manager = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (manager != null) manager.setPrimaryClip(ClipData.newPlainText("DevSpace", value == null ? "" : value));
            });
            return ok("已复制").toString();
        }
    }

    private static String credentialLabel(String field) {
        if ("ownerPassword".equals(field)) return "Owner Password";
        if ("cloudflareToken".equals(field)) return "Cloudflare Tunnel Token";
        return null;
    }

    private void showCredentialDialog(String field) {
        String label = credentialLabel(field);
        if (label == null || isFinishing() || isDestroyed()) return;
        if (credentialDialog != null && credentialDialog.isShowing()) return;
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setSingleLine(true);
        input.setHint("输入新的 " + label);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("设置 / 更换 " + label)
                .setMessage("保存后替换当前凭据；取消保留原值。")
                .setView(input)
                .setNegativeButton("取消", (ignored, which) -> input.setText(""))
                .setPositiveButton("保存", null)
                .create();
        credentialDialog = dialog;
        dialog.setOnDismissListener(ignored -> {
            input.setText("");
            if (credentialDialog == dialog) credentialDialog = null;
        });
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = input.getText().toString();
            if (value.trim().isEmpty()) {
                input.setError("请输入新凭据，或取消以保留原值");
                return;
            }
            try {
                if ("ownerPassword".equals(field)) config.ownerPassword(value);
                else config.cloudflareTunnelToken(value);
                input.setText("");
                dialog.dismiss();
                pushState();
                pushEvent("credentialChanged", ok("ownerPassword".equals(field)
                        ? "Owner Password 已保存"
                        : "Cloudflare Tunnel Token 已保存，下次连接时生效"));
            } catch (Throwable error) {
                input.setError("保存失败，请重试；取消可关闭设置");
            }
        }));
        dialog.show();
    }

    private static JSONObject okFailure(String message) {
        try { return new JSONObject().put("ok", false).put("message", message); }
        catch (Exception ignored) { return new JSONObject(); }
    }

    private JSONObject stateJson() {
        try {
            JSONObject runtime = ServiceRuntimeStatus.json();
            return new JSONObject()
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("state", runtime.optString("state", "STOPPED"))
                    .put("headline", runtime.optString("headline", "服务已停止"))
                    .put("detail", runtime.optString("detail", ""))
                    .put("runMode", runtime.optString("runMode", "manual"))
                    .put("mcpState", runtime.optString("mcpState", "stopped"))
                    .put("tunnelState", runtime.optString("tunnelState", "stopped"))
                    .put("uptimeMs", runtime.optLong("uptimeMs", 0L))
                    .put("lastError", runtime.optString("lastError", ""))
                    .put("activeNetwork", runtime.optString("activeNetwork", "unknown"))
                    .put("lastProbeAt", runtime.optLong("lastProbeAt", 0L))
                    .put("lastHealthyAt", runtime.optLong("lastHealthyAt", 0L))
                    .put("lastProbeError", runtime.optString("lastProbeError", ""))
                    .put("lastTunnelDiagnostic", runtime.optString("lastTunnelDiagnostic", ""))
                    .put("rootGranted", config.rootGranted())
                    .put("publicBaseUrl", config.publicBaseUrl())
                    .put("localPort", config.localPort())
                    .put("fullAccess", config.fullAccess())
                    .put("startOnBoot", config.startOnBoot())
                    .put("keepWakeLock", config.keepWakeLock())
                    .put("allowScreenControl", config.allowScreenControl())
                    .put("allowAppManagement", config.allowAppManagement())
                    .put("allowFileWrite", config.allowFileWrite())
                    .put("tunnelAutoReconnect", config.tunnelAutoReconnect())
                    .put("verboseTunnelLogs", config.verboseTunnelLogs())
                    .put("writableRoots", config.standaloneWritableRootsText())
                    .put("ngrokEnabled", config.ngrokTunnelEnabled())
                    .put("ngrokConfigured", config.ngrokConfigured())
                    .put("ngrokApiKeyConfigured", config.ngrokApiKeyConfigured())
                    .put("cloudflareEnabled", config.cloudflareTunnelEnabled())
                    .put("cloudflareConfigured", config.cloudflareTunnelConfigured())
                    .put("tunnelProvider", config.tunnelProvider())
                    .put("ownerPasswordConfigured", config.ownerPasswordConfigured())
                    .put("ngrokRuntime", NgrokTunnelManager.RUNTIME_VERSION)
                    .put("cloudflaredRuntime", CloudflareTunnelManager.CLOUDFLARED_VERSION);
        } catch (Exception error) {
            return fail(error);
        }
    }

    private void pushState() {
        WebView current = webView;
        if (current == null) return;
        String payload = stateJson().toString();
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript("window.DevSpaceUI&&DevSpaceUI.onState(" + payload + ")", null);
        });
    }

    private void pushEvent(String name, JSONObject data) {
        String event = JSONObject.quote(name);
        String payload = data == null ? "{}" : data.toString();
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript("window.DevSpaceUI&&DevSpaceUI.onEvent(" + event + "," + payload + ")", null);
        });
    }

    private static JSONObject ok(String message) {
        try { return new JSONObject().put("ok", true).put("message", message); }
        catch (Exception ignored) { return new JSONObject(); }
    }

    private static JSONObject fail(Throwable error) {
        try {
            String message = error == null ? "Unknown error" : String.valueOf(error.getMessage());
            if (message == null || "null".equals(message)) message = error.getClass().getSimpleName();
            return new JSONObject().put("ok", false).put("message", message);
        } catch (Exception ignored) { return new JSONObject(); }
    }

    private String readAsset(String path) throws Exception {
        try (InputStream input = getAssets().open(path); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) if (count > 0) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String html(String value) {
        return (value == null ? "" : value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 143);
        }
    }
}
