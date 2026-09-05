package com.devspace.agent;

import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

final class ContentCodec {
    private static final int DEFAULT_MAX_DECODED_BYTES = 8 * 1024 * 1024;

    private ContentCodec() {}

    static JSONObject encode(byte[] bytes) throws IOException, JSONException {
        if (bytes.length >= 4096) {
            ByteArrayOutputStream compressed = new ByteArrayOutputStream();
            try (GZIPOutputStream gzip = new GZIPOutputStream(compressed)) {
                gzip.write(bytes);
            }
            if (compressed.size() + 128 < bytes.length) {
                return new JSONObject()
                        .put("encoding", "gzip-base64")
                        .put("data", Base64.encodeToString(compressed.toByteArray(), Base64.NO_WRAP));
            }
        }
        return new JSONObject()
                .put("encoding", "base64")
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
    }

    static byte[] decode(JSONObject value) throws IOException {
        return decode(value, DEFAULT_MAX_DECODED_BYTES);
    }

    static byte[] decode(JSONObject value, int maxDecodedBytes) throws IOException {
        if (value == null) return new byte[0];
        int limit = Math.max(0, maxDecodedBytes);
        byte[] data = Base64.decode(value.optString("data", ""), Base64.DEFAULT);
        String encoding = value.optString("encoding", "base64");
        if ("base64".equals(encoding)) {
            if (data.length > limit) throw new IOException("Decoded content exceeds bounded limit: " + limit + " bytes");
            return data;
        }
        if (!"gzip-base64".equals(encoding)) {
            throw new IOException("Unsupported content encoding: " + encoding);
        }
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(data));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = gzip.read(buffer)) >= 0) {
                if (count <= 0) continue;
                if (output.size() > limit - count) {
                    throw new IOException("Decompressed content exceeds bounded limit: " + limit + " bytes");
                }
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
}
