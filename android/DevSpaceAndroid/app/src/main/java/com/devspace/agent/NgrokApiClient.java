package com.devspace.agent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

/** Minimal ngrok REST client used only for first-run provisioning. */
final class NgrokApiClient {
    private static final String API = "https://api.ngrok.com";
    private static final int MAX_RESPONSE = 1024 * 1024;

    private NgrokApiClient() {}

    static JSONObject createTunnelCredential(String apiKey, String publicBaseUrl) throws Exception {
        String key = requireApiKey(apiKey);
        JSONObject body = new JSONObject()
                .put("description", "DevSpace Mobile Android")
                .put("metadata", "{\"client\":\"devspace-mobile\"}");
        String host = publicHost(publicBaseUrl);
        if (!host.isEmpty()) body.put("acl", new JSONArray().put("bind:" + host));
        JSONObject response = request("POST", "/credentials", key, body);
        String token = response.optString("token", "").trim();
        if (token.isEmpty()) {
            throw new IllegalStateException("ngrok API created a credential but did not return the one-time token");
        }
        return response;
    }

    static JSONArray listReservedDomains(String apiKey) throws Exception {
        JSONObject response = request("GET", "/reserved_domains?limit=100", requireApiKey(apiKey), null);
        JSONArray source = response.optJSONArray("reserved_domains");
        JSONArray result = new JSONArray();
        if (source == null) return result;
        for (int i = 0; i < source.length(); i++) {
            JSONObject item = source.optJSONObject(i);
            if (item == null) continue;
            String domain = item.optString("domain", "").trim();
            if (!domain.isEmpty()) result.put(domain);
        }
        return result;
    }

    private static JSONObject request(String method, String path, String apiKey, JSONObject body) throws Exception {
        URL url = new URL(API + path);
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setRequestProperty("ngrok-version", "2");
        connection.setRequestProperty("Accept", "application/json");
        if (body != null) {
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            } finally {
                java.util.Arrays.fill(payload, (byte) 0);
            }
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
                ? connection.getInputStream() : connection.getErrorStream();
        String text = readBounded(stream);
        JSONObject json;
        try {
            json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (Exception parse) {
            throw new IllegalStateException("ngrok API HTTP " + status + ": " + bound(text));
        } finally {
            connection.disconnect();
        }
        if (status < 200 || status >= 300) {
            String message = json.optString("msg", json.optString("message", json.optString("error", text)));
            String code = json.optString("error_code", json.optString("code", ""));
            throw new IllegalStateException("ngrok API HTTP " + status
                    + (code.isEmpty() ? "" : " " + code) + ": " + bound(message));
        }
        return json;
    }

    private static String requireApiKey(String value) {
        String key = value == null ? "" : value.trim();
        if (key.length() < 16 || key.length() > 64 * 1024 || key.indexOf('\n') >= 0 || key.indexOf('\r') >= 0) {
            throw new IllegalArgumentException("ngrok API Key 格式异常");
        }
        return key;
    }

    private static String publicHost(String publicBaseUrl) {
        try {
            String value = publicBaseUrl == null ? "" : publicBaseUrl.trim();
            if (value.isEmpty()) return "";
            URI uri = URI.create(value);
            return uri.getHost() == null ? "" : uri.getHost().trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String readBounded(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = stream.read(buffer)) >= 0) {
                if (count <= 0) continue;
                if (output.size() + count > MAX_RESPONSE) {
                    int room = Math.max(0, MAX_RESPONSE - output.size());
                    if (room > 0) output.write(buffer, 0, room);
                    throw new IllegalStateException("ngrok API response exceeded 1 MiB");
                }
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String bound(String value) {
        String text = value == null ? "" : value.trim().replace('\n', ' ').replace('\r', ' ');
        return text.length() <= 700 ? text : text.substring(0, 700) + "…";
    }
}
