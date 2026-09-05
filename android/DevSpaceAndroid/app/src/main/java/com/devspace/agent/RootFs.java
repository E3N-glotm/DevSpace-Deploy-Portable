package com.devspace.agent;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

final class RootFs {
    static final int TRANSFER_CHUNK_BYTES = 512 * 1024;
    static final int MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
    static final int MAX_READ_TEXT_BYTES = 4 * 1024 * 1024;
    static final int MAX_READ_TEXT_LINES = 10_000;
    static final int MAX_LIST_ENTRIES = 5_000;
    static final int MAX_SEARCH_RESULTS = 2_000;

    static final class Stat {
        final boolean exists;
        final String type;
        final long size;
        final long mtimeMs;
        final int mode;

        Stat(boolean exists, String type, long size, long mtimeMs, int mode) {
            this.exists = exists;
            this.type = type;
            this.size = size;
            this.mtimeMs = mtimeMs;
            this.mode = mode;
        }

        JSONObject json() throws JSONException {
            JSONObject value = new JSONObject()
                    .put("exists", exists)
                    .put("type", type)
                    .put("size", size);
            if (exists) value.put("mtimeMs", mtimeMs).put("mode", mode);
            return value;
        }
    }

    private final RootShell shell;
    private final PathGuard guard;

    RootFs(RootShell shell, PathGuard guard) {
        this.shell = shell;
        this.guard = guard;
    }

    PathGuard guard() { return guard; }

    Stat stat(String root, String path) throws Exception {
        return statAbsolute(guard.absolute(root, path));
    }

    Stat statAbsolute(String target) throws Exception {
        String q = ShellEscaper.quote(target);
        String command = "p=" + q + "; "
                + "if [ -L \"$p\" ]; then printf 'symlink|0|0|0\\n'; exit 0; "
                + "elif [ -f \"$p\" ]; then t=file; "
                + "elif [ -d \"$p\" ]; then t=directory; "
                + "elif [ -e \"$p\" ]; then t=special; "
                + "else printf 'missing|0|0|0\\n'; exit 0; fi; "
                + "s=$(stat -c '%s' -- \"$p\" 2>/dev/null || echo 0); "
                + "m=$(stat -c '%Y' -- \"$p\" 2>/dev/null || echo 0); "
                + "a=$(stat -c '%a' -- \"$p\" 2>/dev/null || echo 0); "
                + "printf '%s|%s|%s|%s\\n' \"$t\" \"$s\" \"$m\" \"$a\"";
        RootShell.Result result = shell.exec(command, null, 15, 64 * 1024);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        String[] fields = new String(result.stdout, StandardCharsets.UTF_8).trim().split("\\|", -1);
        if (fields.length < 4 || "missing".equals(fields[0])) return new Stat(false, "missing", 0, 0, 0);
        return new Stat(true, fields[0], parseLong(fields[1]), parseLong(fields[2]) * 1000L, parseMode(fields[3]));
    }

    byte[] readBytes(String root, String path, int maxBytes) throws Exception {
        return readAbsoluteBytes(readableTarget(root, path), maxBytes);
    }

    byte[] readAbsoluteBytes(String target, int maxBytes) throws Exception {
        RootShell.Result result = shell.exec("cat -- " + ShellEscaper.quote(target), null, 60, Math.max(1024, maxBytes));
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        if (result.stdout.length >= maxBytes) {
            Stat stat = statAbsolute(target);
            if (stat.size > maxBytes) throw new IOException("File exceeds bounded read limit: " + stat.size + " bytes");
        }
        return result.stdout;
    }

    byte[] readChunk(String root, String path, long offset, int length) throws Exception {
        String target = readableTarget(root, path);
        int boundedLength = Math.max(1, Math.min(length, TRANSFER_CHUNK_BYTES));
        long boundedOffset = Math.max(0, offset);
        String command = "dd if=" + ShellEscaper.quote(target)
                + " bs=1 skip=" + boundedOffset + " count=" + boundedLength + " 2>/dev/null";
        RootShell.Result result = shell.exec(command, null, 60, boundedLength + 4096);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        return result.stdout;
    }

    JSONObject write(String root, String path, byte[] content, Integer mode) throws Exception {
        String target = writableTarget(root, path);
        writeAbsolute(target, content, mode);
        return new JSONObject()
                .put("path", path)
                .put("bytes", content.length)
                .put("sha256", Hashing.sha256(content))
                .put("deltaTransfer", false);
    }

