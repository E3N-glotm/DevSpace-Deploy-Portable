using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DevSpacePortable.NativeUI
{
    internal static class UiPalette
    {
        public static readonly Color Background = Color.FromArgb(246, 248, 252);
        public static readonly Color Surface = Color.White;
        public static readonly Color SurfaceStrong = Color.FromArgb(238, 241, 247);
        public static readonly Color Primary = Color.FromArgb(73, 91, 246);
        public static readonly Color PrimaryHover = Color.FromArgb(62, 78, 222);
        public static readonly Color PrimarySoft = Color.FromArgb(232, 234, 255);
        public static readonly Color Text = Color.FromArgb(24, 31, 47);
        public static readonly Color TextMuted = Color.FromArgb(102, 112, 137);
        public static readonly Color Border = Color.FromArgb(219, 225, 238);
        public static readonly Color Danger = Color.FromArgb(218, 62, 82);
        public static readonly Color DangerSoft = Color.FromArgb(255, 235, 240);
        public static readonly Color Success = Color.FromArgb(19, 157, 112);
        public static readonly Color Console = Color.FromArgb(24, 29, 43);
        public static readonly Color ConsoleText = Color.FromArgb(221, 227, 239);
    }

    internal static class NativeWindowEffects
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hwnd, int command);

        public static void Apply(IntPtr handle)
        {
            try
            {
                int rounded = 2;
                DwmSetWindowAttribute(handle, 33, ref rounded, sizeof(int));
                int backdrop = 1;
                DwmSetWindowAttribute(handle, 38, ref backdrop, sizeof(int));
                int dark = 0;
                DwmSetWindowAttribute(handle, 20, ref dark, sizeof(int));
            }
            catch { }
        }

        public static void ActivateExistingWindow(string title)
        {
            try
            {
                EnumWindows(delegate (IntPtr hwnd, IntPtr parameter)
                {
                    if (!IsWindowVisible(hwnd)) return true;
                    StringBuilder text = new StringBuilder(256);
                    GetWindowText(hwnd, text, text.Capacity);
                    if (!string.Equals(text.ToString(), title, StringComparison.Ordinal)) return true;
                    ShowWindow(hwnd, 9);
                    SetForegroundWindow(hwnd);
                    return false;
                }, IntPtr.Zero);
            }
            catch { }
        }
    }

    internal static class DrawingUtil
    {
        public static Color BackgroundFor(Control control, Color fallback)
        {
            Control current = control == null ? null : control.Parent;
            while (current != null)
            {
                Color color = current.BackColor;
                if (color.A == 255) return color;
                current = current.Parent;
            }
            return fallback;
        }

        public static GraphicsPath Rounded(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            if (bounds.Width <= 0 || bounds.Height <= 0) return path;
            int safeRadius = Math.Max(1, Math.Min(radius, Math.Min(bounds.Width, bounds.Height) / 2));
            int diameter = Math.Max(2, safeRadius * 2);
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal class ModernButton : Button
    {
        private bool _hover;
        private bool _busy;
        public bool Primary { get; set; }
        public bool Danger { get; set; }
        public string BusyText { get; set; }
        protected virtual int CornerRadius { get { return 13; } }

        public bool Busy
        {
            get { return _busy; }
            set
            {
                if (_busy == value) return;
                _busy = value;
                Cursor = value ? Cursors.WaitCursor : Cursors.Hand;
                Invalidate();
            }
        }

        public ModernButton()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            UseVisualStyleBackColor = false;
            Cursor = Cursors.Hand;
            Font = new Font("Segoe UI Variable Text", 9.25F, FontStyle.Regular);
            MinimumSize = new Size(104, 42);
            Padding = new Padding(16, 0, 16, 0);
            Margin = new Padding(5, 4, 5, 4);
            BusyText = "执行中…";
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            Color fill = Primary
                ? (_hover && !Busy ? UiPalette.PrimaryHover : UiPalette.Primary)
                : Danger
                    ? (_hover && !Busy ? Color.FromArgb(255, 224, 232) : UiPalette.DangerSoft)
                    : (Busy ? UiPalette.PrimarySoft : (_hover ? UiPalette.PrimarySoft : Color.FromArgb(248, 249, 253)));
            Color text = Primary ? Color.White : Danger ? UiPalette.Danger : UiPalette.Text;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, CornerRadius))
            using (Brush brush = new SolidBrush(fill))
            using (Pen border = new Pen(Primary ? fill : UiPalette.Border))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(border, path);
            }
            TextFormatFlags alignment = TextAlign == ContentAlignment.MiddleLeft
                ? TextFormatFlags.Left
                : TextAlign == ContentAlignment.MiddleRight
                    ? TextFormatFlags.Right
                    : TextFormatFlags.HorizontalCenter;
            Rectangle textBounds = new Rectangle(Padding.Left, 0, Math.Max(0, Width - Padding.Horizontal), Height);
            string displayText = Busy ? BusyText : Text;
            TextRenderer.DrawText(e.Graphics, displayText, Font, textBounds, Enabled ? text : UiPalette.TextMuted,
                alignment | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            bool selfTest = args.Length > 0 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase);
            bool structureTest = args.Length > 0 && string.Equals(args[0], "--structure-test", StringComparison.OrdinalIgnoreCase);
            bool tailFileTest = args.Length > 0 && string.Equals(args[0], "--tail-file-test", StringComparison.OrdinalIgnoreCase);
            if (tailFileTest)
            {
                if (args.Length < 3) throw new ArgumentException("--tail-file-test requires an input log and output file.");
                File.WriteAllText(Path.GetFullPath(args[2]), MainForm.TailFile(Path.GetFullPath(args[1]), 2000), Encoding.UTF8);
                return;
            }
            if (selfTest || structureTest)
            {
                string output = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.Combine(Path.GetTempPath(), "devspace-native-ui-self-test.json");
                RunSelfTest(root, output);
                return;
            }
            if (args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException("Unsupported DevSpace Portable option: " + args[0]);
            }
            string mutexName = "Local\\DevSpacePortable.NativeUI." + StableName(root);
            bool createdNew;
            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    NativeWindowEffects.ActivateExistingWindow("DevSpace Portable");
                    return;
                }
                Application.Run(new MainForm(root));
            }
        }

        private static string StableName(string value)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
                return BitConverter.ToString(hash, 0, 10).Replace("-", "");
            }
        }

        private static void RunSelfTest(string root, string output)
        {
            Dictionary<string, object> report = new Dictionary<string, object>();
            report["nativeWindowTitle"] = "DevSpace Portable";
            report["shellKind"] = "webview2";
            report["consoleServerEntry"] = Path.Combine(root, "setup", "console-server.cjs");
            report["consoleUiDist"] = Directory.Exists(Path.Combine(root, "setup", "console-ui", "dist"));
            report["webview2Loader"] = File.Exists(Path.Combine(root, "WebView2Loader.dll"));
            using (MainForm form = new MainForm(root))
            {
                form.CreateControl();
                report["webViewControls"] = FindControls<WebView2>(form).Count();
                report["nativeWindowTitle"] = form.Text;
            }
            report["passed"] = true;
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            File.WriteAllText(output, new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(report), Encoding.UTF8);
        }

        private static IEnumerable<T> FindControls<T>(Control root) where T : Control
        {
            foreach (Control child in root.Controls)
            {
                T match = child as T;
                if (match != null) yield return match;
                foreach (T nested in FindControls<T>(child)) yield return nested;
            }
        }
    }

    internal sealed class ComputerUseOverlayForm : Form
    {
        private const int WsExTransparent = 0x00000020;
        private const int WsExToolWindow = 0x00000080;
        private const int WsExLayered = 0x00080000;
        private const int WsExNoActivate = 0x08000000;
        private const int WmNcHitTest = 0x0084;
        private const int HtTransparent = -1;
        private const uint WdaExcludeFromCapture = 0x00000011;
        private const int BorderThickness = 7;

        [DllImport("user32.dll")]
        private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);

        public ComputerUseOverlayForm(Rectangle bounds)
        {
            Text = "DevSpace Computer Use Indicator";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Magenta;
            TransparencyKey = Color.Magenta;
            DoubleBuffered = true;
            Enabled = false;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams value = base.CreateParams;
                value.ExStyle |= WsExTransparent | WsExToolWindow | WsExLayered | WsExNoActivate;
                return value;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try { SetWindowDisplayAffinity(Handle, WdaExcludeFromCapture); }
            catch { }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.None;
            Color gold = Color.FromArgb(226, 183, 63);
            using (Brush brush = new SolidBrush(gold))
            {
                e.Graphics.FillRectangle(brush, 0, 0, Width, BorderThickness);
                e.Graphics.FillRectangle(brush, 0, Height - BorderThickness, Width, BorderThickness);
                e.Graphics.FillRectangle(brush, 0, BorderThickness, BorderThickness, Math.Max(0, Height - BorderThickness * 2));
                e.Graphics.FillRectangle(brush, Width - BorderThickness, BorderThickness, BorderThickness, Math.Max(0, Height - BorderThickness * 2));
            }
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmNcHitTest)
            {
                message.Result = new IntPtr(HtTransparent);
                return;
            }
            base.WndProc(ref message);
        }
    }

    internal sealed class ComputerUseIndicator : IDisposable
    {
        private readonly List<ComputerUseOverlayForm> _overlays = new List<ComputerUseOverlayForm>();
        private DateTime _visibleUntilUtc = DateTime.MinValue;

        public void Pulse(int holdMilliseconds)
        {
            DateTime requested = DateTime.UtcNow.AddMilliseconds(Math.Max(500, holdMilliseconds));
            if (requested > _visibleUntilUtc) _visibleUntilUtc = requested;
            Rectangle[] current = Screen.AllScreens.Select(screen => screen.Bounds).OrderBy(value => value.Left).ThenBy(value => value.Top).ToArray();
            Rectangle[] existing = _overlays.Select(form => form.Bounds).OrderBy(value => value.Left).ThenBy(value => value.Top).ToArray();
            if (!current.SequenceEqual(existing)) Recreate(current);
            foreach (ComputerUseOverlayForm overlay in _overlays)
            {
                if (!overlay.Visible) overlay.Show();
                overlay.TopMost = true;
                overlay.Invalidate();
            }
        }

        public void Tick()
        {
            if (_visibleUntilUtc == DateTime.MinValue || DateTime.UtcNow < _visibleUntilUtc) return;
            Hide();
        }

        public void Complete(int holdMilliseconds)
        {
            _visibleUntilUtc = DateTime.UtcNow.AddMilliseconds(Math.Max(500, holdMilliseconds));
        }

        public void Hide()
        {
            _visibleUntilUtc = DateTime.MinValue;
            foreach (ComputerUseOverlayForm overlay in _overlays) overlay.Hide();
        }

        private void Recreate(IEnumerable<Rectangle> bounds)
        {
            foreach (ComputerUseOverlayForm overlay in _overlays) overlay.Dispose();
            _overlays.Clear();
            foreach (Rectangle item in bounds) _overlays.Add(new ComputerUseOverlayForm(item));
        }

        public void Dispose()
        {
            foreach (ComputerUseOverlayForm overlay in _overlays) overlay.Dispose();
            _overlays.Clear();
        }
    }

    internal static class NativeComputerInput
    {
        private const uint InputMouse = 0;
        private const uint InputKeyboard = 1;
        private const uint MouseLeftDown = 0x0002;
        private const uint MouseLeftUp = 0x0004;
        private const uint MouseRightDown = 0x0008;
        private const uint MouseRightUp = 0x0010;
        private const uint MouseWheel = 0x0800;
        private const uint KeyUp = 0x0002;
        private const uint KeyUnicode = 0x0004;
        private const int SmXVirtualScreen = 76;
        private const int SmYVirtualScreen = 77;
        private const int SmCxVirtualScreen = 78;
        private const int SmCyVirtualScreen = 79;

        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInput
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint flags;
            public uint time;
            public UIntPtr extraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput
        {
            public ushort virtualKey;
            public ushort scanCode;
            public uint flags;
            public uint time;
            public UIntPtr extraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion
        {
            [FieldOffset(0)] public MouseInput mouse;
            [FieldOffset(0)] public KeyboardInput keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Input
        {
            public uint type;
            public InputUnion union;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
        [DllImport("user32.dll")]
        private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")]
        private static extern uint GetDoubleClickTime();

        public static Dictionary<string, object> Execute(Dictionary<string, object> payload)
        {
            AssertInteractiveDesktop();
            string action = ReadString(payload, "action").ToLowerInvariant();
            Rectangle bounds = new Rectangle(
                GetSystemMetrics(SmXVirtualScreen),
                GetSystemMetrics(SmYVirtualScreen),
                GetSystemMetrics(SmCxVirtualScreen),
                GetSystemMetrics(SmCyVirtualScreen));
            if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("Virtual desktop dimensions are invalid.");

            if (action == "move") SetPoint(payload, bounds);
            else if (action == "click") { SetPoint(payload, bounds); Click(MouseLeftDown, MouseLeftUp); }
            else if (action == "double_click")
            {
                SetPoint(payload, bounds);
                Click(MouseLeftDown, MouseLeftUp);
                Thread.Sleep(Math.Min(75, Math.Max(25, (int)GetDoubleClickTime() / 2)));
                Click(MouseLeftDown, MouseLeftUp);
            }
            else if (action == "right_click") { SetPoint(payload, bounds); Click(MouseRightDown, MouseRightUp); }
            else if (action == "scroll")
            {
                if (payload.ContainsKey("x") || payload.ContainsKey("y")) SetPoint(payload, bounds);
                SendMouse(MouseWheel, unchecked((uint)ReadInt(payload, "delta", true)));
            }
            else if (action == "keypress")
            {
                List<string> keys = ReadStrings(payload, "keys");
                if (keys.Count == 0) throw new InvalidOperationException("keypress requires at least one key.");
                foreach (string key in keys) SendKey(key);
            }
            else if (action == "type_text") SendText(ReadString(payload, "text"));
            else throw new InvalidOperationException("Unsupported action: " + action);

            int delay = Math.Max(0, Math.Min(3000, ReadInt(payload, "delayMs", false)));
            if (delay > 0) Thread.Sleep(delay);
            return new Dictionary<string, object>
            {
                { "action", action },
                { "left", bounds.Left },
                { "top", bounds.Top },
                { "width", bounds.Width },
                { "height", bounds.Height },
                { "inputBackend", "native-ui-sendinput" },
                { "screenshot", false },
            };
        }

        private static void AssertInteractiveDesktop()
        {
            const uint access = 0x0001 | 0x0080 | 0x0100;
            IntPtr desktop = OpenInputDesktop(0, false, access);
            if (desktop == IntPtr.Zero) throw new InvalidOperationException("The interactive input desktop is unavailable. Keep the local UI open and Windows unlocked. Win32 error " + Marshal.GetLastWin32Error() + ".");
            CloseDesktop(desktop);
        }

        private static void SetPoint(Dictionary<string, object> payload, Rectangle bounds)
        {
            int x = ReadInt(payload, "x", true);
            int y = ReadInt(payload, "y", true);
            if (!bounds.Contains(x, y)) throw new InvalidOperationException("Mouse coordinates are outside the virtual desktop.");
            if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed with Win32 error " + Marshal.GetLastWin32Error() + ".");
        }

        private static void Click(uint down, uint up)
        {
            SendMouse(down, 0);
            SendMouse(up, 0);
        }

        private static void SendMouse(uint flags, uint data)
        {
            Input input = new Input { type = InputMouse, union = new InputUnion { mouse = new MouseInput { flags = flags, mouseData = data } } };
            Send(new[] { input });
        }

        private static void SendKey(string raw)
        {
            string value = (raw ?? "").Trim().ToUpperInvariant();
            List<ushort> modifiers = new List<ushort>();
            ushort key;
            if (value == "ALT+F4") { modifiers.Add(0x12); key = 0x73; }
            else if (value.StartsWith("CTRL+", StringComparison.Ordinal) && value.Length == 6 && "ACVXZYSFL".Contains(value[5])) { modifiers.Add(0x11); key = value[5]; }
            else key = ParseSimpleKey(value);
            foreach (ushort modifier in modifiers) SendVirtualKey(modifier, false);
            SendVirtualKey(key, false);
            SendVirtualKey(key, true);
            for (int index = modifiers.Count - 1; index >= 0; index--) SendVirtualKey(modifiers[index], true);
        }

        private static ushort ParseSimpleKey(string value)
        {
            Dictionary<string, ushort> keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
            {
                { "ENTER", 0x0D }, { "TAB", 0x09 }, { "ESCAPE", 0x1B }, { "BACKSPACE", 0x08 },
                { "DELETE", 0x2E }, { "UP", 0x26 }, { "DOWN", 0x28 }, { "LEFT", 0x25 }, { "RIGHT", 0x27 },
                { "HOME", 0x24 }, { "END", 0x23 }, { "PAGEUP", 0x21 }, { "PAGEDOWN", 0x22 },
                { "F1", 0x70 }, { "F2", 0x71 }, { "F3", 0x72 }, { "F4", 0x73 }, { "F5", 0x74 }, { "F6", 0x75 },
                { "F7", 0x76 }, { "F8", 0x77 }, { "F9", 0x78 }, { "F10", 0x79 }, { "F11", 0x7A }, { "F12", 0x7B },
            };
            ushort key;
            if (!keys.TryGetValue(value, out key)) throw new InvalidOperationException("Unsupported key: " + value);
            return key;
        }

        private static void SendVirtualKey(ushort key, bool up)
        {
            Input input = new Input { type = InputKeyboard, union = new InputUnion { keyboard = new KeyboardInput { virtualKey = key, flags = up ? KeyUp : 0 } } };
            Send(new[] { input });
        }

        private static void SendText(string text)
        {
            foreach (char character in text ?? "")
            {
                if (character == '\r') continue;
                if (character == '\n') { SendVirtualKey(0x0D, false); SendVirtualKey(0x0D, true); continue; }
                if (character == '\t') { SendVirtualKey(0x09, false); SendVirtualKey(0x09, true); continue; }
                Input down = new Input { type = InputKeyboard, union = new InputUnion { keyboard = new KeyboardInput { scanCode = character, flags = KeyUnicode } } };
                Input up = down;
                up.union.keyboard.flags = KeyUnicode | KeyUp;
                Send(new[] { down, up });
            }
        }

        private static void Send(Input[] values)
        {
            if (SendInput((uint)values.Length, values, Marshal.SizeOf(typeof(Input))) != values.Length)
                throw new InvalidOperationException("SendInput failed with Win32 error " + Marshal.GetLastWin32Error() + ".");
        }

        private static string ReadString(Dictionary<string, object> payload, string key)
        {
            object value;
            return payload != null && payload.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }

        private static int ReadInt(Dictionary<string, object> payload, string key, bool required)
        {
            object value;
            if (payload == null || !payload.TryGetValue(key, out value) || value == null)
            {
                if (required) throw new InvalidOperationException(key + " is required for this action.");
                return 0;
            }
            return Convert.ToInt32(value);
        }

        private static List<string> ReadStrings(Dictionary<string, object> payload, string key)
        {
            object value;
            List<string> result = new List<string>();
            if (payload == null || !payload.TryGetValue(key, out value) || value is string) return result;
            IEnumerable sequence = value as IEnumerable;
            if (sequence == null) return result;
            foreach (object item in sequence) result.Add(Convert.ToString(item));
            return result;
        }
    }

    internal sealed class MainForm : Form
    {
        private const int ComputerUseActiveIndicatorHoldMs = 90 * 1000;
        private const int ComputerUseWarmIndicatorHoldMs = 65 * 1000;
        private const int ConsoleServerPort = 7677;
        private const string ConsoleServerUrl = "http://127.0.0.1:7677/";

        private readonly string _root;
        private readonly WebView2 _webView = new WebView2();
        private readonly ComputerUseIndicator _computerUseIndicator = new ComputerUseIndicator();
        private readonly System.Windows.Forms.Timer _computerUseTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _computerUseIndicatorTimer = new System.Windows.Forms.Timer();
        private readonly NotifyIcon _notifyIcon = new NotifyIcon();
        private readonly ContextMenuStrip _trayMenu = new ContextMenuStrip();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private bool _closing;
        private bool _allowUiExit;
        private bool _trayNoticeShown;
        private bool _computerUseWorkerBusy;
        private bool _webViewReady;
        private string _closePreference = "";
        private Process _consoleServerProcess;

        public MainForm(string root)
        {
            _root = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            Text = "DevSpace Portable";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1180, 780);
            Size = new Size(1460, 940);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Segoe UI Variable Text", 9.25F);
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            DoubleBuffered = true;
            LoadUiPreferences();
            InitializeTrayIcon();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);
            Shown += async delegate { await InitializeAsync(); };
            FormClosing += MainForm_FormClosing;
            _computerUseTimer.Interval = 15;
            _computerUseTimer.Tick += async delegate { await ProcessComputerUseQueueAsync(); };
            _computerUseIndicatorTimer.Interval = 100;
            _computerUseIndicatorTimer.Tick += delegate { _computerUseIndicator.Tick(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeWindowEffects.Apply(Handle);
        }

        private string UiPreferencesFile
        {
            get
            {
                string configured = Environment.GetEnvironmentVariable("DEVSPACE_PORTABLE_CONFIG_DIR");
                string directory = string.IsNullOrWhiteSpace(configured) ? Path.Combine(_root, "data", "config") : Path.GetFullPath(configured);
                return Path.Combine(directory, "ui-preferences.json");
            }
        }

        private void LoadUiPreferences()
        {
            try
            {
                if (!File.Exists(UiPreferencesFile)) return;
                Dictionary<string, object> value = _json.DeserializeObject(File.ReadAllText(UiPreferencesFile, Encoding.UTF8)) as Dictionary<string, object>;
                string choice = GetString(value, "closeChoice");
                if (choice == "exit-ui" || choice == "minimize-tray") _closePreference = choice;
            }
            catch { _closePreference = ""; }
        }

        private void SaveClosePreference(string choice)
        {
            _closePreference = choice == "exit-ui" || choice == "minimize-tray" ? choice : "";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(UiPreferencesFile));
                string temporary = UiPreferencesFile + ".tmp-" + Process.GetCurrentProcess().Id;
                File.WriteAllText(temporary, _json.Serialize(new Dictionary<string, object>
                {
                    { "formatVersion", 1 },
                    { "closeChoice", _closePreference },
                    { "updatedAt", DateTime.UtcNow.ToString("o") },
                }), new UTF8Encoding(false));
                if (File.Exists(UiPreferencesFile)) File.Delete(UiPreferencesFile);
                File.Move(temporary, UiPreferencesFile);
            }
            catch { }
        }

        private void InitializeTrayIcon()
        {
            _trayMenu.Font = new Font("Microsoft YaHei UI", 9F);
            _trayMenu.Items.Add("打开控制中心", null, delegate { RestoreFromTray(); });
            _trayMenu.Items.Add("下次关闭时询问", null, delegate { SaveClosePreference(""); });
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add("退出控制中心", null, delegate { _allowUiExit = true; Close(); });
            _notifyIcon.Icon = SystemIcons.Application;
            _notifyIcon.Text = "DevSpace Portable";
            _notifyIcon.ContextMenuStrip = _trayMenu;
            _notifyIcon.Visible = false;
            _notifyIcon.DoubleClick += delegate { RestoreFromTray(); };
        }

        private async Task InitializeAsync()
        {
            UseWaitCursor = true;
            try
            {
                EnsureConsoleServer();
                await InitializeWebViewAsync();
                _computerUseTimer.Start();
                _computerUseIndicatorTimer.Start();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "控制中心初始化失败：" + FirstLine(ex.Message), "DevSpace Portable", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { UseWaitCursor = false; }
        }

        private async Task InitializeWebViewAsync()
        {
            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Navigate(ConsoleServerUrl);
            _webViewReady = true;
        }

        private void EnsureConsoleServer()
        {
            if (IsPortOpen(ConsoleServerPort)) return;
            string nodeExe = Path.Combine(_root, "runtime", "node", "node.exe");
            string serverScript = Path.Combine(_root, "setup", "console-server.cjs");
            if (!File.Exists(nodeExe)) throw new InvalidOperationException("Node 运行时缺失：" + nodeExe);
            if (!File.Exists(serverScript)) throw new InvalidOperationException("console-server.cjs 缺失：" + serverScript);
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverScript + "\" --port " + ConsoleServerPort,
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            _consoleServerProcess = Process.Start(info);
            for (int i = 0; i < 100; i++)
            {
                if (IsPortOpen(ConsoleServerPort)) return;
                Thread.Sleep(100);
            }
            throw new InvalidOperationException("console-server 在端口 " + ConsoleServerPort + " 上未就绪。");
        }

        private static bool IsPortOpen(int port)
        {
            try
            {
                using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(200)) return false;
                    client.EndConnect(ar);
                    return client.Connected;
                }
            }
            catch { return false; }
        }

        private string CurrentLeaseId()
        {
            try
            {
                string file = Path.Combine(_root, "data", "run", "ui-session.json");
                if (!File.Exists(file)) return "";
                Dictionary<string, object> lease = _json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
                if (lease == null) return "";
                string leaseId = GetString(lease, "leaseId");
                if (string.IsNullOrEmpty(leaseId)) return "";
                string expiresAt = GetString(lease, "expiresAt");
                if (!string.IsNullOrEmpty(expiresAt))
                {
                    DateTime expires;
                    if (DateTime.TryParse(expiresAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out expires)
                        && expires.ToUniversalTime() < DateTime.UtcNow) return "";
                }
                return leaseId;
            }
            catch { return ""; }
        }

        private async Task ProcessComputerUseQueueAsync()
        {
            if (_closing || _computerUseWorkerBusy) return;
            _computerUseWorkerBusy = true;
            try { await Task.Run((Action)ProcessComputerUseQueue); }
            catch { }
            finally { _computerUseWorkerBusy = false; }
        }

        private void ProcessComputerUseQueue()
        {
            string currentLease = CurrentLeaseId();
            if (string.IsNullOrEmpty(currentLease)) return;
            string queueRoot = Path.Combine(_root, "data", "run", "computer-use");
            string requests = Path.Combine(queueRoot, "requests");
            string responses = Path.Combine(queueRoot, "responses");
            Directory.CreateDirectory(requests);
            Directory.CreateDirectory(responses);
            foreach (string source in Directory.GetFiles(requests, "*.json").OrderBy(value => value).Take(4))
            {
                string requestId = Path.GetFileNameWithoutExtension(source);
                Guid parsedId;
                if (!Guid.TryParse(requestId, out parsedId)) continue;
                string working = source + ".native-working-" + Process.GetCurrentProcess().Id;
                try { File.Move(source, working); }
                catch { continue; }
                try
                {
                    Stopwatch totalTimer = Stopwatch.StartNew();
                    Dictionary<string, object> request = _json.DeserializeObject(File.ReadAllText(working, Encoding.UTF8)) as Dictionary<string, object>;
                    if (request == null || GetString(request, "requestId") != requestId || GetString(request, "leaseId") != currentLease)
                        throw new InvalidOperationException("Computer Use 请求与当前 UI 租约不匹配。");
                    Dictionary<string, object> payload = GetDictionary(request, "payload");
                    NotifyComputerUseActivity(ComputerUseWarmIndicatorHoldMs, false);
                    Dictionary<string, object> metadata = new Dictionary<string, object>();
                    string action = GetString(payload, "action");
                    metadata["action"] = action;
                    metadata["screenshot"] = false;
                    string stderr = "";
                    Stopwatch inputTimer = Stopwatch.StartNew();
                    if (string.Equals(action, "sequence", StringComparison.OrdinalIgnoreCase))
                    {
                        List<Dictionary<string, object>> steps = GetDictionaryList(payload, "steps");
                        if (steps.Count == 0 || steps.Count > 50) throw new InvalidOperationException("Computer Use sequence 需要 1 到 50 个步骤。");
                        List<string> actions = new List<string>();
                        foreach (Dictionary<string, object> step in steps)
                        {
                            string stepAction = GetString(step, "action");
                            if (string.IsNullOrWhiteSpace(stepAction) || string.Equals(stepAction, "snapshot", StringComparison.OrdinalIgnoreCase) || string.Equals(stepAction, "sequence", StringComparison.OrdinalIgnoreCase))
                                throw new InvalidOperationException("Computer Use sequence 包含不支持的步骤动作。");
                            Dictionary<string, object> inputMetadata;
                            string stepStderr;
                            RunNativeInput(step, requestId, out inputMetadata, out stepStderr);
                            if (!string.IsNullOrWhiteSpace(stepStderr)) stderr += stepStderr + Environment.NewLine;
                            actions.Add(stepAction);
                            NotifyComputerUseActivity(ComputerUseWarmIndicatorHoldMs, false);
                        }
                        metadata["steps"] = steps.Count;
                        metadata["actions"] = actions.ToArray();
                        metadata["inputBackend"] = "native-ui-sendinput";
                    }
                    else if (!string.Equals(action, "snapshot", StringComparison.OrdinalIgnoreCase))
                    {
                        Dictionary<string, object> inputMetadata;
                        RunNativeInput(payload, requestId, out inputMetadata, out stderr);
                        foreach (KeyValuePair<string, object> item in inputMetadata) metadata[item.Key] = item.Value;
                    }
                    inputTimer.Stop();
                    metadata["inputElapsedMs"] = inputTimer.ElapsedMilliseconds;
                    bool screenshotAfter = !payload.ContainsKey("screenshotAfter") || Convert.ToBoolean(payload["screenshotAfter"]);
                    if (screenshotAfter)
                    {
                        Stopwatch captureTimer = Stopwatch.StartNew();
                        string imageFile = Path.Combine(responses, requestId + ".png");
                        Dictionary<string, object> capture = CaptureInteractiveDesktop(imageFile);
                        captureTimer.Stop();
                        foreach (KeyValuePair<string, object> item in capture) metadata[item.Key] = item.Value;
                        metadata["action"] = action;
                        metadata["screenshot"] = true;
                        metadata["captureElapsedMs"] = captureTimer.ElapsedMilliseconds;
                    }
                    DateTime createdAt;
                    if (DateTime.TryParse(GetString(request, "createdAt"), out createdAt))
                        metadata["queueWaitMs"] = Math.Max(0, (long)(DateTime.UtcNow - createdAt.ToUniversalTime()).TotalMilliseconds - totalTimer.ElapsedMilliseconds);
                    metadata["totalElapsedMs"] = totalTimer.ElapsedMilliseconds;
                    WriteComputerUseResponse(responses, requestId, new Dictionary<string, object>
                    {
                        { "success", true },
                        { "metadata", metadata },
                        { "stderr", stderr },
                    });
                    NotifyComputerUseActivity(ComputerUseActiveIndicatorHoldMs, true);
                }
                catch (Exception ex)
                {
                    WriteComputerUseResponse(responses, requestId, new Dictionary<string, object>
                    {
                        { "success", false },
                        { "error", FirstLine(ex.Message) },
                    });
                    NotifyComputerUseActivity(ComputerUseActiveIndicatorHoldMs, true);
                }
                finally
                {
                    try { File.Delete(working); } catch { }
                }
            }
        }

        private void RunNativeInput(Dictionary<string, object> payload, string requestId, out Dictionary<string, object> metadata, out string stderr)
        {
            try
            {
                metadata = NativeComputerInput.Execute(payload);
                stderr = "";
                return;
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            RunNativeInputHelper(payload, requestId, out metadata, out stderr);
        }

        private void RunNativeInputHelper(Dictionary<string, object> payload, string requestId, out Dictionary<string, object> metadata, out string stderr)
        {
            string helper = Path.Combine(_root, "app", "node_modules", "@waishnav", "devspace", "dist", "helpers", "computer-use-input.exe");
            if (!File.Exists(helper)) throw new FileNotFoundException("Computer Use 原生输入助手缺失。", helper);
            List<string> arguments = new List<string> { "--action", GetString(payload, "action") };
            foreach (string name in new[] { "x", "y", "delta", "delayMs" })
                if (payload.ContainsKey(name)) { arguments.Add("--" + name.Replace("delayMs", "delay")); arguments.Add(Convert.ToString(payload[name])); }
            object keysValue;
            IEnumerable keyItems = null;
            if (payload.TryGetValue("keys", out keysValue) && !(keysValue is string)) keyItems = keysValue as IEnumerable;
            if (keyItems != null)
                foreach (object key in keyItems) { arguments.Add("--key"); arguments.Add(Convert.ToString(key)); }
            string textFile = "";
            if (string.Equals(GetString(payload, "action"), "type_text", StringComparison.OrdinalIgnoreCase))
            {
                textFile = Path.Combine(_root, "data", "run", "computer-use", "requests", requestId + ".native-text.txt");
                File.WriteAllText(textFile, GetString(payload, "text"), new UTF8Encoding(false));
                arguments.Add("--text-file"); arguments.Add(textFile);
            }
            try
            {
                ProcessStartInfo info = new ProcessStartInfo
                {
                    FileName = helper,
                    Arguments = string.Join(" ", arguments.Select(QuoteProcessArgument)),
                    WorkingDirectory = _root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                using (Process process = Process.Start(info))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    stderr = process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(10000)) { process.Kill(); throw new TimeoutException("Computer Use 输入助手超时。"); }
                    if (process.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? output : stderr);
                    string jsonLine = output.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
                    metadata = string.IsNullOrWhiteSpace(jsonLine)
                        ? new Dictionary<string, object>()
                        : (_json.DeserializeObject(jsonLine) as Dictionary<string, object> ?? new Dictionary<string, object>());
                }
            }
            finally { if (!string.IsNullOrEmpty(textFile)) try { File.Delete(textFile); } catch { } }
        }

        private void NotifyComputerUseActivity(int holdMilliseconds, bool completed)
        {
            if (_closing || IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke((Action)delegate { NotifyComputerUseActivity(holdMilliseconds, completed); }); }
                catch { }
                return;
            }
            if (completed) _computerUseIndicator.Complete(holdMilliseconds);
            else _computerUseIndicator.Pulse(holdMilliseconds);
        }

        private Dictionary<string, object> CaptureInteractiveDesktop(string outputFile)
        {
            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("交互式桌面边界无效。");
            Directory.CreateDirectory(Path.GetDirectoryName(outputFile));
            string temporary = outputFile + ".tmp-" + Process.GetCurrentProcess().Id;
            try
            {
                using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                    int visible = 0;
                    int stepX = Math.Max(1, bounds.Width / 64);
                    int stepY = Math.Max(1, bounds.Height / 64);
                    for (int y = 0; y < bounds.Height && visible < 8; y += stepY)
                        for (int x = 0; x < bounds.Width && visible < 8; x += stepX)
                        {
                            Color pixel = bitmap.GetPixel(x, y);
                            if (pixel.R != 0 || pixel.G != 0 || pixel.B != 0) visible++;
                        }
                    if (visible < 8) throw new InvalidOperationException("原生 UI 收到空桌面帧，RDP 桌面可能已锁定或断开。");
                    bitmap.Save(temporary, System.Drawing.Imaging.ImageFormat.Png);
                }
                if (File.Exists(outputFile)) File.Delete(outputFile);
                File.Move(temporary, outputFile);
                return new Dictionary<string, object>
                {
                    { "width", bounds.Width },
                    { "height", bounds.Height },
                    { "left", bounds.Left },
                    { "top", bounds.Top },
                    { "outputs", Screen.AllScreens.Length },
                    { "backend", "native-ui-gdi" },
                };
            }
            finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
        }

        private void WriteComputerUseResponse(string responses, string requestId, Dictionary<string, object> value)
        {
            value["formatVersion"] = 1;
            value["requestId"] = requestId;
            value["completedAt"] = DateTime.UtcNow.ToString("o");
            string target = Path.Combine(responses, requestId + ".json");
            string temporary = target + ".tmp-" + Process.GetCurrentProcess().Id;
            File.WriteAllText(temporary, _json.Serialize(value), new UTF8Encoding(false));
            if (File.Exists(target)) File.Delete(target);
            File.Move(temporary, target);
        }

        private static string QuoteProcessArgument(string value)
        {
            string text = value ?? "";
            if (text.Length > 0 && text.All(character => !char.IsWhiteSpace(character) && character != '"')) return text;
            return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            if (_closing) return;
            bool systemShutdown = e.CloseReason == CloseReason.WindowsShutDown
                || e.CloseReason == CloseReason.ApplicationExitCall;
            if (!_allowUiExit && !systemShutdown)
            {
                CloseChoice choice;
                bool remember = false;
                if (_closePreference == "minimize-tray") choice = CloseChoice.MinimizeToTray;
                else if (_closePreference == "exit-ui") choice = CloseChoice.ExitUi;
                else
                {
                    CloseChoiceResult result = CloseChoiceDialog.Show(this);
                    choice = result.Choice;
                    remember = result.Remember;
                }
                if (choice == CloseChoice.Cancel)
                {
                    e.Cancel = true;
                    return;
                }
                if (remember) SaveClosePreference(choice == CloseChoice.MinimizeToTray ? "minimize-tray" : "exit-ui");
                if (choice == CloseChoice.MinimizeToTray)
                {
                    e.Cancel = true;
                    MinimizeToTray();
                    return;
                }
                _allowUiExit = true;
            }
            _closing = true;
            _computerUseTimer.Stop();
            _computerUseIndicatorTimer.Stop();
            _computerUseIndicator.Dispose();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _trayMenu.Dispose();
            // console-server 是常驻进程，由用户/系统托盘退出时一并终止
            try { if (_consoleServerProcess != null && !_consoleServerProcess.HasExited) _consoleServerProcess.CloseMainWindow(); } catch { }
        }

        private void MinimizeToTray()
        {
            ShowInTaskbar = false;
            _notifyIcon.Visible = true;
            Hide();
            if (!_trayNoticeShown)
            {
                _trayNoticeShown = true;
                _notifyIcon.ShowBalloonTip(2500, "DevSpace Portable", "控制中心已最小化到系统托盘，后台服务和本地桌面租约保持运行。", ToolTipIcon.Info);
            }
        }

        private void RestoreFromTray()
        {
            if (_closing || IsDisposed) return;
            _notifyIcon.Visible = false;
            ShowInTaskbar = true;
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        internal static string TailFile(string file, int maxLines)
        {
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return "日志文件尚未生成：" + file;
            const int maxBytes = 4 * 1024 * 1024;
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long start = Math.Max(0, stream.Length - maxBytes);
                stream.Seek(start, SeekOrigin.Begin);
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 4096, false))
                {
                    if (start > 0) reader.ReadLine();
                    Queue<string> lines = new Queue<string>(Math.Max(1, maxLines));
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (lines.Count >= maxLines) lines.Dequeue();
                        lines.Enqueue(line);
                    }
                    return string.Join(Environment.NewLine, lines.ToArray());
                }
            }
        }

        private static string FirstLine(string value) { return (value ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "unknown"; }
        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> source, string key) { object value; return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>(); }
        private static string GetString(Dictionary<string, object> source, string key, string fallback = "") { object value; return source != null && source.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback; }
        private static List<Dictionary<string, object>> GetDictionaryList(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null) return new List<Dictionary<string, object>>();
            IEnumerable sequence = value as IEnumerable;
            if (sequence == null || value is string) return new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            foreach (object item in sequence) { Dictionary<string, object> dictionary = item as Dictionary<string, object>; if (dictionary != null) result.Add(dictionary); }
            return result;
        }
    }

    internal enum CloseChoice
    {
        Cancel,
        ExitUi,
        MinimizeToTray,
    }

    internal sealed class CloseChoiceResult
    {
        public CloseChoice Choice { get; set; }
        public bool Remember { get; set; }
    }

    internal sealed class CloseChoiceDialog : Form
    {
        private readonly CheckBox _remember = new CheckBox();
        private CloseChoice _choice = CloseChoice.Cancel;

        private CloseChoiceDialog()
        {
            Text = "关闭 DevSpace Portable";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(560, 290);
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            Font = new Font("Microsoft YaHei UI", 9F);

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 5,
                Padding = new Padding(24, 20, 24, 18),
                BackColor = UiPalette.Background,
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 92));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            Label title = new Label
            {
                Text = "关闭控制中心后要做什么？",
                Dock = DockStyle.Fill,
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            Label hint = new Label
            {
                Text = "两种选择都不会停止 DevSpace 或公网隧道。最小化会保留本地 UI 与 Computer Use 租约；退出只关闭控制中心。",
                Dock = DockStyle.Fill,
                ForeColor = UiPalette.TextMuted,
                TextAlign = ContentAlignment.TopLeft,
                Padding = new Padding(0, 4, 0, 0),
            };
            FlowLayoutPanel choices = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                BackColor = Color.Transparent,
                Padding = new Padding(0, 8, 0, 8),
            };
            ModernButton minimize = new ModernButton
            {
                Text = "最小化到系统托盘",
                Primary = true,
                Width = 238,
                Height = 62,
                AutoSize = false,
                Margin = new Padding(0, 0, 10, 0),
            };
            ModernButton exit = new ModernButton
            {
                Text = "退出控制中心",
                Width = 238,
                Height = 62,
                AutoSize = false,
                Margin = new Padding(10, 0, 0, 0),
            };
            minimize.Click += delegate { _choice = CloseChoice.MinimizeToTray; DialogResult = DialogResult.OK; Close(); };
            exit.Click += delegate { _choice = CloseChoice.ExitUi; DialogResult = DialogResult.OK; Close(); };
            choices.Controls.Add(minimize);
            choices.Controls.Add(exit);

            _remember.Text = "记住我的选择（可从系统托盘菜单恢复为每次询问）";
            _remember.Dock = DockStyle.Fill;
            _remember.ForeColor = UiPalette.TextMuted;
            _remember.BackColor = Color.Transparent;
            _remember.Padding = new Padding(2, 0, 0, 0);

            FlowLayoutPanel cancelBar = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                BackColor = Color.Transparent,
            };
            ModernButton cancel = new ModernButton { Text = "取消", Width = 96, Height = 40, AutoSize = false };
            cancel.Click += delegate { _choice = CloseChoice.Cancel; DialogResult = DialogResult.Cancel; Close(); };
            cancelBar.Controls.Add(cancel);

            layout.Controls.Add(title, 0, 0);
            layout.Controls.Add(hint, 0, 1);
            layout.Controls.Add(choices, 0, 2);
            layout.Controls.Add(_remember, 0, 3);
            layout.Controls.Add(cancelBar, 0, 4);
            Controls.Add(layout);
            CancelButton = cancel;
        }

        public static CloseChoiceResult Show(IWin32Window owner)
        {
            using (CloseChoiceDialog dialog = new CloseChoiceDialog())
            {
                DialogResult result = dialog.ShowDialog(owner);
                return new CloseChoiceResult
                {
                    Choice = result == DialogResult.OK ? dialog._choice : CloseChoice.Cancel,
                    Remember = result == DialogResult.OK && dialog._remember.Checked,
                };
            }
        }
    }
}
