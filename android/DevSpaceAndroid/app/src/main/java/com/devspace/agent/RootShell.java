package com.devspace.agent;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

final class RootShell {
    static final int DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

    static final class Result {
        final int exitCode;
        final byte[] stdout;
        final byte[] stderr;
        final boolean timedOut;

        Result(int exitCode, byte[] stdout, byte[] stderr, boolean timedOut) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.stderr = stderr;
            this.timedOut = timedOut;
        }

        String outputText() {
            String out = new String(stdout, StandardCharsets.UTF_8);
            String err = new String(stderr, StandardCharsets.UTF_8);
            if (err.isEmpty()) return out;
            return out + (out.endsWith("\n") || out.isEmpty() ? "" : "\n") + err;
        }
    }

    boolean isRootAvailable() {
        try {
            Result result = exec("id -u", null, 15, 64 * 1024);
            return result.exitCode == 0 && "0".equals(new String(result.stdout, StandardCharsets.UTF_8).trim());
        } catch (Exception error) {
            return false;
        }
    }

    Result exec(String command, int timeoutSeconds) throws IOException {
        return exec(command, null, timeoutSeconds, DEFAULT_MAX_OUTPUT);
    }

    Result exec(String command, byte[] stdin, int timeoutSeconds, int maxOutputBytes) throws IOException {
        Process process = new ProcessBuilder("su", "-c", command).start();
        if (stdin != null) {
            try (OutputStream stream = process.getOutputStream()) {
                stream.write(stdin);
                stream.flush();
            }
        } else {
            try { process.getOutputStream().close(); } catch (IOException ignored) {}
        }

        BoundedCollector out = new BoundedCollector(process.getInputStream(), maxOutputBytes);
        BoundedCollector err = new BoundedCollector(process.getErrorStream(), Math.min(maxOutputBytes, 1024 * 1024));
        Thread outThread = new Thread(out, "devspace-root-out");
        Thread errThread = new Thread(err, "devspace-root-err");
        outThread.start();
        errThread.start();

        boolean finished;
        try {
            finished = process.waitFor(Math.max(1, timeoutSeconds), TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            finished = false;
        }
        if (!finished) {
            process.destroy();
            try { process.waitFor(300, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
            if (process.isAlive()) process.destroyForcibly();
        }
        try {
            out.await(2, TimeUnit.SECONDS);
            err.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        return new Result(finished ? process.exitValue() : 124, out.bytes(), err.bytes(), !finished);
    }

    Process startProcess(String command) throws IOException {
        return new ProcessBuilder("su", "-c", command).start();
    }

    private static final class BoundedCollector implements Runnable {
        private final InputStream input;
        private final int limit;
        private final ByteArrayOutputStream output = new ByteArrayOutputStream();
        private final CountDownLatch done = new CountDownLatch(1);

        BoundedCollector(InputStream input, int limit) {
            this.input = input;
            this.limit = Math.max(1024, limit);
        }

        @Override public void run() {
            byte[] buffer = new byte[16 * 1024];
            try {
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count <= 0) continue;
                    int room = limit - output.size();
                    if (room > 0) output.write(buffer, 0, Math.min(room, count));
                }
            } catch (IOException ignored) {
            } finally {
                done.countDown();
                try { input.close(); } catch (IOException ignored) {}
            }
        }

        void await(long timeout, TimeUnit unit) throws InterruptedException { done.await(timeout, unit); }
        byte[] bytes() { return output.toByteArray(); }
    }
}