    void writeAbsolute(String target, byte[] content, Integer mode) throws Exception {
        String parent = parent(target);
        String temp = target + ".devspace-write-" + Long.toHexString(System.nanoTime());
        StringBuilder command = new StringBuilder()
                .append("mkdir -p -- ").append(ShellEscaper.quote(parent)).append(" && ")
                .append("cat > ").append(ShellEscaper.quote(temp));
        if (mode != null) {
            command.append(" && chmod ").append(Integer.toOctalString(mode & 07777)).append(" -- ")
                    .append(ShellEscaper.quote(temp));
        }
        command.append(" && mv -f -- ").append(ShellEscaper.quote(temp)).append(' ').append(ShellEscaper.quote(target));
        RootShell.Result result = shell.exec(command.toString(), content, 120, 512 * 1024);
        if (result.exitCode != 0) {
            try { shell.exec("rm -f -- " + ShellEscaper.quote(temp), 10); } catch (Exception ignored) {}
            throw new IOException(result.outputText().trim());
        }
    }

    void writeTransferManifest(String target, String manifestPath, Integer mode) throws Exception {
        String parent = parent(target);
        String temp = target + ".devspace-transfer-" + Long.toHexString(System.nanoTime());
        StringBuilder command = new StringBuilder()
                .append("mkdir -p -- ").append(ShellEscaper.quote(parent)).append(" && ")
                .append(": > ").append(ShellEscaper.quote(temp)).append(" && ")
                .append("while IFS= read -r f; do cat -- \"$f\" >> ")
                .append(ShellEscaper.quote(temp)).append(" || exit 1; done < ")
                .append(ShellEscaper.quote(manifestPath));
        if (mode != null) {
            command.append(" && chmod ").append(Integer.toOctalString(mode & 07777)).append(" -- ")
                    .append(ShellEscaper.quote(temp));
        }
        command.append(" && mv -f -- ").append(ShellEscaper.quote(temp)).append(' ').append(ShellEscaper.quote(target));
        RootShell.Result result = shell.exec(command.toString(), null, 300, 512 * 1024);
        if (result.exitCode != 0) {
            try { shell.exec("rm -f -- " + ShellEscaper.quote(temp), 10); } catch (Exception ignored) {}
            throw new IOException(result.outputText().trim());
        }
    }

    JSONObject edit(String root, String path, JSONArray edits) throws Exception {
        String target = writableTarget(root, path);
        byte[] bytes = readAbsoluteBytes(target, MAX_READ_TEXT_BYTES);
        String original = new String(bytes, StandardCharsets.UTF_8);
        String updated = original;
        for (int i = 0; i < edits.length(); i++) {
            JSONObject edit = edits.getJSONObject(i);
            String oldText = edit.optString("oldText", "");
            String newText = edit.optString("newText", "");
            int first = updated.indexOf(oldText);
            int last = updated.lastIndexOf(oldText);
            if (first < 0 || first != last) {
                throw new IllegalArgumentException("oldText must match exactly once; matched "
                        + (first < 0 ? 0 : "multiple") + " time(s).");
            }
            updated = updated.substring(0, first) + newText + updated.substring(first + oldText.length());
        }
        writeAbsolute(target, updated.getBytes(StandardCharsets.UTF_8), null);
        return new JSONObject()
                .put("path", path)
                .put("before", original)
                .put("after", updated)
                .put("edits", edits.length());
    }

    JSONObject remove(String root, String path) throws Exception {
        String target = writableTarget(root, path);
        RootShell.Result result = shell.exec("rm -rf -- " + ShellEscaper.quote(target), 60);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        return new JSONObject().put("removed", true).put("path", path);
    }

    JSONObject rename(String root, String path, String destination) throws Exception {
        String source = writableTarget(root, path);
        String target = writableTarget(root, destination);
        RootShell.Result result = shell.exec("mkdir -p -- " + ShellEscaper.quote(parent(target))
                + " && mv -f -- " + ShellEscaper.quote(source) + " " + ShellEscaper.quote(target), 60);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        return new JSONObject().put("path", destination).put("previousPath", path);
    }

    JSONObject mkdir(String root, String path) throws Exception {
        String target = writableTarget(root, path);
        RootShell.Result result = shell.exec("mkdir -p -- " + ShellEscaper.quote(target), 30);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        return new JSONObject().put("created", true).put("path", path);
    }

