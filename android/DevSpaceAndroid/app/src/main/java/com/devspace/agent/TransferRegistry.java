package com.devspace.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class TransferRegistry {
    private static final int MAX_TRANSFERS = 32;

    private final File root;
    private final RootFs fs;
    private final Map<String, Transfer> transfers = new ConcurrentHashMap<>();

    TransferRegistry(Context context, RootFs fs) {
        this.root = new File(context.getCacheDir(), "devspace-transfers");
        this.fs = fs;
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        File[] old = root.listFiles();
        if (old != null) for (File file : old) deleteTree(file);
    }

    JSONObject prepare(JSONObject params) throws Exception {
        if (transfers.size() >= MAX_TRANSFERS) throw new IllegalStateException("Android transfer limit reached.");
        String id = params.getString("transferId");
        String workspaceRoot = params.getString("root");
        String path = params.getString("path");
        String target = fs.writableTarget(workspaceRoot, path);
        File directory = new File(root, safeName(id));
        deleteTree(directory);
        if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("Unable to create transfer directory.");

        JSONArray chunks = params.optJSONArray("chunks");
        if (chunks == null) chunks = new JSONArray();
        long declaredTotal = 0;
        Set<Integer> indices = new HashSet<>();
        for (int i = 0; i < chunks.length(); i++) {
            JSONObject item = chunks.getJSONObject(i);
            int index = item.getInt("index");
            int size = item.getInt("size");
            if (index < 0 || !indices.add(index)) throw new IllegalArgumentException("Invalid or duplicate transfer chunk index: " + index);
            if (size < 0 || size > RootFs.TRANSFER_CHUNK_BYTES) throw new IllegalArgumentException("Transfer chunk size is out of range: " + size);
            declaredTotal += size;
        }
        long declaredSize = params.optLong("size", 0);
        if (declaredSize < 0 || declaredTotal != declaredSize) throw new IllegalArgumentException("Transfer metadata size mismatch.");
        Transfer transfer = new Transfer(id, workspaceRoot, path, target, params.optLong("size", 0),
                params.optString("sha256", ""), params.has("mode") ? params.optInt("mode") : null, chunks, directory);
        transfers.put(id, transfer);
        JSONArray missing = new JSONArray();
        for (int i = 0; i < chunks.length(); i++) missing.put(chunks.getJSONObject(i).getInt("index"));
        return new JSONObject().put("transferId", id).put("missingChunks", missing).put("reusedChunks", 0);
    }

    JSONObject writeChunk(JSONObject params) throws Exception {
        String id = params.getString("transferId");
        Transfer transfer = require(id);
        int index = params.getInt("index");
        JSONObject definition = transfer.chunk(index);
        if (definition == null) throw new IllegalArgumentException("Transfer chunk index was not declared: " + index);
        int declaredSize = definition.getInt("size");
        byte[] content = ContentCodec.decode(params.optJSONObject("content"), RootFs.TRANSFER_CHUNK_BYTES);
        if (content.length != declaredSize) throw new IOException("Transfer chunk size mismatch: " + index);
        String expected = params.optString("sha256", "");
        String metadataHash = definition.optString("sha256", "");
        String actualHash = Hashing.sha256(content);
        if ((!expected.isEmpty() && !expected.equals(actualHash)) || (!metadataHash.isEmpty() && !metadataHash.equals(actualHash))) {
            throw new IOException("Transfer chunk hash mismatch: " + index);
        }
        File target = new File(transfer.directory, String.format(Locale.ROOT, "chunk-%08d", index));
        try (FileOutputStream output = new FileOutputStream(target)) { output.write(content); }
        return new JSONObject().put("transferId", id).put("index", index).put("bytes", content.length);
    }

    JSONObject commit(JSONObject params) throws Exception {
        String id = params.getString("transferId");
        Transfer transfer = require(id);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long totalBytes = 0;
            File manifest = new File(transfer.directory, "order.txt");
            try (FileOutputStream order = new FileOutputStream(manifest)) {
                for (int i = 0; i < transfer.chunks.length(); i++) {
                    JSONObject item = transfer.chunks.getJSONObject(i);
                    int index = item.getInt("index");
                    File chunk = new File(transfer.directory, String.format(Locale.ROOT, "chunk-%08d", index));
                    if (!chunk.isFile()) throw new IOException("Transfer chunk missing: " + index);
                    byte[] bytes = readFile(chunk);
                    if (bytes.length != item.getInt("size")) throw new IOException("Transfer chunk size mismatch: " + index);
                    String expected = item.optString("sha256", "");
                    if (!expected.isEmpty() && !expected.equals(Hashing.sha256(bytes))) {
                        throw new IOException("Transfer chunk corrupt: " + index);
                    }
                    digest.update(bytes);
                    totalBytes += bytes.length;
                    order.write(chunk.getAbsolutePath().getBytes(StandardCharsets.UTF_8));
                    order.write('\n');
                }
            }
            if (totalBytes != transfer.size) throw new IOException("Transfer size mismatch.");
            String actualSha256 = hex(digest.digest());
            if (!transfer.sha256.isEmpty() && !transfer.sha256.equals(actualSha256)) {
                throw new IOException("Transfer SHA-256 mismatch.");
            }
            // Re-check canonical parents at commit time. A chunked transfer can
            // stay open long enough for a directory/symlink to change after
            // prepare(), so do not rely only on the initial scoped-path check.
            String validatedTarget = fs.writableTarget(transfer.root, transfer.path);
            if (!validatedTarget.equals(transfer.target)) {
                throw new SecurityException("Android transfer target changed during upload.");
            }
            fs.writeTransferManifest(validatedTarget, manifest.getAbsolutePath(), transfer.mode);
            return new JSONObject().put("path", transfer.path).put("bytes", totalBytes)
                    .put("sha256", actualSha256).put("deltaTransfer", false);
        } finally {
            transfers.remove(id);
            deleteTree(transfer.directory);
        }
    }

    private Transfer require(String id) {
        Transfer transfer = transfers.get(id);
        if (transfer == null) throw new IllegalArgumentException("Transfer not found: " + id);
        return transfer;
    }

    private static byte[] readFile(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) if (count > 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            result[i * 2] = digits[value >>> 4];
            result[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(result);
    }

    private static String safeName(String value) { return Hashing.sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32); }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static final class Transfer {
        final String id;
        final String root;
        final String path;
        final String target;
        final long size;
        final String sha256;
        final Integer mode;
        final JSONArray chunks;
        final File directory;

        Transfer(String id, String root, String path, String target, long size, String sha256, Integer mode, JSONArray chunks, File directory) {
            this.id = id;
            this.root = root;
            this.path = path;
            this.target = target;
            this.size = size;
            this.sha256 = sha256;
            this.mode = mode;
            this.chunks = chunks;
            this.directory = directory;
        }

        JSONObject chunk(int index) throws Exception {
            for (int i = 0; i < chunks.length(); i++) {
                JSONObject item = chunks.getJSONObject(i);
                if (item.getInt("index") == index) return item;
            }
            return null;
        }
    }
}
