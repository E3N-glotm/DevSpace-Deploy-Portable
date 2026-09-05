package com.devspace.agent;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Runs the Android/Bionic build of cloudflared as a root child process.
 *
 * The Cloudflare tunnel token never appears in the command line. It is stored
 * encrypted by SecureStore and materialized only as a root-readable 0600 file
 * while the foreground service is running.
 */
final class CloudflareTunnelManager implements AutoCloseable {
    interface Listener {
        void onTunnelState(String state, String detail);
    }

    static final String CLOUDFLARED_VERSION = "2026.8.2";
    static final String ARM64_ASSET = "cloudflared-arm64-v8a";
    static final String ARM64_SHA256 = "adcbc5cb319af844a4ce932f4ed656ee8656b1c478faf5001aff4b6166a950ef";

    private static final String ROOT_DIR = "/data/local/tmp/devspace-mobile";
    private static final String ROOT_BINARY = ROOT_DIR + "/cloudflared-" + CLOUDFLARED_VERSION + "-arm64";
    private static final String TOKEN_FILE = ROOT_DIR + "/tunnel.token";
    private static final String PID_FILE = ROOT_DIR + "/cloudflared.pid";

    private final Context context;
    private final AgentConfig config;
    private final RootShell rootShell;
    private final Listener listener;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> lastDiagnostic = new AtomicReference<>("");
    private volatile Thread worker;
    private volatile Process process;

    CloudflareTunnelManager(Context context, AgentConfig config, RootShell rootShell, Listener listener) {
        this.context = context.getApplicationContext();
        this.config = config;
        this.rootShell = rootShell;
        this.listener = listener;
    }

    synchronized void start() throws Exception {
        if (!config.cloudflareTunnelEnabled()) return;
        if (running.get()) return;
        if (!config.cloudflareTunnelConfigured()) {
            throw new IllegalStateException("Cloudflare Tunnel 已启用，但尚未保存 Tunnel Token");
        }
        if (!rootShell.isRootAvailable()) {
            throw new SecurityException("运行内置 Cloudflare Tunnel 需要已授权的 Root");
        }
        ensureSupportedAbi();
        ensureBinary();
        materializeToken();
        running.set(true);
        worker = new Thread(this::runLoop, "devspace-cloudflared");
        worker.start();
    }