    JSONObject list(String root, String path) throws Exception {
        String target = readableTarget(root, path == null ? "." : path);
        // Android normally ships toybox rather than GNU find. `find -printf`
        // therefore is not portable across stock/OEM ROMs; enumerate names
        // with toybox-compatible `ls -A1` and obtain metadata via stat below.
        RootShell.Result listing = shell.exec("cd " + ShellEscaper.quote(target)
                + " && ls -A1 2>/dev/null | head -n " + (MAX_LIST_ENTRIES + 1),
                null, 30, 2 * 1024 * 1024);
        if (listing.exitCode != 0) throw new IOException(listing.outputText().trim());
        String text = new String(listing.stdout, StandardCharsets.UTF_8);
        List<String> names = new ArrayList<>();
        if (!text.isEmpty()) names.addAll(Arrays.asList(text.split("\\n", -1)));
        if (!names.isEmpty() && names.get(names.size() - 1).isEmpty()) names.remove(names.size() - 1);
        boolean truncated = names.size() > MAX_LIST_ENTRIES;
        if (truncated) names = names.subList(0, MAX_LIST_ENTRIES);
        names.sort(String.CASE_INSENSITIVE_ORDER);
        JSONArray entries = new JSONArray();
        for (String name : names) {
            if (name.indexOf('\n') >= 0 || name.isEmpty()) continue;
            Stat stat = statAbsolute(target.equals("/") ? "/" + name : target + "/" + name);
            if (!stat.exists) continue;
            entries.put(new JSONObject()
                    .put("name", name)
                    .put("type", stat.type)
                    .put("size", stat.size)
                    .put("mtimeMs", stat.mtimeMs));
        }
        return new JSONObject().put("path", path == null || path.isEmpty() ? "." : path)
                .put("entries", entries).put("truncated", truncated);
    }

    JSONObject read(String root, String path, int offset, int limit) throws Exception {
        String target = readableTarget(root, path);
        Stat stat = statAbsolute(target);
        if (!stat.exists || !"file".equals(stat.type)) throw new IOException("Not a regular file: " + path);
        byte[] sample = readChunk(root, path, 0, (int) Math.min(65536, Math.max(1, stat.size)));
        if (containsNul(sample)) {
            return new JSONObject().put("kind", "binary").put("size", stat.size).put("truncated", true);
        }
        int boundedOffset = Math.max(1, offset);
        int boundedLimit = Math.max(1, Math.min(limit, MAX_READ_TEXT_LINES));
        int end = boundedOffset + boundedLimit - 1;
        String command = "sed -n '" + boundedOffset + "," + end + "p' -- " + ShellEscaper.quote(target);
        RootShell.Result result = shell.exec(command, null, 60, MAX_READ_TEXT_BYTES);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        String selected = new String(result.stdout, StandardCharsets.UTF_8);
        int lines = countLines(selected);
        boolean truncated = lines >= boundedLimit || result.stdout.length >= MAX_READ_TEXT_BYTES;
        return new JSONObject()
                .put("kind", "text")
                .put("text", selected)
                .put("size", stat.size)
                .put("offset", boundedOffset)
                .put("totalLines", JSONObject.NULL)
                .put("truncated", truncated);
    }

    JSONObject grep(String root, String path, String pattern, String include) throws Exception {
        String scope = readableTarget(root, path == null ? "." : path);
        // Android ships Toybox grep. GNU-only long options such as
        // --binary-files/--exclude-dir/--include are not uniformly available
        // across Android releases, so let Toybox find perform filtering and
        // feed NUL-delimited absolute file names to Toybox xargs/grep.
        StringBuilder command = new StringBuilder("find ")
                .append(ShellEscaper.quote(scope))
                .append(" -type d \\( -name .git -o -name node_modules \\) -prune -o -type f ");
        if (include != null && !include.isEmpty()) {
            command.append("-name ").append(ShellEscaper.quote(include)).append(' ');
        }
        command.append("-print0 2>/dev/null | xargs -0 -r grep -nH -E -e ")
                .append(ShellEscaper.quote(pattern))
                .append(" 2>/dev/null | head -n ").append(MAX_SEARCH_RESULTS + 1);
        RootShell.Result result = shell.exec(command.toString(), null, 120, 4 * 1024 * 1024);
        if (result.exitCode != 0 && result.exitCode != 1) throw new IOException(result.outputText().trim());
        String[] lines = new String(result.stdout, StandardCharsets.UTF_8).split("\\n");
        JSONArray matches = new JSONArray();
        boolean truncated = lines.length > MAX_SEARCH_RESULTS;
        int count = Math.min(lines.length, MAX_SEARCH_RESULTS);
        for (int i = 0; i < count; i++) {
            String line = lines[i];
            int first = line.indexOf(':');
            int second = first < 0 ? -1 : line.indexOf(':', first + 1);
            if (first < 0 || second < 0) continue;
            String file = line.substring(0, first);
            int lineNumber;
            try { lineNumber = Integer.parseInt(line.substring(first + 1, second)); } catch (NumberFormatException ignored) { continue; }
            String relative = PathGuard.inside(scope, file) ? relativize(root, file) : file;
            matches.put(new JSONObject().put("path", relative).put("line", lineNumber)
                    .put("text", line.substring(second + 1, Math.min(line.length(), second + 4001))));
        }
        return new JSONObject().put("matches", matches).put("truncated", truncated);
    }

