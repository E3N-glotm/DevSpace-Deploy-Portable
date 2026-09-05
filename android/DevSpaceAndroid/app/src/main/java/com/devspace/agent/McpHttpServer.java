package com.devspace.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class McpHttpServer implements AutoCloseable {
    interface Listener { void onState(String state, String detail); }

    private static final int MAX_BODY = 10 * 1024 * 1024;
    private static final String MODERN_PROTOCOL = "2026-07-28";
    private static final String LEGACY_PROTOCOL = "2025-11-25";
    private final AgentConfig config;
    private final OAuthManager oauth;
    private final StandaloneMcpDispatcher dispatcher;
    private final Listener listener;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ExecutorService clients = Executors.newCachedThreadPool();
    private volatile ServerSocket server;
    private volatile Thread acceptThread;

    McpHttpServer(Context context, AgentConfig config, RootShell rootShell, Listener listener) {
        this.config = config;
        this.oauth = new OAuthManager(config);
        this.dispatcher = new StandaloneMcpDispatcher(context, config, rootShell);
        this.listener = listener;
    }

    synchronized void start() throws Exception {
        if (running.get()) return;
        ServerSocket socket = new ServerSocket(config.localPort(), 32, InetAddress.getByName("127.0.0.1"));
        server = socket;
        running.set(true);
        acceptThread = new Thread(this::acceptLoop, "devspace-mobile-http");
        acceptThread.start();
        listener.onState("MCP 已监听", "http://127.0.0.1:" + config.localPort() + "/mcp");
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket socket = server.accept();
                socket.setSoTimeout(45_000);
                clients.execute(() -> handleSocket(socket));
            } catch (IOException error) {
                if (running.get()) listener.onState("MCP 监听异常", String.valueOf(error.getMessage()));
            }
        }
    }

    private void handleSocket(Socket socket) {
        try (Socket current = socket) {
            Request request = readRequest(current);
            if (request == null) return;
            Response response = route(request);
            writeResponse(current.getOutputStream(), response);
        } catch (Throwable ignored) {}
    }

    private Response route(Request request) {
        try {
            String path = request.path;
            if ("GET".equals(request.method) && "/health".equals(path)) {
                return json(200, new JSONObject().put("ok", true).put("service", "DevSpace Mobile").put("root", "127.0.0.1").put("port", config.localPort()));
            }
            if ("GET".equals(request.method) && ("/.well-known/oauth-protected-resource/mcp".equals(path) || "/.well-known/oauth-protected-resource".equals(path))) {
                return json(200, protectedResourceMetadata());
            }
            if ("GET".equals(request.method) && path.startsWith("/.well-known/oauth-authorization-server")) {
                return json(200, authorizationServerMetadata());
            }
            if ("POST".equals(request.method) && "/register".equals(path)) {
                return json(201, oauth.registerClient(new JSONObject(request.bodyText())));
            }
            if ("GET".equals(request.method) && "/authorize".equals(path)) return authorizePage(request.query);
            if ("POST".equals(request.method) && "/authorize".equals(path)) return authorizeSubmit(parseForm(request.bodyText()));
            if ("POST".equals(request.method) && "/token".equals(path)) return token(parseForm(request.bodyText()));
            if ("POST".equals(request.method) && "/mcp".equals(path)) return mcp(request);
            if (("GET".equals(request.method) || "DELETE".equals(request.method)) && "/mcp".equals(path)) {
                return text(405, "Method not allowed", "text/plain; charset=utf-8");
            }
            return text(404, "Not found", "text/plain; charset=utf-8");
        } catch (SecurityException error) {
            return jsonError(403, "access_denied", error.getMessage());
        } catch (IllegalArgumentException error) {
            return jsonError(400, "invalid_request", error.getMessage());
        } catch (Throwable error) {
            return jsonError(500, "server_error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
        }
    }

    private Response mcp(Request request) throws Exception {
        if (!originAllowed(request.headers.get("origin"))) {
            return rpcError(403, JSONObject.NULL, -32600, "Invalid Origin header");
        }
        String auth = request.headers.getOrDefault("authorization", "");
        String token = auth.toLowerCase(Locale.ROOT).startsWith("bearer ") ? auth.substring(7).trim() : "";
        if (!oauth.verifyAccessToken(token, baseUrl() + "/mcp")) {
            Response unauthorized = jsonError(401, "invalid_token", "OAuth Bearer token required");
            unauthorized.headers.put("WWW-Authenticate", "Bearer resource_metadata=\"" + baseUrl() + "/.well-known/oauth-protected-resource/mcp\", scope=\"" + OAuthManager.DEFAULT_SCOPE + "\"");
            return unauthorized;
        }
        JSONObject rpc = new JSONObject(request.bodyText());
        boolean notification = !rpc.has("id");
        String envelopeVersion = envelopeProtocolVersion(rpc);
        boolean modern = MODERN_PROTOCOL.equals(envelopeVersion)
                || MODERN_PROTOCOL.equals(request.headers.getOrDefault("mcp-protocol-version", ""));
        Response headerError = validateMcpHeaders(request, rpc, modern, notification);
        if (headerError != null) return headerError;

        Object id = notification ? JSONObject.NULL : rpc.get("id");
        String method = rpc.optString("method", "");
        JSONObject params = rpc.optJSONObject("params");
        if (params == null) params = new JSONObject();
        if (notification) return new Response(202, "application/json", new byte[0]);
        JSONObject result;
        switch (method) {
            case "initialize":
                if (modern) return rpcError(200, id, -32601, "Method not available in MCP 2026-07-28: initialize");
                result = new JSONObject()
                        .put("protocolVersion", negotiatedLegacyProtocol(rpc.optJSONObject("params")))
                        .put("capabilities", new JSONObject().put("tools", new JSONObject()))
                        .put("serverInfo", serverInfo());
                break;
            case "server/discover":
                if (!modern) return rpcError(200, id, -32601, "Method not found: server/discover");
                result = new JSONObject()
                        .put("supportedVersions", new JSONArray().put(MODERN_PROTOCOL))
                        .put("capabilities", new JSONObject().put("tools", new JSONObject().put("listChanged", false)))
                        .put("instructions", "DevSpace Mobile runs directly on the owner's Root Android device. Use structured file/process tools where possible; use unrestricted Root shell only when Full Root Access is enabled.")
                        .put("ttlMs", 60_000)
                        .put("cacheScope", "private");
                break;
            case "tools/list":
                result = new JSONObject().put("tools", dispatcher.tools());
                if (modern) result.put("ttlMs", 60_000).put("cacheScope", "private");
                break;
            case "tools/call": {
                String name = params.getString("name");
                JSONObject args = params.optJSONObject("arguments");
                if (args == null) args = new JSONObject();
                result = dispatcher.call(name, args);
                break;
            }
            default: return rpcError(modern ? 404 : 200, id, -32601, "Method not found: " + method);
        }
        if (modern) stampModernResult(result);
        return rpcResult(id, result);
    }

    private Response authorizePage(Map<String, String> query) throws Exception {
        String clientId = query.getOrDefault("client_id", "");
        String redirect = query.getOrDefault("redirect_uri", "");
        String responseType = query.getOrDefault("response_type", "");
        String challenge = query.getOrDefault("code_challenge", "");
        String challengeMethod = query.getOrDefault("code_challenge_method", "");
        String resource = query.getOrDefault("resource", "");
        if (!"code".equals(responseType)) throw new IllegalArgumentException("response_type=code is required");
        if (!oauth.clientRedirectAllowed(clientId, redirect)) throw new SecurityException("Unknown OAuth client or redirect URI");
        if (challenge.isEmpty() || !"S256".equalsIgnoreCase(challengeMethod)) throw new SecurityException("PKCE S256 is required");
        if (!oauth.resourceAllowed(resource)) throw new SecurityException("Invalid or missing OAuth resource");
        if (!config.ownerPasswordConfigured()) return text(503, "Owner Password is not configured in the APK.", "text/plain; charset=utf-8");
        String html = "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>DevSpace Mobile OAuth</title>"
                + "<style>body{font-family:sans-serif;max-width:520px;margin:48px auto;padding:20px;background:#111;color:#eee}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border-radius:8px}button{font-weight:700}</style></head><body>"
                + "<h2>授权 DevSpace Mobile</h2><p>此授权将允许 MCP 客户端调用你这台 Root Android 设备上的 DevSpace 工具。</p><form method='post' action='/authorize'>"
                + hidden("client_id", clientId) + hidden("redirect_uri", redirect) + hidden("state", query.getOrDefault("state", ""))
                + hidden("scope", query.getOrDefault("scope", OAuthManager.DEFAULT_SCOPE)) + hidden("code_challenge", challenge)
                + hidden("code_challenge_method", challengeMethod) + hidden("resource", resource)
                + "<label>Owner Password</label><input type=password name=owner_password autocomplete=current-password required><button type=submit>授权</button></form></body></html>";
        return text(200, html, "text/html; charset=utf-8");
    }

    private Response authorizeSubmit(Map<String, String> form) throws Exception {
        String code = oauth.createAuthorizationCode(form.getOrDefault("owner_password", ""), form.getOrDefault("client_id", ""),
                form.getOrDefault("redirect_uri", ""), form.getOrDefault("scope", OAuthManager.DEFAULT_SCOPE),
                form.getOrDefault("code_challenge", ""), form.getOrDefault("code_challenge_method", ""),
                form.getOrDefault("resource", ""));
        String location = appendQuery(form.getOrDefault("redirect_uri", ""), "code", code);
        String state = form.getOrDefault("state", "");
        if (!state.isEmpty()) location = appendQuery(location, "state", state);
        location = appendQuery(location, "iss", baseUrl());
        Response response = new Response(302, "text/plain; charset=utf-8", "Redirecting".getBytes(StandardCharsets.UTF_8));
        response.headers.put("Location", location);
        response.headers.put("Cache-Control", "no-store");
        return response;
    }

    private Response token(Map<String, String> form) throws Exception {
        try {
            String grant = form.getOrDefault("grant_type", "");
            JSONObject result;
            if ("authorization_code".equals(grant)) {
                result = oauth.exchangeAuthorizationCode(form.getOrDefault("code", ""), form.getOrDefault("client_id", ""),
                        form.getOrDefault("client_secret", ""), form.getOrDefault("redirect_uri", ""),
                        form.getOrDefault("code_verifier", ""), form.getOrDefault("resource", ""));
            } else if ("refresh_token".equals(grant)) {
                result = oauth.exchangeRefreshToken(form.getOrDefault("refresh_token", ""), form.getOrDefault("client_id", ""),
                        form.getOrDefault("client_secret", ""), form.getOrDefault("resource", ""), form.getOrDefault("scope", ""));
            } else throw new IllegalArgumentException("Unsupported grant_type");
            Response response = json(200, result);
            response.headers.put("Cache-Control", "no-store");
            return response;
        } catch (SecurityException error) {
            Response response = jsonError(400, "invalid_grant", error.getMessage());
            response.headers.put("Cache-Control", "no-store");
            return response;
        }
    }

    private JSONObject protectedResourceMetadata() throws Exception {
        return new JSONObject().put("resource", baseUrl() + "/mcp")
                .put("authorization_servers", new JSONArray().put(baseUrl()))
                .put("scopes_supported", new JSONArray().put(OAuthManager.DEFAULT_SCOPE))
                .put("bearer_methods_supported", new JSONArray().put("header"));
    }

    private JSONObject authorizationServerMetadata() throws Exception {
        String base = baseUrl();
        return new JSONObject().put("issuer", base)
                .put("authorization_endpoint", base + "/authorize")
                .put("token_endpoint", base + "/token")
                .put("registration_endpoint", base + "/register")
                .put("response_types_supported", new JSONArray().put("code"))
                .put("grant_types_supported", new JSONArray().put("authorization_code").put("refresh_token"))
                .put("token_endpoint_auth_methods_supported", new JSONArray().put("none").put("client_secret_post"))
                .put("code_challenge_methods_supported", new JSONArray().put("S256"))
                .put("scopes_supported", new JSONArray().put(OAuthManager.DEFAULT_SCOPE))
                .put("client_id_metadata_document_supported", false);
    }

    private JSONObject serverInfo() throws Exception {
        return new JSONObject().put("name", "DevSpace Mobile").put("version", BuildConfig.VERSION_NAME);
    }

    private String negotiatedLegacyProtocol(JSONObject params) {
        String requested = params == null ? "" : params.optString("protocolVersion", "");
        if (LEGACY_PROTOCOL.equals(requested) || "2025-06-18".equals(requested) || "2025-03-26".equals(requested)) {
            return requested;
        }
        return LEGACY_PROTOCOL;
    }

    private Response validateMcpHeaders(Request request, JSONObject rpc, boolean modern, boolean notification) throws Exception {
        String version = request.headers.getOrDefault("mcp-protocol-version", "");
        String envelopeVersion = envelopeProtocolVersion(rpc);
        if (!envelopeVersion.isEmpty() && !MODERN_PROTOCOL.equals(envelopeVersion)) {
            return rpcError(400, rpc.has("id") ? rpc.get("id") : JSONObject.NULL, -32022,
                    "Unsupported request envelope protocol version. Supported modern version: " + MODERN_PROTOCOL);
        }
        if (!version.isEmpty() && !(MODERN_PROTOCOL.equals(version) || LEGACY_PROTOCOL.equals(version)
                || "2025-06-18".equals(version) || "2025-03-26".equals(version))) {
            return rpcError(400, rpc.has("id") ? rpc.get("id") : JSONObject.NULL, -32022,
                    "Unsupported protocol version. Supported: " + MODERN_PROTOCOL + ", " + LEGACY_PROTOCOL + ", 2025-06-18, 2025-03-26");
        }
        if (!modern) return null;
        if (notification) return null;

        Object id = rpc.has("id") ? rpc.get("id") : JSONObject.NULL;
        String method = rpc.optString("method", "");
        if (!MODERN_PROTOCOL.equals(version)) {
            return rpcError(400, id, -32020, "Header mismatch: MCP-Protocol-Version is required and must match the modern request envelope");
        }
        String headerMethod = request.headers.getOrDefault("mcp-method", "");
        if (headerMethod.isEmpty() || !headerMethod.equals(method)) {
            return rpcError(400, id, -32020, "Header mismatch: Mcp-Method does not match JSON-RPC method");
        }
        if (!MODERN_PROTOCOL.equals(envelopeVersion)) {
            return rpcError(400, id, -32020, "Header mismatch: MCP-Protocol-Version does not match request _meta");
        }
        JSONObject params = rpc.optJSONObject("params");
        if ("tools/call".equals(method)) {
            String name = params == null ? "" : params.optString("name", "");
            String headerName = decodeMcpHeader(request.headers.getOrDefault("mcp-name", ""));
            if (headerName.isEmpty() || !headerName.equals(name)) {
                return rpcError(400, id, -32020, "Header mismatch: Mcp-Name does not match tools/call params.name");
            }
        }
        return null;
    }

    private static String envelopeProtocolVersion(JSONObject rpc) {
        JSONObject params = rpc.optJSONObject("params");
        JSONObject meta = params == null ? null : params.optJSONObject("_meta");
        return meta == null ? "" : meta.optString("io.modelcontextprotocol/protocolVersion", "");
    }

    private void stampModernResult(JSONObject result) throws Exception {
        if (!result.has("resultType")) result.put("resultType", "complete");
        JSONObject meta = result.optJSONObject("_meta");
        if (meta == null) meta = new JSONObject();
        if (!meta.has("io.modelcontextprotocol/serverInfo")) {
            meta.put("io.modelcontextprotocol/serverInfo", serverInfo());
        }
        result.put("_meta", meta);
    }

    private boolean originAllowed(String origin) {
        if (origin == null || origin.trim().isEmpty()) return true;
        try {
            URI expected = URI.create(baseUrl());
            URI actual = URI.create(origin.trim());
            int expectedPort = expected.getPort() >= 0 ? expected.getPort() : ("https".equalsIgnoreCase(expected.getScheme()) ? 443 : 80);
            int actualPort = actual.getPort() >= 0 ? actual.getPort() : ("https".equalsIgnoreCase(actual.getScheme()) ? 443 : 80);
            return expected.getScheme().equalsIgnoreCase(actual.getScheme())
                    && expected.getHost() != null && expected.getHost().equalsIgnoreCase(actual.getHost())
                    && expectedPort == actualPort;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String decodeMcpHeader(String value) {
        if (value == null) return "";
        String text = value.trim();
        if (text.startsWith("=?base64?") && text.endsWith("?=")) {
            String encoded = text.substring(9, text.length() - 2);
            try {
                return new String(android.util.Base64.decode(encoded, android.util.Base64.DEFAULT), StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                return "";
            }
        }
        return text;
    }

    private String baseUrl() {
        String base = AgentConfig.normalizeServer(config.publicBaseUrl());
        if (base.isEmpty()) throw new IllegalStateException("Public Base URL is not configured");
        return base;
    }

    private static Request readRequest(Socket socket) throws Exception {
        BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
        String first = readLine(input);
        if (first == null || first.isEmpty()) return null;
        String[] parts = first.split(" ", 3);
        if (parts.length < 2) throw new IOException("Invalid HTTP request line");
        String target = parts[1];
        String path = target;
        String queryText = "";
        int question = target.indexOf('?');
        if (question >= 0) { path = target.substring(0, question); queryText = target.substring(question + 1); }
        Map<String, String> headers = new LinkedHashMap<>();
        while (true) {
            String line = readLine(input);
            if (line == null || line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
        int length = 0;
        String rawLength = headers.get("content-length");
        if (rawLength != null && !rawLength.isEmpty()) length = Integer.parseInt(rawLength);
        if (length < 0 || length > MAX_BODY) throw new IOException("HTTP body exceeds bounded limit");
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < body.length) {
            int count = input.read(body, offset, body.length - offset);
            if (count < 0) throw new IOException("Unexpected EOF");
            offset += count;
        }
        return new Request(parts[0].toUpperCase(Locale.ROOT), path, parseForm(queryText), headers, body);
    }

    private static String readLine(BufferedInputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        int previous = -1;
        while (output.size() < 16 * 1024) {
            int value = input.read();
            if (value < 0) break;
            if (previous == '\r' && value == '\n') {
                byte[] bytes = output.toByteArray();
                int length = Math.max(0, bytes.length - 1);
                return new String(bytes, 0, length, StandardCharsets.ISO_8859_1);
            }
            output.write(value);
            previous = value;
        }
        if (output.size() == 0) return null;
        return output.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static void writeResponse(OutputStream output, Response response) throws IOException {
        byte[] body = response.body == null ? new byte[0] : response.body;
        StringBuilder head = new StringBuilder("HTTP/1.1 ").append(response.status).append(' ').append(reason(response.status)).append("\r\n")
                .append("Content-Type: ").append(response.contentType).append("\r\n")
                .append("Content-Length: ").append(body.length).append("\r\n")
                .append("Connection: close\r\n")
                .append("X-Content-Type-Options: nosniff\r\n");
        for (Map.Entry<String, String> header : response.headers.entrySet()) head.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
        head.append("\r\n");
        output.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        output.write(body);
        output.flush();
    }

    private static Response rpcResult(Object id, JSONObject result) throws Exception {
        return json(200, new JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result));
    }
    private static Response rpcError(int status, Object id, int code, String message) {
        try { return json(status, new JSONObject().put("jsonrpc", "2.0").put("id", id).put("error", new JSONObject().put("code", code).put("message", message))); }
        catch (Exception error) { return text(status, message, "text/plain; charset=utf-8"); }
    }
    private static Response jsonError(int status, String error, String description) {
        try { return json(status, new JSONObject().put("error", error).put("error_description", description == null ? "" : description)); }
        catch (Exception ignored) { return text(status, error, "text/plain; charset=utf-8"); }
    }
    private static Response json(int status, JSONObject object) { return text(status, object.toString(), "application/json; charset=utf-8"); }
    private static Response text(int status, String text, String contentType) { return new Response(status, contentType, (text == null ? "" : text).getBytes(StandardCharsets.UTF_8)); }

    private static Map<String, String> parseForm(String encoded) {
        Map<String, String> result = new LinkedHashMap<>();
        if (encoded == null || encoded.isEmpty()) return result;
        for (String pair : encoded.split("&")) {
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            String value = eq < 0 ? "" : pair.substring(eq + 1);
            result.put(urlDecode(key), urlDecode(value));
        }
        return result;
    }
    private static String urlDecode(String value) { try { return URLDecoder.decode(value, "UTF-8"); } catch (Exception error) { return value; } }
    private static String urlEncode(String value) { try { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); } catch (Exception error) { return ""; } }
    private static String appendQuery(String uri, String key, String value) { return uri + (uri.contains("?") ? "&" : "?") + urlEncode(key) + "=" + urlEncode(value); }
    private static String hidden(String name, String value) { return "<input type=hidden name='" + html(name) + "' value='" + html(value) + "'>"; }
    private static String html(String value) { return (value == null ? "" : value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;"); }
    private static String reason(int status) { switch (status) { case 200:return "OK"; case 201:return "Created"; case 202:return "Accepted"; case 302:return "Found"; case 400:return "Bad Request"; case 401:return "Unauthorized"; case 403:return "Forbidden"; case 404:return "Not Found"; case 405:return "Method Not Allowed"; case 500:return "Internal Server Error"; case 503:return "Service Unavailable"; default:return "Status"; } }

    @Override public synchronized void close() {
        if (!running.getAndSet(false)) return;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        server = null;
        if (acceptThread != null) acceptThread.interrupt();
        acceptThread = null;
        clients.shutdownNow();
        dispatcher.close();
    }

    private static final class Request {
        final String method;
        final String path;
        final Map<String, String> query;
        final Map<String, String> headers;
        final byte[] body;
        Request(String method, String path, Map<String, String> query, Map<String, String> headers, byte[] body) {
            this.method = method; this.path = path; this.query = query; this.headers = headers; this.body = body;
        }
        String bodyText() { return new String(body, StandardCharsets.UTF_8); }
    }
    private static final class Response {
        final int status;
        final String contentType;
        final byte[] body;
        final Map<String, String> headers = new LinkedHashMap<>();
        Response(int status, String contentType, byte[] body) { this.status = status; this.contentType = contentType; this.body = body; }
    }
}
