package com.devspace.agent;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

final class FileRpc {
    private final RootFs fs;
    private final TransferRegistry transfers;

    FileRpc(Context context, RootShell shell, PathGuard guard) {
        fs = new RootFs(shell, guard);
        transfers = new TransferRegistry(context, fs);
    }

    RootFs fs() { return fs; }

    Object dispatch(String method, JSONObject params) throws Exception {
        String root;
        switch (method) {
            case "workspace.inspect": return workspaceInspect(params);
            case "workspace.createWorktree": throw new UnsupportedOperationException("Android Agent does not create Git worktrees.");
            case "fs.stat": return fs.stat(params.getString("root"), params.optString("path", ".")).json();
            case "fs.capture": return fs.capture(params.getString("root"), params.optString("path", "."));
            case "fs.restore": return fs.restore(params.getString("root"), params.optString("path", "."),
                    params.optJSONObject("descriptor") == null ? new JSONObject() : params.optJSONObject("descriptor"), params.optJSONObject("content"));
            case "fs.read": return fs.read(params.getString("root"), params.getString("path"),
                    Math.max(1, params.optInt("offset", 1)), Math.max(1, params.optInt("limit", 2000)));
            case "fs.readChunk": {
                byte[] bytes = fs.readChunk(params.getString("root"), params.getString("path"),
                        Math.max(0, params.optLong("offset", 0)), Math.max(1, params.optInt("length", RootFs.TRANSFER_CHUNK_BYTES)));
                return new JSONObject().put("offset", Math.max(0, params.optLong("offset", 0))).put("bytes", bytes.length)
                        .put("content", ContentCodec.encode(bytes)).put("sha256", Hashing.sha256(bytes));
            }
            case "fs.write": {
                byte[] content = ContentCodec.decode(params.optJSONObject("content"), RootFs.TRANSFER_CHUNK_BYTES);
                String expected = params.optString("sha256", "");
                if (!expected.isEmpty() && !expected.equals(Hashing.sha256(content))) throw new IOException("Remote write content hash mismatch.");
                return fs.write(params.getString("root"), params.getString("path"), content,
                        params.has("mode") ? params.optInt("mode") : null);
            }
            case "fs.edit": return fs.edit(params.getString("root"), params.getString("path"),
                    params.optJSONArray("edits") == null ? new JSONArray() : params.getJSONArray("edits"));
            case "fs.remove": return fs.remove(params.getString("root"), params.optString("path", "."));
            case "fs.rename": return fs.rename(params.getString("root"), params.getString("path"), params.getString("destination"));
            case "fs.mkdir": return fs.mkdir(params.getString("root"), params.optString("path", "."));
            case "fs.list": return fs.list(params.getString("root"), params.optString("path", "."));
            case "fs.prepareWrite": return transfers.prepare(params);
            case "fs.writeChunk": return transfers.writeChunk(params);
            case "fs.commitWrite": return transfers.commit(params);
            case "search.grep": return fs.grep(params.getString("root"), params.optString("path", "."),
                    params.getString("pattern"), params.optString("include", ""));
            case "search.glob": return fs.glob(params.getString("root"), params.optString("path", "."), params.getString("pattern"));
            case "shell.run": return fs.shellRun(params.getString("root"), params.optString("cwd", params.getString("root")),
                    params.getString("command"), Math.max(1, Math.min(300, params.optInt("timeout", 30))));
            default: throw new UnsupportedOperationException("Unsupported Android file RPC: " + method);
        }
    }

    private JSONObject workspaceInspect(JSONObject params) throws Exception {
        String root = fs.guard().workspaceRoot(params.getString("path"));
        RootFs.Stat rootStat = fs.statAbsolute(root);
        if (!rootStat.exists || !"directory".equals(rootStat.type)) throw new IOException("Android workspace is not a directory: " + root);
        JSONArray loaded = new JSONArray();
        for (String name : Arrays.asList("AGENTS.md", "CLAUDE.md")) {
            String path = root.equals("/") ? "/" + name : root + "/" + name;
            RootFs.Stat stat = fs.stat(root, name);
            if (!stat.exists || !"file".equals(stat.type) || stat.size > 512 * 1024) continue;
            byte[] bytes = fs.readBytes(root, name, 512 * 1024 + 1);
            loaded.put(new JSONObject().put("path", path).put("content", new String(bytes, StandardCharsets.UTF_8)));
        }
        String title = root.equals("/") ? "/" : root.substring(root.lastIndexOf('/') + 1);
        return new JSONObject()
                .put("root", root)
                .put("title", title)
                .put("git", new JSONObject())
                .put("agentsFiles", loaded)
                .put("availableAgentsFiles", new JSONArray());
    }
}
