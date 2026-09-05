package com.devspace.agent;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Runs the Android-native ngrok Agent SDK bridge bundled in the APK.
 *
 * The previous build embedded ngrok's Linux CLI binary. Android is not listed
 * as a supported CLI target by ngrok, so this runtime instead compiles the
 * official Go Agent SDK for GOOS=android/arm64. The authtoken is delivered to
 * the bridge over stdin and never appears in argv or environment variables.
 */
final class NgrokTunnelManager implements AutoCloseable {
    interface Listener {
        void onTunnelState(String state, String detail);
    }

    static final String NGROK_SDK_VERSION = "2.1.4";
    static final String RUNTIME_VERSION = "devspace-ngrok-sdk-2.1.4";
    static final String ARM64_ASSET = "ngrok-android-arm64";
    static final String ARM64_SHA256 = "6e7495dbf4f2031bd6d36f5935bf9a97aefa15d6b1c48805b0064b46a0d787bd";

    private static final String ROOT_DIR = "/data/local/tmp/devspace-mobile";
    private static final String ROOT_BINARY = ROOT_DIR + "/ngrok-android-sdk-2.1.4-arm64";
    private static final String PID_FILE = ROOT_DIR + "/ngrok.pid";

    private final Context context;
    private final AgentConfig config;
    private final RootShell rootShell;
    private final Listener listener;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> lastDiagnostic = new AtomicReference<>("");
    private volatile Thread worker;
    private volatile Process process;

    NgrokTunnelManager(Context context, AgentConfig config, RootShell rootShell, Listener listener) {
        this.context = context.getApplicationContext();
        this.config = config;
        this.rootShell = rootShell;
        this.listener = listener;
    }

    synchronized void start() throws Exception {
        if (!config.ngrokTunnelEnabled()) return;
        if (running.get()) return;
        if (!config.ngrokConfigured()) {
            throw new IllegalStateException("ngrok 已启用，但尚未保存 Authtoken。可在 APK 中用 ngrok API Key 自动生成。");
        }
        String publicBase = config.publicBaseUrl();
        if (!publicBase.startsWith("https://")) {
            throw new IllegalArgumentException("ngrok Public Base URL 必须是 https:// 开头的 ngrok 域名");
        }
        if (!rootShell.isRootAvailable()) {
            throw new SecurityException("运行内置 ngrok SDK runtime 需要已授权的 Root");
        }
        ensureSupportedAbi();
        ensureBinary();
        running.set(true);
        worker = new Thread(this::runLoop, "devspace-ngrok-sdk");
        worker.start();
    }

    private void runLoop() {
        long retryMs = 1_000L;
        while (running.get()) {
            Thread stdout = null;
            Thread stderr = null;
            try {
                lastDiagnostic.set("");
                listener.onTunnelState("ngrok 连接中", "Android-native Agent SDK " + NGROK_SDK_VERSION + " · " + config.publicBaseUrl());
                int hostPid = android.os.Process.myPid();
                String hostProcess = context.getPackageName();
                String command = "set -e; mkdir -p " + ShellEscaper.quote(ROOT_DIR)
                        + "; runtime_pid=$$; echo \"$runtime_pid\" > " + ShellEscaper.quote(PID_FILE)
                        + "; (while kill -0 \"$runtime_pid\" 2>/dev/null; do "
                        + "host_cmd=$(tr '\\000' '\\n' < /proc/" + hostPid + "/cmdline 2>/dev/null | head -n 1 || true); "
                        + "if [ \"$host_cmd\" != " + ShellEscaper.quote(hostProcess) + " ]; then "
                        + "kill -TERM \"$runtime_pid\" 2>/dev/null || true; sleep 1; "
                        + "kill -KILL \"$runtime_pid\" 2>/dev/null || true; "
                        + "rm -f " + ShellEscaper.quote(PID_FILE) + "; exit 0; fi; "
                        + "sleep 1; done; rm -f " + ShellEscaper.quote(PID_FILE)
                        + ") >/dev/null 2>&1 & "
                        + "exec " + ShellEscaper.quote(ROOT_BINARY);
                Process current = rootShell.startProcess(command);
                process = current;

                stdout = new Thread(() -> readBridgeOutput(current.getInputStream(), true), "devspace-ngrok-out");
                stderr = new Thread(() -> readBridgeOutput(current.getErrorStream(), false), "devspace-ngrok-err");
                stdout.start();
                stderr.start();

                JSONObject launch = new JSONObject()
                        .put("authtoken", config.ngrokAuthToken())
                        .put("url", config.publicBaseUrl())
                        .put("upstream", "http://127.0.0.1:" + config.localPort());
                byte[] secretPayload = launch.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream input = current.getOutputStream()) {
                    input.write(secretPayload);
                    input.write('\n');
                    input.flush();
                } finally {
                    java.util.Arrays.fill(secretPayload, (byte) 0);
                }

                retryMs = 1_000L;
                int exit = current.waitFor();
                process = null;
                if (stdout != null) stdout.join(1_000L);
                if (stderr != null) stderr.join(1_000L);
                if (!running.get()) break;
                String diagnostic = lastDiagnostic.get();
                String detail = "ngrok runtime exit=" + exit;
                if (!diagnostic.isEmpty()) detail += " · " + diagnostic;
                if (!config.tunnelAutoReconnect()) {
                    listener.onTunnelState("ngrok 已退出", detail + " · 自动重连已关闭");
                    break;
                }
                listener.onTunnelState("ngrok 已退出", detail + " · 即将自动重连");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            } catch (Throwable error) {
                if (running.get()) {
                    String detail = safeMessage(error);
                    if (!config.tunnelAutoReconnect()) {
                        listener.onTunnelState("ngrok 连接失败", detail + " · 自动重连已关闭");
                        break;
                    }
                    listener.onTunnelState("ngrok 连接失败", detail + " · 即将自动重连");
                }
            }
            if (!running.get()) break;
            try {
                Thread.sleep(retryMs);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
            retryMs = Math.min(30_000L, retryMs * 2L);
        }
    }

