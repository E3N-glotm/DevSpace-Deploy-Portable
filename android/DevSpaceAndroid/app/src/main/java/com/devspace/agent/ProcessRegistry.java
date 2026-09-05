package com.devspace.agent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

final class ProcessRegistry {
    private static final int MAX_RECORDS = 200;
    private static final int MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

    private final RootShell shell;
    private final PathGuard guard;
    private final Map<String, Record> records = new ConcurrentHashMap<>();

    ProcessRegistry(RootShell shell, PathGuard guard) {
        this.shell = shell;
        this.guard = guard;
    }

    JSONObject start(JSONObject params) throws Exception {
        if (!guard.fullAccess()) throw new SecurityException("Scoped Android Agent rejects arbitrary Root processes. Enable Full Access first.");
        if (params.optBoolean("tty", false)) throw new UnsupportedOperationException("Android Agent PTY processes are not supported in this APK build.");
        if (params.optBoolean("persistent", false)) throw new UnsupportedOperationException("Android Agent persistent processes are not yet restart-survivable.");
        if (records.size() >= MAX_RECORDS) pruneCompleted();
        if (records.size() >= MAX_RECORDS) throw new IllegalStateException("Android process registry limit reached.");

        String root = guard.workspaceRoot(params.getString("root"));
        String cwd = guard.absolute(root, params.optString("cwd", root));
        boolean hasCommand = params.has("command") && !params.isNull("command");
        boolean hasArgv = params.has("argv") && !params.isNull("argv");
        if (hasCommand == hasArgv) throw new IllegalArgumentException("Provide exactly one of command or argv.");
        String body = hasCommand ? params.getString("command") : argvCommand(params.getJSONArray("argv"));
        JSONObject env = params.optJSONObject("env");
        String command = "cd " + ShellEscaper.quote(cwd) + " && " + environmentPrefix(env) + "exec " + body;
        String handle = params.optString("processHandle", "").trim();
        if (handle.isEmpty()) handle = "android_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        if (handle.length() > 128) throw new IllegalArgumentException("processHandle is too long.");
        Record existing = records.get(handle);
        if (existing != null && existing.running()) throw new IllegalArgumentException("Process handle is already running: " + handle);

        Process process = shell.startProcess(command);
        Record record = new Record(handle, params.optString("workspaceId", ""), root, cwd, process);
        records.put(handle, record);
        record.startReaders();
        int yield = Math.max(0, Math.min(30_000, params.optInt("yieldTimeMs", 10_000)));
        waitYield(record, yield);
        return record.snapshot(Math.max(4096, Math.min(MAX_OUTPUT_BYTES, params.optInt("maxOutputTokens", 10_000) * 4)), true);
    }

    JSONObject write(JSONObject params) throws Exception {
        Record record = find(params);
        String chars = params.has("chars") && !params.isNull("chars") ? params.optString("chars", "") : null;
        if (chars != null && !chars.isEmpty()) {
            if (!record.running()) throw new IllegalStateException("Remote process is not running: " + record.handle);
            OutputStream stdin = record.process.getOutputStream();
            stdin.write(chars.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        }
        int yield = Math.max(0, Math.min(30_000, params.optInt("yieldTimeMs", 10_000)));
        waitYield(record, yield);
        return record.snapshot(Math.max(4096, Math.min(MAX_OUTPUT_BYTES, params.optInt("maxOutputTokens", 10_000) * 4)), true);
    }

    JSONArray list(JSONObject params) throws Exception {
        String workspaceId = params.optString("workspaceId", "");
        boolean includeCompleted = params.optBoolean("includeCompleted", false);
        int limit = Math.max(1, Math.min(1000, params.optInt("limit", 100)));
        List<Record> selected = new ArrayList<>();
        for (Record record : records.values()) {
            if (!workspaceId.isEmpty() && !workspaceId.equals(record.workspaceId)) continue;
            if (!includeCompleted && !record.running()) continue;
            selected.add(record);
        }
        selected.sort(Comparator.comparingLong(record -> record.startedEpoch));
        JSONArray result = new JSONArray();
        for (int i = 0; i < Math.min(limit, selected.size()); i++) result.put(selected.get(i).snapshot(4096, false));
        return result;
    }

    JSONObject attach(JSONObject params) throws Exception {
        return find(params).snapshot(Math.max(4096, Math.min(MAX_OUTPUT_BYTES, params.optInt("maxOutputTokens", 10_000) * 4)), true);
    }

    JSONObject kill(JSONObject params) throws Exception {
        Record record = find(params);
        if (record.running()) {
            record.process.destroy();
            try { record.process.waitFor(500, TimeUnit.MILLISECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            if (record.process.isAlive()) record.process.destroyForcibly();
            record.signal = params.optString("signal", "SIGTERM");
        }
        return record.snapshot(Math.max(4096, Math.min(MAX_OUTPUT_BYTES, params.optInt("maxOutputTokens", 10_000) * 4)), true);
    }

    void close() {
        for (Record record : records.values()) {
            if (record.running()) record.process.destroy();
        }
    }

    private Record find(JSONObject params) {
        String handle = params.optString("processHandle", "");
        if (!handle.isEmpty()) {
            Record record = records.get(handle);
            if (record != null) return record;
        }
        if (params.has("sessionId")) {
            long sessionId = params.optLong("sessionId", -1);
            Record found = null;
            for (Record record : records.values()) {
                if (record.sessionId != sessionId) continue;
                if (found != null) throw new IllegalArgumentException("Remote process sessionId is ambiguous: " + sessionId);
                found = record;
            }
            if (found != null) return found;
        }
        throw new IllegalArgumentException("Unknown remote process handle/session: " + (handle.isEmpty() ? params.opt("sessionId") : handle));
    }

    private void pruneCompleted() {
        records.entrySet().removeIf(entry -> !entry.getValue().running());
    }

    private static String argvCommand(JSONArray argv) throws Exception {
        if (argv == null || argv.length() == 0) throw new IllegalArgumentException("argv must not be empty.");
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < argv.length(); i++) {
            if (i > 0) result.append(' ');
            result.append(ShellEscaper.quote(argv.getString(i)));
        }
        return result.toString();
    }

    private static String environmentPrefix(JSONObject env) throws Exception {
        if (env == null || env.length() == 0) return "";
        StringBuilder result = new StringBuilder("env ");
        java.util.Iterator<String> keys = env.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) throw new IllegalArgumentException("Invalid environment variable name: " + key);
            if (env.isNull(key)) result.append("-u ").append(ShellEscaper.quote(key)).append(' ');
            else result.append(ShellEscaper.quote(key + "=" + env.getString(key))).append(' ');
        }
        return result.toString();
    }

