using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DevSpacePortableUpdater
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Dictionary<string, string> options = ParseArguments(args);
            string selfTest;
            if (options.TryGetValue("self-test", out selfTest))
            {
                var report = new Dictionary<string, object>
                {
                    ["standaloneUpdater"] = true,
                    ["mainUiOnlyLaunchesUpdater"] = true,
                    ["tempApplyController"] = true,
                    ["scheduledTaskRequired"] = false,
                    ["progressPolling"] = true,
                    ["validatedUiTermination"] = true,
                    ["transactionalPowerShellBackend"] = true,
                };
                File.WriteAllText(selfTest, new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool applyHelper = options.ContainsKey("apply-helper");
            Mutex singleInstance = null;
            if (!applyHelper)
            {
                bool created;
                singleInstance = new Mutex(true, "Local\\DevSpacePortableStandaloneUpdater", out created);
                if (!created)
                {
                    MessageBox.Show("DevSpace Update 已经在运行。", "DevSpace Update", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
            }
            try
            {
                Application.Run(new UpdateForm(options, applyHelper));
                return 0;
            }
            finally
            {
                if (singleInstance != null)
                {
                    try { singleInstance.ReleaseMutex(); } catch { }
                    singleInstance.Dispose();
                }
            }
        }

        internal static Dictionary<string, string> ParseArguments(string[] args)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < args.Length; i++)
            {
                string item = args[i] ?? "";
                if (!item.StartsWith("--", StringComparison.Ordinal)) continue;
                string key = item.Substring(2);
                if (i + 1 < args.Length && !(args[i + 1] ?? "").StartsWith("--", StringComparison.Ordinal))
                    result[key] = args[++i];
                else
                    result[key] = "true";
            }
            return result;
        }
    }

    internal sealed class UpdateForm : Form
    {
        private const string DefaultRepository = "E3N-glotm/DevSpace-Deploy-Portable";
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly Dictionary<string, string> _options;
        private readonly bool _applyHelper;
        private readonly string _root;
        private readonly string _repository;
        private readonly string _currentVersion;
        private readonly int _parentUiPid;
        private readonly Label _title = new Label();
        private readonly Label _summary = new Label();
        private readonly Label _detail = new Label();
        private readonly ProgressBar _progress = new ProgressBar();
        private readonly RichTextBox _log = new RichTextBox();
        private readonly Button _checkButton = new Button();
        private readonly Button _installButton = new Button();
        private readonly Button _closeButton = new Button();
        private readonly System.Windows.Forms.Timer _progressTimer = new System.Windows.Forms.Timer();
        private Dictionary<string, object> _lastCheck = new Dictionary<string, object>();
        private string _stagingPath = "";
        private string _targetVersion = "";
        private bool _busy;
        private bool _handoffToApply;
        private bool _allowBusyClose;

        public UpdateForm(Dictionary<string, string> options, bool applyHelper)
        {
            _options = options;
            _applyHelper = applyHelper;
            _root = ResolveRoot(options);
            _repository = GetOption(options, "repository", DefaultRepository);
            _currentVersion = GetOption(options, "current", ReadPortableVersion(_root));
            _parentUiPid = ParseInt(GetOption(options, "parent-ui", "0"));
            if (!applyHelper) CleanupOldTemporaryControllers();

            Text = applyHelper ? "DevSpace Update · 正在安装" : "DevSpace Update";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(760, 590);
            MinimumSize = new Size(680, 520);
            BackColor = Color.FromArgb(246, 248, 252);
            Font = new Font("Segoe UI", 9.5F, FontStyle.Regular, GraphicsUnit.Point);
            BuildUi();
            _progressTimer.Interval = 500;
            _progressTimer.Tick += delegate { RenderProgressFile(); };
            Shown += async delegate
            {
                if (_applyHelper) await ApplyFromTemporaryControllerAsync();
                else await CheckAsync();
            };
        }

        private void BuildUi()
        {
            var shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 7,
                Padding = new Padding(24),
                BackColor = BackColor,
            };
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 18));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));

            _title.Text = _applyHelper ? "正在应用 DevSpace Portable 更新" : "DevSpace Portable 更新";
            _title.Dock = DockStyle.Fill;
            _title.Font = new Font(Font.FontFamily, 18F, FontStyle.Bold);
            _title.ForeColor = Color.FromArgb(27, 35, 52);
            _title.TextAlign = ContentAlignment.MiddleLeft;

            _summary.Text = _applyHelper ? "独立更新控制器已接管。" : "正在检查 GitHub 稳定版……";
            _summary.Dock = DockStyle.Fill;
            _summary.Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold);
            _summary.ForeColor = Color.FromArgb(57, 69, 92);
            _summary.TextAlign = ContentAlignment.MiddleLeft;

            _detail.Text = "当前版本：" + _currentVersion;
            _detail.Dock = DockStyle.Fill;
            _detail.ForeColor = Color.FromArgb(100, 112, 135);
            _detail.TextAlign = ContentAlignment.MiddleLeft;

            _progress.Dock = DockStyle.Fill;
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Minimum = 0;
            _progress.Maximum = 1000;
            _progress.Value = 0;
            _progress.Margin = new Padding(0, 8, 0, 8);

            _log.Dock = DockStyle.Fill;
            _log.ReadOnly = true;
            _log.BackColor = Color.White;
            _log.ForeColor = Color.FromArgb(48, 58, 76);
            _log.BorderStyle = BorderStyle.FixedSingle;
            _log.Font = new Font("Cascadia Mono", 9F, FontStyle.Regular, GraphicsUnit.Point);

            var buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                BackColor = Color.Transparent,
            };
            ConfigureButton(_closeButton, "关闭", false);
            ConfigureButton(_installButton, "下载并安装", true);
            ConfigureButton(_checkButton, "重新检查", false);
            _installButton.Enabled = false;
            _checkButton.Click += async delegate { await CheckAsync(); };
            _installButton.Click += async delegate { await StageAndInstallAsync(); };
            _closeButton.Click += delegate { if (!_busy) Close(); };
            buttons.Controls.Add(_closeButton);
            buttons.Controls.Add(_installButton);
            buttons.Controls.Add(_checkButton);
            if (_applyHelper)
            {
                _checkButton.Visible = false;
                _installButton.Visible = false;
                _closeButton.Enabled = false;
            }

            shell.Controls.Add(_title, 0, 0);
            shell.Controls.Add(_summary, 0, 1);
            shell.Controls.Add(_progress, 0, 2);
            shell.Controls.Add(_detail, 0, 3);
            shell.Controls.Add(_log, 0, 4);
            shell.Controls.Add(new Label { Text = "", Dock = DockStyle.Fill }, 0, 5);
            shell.Controls.Add(buttons, 0, 6);
            Controls.Add(shell);
        }

        private static void ConfigureButton(Button button, string text, bool primary)
        {
            button.Text = text;
            button.AutoSize = true;
            button.MinimumSize = new Size(116, 36);
            button.Margin = new Padding(8, 4, 0, 4);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            if (primary)
            {
                button.BackColor = Color.FromArgb(72, 88, 245);
                button.ForeColor = Color.White;
                button.FlatAppearance.BorderColor = Color.FromArgb(72, 88, 245);
            }
            else
            {
                button.BackColor = Color.White;
                button.ForeColor = Color.FromArgb(48, 58, 76);
                button.FlatAppearance.BorderColor = Color.FromArgb(214, 220, 232);
            }
        }

        private async Task CheckAsync()
        {
            if (_busy) return;
            if (Directory.Exists(Path.Combine(_root, ".git")))
            {
                _summary.Text = "源码工作区不执行在线覆盖更新";
                _detail.Text = "请在正式 Release 解压目录运行 Update.exe。";
                _installButton.Enabled = false;
                return;
            }
            SetBusy(true);
            try
            {
                _summary.Text = "正在检查 GitHub 稳定版……";
                _detail.Text = "当前版本：" + _currentVersion;
                AppendLog("检查更新：" + _currentVersion);
                BackendResult backend = await RunPortableUpdaterAsync("Check", new string[0], 120000, false);
                _lastCheck = ParseLastJsonObject(backend.Output);
                string latest = GetString(_lastCheck, "latestVersion", _currentVersion);
                _targetVersion = latest;
                bool available = GetBool(_lastCheck, "updateAvailable");
                if (!available)
                {
                    _summary.Text = "当前已是最新稳定版";
                    _detail.Text = "当前版本：" + _currentVersion + " · GitHub 最新版本：" + latest;
                    _installButton.Enabled = false;
                    _progress.Value = 1000;
                    return;
                }

                string mode = GetString(_lastCheck, "preferredMode", "full");
                long fullSize = GetLong(_lastCheck, "fullAssetSize", GetLong(_lastCheck, "assetSize", 0));
                long incrementalSize = GetLong(_lastCheck, "incrementalAssetSize", 0);
                bool incremental = string.Equals(mode, "incremental", StringComparison.OrdinalIgnoreCase) && incrementalSize > 0;
                _summary.Text = "发现 DevSpace Portable " + latest;
                _detail.Text = "首选：" + (incremental ? "增量更新" : "完整包")
                    + " · 预计下载 " + FormatBytes(incremental ? incrementalSize : fullSize)
                    + (incremental ? " · 完整包兜底 " + FormatBytes(fullSize) : "");
                _installButton.Text = "下载并安装 " + latest;
                _installButton.Enabled = true;
                _progress.Value = 0;
            }
            catch (Exception ex)
            {
                ShowFailure("检查更新失败", ex);
            }
            finally { SetBusy(false); }
        }

        private async Task StageAndInstallAsync()
        {
            if (_busy || string.IsNullOrWhiteSpace(_targetVersion)) return;
            if (MessageBox.Show(this,
                "独立 Update.exe 将负责下载、校验和安装。主程序只会在真正开始替换文件时关闭。\r\n\r\n继续更新到 " + _targetVersion + " 吗？",
                "安装 " + _targetVersion,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question) != DialogResult.Yes) return;

            SetBusy(true);
            try
            {
                AppendLog("开始暂存更新 " + _targetVersion + "。主程序和服务在下载阶段保持运行。");
                _progressTimer.Start();
                BackendResult backend = await RunPortableUpdaterAsync("Stage", new string[0], 3900000, true);
                _progressTimer.Stop();
                RenderProgressFile();
                Dictionary<string, object> staged = ParseLastJsonObject(backend.Output);
                if (!GetBool(staged, "staged"))
                {
                    _summary.Text = "没有需要安装的更新";
                    return;
                }
                _stagingPath = GetString(staged, "stagingPath", "");
                string actualMode = GetString(staged, "updateMode", "full");
                string fallbackReason = GetString(staged, "fallbackReason", "");
                _summary.Text = "更新包已下载并校验";
                _detail.Text = "实际方式：" + (actualMode == "incremental" ? "增量更新" : "完整包更新")
                    + (string.IsNullOrWhiteSpace(fallbackReason) ? "" : " · 兜底原因：" + fallbackReason);
                AppendLog("暂存完成：" + _stagingPath);

                if (MessageBox.Show(this,
                    "更新包已经完成下载与校验。\r\n\r\n现在由独立更新控制器关闭 DevSpace 控制中心、停止 Portable 自有服务并执行事务更新吗？",
                    "准备安装 " + _targetVersion,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes)
                {
                    _summary.Text = "更新包已暂存，尚未安装";
                    return;
                }
                LaunchTemporaryApplyController();
                _handoffToApply = true;
                Close();
            }
            catch (Exception ex)
            {
                _progressTimer.Stop();
                ShowFailure("更新准备失败", ex);
            }
            finally { SetBusy(false); }
        }

        private void LaunchTemporaryApplyController()
        {
            string tempRoot = Path.Combine(Path.GetTempPath(), "DevSpacePortableUpdater", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            string tempExe = Path.Combine(tempRoot, "Update.exe");
            File.Copy(Application.ExecutablePath, tempExe, true);
            var arguments = new List<string>
            {
                "--apply-helper",
                "--root", _root,
                "--repository", _repository,
                "--current", _currentVersion,
                "--target", _targetVersion,
                "--staging", _stagingPath,
                "--parent-ui", _parentUiPid.ToString(),
                "--source-updater-pid", Process.GetCurrentProcess().Id.ToString(),
            };
            Process.Start(new ProcessStartInfo
            {
                FileName = tempExe,
                Arguments = JoinArguments(arguments),
                WorkingDirectory = tempRoot,
                UseShellExecute = false,
            });
        }

        private async Task ApplyFromTemporaryControllerAsync()
        {
            _busy = true;
            _closeButton.Enabled = false;
            try
            {
                string staging = GetOption(_options, "staging", "");
                string target = GetOption(_options, "target", "");
                int sourceUpdaterPid = ParseInt(GetOption(_options, "source-updater-pid", "0"));
                ValidateStagingPath(staging);
                _targetVersion = target;
                _summary.Text = "独立更新控制器已接管 " + _currentVersion + " → " + target;
                _detail.Text = "更新器运行于系统临时目录，不占用 Portable 根目录中的 Update.exe。";
                AppendLog("等待主 Update.exe 退出……");
                await WaitForProcessExitAsync(sourceUpdaterPid, 15000);

                AppendLog("正在关闭 DevSpace 控制中心……");
                await CloseValidatedParentUiAsync(_parentUiPid);

                string stagedUpdater = Path.Combine(staging, "portable-updater.ps1");
                if (!File.Exists(stagedUpdater)) throw new InvalidOperationException("暂存目录缺少 portable-updater.ps1。");
                _progressTimer.Start();
                BackendResult result = await RunPowerShellAsync(stagedUpdater, "Apply", new[]
                {
                    "-StagingPath", staging,
                    "-UiPid", "0",
                }, 3900000);
                _progressTimer.Stop();
                RenderProgressFile();
                Dictionary<string, object> applied = ParseLastJsonObject(result.Output);
                if (!GetBool(applied, "success")) throw new InvalidOperationException("更新控制器没有返回成功结果。");
                _summary.Text = "DevSpace Portable " + target + " 更新完成";
                _detail.Text = "实际更新方式：" + GetString(applied, "updateMode", "unknown") + " · 新控制中心已启动。";
                _progress.Value = 1000;
                AppendLog("更新完成。临时 Update.exe 即将退出。");
                await Task.Delay(2200);
                _allowBusyClose = true;
                Close();
            }
            catch (Exception ex)
            {
                _progressTimer.Stop();
                ShowFailure("安装失败", ex);
                _closeButton.Enabled = true;
            }
            finally { _busy = false; }
        }

        private void ValidateStagingPath(string staging)
        {
            if (string.IsNullOrWhiteSpace(staging)) throw new InvalidOperationException("缺少 staging 路径。");
            string full = Path.GetFullPath(staging).TrimEnd(Path.DirectorySeparatorChar);
            string allowed = Path.Combine(_root, ".update-staging") + Path.DirectorySeparatorChar;
            if (!full.StartsWith(allowed, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("staging 路径不属于当前 Portable。");
            if (!File.Exists(Path.Combine(full, "stage-info.json")))
                throw new InvalidOperationException("staging 元数据不存在。");
        }

        private async Task CloseValidatedParentUiAsync(int pid)
        {
            if (pid <= 0) return;
            await Task.Run(() =>
            {
                Process process;
                try { process = Process.GetProcessById(pid); }
                catch { return; }
                using (process)
                {
                    string expected = Path.GetFullPath(Path.Combine(_root, "DevSpace-Portable.exe"));
                    string actual;
                    try { actual = Path.GetFullPath(process.MainModule.FileName); }
                    catch (Exception ex) { throw new InvalidOperationException("无法验证 DevSpace 控制中心 PID，拒绝结束未知进程。", ex); }
                    if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("parent-ui PID 已被其他程序复用，拒绝结束未知进程。");
                    try { process.CloseMainWindow(); } catch { }
                    if (process.WaitForExit(3500)) return;
                    process.Kill();
                    if (!process.WaitForExit(7000)) throw new InvalidOperationException("DevSpace 控制中心没有在更新前退出。");
                }
            });
        }

        private static Task WaitForProcessExitAsync(int pid, int timeoutMs)
        {
            if (pid <= 0) return Task.FromResult(0);
            return Task.Run(() =>
            {
                try
                {
                    using (Process process = Process.GetProcessById(pid))
                    {
                        if (!process.WaitForExit(timeoutMs))
                            throw new InvalidOperationException("原 Update.exe 没有按时退出，安装未开始。");
                    }
                }
                catch (ArgumentException) { }
            });
        }

        private Task<BackendResult> RunPortableUpdaterAsync(string action, string[] extra, int timeoutMs, bool stage)
        {
            string script = Path.Combine(_root, "setup", "portable-updater.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Portable updater backend is missing.", script);
            return RunPowerShellAsync(script, action, extra, timeoutMs);
        }

        private Task<BackendResult> RunPowerShellAsync(string script, string action, string[] extra, int timeoutMs)
        {
            return Task.Run(() =>
            {
                string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
                var args = new List<string>
                {
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", script,
                    "-Action", action,
                    "-Root", _root,
                    "-Repository", _repository,
                    "-CurrentVersion", _currentVersion,
                };
                if (extra != null) args.AddRange(extra);
                var psi = new ProcessStartInfo
                {
                    FileName = powershell,
                    Arguments = JoinArguments(args),
                    WorkingDirectory = _root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                psi.EnvironmentVariables["DEVSPACE_WINDOWS_TEXT_ENCODING"] = "utf-8";
                using (var process = new Process { StartInfo = psi })
                {
                    if (!process.Start()) throw new InvalidOperationException("无法启动 Portable updater backend。");
                    Task<string> stdout = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(timeoutMs))
                    {
                        try { process.Kill(); } catch { }
                        throw new TimeoutException("更新后端执行超时。");
                    }
                    Task.WaitAll(stdout, stderr);
                    string output = (stdout.Result + "\n" + stderr.Result).Trim();
                    if (process.ExitCode != 0)
                        throw new InvalidOperationException("更新后端失败 (" + process.ExitCode + ")：" + LastUsefulLine(output));
                    return new BackendResult { ExitCode = process.ExitCode, Output = output };
                }
            });
        }

        private void RenderProgressFile()
        {
            try
            {
                string file = Path.Combine(_root, "data", "state", "update-progress.json");
                if (!File.Exists(file)) return;
                object raw = _json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8));
                Dictionary<string, object> progress = raw as Dictionary<string, object>;
                if (progress == null) return;
                string phase = GetString(progress, "phase", "working");
                string message = GetString(progress, "message", "正在处理更新");
                double percent = GetDouble(progress, "percent", 0);
                _progress.Value = Math.Max(0, Math.Min(1000, (int)Math.Round(percent * 10)));
                _summary.Text = PhaseTitle(phase);
                long received = GetLong(progress, "bytesReceived", 0);
                long total = GetLong(progress, "bytesTotal", 0);
                long speed = GetLong(progress, "speedBytesPerSecond", 0);
                string transport = GetString(progress, "transport", "");
                var detail = new StringBuilder();
                if (total > 0) detail.Append(percent.ToString("0.0")).Append("% · ").Append(FormatBytes(received)).Append(" / ").Append(FormatBytes(total));
                if (speed > 0) detail.Append(" · ").Append(FormatBytes(speed)).Append("/s");
                if (!string.IsNullOrWhiteSpace(transport)) detail.Append(" · ").Append(transport);
                if (detail.Length == 0) detail.Append(message);
                _detail.Text = detail.ToString();
            }
            catch { }
        }

        private static string PhaseTitle(string phase)
        {
            switch ((phase ?? "").ToLowerInvariant())
            {
                case "metadata": return "正在读取 GitHub Release";
                case "downloading": return "正在下载更新包";
                case "downloaded": return "更新包下载完成";
                case "verifying": return "正在校验 SHA-256";
                case "extracting": return "正在安全解压并验证";
                case "fallback": return "正在切换完整包兜底";
                case "staged": return "更新包已暂存";
                case "apply-started": return "独立更新控制器已接管";
                case "applying": return "正在应用更新";
                case "rollback": return "更新失败，正在回滚";
                case "completed": return "更新完成";
                case "error": return "更新失败";
                default: return "正在处理更新";
            }
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _checkButton.Enabled = !busy;
            _installButton.Enabled = !busy && _lastCheck.Count > 0 && GetBool(_lastCheck, "updateAvailable");
            _closeButton.Enabled = !busy;
            UseWaitCursor = busy;
        }

        private void ShowFailure(string title, Exception ex)
        {
            _summary.Text = title;
            _detail.Text = ex.Message;
            AppendLog(title + "：" + ex);
            MessageBox.Show(this, ex.Message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private void AppendLog(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            _log.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text.Trim() + Environment.NewLine);
            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }

        private Dictionary<string, object> ParseLastJsonObject(string output)
        {
            string[] lines = (output ?? "").Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string line = lines[i].Trim();
                if (!line.StartsWith("{", StringComparison.Ordinal) || !line.EndsWith("}", StringComparison.Ordinal)) continue;
                object parsed = _json.DeserializeObject(line);
                Dictionary<string, object> value = parsed as Dictionary<string, object>;
                if (value != null) return value;
            }
            throw new InvalidOperationException("更新后端没有返回有效 JSON：" + LastUsefulLine(output));
        }

        private static string ResolveRoot(Dictionary<string, string> options)
        {
            string configured = GetOption(options, "root", "");
            string root = string.IsNullOrWhiteSpace(configured) ? AppDomain.CurrentDomain.BaseDirectory : configured;
            return Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static void CleanupOldTemporaryControllers()
        {
            try
            {
                string parent = Path.Combine(Path.GetTempPath(), "DevSpacePortableUpdater");
                if (!Directory.Exists(parent)) return;
                foreach (string directory in Directory.GetDirectories(parent))
                {
                    try
                    {
                        if (Directory.GetLastWriteTimeUtc(directory) < DateTime.UtcNow.AddDays(-1))
                            Directory.Delete(directory, true);
                    }
                    catch { }
                }
            }
            catch { }
        }

        private static string ReadPortableVersion(string root)
        {
            try
            {
                string file = Path.Combine(root, "VERSION-MANIFEST.json");
                if (!File.Exists(file)) return "0.0.0";
                object parsed = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file, Encoding.UTF8));
                Dictionary<string, object> manifest = parsed as Dictionary<string, object>;
                if (manifest == null) return "0.0.0";
                Dictionary<string, object> runtime;
                object runtimeRaw;
                if (manifest.TryGetValue("runtime", out runtimeRaw) && (runtime = runtimeRaw as Dictionary<string, object>) != null)
                    return GetString(runtime, "devspacePortable", "0.0.0");
            }
            catch { }
            return "0.0.0";
        }

        private static string GetOption(Dictionary<string, string> options, string key, string fallback)
        {
            string value;
            return options.TryGetValue(key, out value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;
        }

        private static int ParseInt(string value)
        {
            int result;
            return int.TryParse(value, out result) ? result : 0;
        }

        private static string GetString(Dictionary<string, object> value, string key, string fallback)
        {
            object raw;
            return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : fallback;
        }

        private static bool GetBool(Dictionary<string, object> value, string key)
        {
            object raw;
            if (value == null || !value.TryGetValue(key, out raw) || raw == null) return false;
            try { return Convert.ToBoolean(raw); } catch { return false; }
        }

        private static long GetLong(Dictionary<string, object> value, string key, long fallback)
        {
            object raw;
            if (value == null || !value.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToInt64(raw); } catch { return fallback; }
        }

        private static double GetDouble(Dictionary<string, object> value, string key, double fallback)
        {
            object raw;
            if (value == null || !value.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToDouble(raw); } catch { return fallback; }
        }

        private static string LastUsefulLine(string text)
        {
            string[] lines = (text ?? "").Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            return lines.Length == 0 ? "无详细错误信息。" : lines[lines.Length - 1].Trim();
        }

        private static string FormatBytes(long value)
        {
            if (value < 1024) return value + " B";
            if (value < 1024L * 1024L) return (value / 1024D).ToString("0.0") + " KiB";
            if (value < 1024L * 1024L * 1024L) return (value / 1024D / 1024D).ToString("0.0") + " MiB";
            return (value / 1024D / 1024D / 1024D).ToString("0.00") + " GiB";
        }

        private static string JoinArguments(IEnumerable<string> args)
        {
            return string.Join(" ", args.Select(QuoteArgument));
        }

        private static string QuoteArgument(string value)
        {
            string text = value ?? "";
            if (text.Length == 0) return "\"\"";
            if (!text.Any(char.IsWhiteSpace) && text.IndexOf('"') < 0) return text;
            return "\"" + text.Replace("\"", "\\\"") + "\"";
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && !_handoffToApply && !_allowBusyClose)
            {
                e.Cancel = true;
                return;
            }
            base.OnFormClosing(e);
        }

        private sealed class BackendResult
        {
            public int ExitCode { get; set; }
            public string Output { get; set; }
        }
    }
}