    private void readBridgeOutput(InputStream stream, boolean structured) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String bounded = bound(line);
                if (structured) {
                    try {
                        JSONObject event = new JSONObject(line);
                        String type = event.optString("event", "");
                        if ("online".equals(type)) {
                            String url = event.optString("url", config.publicBaseUrl());
                            lastDiagnostic.set("online " + url);
                            listener.onTunnelState("ngrok 已在线", url + " → 127.0.0.1:" + config.localPort());
                            continue;
                        }
                        if ("error".equals(type)) {
                            String code = event.optString("code", "");
                            String message = event.optString("message", "ngrok error");
                            String detail = (code.isEmpty() ? "" : code + " · ") + message;
                            lastDiagnostic.set(bound(detail));
                            listener.onTunnelState("ngrok 错误", bound(detail));
                            continue;
                        }
                        if ("stopped".equals(type)) {
                            lastDiagnostic.set("stopped: " + event.optString("reason", "unknown"));
                            continue;
                        }
                    } catch (Exception ignored) {
                    }
                }
                if (!bounded.isEmpty()) {
                    lastDiagnostic.set(bounded);
                    if (config.verboseTunnelLogs()) listener.onTunnelState("ngrok 日志", bounded);
                }
            }
        } catch (Exception error) {
            if (running.get()) lastDiagnostic.set(bound(safeMessage(error)));
        }
    }

    private void ensureSupportedAbi() {
        for (String abi : Build.SUPPORTED_ABIS) {
            if ("arm64-v8a".equals(abi)) return;
        }
        throw new UnsupportedOperationException(
                "当前内置 ngrok SDK runtime 暂只支持 arm64-v8a；设备 ABI=" + String.join(",", Build.SUPPORTED_ABIS));
    }

    private void ensureBinary() throws Exception {
        File staged = new File(context.getFilesDir(), ARM64_ASSET + "-" + NGROK_SDK_VERSION);
        if (!staged.isFile() || !ARM64_SHA256.equals(sha256(staged))) {
            File temporary = new File(staged.getAbsolutePath() + ".tmp");
            try (InputStream input = context.getAssets().open(ARM64_ASSET);
                 FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[128 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count > 0) output.write(buffer, 0, count);
                }
                output.getFD().sync();
            }
            if (!ARM64_SHA256.equals(sha256(temporary))) {
                //noinspection ResultOfMethodCallIgnored
                temporary.delete();
                throw new SecurityException("Bundled Android ngrok SDK runtime SHA-256 mismatch");
            }
            if (staged.exists() && !staged.delete()) throw new IllegalStateException("Unable to replace staged ngrok runtime");
            if (!temporary.renameTo(staged)) throw new IllegalStateException("Unable to finalize staged ngrok runtime");
        }

        String temporaryRootBinary = ROOT_BINARY + ".new";
        String install = "set -e; umask 077; mkdir -p " + ShellEscaper.quote(ROOT_DIR)
                + "; rm -f " + ShellEscaper.quote(temporaryRootBinary)
                + "; cp " + ShellEscaper.quote(staged.getAbsolutePath()) + " " + ShellEscaper.quote(temporaryRootBinary)
                + "; chmod 700 " + ShellEscaper.quote(temporaryRootBinary)
                + "; mv -f " + ShellEscaper.quote(temporaryRootBinary) + " " + ShellEscaper.quote(ROOT_BINARY)
                + "; " + ShellEscaper.quote(ROOT_BINARY) + " --version";
        RootShell.Result result = rootShell.exec(install, null, 45, 256 * 1024);
        if (result.exitCode != 0 || !result.outputText().contains(RUNTIME_VERSION)) {
            throw new IllegalStateException("Unable to install verified Android ngrok runtime: " + result.outputText().trim());
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[128 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) digest.update(buffer, 0, count);
            }
        }
        StringBuilder out = new StringBuilder();
        for (byte value : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static String bound(String value) {
        String text = value == null ? "" : value.trim().replace('\n', ' ').replace('\r', ' ');
        return text.length() <= 900 ? text : text.substring(0, 900) + "…";
    }

    private static String safeMessage(Throwable error) {
        String value = error.getMessage();
        if (value == null || value.trim().isEmpty()) return error.getClass().getSimpleName();
        return bound(value);
    }

    @Override public synchronized void close() {
        if (!running.getAndSet(false)) return;
        Thread currentWorker = worker;
        worker = null;
        if (currentWorker != null) currentWorker.interrupt();
        Process current = process;
        process = null;
        if (current != null) {
            current.destroy();
            try { current.waitFor(500, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
            if (current.isAlive()) current.destroyForcibly();
        }
        try {
            rootShell.exec("if [ -f " + ShellEscaper.quote(PID_FILE) + " ]; then "
                            + "pid=$(cat " + ShellEscaper.quote(PID_FILE) + " 2>/dev/null || true); "
                            + "case \"$pid\" in ''|*[!0-9]*) ;; *) kill \"$pid\" 2>/dev/null || true ;; esac; fi; "
                            + "rm -f " + ShellEscaper.quote(PID_FILE),
                    null, 10, 128 * 1024);
        } catch (Exception ignored) {}
    }
}
