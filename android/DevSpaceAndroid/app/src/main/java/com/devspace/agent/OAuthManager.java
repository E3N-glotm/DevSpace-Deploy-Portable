package com.devspace.agent;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class OAuthManager {
    static final String DEFAULT_SCOPE = "devspace";
    private static final long ACCESS_TTL_SECONDS = 60L * 60L;
    private static final long REFRESH_TTL_SECONDS = 30L * 24L * 60L * 60L;

    static final class AuthorizationCode {
        final String clientId;
        final String redirectUri;
        final String scope;
        final String challenge;
        final String resource;
        final long expiresAt;

        AuthorizationCode(String clientId, String redirectUri, String scope, String challenge,
                          String resource, long expiresAt) {
            this.clientId = clientId;
            this.redirectUri = redirectUri;
            this.scope = scope;
            this.challenge = challenge;
            this.resource = resource;
            this.expiresAt = expiresAt;
        }
    }

    static final class RefreshRecord {
        final String clientId;
        final String scope;
        final String resource;
        final long expiresAt;

        RefreshRecord(String clientId, String scope, String resource, long expiresAt) {
            this.clientId = clientId;
            this.scope = scope;
            this.resource = resource;
            this.expiresAt = expiresAt;
        }

        JSONObject json() throws Exception {
            return new JSONObject()
                    .put("client_id", clientId)
                    .put("scope", scope)
                    .put("resource", resource)
                    .put("expires_at", expiresAt);
        }
    }

    private final AgentConfig config;
    private final SecureRandom random = new SecureRandom();
    private final ConcurrentHashMap<String, JSONObject> clients = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AuthorizationCode> codes = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RefreshRecord> refreshTokens = new ConcurrentHashMap<>();
    private final byte[] signingKey;

    OAuthManager(AgentConfig config) {
        this.config = config;
        signingKey = Base64.decode(config.signingSecret(), Base64.DEFAULT);
        loadClients();
        loadRefreshTokens();
        pruneRefreshTokens();
    }

    synchronized JSONObject registerClient(JSONObject input) throws Exception {
        JSONArray redirects = input.optJSONArray("redirect_uris");
        if (redirects == null || redirects.length() < 1) {
            throw new IllegalArgumentException("redirect_uris is required");
        }
        JSONArray normalized = new JSONArray();
        for (int i = 0; i < redirects.length(); i++) {
            String uri = redirects.optString(i, "").trim();
            if (!redirectUriAllowed(uri)) {
                throw new IllegalArgumentException("Unsupported OAuth redirect URI: " + uri);
            }
            normalized.put(uri);
        }

        String authMethod = input.optString("token_endpoint_auth_method", "none").trim();
        if (authMethod.isEmpty()) authMethod = "none";
        if (!("none".equals(authMethod) || "client_secret_post".equals(authMethod))) {
            throw new IllegalArgumentException("Unsupported token_endpoint_auth_method: " + authMethod);
        }

        String clientId = "dsm_" + randomToken(18);
        JSONObject stored = new JSONObject()
                .put("client_id", clientId)
                .put("client_name", input.optString("client_name", "MCP Client"))
                .put("application_type", input.optString("application_type", "native"))
                .put("redirect_uris", normalized)
                .put("token_endpoint_auth_method", authMethod)
                .put("grant_types", new JSONArray().put("authorization_code").put("refresh_token"))
                .put("response_types", new JSONArray().put("code"))
                .put("created_at", System.currentTimeMillis());
        if ("client_secret_post".equals(authMethod)) {
            stored.put("client_secret", randomToken(32));
        }

        clients.put(clientId, stored);
        persistClients();

        JSONObject response = new JSONObject(stored.toString())
                .put("client_id_issued_at", System.currentTimeMillis() / 1000L);
        if ("client_secret_post".equals(authMethod)) response.put("client_secret_expires_at", 0);
        return response;
    }

    boolean clientRedirectAllowed(String clientId, String redirectUri) {
        JSONObject client = clients.get(clientId);
        if (client == null) return false;
        JSONArray redirects = client.optJSONArray("redirect_uris");
        if (redirects == null) return false;
        for (int i = 0; i < redirects.length(); i++) {
            if (redirectUri.equals(redirects.optString(i, ""))) return true;
        }
        return false;
    }

    boolean resourceAllowed(String resource) {
        String canonical = canonicalResource();
        return !canonical.isEmpty() && canonical.equals(normalizeResource(resource));
    }

    String createAuthorizationCode(String ownerPassword, String clientId, String redirectUri,
                                   String scope, String challenge, String challengeMethod,
                                   String resource) throws Exception {
        if (!passwordMatches(ownerPassword)) throw new SecurityException("Owner Password is incorrect");
        if (!clientRedirectAllowed(clientId, redirectUri)) {
            throw new SecurityException("OAuth client or redirect_uri is not registered");
        }
        if (challenge == null || challenge.isEmpty() || !"S256".equalsIgnoreCase(challengeMethod)) {
            throw new SecurityException("PKCE S256 is required");
        }
        if (!resourceAllowed(resource)) throw new SecurityException("Invalid or missing OAuth resource");

        pruneAuthorizationCodes();
        String code = "dsc_" + randomToken(24);
        codes.put(code, new AuthorizationCode(clientId, redirectUri,
                normalizeScope(scope), challenge, canonicalResource(), System.currentTimeMillis() + 5 * 60_000L));
        return code;
    }

    JSONObject exchangeAuthorizationCode(String code, String clientId, String clientSecret,
                                         String redirectUri, String verifier, String resource) throws Exception {
        validateClientAuthentication(clientId, clientSecret);
        if (!resourceAllowed(resource)) throw new SecurityException("Invalid or missing OAuth resource");
        pruneAuthorizationCodes();
        AuthorizationCode auth = codes.remove(code);
        if (auth == null || auth.expiresAt < System.currentTimeMillis()) {
            throw new SecurityException("authorization code is invalid or expired");
        }
        if (!auth.clientId.equals(clientId) || !auth.redirectUri.equals(redirectUri)) {
            throw new SecurityException("authorization code binding mismatch");
        }
        if (!auth.resource.equals(canonicalResource())) {
            throw new SecurityException("authorization code resource binding mismatch");
        }
        String actual = base64Url(MessageDigest.getInstance("SHA-256")
                .digest((verifier == null ? "" : verifier).getBytes(StandardCharsets.US_ASCII)));
        if (!constantEquals(auth.challenge, actual)) throw new SecurityException("PKCE verification failed");
        return issueTokens(clientId, auth.scope, auth.resource);
    }

    synchronized JSONObject exchangeRefreshToken(String refreshToken, String clientId, String clientSecret,
                                                  String resource, String requestedScope) throws Exception {
        validateClientAuthentication(clientId, clientSecret);
        TokenClaims claims = verifySignedToken(refreshToken, "r1");
        String hash = hashToken(refreshToken);
        RefreshRecord record = refreshTokens.remove(hash);
        if (record == null || record.expiresAt <= System.currentTimeMillis() / 1000L) {
            persistRefreshTokens();
            throw new SecurityException("invalid or already-consumed refresh token");
        }
        String canonical = canonicalResource();
        if (!record.clientId.equals(clientId) || !claims.clientId.equals(clientId)) {
            persistRefreshTokens();
            throw new SecurityException("refresh token client binding mismatch");
        }
        if (!canonical.equals(record.resource) || !canonical.equals(claims.resource)
                || !canonical.equals(normalizeResource(resource))) {
            persistRefreshTokens();
            throw new SecurityException("refresh token resource binding mismatch");
        }
        if (requestedScope != null && !requestedScope.trim().isEmpty()
                && !normalizeScope(requestedScope).equals(record.scope)) {
            persistRefreshTokens();
            throw new SecurityException("refresh token cannot expand scope");
        }

        // Consume first so public clients cannot replay a used refresh token.
        persistRefreshTokens();
        return issueTokens(clientId, record.scope, record.resource);
    }

    boolean verifyAccessToken(String token, String expectedResource) {
        try {
            TokenClaims claims = verifySignedToken(token, "a1");
            String canonical = normalizeResource(expectedResource);
            return !canonical.isEmpty() && canonical.equals(claims.resource) && canonical.equals(canonicalResource());
        } catch (Exception ignored) {
            return false;
        }
    }

    private synchronized JSONObject issueTokens(String clientId, String scope, String resource) throws Exception {
        long now = System.currentTimeMillis() / 1000L;
        String canonical = normalizeResource(resource);
        if (!canonicalResource().equals(canonical)) throw new SecurityException("Invalid token resource");

        String access = token("a1", now + ACCESS_TTL_SECONDS, clientId, canonical);
        String refresh = token("r1", now + REFRESH_TTL_SECONDS, clientId, canonical);
        refreshTokens.put(hashToken(refresh), new RefreshRecord(clientId, normalizeScope(scope), canonical,
                now + REFRESH_TTL_SECONDS));
        pruneRefreshTokens();
        persistRefreshTokens();

        return new JSONObject()
                .put("access_token", access)
                .put("token_type", "Bearer")
                .put("expires_in", ACCESS_TTL_SECONDS)
                .put("refresh_token", refresh)
                .put("scope", normalizeScope(scope));
    }

    private void validateClientAuthentication(String clientId, String secret) {
        JSONObject client = clients.get(clientId);
        if (client == null) throw new SecurityException("unknown client_id");
        String method = client.optString("token_endpoint_auth_method", "none");
        if ("none".equals(method)) return;
        if (!"client_secret_post".equals(method)) throw new SecurityException("unsupported client authentication method");
        if (!constantEquals(client.optString("client_secret", ""), secret == null ? "" : secret)) {
            throw new SecurityException("client authentication failed");
        }
    }

    private boolean passwordMatches(String candidate) {
        String expected = config.ownerPassword();
        return !expected.isEmpty() && constantEquals(expected, candidate == null ? "" : candidate);
    }

    private String token(String type, long expires, String clientId, String resource) throws Exception {
        String payload = type + "." + expires + "."
                + base64Url(clientId.getBytes(StandardCharsets.UTF_8)) + "."
                + base64Url(resource.getBytes(StandardCharsets.UTF_8)) + "."
                + randomToken(18);
        return payload + "." + base64Url(hmac(payload));
    }

    private TokenClaims verifySignedToken(String token, String expectedType) throws Exception {
        String[] parts = token == null ? new String[0] : token.split("\\.", -1);
        if (parts.length != 6 || !expectedType.equals(parts[0])) throw new SecurityException("invalid token");
        long expires = Long.parseLong(parts[1]);
        if (expires <= System.currentTimeMillis() / 1000L) throw new SecurityException("token expired");
        String payload = String.join(".", parts[0], parts[1], parts[2], parts[3], parts[4]);
        if (!constantEquals(base64Url(hmac(payload)), parts[5])) throw new SecurityException("token signature invalid");
        String clientId = decodeBase64Url(parts[2]);
        String resource = normalizeResource(decodeBase64Url(parts[3]));
        if (!clients.containsKey(clientId)) throw new SecurityException("token client no longer registered");
        if (resource.isEmpty()) throw new SecurityException("token resource missing");
        return new TokenClaims(clientId, resource, expires);
    }

    private byte[] hmac(String value) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(signingKey, "HmacSHA256"));
        return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
    }

    private String randomToken(int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return base64Url(value);
    }

    private String canonicalResource() {
        String base = AgentConfig.normalizeServer(config.publicBaseUrl());
        return base.isEmpty() ? "" : base + "/mcp";
    }

    private static String normalizeScope(String scope) {
        return DEFAULT_SCOPE;
    }

    private static String normalizeResource(String resource) {
        String value = resource == null ? "" : resource.trim();
        while (value.endsWith("/") && value.length() > 1) value = value.substring(0, value.length() - 1);
        return value;
    }

    private static boolean redirectUriAllowed(String uri) {
        if (uri == null || uri.trim().isEmpty()) return false;
        String value = uri.trim();
        if (value.startsWith("https://")) return true;
        if (value.startsWith("http://127.0.0.1") || value.startsWith("http://localhost") || value.startsWith("http://[::1]")) {
            return true;
        }
        int colon = value.indexOf(':');
        if (colon <= 0) return false;
        String scheme = value.substring(0, colon).toLowerCase(java.util.Locale.ROOT);
        if (scheme.equals("http") || scheme.equals("file") || scheme.equals("data")
                || scheme.equals("javascript") || scheme.equals("vbscript") || scheme.equals("ftp")) return false;
        return scheme.matches("[a-z][a-z0-9+.-]*") && scheme.contains(".");
    }

    private synchronized void persistClients() throws Exception {
        JSONObject root = new JSONObject();
        for (Map.Entry<String, JSONObject> entry : clients.entrySet()) root.put(entry.getKey(), entry.getValue());
        config.oauthClientsJson(root.toString());
    }

    private synchronized void persistRefreshTokens() throws Exception {
        pruneRefreshTokens();
        JSONObject root = new JSONObject();
        for (Map.Entry<String, RefreshRecord> entry : refreshTokens.entrySet()) root.put(entry.getKey(), entry.getValue().json());
        config.oauthRefreshTokensJson(root.toString());
    }

    private void loadClients() {
        String stored = config.oauthClientsJson();
        if (stored == null || stored.isEmpty()) return;
        try {
            JSONObject root = new JSONObject(stored);
            JSONArray names = root.names();
            if (names == null) return;
            for (int i = 0; i < names.length(); i++) {
                String name = names.optString(i, "");
                JSONObject value = root.optJSONObject(name);
                if (!name.isEmpty() && value != null) clients.put(name, value);
            }
        } catch (Exception ignored) {}
    }

    private void loadRefreshTokens() {
        String stored = config.oauthRefreshTokensJson();
        if (stored == null || stored.isEmpty()) return;
        try {
            JSONObject root = new JSONObject(stored);
            JSONArray names = root.names();
            if (names == null) return;
            for (int i = 0; i < names.length(); i++) {
                String hash = names.optString(i, "");
                JSONObject value = root.optJSONObject(hash);
                if (hash.isEmpty() || value == null) continue;
                refreshTokens.put(hash, new RefreshRecord(
                        value.optString("client_id", ""), value.optString("scope", DEFAULT_SCOPE),
                        value.optString("resource", ""), value.optLong("expires_at", 0)));
            }
        } catch (Exception ignored) {}
    }

    private void pruneAuthorizationCodes() {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, AuthorizationCode> entry : codes.entrySet()) {
            if (entry.getValue().expiresAt <= now) codes.remove(entry.getKey(), entry.getValue());
        }
        while (codes.size() > 256) {
            java.util.Enumeration<String> keys = codes.keys();
            if (!keys.hasMoreElements()) break;
            codes.remove(keys.nextElement());
        }
    }

    private void pruneRefreshTokens() {
        long now = System.currentTimeMillis() / 1000L;
        for (Map.Entry<String, RefreshRecord> entry : refreshTokens.entrySet()) {
            if (entry.getValue().expiresAt <= now) refreshTokens.remove(entry.getKey(), entry.getValue());
        }
        while (refreshTokens.size() > 1024) {
            java.util.Enumeration<String> keys = refreshTokens.keys();
            if (!keys.hasMoreElements()) break;
            refreshTokens.remove(keys.nextElement());
        }
    }

    private static String hashToken(String token) throws Exception {
        return base64Url(MessageDigest.getInstance("SHA-256")
                .digest((token == null ? "" : token).getBytes(StandardCharsets.UTF_8)));
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String decodeBase64Url(String value) {
        return new String(Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
    }

    private static boolean constantEquals(String left, String right) {
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }

    private static final class TokenClaims {
        final String clientId;
        final String resource;
        final long expires;
        TokenClaims(String clientId, String resource, long expires) {
            this.clientId = clientId;
            this.resource = resource;
            this.expires = expires;
        }
    }
}
