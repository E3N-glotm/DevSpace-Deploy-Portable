package com.devspace.agent;

import android.content.Context;
import android.os.Environment;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

final class StandaloneMcpDispatcher implements AutoCloseable {
    private final AgentConfig config;
    private final RootShell rootShell;
    private final FileRpc files;
    private final AndroidControl android;
    private final ProcessRegistry processes;
    private final ConcurrentHashMap<String, String> workspaces = new ConcurrentHashMap<>();

    StandaloneMcpDispatcher(Context context, AgentConfig config, RootShell rootShell) {
        this.config = config;
        this.rootShell = rootShell;
        List<String> roots = config.standaloneWritableRoots();
        if (!config.fullAccess() && roots.isEmpty()) {
            @SuppressWarnings("deprecation")
            String external = Environment.getExternalStorageDirectory().getAbsolutePath();
            roots = java.util.Arrays.asList(external + "/DevSpace", "/data/local/tmp/devspace");
        }
        PathGuard guard = new PathGuard(config.standaloneAccessMode(), roots);
        files = new FileRpc(context, rootShell, guard);
        android = new AndroidControl(context, rootShell, config);
        processes = new ProcessRegistry(rootShell, guard);
    }

    JSONArray tools() throws Exception {
        JSONArray tools = new JSONArray();
        tools.put(tool("android_device_status", "读取手机 Root、电量、屏幕、存储和 Android 状态。", new JSONObject()));
        tools.put(tool("android_snapshot", "截取当前手机屏幕，默认返回低延迟 JPEG。", objectSchema()
                .put("properties", new JSONObject()
                        .put("format", enumSchema("jpeg", "png"))
                        .put("quality", integerSchema(30, 100))
                        .put("maxWidth", integerSchema(320, 4096)))));
        tools.put(tool("android_action", "执行 Root 触控/按键/文字输入，支持最多 50 步批处理。", objectSchema()
                .put("properties", new JSONObject()
                        .put("action", enumSchema("tap", "swipe", "text", "key", "back", "home", "sleep"))
                        .put("x", integerSchema(0, 32767)).put("y", integerSchema(0, 32767))
                        .put("x1", integerSchema(0, 32767)).put("y1", integerSchema(0, 32767))
                        .put("x2", integerSchema(0, 32767)).put("y2", integerSchema(0, 32767))
                        .put("durationMs", integerSchema(0, 30000)).put("text", new JSONObject().put("type", "string"))
                        .put("key", new JSONObject().put("type", "string")).put("steps", new JSONObject().put("type", "array").put("maxItems", 50)))));
        tools.put(tool("android_app", "Root 应用管理：list/info/start/stop/clear/install/uninstall。", objectSchema()
                .put("properties", new JSONObject().put("action", enumSchema("list", "info", "start", "stop", "clear", "install", "uninstall"))
                        .put("package", stringSchema()).put("component", stringSchema()).put("path", stringSchema()))
                .put("required", new JSONArray().put("action"))));
        tools.put(tool("android_shell", "在 Full Root Access 模式下执行任意 Root shell 命令。", objectSchema()
                .put("properties", new JSONObject().put("command", stringSchema()).put("cwd", stringSchema()).put("timeout", integerSchema(1, 300)))
                .put("required", new JSONArray().put("command"))));
        tools.put(tool("open_workspace", "在手机本机打开一个绝对路径作为 DevSpace workspace。", objectSchema()
                .put("properties", new JSONObject().put("path", stringSchema()))
                .put("required", new JSONArray().put("path"))));
        tools.put(tool("stat", "读取 Android workspace 内文件或目录的类型、大小、时间和权限。", workspacePathSchema(false)));
        tools.put(tool("read", "读取已打开 Android workspace 内的文本文件。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema())
                        .put("offset", integerSchema(1, Integer.MAX_VALUE)).put("limit", integerSchema(1, 20000)))
                .put("required", new JSONArray().put("workspaceId").put("path"))));
        tools.put(tool("ls", "列出已打开 Android workspace 内的目录。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()))
                .put("required", new JSONArray().put("workspaceId"))));
        tools.put(tool("write", "以 UTF-8 完整写入已打开 Android workspace 内的文件。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()).put("content", stringSchema()))
                .put("required", new JSONArray().put("workspaceId").put("path").put("content"))));
        tools.put(tool("edit", "对 Android workspace 内文本文件执行一组唯一 oldText -> newText 编辑。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema())
                        .put("edits", new JSONObject().put("type", "array").put("minItems", 1).put("maxItems", 256)))
                .put("required", new JSONArray().put("workspaceId").put("path").put("edits"))));
        tools.put(tool("remove", "删除 Android workspace 内允许写入的文件或目录。", workspacePathSchema(true)));
        tools.put(tool("rename", "移动或重命名 Android workspace 内允许写入的路径。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()).put("destination", stringSchema()))
                .put("required", new JSONArray().put("workspaceId").put("path").put("destination"))));
        tools.put(tool("mkdir", "创建 Android workspace 内允许写入的目录。", workspacePathSchema(true)));
        tools.put(tool("grep", "在 Android workspace 中使用受控 grep 搜索文本。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()).put("pattern", stringSchema()).put("include", stringSchema()))
                .put("required", new JSONArray().put("workspaceId").put("pattern"))));
        tools.put(tool("glob", "按路径 pattern 在 Android workspace 中枚举文件。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()).put("pattern", stringSchema()))
                .put("required", new JSONArray().put("workspaceId").put("pattern"))));
        tools.put(tool("exec_command", "在 Full Root Access 模式下从已打开 workspace 执行 Root shell。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("command", stringSchema()).put("workingDirectory", stringSchema()).put("timeout", integerSchema(1, 300)))
                .put("required", new JSONArray().put("workspaceId").put("command"))));
        tools.put(tool("process_start", "在 Full Root Access workspace 中启动可轮询的非 PTY Root 长进程。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("command", stringSchema())
                        .put("cwd", stringSchema()).put("processHandle", stringSchema())
                        .put("yieldTimeMs", integerSchema(0, 30000)).put("maxOutputTokens", integerSchema(1, 500000)))
                .put("required", new JSONArray().put("workspaceId").put("command"))));
        tools.put(tool("write_stdin", "向已启动 Android Root 进程写入字符并轮询新增输出。", objectSchema()
                .put("properties", new JSONObject().put("processHandle", stringSchema()).put("chars", stringSchema())
                        .put("yieldTimeMs", integerSchema(0, 30000)).put("maxOutputTokens", integerSchema(1, 500000)))
                .put("required", new JSONArray().put("processHandle"))));
        tools.put(tool("process_list", "列出 Android standalone MCP 进程注册表。", objectSchema()
                .put("properties", new JSONObject().put("workspaceId", stringSchema()).put("includeCompleted", new JSONObject().put("type", "boolean"))
                        .put("limit", integerSchema(1, 1000)))));
        tools.put(tool("process_attach", "读取已知 Android Root 长进程的当前状态和缓冲输出。", objectSchema()
                .put("properties", new JSONObject().put("processHandle", stringSchema()).put("maxOutputTokens", integerSchema(1, 500000)))
                .put("required", new JSONArray().put("processHandle"))));
        tools.put(tool("process_kill", "终止已知 Android Root 长进程。", objectSchema()
                .put("properties", new JSONObject().put("processHandle", stringSchema()).put("signal", stringSchema()).put("maxOutputTokens", integerSchema(1, 500000)))
                .put("required", new JSONArray().put("processHandle"))));
        return tools;
    }

    JSONObject call(String name, JSONObject args) throws Exception {
        switch (name) {
            case "android_device_status": {
                JSONObject status = android.status();
                return textResult(status.toString(2), status);
            }
            case "android_snapshot": {
                requireScreenControl();
                JSONObject shot = android.screenshot(args);
                JSONArray content = new JSONArray()
                        .put(new JSONObject().put("type", "text").put("text", "Android screenshot " + shot.getInt("width") + "x" + shot.getInt("height")))
                        .put(new JSONObject().put("type", "image").put("data", shot.getString("data")).put("mimeType", shot.getString("mimeType")));
                return new JSONObject().put("content", content).put("structuredContent", new JSONObject()
                        .put("width", shot.getInt("width")).put("height", shot.getInt("height")).put("bytes", shot.getInt("bytes")));
            }
            case "android_action": {
                requireScreenControl();
                JSONObject result = android.input(args);
                return textResult("Android input completed.", result);
            }
            case "android_app": {
                requireAppManagement();
                JSONObject result = android.app(args);
                return textResult(result.optString("output", ""), result);
            }
            case "android_shell": {
                requireFullAccess();
                String command = args.getString("command");
                String cwd = args.optString("cwd", "/");
                int timeout = Math.max(1, Math.min(300, args.optInt("timeout", 30)));
                RootShell.Result result = rootShell.exec("cd " + ShellEscaper.quote(cwd) + " && " + command, timeout);
                JSONObject details = new JSONObject().put("exitCode", result.exitCode).put("output", result.outputText()).put("timedOut", result.timedOut);
                return textResult(result.outputText(), details);
            }
            case "open_workspace": {
                String path = PathGuard.normalizeAbsolute(args.getString("path"));
                JSONObject inspected = (JSONObject) files.dispatch("workspace.inspect", new JSONObject().put("path", path));
                String id = workspaceId(path);
                workspaces.put(id, path);
                inspected.put("workspaceId", id).put("backend", "android-local").put("accessMode", config.standaloneAccessMode());
                return textResult(inspected.toString(2), inspected);
            }
            case "stat": {
                String root = root(args.getString("workspaceId"));
                JSONObject result = (JSONObject) files.dispatch("fs.stat", new JSONObject().put("root", root)
                        .put("path", args.optString("path", ".")));
                return textResult(result.toString(2), result);
            }
            case "read": {
                String root = root(args.getString("workspaceId"));
                JSONObject result = (JSONObject) files.dispatch("fs.read", new JSONObject().put("root", root)
                        .put("path", args.getString("path")).put("offset", args.optInt("offset", 1)).put("limit", args.optInt("limit", 2000)));
                return textResult(result.toString(2), result);
            }
            case "ls":
            case "list_files": {
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("fs.list", new JSONObject().put("root", root).put("path", args.optString("path", ".")));
                return textResult(String.valueOf(result), result);
            }
            case "write":
            case "write_file": {
                requireFileWrite();
                String root = root(args.getString("workspaceId"));
                byte[] bytes = args.getString("content").getBytes(StandardCharsets.UTF_8);
                JSONObject result = files.fs().write(root, args.getString("path"), bytes, null);
                return textResult(result.toString(2), result);
            }
            case "edit": {
                requireFileWrite();
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("fs.edit", new JSONObject().put("root", root).put("path", args.getString("path"))
                        .put("edits", args.getJSONArray("edits")));
                return textResult(String.valueOf(result), result);
            }
            case "remove": {
                requireFileWrite();
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("fs.remove", new JSONObject().put("root", root).put("path", args.getString("path")));
                return textResult(String.valueOf(result), result);
            }
            case "rename": {
                requireFileWrite();
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("fs.rename", new JSONObject().put("root", root).put("path", args.getString("path"))
                        .put("destination", args.getString("destination")));
                return textResult(String.valueOf(result), result);
            }
            case "mkdir": {
                requireFileWrite();
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("fs.mkdir", new JSONObject().put("root", root).put("path", args.getString("path")));
                return textResult(String.valueOf(result), result);
            }
            case "grep": {
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("search.grep", new JSONObject().put("root", root).put("path", args.optString("path", "."))
                        .put("pattern", args.getString("pattern")).put("include", args.optString("include", "")));
                return textResult(String.valueOf(result), result);
            }
            case "glob": {
                String root = root(args.getString("workspaceId"));
                Object result = files.dispatch("search.glob", new JSONObject().put("root", root).put("path", args.optString("path", "."))
                        .put("pattern", args.getString("pattern")));
                return textResult(String.valueOf(result), result);
            }
            case "exec_command": {
                requireFullAccess();
                String root = root(args.getString("workspaceId"));
                String cwd = args.optString("workingDirectory", root);
                Object result = files.dispatch("shell.run", new JSONObject().put("root", root).put("cwd", cwd)
                        .put("command", args.getString("command")).put("timeout", args.optInt("timeout", 30)));
                return textResult(String.valueOf(result), result);
            }
            case "process_start": {
                requireFullAccess();
                String workspaceId = args.getString("workspaceId");
                String workspaceRoot = root(workspaceId);
                JSONObject params = new JSONObject(args.toString())
                        .put("root", workspaceRoot)
                        .put("workspaceId", workspaceId);
                JSONObject result = processes.start(params);
                return textResult(result.optString("output", ""), result);
            }
            case "write_stdin": {
                requireFullAccess();
                JSONObject result = processes.write(new JSONObject(args.toString()));
                return textResult(result.optString("output", ""), result);
            }
            case "process_list": {
                requireFullAccess();
                JSONArray result = processes.list(new JSONObject(args.toString()));
                return textResult(result.toString(2), result);
            }
            case "process_attach": {
                requireFullAccess();
                JSONObject result = processes.attach(new JSONObject(args.toString()));
                return textResult(result.optString("output", ""), result);
            }
            case "process_kill": {
                requireFullAccess();
                JSONObject result = processes.kill(new JSONObject(args.toString()));
                return textResult(result.optString("output", ""), result);
            }
            default: throw new UnsupportedOperationException("Unknown standalone Android MCP tool: " + name);
        }
    }

    private String root(String id) {
        String root = workspaces.get(id);
        if (root == null) throw new IllegalArgumentException("Unknown workspaceId; call open_workspace first");
        return root;
    }

    private void requireFullAccess() {
        if (!config.fullAccess()) throw new SecurityException("This tool requires Full Root Access to be enabled in DevSpace Mobile");
    }

    private void requireScreenControl() {
        if (!config.allowScreenControl()) {
            throw new SecurityException("Screen capture/input is disabled in DevSpace Mobile settings");
        }
    }

    private void requireAppManagement() {
        if (!config.allowAppManagement()) {
            throw new SecurityException("Android app management is disabled in DevSpace Mobile settings");
        }
    }

    private void requireFileWrite() {
        if (!config.allowFileWrite()) {
            throw new SecurityException("Structured file writes are disabled in DevSpace Mobile settings");
        }
    }

    private static JSONObject textResult(String text, Object structured) throws Exception {
        JSONObject result = new JSONObject().put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", text == null ? "" : text)));
        if (structured instanceof JSONObject) result.put("structuredContent", structured);
        else if (structured instanceof JSONArray) result.put("structuredContent", new JSONObject().put("items", structured));
        else result.put("structuredContent", new JSONObject().put("result", String.valueOf(structured)));
        return result;
    }

    private static JSONObject tool(String name, String description, JSONObject inputSchema) throws Exception {
        return new JSONObject().put("name", name).put("description", description).put("inputSchema", inputSchema);
    }
    private static JSONObject workspacePathSchema(boolean requirePath) throws Exception {
        JSONObject schema = objectSchema().put("properties", new JSONObject().put("workspaceId", stringSchema()).put("path", stringSchema()));
        JSONArray required = new JSONArray().put("workspaceId");
        if (requirePath) required.put("path");
        return schema.put("required", required);
    }
    private static JSONObject objectSchema() throws Exception { return new JSONObject().put("type", "object").put("additionalProperties", true); }
    private static JSONObject stringSchema() throws Exception { return new JSONObject().put("type", "string"); }
    private static JSONObject integerSchema(int min, int max) throws Exception { return new JSONObject().put("type", "integer").put("minimum", min).put("maximum", max); }
    private static JSONObject enumSchema(String... values) throws Exception { JSONArray a = new JSONArray(); for (String v : values) a.put(v); return new JSONObject().put("type", "string").put("enum", a); }
    private static String workspaceId(String path) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8));
        return "ws_" + Base64.encodeToString(hash, 0, 12, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    @Override public void close() {
        processes.close();
    }
}
