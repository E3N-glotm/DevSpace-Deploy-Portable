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
                "DevSpace Portable Next 的界面或 Electron 运行时缺失。\n"
                + "旧版 DevSpace-Portable.exe 仍可正常使用，请重新提取完整 dev3 开发包。",
                "DevSpace Portable Next", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                "无法启动新版界面：" + error.Message + "\n\n可继续使用旧版 DevSpace-Portable.exe。",
                "DevSpace Portable Next", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