    JSONObject glob(String root, String path, String pattern) throws Exception {
        String scope = readableTarget(root, path == null ? "." : path);
        String normalizedPattern = pattern.replace('\\', '/');
        String command = "cd " + ShellEscaper.quote(scope) + " && find . -path "
                + ShellEscaper.quote("./" + normalizedPattern) + " -print 2>/dev/null | head -n " + (MAX_SEARCH_RESULTS + 1);
        RootShell.Result result = shell.exec(command, null, 120, 2 * 1024 * 1024);
        if (result.exitCode != 0) throw new IOException(result.outputText().trim());
        String[] lines = new String(result.stdout, StandardCharsets.UTF_8).split("\\n");
        JSONArray matches = new JSONArray();
        boolean truncated = lines.length > MAX_SEARCH_RESULTS;
        int count = Math.min(lines.length, MAX_SEARCH_RESULTS);
        for (int i = 0; i < count; i++) {
            String value = lines[i];
            if (value.startsWith("./")) value = value.substring(2);
            if (!value.isEmpty()) matches.put(value);
        }
        return new JSONObject().put("matches", matches).put("truncated", truncated);
    }

    JSONObject shellRun(String root, String cwd, String command, int timeout) throws Exception {
        if (!guard.fullAccess()) {
            throw new SecurityException("Scoped Android Agent rejects arbitrary Root shell. Enable Full Access or use structured workspace tools.");
        }
        String workspace = guard.workspaceRoot(root);
        String working = guard.absolute(workspace, cwd == null || cwd.isEmpty() ? workspace : cwd);
        RootShell.Result result = shell.exec("cd " + ShellEscaper.quote(working) + " && " + command,
                null, Math.max(1, Math.min(timeout, 300)), RootShell.DEFAULT_MAX_OUTPUT);
        return new JSONObject().put("output", result.outputText()).put("exitCode", result.exitCode);
    }

    JSONObject capture(String root, String path) throws Exception {
        String target = guard.absolute(root, path);
        Stat stat = statAbsolute(target);
        JSONObject descriptor = stat.json().put("stored", false);
        JSONObject value = new JSONObject().put("descriptor", descriptor);
        if (!stat.exists) return value;
        if ("symlink".equals(stat.type)) {
            RootShell.Result link = shell.exec("readlink -- " + ShellEscaper.quote(target), null, 15, 64 * 1024);
            if (link.exitCode != 0) throw new IOException(link.outputText().trim());
            String linkTarget = new String(link.stdout, StandardCharsets.UTF_8).trim();
            String resolved = linkTarget.startsWith("/") ? linkTarget : parent(target) + "/" + linkTarget;
            readableTarget(root, resolved);
            descriptor.put("linkTarget", linkTarget).put("stored", true);
            return value;
        }
        readableTarget(root, path);
        if (!"file".equals(stat.type)) return value;
        if (stat.size > MAX_CAPTURE_BYTES) {
            descriptor.put("reason", "file-exceeds-" + MAX_CAPTURE_BYTES + "-bytes");
            return value;
        }
        byte[] content = readAbsoluteBytes(target, MAX_CAPTURE_BYTES + 1);
        descriptor.put("sha256", Hashing.sha256(content)).put("text", !containsNul(Arrays.copyOf(content, Math.min(content.length, 65536))));
        value.put("content", ContentCodec.encode(content));
        return value;
    }

