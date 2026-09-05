package com.devspace.agent;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

final class PathGuard {
    private final boolean fullAccess;
    private final List<String> writableRoots;

    PathGuard(String accessMode, List<String> writableRoots) {
        this.fullAccess = "full-access".equalsIgnoreCase(accessMode);
        this.writableRoots = new ArrayList<>();
        if (writableRoots != null) {
            for (String root : writableRoots) {
                if (root != null && !root.trim().isEmpty()) this.writableRoots.add(normalizeAbsolute(root));
            }
        }
        if (!fullAccess && this.writableRoots.isEmpty()) {
            throw new IllegalArgumentException("Scoped Android Agent requires at least one writable root.");
        }
    }

    boolean fullAccess() { return fullAccess; }

    List<String> writableRoots() { return new ArrayList<>(writableRoots); }

    String workspaceRoot(String root) {
        return normalizeAbsolute(root);
    }

    String absolute(String root, String path) {
        String workspace = workspaceRoot(root);
        String candidate;
        if (path == null || path.isEmpty() || ".".equals(path)) candidate = workspace;
        else if (path.startsWith("/")) candidate = normalizeAbsolute(path);
        else candidate = normalizeAbsolute(workspace + "/" + path);
        if (!inside(workspace, candidate)) {
            throw new SecurityException("Path is outside the opened Android workspace: " + candidate);
        }
        return candidate;
    }

    String writable(String root, String path) {
        String candidate = absolute(root, path);
        if (fullAccess) return candidate;
        for (String allowed : writableRoots) {
            if (inside(allowed, candidate)) return candidate;
        }
        throw new SecurityException("Android Agent write is outside configured writable roots: " + candidate);
    }

    static boolean inside(String root, String candidate) {
        if ("/".equals(root)) return candidate.startsWith("/");
        return candidate.equals(root) || candidate.startsWith(root + "/");
    }

    static String normalizeAbsolute(String value) {
        String text = value == null ? "" : value.trim().replace('\\', '/');
        if (!text.startsWith("/")) throw new IllegalArgumentException("Android path must be absolute: " + value);
        Deque<String> parts = new ArrayDeque<>();
        for (String part : text.split("/+")) {
            if (part.isEmpty() || ".".equals(part)) continue;
            if ("..".equals(part)) {
                if (parts.isEmpty()) throw new IllegalArgumentException("Android path escapes root: " + value);
                parts.removeLast();
            } else {
                parts.addLast(part);
            }
        }
        if (parts.isEmpty()) return "/";
        StringBuilder out = new StringBuilder();
        for (String part : parts) out.append('/').append(part);
        return out.toString();
    }
}