    private void runLoop() {
        long retryMs = 1_000L;
        while (running.get()) {
            try {
                listener.onTunnelState("Tunnel 连接中", "Cloudflare Tunnel " + CLOUDFLARED_VERSION);
                int hostPid = android.os.Process.myPid();
                String hostProcess = context.getPackageName();
                String command = "set -e; mkdir -p " + ShellEscaper.quote(ROOT_DIR)
                        + "; runtime_pid=$$; echo \"$runtime_pid\" > " + ShellEscaper.quote(PID_FILE)
                        + "; (while kill -0 \"$runtime_pid\" 2>/dev/null; do "
                        + "host_cmd=$(tr '\\000' '\\n' < /proc/" + hostPid + "/cmdline 2>/dev/null | head -n 1 || true); "
                        + "if [ \"$host_cmd\" != " + ShellEscaper.quote(hostProcess) + " ]; then "
                        + "kill -TERM \"$runtime_pid\" 2>/dev/null || true; sleep 1; "
                        + "kill -KILL \"$runtime_pid\" 2>/dev/null || true; "
                        + "rm -f " + ShellEscaper.quote(PID_FILE) + " " + ShellEscaper.quote(TOKEN_FILE) + "; exit 0; fi; "
                        + "sleep 1; done; rm -f " + ShellEscaper.quote(PID_FILE)
                        + ") >/dev/null 2>&1 & "
                        + "exec " + ShellEscaper.quote(ROOT_BINARY)
                        + " tunnel --no-autoupdate --protocol auto run --token-file " + ShellEscaper.quote(TOKEN_FILE);
                Process current = rootShell.startProcess(command);
                process = current;
                lastDiagnostic.set("");
                Thread stdout = new Thread(() -> readTunnelOutput(current.getInputStream()), "devspace-cloudflared-out");
                Thread stderr = new Thread(() -> readTunnelOutput(current.getErrorStream()), "devspace-cloudflared-err");
                stdout.start();
                stderr.start();
                listener.onTunnelState("Tunnel 已启动", "公网域名由 Cloudflare Tunnel 映射到手机 127.0.0.1:" + config.localPort());
                retryMs = 1_000L;
                int exit = current.waitFor();
                process = null;
                if (!running.get()) break;
                String diagnostic = lastDiagnostic.get();
                String detail = "exit=" + exit + (diagnostic.isEmpty() ? "" : " · " + diagnostic);
                if (!config.tunnelAutoReconnect()) {
                    listener.onTunnelState("Tunnel 已退出", detail + " · 自动重连已关闭");
                    break;
                }
                listener.onTunnelState("Tunnel 已退出", detail + " · 即将自动重连");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            } catch (Throwable error) {
                if (running.get()) {
                    if (!config.tunnelAutoReconnect()) {
                        listener.onTunnelState("Tunnel 连接失败", safeMessage(error) + " · 自动重连已关闭");
                        break;
                    }
                    listener.onTunnelState("Tunnel 连接失败", safeMessage(error) + "，即将自动重连");
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

    private void readTunnelOutput(InputStream stream) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String diagnostic = line.trim().replace('\n', ' ').replace('\r', ' ');
                if (diagnostic.length() > 900) diagnostic = diagnostic.substring(0, 900) + "…";
                if (!diagnostic.isEmpty()) {
                    lastDiagnostic.set(diagnostic);
                    if (config.verboseTunnelLogs()) listener.onTunnelState("Cloudflare 日志", diagnostic);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void ensureSupportedAbi() {
        for (String abi : Build.SUPPORTED_ABIS) {
            if ("arm64-v8a".equals(abi)) return;
        }
        throw new UnsupportedOperationException(
                "当前 APK 内置 Tunnel 运行时暂只支持 arm64-v8a；设备 ABI=" + String.join(",", Build.SUPPORTED_ABIS));
    }

    private void ensureBinary() throws Exception {
        File staged = new File(context.getFilesDir(), ARM64_ASSET + "-" + CLOUDFLARED_VERSION);
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
                throw new SecurityException("Bundled cloudflared asset SHA-256 mismatch");
            }
            if (staged.exists() && !staged.delete()) throw new IllegalStateException("Unable to replace staged cloudflared");
            if (!temporary.renameTo(staged)) throw new IllegalStateException("Unable to finalize staged cloudflared");
        }

        String temporaryRootBinary = ROOT_BINARY + ".new";
        String install = "set -e; umask 077; mkdir -p " + ShellEscaper.quote(ROOT_DIR)
                + "; rm -f " + ShellEscaper.quote(temporaryRootBinary)
                + "; cp " + ShellEscaper.quote(staged.getAbsolutePath()) + " " + ShellEscaper.quote(temporaryRootBinary)
                + "; chmod 700 " + ShellEscaper.quote(temporaryRootBinary)
                + "; mv -f " + ShellEscaper.quote(temporaryRootBinary) + " " + ShellEscaper.quote(ROOT_BINARY)
                + "; " + ShellEscaper.quote(ROOT_BINARY) + " --version";
        RootShell.Result result = rootShell.exec(install, null, 45, 256 * 1024);
        if (result.exitCode != 0 || !result.outputText().contains(CLOUDFLARED_VERSION)) {
            throw new IllegalStateException("Unable to install verified cloudflared runtime: " + result.outputText().trim());
        }
    }

    private void materializeToken() throws Exception {
        byte[] token = config.cloudflareTunnelToken().getBytes(StandardCharsets.UTF_8);
        if (token.length < 16 || token.length > 64 * 1024) {
            throw new IllegalArgumentException("Cloudflare Tunnel Token 长度异常");
        }
        String command = "set -e; umask 077; mkdir -p " + ShellEscaper.quote(ROOT_DIR)
                + "; cat > " + ShellEscaper.quote(TOKEN_FILE)
                + "; chmod 600 " + ShellEscaper.quote(TOKEN_FILE);
        RootShell.Result result = rootShell.exec(command, token, 15, 128 * 1024);
        java.util.Arrays.fill(token, (byte) 0);
        if (result.exitCode != 0) {
            throw new IllegalStateException("Unable to materialize Cloudflare Tunnel Token securely");
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

    private static String safeMessage(Throwable error) {
        String value = error.getMessage();
        if (value == null || value.trim().isEmpty()) return error.getClass().getSimpleName();
        // Tunnel tokens are never intentionally present in error messages, but
        // keep the surfaced diagnostic bounded so third-party output cannot
        // flood the foreground notification/status UI.
        String trimmed = value.trim().replace('\n', ' ').replace('\r', ' ');
        return trimmed.length() <= 300 ? trimmed : trimmed.substring(0, 300) + "…";
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
                    + "rm -f " + ShellEscaper.quote(PID_FILE) + " " + ShellEscaper.quote(TOKEN_FILE),
                    null, 10, 128 * 1024);
        } catch (Exception ignored) {}
    }
}