    JSONObject restore(String root, String path, JSONObject descriptor, JSONObject encodedContent) throws Exception {
        String target = writableTarget(root, path);
        if (!descriptor.optBoolean("exists", false)) {
            remove(root, path);
            return new JSONObject().put("restored", true).put("path", path);
        }
        String type = descriptor.optString("type", "");
        if ("symlink".equals(type)) {
            String linkTarget = descriptor.optString("linkTarget", "");
            String resolved = linkTarget.startsWith("/") ? linkTarget : parent(target) + "/" + linkTarget;
            readableTarget(root, resolved);
            RootShell.Result result = shell.exec("rm -rf -- " + ShellEscaper.quote(target) + " && mkdir -p -- " + ShellEscaper.quote(parent(target))
                    + " && ln -s -- " + ShellEscaper.quote(linkTarget) + " " + ShellEscaper.quote(target), 30);
            if (result.exitCode != 0) throw new IOException(result.outputText().trim());
            return new JSONObject().put("restored", true).put("path", path);
        }
        if (!"file".equals(type)) throw new IllegalArgumentException("Only missing paths, files, and symlinks are restorable.");
        byte[] content = ContentCodec.decode(encodedContent, MAX_CAPTURE_BYTES);
        Integer mode = descriptor.has("mode") ? descriptor.optInt("mode") : null;
        writeAbsolute(target, content, mode);
        return new JSONObject().put("restored", true).put("path", path).put("bytes", content.length);
    }

    private static boolean containsNul(byte[] bytes) {
        for (byte value : bytes) if (value == 0) return true;
        return false;
    }

    private static int countLines(String text) {
        if (text.isEmpty()) return 0;
        int count = 0;
        for (int i = 0; i < text.length(); i++) if (text.charAt(i) == '\n') count++;
        if (!text.endsWith("\n")) count++;
        return count;
    }

    private static long parseLong(String value) {
        try { return Long.parseLong(value.trim()); } catch (Exception ignored) { return 0; }
    }

    private static int parseMode(String value) {
        try { return Integer.parseInt(value.trim(), 8); } catch (Exception ignored) { return 0; }
    }

    static String parent(String path) {
        int slash = path.lastIndexOf('/');
        return slash <= 0 ? "/" : path.substring(0, slash);
    }

    static String relativize(String root, String target) {
        String normalizedRoot = PathGuard.normalizeAbsolute(root);
        String normalizedTarget = PathGuard.normalizeAbsolute(target);
        if (normalizedTarget.equals(normalizedRoot)) return ".";
        if (PathGuard.inside(normalizedRoot, normalizedTarget)) {
            return normalizedTarget.substring(normalizedRoot.equals("/") ? 1 : normalizedRoot.length() + 1);
        }
        return normalizedTarget;
    }

    String writableTarget(String root, String path) throws Exception {
        String candidate = guard.writable(root, path);
        assertCanonicalWorkspace(root, candidate);
        if (guard.fullAccess()) return candidate;
        String canonicalCandidate = canonicalPotential(candidate);
        for (String writableRoot : guard.writableRoots()) {
            String canonicalWritableRoot = canonicalPotential(writableRoot);
            if (PathGuard.inside(canonicalWritableRoot, canonicalCandidate)) return candidate;
        }
        throw new SecurityException("Android Agent write escapes configured writable roots through a symbolic link: " + candidate);
    }

    private String readableTarget(String root, String path) throws Exception {
        String candidate = guard.absolute(root, path);
        assertCanonicalWorkspace(root, candidate);
        return candidate;
    }

    private void assertCanonicalWorkspace(String root, String candidate) throws Exception {
        String canonicalRoot = canonicalPotential(guard.workspaceRoot(root));
        String canonicalCandidate = canonicalPotential(candidate);
        if (!PathGuard.inside(canonicalRoot, canonicalCandidate)) {
            throw new SecurityException("Android Agent path escapes the opened workspace through a symbolic link: " + candidate);
        }
    }

    private String canonicalPotential(String path) throws Exception {
        String normalized = PathGuard.normalizeAbsolute(path);
        String command = "p=" + ShellEscaper.quote(normalized) + "; suffix=''; "
                + "while [ ! -e \"$p\" ] && [ \"$p\" != / ]; do "
                + "b=${p##*/}; suffix=\"/$b$suffix\"; p=${p%/*}; [ -n \"$p\" ] || p=/; done; "
                + "base=$(realpath \"$p\" 2>/dev/null) || exit 1; printf '%s%s\\n' \"$base\" \"$suffix\"";
        RootShell.Result result = shell.exec(command, null, 15, 64 * 1024);
        if (result.exitCode != 0) throw new IOException("Unable to canonicalize Android path: " + normalized);
        String canonical = new String(result.stdout, StandardCharsets.UTF_8).trim();
        if (canonical.isEmpty()) throw new IOException("Unable to canonicalize Android path: " + normalized);
        return PathGuard.normalizeAbsolute(canonical);
    }
}