    private static void waitYield(Record record, int yieldMs) {
        long deadline = System.nanoTime() + yieldMs * 1_000_000L;
        while (System.nanoTime() < deadline && record.running()) {
            try { Thread.sleep(30); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
        }
    }

    private static final class Record {
        final String handle;
        final long sessionId = Math.abs(System.nanoTime() % 2_000_000_000L);
        final String workspaceId;
        final String root;
        final String cwd;
        final Process process;
        final long startedEpoch = System.currentTimeMillis();
        final BoundedLog log = new BoundedLog(MAX_OUTPUT_BYTES);
        volatile String signal;
        volatile int cursor;

        Record(String handle, String workspaceId, String root, String cwd, Process process) {
            this.handle = handle;
            this.workspaceId = workspaceId;
            this.root = root;
            this.cwd = cwd;
            this.process = process;
        }

        void startReaders() {
            new Thread(() -> copy(process.getInputStream(), log), "devspace-proc-out").start();
            new Thread(() -> copy(process.getErrorStream(), log), "devspace-proc-err").start();
        }

        boolean running() { return process.isAlive(); }

        JSONObject snapshot(int budget, boolean consume) throws Exception {
            String output = consume ? log.readFrom(cursor, budget) : "";
            if (consume) cursor = log.length();
            JSONObject value = new JSONObject()
                    .put("processHandle", handle)
                    .put("sessionId", sessionId)
                    .put("running", running())
                    .put("status", running() ? "running" : "exited")
                    .put("wallTimeMs", Math.max(0, System.currentTimeMillis() - startedEpoch))
                    .put("reattachable", true)
                    .put("output", output)
                    .put("outputTruncated", false);
            if (!running()) {
                try { value.put("exitCode", process.exitValue()); } catch (IllegalThreadStateException ignored) {}
            }
            if (signal != null) value.put("signal", signal);
            return value;
        }

        private static void copy(InputStream input, BoundedLog log) {
            byte[] buffer = new byte[8192];
            try {
                int count;
                while ((count = input.read(buffer)) >= 0) if (count > 0) log.append(buffer, count);
            } catch (IOException ignored) {
            } finally {
                try { input.close(); } catch (IOException ignored) {}
            }
        }
    }

    private static final class BoundedLog {
        private final int limit;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();

        BoundedLog(int limit) { this.limit = limit; }

        synchronized void append(byte[] source, int count) {
            int room = limit - bytes.size();
            if (room > 0) bytes.write(source, 0, Math.min(room, count));
        }

        synchronized int length() { return bytes.size(); }

        synchronized String readFrom(int offset, int budget) {
            byte[] all = bytes.toByteArray();
            int start = Math.max(0, Math.min(offset, all.length));
            int end = Math.min(all.length, start + Math.max(0, budget));
            return new String(all, start, end - start, StandardCharsets.UTF_8);
        }
    }
}
