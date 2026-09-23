using System;
using System.Diagnostics;
using System.IO;
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
}
