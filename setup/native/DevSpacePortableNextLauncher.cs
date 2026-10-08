using System;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class DevSpacePortableNextLauncher
{
    [STAThread]
    private static void Main()
    {
        var root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        var runtime = Path.Combine(root, "ui-next", "runtime", "electron.exe");
        var appDir = Path.Combine(root, "ui-next");
        var main = Path.Combine(appDir, "electron", "main.cjs");
        var ui = Path.Combine(appDir, "dist", "index.html");
        // Historical file-delta-v1 bridges only install the new launcher,
        // update manager and marker. Electron is deliberately absent until
        // the same-version full repair. Repair *before* checking Electron,
        // otherwise an old installation becomes stranded at this dialog.
        if (TryCompleteLegacyUpgrade(root)) return;
        if (!File.Exists(runtime) || !File.Exists(main) || !File.Exists(ui))
        {
            MessageBox.Show(
                "DevSpace Portable 的 Electron 界面或运行时缺失。\n"
                + "请重新提取完整安装包，原始桌面界面已不再随包分发。",
                "DevSpace Portable", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        try
        {
            var process = new ProcessStartInfo(runtime)
            {
                Arguments = "\"" + appDir.Replace("\"", "\"\"") + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = false,
            };
            process.EnvironmentVariables["DEVSPACE_PORTABLE_ROOT"] = root;
            Process.Start(process);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "无法启动 DevSpace 桌面界面：" + error.Message + "\n请检查完整安装包与安全软件日志。",
                "DevSpace Portable", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static bool TryCompleteLegacyUpgrade(string root)
    {
        var marker = Path.Combine(root, "setup", "legacy-upgrade-bootstrap.json");
        if (!File.Exists(marker)) return false;
        try
        {
            var staged = RunManager(root, "update-stage-force-full", null);
            object value;
            var stagingPath = staged.TryGetValue("stagingPath", out value) ? Convert.ToString(value) : "";
            if (String.IsNullOrWhiteSpace(stagingPath))
                throw new InvalidOperationException("完整安装包下载/校验失败，暂不能完成引导。请检查网络后重新打开程序。");
            var launched = RunManager(root, "update-launch", new Dictionary<string, object>
            {
                { "stagingPath", stagingPath },
                { "uiPid", Process.GetCurrentProcess().Id },
            });
            if (!launched.TryGetValue("launched", out value) || !Convert.ToBoolean(value))
                throw new InvalidOperationException("完整安装阶段未能启动。");
            // The detached updater must wait for this launcher to exit before
            // replacing the shallow bridge with the full Electron payload.
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "检测到旧版本升级引导尚未完成。程序已尝试继续下载并安装完整发行包，但未成功。\n\n"
                + "原有数据不应删除。请检查网络及 Windows 进程枚举功能，"
                + "或备份旧版 data 文件夹后使用完整安装包修复。\n\n"
                + error.Message,
                "DevSpace Portable · 兼容更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return true;
    }

    private static Dictionary<string, object> RunManager(string root, string action, object payload)
    {
        var node = Path.Combine(root, "runtime", "node", "node.exe");
        var manager = Path.Combine(root, "setup", "portable-manager.cjs");
        if (!File.Exists(node) || !File.Exists(manager))
            throw new FileNotFoundException("旧版安装中缺少更新管理器或 Node 运行时。");
        var json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
        var info = new ProcessStartInfo(node)
        {
            Arguments = "\"" + manager.Replace("\"", "\\\"") + "\" " + action,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.EnvironmentVariables["DEVSPACE_PORTABLE_ROOT"] = root;
        info.EnvironmentVariables["DEVSPACE_NATIVE_UI_PID"] = Process.GetCurrentProcess().Id.ToString();
        using (var process = Process.Start(info))
        {
            if (payload != null) process.StandardInput.Write(json.Serialize(payload));
            process.StandardInput.Close();
            var output = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0)
                throw new InvalidOperationException(String.IsNullOrWhiteSpace(stderr) ? output : stderr);
            var parsed = json.DeserializeObject(String.IsNullOrWhiteSpace(output) ? "{}" : output);
            return parsed as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
    }
}
