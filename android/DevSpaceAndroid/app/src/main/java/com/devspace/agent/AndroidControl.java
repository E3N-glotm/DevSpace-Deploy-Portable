package com.devspace.agent;

import android.app.ActivityManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

final class AndroidControl {
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9._]*");
    private static final Pattern COMPONENT = Pattern.compile("[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+|[A-Za-z0-9_.$]+/\\.[A-Za-z0-9_.$]+");
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_]+|[0-9]+");
    private static final int MAX_SCREENSHOT_RAW = 32 * 1024 * 1024;
    private static final int MAX_SCREENSHOT_RPC_BYTES = 5 * 1024 * 1024;

    private final Context context;
    private final RootShell shell;
    private final AgentConfig config;

    AndroidControl(Context context, RootShell shell, AgentConfig config) {
        this.context = context.getApplicationContext();
        this.shell = shell;
        this.config = config;
    }

    JSONObject status() throws Exception {
        boolean root = shell.isRootAvailable();
        BatteryManager battery = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        int batteryPercent = battery == null ? -1 : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager != null) {
            if (Build.VERSION.SDK_INT >= 30) {
                android.view.WindowMetrics wm = windowManager.getCurrentWindowMetrics();
                metrics.widthPixels = wm.getBounds().width();
                metrics.heightPixels = wm.getBounds().height();
                metrics.densityDpi = context.getResources().getDisplayMetrics().densityDpi;
            } else {
                //noinspection deprecation
                windowManager.getDefaultDisplay().getRealMetrics(metrics);
            }
        }
        StatFs data = new StatFs(Environment.getDataDirectory().getAbsolutePath());
        JSONObject storage = new JSONObject()
                .put("dataTotalBytes", data.getTotalBytes())
                .put("dataFreeBytes", data.getAvailableBytes());
        JSONObject display = new JSONObject()
                .put("width", metrics.widthPixels)
                .put("height", metrics.heightPixels)
                .put("densityDpi", metrics.densityDpi);
        return new JSONObject()
                .put("root", root)
                .put("manufacturer", Build.MANUFACTURER)
                .put("brand", Build.BRAND)
                .put("model", Build.MODEL)
                .put("device", Build.DEVICE)
                .put("androidVersion", Build.VERSION.RELEASE)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "unknown")
                .put("batteryPercent", batteryPercent)
                .put("display", display)
                .put("storage", storage)
                .put("accessMode", config.standaloneAccessMode())
                .put("publicBaseUrl", config.publicBaseUrl())
                .put("localMcp", "http://127.0.0.1:" + config.localPort() + "/mcp");
    }

    JSONObject screenshot(JSONObject params) throws Exception {
        requireRoot();
        RootShell.Result capture = shell.exec("screencap -p", null, 30, MAX_SCREENSHOT_RAW);
        if (capture.exitCode != 0 || capture.stdout.length == 0) {
            throw new IOException("screencap failed: " + capture.outputText().trim());
        }
        Bitmap bitmap = BitmapFactory.decodeByteArray(capture.stdout, 0, capture.stdout.length);
        if (bitmap == null) throw new IOException("Unable to decode screencap PNG.");
        int maxWidth = Math.max(320, Math.min(4096, params.optInt("maxWidth", 1440)));
        if (bitmap.getWidth() > maxWidth) {
            int height = Math.max(1, Math.round(bitmap.getHeight() * (maxWidth / (float) bitmap.getWidth())));
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, maxWidth, height, true);
            if (scaled != bitmap) bitmap.recycle();
            bitmap = scaled;
        }
        String format = params.optString("format", "jpeg").toLowerCase(Locale.ROOT);
        int quality = Math.max(30, Math.min(100, params.optInt("quality", 80)));
        Bitmap.CompressFormat compressFormat = "png".equals(format) ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG;
        String mimeType = "png".equals(format) ? "image/png" : "image/jpeg";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!bitmap.compress(compressFormat, quality, output)) {
            bitmap.recycle();
            throw new IOException("Unable to compress Android screenshot.");
        }
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        bitmap.recycle();
        byte[] bytes = output.toByteArray();
        if (bytes.length > MAX_SCREENSHOT_RPC_BYTES) {
            throw new IOException("Screenshot exceeds bounded RPC payload; use JPEG or a smaller maxWidth.");
        }
        return new JSONObject()
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("mimeType", mimeType)
                .put("width", width)
                .put("height", height)
                .put("bytes", bytes.length);
    }

    JSONObject input(JSONObject params) throws Exception {
        requireRoot();
        long started = System.nanoTime();
        JSONArray results = new JSONArray();
        JSONArray steps = params.optJSONArray("steps");
        if (steps != null) {
            if (steps.length() < 1 || steps.length() > 50) throw new IllegalArgumentException("Android input steps must contain 1 to 50 actions.");
            StringBuilder batch = new StringBuilder("set -e; ");
            for (int i = 0; i < steps.length(); i++) {
                JSONObject step = steps.getJSONObject(i);
                if (i > 0) batch.append("; ");
                batch.append(commandForStep(step));
                results.put(new JSONObject().put("action", step.getString("action")).put("exitCode", 0));
            }
            RootShell.Result result = shell.exec(batch.toString(), null, 60, 512 * 1024);
            if (result.exitCode != 0) throw new IOException("Android input batch failed: " + result.outputText().trim());
        } else {
            if (!params.has("action")) throw new IllegalArgumentException("Android input requires action or steps.");
            results.put(executeStep(params));
        }
        return new JSONObject().put("steps", results).put("elapsedMs", elapsedMs(started));
    }

    JSONObject app(JSONObject params) throws Exception {
        requireRoot();
        String action = params.getString("action");
        String packageName = params.optString("package", "");
        String component = params.optString("component", "");
        String path = params.optString("path", "");
        String command;
        switch (action) {
            case "list":
                command = "pm list packages";
                break;
            case "info":
                requirePackage(packageName);
                command = "dumpsys package " + ShellEscaper.quote(packageName);
                break;
            case "start":
                requirePackage(packageName);
                if (!component.isEmpty()) {
                    if (!COMPONENT.matcher(component).matches()) throw new IllegalArgumentException("Invalid Android component.");
                    command = "am start -n " + ShellEscaper.quote(component);
                } else {
                    command = "monkey -p " + ShellEscaper.quote(packageName) + " -c android.intent.category.LAUNCHER 1";
                }
                break;
            case "stop":
                requirePackage(packageName);
                command = "am force-stop " + ShellEscaper.quote(packageName);
                break;
            case "clear":
                requirePackage(packageName);
                command = "pm clear " + ShellEscaper.quote(packageName);
                break;
            case "install":
                if (path.isEmpty() || !path.startsWith("/")) throw new IllegalArgumentException("install requires an absolute APK path.");
                command = "pm install -r --user 0 " + ShellEscaper.quote(path);
                break;
            case "uninstall":
                requirePackage(packageName);
                command = "pm uninstall --user 0 " + ShellEscaper.quote(packageName);
                break;
            default:
                throw new IllegalArgumentException("Unsupported Android app action: " + action);
        }
        RootShell.Result result = shell.exec(command, null, "install".equals(action) ? 150 : 45, 4 * 1024 * 1024);
        return new JSONObject().put("exitCode", result.exitCode).put("output", result.outputText());
    }

    JSONObject systemStatus() throws Exception {
        JSONObject status = status();
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memory);
            status.put("memory", new JSONObject()
                    .put("totalBytes", memory.totalMem)
                    .put("availableBytes", memory.availMem)
                    .put("lowMemory", memory.lowMemory));
        }
        status.put("gpus", new JSONArray());
        return status;
    }

    private JSONObject executeStep(JSONObject step) throws Exception {
        String action = step.getString("action");
        long started = System.nanoTime();
        String command = commandForStep(step);
        RootShell.Result result = shell.exec(command, null, 30, 256 * 1024);
        if (result.exitCode != 0) throw new IOException("Android input failed: " + result.outputText().trim());
        return new JSONObject().put("action", action).put("exitCode", result.exitCode).put("elapsedMs", elapsedMs(started));
    }

    private String commandForStep(JSONObject step) {
        String action = step.optString("action", "");
        switch (action) {
            case "tap":
                return "input tap " + coordinate(step, "x") + " " + coordinate(step, "y");
            case "swipe":
                int duration = Math.max(0, Math.min(30_000, step.optInt("durationMs", 300)));
                return "input swipe " + coordinate(step, "x1") + " " + coordinate(step, "y1") + " "
                        + coordinate(step, "x2") + " " + coordinate(step, "y2") + " " + duration;
            case "text": {
                String text = step.optString("text", "");
                if (text.length() > 80_000) throw new IllegalArgumentException("Android input text is too long.");
                return "input text " + ShellEscaper.quote(encodeInputText(text));
            }
            case "key": {
                String key = step.optString("key", "").trim();
                if (!KEY.matcher(key).matches()) throw new IllegalArgumentException("Invalid Android keyevent.");
                return "input keyevent " + key;
            }
            case "back":
                return "input keyevent KEYCODE_BACK";
            case "home":
                return "input keyevent KEYCODE_HOME";
            case "sleep": {
                long delay = Math.max(0, Math.min(30_000, step.optLong("durationMs", 0)));
                return String.format(Locale.ROOT, "sleep %.3f", delay / 1000.0);
            }
            default:
                throw new IllegalArgumentException("Unsupported Android input action: " + action);
        }
    }

    private static int coordinate(JSONObject value, String name) {
        if (!value.has(name)) throw new IllegalArgumentException("Android input missing coordinate: " + name);
        int result = value.optInt(name, Integer.MIN_VALUE);
        if (result < 0 || result > 32767) throw new IllegalArgumentException("Android coordinate is out of range: " + name);
        return result;
    }

    private static String encodeInputText(String text) {
        // Android's `input text` uses %s for spaces. Escape percent first so a
        // literal % does not become part of an accidental formatting sequence.
        return text.replace("%", "%25").replace(" ", "%s");
    }

    private void requireRoot() {
        if (config.rootGranted()) return;
        if (!shell.isRootAvailable()) throw new SecurityException("Root permission is not granted to DevSpace Android.");
        config.runtimeState(config.lastState(), config.lastError(), true);
    }

    private static void requirePackage(String packageName) {
        if (packageName.isEmpty() || !PACKAGE.matcher(packageName).matches()) throw new IllegalArgumentException("A valid Android package name is required.");
    }

    private static long elapsedMs(long started) { return Math.max(0, (System.nanoTime() - started) / 1_000_000L); }
}
