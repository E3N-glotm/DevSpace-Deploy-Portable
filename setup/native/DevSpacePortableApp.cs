using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using DevSpaceBranding;

namespace DevSpacePortable.NativeUI
{
    internal static class UiPalette
    {
        public static readonly Color Background = Color.FromArgb(246, 248, 252);
        public static readonly Color BackgroundEnd = Background;
        public static readonly Color Surface = Color.White;
        public static readonly Color SurfaceMuted = Color.FromArgb(247, 249, 252);
        public static readonly Color SurfaceStrong = Color.FromArgb(238, 241, 247);
        public static readonly Color Primary = Color.FromArgb(73, 91, 246);
        public static readonly Color PrimaryEnd = Primary;
        public static readonly Color PrimaryHover = Color.FromArgb(62, 78, 222);
        public static readonly Color PrimarySoft = Color.FromArgb(232, 234, 255);
        public static readonly Color Text = Color.FromArgb(24, 31, 47);
        public static readonly Color TextMuted = Color.FromArgb(102, 112, 137);
        public static readonly Color Border = Color.FromArgb(219, 225, 238);
        public static readonly Color BorderStrong = Color.FromArgb(201, 210, 228);
        public static readonly Color Danger = Color.FromArgb(218, 62, 82);
        public static readonly Color DangerSoft = Color.FromArgb(255, 235, 240);
        public static readonly Color Success = Color.FromArgb(19, 157, 112);
        public static readonly Color Console = Color.FromArgb(24, 29, 43);
        public static readonly Color ConsoleText = Color.FromArgb(221, 227, 239);
    }

    internal static class UiTypography
    {
        public static readonly string UiFamily = ResolveFamily("Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI");
        public static readonly string DisplayFamily = ResolveFamily("Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI");
        public static readonly string CodeFamily = ResolveFamily("Cascadia Code", "Cascadia Mono", "Consolas");

        public static Font Ui(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(UiFamily, size, style, GraphicsUnit.Point);
        }

        public static Font Display(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(DisplayFamily, size, style, GraphicsUnit.Point);
        }

        public static Font Code(float size, FontStyle style = FontStyle.Regular)
        {
            return new Font(CodeFamily, size, style, GraphicsUnit.Point);
        }

        private static string ResolveFamily(params string[] candidates)
        {
            foreach (string candidate in candidates)
            {
                try
                {
                    using (Font probe = new Font(candidate, 9F, FontStyle.Regular, GraphicsUnit.Point))
                    {
                        if (string.Equals(probe.FontFamily.Name, candidate, StringComparison.OrdinalIgnoreCase)) return candidate;
                    }
                }
                catch { }
            }
            return FontFamily.GenericSansSerif.Name;
        }
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
                    ActivateWindow(hwnd);
                    return false;
                }, IntPtr.Zero);
            }
            catch { }
        }

        public static bool ActivateWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                ShowWindow(hwnd, 9);
                return SetForegroundWindow(hwnd);
            }
            catch { return false; }
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

    internal static class SafeSplitLayout
    {
        public static void Bind(SplitContainer split, int panel1MinSize, int panel2MinSize, double panel1Ratio)
        {
            if (split == null) throw new ArgumentNullException("split");
            split.Panel1MinSize = 0;
            split.Panel2MinSize = 0;
            bool applying = false;
            EventHandler apply = delegate
            {
                if (applying || split.IsDisposed) return;
                applying = true;
                try { Apply(split, panel1MinSize, panel2MinSize, panel1Ratio); }
                finally { applying = false; }
            };
            split.HandleCreated += apply;
            split.ParentChanged += apply;
            split.SizeChanged += apply;
            Apply(split, panel1MinSize, panel2MinSize, panel1Ratio);
        }

        public static void Apply(SplitContainer split, int panel1MinSize, int panel2MinSize, double panel1Ratio)
        {
            if (split == null || split.IsDisposed) return;
            int extent = split.Orientation == Orientation.Vertical ? split.ClientSize.Width : split.ClientSize.Height;
            int splitterWidth = Math.Max(1, split.SplitterWidth);
            int usable = extent - splitterWidth;
            if (usable <= 2)
            {
                ResetMinimums(split);
                return;
            }

            int desiredMin1 = Math.Max(0, panel1MinSize);
            int desiredMin2 = Math.Max(0, panel2MinSize);
            bool hasRoomForDesiredMinimums = usable >= desiredMin1 + desiredMin2;
            int effectiveMin1 = hasRoomForDesiredMinimums ? desiredMin1 : 0;
            int effectiveMin2 = hasRoomForDesiredMinimums ? desiredMin2 : 0;
            double safeRatio = Math.Max(0.05D, Math.Min(0.95D, panel1Ratio));
            int desiredDistance = (int)Math.Round(usable * safeRatio);
            int lower = Math.Max(1, effectiveMin1);
            int upper = Math.Max(lower, usable - effectiveMin2);
            int distance = Math.Max(lower, Math.Min(desiredDistance, upper));

            try
            {
                // Clear old minimums before changing the distance. During WinForms
                // handle creation, DPI scaling and Dock layout can temporarily make
                // ClientSize much smaller than the eventual dialog size. Keeping old
                // minimums in that transient state is what causes SplitterDistance to
                // throw before the page is even shown.
                ResetMinimums(split);
                if (split.SplitterDistance != distance) split.SplitterDistance = distance;
                if (hasRoomForDesiredMinimums)
                {
                    // WinForms validates minimums against the current splitter
                    // distance again while DPI/Dock layout events are firing. Keep
                    // a one-pixel safety margin so a transient exact-boundary value
                    // can never throw from Panel1MinSize/Panel2MinSize setters.
                    split.Panel1MinSize = Math.Min(desiredMin1, Math.Max(0, distance - 1));
                    split.Panel2MinSize = Math.Min(desiredMin2, Math.Max(0, usable - distance - 1));
                }
            }
            catch (ArgumentOutOfRangeException)
            {
                ApplyFallback(split, usable, safeRatio);
            }
            catch (InvalidOperationException)
            {
                ApplyFallback(split, usable, safeRatio);
            }
        }

        private static void ResetMinimums(SplitContainer split)
        {
            if (split.Panel1MinSize != 0) split.Panel1MinSize = 0;
            if (split.Panel2MinSize != 0) split.Panel2MinSize = 0;
        }

        private static void ApplyFallback(SplitContainer split, int usable, double ratio)
        {
            try
            {
                ResetMinimums(split);
                if (usable <= 2) return;
                int distance = Math.Max(1, Math.Min((int)Math.Round(usable * ratio), Math.Max(1, usable - 1)));
                if (split.SplitterDistance != distance) split.SplitterDistance = distance;
            }
            catch { }
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
            Font = UiTypography.Ui(9.25F);
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

    internal sealed class ModernNavButton : ModernButton
    {
        private bool _selected;
        public int IconKind { get; set; }
        public string Title { get; set; }
        public string Subtitle { get; set; }
        protected override int CornerRadius { get { return 17; } }
        public bool Selected
        {
            get { return _selected; }
            set { _selected = value; Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            if (Selected)
            {
                using (GraphicsPath path = DrawingUtil.Rounded(bounds, 16))
                using (SolidBrush fill = new SolidBrush(UiPalette.Primary))
                    e.Graphics.FillPath(fill, path);
            }
            Rectangle iconBounds = new Rectangle(14, 12, 34, 34);
            using (GraphicsPath iconPath = DrawingUtil.Rounded(iconBounds, 11))
            using (SolidBrush iconFill = new SolidBrush(Selected ? Color.FromArgb(42, Color.White) : UiPalette.PrimarySoft))
                e.Graphics.FillPath(iconFill, iconPath);
            DrawIcon(e.Graphics, iconBounds, Selected ? Color.White : UiPalette.Primary);
            using (Font titleFont = UiTypography.Ui(9.5F, FontStyle.Bold))
                TextRenderer.DrawText(e.Graphics, Title ?? Text, titleFont, new Rectangle(60, 10, Math.Max(0, Width - 72), 24), Selected ? Color.White : UiPalette.Text,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            using (Font subtitleFont = UiTypography.Ui(8.25F))
                TextRenderer.DrawText(e.Graphics, Subtitle ?? "", subtitleFont, new Rectangle(60, 32, Math.Max(0, Width - 72), 18), Selected ? Color.FromArgb(218, 228, 255) : UiPalette.TextMuted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }

        private void DrawIcon(Graphics graphics, Rectangle bounds, Color color)
        {
            int x = bounds.X;
            int y = bounds.Y;
            using (Pen pen = new Pen(color, 1.8F) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            {
                if (IconKind == 0)
                {
                    graphics.DrawLines(pen, new[] { new Point(x + 8, y + 17), new Point(x + 17, y + 9), new Point(x + 26, y + 17) });
                    graphics.DrawRectangle(pen, x + 11, y + 16, 12, 10);
                }
                else if (IconKind == 1)
                {
                    graphics.DrawEllipse(pen, x + 11, y + 11, 12, 12);
                    graphics.DrawEllipse(pen, x + 15, y + 15, 4, 4);
                    graphics.DrawLine(pen, x + 17, y + 7, x + 17, y + 11);
                    graphics.DrawLine(pen, x + 17, y + 23, x + 17, y + 27);
                    graphics.DrawLine(pen, x + 7, y + 17, x + 11, y + 17);
                    graphics.DrawLine(pen, x + 23, y + 17, x + 27, y + 17);
                }
                else if (IconKind == 2)
                {
                    for (int row = 0; row < 2; row++)
                        for (int column = 0; column < 2; column++)
                            graphics.DrawRectangle(pen, x + 8 + column * 11, y + 8 + row * 11, 7, 7);
                }
                else if (IconKind == 3)
                {
                    graphics.DrawEllipse(pen, x + 8, y + 8, 19, 19);
                    graphics.DrawLine(pen, x + 17, y + 17, x + 17, y + 11);
                    graphics.DrawLine(pen, x + 17, y + 17, x + 22, y + 20);
                }
                else if (IconKind == 4)
                {
                    graphics.DrawRectangle(pen, x + 8, y + 8, 18, 20);
                    graphics.DrawLine(pen, x + 12, y + 13, x + 22, y + 13);
                    graphics.DrawLine(pen, x + 12, y + 18, x + 22, y + 18);
                    graphics.DrawLine(pen, x + 12, y + 23, x + 19, y + 23);
                }
                else
                {
                    graphics.DrawLines(pen, new[] { new Point(x + 6, y + 18), new Point(x + 11, y + 18), new Point(x + 14, y + 11), new Point(x + 19, y + 24), new Point(x + 23, y + 15), new Point(x + 28, y + 15) });
                }
            }
        }
    }

    internal sealed class ModernToggle : CheckBox
    {
        private bool _hover;
        public ModernToggle()
        {
            AutoSize = false;
            Height = 36;
            Width = 290;
            Cursor = Cursors.Hand;
            Font = UiTypography.Ui(9F);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            bool hasText = !string.IsNullOrWhiteSpace(Text);
            const int trackWidth = 48;
            const int trackHeight = 24;
            int trackX = hasText ? 1 : Math.Max(1, (ClientSize.Width - trackWidth) / 2);
            int trackY = Math.Max(1, (ClientSize.Height - trackHeight) / 2);
            Rectangle track = new Rectangle(trackX, trackY, trackWidth, trackHeight);
            Color trackColor = Checked ? UiPalette.Primary : (_hover ? Color.FromArgb(181, 191, 210) : Color.FromArgb(203, 211, 225));
            using (GraphicsPath path = DrawingUtil.Rounded(track, 12))
            using (SolidBrush brush = new SolidBrush(trackColor)) e.Graphics.FillPath(brush, path);
            const int knobDiameter = 20;
            int knobX = Checked ? track.Right - knobDiameter - 2 : track.Left + 2;
            int knobY = track.Top + (track.Height - knobDiameter) / 2;
            using (SolidBrush knob = new SolidBrush(Color.White)) e.Graphics.FillEllipse(knob, knobX, knobY, knobDiameter, knobDiameter);
            if (hasText)
            {
                Rectangle textRect = new Rectangle(58, 0, Math.Max(0, Width - 58), Height);
                TextRenderer.DrawText(e.Graphics, Text, Font, textRect, Enabled ? UiPalette.Text : UiPalette.TextMuted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
        }
    }

    internal sealed class ModernGroupBox : GroupBox
    {
        public ModernGroupBox()
        {
            BackColor = Color.Transparent;
            ForeColor = UiPalette.Text;
            Padding = new Padding(18, 52, 18, 18);
            Font = UiTypography.Ui(9.5F, FontStyle.Bold);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 3 || ClientSize.Height <= 3) return;
            Rectangle box = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = DrawingUtil.Rounded(box, 20))
            using (SolidBrush fill = new SolidBrush(UiPalette.Surface))
            using (Pen border = new Pen(UiPalette.Border))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
            Rectangle accent = new Rectangle(18, 18, 5, 18);
            using (GraphicsPath accentPath = DrawingUtil.Rounded(accent, 3))
            using (SolidBrush accentBrush = new SolidBrush(UiPalette.Primary)) e.Graphics.FillPath(accentBrush, accentPath);
            Rectangle title = new Rectangle(32, 13, Math.Max(0, Width - 50), 28);
            TextRenderer.DrawText(e.Graphics, Text, Font, title, UiPalette.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    internal sealed class GlassPanel : Panel
    {
        public GlassPanel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(DrawingUtil.BackgroundFor(this, UiPalette.Background));
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 24))
            using (SolidBrush fill = new SolidBrush(UiPalette.Surface))
            using (Pen border = new Pen(UiPalette.Border))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
        }
    }

    internal sealed class StatusIndicatorCard : Panel
    {
        private string _state = "working";
        private string _title = "正在检查状态";
        private string _detail = "正在读取本地服务与公网连接状态……";

        public StatusIndicatorCard()
        {
            Height = 92;
            MinimumSize = new Size(220, 92);
            Margin = new Padding(6);
            Padding = new Padding(0);
            BackColor = Color.Transparent;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        }

        public void SetStatus(string state, string title, string detail)
        {
            _state = string.IsNullOrWhiteSpace(state) ? "working" : state.Trim().ToLowerInvariant();
            _title = string.IsNullOrWhiteSpace(title) ? "状态未知" : title.Trim();
            _detail = string.IsNullOrWhiteSpace(detail) ? "暂无详细信息。" : detail.Trim();
            Invalidate();
        }

        private Color IndicatorColor
        {
            get
            {
                if (_state == "ready") return UiPalette.Success;
                if (_state == "idle") return Color.FromArgb(232, 137, 35);
                if (_state == "warning") return Color.FromArgb(222, 157, 30);
                if (_state == "error") return UiPalette.Danger;
                if (_state == "stopped") return Color.FromArgb(150, 159, 178);
                return UiPalette.Primary;
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(DrawingUtil.BackgroundFor(this, UiPalette.Background));
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 18))
            using (SolidBrush fill = new SolidBrush(UiPalette.Surface))
            using (Pen border = new Pen(UiPalette.Border))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
            using (SolidBrush dot = new SolidBrush(IndicatorColor))
                e.Graphics.FillEllipse(dot, 22, 27, 14, 14);
            using (Font titleFont = UiTypography.Ui(11.2F, FontStyle.Bold))
                TextRenderer.DrawText(e.Graphics, _title, titleFont, new Rectangle(50, 17, Math.Max(0, Width - 68), 28), UiPalette.Text,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            using (Font detailFont = UiTypography.Ui(9.2F))
                TextRenderer.DrawText(e.Graphics, _detail, detailFont, new Rectangle(50, 48, Math.Max(0, Width - 68), 27), UiPalette.TextMuted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }
    }

    internal sealed class SurfacePanel : Panel
    {
        public bool Dark { get; set; }
        public SurfacePanel()
        {
            Padding = new Padding(12);
            Margin = new Padding(4);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(DrawingUtil.BackgroundFor(this, UiPalette.Background));
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 16))
            using (SolidBrush fill = new SolidBrush(Dark ? UiPalette.Console : UiPalette.Surface))
            using (Pen border = new Pen(Dark ? Color.FromArgb(54, 64, 86) : UiPalette.Border))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
        }
    }

    internal sealed class FieldHost : Panel
    {
        private readonly Control _child;
        private readonly bool _centerSingleLineText;

        public FieldHost(Control child, int width = 0)
        {
            _child = child;
            BackColor = Color.Transparent;
            Margin = new Padding(3, 3, 3, 6);
            bool multiline = child is TextBox && ((TextBox)child).Multiline;
            _centerSingleLineText = child is TextBoxBase && !multiline;
            Padding = multiline
                ? new Padding(10)
                : child is ComboBox
                    ? new Padding(10, 3, 8, 3)
                    : new Padding(10, 7, 8, 6);
            Height = multiline ? Math.Max(72, child.Height + 12) : 38;
            MinimumSize = new Size(40, Height);
            if (width > 0) Width = width;
            if (multiline || !_centerSingleLineText)
            {
                child.Dock = DockStyle.Fill;
            }
            else
            {
                child.Dock = DockStyle.None;
                child.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            }
            Controls.Add(child);
            ModernNumericUpDown number = child as ModernNumericUpDown;
            if (number != null)
            {
                NumericStepper stepper = new NumericStepper(number) { Dock = DockStyle.Right, Width = 26 };
                Controls.Add(stepper);
                stepper.BringToFront();
            }
            child.Enter += delegate { Invalidate(); };
            child.Leave += delegate { Invalidate(); };
            Cursor = child is TextBoxBase ? Cursors.IBeam : Cursors.Hand;
            Resize += delegate { LayoutInputChild(); };
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            LayoutInputChild();
        }

        private void LayoutInputChild()
        {
            if (_child == null || !_centerSingleLineText || _child.Dock == DockStyle.Fill) return;
            int left = Padding.Left;
            int width = Math.Max(1, ClientSize.Width - Padding.Horizontal);
            int preferredHeight = Math.Max(1, _child.PreferredSize.Height);
            int top = Math.Max(Padding.Top, (ClientSize.Height - preferredHeight) / 2);
            _child.Bounds = new Rectangle(left, top, width, Math.Min(preferredHeight, Math.Max(1, ClientSize.Height - top - Padding.Bottom)));
        }

        internal void ActivateInput(Point hostPoint)
        {
            if (_child == null || !_child.Enabled) return;
            TextBoxBase text = _child as TextBoxBase;
            if (text != null)
            {
                text.Focus();
                Point local = new Point(
                    Math.Max(0, Math.Min(text.ClientSize.Width - 1, hostPoint.X - text.Left)),
                    Math.Max(0, Math.Min(text.ClientSize.Height - 1, hostPoint.Y - text.Top)));
                int index = text.GetCharIndexFromPosition(local);
                text.SelectionStart = Math.Max(0, Math.Min(index, text.TextLength));
                text.SelectionLength = 0;
                return;
            }
            ComboBox combo = _child as ComboBox;
            if (combo != null)
            {
                combo.Focus();
                if (combo.DropDownStyle != ComboBoxStyle.Simple) combo.DroppedDown = true;
                return;
            }
            _child.Focus();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) ActivateInput(e.Location);
            base.OnMouseDown(e);
        }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            e.Graphics.Clear(DrawingUtil.BackgroundFor(this, UiPalette.Surface));
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 11))
            using (SolidBrush fill = new SolidBrush(UiPalette.SurfaceMuted))
            {
                e.Graphics.FillPath(fill, path);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 11))
            using (Pen border = new Pen(ContainsFocus ? UiPalette.Primary : UiPalette.BorderStrong, ContainsFocus ? 1.8F : 1.2F))
                e.Graphics.DrawPath(border, path);
        }
    }

    internal sealed class ModernComboBox : ComboBox
    {
        private const int WmPaint = 0x000F;

        public ModernComboBox()
        {
            DrawMode = DrawMode.OwnerDrawFixed;
            ItemHeight = 26;
            FlatStyle = FlatStyle.Flat;
            DropDownStyle = ComboBoxStyle.DropDownList;
            BackColor = UiPalette.SurfaceMuted;
            ForeColor = UiPalette.Text;
        }

        protected override void WndProc(ref Message message)
        {
            base.WndProc(ref message);
            if (message.Msg == WmPaint && IsHandleCreated && !DroppedDown)
            {
                using (Graphics graphics = Graphics.FromHwnd(Handle)) DrawClosedState(graphics);
            }
        }

        protected override void OnSelectedIndexChanged(EventArgs e) { base.OnSelectedIndexChanged(e); Invalidate(); }
        protected override void OnDropDownClosed(EventArgs e) { base.OnDropDownClosed(e); Invalidate(); }

        private void DrawClosedState(Graphics graphics)
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush fill = new SolidBrush(UiPalette.SurfaceMuted)) graphics.FillRectangle(fill, ClientRectangle);
            string value = SelectedIndex >= 0 ? GetItemText(SelectedItem) : Text;
            TextRenderer.DrawText(graphics, value, Font, new Rectangle(2, 0, Math.Max(0, Width - 28), Height), ForeColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            int centerX = Width - 12;
            int centerY = Height / 2;
            using (Pen pen = new Pen(UiPalette.TextMuted, 1.5F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                graphics.DrawLine(pen, centerX - 4, centerY - 2, centerX, centerY + 2);
                graphics.DrawLine(pen, centerX, centerY + 2, centerX + 4, centerY - 2);
            }
        }
        protected override void OnDrawItem(DrawItemEventArgs e)
        {
            if (e.Index < 0) return;
            bool selected = (e.State & DrawItemState.Selected) != 0 && (e.State & DrawItemState.ComboBoxEdit) == 0;
            using (SolidBrush fill = new SolidBrush(selected ? UiPalette.PrimarySoft : UiPalette.SurfaceMuted)) e.Graphics.FillRectangle(fill, e.Bounds);
            string value = GetItemText(Items[e.Index]);
            TextRenderer.DrawText(e.Graphics, value, Font, new Rectangle(e.Bounds.X + 6, e.Bounds.Y, Math.Max(0, e.Bounds.Width - 10), e.Bounds.Height), UiPalette.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    internal sealed class ModernNumericUpDown : NumericUpDown
    {
        public ModernNumericUpDown()
        {
            BorderStyle = BorderStyle.None;
            BackColor = UiPalette.SurfaceMuted;
            ForeColor = UiPalette.Text;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            HideNativeStepper();
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            HideNativeStepper();
        }

        private void HideNativeStepper()
        {
            foreach (Control control in Controls)
            {
                if (control.GetType().Name.IndexOf("UpDownButtons", StringComparison.OrdinalIgnoreCase) >= 0)
                    control.Visible = false;
            }
        }
    }

    internal sealed class NumericStepper : Control
    {
        private readonly ModernNumericUpDown _owner;

        public NumericStepper(ModernNumericUpDown owner)
        {
            _owner = owner;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaintBackground(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color color = Enabled && _owner.Enabled ? UiPalette.TextMuted : UiPalette.BorderStrong;
            int centerX = Width / 2;
            using (Pen pen = new Pen(color, 1.35F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                int upper = Height / 2 - 5;
                e.Graphics.DrawLine(pen, centerX - 3, upper + 2, centerX, upper - 1);
                e.Graphics.DrawLine(pen, centerX, upper - 1, centerX + 3, upper + 2);
                int lower = Height / 2 + 5;
                e.Graphics.DrawLine(pen, centerX - 3, lower - 2, centerX, lower + 1);
                e.Graphics.DrawLine(pen, centerX, lower + 1, centerX + 3, lower - 2);
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (!_owner.Enabled) return;
            _owner.Focus();
            decimal next = e.Y < Height / 2 ? _owner.Value + _owner.Increment : _owner.Value - _owner.Increment;
            _owner.Value = Math.Min(_owner.Maximum, Math.Max(_owner.Minimum, next));
        }
    }

    internal sealed class BrandMark : Control
    {
        public BrandMark()
        {
            Size = new Size(44, 44);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            BrandIconFactory.DrawMark(e.Graphics, new RectangleF(1, 1, Width - 3, Height - 3));
        }
    }

    internal sealed class InlineNotice : Control
    {
        private string _message = "";
        private bool _error;
        private bool _expanded;
        public event EventHandler Dismissed;

        public InlineNotice()
        {
            Dock = DockStyle.Top;
            Height = 0;
            Visible = false;
            Cursor = Cursors.Default;
            Font = UiTypography.Ui(9F);
            Margin = new Padding(0, 0, 0, 8);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
        }

        public void ShowMessage(string message, bool error)
        {
            _message = string.IsNullOrWhiteSpace(message) ? "操作未完成，请检查当前设置。" : message.Trim();
            _error = error;
            _expanded = true;
            Height = 48;
            Visible = true;
            if (Parent != null) Parent.PerformLayout();
            Invalidate();
        }

        public void Dismiss()
        {
            _expanded = false;
            Visible = false;
            Height = 0;
            if (Parent != null) Parent.PerformLayout();
            EventHandler handler = Dismissed;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            return new Size(Math.Max(1, proposedSize.Width), _expanded ? 48 : 0);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(DrawingUtil.BackgroundFor(this, UiPalette.Surface));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            Color fill = _error ? UiPalette.DangerSoft : UiPalette.PrimarySoft;
            Color accent = _error ? UiPalette.Danger : UiPalette.Primary;
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 13))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen border = new Pen(Color.FromArgb(80, accent), 1F))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(border, path);
            }
            using (SolidBrush accentBrush = new SolidBrush(accent))
                e.Graphics.FillRectangle(accentBrush, 14, 13, 4, Math.Max(8, Height - 26));
            Rectangle textBounds = new Rectangle(30, 0, Math.Max(0, Width - 74), Height);
            TextRenderer.DrawText(e.Graphics, _message, Font, textBounds, UiPalette.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
            Rectangle closeBounds = new Rectangle(Math.Max(0, Width - 42), 0, 40, Height);
            using (Pen closePen = new Pen(UiPalette.TextMuted, 1.5F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                int centerX = closeBounds.Left + closeBounds.Width / 2;
                int centerY = closeBounds.Top + closeBounds.Height / 2;
                e.Graphics.DrawLine(closePen, centerX - 4, centerY - 4, centerX + 4, centerY + 4);
                e.Graphics.DrawLine(closePen, centerX + 4, centerY - 4, centerX - 4, centerY + 4);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            Cursor = e.X >= Width - 44 ? Cursors.Hand : Cursors.Default;
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            Cursor = Cursors.Default;
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && e.X >= Width - 44) Dismiss();
            base.OnMouseDown(e);
        }
    }

    internal sealed class BorderlessTabControl : TabControl
    {
        private const int TcmAdjustRect = 0x1328;

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == TcmAdjustRect && !DesignMode)
            {
                message.Result = (IntPtr)1;
                return;
            }
            base.WndProc(ref message);
        }
    }

    internal sealed class ModernDiffViewer : UserControl
    {
        private readonly Label _path = new Label();
        private readonly Label _meta = new Label();
        private readonly RichTextBox _content = new RichTextBox();

        public ModernDiffViewer()
        {
            Dock = DockStyle.Fill;
            BackColor = Color.FromArgb(30, 31, 34);
            Margin = new Padding(0);
            Padding = new Padding(0);

            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 54,
                BackColor = Color.FromArgb(39, 40, 44),
                Padding = new Padding(16, 8, 16, 7),
            };
            _path.Dock = DockStyle.Top;
            _path.Height = 23;
            _path.Font = UiTypography.Code(9.5F, FontStyle.Bold);
            _path.ForeColor = Color.FromArgb(223, 225, 229);
            _path.AutoEllipsis = true;
            _path.Text = "未选择文件";
            _meta.Dock = DockStyle.Bottom;
            _meta.Height = 18;
            _meta.Font = UiTypography.Ui(8.25F);
            _meta.ForeColor = Color.FromArgb(135, 139, 147);
            _meta.AutoEllipsis = true;
            _meta.Text = "在上方文件列表中选择一项";
            header.Controls.Add(_path);
            header.Controls.Add(_meta);

            _content.Dock = DockStyle.Fill;
            _content.ReadOnly = true;
            _content.BorderStyle = BorderStyle.None;
            _content.BackColor = Color.FromArgb(30, 31, 34);
            _content.ForeColor = Color.FromArgb(188, 190, 196);
            _content.Font = UiTypography.Code(9F);
            _content.DetectUrls = false;
            _content.WordWrap = false;
            _content.ScrollBars = RichTextBoxScrollBars.Both;
            _content.Margin = new Padding(0);

            Controls.Add(_content);
            Controls.Add(header);
            ShowEmpty("选择一个改动文件后，这里只显示该文件的统一差异。");
        }

        public void ShowEmpty(string message)
        {
            _path.Text = "未选择文件";
            _meta.Text = "仅显示当前选择 · Unified diff";
            _content.Clear();
            _content.SelectionColor = Color.FromArgb(135, 139, 147);
            using (Font placeholder = UiTypography.Ui(10F))
            {
                _content.SelectionFont = placeholder;
                _content.AppendText(Environment.NewLine + Environment.NewLine + "  " + (message ?? "没有可显示的差异。"));
            }
            _content.SelectionStart = 0;
            _content.SelectionLength = 0;
        }

        public void Render(string patch, string title)
        {
            string text = (patch ?? "").Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd('\n');
            if (string.IsNullOrWhiteSpace(text))
            {
                ShowEmpty("当前选择没有可显示的文本差异。");
                return;
            }

            string[] lines = text.Split('\n');
            _path.Text = string.IsNullOrWhiteSpace(title) ? "选中文件" : title;
            _meta.Text = "仅显示当前选择  ·  Unified diff  ·  " + lines.Length + " 行";
            _content.SuspendLayout();
            _content.Clear();
            using (Font regular = UiTypography.Code(9F))
            using (Font bold = UiTypography.Code(9F, FontStyle.Bold))
            {
                int oldLine = 0;
                int newLine = 0;
                for (int index = 0; index < lines.Length; index++)
                {
                    string line = lines[index];
                    bool header = line.StartsWith("diff --git", StringComparison.Ordinal)
                        || line.StartsWith("index ", StringComparison.Ordinal)
                        || line.StartsWith("---", StringComparison.Ordinal)
                        || line.StartsWith("+++", StringComparison.Ordinal);
                    bool hunk = line.StartsWith("@@", StringComparison.Ordinal);
                    bool addition = line.StartsWith("+", StringComparison.Ordinal) && !line.StartsWith("+++", StringComparison.Ordinal);
                    bool deletion = line.StartsWith("-", StringComparison.Ordinal) && !line.StartsWith("---", StringComparison.Ordinal);

                    if (hunk) TryParseHunkStart(line, out oldLine, out newLine);
                    string oldGutter = "";
                    string newGutter = "";
                    if (!header && !hunk && !line.StartsWith("\\ No newline", StringComparison.Ordinal))
                    {
                        if (addition)
                        {
                            newGutter = newLine > 0 ? newLine.ToString() : "";
                            if (newLine > 0) newLine++;
                        }
                        else if (deletion)
                        {
                            oldGutter = oldLine > 0 ? oldLine.ToString() : "";
                            if (oldLine > 0) oldLine++;
                        }
                        else
                        {
                            oldGutter = oldLine > 0 ? oldLine.ToString() : "";
                            newGutter = newLine > 0 ? newLine.ToString() : "";
                            if (oldLine > 0) oldLine++;
                            if (newLine > 0) newLine++;
                        }
                    }

                    _content.SelectionColor = Color.FromArgb(91, 95, 103);
                    _content.SelectionBackColor = Color.FromArgb(27, 28, 31);
                    _content.SelectionFont = regular;
                    _content.AppendText(oldGutter.PadLeft(5) + " " + newGutter.PadLeft(5) + "  │  ");

                    _content.SelectionFont = header || hunk ? bold : regular;
                    _content.SelectionColor = header
                        ? Color.FromArgb(128, 171, 255)
                        : hunk
                            ? Color.FromArgb(196, 162, 255)
                            : addition
                                ? Color.FromArgb(138, 209, 149)
                                : deletion
                                    ? Color.FromArgb(247, 139, 143)
                                    : Color.FromArgb(188, 190, 196);
                    _content.SelectionBackColor = addition
                        ? Color.FromArgb(35, 65, 45)
                        : deletion
                            ? Color.FromArgb(75, 41, 45)
                            : hunk
                                ? Color.FromArgb(50, 45, 70)
                                : header
                                    ? Color.FromArgb(36, 45, 62)
                                    : Color.FromArgb(30, 31, 34);
                    _content.AppendText(line + Environment.NewLine);
                }
            }
            _content.SelectionStart = 0;
            _content.SelectionLength = 0;
            _content.ResumeLayout();
        }

        private static bool TryParseHunkStart(string line, out int oldLine, out int newLine)
        {
            oldLine = 0;
            newLine = 0;
            if (string.IsNullOrWhiteSpace(line)) return false;
            int minus = line.IndexOf('-', 0);
            int plus = line.IndexOf('+', Math.Max(0, minus + 1));
            if (minus < 0 || plus < 0) return false;
            oldLine = ParseLeadingNumber(line, minus + 1);
            newLine = ParseLeadingNumber(line, plus + 1);
            return oldLine >= 0 && newLine >= 0;
        }

        private static int ParseLeadingNumber(string value, int start)
        {
            int end = start;
            while (end < value.Length && char.IsDigit(value[end])) end++;
            int parsed;
            return end > start && int.TryParse(value.Substring(start, end - start), out parsed) ? parsed : 0;
        }
    }

    internal sealed class SessionDiffDialog : Form
    {
        private readonly ModernDiffViewer _viewer = new ModernDiffViewer();
        private readonly Func<Task> _rollback;
        private readonly Func<Task> _restore;
        private readonly Label _activity = new Label();
        private bool _busy;

        public SessionDiffDialog(Func<Task> rollback, Func<Task> restore)
        {
            _rollback = rollback;
            _restore = restore;
            Text = "文件差异";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = true;
            MinimizeBox = true;
            MinimumSize = new Size(900, 600);
            Size = new Size(1180, 780);
            BackColor = UiPalette.Background;
            Font = UiTypography.Ui(9F);

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                Padding = new Padding(12),
                BackColor = UiPalette.Background,
            };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            FlowLayoutPanel actions = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                AutoSize = true,
                WrapContents = true,
                Padding = new Padding(2, 2, 2, 10),
                BackColor = Color.Transparent,
            };
            actions.Controls.Add(ActionButton("回退此次修改", _rollback, true));
            actions.Controls.Add(ActionButton("恢复回退前快照", _restore, false));
            _activity.AutoSize = true;
            _activity.ForeColor = UiPalette.TextMuted;
            _activity.Padding = new Padding(12, 10, 0, 0);
            _activity.Text = "可自由调整窗口大小；仅显示主窗口当前选择的文件。";
            actions.Controls.Add(_activity);
            layout.Controls.Add(actions, 0, 0);
            SurfacePanel surface = new SurfacePanel { Dock = DockStyle.Fill, Dark = true, Padding = new Padding(1) };
            surface.Controls.Add(_viewer);
            layout.Controls.Add(surface, 0, 1);
            Controls.Add(layout);
            Shown += delegate { NativeWindowEffects.Apply(Handle); };
        }

        public void UpdateDiff(string patch, string title)
        {
            Text = string.IsNullOrWhiteSpace(title) ? "文件差异" : "文件差异 · " + title;
            _viewer.Render(patch, title);
        }

        public void ShowEmpty(string message) { _viewer.ShowEmpty(message); }

        private ModernButton ActionButton(string text, Func<Task> action, bool danger)
        {
            ModernButton button = new ModernButton { Text = text, AutoSize = true, Danger = danger };
            button.Click += async delegate
            {
                if (_busy || action == null) return;
                _busy = true;
                button.Busy = true;
                _activity.Text = "正在执行，请稍候……";
                try
                {
                    await action();
                    _activity.Text = "操作完成 · " + DateTime.Now.ToString("HH:mm:ss");
                }
                catch (Exception ex)
                {
                    _activity.Text = "操作失败";
                    MessageBox.Show(this, ex.Message, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                finally
                {
                    button.Busy = false;
                    _busy = false;
                }
            };
            return button;
        }
    }

    internal sealed class ContentPreviewDialog : Form
    {
        private readonly RichTextBox _content = new RichTextBox();

        public ContentPreviewDialog()
        {
            Text = "完整内容浏览";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = true;
            MinimizeBox = true;
            MinimumSize = new Size(760, 520);
            Size = new Size(980, 720);
            BackColor = UiPalette.Background;
            Font = UiTypography.Ui(9F);
            Padding = new Padding(14);
            _content.Dock = DockStyle.Fill;
            _content.ReadOnly = true;
            _content.BackColor = UiPalette.Surface;
            _content.ForeColor = UiPalette.Text;
            _content.Font = UiTypography.Ui(10F);
            _content.BorderStyle = BorderStyle.None;
            _content.DetectUrls = false;
            _content.WordWrap = true;
            _content.ScrollBars = RichTextBoxScrollBars.Both;
            Controls.Add(_content);
            Shown += delegate { NativeWindowEffects.Apply(Handle); };
        }

        public void UpdateContent(string title, string content)
        {
            Text = string.IsNullOrWhiteSpace(title) ? "完整内容浏览" : "完整内容浏览 · " + title;
            _content.Text = content ?? "";
            _content.SelectionStart = 0;
            _content.SelectionLength = 0;
            _content.ScrollToCaret();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory));
            bool selfTest = args.Length > 0 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase);
            bool structureTest = args.Length > 0 && string.Equals(args[0], "--structure-test", StringComparison.OrdinalIgnoreCase);
            bool tailFileTest = args.Length > 0 && string.Equals(args[0], "--tail-file-test", StringComparison.OrdinalIgnoreCase);
            bool diffExtractTest = args.Length > 0 && string.Equals(args[0], "--diff-extract-test", StringComparison.OrdinalIgnoreCase);
            if (diffExtractTest)
            {
                if (args.Length < 4) throw new ArgumentException("--diff-extract-test requires a patch file, selected path, and output file.");
                string patch = File.ReadAllText(Path.GetFullPath(args[1]), Encoding.UTF8);
                string selected = MainForm.ExtractPatchForFile(patch, args[2]);
                File.WriteAllText(Path.GetFullPath(args[3]), selected, new UTF8Encoding(false));
                return;
            }
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
            ManagerClient manager = new ManagerClient(root);
            Dictionary<string, object> report = new Dictionary<string, object>();
            report["showConfig"] = manager.RunJson("show-config");
            report["plugins"] = manager.RunJson("plugin-list");
            report["sessions"] = manager.RunJson("review-list", new { includeHidden = true, includeArchived = true });
            report["memories"] = manager.RunJson("memory-list", new { limit = 200 });
            report["remoteAgents"] = manager.RunJson("remote-agent-list");
            report["logs"] = manager.RunJson("log-paths");
            report["processes"] = manager.RunJson("portable-processes");
            report["splitterLayout"] = RunSplitterLayoutSelfTest(manager);
            using (MainForm form = new MainForm(root))
            {
                form.CreateControl();
                report["uiTabs"] = FindControls<TabControl>(form).SelectMany(tab => tab.TabPages.Cast<TabPage>()).Select(page => page.Text).ToArray();
                report["uiButtons"] = FindControls<Button>(form).Select(button => button.Text).Where(text => !string.IsNullOrWhiteSpace(text)).Distinct().OrderBy(text => text).ToArray();
                report["nativeWindowTitle"] = form.Text;
                report["brandIcon"] = form.Icon != null && form.Icon.Width > 0 && form.Icon.Height > 0;
            }
            report["passed"] = true;
            Directory.CreateDirectory(Path.GetDirectoryName(output));
            File.WriteAllText(output, new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(report), Encoding.UTF8);
        }

        private static Dictionary<string, object> RunSplitterLayoutSelfTest(ManagerClient manager)
        {
            Dictionary<string, object> report = new Dictionary<string, object>();
            int[] transientWidths = new[] { 120, 240, 480, 820, 940, 1180, 1800 };
            int[] transientHeights = new[] { 90, 180, 360, 520, 700, 980 };

            using (SplitContainer vertical = new SplitContainer { Orientation = Orientation.Vertical, SplitterWidth = 12 })
            {
                SafeSplitLayout.Bind(vertical, 420, 390, 0.55D);
                foreach (int width in transientWidths)
                {
                    vertical.Size = new Size(width, 600);
                    vertical.PerformLayout();
                    AssertSplitterBounds(vertical);
                }
            }

            using (SplitContainer horizontal = new SplitContainer { Orientation = Orientation.Horizontal, SplitterWidth = 12 })
            {
                SafeSplitLayout.Bind(horizontal, 180, 160, 0.62D);
                foreach (int height in transientHeights)
                {
                    horizontal.Size = new Size(900, height);
                    horizontal.PerformLayout();
                    AssertSplitterBounds(horizontal);
                }
            }

            using (OAuthClientsDialog oauth = new OAuthClientsDialog(manager))
            {
                oauth.CreateControl();
                oauth.PerformLayout();
                report["oauthResponsiveColumns"] = FindControls<SplitContainer>(oauth).Count() == 0
                    && FindControls<SurfacePanel>(oauth).Count() >= 2;
            }

            using (RemoteAgentsDialog agents = new RemoteAgentsDialog(manager))
            {
                agents.CreateControl();
                Size[] remoteSizes = new[]
                {
                    new Size(1040, 760),
                    new Size(1120, 800),
                    new Size(1220, 860),
                    new Size(1440, 920),
                };
                foreach (Size size in remoteSizes)
                {
                    agents.Size = size;
                    agents.PerformLayout();
                }
                TextBox commandBox = FindControls<TextBox>(agents).FirstOrDefault(box => box.Multiline && box.ReadOnly);
                RemoteInputHost commandHost = commandBox == null ? null : commandBox.Parent as RemoteInputHost;
                int remoteButtonMinHeight = FindControls<ModernButton>(agents).Select(button => button.Height).DefaultIfEmpty(0).Min();
                int remoteTileCount = FindControls<RemoteAgentTile>(agents).Count();
                int remoteInputCount = FindControls<RemoteInputHost>(agents).Count();
                int remoteCardCount = FindControls<RemoteCard>(agents).Count();
                bool remoteButtonsUnclipped = FindControls<ModernButton>(agents).All(button => button.Parent == null || button.Bottom <= button.Parent.ClientSize.Height + 1);
                Label sshHint = FindControls<Label>(agents).FirstOrDefault(label => (label.Text ?? "").StartsWith("优先通过现有 Agent", StringComparison.Ordinal));
                Label privilegeHint = FindControls<Label>(agents).FirstOrDefault(label => (label.Text ?? "").StartsWith("无管理员权限", StringComparison.Ordinal));
                bool remoteHintsUnclipped = new[] { sshHint, privilegeHint }.All(label =>
                {
                    if (label == null || label.Width <= 0 || label.Height <= 0) return false;
                    Size preferred = label.GetPreferredSize(new Size(Math.Max(1, label.ClientSize.Width - label.Padding.Horizontal), 0));
                    // Label.GetPreferredSize already includes the Label.Padding.
                    // Adding Padding.Vertical a second time made this contract
                    // font-dependent and could fail on the GitHub runner even
                    // when the full wrapped text visibly fit inside the row.
                    return preferred.Height <= label.ClientSize.Height + 1;
                });
                report["remoteAgentsStableLayout"] = FindControls<DataGridView>(agents).Count() == 0
                    && FindControls<TextBox>(agents).Count() >= 3
                    && FindControls<SurfacePanel>(agents).Count() == 0
                    && FindControls<FieldHost>(agents).Count() == 0
                    && remoteCardCount >= 3
                    && remoteInputCount >= 7
                    && remoteTileCount >= 1
                    && remoteButtonMinHeight >= 44
                    && remoteButtonsUnclipped
                    && remoteHintsUnclipped
                    && commandBox != null
                    && commandHost != null
                    && commandHost.Height >= 64;
                report["remoteAgentTileCount"] = remoteTileCount;
                report["remoteAgentInputHostCount"] = remoteInputCount;
                report["remoteAgentCardCount"] = remoteCardCount;
                report["remoteAgentButtonMinHeight"] = remoteButtonMinHeight;
                report["remoteAgentButtonsUnclipped"] = remoteButtonsUnclipped;
                report["remoteAgentHintsUnclipped"] = remoteHintsUnclipped;
                report["remoteAgentSshHintHeight"] = sshHint == null ? 0 : sshHint.ClientSize.Height;
                report["remoteAgentSshHintPreferredHeight"] = sshHint == null ? 0 : sshHint.GetPreferredSize(new Size(Math.Max(1, sshHint.ClientSize.Width - sshHint.Padding.Horizontal), 0)).Height;
                report["remoteAgentPrivilegeHintHeight"] = privilegeHint == null ? 0 : privilegeHint.ClientSize.Height;
                report["remoteAgentPrivilegeHintPreferredHeight"] = privilegeHint == null ? 0 : privilegeHint.GetPreferredSize(new Size(Math.Max(1, privilegeHint.ClientSize.Width - privilegeHint.Padding.Horizontal), 0)).Height;
                report["remoteAgentCommandHostHeight"] = commandHost == null ? 0 : commandHost.Height;
                report["remoteAgentSshAskPass"] = File.Exists(Path.Combine(manager.Root, "DevSpace-SshAskPass.exe"));
                string normalizedSshScript = RemoteAgentsDialog.NormalizeSshScriptForBash("set -eu\r\nfor x in a; do\r\necho $x\rdone");
                bool sshScriptLfOnly = !normalizedSshScript.Contains("\r")
                    && normalizedSshScript.EndsWith("\n", StringComparison.Ordinal)
                    && normalizedSshScript.Contains("set -eu\nfor x in a; do\necho $x\ndone\n");
                report["remoteAgentSshScriptLfOnly"] = sshScriptLfOnly;
                if (!sshScriptLfOnly)
                    throw new InvalidOperationException("SSH rescue shell-script newline normalization regressed.");
                report["remoteAgentSizes"] = remoteSizes.Select(size => size.Width + "x" + size.Height).ToArray();
            }

            // The painted host is taller than a native single-line TextBox.
            // Verify that its lower half remains an active editing hit target
            // instead of becoming a dead Panel region with a normal arrow.
            using (TextBox fieldText = new TextBox { Text = "abcdef" })
            using (FieldHost fieldHost = new FieldHost(fieldText, 280))
            using (TextBox remoteText = new TextBox { Text = "abcdef" })
            using (RemoteInputHost remoteHost = new RemoteInputHost(remoteText, 44))
            using (ModernComboBox combo = new ModernComboBox())
            using (FieldHost comboHost = new FieldHost(combo, 280))
            {
                combo.Items.Add("ngrok");
                combo.Items.Add("cloudflare");
                combo.SelectedIndex = 0;
                fieldHost.Size = new Size(280, 44);
                remoteHost.Size = new Size(280, 44);
                comboHost.Size = new Size(280, 44);
                fieldHost.CreateControl();
                fieldText.CreateControl();
                remoteHost.CreateControl();
                remoteText.CreateControl();
                comboHost.CreateControl();
                combo.CreateControl();
                fieldHost.PerformLayout();
                remoteHost.PerformLayout();
                comboHost.PerformLayout();
                fieldText.SelectionStart = 0;
                remoteText.SelectionStart = 0;
                fieldHost.ActivateInput(new Point(fieldHost.ClientSize.Width - 12, fieldHost.ClientSize.Height - 4));
                remoteHost.ActivateInput(new Point(remoteHost.ClientSize.Width - 12, remoteHost.ClientSize.Height - 4));
                bool fieldHitTarget = fieldHost.Cursor == Cursors.IBeam && fieldText.SelectionStart > 0;
                bool remoteHitTarget = remoteHost.Cursor == Cursors.IBeam && remoteText.SelectionStart > 0;
                bool comboUnclipped = combo.Dock == DockStyle.Fill
                    && combo.ClientSize.Height >= combo.ItemHeight
                    && combo.Bottom <= comboHost.ClientSize.Height - comboHost.Padding.Bottom + 1;
                report["inputHostsFullHitTarget"] = fieldHitTarget && remoteHitTarget;
                report["fieldHostLowerHalfHitTarget"] = fieldHitTarget;
                report["remoteInputLowerHalfHitTarget"] = remoteHitTarget;
                report["comboBoxUnclipped"] = comboUnclipped;
                if (!fieldHitTarget || !remoteHitTarget || !comboUnclipped)
                    throw new InvalidOperationException("Rounded input host lower-half hit testing regressed.");
            }

            report["passed"] = true;
            report["verticalWidths"] = transientWidths;
            report["horizontalHeights"] = transientHeights;
            report["oauthDialog"] = true;
            report["remoteAgentsDialog"] = Convert.ToBoolean(report["remoteAgentsStableLayout"]);
            report["dpiSafeDeferredLayout"] = true;
            return report;
        }

        private static void AssertSplitterBounds(SplitContainer split)
        {
            int extent = split.Orientation == Orientation.Vertical ? split.ClientSize.Width : split.ClientSize.Height;
            int usable = Math.Max(0, extent - Math.Max(1, split.SplitterWidth));
            int distance = split.SplitterDistance;
            if (usable <= 2) return;
            if (distance < split.Panel1MinSize)
                throw new InvalidOperationException("SplitterDistance fell below Panel1MinSize during native UI layout self-test.");
            if (distance > usable - split.Panel2MinSize)
                throw new InvalidOperationException("SplitterDistance exceeded the safe Panel2MinSize bound during native UI layout self-test.");
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

    internal sealed class ManagerClient
    {
        private readonly string _root;
        private readonly string _node;
        private readonly string _manager;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public ManagerClient(string root)
        {
            _root = root;
            _node = Path.Combine(root, "runtime", "node", "node.exe");
            _manager = Path.Combine(root, "setup", "portable-manager.cjs");
            if (!File.Exists(_node)) throw new FileNotFoundException("Bundled Node runtime is missing.", _node);
            if (!File.Exists(_manager)) throw new FileNotFoundException("Portable manager is missing.", _manager);
        }

        public string Root { get { return _root; } }

        public Task<string> RunAsync(string action, object payload = null)
        {
            return Task.Run(() => Run(action, payload));
        }

        public string Run(string action, object payload = null)
        {
            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = _node,
                Arguments = Quote(_manager) + " " + action,
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            info.EnvironmentVariables["DEVSPACE_PORTABLE_ROOT"] = _root;
            info.EnvironmentVariables["DEVSPACE_NATIVE_UI_PID"] = Process.GetCurrentProcess().Id.ToString();
            info.EnvironmentVariables["DEVSPACE_NATIVE_UI_QUEUE_WORKER"] = "1";
            using (Process process = Process.Start(info))
            {
                if (payload != null) process.StandardInput.Write(_json.Serialize(payload));
                process.StandardInput.Close();
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? output : error);
                return output.Trim();
            }
        }

        public Dictionary<string, object> RunJson(string action, object payload = null)
        {
            string text = Run(action, payload);
            object value = _json.DeserializeObject(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public async Task<Dictionary<string, object>> RunJsonAsync(string action, object payload = null)
        {
            string text = await RunAsync(action, payload);
            object value = _json.DeserializeObject(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    }

    internal sealed class OAuthClientsDialog : Form
    {
        private readonly ManagerClient _manager;
        private readonly DataGridView _grid = new DataGridView();
        private readonly TextBox _clientName = new TextBox();
        private readonly TextBox _redirectUris = new TextBox();
        private readonly TextBox _clientId = new TextBox();
        private readonly TextBox _clientSecret = new TextBox();
        private readonly Label _selectionHint = new Label();
        private readonly Label _status = new Label();
        private string _secretForClientId = "";

        public OAuthClientsDialog(ManagerClient manager)
        {
            _manager = manager;
            Text = "AI / MCP OAuth 客户端";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(980, 650);
            Size = new Size(1180, 760);
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            Font = UiTypography.Ui(9.25F);
            BuildUi();
            Shown += async delegate
            {
                NativeWindowEffects.Apply(Handle);
                await LoadClientsAsync();
            };
        }

        private void BuildUi()
        {
            TableLayoutPanel root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                Padding = new Padding(22),
                BackColor = UiPalette.Background,
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));

            Panel intro = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
            Label title = new Label
            {
                Text = "AI / MCP OAuth 客户端",
                Font = UiTypography.Display(16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(4, 4),
            };
            Label hint = new Label
            {
                Text = "统一管理 ChatGPT、Gemini、Claude、IDE 等标准 MCP 客户端。支持 DCR 时自动注册；客户端明确要求 Client ID / Secret 时，再创建手动客户端。",
                Font = UiTypography.Ui(9F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = false,
                AutoEllipsis = true,
                Location = new Point(6, 42),
                Size = new Size(1080, 34),
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right,
            };
            intro.Controls.Add(title);
            intro.Controls.Add(hint);
            root.Controls.Add(intro, 0, 0);

            TableLayoutPanel columns = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = UiPalette.Background,
                Margin = new Padding(0),
            };
            columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
            columns.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
            columns.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            SurfacePanel listSurface = new SurfacePanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(14),
                Margin = new Padding(0, 0, 8, 0),
            };
            TableLayoutPanel listLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                BackColor = Color.Transparent,
                Margin = new Padding(0),
                Padding = new Padding(2),
            };
            listLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            listLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            listLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            Panel listHeader = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
            listHeader.Controls.Add(new Label
            {
                Text = "已注册客户端",
                AutoSize = true,
                Font = UiTypography.Display(11.5F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                Location = new Point(4, 2),
            });
            listHeader.Controls.Add(new Label
            {
                Text = "DCR 与手动客户端都显示在这里。选中一项后，右侧只显示该客户端的凭据。",
                AutoSize = false,
                AutoEllipsis = true,
                Font = UiTypography.Ui(8.6F),
                ForeColor = UiPalette.TextMuted,
                Location = new Point(5, 29),
                Size = new Size(500, 24),
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right,
            });
            ConfigureGrid();
            listLayout.Controls.Add(listHeader, 0, 0);
            listLayout.Controls.Add(_grid, 0, 1);
            FlowLayoutPanel listActions = ButtonBar();
            listActions.Controls.Add(ActionButton("刷新列表", async delegate { await LoadClientsAsync(); }, false));
            listLayout.Controls.Add(listActions, 0, 2);
            listSurface.Controls.Add(listLayout);
            columns.Controls.Add(listSurface, 0, 0);

            SurfacePanel formSurface = new SurfacePanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(14),
                Margin = new Padding(8, 0, 0, 0),
            };
            TableLayoutPanel form = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 14,
                Padding = new Padding(4, 0, 4, 0),
                BackColor = Color.Transparent,
                AutoScroll = true,
            };
            for (int i = 0; i < 14; i++) form.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Label createTitle = new Label
            {
                Text = "创建手动 OAuth 客户端",
                AutoSize = true,
                Font = UiTypography.Display(11.5F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                Margin = new Padding(3, 2, 3, 4),
            };
            Label createHint = new Label
            {
                Text = "仅当 Gemini / Claude 显示“未能自动注册”并要求 Client ID / Secret 时使用。先在目标客户端复制 Redirect URI，再粘贴到这里。",
                AutoSize = false,
                Height = 42,
                Dock = DockStyle.Top,
                Font = UiTypography.Ui(8.6F),
                ForeColor = UiPalette.TextMuted,
                Margin = new Padding(3, 0, 3, 6),
            };
            form.Controls.Add(createTitle, 0, 0);
            form.Controls.Add(createHint, 0, 1);
            form.Controls.Add(FieldLabel("客户端名称"), 0, 2);
            StyleTextBox(_clientName);
            _clientName.Text = "Gemini";
            form.Controls.Add(new FieldHost(_clientName), 0, 3);
            form.Controls.Add(FieldLabel("Redirect URI（每行一个）"), 0, 4);
            StyleTextBox(_redirectUris);
            _redirectUris.Multiline = true;
            _redirectUris.ScrollBars = ScrollBars.Vertical;
            _redirectUris.Height = 82;
            FieldHost redirectHost = new FieldHost(_redirectUris) { Dock = DockStyle.Top, Height = 98 };
            form.Controls.Add(redirectHost, 0, 5);
            FlowLayoutPanel createActions = ButtonBar();
            createActions.Controls.Add(ActionButton("创建客户端", async delegate { await CreateClientAsync(); }, true));
            form.Controls.Add(createActions, 0, 6);

            Label credentialsTitle = new Label
            {
                Text = "选中客户端凭据",
                AutoSize = true,
                Font = UiTypography.Display(11F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                Margin = new Padding(3, 10, 3, 3),
            };
            _selectionHint.AutoSize = false;
            _selectionHint.Height = 34;
            _selectionHint.Dock = DockStyle.Top;
            _selectionHint.Font = UiTypography.Ui(8.5F);
            _selectionHint.ForeColor = UiPalette.TextMuted;
            _selectionHint.Text = "从左侧选择客户端。";
            _selectionHint.Margin = new Padding(3, 0, 3, 4);
            form.Controls.Add(credentialsTitle, 0, 7);
            form.Controls.Add(_selectionHint, 0, 8);
            form.Controls.Add(FieldLabel("Client ID"), 0, 9);
            StyleTextBox(_clientId);
            _clientId.ReadOnly = true;
            form.Controls.Add(new FieldHost(_clientId), 0, 10);
            form.Controls.Add(FieldLabel("Client Secret（仅在创建/轮换后的当前窗口提供）"), 0, 11);
            StyleTextBox(_clientSecret);
            _clientSecret.ReadOnly = true;
            _clientSecret.UseSystemPasswordChar = true;
            form.Controls.Add(new FieldHost(_clientSecret), 0, 12);
            FlowLayoutPanel manageActions = ButtonBar();
            manageActions.Controls.Add(ActionButton("复制 Client ID", delegate { CopyText(_clientId.Text, "Client ID"); }, false));
            manageActions.Controls.Add(ActionButton("复制 Client Secret", delegate { CopyText(_clientSecret.Text, "Client Secret"); }, false));
            manageActions.Controls.Add(ActionButton("显示 / 隐藏 Secret", delegate { ToggleSecretVisibility(); }, false));
            manageActions.Controls.Add(ActionButton("轮换 Secret", async delegate { await RotateSecretAsync(); }, false));
            manageActions.Controls.Add(ActionButton("删除并撤销", async delegate { await DeleteClientAsync(); }, false, true));
            form.Controls.Add(manageActions, 0, 13);
            formSurface.Controls.Add(form);
            columns.Controls.Add(formSurface, 1, 0);
            root.Controls.Add(columns, 0, 1);

            _status.Dock = DockStyle.Fill;
            _status.ForeColor = UiPalette.TextMuted;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Text = "准备读取 OAuth 客户端。";
            root.Controls.Add(_status, 0, 2);
            Controls.Add(root);
        }

        private void ConfigureGrid()
        {
            _grid.Dock = DockStyle.Fill;
            _grid.BackgroundColor = UiPalette.Surface;
            _grid.BorderStyle = BorderStyle.None;
            _grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            _grid.GridColor = UiPalette.Border;
            _grid.AllowUserToAddRows = false;
            _grid.AllowUserToDeleteRows = false;
            _grid.AllowUserToResizeRows = false;
            _grid.MultiSelect = false;
            _grid.ReadOnly = true;
            _grid.RowHeadersVisible = false;
            _grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            _grid.AutoGenerateColumns = false;
            _grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            _grid.ColumnHeadersHeight = 36;
            _grid.RowTemplate.Height = 34;
            _grid.EnableHeadersVisualStyles = false;
            _grid.ColumnHeadersDefaultCellStyle.BackColor = UiPalette.SurfaceMuted;
            _grid.ColumnHeadersDefaultCellStyle.ForeColor = UiPalette.TextMuted;
            _grid.DefaultCellStyle.BackColor = UiPalette.Surface;
            _grid.DefaultCellStyle.ForeColor = UiPalette.Text;
            _grid.DefaultCellStyle.SelectionBackColor = UiPalette.PrimarySoft;
            _grid.DefaultCellStyle.SelectionForeColor = UiPalette.Text;
            _grid.DefaultCellStyle.Padding = new Padding(6, 0, 6, 0);
            _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "ClientName", HeaderText = "客户端", FillWeight = 27 });
            _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Kind", HeaderText = "类型", FillWeight = 12 });
            _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Auth", HeaderText = "认证", FillWeight = 16 });
            _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = "Redirect", HeaderText = "Redirect URI", FillWeight = 45 });
            _grid.SelectionChanged += delegate { SelectCurrentClient(); };
        }

        private async Task LoadClientsAsync()
        {
            try
            {
                string priorId = SelectedClientId();
                _status.Text = "正在读取 OAuth 客户端……";
                Dictionary<string, object> result = await _manager.RunJsonAsync("oauth-client-list");
                _grid.Rows.Clear();
                foreach (Dictionary<string, object> client in Dictionaries(result, "clients"))
                {
                    string id = ValueText(client, "clientId");
                    string redirect = Strings(client, "redirectUris").FirstOrDefault() ?? "";
                    int rowIndex = _grid.Rows.Add(
                        ValueText(client, "clientName"),
                        Bool(client, "manual") ? "手动" : "DCR",
                        ValueText(client, "tokenEndpointAuthMethod"),
                        redirect);
                    _grid.Rows[rowIndex].Tag = client;
                    _grid.Rows[rowIndex].Cells[0].ToolTipText = id;
                }
                _status.Text = "已读取 " + _grid.Rows.Count + " 个 OAuth 客户端。DCR 客户端由 ChatGPT/Gemini 等支持动态注册的工具自动创建。";
                string targetId = !string.IsNullOrWhiteSpace(_secretForClientId) ? _secretForClientId : priorId;
                if (!string.IsNullOrWhiteSpace(targetId)) SelectClientById(targetId);
                if (_grid.SelectedRows.Count != 1 && _grid.Rows.Count > 0)
                {
                    _grid.ClearSelection();
                    _grid.Rows[0].Selected = true;
                    _grid.CurrentCell = _grid.Rows[0].Cells[0];
                }
                else ClearSelectionFields();
            }
            catch (Exception ex)
            {
                _status.Text = "读取失败：" + ex.Message;
            }
        }

        private async Task CreateClientAsync()
        {
            string[] redirects = _redirectUris.Lines.Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
            if (redirects.Length == 0)
            {
                MessageBox.Show(this, "请先从 Gemini、Claude 或其它客户端复制 Redirect URI，并粘贴到这里。", "需要 Redirect URI", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Dictionary<string, object> result = await _manager.RunJsonAsync("oauth-client-create", new
                {
                    clientName = _clientName.Text.Trim(),
                    redirectUris = redirects,
                });
                Dictionary<string, object> client = Dictionary(result, "client");
                string createdId = ValueText(client, "clientId");
                string createdSecret = ValueText(result, "clientSecret");
                _clientId.Text = createdId;
                _clientSecret.Text = createdSecret;
                _secretForClientId = createdId;
                await LoadClientsAsync();
                _secretForClientId = createdId;
                _clientSecret.Text = createdSecret;
                SelectClientById(createdId);
                _status.Text = "客户端已创建。现在依次复制 Client ID 和 Client Secret 到目标 AI 客户端；Secret 关闭此窗口后不会再次显示。";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "创建 OAuth 客户端失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task RotateSecretAsync()
        {
            string id = SelectedClientId();
            if (string.IsNullOrWhiteSpace(id)) return;
            Dictionary<string, object> selected = SelectedClient();
            if (!Bool(selected, "manual"))
            {
                MessageBox.Show(this, "动态注册客户端的凭据由对应 AI 客户端管理。需要手动密钥时，请新建一个手动 OAuth 客户端。", "不能轮换 DCR 客户端", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (MessageBox.Show(this, "轮换 Secret 会立即撤销这个客户端现有的 Access/Refresh Token，需要在 AI 客户端重新授权。继续吗？", "轮换 Client Secret", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            try
            {
                Dictionary<string, object> result = await _manager.RunJsonAsync("oauth-client-rotate-secret", new { clientId = id });
                string rotatedSecret = ValueText(result, "clientSecret");
                _clientId.Text = id;
                _clientSecret.Text = rotatedSecret;
                _secretForClientId = id;
                await LoadClientsAsync();
                _secretForClientId = id;
                _clientSecret.Text = rotatedSecret;
                SelectClientById(id);
                _status.Text = "Client Secret 已轮换，旧 Token 已撤销。请立即把新 Secret 更新到目标 AI 客户端。";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "轮换失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task DeleteClientAsync()
        {
            string id = SelectedClientId();
            if (string.IsNullOrWhiteSpace(id)) return;
            if (MessageBox.Show(this, "删除此 OAuth 客户端会同时撤销它现有的 Access/Refresh Token。确定继续吗？", "删除 OAuth 客户端", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            try
            {
                await _manager.RunJsonAsync("oauth-client-delete", new { clientId = id });
                ClearSelectionFields();
                _status.Text = "OAuth 客户端及其 Token 已删除。";
                await LoadClientsAsync();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "删除失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void SelectCurrentClient()
        {
            Dictionary<string, object> client = SelectedClient();
            if (client.Count == 0) return;
            string id = ValueText(client, "clientId");
            _clientId.Text = id;
            if (!string.Equals(_secretForClientId, id, StringComparison.Ordinal)) _clientSecret.Text = "";
            _selectionHint.Text = Bool(client, "manual")
                ? "手动客户端：可复制 Client ID；Secret 仅在创建或轮换后的当前窗口可见。"
                : "DCR 客户端：凭据由对应工具自动管理，不提供可手动复用的 Client Secret。";
        }

        private void SelectClientById(string clientId)
        {
            foreach (DataGridViewRow row in _grid.Rows)
            {
                Dictionary<string, object> client = row.Tag as Dictionary<string, object>;
                if (client != null && string.Equals(ValueText(client, "clientId"), clientId, StringComparison.Ordinal))
                {
                    _grid.ClearSelection();
                    row.Selected = true;
                    _grid.CurrentCell = row.Cells[0];
                    SelectCurrentClient();
                    break;
                }
            }
        }

        private Dictionary<string, object> SelectedClient()
        {
            if (_grid.SelectedRows.Count != 1) return new Dictionary<string, object>();
            return _grid.SelectedRows[0].Tag as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        private string SelectedClientId() { return ValueText(SelectedClient(), "clientId"); }

        private void ClearSelectionFields()
        {
            _clientId.Text = "";
            _clientSecret.Text = "";
            _secretForClientId = "";
            _selectionHint.Text = "从左侧选择客户端。";
        }

        private void ToggleSecretVisibility()
        {
            if (string.IsNullOrWhiteSpace(_clientSecret.Text))
            {
                MessageBox.Show(this, "当前没有可显示的 Client Secret。手动客户端的 Secret 只在创建或轮换后的当前窗口提供。", "没有 Client Secret", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            _clientSecret.UseSystemPasswordChar = !_clientSecret.UseSystemPasswordChar;
            _clientSecret.Refresh();
        }

        private void CopyText(string value, string label)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                MessageBox.Show(this, label + " 当前不可用。Client Secret 只在创建或轮换后提供。", "没有可复制内容", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Clipboard.SetText(value);
            _status.Text = label + " 已复制到剪贴板。";
        }

        private static Label FieldLabel(string text)
        {
            return new Label { Text = text, AutoSize = true, Font = UiTypography.Ui(9F, FontStyle.Bold), ForeColor = UiPalette.TextMuted, Margin = new Padding(3, 8, 3, 3) };
        }

        private static void StyleTextBox(TextBox box)
        {
            box.Dock = DockStyle.Fill;
            box.Font = UiTypography.Ui(9.25F);
            box.BackColor = UiPalette.SurfaceMuted;
            box.ForeColor = UiPalette.Text;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Margin = new Padding(0, 2, 0, 4);
        }

        private static FlowLayoutPanel ButtonBar()
        {
            return new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, WrapContents = true, BackColor = Color.Transparent, Margin = new Padding(0, 4, 0, 8) };
        }

        private static Button ActionButton(string text, EventHandler handler, bool primary, bool danger = false)
        {
            ModernButton button = new ModernButton
            {
                Text = text,
                AutoSize = true,
                Primary = primary,
                Danger = danger,
                MinimumSize = new Size(104, 40),
                Padding = new Padding(14, 0, 14, 0),
                Margin = new Padding(3),
            };
            button.Click += handler;
            return button;
        }

        private static Dictionary<string, object> Dictionary(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>();
        }

        private static IEnumerable<Dictionary<string, object>> Dictionaries(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null || value is string) yield break;
            IEnumerable items = value as IEnumerable;
            if (items == null) yield break;
            foreach (object item in items)
            {
                Dictionary<string, object> dictionary = item as Dictionary<string, object>;
                if (dictionary != null) yield return dictionary;
            }
        }

        private static string ValueText(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }

        private static bool Bool(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value != null && Convert.ToBoolean(value);
        }

        private static List<string> Strings(Dictionary<string, object> source, string key)
        {
            object value;
            List<string> values = new List<string>();
            if (source == null || !source.TryGetValue(key, out value) || value == null || value is string) return values;
            IEnumerable items = value as IEnumerable;
            if (items == null) return values;
            foreach (object item in items) values.Add(Convert.ToString(item));
            return values;
        }
    }

    internal sealed class RemoteAgentTile : Control
    {
        private bool _hover;
        private bool _selected;
        private bool _placeholder;
        private string _name = "";
        private string _status = "";
        private string _host = "";
        private string _agentId = "";
        private string _version = "";
        private string _roots = "";

        public bool Selected
        {
            get { return _selected; }
            set { if (_selected != value) { _selected = value; Invalidate(); } }
        }

        public RemoteAgentTile()
        {
            Height = 118;
            MinimumSize = new Size(330, 118);
            Margin = new Padding(6);
            Cursor = Cursors.Hand;
            TabStop = true;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            BackColor = UiPalette.Surface;
        }

        public void SetAgent(string name, string status, string host, string agentId, string version, string roots, bool placeholder = false)
        {
            _name = name ?? "";
            _status = status ?? "";
            _host = host ?? "";
            _agentId = agentId ?? "";
            _version = version ?? "";
            _roots = roots ?? "";
            _placeholder = placeholder;
            Cursor = placeholder ? Cursors.Default : Cursors.Hand;
            Invalidate();
        }

        protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(UiPalette.Surface);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            if (ClientSize.Width <= 2 || ClientSize.Height <= 2) return;
            Rectangle bounds = new Rectangle(2, 2, Width - 5, Height - 5);
            Color fill = _selected
                ? UiPalette.PrimarySoft
                : _hover && !_placeholder ? Color.FromArgb(248, 249, 255) : UiPalette.Surface;
            Color borderColor = _selected || Focused ? UiPalette.Primary : (_hover && !_placeholder ? UiPalette.BorderStrong : UiPalette.Border);
            float borderWidth = _selected || Focused ? 1.8F : 1.0F;
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 18))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen border = new Pen(borderColor, borderWidth))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(border, path);
            }

            if (_placeholder)
            {
                using (Font titleFont = UiTypography.Ui(11F, FontStyle.Bold))
                    TextRenderer.DrawText(e.Graphics, string.IsNullOrWhiteSpace(_name) ? "尚未登记 Linux Agent" : _name, titleFont,
                        new Rectangle(24, 28, Math.Max(0, Width - 48), 28), UiPalette.Text,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
                using (Font detailFont = UiTypography.Ui(9F))
                    TextRenderer.DrawText(e.Graphics, string.IsNullOrWhiteSpace(_roots) ? "生成一次性安装命令并在目标 Ubuntu 执行，Agent 会自动出现在这里。" : _roots, detailFont,
                        new Rectangle(24, 61, Math.Max(0, Width - 48), 28), UiPalette.TextMuted,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
                return;
            }

            Color statusColor = StatusColor(_status);
            using (SolidBrush dot = new SolidBrush(statusColor)) e.Graphics.FillEllipse(dot, 22, 24, 12, 12);
            using (Font titleFont = UiTypography.Ui(11.2F, FontStyle.Bold))
                TextRenderer.DrawText(e.Graphics, string.IsNullOrWhiteSpace(_name) ? "Linux Agent" : _name, titleFont,
                    new Rectangle(44, 16, Math.Max(0, Width - 220), 28), UiPalette.Text,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);

            string statusText = string.IsNullOrWhiteSpace(_status) ? "unknown" : _status;
            using (Font pillFont = UiTypography.Ui(8.4F, FontStyle.Bold))
            {
                int pillWidth = Math.Min(142, Math.Max(72, TextRenderer.MeasureText(statusText, pillFont).Width + 20));
                Rectangle pill = new Rectangle(Math.Max(48, Width - pillWidth - 20), 16, pillWidth, 28);
                using (GraphicsPath pillPath = DrawingUtil.Rounded(pill, 14))
                using (SolidBrush pillFill = new SolidBrush(Color.FromArgb(22, statusColor))) e.Graphics.FillPath(pillFill, pillPath);
                TextRenderer.DrawText(e.Graphics, statusText, pillFont, pill, statusColor,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            }

            string hostLine = string.IsNullOrWhiteSpace(_version) ? _host : _host + "   ·   v" + _version;
            using (Font metaFont = UiTypography.Ui(8.9F))
                TextRenderer.DrawText(e.Graphics, string.IsNullOrWhiteSpace(hostLine) ? "主机信息待 Agent 上报" : hostLine, metaFont,
                    new Rectangle(22, 49, Math.Max(0, Width - 44), 20), UiPalette.TextMuted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            using (Font codeFont = UiTypography.Code(8.5F))
                TextRenderer.DrawText(e.Graphics, _agentId, codeFont,
                    new Rectangle(22, 72, Math.Max(0, Width - 44), 18), UiPalette.Text,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
            using (Font rootFont = UiTypography.Ui(8.7F))
                TextRenderer.DrawText(e.Graphics, _roots, rootFont,
                    new Rectangle(22, 94, Math.Max(0, Width - 44), 17), UiPalette.TextMuted,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        }

        private static Color StatusColor(string status)
        {
            string value = (status ?? "").Trim().ToLowerInvariant();
            if (value.StartsWith("online", StringComparison.Ordinal)) return UiPalette.Success;
            if (value.Contains("revoked")) return UiPalette.Danger;
            if (value.Contains("offline") || value.Contains("stale")) return Color.FromArgb(150, 159, 178);
            return UiPalette.Primary;
        }
    }

    internal sealed class RemoteInputHost : Panel
    {
        private readonly TextBox _textBox;

        public RemoteInputHost(TextBox textBox, int height)
        {
            _textBox = textBox;
            Height = height;
            MinimumSize = new Size(60, height);
            Margin = new Padding(3, 2, 3, 6);
            Padding = textBox.Multiline ? new Padding(12, 9, 10, 9) : new Padding(12, 8, 10, 7);
            BackColor = UiPalette.Surface;
            textBox.BorderStyle = BorderStyle.None;
            textBox.BackColor = UiPalette.SurfaceMuted;
            textBox.ForeColor = UiPalette.Text;
            textBox.Font = UiTypography.Ui(9.25F);
            textBox.Dock = textBox.Multiline ? DockStyle.Fill : DockStyle.None;
            if (!textBox.Multiline) textBox.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            textBox.Margin = new Padding(0);
            Controls.Add(textBox);
            textBox.Enter += delegate { Invalidate(); };
            textBox.Leave += delegate { Invalidate(); };
            Cursor = Cursors.IBeam;
            Resize += delegate { LayoutTextBox(); };
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            LayoutTextBox();
        }

        private void LayoutTextBox()
        {
            if (_textBox.Multiline) return;
            int left = Padding.Left;
            int width = Math.Max(1, ClientSize.Width - Padding.Horizontal);
            int preferredHeight = Math.Max(1, _textBox.PreferredSize.Height);
            int top = Math.Max(Padding.Top, (ClientSize.Height - preferredHeight) / 2);
            _textBox.Bounds = new Rectangle(left, top, width, Math.Min(preferredHeight, Math.Max(1, ClientSize.Height - top - Padding.Bottom)));
        }

        internal void ActivateInput(Point hostPoint)
        {
            if (!_textBox.Enabled) return;
            _textBox.Focus();
            Point local = new Point(
                Math.Max(0, Math.Min(_textBox.ClientSize.Width - 1, hostPoint.X - _textBox.Left)),
                Math.Max(0, Math.Min(_textBox.ClientSize.Height - 1, hostPoint.Y - _textBox.Top)));
            int index = _textBox.GetCharIndexFromPosition(local);
            _textBox.SelectionStart = Math.Max(0, Math.Min(index, _textBox.TextLength));
            _textBox.SelectionLength = 0;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) ActivateInput(e.Location);
            base.OnMouseDown(e);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(UiPalette.Surface);
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 12))
            using (SolidBrush fill = new SolidBrush(UiPalette.SurfaceMuted)) e.Graphics.FillPath(fill, path);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (ClientSize.Width <= 2 || ClientSize.Height <= 2) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 12))
            using (Pen border = new Pen(ContainsFocus ? UiPalette.Primary : UiPalette.BorderStrong, ContainsFocus ? 1.8F : 1.1F))
                e.Graphics.DrawPath(border, path);
        }
    }

    internal sealed class RemoteCard : Panel
    {
        public RemoteCard()
        {
            Padding = new Padding(16);
            Margin = new Padding(0, 4, 0, 8);
            BackColor = UiPalette.Background;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(UiPalette.Background);
            Rectangle bounds = new Rectangle(1, 1, Math.Max(1, Width - 3), Math.Max(1, Height - 3));
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 20))
            using (SolidBrush fill = new SolidBrush(UiPalette.Surface))
            using (Pen border = new Pen(UiPalette.Border))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
        }
    }

    internal sealed class RemoteAgentsDialog : Form
    {
        private readonly ManagerClient _manager;
        private readonly FlowLayoutPanel _agentTiles = new FlowLayoutPanel();
        private readonly TextBox _name = new TextBox();
        private readonly TextBox _roots = new TextBox();
        private readonly TextBox _installCommand = new TextBox();
        private readonly TextBox _sshHost = new TextBox();
        private readonly TextBox _sshPort = new TextBox();
        private readonly TextBox _sshUser = new TextBox();
        private readonly TextBox _sshPassword = new TextBox();
        private readonly CheckBox _sshAutoRecover = new CheckBox();
        private readonly System.Windows.Forms.Timer _sshRecoveryTimer = new System.Windows.Forms.Timer { Interval = 30000 };
        private readonly Label _status = new Label();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private Dictionary<string, object> _selectedAgent = new Dictionary<string, object>();
        private bool _sshBusy;
        private static readonly Dictionary<string, DateTime> BackgroundSshAttempts = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        private sealed class StoredSshProfile
        {
            public string Key { get; set; }
            public string Host { get; set; }
            public int Port { get; set; }
            public string UserName { get; set; }
            public string ProtectedPassword { get; set; }
            public bool AutoRecover { get; set; }
        }

        private sealed class StoredSshProfiles
        {
            public List<StoredSshProfile> Profiles { get; set; } = new List<StoredSshProfile>();
        }

        public RemoteAgentsDialog(ManagerClient manager)
        {
            _manager = manager;
            Text = "远程服务器 / Linux Agent";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(1040, 900);
            Size = new Size(1220, 1020);
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            Font = UiTypography.Ui(9.25F);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BuildUi();
            Resize += delegate { ResizeAgentTiles(); Invalidate(true); };
            _sshRecoveryTimer.Tick += async delegate { await AutoRecoverSelectedAgentAsync(); };
            FormClosed += delegate { _sshRecoveryTimer.Stop(); };
            Shown += async delegate
            {
                NativeWindowEffects.Apply(Handle);
                await LoadAgentsAsync();
                _sshRecoveryTimer.Start();
            };
        }

        private void BuildUi()
        {
            TableLayoutPanel root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 5,
                Padding = new Padding(22),
                BackColor = UiPalette.Background,
                AutoScroll = true,
            };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
            // Keep the Remote Agent cards at a stable preferred height and let
            // the outer dialog scroll vertically on shorter screens. The old
            // Percent row silently donated height from the two lower cards;
            // at 125%-150% DPI their explanatory labels were partially hidden
            // behind the rounded card border even though the controls existed.
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 226));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 220));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 400));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));

            Panel intro = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
            Label title = new Label
            {
                Text = "远程服务器 / Linux Agent",
                Font = UiTypography.Display(16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(4, 4),
            };
            Label hint = new Label
            {
                Text = "Ubuntu 只运行轻量出站 Agent；MCP/OAuth、审阅与权限控制仍由本机 DevSpace 负责。Agent 额外受 allowedRoots 与 Linux 用户权限约束。",
                Font = UiTypography.Ui(9F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = false,
                AutoEllipsis = true,
                Location = new Point(6, 42),
                Size = new Size(1080, 32),
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right,
            };
            intro.Controls.Add(title);
            intro.Controls.Add(hint);
            root.Controls.Add(intro, 0, 0);

            RemoteCard agentCard = new RemoteCard { Dock = DockStyle.Fill, Padding = new Padding(16), Margin = new Padding(0, 0, 0, 8) };
            TableLayoutPanel agentSection = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                BackColor = UiPalette.Surface,
                Margin = new Padding(0),
            };
            agentSection.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            agentSection.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            TableLayoutPanel agentHeader = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = UiPalette.Surface, Margin = new Padding(0) };
            agentHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            agentHeader.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            agentHeader.Controls.Add(new Label
            {
                Text = "已登记的远程服务器",
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Font = UiTypography.Display(11.5F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                Margin = new Padding(4, 0, 0, 0),
            }, 0, 0);
            agentHeader.Controls.Add(new Label
            {
                Text = "点击磁贴选择 Agent",
                AutoSize = true,
                Anchor = AnchorStyles.Right,
                Font = UiTypography.Ui(8.7F),
                ForeColor = UiPalette.TextMuted,
                Margin = new Padding(8, 0, 4, 0),
            }, 1, 0);
            _agentTiles.Dock = DockStyle.Fill;
            _agentTiles.AutoScroll = true;
            _agentTiles.WrapContents = true;
            _agentTiles.FlowDirection = FlowDirection.LeftToRight;
            _agentTiles.BackColor = UiPalette.Surface;
            _agentTiles.Padding = new Padding(0, 2, 0, 4);
            _agentTiles.Margin = new Padding(0);
            _agentTiles.SizeChanged += delegate { ResizeAgentTiles(); };
            RemoteAgentTile loadingTile = new RemoteAgentTile();
            loadingTile.SetAgent("正在读取 Linux Agent", "", "", "", "", "正在从本机 DevSpace 控制端读取登记记录与 heartbeat 状态……", true);
            _agentTiles.Controls.Add(loadingTile);
            agentSection.Controls.Add(agentHeader, 0, 0);
            agentSection.Controls.Add(_agentTiles, 0, 1);
            agentCard.Controls.Add(agentSection);
            root.Controls.Add(agentCard, 0, 1);

            RemoteCard sshCard = new RemoteCard { Dock = DockStyle.Fill, Padding = new Padding(16), Margin = new Padding(0, 4, 0, 6) };
            TableLayoutPanel sshLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                BackColor = UiPalette.Surface,
                Margin = new Padding(0),
            };
            sshLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
            sshLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            sshLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            TableLayoutPanel sshFields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 2, BackColor = UiPalette.Surface, Margin = new Padding(0) };
            sshFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
            sshFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 12));
            sshFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24));
            sshFields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
            sshFields.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            sshFields.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            sshFields.Controls.Add(FieldLabel("服务器 IP / 主机名"), 0, 0);
            sshFields.Controls.Add(FieldLabel("SSH 端口"), 1, 0);
            sshFields.Controls.Add(FieldLabel("用户名"), 2, 0);
            sshFields.Controls.Add(FieldLabel("密码（Windows 用户级加密保存）"), 3, 0);
            StyleTextBox(_sshHost);
            StyleTextBox(_sshPort);
            StyleTextBox(_sshUser);
            StyleTextBox(_sshPassword);
            _sshPort.Text = "22";
            _sshUser.Text = "ubuntu";
            _sshPassword.UseSystemPasswordChar = true;
            sshFields.Controls.Add(new RemoteInputHost(_sshHost, 44) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 8, 5) }, 0, 1);
            sshFields.Controls.Add(new RemoteInputHost(_sshPort, 44) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 8, 5) }, 1, 1);
            sshFields.Controls.Add(new RemoteInputHost(_sshUser, 44) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 8, 5) }, 2, 1);
            sshFields.Controls.Add(new RemoteInputHost(_sshPassword, 44) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 2, 5) }, 3, 1);
            sshLayout.Controls.Add(sshFields, 0, 0);

            FlowLayoutPanel sshActions = ButtonBar();
            sshActions.WrapContents = false;
            sshActions.Controls.Add(ActionButton("保存 SSH 配置", delegate { SaveCurrentSshProfile(true); }, false, false, 138));
            sshActions.Controls.Add(ActionButton("测试 SSH", async delegate { await TestSshAsync(); }, false, false, 116));
            sshActions.Controls.Add(ActionButton("一键恢复 / 安装 Agent", async delegate { await RecoverAgentViaSshAsync(false); }, true, false, 190));
            _sshAutoRecover.Text = "选中 Agent 离线时自动尝试 SSH 救援";
            _sshAutoRecover.AutoSize = true;
            _sshAutoRecover.ForeColor = UiPalette.TextMuted;
            _sshAutoRecover.Font = UiTypography.Ui(8.8F);
            _sshAutoRecover.Margin = new Padding(12, 14, 4, 0);
            sshActions.Controls.Add(_sshAutoRecover);
            sshLayout.Controls.Add(sshActions, 0, 1);

            Label sshHint = new Label
            {
                Text = "优先通过现有 Agent 连接。仅当 Agent 离线时才使用 SSH 救援：先重启已有 Agent；若服务器尚未安装，再自动生成一次性 enrollment 并安装。手动安装命令始终保留为最终 fallback。",
                Dock = DockStyle.Fill,
                AutoEllipsis = false,
                TextAlign = ContentAlignment.TopLeft,
                Font = UiTypography.Ui(8.6F),
                ForeColor = UiPalette.TextMuted,
                Padding = new Padding(5, 6, 5, 0),
                Margin = new Padding(0),
            };
            sshLayout.Controls.Add(sshHint, 0, 2);
            sshCard.Controls.Add(sshLayout);
            root.Controls.Add(sshCard, 0, 2);

            RemoteCard formCard = new RemoteCard { Dock = DockStyle.Fill, Padding = new Padding(16), Margin = new Padding(0, 4, 0, 6) };
            TableLayoutPanel form = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 5,
                BackColor = UiPalette.Surface,
                Margin = new Padding(0),
            };
            form.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));
            form.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            form.RowStyles.Add(new RowStyle(SizeType.Absolute, 98));
            form.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
            form.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            TableLayoutPanel fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, BackColor = UiPalette.Surface, Margin = new Padding(0) };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 66));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            fields.Controls.Add(FieldLabel("服务器显示名"), 0, 0);
            fields.Controls.Add(FieldLabel("Linux allowedRoots（每行一个）"), 1, 0);
            StyleTextBox(_name);
            _name.Text = "gpu-server";
            RemoteInputHost nameHost = new RemoteInputHost(_name, 44) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 10, 5) };
            fields.Controls.Add(nameHost, 0, 1);
            StyleTextBox(_roots);
            _roots.Multiline = true;
            _roots.ScrollBars = ScrollBars.Vertical;
            _roots.Text = "/home/ubuntu/workspace";
            RemoteInputHost rootsHost = new RemoteInputHost(_roots, 52) { Dock = DockStyle.Fill, Margin = new Padding(2, 1, 2, 5) };
            fields.Controls.Add(rootsHost, 1, 1);
            form.Controls.Add(fields, 0, 0);

            FlowLayoutPanel actions = ButtonBar();
            actions.WrapContents = false;
            actions.Controls.Add(ActionButton("生成一次性安装命令", async delegate { await CreateEnrollmentAsync(); }, true, false, 176));
            actions.Controls.Add(ActionButton("刷新列表", async delegate { await LoadAgentsAsync(); }, false));
            actions.Controls.Add(ActionButton("撤销选中 Agent", async delegate { await RevokeSelectedAsync(); }, false, true, 138));
            actions.Controls.Add(ActionButton("删除选中记录", async delegate { await DeleteSelectedAsync(); }, false, true, 138));
            form.Controls.Add(actions, 0, 1);

            TableLayoutPanel commandBlock = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, BackColor = UiPalette.Surface, Margin = new Padding(0) };
            commandBlock.RowStyles.Add(new RowStyle(SizeType.Absolute, 27));
            commandBlock.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            commandBlock.Controls.Add(FieldLabel("一次性安装命令（默认无 sudo，当前 Linux 用户安装）"), 0, 0);
            StyleTextBox(_installCommand);
            _installCommand.Multiline = true;
            _installCommand.ScrollBars = ScrollBars.Both;
            _installCommand.WordWrap = false;
            _installCommand.ReadOnly = true;
            RemoteInputHost commandHost = new RemoteInputHost(_installCommand, 68) { Dock = DockStyle.Fill, Margin = new Padding(2, 0, 2, 4) };
            commandBlock.Controls.Add(commandHost, 0, 1);
            form.Controls.Add(commandBlock, 0, 2);

            TableLayoutPanel copyBar = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = UiPalette.Surface,
                Margin = new Padding(0),
            };
            copyBar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 164));
            copyBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            copyBar.Controls.Add(ActionButton("复制安装命令", delegate { CopyInstallCommand(); }, false, false, 146), 0, 0);
            Label enrollmentHint = new Label
            {
                Text = "默认不需要 sudo。Token 默认 15 分钟有效；ACK 前断线可在 2 分钟恢复窗口内安全重试，确认成功后立即失效。",
                AutoSize = false,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = UiPalette.TextMuted,
                Font = UiTypography.Ui(8.8F),
                Padding = new Padding(6, 0, 0, 0),
            };
            copyBar.Controls.Add(enrollmentHint, 1, 0);
            form.Controls.Add(copyBar, 0, 3);
            Label privilegeHint = new Label
            {
                Text = "无管理员权限：安装到当前用户可写状态目录并后台运行；若当前用户可写旧 /var/lib/devspace-agent，则自动原位升级。只有显式使用 sudo 执行安装器时才走系统级安装。",
                Dock = DockStyle.Fill,
                AutoEllipsis = false,
                TextAlign = ContentAlignment.TopLeft,
                Font = UiTypography.Ui(8.6F),
                ForeColor = UiPalette.TextMuted,
                Padding = new Padding(5, 7, 5, 0),
                Margin = new Padding(0),
            };
            form.Controls.Add(privilegeHint, 0, 4);
            formCard.Controls.Add(form);
            root.Controls.Add(formCard, 0, 3);

            _status.Dock = DockStyle.Fill;
            _status.ForeColor = UiPalette.TextMuted;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Text = "准备读取远程 Agent。";
            root.Controls.Add(_status, 0, 4);
            Controls.Add(root);
        }

        private void ResizeAgentTiles()
        {
            if (_agentTiles.IsDisposed || _agentTiles.ClientSize.Width <= 0) return;
            int available = Math.Max(320, _agentTiles.ClientSize.Width - _agentTiles.Padding.Horizontal - SystemInformation.VerticalScrollBarWidth - 8);
            int columns = available >= 760 ? 2 : 1;
            int width = Math.Max(330, (available - (columns * 12)) / columns);
            foreach (RemoteAgentTile tile in _agentTiles.Controls.OfType<RemoteAgentTile>())
                tile.Width = width;
        }

        private async Task LoadAgentsAsync()
        {
            try
            {
                Dictionary<string, object> result = await _manager.RunJsonAsync("remote-agent-list");
                string selectedId = ValueText(_selectedAgent, "id");
                _agentTiles.SuspendLayout();
                _agentTiles.Controls.Clear();
                _selectedAgent = new Dictionary<string, object>();
                int count = 0;
                foreach (Dictionary<string, object> agent in Dictionaries(result, "agents"))
                {
                    RemoteAgentTile tile = new RemoteAgentTile { Tag = agent };
                    tile.SetAgent(
                        ValueText(agent, "name"),
                        ValueText(agent, "status"),
                        ValueText(agent, "hostname"),
                        ValueText(agent, "id"),
                        ValueText(agent, "agentVersion"),
                        string.Join("  ·  ", Strings(agent, "allowedRoots")));
                    tile.Click += delegate { SelectAgentTile(tile); };
                    tile.KeyDown += delegate (object sender, KeyEventArgs args)
                    {
                        if (args.KeyCode == Keys.Enter || args.KeyCode == Keys.Space)
                        {
                            SelectAgentTile(tile);
                            args.Handled = true;
                        }
                    };
                    _agentTiles.Controls.Add(tile);
                    count++;
                    if (!string.IsNullOrWhiteSpace(selectedId) && string.Equals(selectedId, ValueText(agent, "id"), StringComparison.Ordinal))
                        SelectAgentTile(tile);
                }
                if (count == 0)
                {
                    RemoteAgentTile empty = new RemoteAgentTile();
                    empty.SetAgent("尚未登记 Linux Agent", "", "", "", "", "生成一次性安装命令并在目标 Ubuntu 执行，Agent 会自动出现在这里。", true);
                    _agentTiles.Controls.Add(empty);
                }
                _agentTiles.ResumeLayout(true);
                ResizeAgentTiles();
                _status.Text = "已登记 " + count + " 个 Linux Agent。绿色状态磁贴表示最近 heartbeat 正常。";
            }
            catch (Exception ex)
            {
                _status.Text = "读取 Agent 失败：" + ex.Message;
            }
        }

        private async Task CreateEnrollmentAsync()
        {
            string[] roots = _roots.Lines.Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
            if (string.IsNullOrWhiteSpace(_name.Text) || roots.Length == 0)
            {
                MessageBox.Show(this, "请填写服务器显示名，并至少填写一个 Linux allowedRoot。", "信息不完整", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Dictionary<string, object> result = await _manager.RunJsonAsync("remote-agent-create-enrollment", new
                {
                    name = _name.Text.Trim(),
                    allowedRoots = roots,
                    ttlMinutes = 15,
                });
                _installCommand.Text = ValueText(result, "installCommand");
                _status.Text = string.IsNullOrWhiteSpace(_installCommand.Text)
                    ? "Enrollment 已生成，但当前 publicBaseUrl 不完整，因此没有生成公网安装命令。"
                    : "一次性安装命令已生成。默认用户级安装，不需要 sudo 密码，也不需要把 SSH 密码交给 DevSpace。";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "生成 Linux Agent 安装命令失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string SshProfilesPath
        {
            get { return SshProfilesPathFor(_manager); }
        }

        private static string SshProfilesPathFor(ManagerClient manager)
        {
            return Path.Combine(manager.Root, "data", "remote-agent-ssh-profiles.json");
        }

        private string CurrentSshProfileKey()
        {
            string id = ValueText(_selectedAgent, "id");
            if (!string.IsNullOrWhiteSpace(id)) return id;
            string selectedName = ValueText(_selectedAgent, "name");
            if (!string.IsNullOrWhiteSpace(selectedName)) return "name:" + selectedName;
            string name = (_name.Text ?? "").Trim();
            return string.IsNullOrWhiteSpace(name) ? "" : "name:" + name;
        }

        private StoredSshProfiles LoadSshProfiles()
        {
            return LoadSshProfiles(_manager);
        }

        private static StoredSshProfiles LoadSshProfiles(ManagerClient manager)
        {
            try
            {
                string path = SshProfilesPathFor(manager);
                if (!File.Exists(path)) return new StoredSshProfiles();
                JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                StoredSshProfiles value = json.Deserialize<StoredSshProfiles>(File.ReadAllText(path, Encoding.UTF8));
                return value ?? new StoredSshProfiles();
            }
            catch
            {
                return new StoredSshProfiles();
            }
        }

        private StoredSshProfile FindSshProfile(Dictionary<string, object> agent)
        {
            StoredSshProfiles profiles = LoadSshProfiles();
            string id = ValueText(agent, "id");
            string name = ValueText(agent, "name");
            StoredSshProfile direct = profiles.Profiles.FirstOrDefault(profile =>
                !string.IsNullOrWhiteSpace(id) && string.Equals(profile.Key, id, StringComparison.Ordinal));
            if (direct != null) return direct;
            return profiles.Profiles.FirstOrDefault(profile =>
                !string.IsNullOrWhiteSpace(name) && string.Equals(profile.Key, "name:" + name, StringComparison.OrdinalIgnoreCase));
        }

        private static string ProtectSshPassword(string password)
        {
            if (string.IsNullOrEmpty(password)) return "";
            byte[] entropy = Encoding.UTF8.GetBytes("DevSpacePortable.RemoteAgentSsh.v1");
            byte[] protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), entropy, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(protectedBytes);
        }

        private static string UnprotectSshPassword(string protectedPassword)
        {
            if (string.IsNullOrWhiteSpace(protectedPassword)) return "";
            byte[] entropy = Encoding.UTF8.GetBytes("DevSpacePortable.RemoteAgentSsh.v1");
            byte[] clear = ProtectedData.Unprotect(Convert.FromBase64String(protectedPassword), entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(clear);
        }

        private void SaveCurrentSshProfile(bool notify)
        {
            string key = CurrentSshProfileKey();
            if (string.IsNullOrWhiteSpace(key))
            {
                if (notify) MessageBox.Show(this, "请先选择一个 Agent，或填写服务器显示名。", "无法保存 SSH 配置", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string host = (_sshHost.Text ?? "").Trim();
            string user = (_sshUser.Text ?? "").Trim();
            int port;
            if (!ValidateSshEndpoint(host, _sshPort.Text, user, out port, notify)) return;
            StoredSshProfiles profiles = LoadSshProfiles();
            StoredSshProfile existing = profiles.Profiles.FirstOrDefault(profile => string.Equals(profile.Key, key, StringComparison.OrdinalIgnoreCase));
            if (existing == null)
            {
                existing = new StoredSshProfile();
                profiles.Profiles.Add(existing);
            }
            existing.Key = key;
            existing.Host = host;
            existing.Port = port;
            existing.UserName = user;
            existing.ProtectedPassword = ProtectSshPassword(_sshPassword.Text ?? "");
            existing.AutoRecover = _sshAutoRecover.Checked;
            string directory = Path.GetDirectoryName(SshProfilesPath);
            Directory.CreateDirectory(directory);
            string temporary = SshProfilesPath + ".tmp";
            File.WriteAllText(temporary, _json.Serialize(profiles), new UTF8Encoding(false));
            if (File.Exists(SshProfilesPath)) File.Replace(temporary, SshProfilesPath, null);
            else File.Move(temporary, SshProfilesPath);
            if (notify) _status.Text = "SSH 配置已保存。密码仅以当前 Windows 用户可解密的 DPAPI 密文落盘。";
        }

        private void LoadSelectedSshProfile()
        {
            StoredSshProfile profile = FindSshProfile(_selectedAgent);
            if (profile == null) return;
            _sshHost.Text = profile.Host ?? "";
            _sshPort.Text = profile.Port > 0 ? profile.Port.ToString(CultureInfo.InvariantCulture) : "22";
            _sshUser.Text = profile.UserName ?? "";
            try { _sshPassword.Text = UnprotectSshPassword(profile.ProtectedPassword); }
            catch { _sshPassword.Text = ""; }
            _sshAutoRecover.Checked = profile.AutoRecover;
        }

        private bool ValidateSshEndpoint(string host, string portText, string user, out int port, bool notify)
        {
            port = 0;
            bool validHost = !string.IsNullOrWhiteSpace(host)
                && Regex.IsMatch(host, @"^[A-Za-z0-9._:\[\]-]+$")
                && !host.Contains("..");
            bool validUser = !string.IsNullOrWhiteSpace(user) && Regex.IsMatch(user, @"^[A-Za-z0-9._-]+$");
            bool validPort = int.TryParse((portText ?? "").Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out port)
                && port >= 1 && port <= 65535;
            if (validHost && validUser && validPort) return true;
            if (notify)
            {
                MessageBox.Show(this, "SSH 主机、端口或用户名格式无效。主机不允许空格和命令字符，端口必须为 1–65535。", "SSH 配置无效", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return false;
        }

        private sealed class SshRunResult
        {
            public int ExitCode { get; set; }
            public string Output { get; set; }
            public string Error { get; set; }
        }

        private static string QuoteProcessArgument(string value)
        {
            if (value == null) return "\"\"";
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int slashes = 0;
            foreach (char ch in value)
            {
                if (ch == '\\')
                {
                    slashes++;
                    continue;
                }
                if (ch == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0)
                {
                    result.Append('\\', slashes);
                    slashes = 0;
                }
                result.Append(ch);
            }
            if (slashes > 0) result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private Task<SshRunResult> RunSshScriptAsync(string script, int timeoutMs = 30000)
        {
            string host = (_sshHost.Text ?? "").Trim();
            string user = (_sshUser.Text ?? "").Trim();
            int port;
            if (!ValidateSshEndpoint(host, _sshPort.Text, user, out port, true))
                throw new InvalidOperationException("SSH endpoint is invalid.");
            string password = _sshPassword.Text ?? "";
            return RunSshScriptWithProfileAsync(_manager, host, port, user, password, script, timeoutMs);
        }

        internal static string NormalizeSshScriptForBash(string script)
        {
            string normalized = (script ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
            if (!normalized.EndsWith("\n", StringComparison.Ordinal)) normalized += "\n";
            return normalized;
        }

        private static Task<SshRunResult> RunSshScriptWithProfileAsync(ManagerClient manager, string host, int port, string user, string password, string script, int timeoutMs)
        {
            string ssh = Path.Combine(manager.Root, "runtime", "git", "usr", "bin", "ssh.exe");
            if (!File.Exists(ssh)) ssh = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");
            if (!File.Exists(ssh)) throw new FileNotFoundException("没有找到 bundled Git SSH 或 Windows OpenSSH。", ssh);
            string askPass = Path.Combine(manager.Root, "DevSpace-SshAskPass.exe");
            if (!string.IsNullOrEmpty(password) && !File.Exists(askPass))
                throw new FileNotFoundException("SSH 密码辅助程序缺失。", askPass);
            string normalizedHost = host.Contains(":") && !host.StartsWith("[", StringComparison.Ordinal) ? "[" + host + "]" : host;
            string target = user + "@" + normalizedHost;
            string arguments = "-o ConnectTimeout=10 -o ConnectionAttempts=2 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "
                + (string.IsNullOrEmpty(password) ? "-o BatchMode=yes " : "-o BatchMode=no -o NumberOfPasswordPrompts=2 ")
                + "-p " + port.ToString(CultureInfo.InvariantCulture) + " " + QuoteProcessArgument(target) + " bash -s";

            return Task.Run(delegate
            {
                ProcessStartInfo info = new ProcessStartInfo
                {
                    FileName = ssh,
                    Arguments = arguments,
                    WorkingDirectory = manager.Root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                if (!string.IsNullOrEmpty(password))
                {
                    info.EnvironmentVariables["SSH_ASKPASS"] = askPass;
                    info.EnvironmentVariables["SSH_ASKPASS_REQUIRE"] = "force";
                    info.EnvironmentVariables["DISPLAY"] = "devspace";
                    info.EnvironmentVariables["DEVSPACE_SSH_PASSWORD"] = password;
                }
                using (Process process = Process.Start(info))
                {
                    Task<string> stdout = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderr = process.StandardError.ReadToEndAsync();
                    // C# source files are intentionally CRLF on Windows, and
                    // verbatim multi-line strings therefore carry CRLF too.
                    // Feeding those bytes unchanged to remote `bash -s` makes
                    // Bash parse tokens such as `set -eu\r` and `do\r`, which
                    // produces the rescue failure seen in 1.1.40. Always send
                    // POSIX LF shell text regardless of the Windows checkout
                    // or which SSH implementation is selected.
                    string normalizedScript = NormalizeSshScriptForBash(script);
                    process.StandardInput.NewLine = "\n";
                    process.StandardInput.Write(normalizedScript);
                    process.StandardInput.Close();
                    if (!process.WaitForExit(timeoutMs))
                    {
                        try { process.Kill(); } catch { }
                        throw new TimeoutException("SSH 操作超时。请检查服务器地址、端口、防火墙和网络。 ");
                    }
                    Task.WaitAll(new Task[] { stdout, stderr }, 5000);
                    return new SshRunResult
                    {
                        ExitCode = process.ExitCode,
                        Output = stdout.IsCompleted ? stdout.Result.Trim() : "",
                        Error = stderr.IsCompleted ? stderr.Result.Trim() : "",
                    };
                }
            });
        }

        private async Task TestSshAsync()
        {
            if (_sshBusy) return;
            _sshBusy = true;
            try
            {
                _status.Text = "正在测试 SSH 连接…";
                SshRunResult result = await RunSshScriptAsync("set -e\nprintf 'DEVSPACE_SSH_OK\\n'\nuname -s 2>/dev/null || true\nhostname 2>/dev/null || true\n", 20000);
                if (result.ExitCode != 0 || !result.Output.Contains("DEVSPACE_SSH_OK"))
                    throw new InvalidOperationException(string.IsNullOrWhiteSpace(result.Error) ? "SSH 测试未返回预期标记。" : result.Error);
                SaveCurrentSshProfile(false);
                _status.Text = "SSH 连接正常。后续 Agent 离线时可以直接使用一键救援。";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "SSH 连接失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                _status.Text = "SSH 连接失败。手动安装命令仍可作为 fallback。";
            }
            finally { _sshBusy = false; }
        }

        private static string ExistingAgentRecoveryScript()
        {
            return @"set -eu
state=''
for candidate in ""${XDG_STATE_HOME:-$HOME/.local/state}/devspace-agent"" ""$HOME/.local/state/devspace-agent"" ""/var/lib/devspace-agent""; do
  if [ -f ""$candidate/bin/devspace-agent.py"" ] && [ -f ""$candidate/config.json"" ]; then state=""$candidate""; break; fi
done
if [ -z ""$state"" ]; then echo DEVSPACE_AGENT_NOT_INSTALLED; exit 42; fi
if [ -f ""$state/agent.pid"" ]; then
  pid=$(cat ""$state/agent.pid"" 2>/dev/null || true)
  if [ -n ""$pid"" ] && kill -0 ""$pid"" 2>/dev/null; then echo DEVSPACE_AGENT_ALREADY_RUNNING; exit 0; fi
fi
if command -v systemctl >/dev/null 2>&1 && [ ""$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')"" = systemd ]; then
  if systemctl --user cat devspace-agent.service >/dev/null 2>&1; then
    systemctl --user restart devspace-agent.service && echo DEVSPACE_AGENT_STARTED && exit 0
  fi
  if sudo -n systemctl restart devspace-agent.service >/dev/null 2>&1; then echo DEVSPACE_AGENT_STARTED && exit 0; fi
fi
python_bin=$(command -v python3 || command -v python || true)
if [ -z ""$python_bin"" ]; then echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; fi
nohup ""$python_bin"" ""$state/bin/devspace-agent.py"" --config ""$state/config.json"" run >>""$state/agent.log"" 2>&1 </dev/null &
pid=$!
printf '%s\n' ""$pid"" > ""$state/agent.pid""
sleep 1
if ! kill -0 ""$pid"" 2>/dev/null; then tail -n 20 ""$state/agent.log"" >&2 || true; exit 44; fi
echo DEVSPACE_AGENT_STARTED
";
        }

        internal static async Task AutoRecoverConfiguredAgentsAsync(ManagerClient manager)
        {
            StoredSshProfiles profiles = LoadSshProfiles(manager);
            if (profiles.Profiles == null || profiles.Profiles.Count == 0) return;
            Dictionary<string, object> listed;
            try { listed = await manager.RunJsonAsync("remote-agent-list"); }
            catch { return; }
            foreach (Dictionary<string, object> agent in Dictionaries(listed, "agents"))
            {
                if (!string.Equals(ValueText(agent, "status"), "offline", StringComparison.OrdinalIgnoreCase)) continue;
                string id = ValueText(agent, "id");
                string name = ValueText(agent, "name");
                StoredSshProfile profile = profiles.Profiles.FirstOrDefault(value =>
                    value.AutoRecover
                    && ((!string.IsNullOrWhiteSpace(id) && string.Equals(value.Key, id, StringComparison.Ordinal))
                        || (!string.IsNullOrWhiteSpace(name) && string.Equals(value.Key, "name:" + name, StringComparison.OrdinalIgnoreCase))));
                if (profile == null || string.IsNullOrWhiteSpace(profile.Host) || string.IsNullOrWhiteSpace(profile.UserName) || profile.Port < 1 || profile.Port > 65535) continue;

                string throttleKey = string.IsNullOrWhiteSpace(id) ? profile.Key : id;
                lock (BackgroundSshAttempts)
                {
                    DateTime last;
                    if (BackgroundSshAttempts.TryGetValue(throttleKey, out last) && DateTime.UtcNow - last < TimeSpan.FromMinutes(2)) continue;
                    BackgroundSshAttempts[throttleKey] = DateTime.UtcNow;
                }
                string password;
                try { password = UnprotectSshPassword(profile.ProtectedPassword); }
                catch { continue; }
                try
                {
                    await RunSshScriptWithProfileAsync(
                        manager,
                        profile.Host,
                        profile.Port,
                        profile.UserName,
                        password,
                        ExistingAgentRecoveryScript(),
                        30000);
                }
                catch
                {
                    // Background rescue is deliberately quiet. The explicit
                    // Remote Agent page exposes detailed SSH diagnostics and
                    // keeps the manual enrollment command as the final fallback.
                }
            }
        }

        private async Task<bool> WaitForAgentOnlineAsync(string previousId, string name)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                await Task.Delay(attempt == 0 ? 800 : 1600);
                Dictionary<string, object> result = await _manager.RunJsonAsync("remote-agent-list");
                foreach (Dictionary<string, object> agent in Dictionaries(result, "agents"))
                {
                    bool same = (!string.IsNullOrWhiteSpace(previousId) && string.Equals(ValueText(agent, "id"), previousId, StringComparison.Ordinal))
                        || (!string.IsNullOrWhiteSpace(name) && string.Equals(ValueText(agent, "name"), name, StringComparison.OrdinalIgnoreCase));
                    if (same && string.Equals(ValueText(agent, "status"), "online", StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            return false;
        }

        private async Task RecoverAgentViaSshAsync(bool silent)
        {
            if (_sshBusy) return;
            _sshBusy = true;
            try
            {
                SaveCurrentSshProfile(false);
                string agentId = ValueText(_selectedAgent, "id");
                string agentName = ValueText(_selectedAgent, "name");
                if (string.IsNullOrWhiteSpace(agentName)) agentName = (_name.Text ?? "").Trim();
                _status.Text = "Agent 离线救援：正在通过 SSH 检查并启动已有 Agent…";
                SshRunResult recovery = await RunSshScriptAsync(ExistingAgentRecoveryScript(), 30000);
                if (recovery.ExitCode == 42 || recovery.Output.Contains("DEVSPACE_AGENT_NOT_INSTALLED"))
                {
                    string[] selectedRoots = Strings(_selectedAgent, "allowedRoots").Where(value => !string.IsNullOrWhiteSpace(value)).ToArray();
                    string[] roots = selectedRoots.Length > 0
                        ? selectedRoots
                        : _roots.Lines.Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
                    if (string.IsNullOrWhiteSpace(agentName) || roots.Length == 0)
                        throw new InvalidOperationException("服务器尚未安装 Agent；请填写服务器显示名和至少一个 allowedRoot 后重试。 ");
                    Dictionary<string, object> enrollment = await _manager.RunJsonAsync("remote-agent-create-enrollment", new
                    {
                        name = agentName,
                        allowedRoots = roots,
                        ttlMinutes = 15,
                    });
                    string command = ValueText(enrollment, "installCommand");
                    if (string.IsNullOrWhiteSpace(command))
                        throw new InvalidOperationException("已生成 enrollment，但当前 publicBaseUrl 无法生成安装命令。请使用手动 fallback。 ");
                    _installCommand.Text = command;
                    _status.Text = "服务器未安装 Agent；正在通过 SSH 执行一次性安装命令…";
                    SshRunResult install = await RunSshScriptAsync("set -e\n" + command + "\n", 120000);
                    if (install.ExitCode != 0)
                        throw new InvalidOperationException(string.IsNullOrWhiteSpace(install.Error) ? "远程 Agent 安装失败。" : install.Error);
                }
                else if (recovery.ExitCode != 0)
                {
                    throw new InvalidOperationException(string.IsNullOrWhiteSpace(recovery.Error) ? "已有 Agent 无法通过 SSH 启动。" : recovery.Error);
                }

                bool online = await WaitForAgentOnlineAsync(agentId, agentName);
                await LoadAgentsAsync();
                if (!online)
                    throw new InvalidOperationException("SSH 操作已完成，但 Agent 在等待窗口内仍未恢复 heartbeat。请查看服务器 agent.log 或使用手动安装命令。 ");
                _status.Text = "Remote Workspace Agent 已通过 SSH 恢复并重新上线。";
            }
            catch (Exception ex)
            {
                _status.Text = "SSH 自动救援失败；手动安装命令仍可用。";
                if (!silent) MessageBox.Show(this, ex.Message, "Remote Agent SSH 救援失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { _sshBusy = false; }
        }

        private async Task AutoRecoverSelectedAgentAsync()
        {
            if (_sshBusy || !_sshAutoRecover.Checked) return;
            if (!string.Equals(ValueText(_selectedAgent, "status"), "offline", StringComparison.OrdinalIgnoreCase)) return;
            if (string.IsNullOrWhiteSpace(_sshHost.Text) || string.IsNullOrWhiteSpace(_sshUser.Text)) return;
            await RecoverAgentViaSshAsync(true);
        }

        private async Task RevokeSelectedAsync()
        {
            Dictionary<string, object> agent = SelectedAgent();
            string id = ValueText(agent, "id");
            if (string.IsNullOrWhiteSpace(id)) return;
            if (MessageBox.Show(this, "撤销 " + ValueText(agent, "name") + " 后，该 Agent 的现有 Secret 将不能再连接。继续吗？", "撤销 Linux Agent", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            await _manager.RunJsonAsync("remote-agent-revoke", new { agentId = id });
            await LoadAgentsAsync();
        }

        private async Task DeleteSelectedAsync()
        {
            Dictionary<string, object> agent = SelectedAgent();
            string id = ValueText(agent, "id");
            if (string.IsNullOrWhiteSpace(id)) return;
            if (MessageBox.Show(this, "永久删除此 Agent 的控制端登记记录？远端 systemd 服务或后台 Agent 进程不会被远程删除。", "删除 Agent 记录", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            await _manager.RunJsonAsync("remote-agent-delete", new { agentId = id });
            await LoadAgentsAsync();
        }

        private Dictionary<string, object> SelectedAgent()
        {
            return _selectedAgent ?? new Dictionary<string, object>();
        }

        private void SelectAgentTile(RemoteAgentTile selected)
        {
            if (selected == null || selected.Tag == null) return;
            foreach (RemoteAgentTile tile in _agentTiles.Controls.OfType<RemoteAgentTile>()) tile.Selected = ReferenceEquals(tile, selected);
            _selectedAgent = selected.Tag as Dictionary<string, object> ?? new Dictionary<string, object>();
            selected.Focus();
            string name = ValueText(_selectedAgent, "name");
            string id = ValueText(_selectedAgent, "id");
            if (!string.IsNullOrWhiteSpace(name)) _name.Text = name;
            string[] selectedRoots = Strings(_selectedAgent, "allowedRoots").Where(value => !string.IsNullOrWhiteSpace(value)).ToArray();
            if (selectedRoots.Length > 0) _roots.Lines = selectedRoots;
            LoadSelectedSshProfile();
            _status.Text = string.IsNullOrWhiteSpace(id) ? "已选择 Linux Agent。" : "已选择 " + name + "（" + id + "）。";
        }

        private void CopyInstallCommand()
        {
            if (string.IsNullOrWhiteSpace(_installCommand.Text))
            {
                MessageBox.Show(this, "请先生成一次性安装命令。", "没有可复制内容", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Clipboard.SetText(_installCommand.Text);
            _status.Text = "Linux Agent 安装命令已复制到剪贴板。";
        }

        private static Label FieldLabel(string text)
        {
            return new Label { Text = text, AutoSize = true, Font = UiTypography.Ui(9F, FontStyle.Bold), ForeColor = UiPalette.TextMuted, Margin = new Padding(3, 8, 3, 3) };
        }

        private static void StyleTextBox(TextBox box)
        {
            box.Dock = DockStyle.Fill;
            box.Font = UiTypography.Ui(9.25F);
            box.BackColor = UiPalette.SurfaceMuted;
            box.ForeColor = UiPalette.Text;
            box.BorderStyle = BorderStyle.None;
            box.Margin = new Padding(0);
        }

        private static FlowLayoutPanel ButtonBar()
        {
            return new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                AutoSize = false,
                WrapContents = true,
                BackColor = UiPalette.Surface,
                Margin = new Padding(0),
                Padding = new Padding(0, 3, 0, 3),
            };
        }

        private static Button ActionButton(string text, EventHandler handler, bool primary, bool danger = false, int width = 112)
        {
            ModernButton button = new ModernButton
            {
                Text = text,
                AutoSize = false,
                Primary = primary,
                Danger = danger,
                Width = Math.Max(104, width),
                Height = 44,
                MinimumSize = new Size(104, 44),
                Padding = new Padding(14, 0, 14, 0),
                Margin = new Padding(4, 3, 4, 3),
            };
            button.Click += handler;
            return button;
        }

        private static IEnumerable<Dictionary<string, object>> Dictionaries(Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value) || value == null || value is string) yield break;
            IEnumerable items = value as IEnumerable;
            if (items == null) yield break;
            foreach (object item in items)
            {
                Dictionary<string, object> dictionary = item as Dictionary<string, object>;
                if (dictionary != null) yield return dictionary;
            }
        }

        private static List<string> Strings(Dictionary<string, object> source, string key)
        {
            object value;
            List<string> values = new List<string>();
            if (source == null || !source.TryGetValue(key, out value) || value == null || value is string) return values;
            IEnumerable items = value as IEnumerable;
            if (items == null) return values;
            foreach (object item in items) values.Add(Convert.ToString(item));
            return values;
        }

        private static string ValueText(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }
    }

    internal sealed class DiagnosticsDetailsDialog : Form
    {
        private readonly ManagerClient _manager;
        private readonly string _root;
        private readonly TabControl _pages = new TabControl();
        private readonly RichTextBox _summary = CreateOutputBox();
        private readonly RichTextBox _http = CreateOutputBox();
        private readonly RichTextBox _tunnel = CreateOutputBox();
        private readonly RichTextBox _files = CreateOutputBox();
        private readonly RichTextBox _logs = CreateOutputBox();
        private readonly Label _activity = new Label();
        private bool _busy;
        public event EventHandler StatusChanged;

        public DiagnosticsDetailsDialog(string root, ManagerClient manager)
        {
            _root = root;
            _manager = manager;
            Text = "DevSpace 详细信息";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = new Size(920, 620);
            Size = new Size(1120, 760);
            BackColor = UiPalette.Background;
            Font = UiTypography.Ui(9F);

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3,
                Padding = new Padding(18),
                BackColor = UiPalette.Background,
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 108));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            Panel header = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
            Label title = new Label
            {
                Text = "运行状态与诊断详情",
                Font = UiTypography.Display(17F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(4, 5),
            };
            Label subtitle = new Label
            {
                Text = "这里保留完整状态、HTTP/OAuth、隧道、文件校验和运行日志；主页只显示自动更新的活动指示器。",
                Font = UiTypography.Ui(9.2F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = true,
                Location = new Point(5, 40),
            };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            layout.Controls.Add(header, 0, 0);

            FlowLayoutPanel actions = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                BackColor = Color.Transparent,
                Padding = new Padding(0, 4, 0, 4),
            };
            actions.Controls.Add(ActionButton("刷新概览", async delegate { await RefreshSummaryAsync(); }));
            actions.Controls.Add(ActionButton("验证 HTTP", async delegate { await RunDiagnosticAsync("test", _http, 1); }));
            actions.Controls.Add(ActionButton("诊断隧道", async delegate { await RunDiagnosticAsync("diagnose", _tunnel, 2); }));
            actions.Controls.Add(ActionButton("验证文件", async delegate { await RunDiagnosticAsync("verify-files", _files, 3); }));
            actions.Controls.Add(ActionButton("刷新日志", async delegate { await RefreshLogsAsync(); }));
            actions.Controls.Add(ActionButton("检查系统代理", async delegate { await InspectSystemProxyAsync(); }));
            actions.Controls.Add(ActionButton("修复失效系统代理", async delegate { await RepairStaleProxyAsync(); }));
            actions.Controls.Add(ActionButton("恢复代理修复", async delegate { await RestoreProxyRepairAsync(); }));
            actions.Controls.Add(ActionButton("任务计划程序", delegate { OpenExternal("taskschd.msc"); }));
            actions.Controls.Add(ActionButton("日志目录", delegate { OpenExternal(Path.Combine(_root, "logs")); }));
            _activity.Text = "等待操作";
            _activity.AutoSize = false;
            _activity.Width = 180;
            _activity.Height = 42;
            _activity.TextAlign = ContentAlignment.MiddleLeft;
            _activity.ForeColor = UiPalette.TextMuted;
            _activity.Margin = new Padding(12, 4, 0, 4);
            actions.Controls.Add(_activity);
            layout.Controls.Add(actions, 0, 1);

            _pages.Dock = DockStyle.Fill;
            _pages.Font = UiTypography.Ui(9.2F);
            AddPage("状态概览", _summary);
            AddPage("HTTP / OAuth", _http);
            AddPage("公网隧道", _tunnel);
            AddPage("文件验证", _files);
            AddPage("日志", _logs);
            layout.Controls.Add(_pages, 0, 2);
            Controls.Add(layout);
            Shown += async delegate
            {
                NativeWindowEffects.Apply(Handle);
                await RefreshSummaryAsync();
                await RefreshLogsAsync(false);
            };
        }

        private static RichTextBox CreateOutputBox()
        {
            return new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                BackColor = UiPalette.Console,
                ForeColor = UiPalette.ConsoleText,
                Font = UiTypography.Code(9F),
                WordWrap = false,
                DetectUrls = false,
                Padding = new Padding(12),
            };
        }

        private static ModernButton ActionButton(string text, Func<Task> action)
        {
            ModernButton button = new ModernButton { Text = text, Height = 40, AutoSize = true };
            button.Click += async delegate { await action(); };
            return button;
        }

        private static ModernButton ActionButton(string text, Action action)
        {
            ModernButton button = new ModernButton { Text = text, Height = 40, AutoSize = true };
            button.Click += delegate { action(); };
            return button;
        }

        private void AddPage(string title, Control content)
        {
            TabPage page = new TabPage(title) { BackColor = UiPalette.Background, Padding = new Padding(8) };
            SurfacePanel surface = new SurfacePanel { Dock = DockStyle.Fill, Dark = true, Padding = new Padding(12) };
            surface.Controls.Add(content);
            page.Controls.Add(surface);
            _pages.TabPages.Add(page);
        }

        private async Task RefreshSummaryAsync()
        {
            await RunDiagnosticAsync("status", _summary, 0);
        }

        private async Task InspectSystemProxyAsync()
        {
            if (_busy) return;
            _busy = true;
            _activity.Text = "正在检查系统代理…";
            _pages.SelectedIndex = 0;
            try
            {
                Dictionary<string, object> state = await _manager.RunJsonAsync("network-proxy-state");
                StringBuilder text = new StringBuilder();
                text.AppendLine("=== Windows System Proxy ===");
                text.AppendLine("Enabled: " + GetBool(state, "enabled"));
                text.AppendLine("ProxyServer: " + GetString(state, "rawServer"));
                text.AppendLine("Candidate: " + GetString(state, "candidate"));
                text.AppendLine("Loopback: " + GetBool(state, "loopback"));
                text.AppendLine("Local listener healthy: " + GetBool(state, "localHealthy"));
                text.AppendLine("Stale loopback proxy: " + GetBool(state, "staleLoopback"));
                text.AppendLine("Repair backup exists: " + GetBool(state, "repairBackupExists"));
                text.AppendLine("Repair backup: " + GetString(state, "repairBackupFile"));
                text.AppendLine();
                text.AppendLine("DevSpace 仅进行只读检查；除非你明确点击“修复失效系统代理”，否则不会改 Windows 代理设置。");
                _summary.Text = text.ToString().Trim();
                _activity.Text = "系统代理已检查 · " + DateTime.Now.ToString("HH:mm:ss");
            }
            catch (Exception ex)
            {
                _summary.Text = "错误：\r\n" + ex.Message;
                _activity.Text = "检查失败";
            }
            finally { _busy = false; }
        }

        private async Task RepairStaleProxyAsync()
        {
            if (_busy) return;
            Dictionary<string, object> state = await _manager.RunJsonAsync("network-proxy-state");
            if (!GetBool(state, "staleLoopback"))
            {
                MessageBox.Show(this, "当前没有检测到“系统代理已启用，但本地代理端口无人监听”的状态，因此不会修改任何网络设置。", "无需修复", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string proxy = GetString(state, "rawServer");
            if (MessageBox.Show(this,
                "检测到 Windows 系统代理仍指向本机代理：\r\n\r\n" + proxy +
                "\r\n\r\n但对应本地端口当前没有监听。这会让部分浏览器内核、登录页或命令行程序在代理软件关闭后无法联网。\r\n\r\nDevSpace 可以仅将 ProxyEnable 关闭，并把原值备份到 data\\state，便于恢复。不会修改路由、VPN、网卡或第三方进程。是否继续？",
                "修复失效系统代理", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            await RunDiagnosticAsync("repair-stale-proxy", _summary, 0);
        }

        private async Task RestoreProxyRepairAsync()
        {
            if (_busy) return;
            Dictionary<string, object> state = await _manager.RunJsonAsync("network-proxy-state");
            if (!GetBool(state, "repairBackupExists"))
            {
                MessageBox.Show(this, "没有找到由 DevSpace 创建的系统代理修复备份。", "没有可恢复项", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (MessageBox.Show(this, "将恢复上一次“修复失效系统代理”前保存的 Windows 系统代理设置。是否继续？", "恢复系统代理", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            await RunDiagnosticAsync("restore-proxy-repair", _summary, 0);
        }

        private async Task RunDiagnosticAsync(string action, RichTextBox target, int pageIndex)
        {
            if (_busy) return;
            _busy = true;
            _activity.Text = "正在执行 " + action + "…";
            target.Text = "正在执行，请稍候……";
            _pages.SelectedIndex = pageIndex;
            try
            {
                target.Text = await _manager.RunAsync(action);
                _activity.Text = "完成 · " + DateTime.Now.ToString("HH:mm:ss");
                EventHandler handler = StatusChanged;
                if (handler != null) handler(this, EventArgs.Empty);
            }
            catch (Exception ex)
            {
                target.Text = "错误：\r\n" + ex.Message;
                _activity.Text = "执行失败";
            }
            finally { _busy = false; }
        }

        private async Task RefreshLogsAsync(bool selectPage = true)
        {
            if (_busy) return;
            _busy = true;
            _activity.Text = "正在读取日志…";
            if (selectPage) _pages.SelectedIndex = 4;
            try
            {
                Dictionary<string, object> paths = await _manager.RunJsonAsync("log-paths");
                string devspace = GetString(paths, "devspace");
                string tunnel = GetString(paths, "tunnel");
                string update = Path.Combine(_root, "logs", "update.log");
                StringBuilder text = new StringBuilder();
                text.AppendLine("=== DevSpace ===");
                text.AppendLine(TailFile(devspace, 180));
                text.AppendLine();
                text.AppendLine("=== Tunnel ===");
                text.AppendLine(TailFile(tunnel, 180));
                text.AppendLine();
                text.AppendLine("=== Update ===");
                text.AppendLine(TailFile(update, 180));
                _logs.Text = text.ToString().Trim();
                _activity.Text = "日志已刷新 · " + DateTime.Now.ToString("HH:mm:ss");
            }
            catch (Exception ex)
            {
                _logs.Text = "错误：\r\n" + ex.Message;
                _activity.Text = "日志读取失败";
            }
            finally { _busy = false; }
        }

        private static string TailFile(string file, int lines)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(file) || !File.Exists(file)) return "(文件不存在)";
                string[] values = File.ReadAllLines(file, Encoding.UTF8);
                return string.Join(Environment.NewLine, values.Skip(Math.Max(0, values.Length - lines)));
            }
            catch (Exception ex) { return "(读取失败: " + ex.Message + ")"; }
        }

        private static string GetString(Dictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item != null ? Convert.ToString(item) : "";
        }

        private static bool GetBool(Dictionary<string, object> value, string key)
        {
            object item;
            if (value == null || !value.TryGetValue(key, out item) || item == null) return false;
            if (item is bool) return (bool)item;
            bool parsed;
            return bool.TryParse(Convert.ToString(item), out parsed) && parsed;
        }

        private static void OpenExternal(string target)
        {
            try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); } catch { }
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
                ["action"] = action,
                ["left"] = bounds.Left,
                ["top"] = bounds.Top,
                ["width"] = bounds.Width,
                ["height"] = bounds.Height,
                ["inputBackend"] = "native-ui-sendinput",
                ["screenshot"] = false,
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
                ["ENTER"] = 0x0D, ["TAB"] = 0x09, ["ESCAPE"] = 0x1B, ["BACKSPACE"] = 0x08,
                ["DELETE"] = 0x2E, ["UP"] = 0x26, ["DOWN"] = 0x28, ["LEFT"] = 0x25, ["RIGHT"] = 0x27,
                ["HOME"] = 0x24, ["END"] = 0x23, ["PAGEUP"] = 0x21, ["PAGEDOWN"] = 0x22,
                ["F1"] = 0x70, ["F2"] = 0x71, ["F3"] = 0x72, ["F4"] = 0x73, ["F5"] = 0x74, ["F6"] = 0x75,
                ["F7"] = 0x76, ["F8"] = 0x77, ["F9"] = 0x78, ["F10"] = 0x79, ["F11"] = 0x7A, ["F12"] = 0x7B,
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
        private readonly string _root;
        private readonly ManagerClient _manager;
        private readonly TabControl _tabs = new BorderlessTabControl();
        private readonly Label _versionLabel = new Label();
        private readonly Label _leaseLabel = new Label();
        private readonly Label _pageTitle = new Label();
        private readonly List<ModernNavButton> _navButtons = new List<ModernNavButton>();
        private readonly ModernToggle _computerUseToggle = new ModernToggle();
        private readonly StatusIndicatorCard _overallStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _serviceStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _tunnelStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _httpStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _filesStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _networkStatus = new StatusIndicatorCard();
        private readonly StatusIndicatorCard _computerUseStatus = new StatusIndicatorCard();
        private readonly InlineNotice _inlineNotice = new InlineNotice();
        private readonly TableLayoutPanel _contentLayout = new TableLayoutPanel();
        private readonly RichTextBox _operationOutput = CreateConsoleBox();
        private readonly RichTextBox _devspaceLog = CreateLogBox();
        private readonly RichTextBox _tunnelLog = CreateLogBox();
        private readonly DataGridView _pluginGrid = CreateGrid();
        private readonly DataGridView _slotGrid = CreateGrid();
        private readonly DataGridView _sessionGrid = CreateGrid();
        private readonly DataGridView _fileGrid = CreateGrid();
        private readonly BorderlessTabControl _sessionPages = new BorderlessTabControl();
        private readonly DataGridView _memoryGrid = CreateGrid();
        private readonly System.Windows.Forms.Timer _heartbeatTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _statusTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _noticeTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _computerUseTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _computerUseIndicatorTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _remoteAgentRecoveryTimer = new System.Windows.Forms.Timer();
        private readonly ComputerUseIndicator _computerUseIndicator = new ComputerUseIndicator();
        private readonly JavaScriptSerializer _computerUseJson = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly NotifyIcon _notifyIcon = new NotifyIcon();
        private readonly ContextMenuStrip _trayMenu = new ContextMenuStrip();

        private string _leaseId = "";
        private bool _heartbeatBusy;
        private bool _computerUseWorkerBusy;
        private bool _closing;
        private bool _allowUiExit;
        private bool _closingForUpdate;
        private bool _trayNoticeShown;
        private bool _sessionListLoading;
        private bool _memoryListLoading;
        private bool _loadingConfiguration;
        private bool _dashboardStatusBusy;
        private int _busyOperationCount;
        private Dictionary<string, object> _currentConfig = new Dictionary<string, object>();
        private Dictionary<string, object> _selectedSessionDetails = new Dictionary<string, object>();
        private List<Dictionary<string, object>> _allSessions = new List<Dictionary<string, object>>();
        private List<Dictionary<string, object>> _allMemories = new List<Dictionary<string, object>>();
        private readonly HashSet<string> _expandedSessionGroups = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, int> _dashboardProblemCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        private string _fullSessionPatch = "";
        private string _memoryPreviewText = "";
        private string _editingMemoryId = "";
        private string _closePreference = "";
        private readonly Dictionary<string, string> _providerUrls = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private string _selectedProviderName = "";

        private ComboBox _provider;
        private TextBox _publicUrl;
        private NumericUpDown _port;
        private ComboBox _toolMode;
        private ComboBox _accessProfile;
        private TextBox _roots;
        private CheckBox _allDrives;
        private TextBox _ngrokToken;
        private TextBox _ngrokProxy;
        private CheckBox _tunnelNetworkCompatibility;
        private CheckBox _ngrokCas;
        private TextBox _cloudflareToken;
        private TextBox _ownerToken;
        private readonly Dictionary<string, CheckBox> _permissionBoxes = new Dictionary<string, CheckBox>();
        private readonly Dictionary<string, CheckBox> _featureBoxes = new Dictionary<string, CheckBox>();
        private ComboBox _pluginVersion;
        private ComboBox _slotNumber;
        private ComboBox _slotPlugin;
        private ComboBox _slotTool;
        private TextBox _sessionSearch;
        private CheckBox _showHidden;
        private CheckBox _showArchived;
        private CheckBox _showEmptySessions;
        private Label _sessionSummary;
        private Label _sessionDetailTitle;
        private Label _sessionDetailMeta;
        private TextBox _memorySearch;
        private ComboBox _memoryViewWorkspace;
        private CheckBox _showOtherWorkspaceMemories;
        private ComboBox _memoryScope;
        private ComboBox _memoryWorkspace;
        private TextBox _memoryTitle;
        private TextBox _memoryTags;
        private TextBox _memoryContent;
        private Label _memoryStatus;
        private SessionDiffDialog _diffWindow;
        private ContentPreviewDialog _memoryPreviewWindow;

        public MainForm(string root)
        {
            _root = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            _manager = new ManagerClient(_root);
            Text = "DevSpace Portable";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1180, 780);
            Size = new Size(1460, 940);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = UiTypography.Ui(9.25F);
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            DoubleBuffered = true;
            LoadUiPreferences();
            InitializeTrayIcon();
            BuildUi();
            Shown += async delegate { await RunUiActionAsync(InitializeAsync); };
            FormClosing += MainForm_FormClosing;
            _heartbeatTimer.Interval = 1500;
            _heartbeatTimer.Tick += async delegate { await HeartbeatAsync(); };
            _statusTimer.Interval = 3000;
            _statusTimer.Tick += async delegate { await RefreshDashboardStatusAsync(); };
            _noticeTimer.Interval = 9000;
            _noticeTimer.Tick += delegate { _noticeTimer.Stop(); _inlineNotice.Dismiss(); };
            _computerUseTimer.Interval = 15;
            _computerUseTimer.Tick += async delegate { await ProcessComputerUseQueueAsync(); };
            _computerUseIndicatorTimer.Interval = 100;
            _computerUseIndicatorTimer.Tick += delegate { _computerUseIndicator.Tick(); };
            _remoteAgentRecoveryTimer.Interval = 60000;
            _remoteAgentRecoveryTimer.Tick += async delegate { await RemoteAgentsDialog.AutoRecoverConfiguredAgentsAsync(_manager); };
            _inlineNotice.Dismissed += delegate { CollapseNoticeRow(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            NativeWindowEffects.Apply(Handle);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            CloseOpenDropDowns(this);
            base.OnSizeChanged(e);
        }

        private static void CloseOpenDropDowns(Control parent)
        {
            foreach (Control child in parent.Controls)
            {
                ComboBox combo = child as ComboBox;
                if (combo != null && combo.DroppedDown) combo.DroppedDown = false;
                if (child.HasChildren) CloseOpenDropDowns(child);
            }
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
                Dictionary<string, object> value = _computerUseJson.DeserializeObject(File.ReadAllText(UiPreferencesFile, Encoding.UTF8)) as Dictionary<string, object>;
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
                File.WriteAllText(temporary, _computerUseJson.Serialize(new Dictionary<string, object>
                {
                    ["formatVersion"] = 1,
                    ["closeChoice"] = _closePreference,
                    ["updatedAt"] = DateTime.UtcNow.ToString("o"),
                }), new UTF8Encoding(false));
                if (File.Exists(UiPreferencesFile)) File.Delete(UiPreferencesFile);
                File.Move(temporary, UiPreferencesFile);
            }
            catch { }
        }

        private void InitializeTrayIcon()
        {
            _trayMenu.Font = UiTypography.Ui(9F);
            _trayMenu.Items.Add("打开控制中心", null, delegate { RestoreFromTray(); });
            _trayMenu.Items.Add("下次关闭时询问", null, delegate
            {
                SaveClosePreference("");
                ShowInlineNotice("已清除关闭窗口的记忆选择；下次点击关闭时会重新询问。", false);
            });
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add("退出控制中心", null, delegate
            {
                _allowUiExit = true;
                Close();
            });
            _notifyIcon.Icon = Icon ?? SystemIcons.Application;
            _notifyIcon.Text = "DevSpace Portable";
            _notifyIcon.ContextMenuStrip = _trayMenu;
            _notifyIcon.Visible = false;
            _notifyIcon.DoubleClick += delegate { RestoreFromTray(); };
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

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
            e.Graphics.Clear(UiPalette.Background);
        }

        private void BuildUi()
        {
            SuspendLayout();
            _tabs.Appearance = TabAppearance.FlatButtons;
            _tabs.SizeMode = TabSizeMode.Fixed;
            _tabs.ItemSize = new Size(0, 1);
            _tabs.Padding = new Point(0, 0);
            _tabs.Dock = DockStyle.Fill;
            _tabs.TabPages.Add(BuildDashboardTab());
            _tabs.TabPages.Add(BuildConfigurationTab());
            _tabs.TabPages.Add(BuildPluginsTab());
            _tabs.TabPages.Add(BuildSessionsTab());
            _tabs.TabPages.Add(BuildMemoriesTab());
            _tabs.TabPages.Add(BuildLogsTab());
            foreach (TabPage page in _tabs.TabPages) page.BackColor = UiPalette.Background;

            TableLayoutPanel shell = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 3,
                BackColor = Color.Transparent,
                Padding = new Padding(18),
            };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 244));
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 98));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));

            GlassPanel header = new GlassPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 14) };
            BrandMark brandMark = new BrandMark { Location = new Point(24, 16) };
            Label brand = new Label
            {
                Text = "DevSpace Portable",
                Font = UiTypography.Display(18.5F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(82, 15),
            };
            _pageTitle.Text = "状态与部署";
            _pageTitle.Font = UiTypography.Ui(9.5F);
            _pageTitle.ForeColor = UiPalette.TextMuted;
            _pageTitle.AutoSize = true;
            _pageTitle.Location = new Point(84, 49);
            _computerUseToggle.Text = "Computer Use";
            _computerUseToggle.Width = 168;
            _computerUseToggle.BackColor = UiPalette.Surface;
            _computerUseToggle.CheckedChanged += async delegate { await RunUiActionAsync(ComputerUseToggleChangedAsync); };
            Panel headerActions = new Panel { Dock = DockStyle.Right, Width = 212, BackColor = Color.Transparent };
            headerActions.Controls.Add(_computerUseToggle);
            Action centerHeaderToggle = delegate
            {
                _computerUseToggle.Location = new Point(20, Math.Max(0, (headerActions.ClientSize.Height - _computerUseToggle.Height) / 2));
            };
            headerActions.Resize += delegate { centerHeaderToggle(); };
            centerHeaderToggle();
            header.Controls.Add(brandMark);
            header.Controls.Add(brand);
            header.Controls.Add(_pageTitle);
            header.Controls.Add(headerActions);
            shell.Controls.Add(header, 0, 0);
            shell.SetColumnSpan(header, 2);

            GlassPanel navigation = new GlassPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 14, 0), Padding = new Padding(14, 18, 14, 18) };
            FlowLayoutPanel navStack = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                BackColor = UiPalette.Surface,
                AutoScroll = false,
            };
            AddNavigation(navStack, 0, "状态与部署", "OVERVIEW", 0);
            AddNavigation(navStack, 1, "配置与权限", "SETTINGS", 1);
            AddNavigation(navStack, 2, "插件管理", "EXTENSIONS", 2);
            AddNavigation(navStack, 3, "会话与回退", "REVIEW", 3);
            AddNavigation(navStack, 4, "显式 Memories", "MEMORIES", 4);
            AddNavigation(navStack, 5, "日志与诊断", "DIAGNOSTICS", 5);
            Action fitNavigationButtons = delegate
            {
                int available = Math.Max(120, navStack.ClientSize.Width - 8);
                foreach (Control child in navStack.Controls)
                {
                    ModernNavButton navButton = child as ModernNavButton;
                    if (navButton != null && navButton.Width != available) navButton.Width = available;
                }
            };
            navStack.SizeChanged += delegate { fitNavigationButtons(); };
            navigation.SizeChanged += delegate { fitNavigationButtons(); };
            navigation.Controls.Add(navStack);
            shell.Controls.Add(navigation, 0, 1);

            GlassPanel content = new GlassPanel { Dock = DockStyle.Fill, Padding = new Padding(14), Margin = new Padding(0) };
            _contentLayout.Dock = DockStyle.Fill;
            _contentLayout.ColumnCount = 1;
            _contentLayout.RowCount = 2;
            _contentLayout.BackColor = UiPalette.Surface;
            _contentLayout.Margin = new Padding(0);
            _contentLayout.Padding = new Padding(0);
            _contentLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            _contentLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 0));
            _contentLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            _contentLayout.Controls.Add(_inlineNotice, 0, 0);
            _contentLayout.Controls.Add(_tabs, 0, 1);
            content.Controls.Add(_contentLayout);
            shell.Controls.Add(content, 1, 1);

            Panel footer = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Margin = new Padding(2, 7, 2, 0) };
            _versionLabel.Text = "DevSpace Portable 1.1.41 · Protocol 1.5";
            _versionLabel.ForeColor = UiPalette.TextMuted;
            _versionLabel.AutoSize = true;
            _versionLabel.Location = new Point(4, 5);
            _leaseLabel.ForeColor = UiPalette.TextMuted;
            _leaseLabel.TextAlign = ContentAlignment.MiddleRight;
            _leaseLabel.Text = "本地桌面服务正在初始化";
            _leaseLabel.AutoEllipsis = true;
            _leaseLabel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _leaseLabel.Size = new Size(650, 24);
            _leaseLabel.Location = new Point(Math.Max(0, footer.Width - 655), 2);
            footer.Resize += delegate { _leaseLabel.Left = Math.Max(0, footer.ClientSize.Width - _leaseLabel.Width - 4); };
            footer.Controls.Add(_versionLabel);
            footer.Controls.Add(_leaseLabel);
            shell.Controls.Add(footer, 0, 2);
            shell.SetColumnSpan(footer, 2);

            Controls.Add(shell);
            SelectPage(0);
            fitNavigationButtons();
            ResumeLayout(true);
        }

        private void AddNavigation(Control parent, int iconKind, string title, string subtitle, int index)
        {
            ModernNavButton button = new ModernNavButton
            {
                IconKind = iconKind,
                Text = title,
                Title = title,
                Subtitle = subtitle,
                Width = 194,
                Height = 58,
                Margin = new Padding(4, 4, 4, 10),
            };
            button.Click += delegate { SelectPage(index); };
            _navButtons.Add(button);
            parent.Controls.Add(button);
        }

        private void SelectPage(int index)
        {
            if (index < 0 || index >= _tabs.TabPages.Count) return;
            CloseOpenDropDowns(this);
            SuspendLayout();
            _tabs.SelectedIndex = index;
            _pageTitle.Text = _tabs.TabPages[index].Text;
            for (int i = 0; i < _navButtons.Count; i++) _navButtons[i].Selected = i == index;
            _tabs.SelectedTab.Invalidate(true);
            _tabs.SelectedTab.Update();
            ResumeLayout(true);
        }

        private TabPage BuildDashboardTab()
        {
            TabPage page = new TabPage("状态与部署");
            TableLayoutPanel layout = NewTable(1, 3);
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            FlowLayoutPanel buttons = NewButtonBar();
            buttons.Controls.Add(ActionButton("保存并部署本地 MCP", async delegate { await DeployAsync(); }, true));
            buttons.Controls.Add(ActionButton("启动本地 MCP", async delegate { await RunActionAsync("start-local"); }));
            buttons.Controls.Add(ActionButton("重启本地 MCP", async delegate { await ConfirmActionAsync("restart-local", "确定只重启本地 MCP 吗？公网隧道不会被停止或重启。"); }));
            buttons.Controls.Add(ActionButton("启动公网隧道", async delegate { await RunActionAsync("start-tunnel"); }, true));
            buttons.Controls.Add(ActionButton("重启公网隧道", async delegate { await ConfirmActionAsync("restart-tunnel", "确定只重启 DevSpace 公网隧道吗？本地 MCP 将保持运行。"); }));
            buttons.Controls.Add(ActionButton("停止公网隧道", async delegate { await ConfirmActionAsync("stop-tunnel", "确定停止公网隧道吗？本地 MCP 将继续运行。"); }, false, true));
            buttons.Controls.Add(ActionButton("停止全部并退出", async delegate { await StopEverythingAsync(); }, false, true));
            buttons.Controls.Add(ActionButton("停止并禁用", async delegate { await ConfirmActionAsync("disable", "确定停止并禁用 DevSpace 与隧道计划任务吗？"); }, false, true));
            buttons.Controls.Add(ActionButton("恢复并启动全部", async delegate { await RunActionAsync("enable"); }));
            buttons.Controls.Add(ActionButton("卸载计划任务", async delegate { await ConfirmActionAsync("uninstall-tasks", "确定卸载 DevSpace 与隧道计划任务吗？配置和认证数据不会删除。"); }, false, true));
            buttons.Controls.Add(ActionButton("检查更新", async delegate { await CheckForUpdatesAsync(); }, true));
            buttons.Controls.Add(ActionButton("详细信息", async delegate { await ShowDiagnosticsDetailsAsync(); }, true));
            buttons.Controls.Add(ActionButton("重置关闭选择", delegate
            {
                SaveClosePreference("");
                ShowInlineNotice("已恢复为每次点击关闭按钮时询问。", false);
            }));
            layout.Controls.Add(buttons, 0, 0);

            _overallStatus.Dock = DockStyle.Fill;
            _overallStatus.Margin = new Padding(4, 4, 4, 8);
            _overallStatus.SetStatus("working", "正在检查 DevSpace 状态", "主页会自动刷新，不需要手动点击“刷新状态”。");
            layout.Controls.Add(_overallStatus, 0, 1);

            TableLayoutPanel indicators = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 3,
                BackColor = UiPalette.Background,
                Padding = new Padding(0),
                Margin = new Padding(0),
            };
            indicators.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            indicators.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            indicators.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            indicators.RowStyles.Add(new RowStyle(SizeType.Percent, 33.33F));
            indicators.RowStyles.Add(new RowStyle(SizeType.Percent, 33.34F));
            _serviceStatus.Dock = DockStyle.Fill;
            _tunnelStatus.Dock = DockStyle.Fill;
            _httpStatus.Dock = DockStyle.Fill;
            _filesStatus.Dock = DockStyle.Fill;
            _networkStatus.Dock = DockStyle.Fill;
            _computerUseStatus.Dock = DockStyle.Fill;
            _computerUseStatus.SetStatus("stopped", "Computer Use 未启用", "可通过右上角开关启用交互式桌面控制。");
            indicators.Controls.Add(_serviceStatus, 0, 0);
            indicators.Controls.Add(_tunnelStatus, 1, 0);
            indicators.Controls.Add(_httpStatus, 0, 1);
            indicators.Controls.Add(_filesStatus, 1, 1);
            indicators.Controls.Add(_networkStatus, 0, 2);
            indicators.Controls.Add(_computerUseStatus, 1, 2);
            layout.Controls.Add(indicators, 0, 2);

            page.Controls.Add(layout);
            return page;
        }

        private TabPage BuildConfigurationTab()
        {
            TabPage page = new TabPage("配置与权限");
            Panel scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, AutoScrollMargin = new Size(0, 32), BackColor = UiPalette.Background };
            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 2,
                RowCount = 3,
                Padding = new Padding(12, 12, 24, 32),
                BackColor = UiPalette.Background,
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            GroupBox network = NewAutoGroup("公网与本地服务");
            TableLayoutPanel networkForm = NewFormTable();
            _provider = AddCombo(networkForm, "隧道提供商", new[] { "ngrok", "cloudflare" });
            _provider.SelectedIndexChanged += ProviderChanged;
            _publicUrl = AddText(networkForm, "公网 HTTPS 根地址");
            _port = AddNumber(networkForm, "本地端口", 1, 65535, 7676);
            _toolMode = AddCombo(networkForm, "工具模式", new[] { "full", "codex", "minimal" });
            _ngrokToken = AddPassword(networkForm, "ngrok Authtoken（留空保留）");
            _ngrokProxy = AddText(networkForm, "ngrok 出站代理（可选）");
            _tunnelNetworkCompatibility = AddCheck(networkForm, "网络隔离监测（推荐）", "tunnelNetworkCompatibility");
            _ngrokCas = AddCheck(networkForm, "使用 Windows 根证书", "ngrokConnectCasHost");
            _cloudflareToken = AddPassword(networkForm, "Cloudflare Tunnel Token（留空保留）");
            network.Controls.Add(networkForm);

            GroupBox access = NewAutoGroup("目录、权限和功能");
            TableLayoutPanel accessForm = NewFormTable();
            _accessProfile = AddCombo(accessForm, "访问权限", new[] { "workspace", "full-access", "custom" });
            _roots = AddMultiline(accessForm, "允许的工作目录（每行一个）", 92);
            _allDrives = AddCheck(accessForm, "开放当前全部盘符根目录", "allowAllFixedDrives");
            AddPermission(accessForm, "允许工作区外路径", "allowExternalPaths");
            AddPermission(accessForm, "允许任意命令", "allowArbitraryCommands");
            AddPermission(accessForm, "允许 Shell 修改文件", "allowShellMutation");
            AddPermission(accessForm, "允许网络和 SSH", "allowNetworkAccess");
            AddPermission(accessForm, "允许凭据接口", "allowCredentialAccess");
            AddPermission(accessForm, "允许 Computer Use", "allowComputerUse");
            AddPermission(accessForm, "允许交互式进程", "allowInteractiveProcesses");
            AddPermission(accessForm, "允许持续进程", "allowPersistentProcesses");
            AddFeature(accessForm, "启用 Computer Use", "computerUse");
            AddFeature(accessForm, "启用显式 Memories", "memories");
            AddFeature(accessForm, "启用生命周期 Hooks", "hooks");
            AddFeature(accessForm, "启用会话修改统计与回退", "uiSessionReview");
            _ownerToken = AddPassword(accessForm, "Owner Password（留空保留/首次自动生成）");
            access.Controls.Add(accessForm);

            layout.Controls.Add(network, 0, 0);
            layout.Controls.Add(access, 1, 0);
            FlowLayoutPanel actions = NewButtonBar();
            actions.Controls.Add(ActionButton("添加工作目录", delegate { AddWorkspaceRoot(); }));
            actions.Controls.Add(ActionButton("AI / MCP OAuth 客户端", delegate { OpenOAuthClientsDialog(); }));
            actions.Controls.Add(ActionButton("远程服务器 / Linux Agent", delegate { OpenRemoteAgentsDialog(); }));
            actions.Controls.Add(ActionButton("只保存设置", async delegate { await SaveConfigurationAsync(false); }, true));
            actions.Controls.Add(ActionButton("保存并部署本地 MCP", async delegate { await DeployAsync(); }));
            actions.Controls.Add(ActionButton("重新加载", async delegate { await LoadConfigurationAsync(); }));
            layout.Controls.Add(actions, 0, 1);
            layout.SetColumnSpan(actions, 2);
            scroll.Controls.Add(layout);
            bool compactLayout = false;
            scroll.Resize += delegate
            {
                int availableWidth = Math.Max(1, scroll.ClientSize.Width - SystemInformation.VerticalScrollBarWidth);
                bool compact = availableWidth < 980;
                layout.Width = compact ? Math.Max(560, availableWidth) : Math.Max(900, availableWidth);
                if (compact == compactLayout) return;
                compactLayout = compact;
                layout.SuspendLayout();
                layout.ColumnStyles.Clear();
                if (compact)
                {
                    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
                    layout.SetCellPosition(actions, new TableLayoutPanelCellPosition(0, 2));
                    layout.SetCellPosition(network, new TableLayoutPanelCellPosition(0, 0));
                    layout.SetCellPosition(access, new TableLayoutPanelCellPosition(0, 1));
                    layout.SetColumnSpan(actions, 1);
                }
                else
                {
                    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
                    layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
                    layout.SetCellPosition(network, new TableLayoutPanelCellPosition(0, 0));
                    layout.SetCellPosition(access, new TableLayoutPanelCellPosition(1, 0));
                    layout.SetCellPosition(actions, new TableLayoutPanelCellPosition(0, 1));
                    layout.SetColumnSpan(actions, 2);
                }
                layout.ResumeLayout(true);
            };
            page.Controls.Add(scroll);
            return page;
        }

        private void OpenOAuthClientsDialog()
        {
            using (OAuthClientsDialog dialog = new OAuthClientsDialog(_manager))
            {
                dialog.ShowDialog(this);
            }
        }

        private void OpenRemoteAgentsDialog()
        {
            using (RemoteAgentsDialog dialog = new RemoteAgentsDialog(_manager))
            {
                dialog.ShowDialog(this);
            }
        }

        private TabPage BuildPluginsTab()
        {
            TabPage page = new TabPage("插件管理");
            SplitContainer split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                BorderStyle = BorderStyle.None,
                BackColor = UiPalette.Background,
            };
            SafeSplitLayout.Bind(split, 260, 240, 0.55D);
            TableLayoutPanel top = NewTable(1, 2);
            FlowLayoutPanel actions = NewButtonBar();
            actions.Controls.Add(ActionButton("刷新插件", async delegate { await LoadPluginsAsync(); }, true));
            actions.Controls.Add(ActionButton("安装插件", async delegate { await InstallPluginAsync(); }));
            actions.Controls.Add(ActionButton("导出当前选中插件包", async delegate { await ExportPluginAsync(); }));
            actions.Controls.Add(ActionButton("启用", async delegate { await PluginActionAsync("plugin-enable"); }));
            actions.Controls.Add(ActionButton("禁用", async delegate { await PluginActionAsync("plugin-disable"); }));
            actions.Controls.Add(ActionButton("卸载所选版本", async delegate { await UninstallPluginAsync(false); }, false, true));
            actions.Controls.Add(ActionButton("卸载全部版本", async delegate { await UninstallPluginAsync(true); }, false, true));
            _pluginVersion = new ModernComboBox { Width = 130 };
            StyleField(_pluginVersion);
            FlowLayoutPanel versionGroup = new FlowLayoutPanel
            {
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                WrapContents = false,
                BackColor = Color.Transparent,
                Margin = new Padding(4),
                Padding = new Padding(0, 0, 0, 4),
            };
            versionGroup.Controls.Add(ToolbarLabel("版本"));
            versionGroup.Controls.Add(WrapField(_pluginVersion, 130));
            actions.Controls.Add(versionGroup);
            top.Controls.Add(actions, 0, 0);
            ConfigurePluginGrid();
            top.Controls.Add(WrapSurface(_pluginGrid), 0, 1);
            split.Panel1.Controls.Add(top);

            TableLayoutPanel bottom = NewTable(1, 2);
            bottom.AutoScroll = false;
            bottom.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            bottom.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            TableLayoutPanel slotActions = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 6,
                RowCount = 2,
                BackColor = Color.Transparent,
                Margin = new Padding(0),
                Padding = new Padding(3, 3, 3, 8),
                MinimumSize = new Size(0, 104),
            };
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 106));
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            slotActions.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            slotActions.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            slotActions.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _slotNumber = new ModernComboBox();
            StyleField(_slotNumber);
            for (int i = 1; i <= 16; i++) _slotNumber.Items.Add(i);
            _slotNumber.SelectedIndex = 0;
            _slotPlugin = new ModernComboBox();
            _slotTool = new ModernComboBox();
            StyleField(_slotPlugin);
            StyleField(_slotTool);
            _slotPlugin.SelectedIndexChanged += delegate { PopulateSlotTools(); };
            Control slotNumberHost = WrapField(_slotNumber);
            Control slotPluginHost = WrapField(_slotPlugin);
            Control slotToolHost = WrapField(_slotTool);
            slotNumberHost.Dock = DockStyle.Fill;
            slotPluginHost.Dock = DockStyle.Fill;
            slotToolHost.Dock = DockStyle.Fill;
            slotPluginHost.MinimumSize = new Size(110, slotPluginHost.MinimumSize.Height);
            slotToolHost.MinimumSize = new Size(110, slotToolHost.MinimumSize.Height);
            slotActions.Controls.Add(ToolbarLabel("槽位"), 0, 0);
            slotActions.Controls.Add(slotNumberHost, 1, 0);
            slotActions.Controls.Add(ToolbarLabel("插件"), 2, 0);
            slotActions.Controls.Add(slotPluginHost, 3, 0);
            slotActions.Controls.Add(ActionButton("绑定", async delegate { await BindSlotAsync(); }, true), 4, 0);
            slotActions.Controls.Add(ActionButton("解除", async delegate { await UnbindSlotAsync(); }, false, true), 5, 0);
            slotActions.Controls.Add(ToolbarLabel("工具"), 2, 1);
            slotActions.Controls.Add(slotToolHost, 3, 1);
            slotActions.SetColumnSpan(slotToolHost, 3);
            bottom.Controls.Add(slotActions, 0, 0);
            ConfigureSlotGrid();
            bottom.Controls.Add(WrapSurface(_slotGrid), 0, 1);
            split.Panel2.Controls.Add(bottom);
            page.Controls.Add(split);
            return page;
        }

        private TabPage BuildSessionsTab()
        {
            TabPage page = new TabPage("会话与回退");
            _sessionPages.Appearance = TabAppearance.FlatButtons;
            _sessionPages.SizeMode = TabSizeMode.Fixed;
            _sessionPages.ItemSize = new Size(0, 1);
            _sessionPages.Padding = new Point(0, 0);
            _sessionPages.Dock = DockStyle.Fill;

            TabPage listPage = new TabPage("会话列表") { BackColor = UiPalette.Background };
            TableLayoutPanel listLayout = NewTable(1, 4);
            listLayout.AutoScroll = false;
            listLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
            listLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            listLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            listLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            Panel listIntro = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Padding = new Padding(12, 8, 12, 4) };
            Label listTitle = new Label
            {
                Text = "会话历史",
                Font = UiTypography.Display(16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(10, 8),
            };
            Label listHint = new Label
            {
                Text = "选择一轮会话进入独立审阅页，查看改动文件、逐文件差异并执行回退。",
                Font = UiTypography.Ui(9.25F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = true,
                Location = new Point(12, 44),
            };
            listIntro.Controls.Add(listTitle);
            listIntro.Controls.Add(listHint);
            listLayout.Controls.Add(listIntro, 0, 0);

            TableLayoutPanel filterBlock = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 1, RowCount = 2, BackColor = Color.Transparent, Margin = new Padding(0) };
            TableLayoutPanel searchRow = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                AutoSize = false,
                Height = 50,
                MinimumSize = new Size(0, 50),
                ColumnCount = 3,
                RowCount = 1,
                BackColor = Color.Transparent,
                Margin = new Padding(0),
                Padding = new Padding(3),
            };
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            searchRow.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            FlowLayoutPanel optionRow = NewButtonBar();
            _sessionSearch = new TextBox { Height = 34 };
            StyleField(_sessionSearch);
            _sessionSearch.TextChanged += delegate { RenderSessionList(); };
            _showEmptySessions = new ModernToggle { Text = "显示空会话", Width = 132, Margin = new Padding(8, 3, 2, 0) };
            _showHidden = new ModernToggle { Text = "显示隐藏", Width = 122, Margin = new Padding(8, 3, 2, 0) };
            _showArchived = new ModernToggle { Text = "显示归档", Width = 122, Margin = new Padding(8, 3, 2, 0) };
            _showEmptySessions.CheckedChanged += async delegate { await RunUiActionAsync(LoadSessionsAsync); };
            _showHidden.CheckedChanged += async delegate { await RunUiActionAsync(LoadSessionsAsync); };
            _showArchived.CheckedChanged += async delegate { await RunUiActionAsync(LoadSessionsAsync); };
            Control searchHost = WrapField(_sessionSearch);
            searchHost.Dock = DockStyle.Fill;
            searchHost.MinimumSize = new Size(90, searchHost.MinimumSize.Height);
            searchRow.Controls.Add(ToolbarLabel("搜索"), 0, 0);
            searchRow.Controls.Add(searchHost, 1, 0);
            searchRow.Controls.Add(ActionButton("刷新", async delegate { await LoadSessionsAsync(); }, true), 2, 0);
            optionRow.Controls.Add(_showEmptySessions);
            optionRow.Controls.Add(_showHidden);
            optionRow.Controls.Add(_showArchived);
            optionRow.Controls.Add(ActionButton("全部折叠", CollapseAllSessionGroups));
            optionRow.Controls.Add(ActionButton("全部展开", ExpandAllSessionGroups));
            filterBlock.Controls.Add(searchRow, 0, 0);
            filterBlock.Controls.Add(optionRow, 0, 1);
            listLayout.Controls.Add(filterBlock, 0, 1);
            ConfigureSessionGrid();
            listLayout.Controls.Add(WrapSurface(_sessionGrid), 0, 2);
            FlowLayoutPanel sessionActions = NewButtonBar();
            sessionActions.Controls.Add(ActionButton("查看本轮修改", async delegate { await OpenSelectedSessionAsync(); }, true));
            sessionActions.Controls.Add(ActionButton("重命名", async delegate { await RenameSessionAsync(); }));
            sessionActions.Controls.Add(ActionButton("置顶/取消", async delegate { await ToggleSessionAsync("pinned"); }));
            sessionActions.Controls.Add(ActionButton("隐藏/显示", async delegate { await ToggleSessionAsync("hidden"); }));
            sessionActions.Controls.Add(ActionButton("归档/恢复", async delegate { await ArchiveSessionAsync(); }));
            sessionActions.Controls.Add(ActionButton("打开目录", delegate { OpenSelectedSessionFolder(); }));
            listLayout.Controls.Add(sessionActions, 0, 3);
            listPage.Controls.Add(listLayout);

            TabPage detailPage = new TabPage("会话详情") { BackColor = UiPalette.Background };
            TableLayoutPanel details = NewTable(1, 3);
            details.AutoScroll = false;
            details.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));
            details.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            details.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            TableLayoutPanel detailHeader = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = Color.Transparent,
                Padding = new Padding(4, 4, 4, 8),
            };
            detailHeader.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            detailHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Button backButton = ActionButton("← 返回会话", delegate { ShowSessionListPage(); });
            backButton.Margin = new Padding(4, 14, 12, 8);
            detailHeader.Controls.Add(backButton, 0, 0);
            Panel detailTitles = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
            _sessionDetailTitle = new Label
            {
                Text = "本轮修改",
                Font = UiTypography.Display(15F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(6, 8),
            };
            _sessionDetailMeta = new Label
            {
                Text = "正在读取会话详情……",
                Font = UiTypography.Ui(9.25F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = true,
                Location = new Point(8, 45),
            };
            _sessionSummary = _sessionDetailMeta;
            detailTitles.Controls.Add(_sessionDetailTitle);
            detailTitles.Controls.Add(_sessionDetailMeta);
            detailHeader.Controls.Add(detailTitles, 1, 0);
            details.Controls.Add(detailHeader, 0, 0);

            FlowLayoutPanel reviewActions = NewButtonBar();
            reviewActions.Controls.Add(ActionButton("刷新修改", async delegate { await LoadSelectedSessionDetailsAsync(); }, true));
            reviewActions.Controls.Add(ActionButton("打开差异窗口", delegate { OpenSelectedFileDiff(); }, true));
            reviewActions.Controls.Add(ActionButton("回退此次修改", async delegate { await RollbackSelectedSessionAsync(); }, false, true));
            reviewActions.Controls.Add(ActionButton("恢复回退前快照", async delegate { await RestoreSafetySnapshotAsync(); }));
            reviewActions.Controls.Add(ActionButton("打开项目目录", delegate { OpenSelectedSessionFolder(); }));
            details.Controls.Add(reviewActions, 0, 1);

            ConfigureFileGrid();
            GroupBox filesGroup = NewGroup("本轮改动文件");
            filesGroup.Controls.Add(WrapSurface(_fileGrid));
            details.Controls.Add(filesGroup, 0, 2);
            detailPage.Controls.Add(details);

            _sessionPages.TabPages.Add(listPage);
            _sessionPages.TabPages.Add(detailPage);
            _sessionPages.SelectedIndex = 0;
            page.Controls.Add(_sessionPages);
            return page;
        }

        private TabPage BuildMemoriesTab()
        {
            TabPage page = new TabPage("显式 Memories");
            SplitContainer split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Size = new Size(1080, 680),
                SplitterWidth = 14,
                BorderStyle = BorderStyle.None,
                BackColor = UiPalette.Background,
            };
            SafeSplitLayout.Bind(split, 380, 380, 0.48D);

            TableLayoutPanel list = NewTable(1, 5);
            list.AutoScroll = false;
            list.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
            list.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            list.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            list.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            list.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Panel intro = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Padding = new Padding(10, 8, 10, 4) };
            intro.Controls.Add(new Label
            {
                Text = "显式 Memories",
                Font = UiTypography.Display(16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(8, 8),
            });
            intro.Controls.Add(new Label
            {
                Text = "这些记录由用户明确维护，不会从命令输出或浏览历史中自动推断。",
                Font = UiTypography.Ui(9.25F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = true,
                Location = new Point(10, 44),
            });
            list.Controls.Add(intro, 0, 0);

            TableLayoutPanel scopeBar = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 3, BackColor = Color.Transparent, Padding = new Padding(3) };
            scopeBar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            scopeBar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            scopeBar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _memoryViewWorkspace = new ModernComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
            StyleField(_memoryViewWorkspace);
            _memoryViewWorkspace.SelectedIndexChanged += delegate { if (!_memoryListLoading) RenderMemoryList(); };
            Control memoryWorkspaceHost = WrapField(_memoryViewWorkspace);
            memoryWorkspaceHost.Dock = DockStyle.Fill;
            _showOtherWorkspaceMemories = new CheckBox
            {
                Text = "显示其他",
                AutoSize = true,
                Font = UiTypography.Ui(9F),
                ForeColor = UiPalette.TextMuted,
                BackColor = Color.Transparent,
                Padding = new Padding(6, 7, 4, 4),
            };
            _showOtherWorkspaceMemories.CheckedChanged += delegate { if (!_memoryListLoading) RenderMemoryList(); };
            scopeBar.Controls.Add(ToolbarLabel("查看工作区"), 0, 0);
            scopeBar.Controls.Add(memoryWorkspaceHost, 1, 0);
            scopeBar.Controls.Add(_showOtherWorkspaceMemories, 2, 0);
            list.Controls.Add(scopeBar, 0, 1);

            TableLayoutPanel search = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2, BackColor = Color.Transparent, Padding = new Padding(3) };
            search.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            search.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            _memorySearch = new TextBox();
            StyleField(_memorySearch);
            _memorySearch.TextChanged += delegate { RenderMemoryList(); };
            Control memorySearchHost = WrapField(_memorySearch);
            memorySearchHost.Dock = DockStyle.Fill;
            search.Controls.Add(ToolbarLabel("搜索"), 0, 0);
            search.Controls.Add(memorySearchHost, 1, 0);
            list.Controls.Add(search, 0, 2);
            ConfigureMemoryGrid();
            list.Controls.Add(WrapSurface(_memoryGrid), 0, 3);
            FlowLayoutPanel memoryListActions = NewButtonBar();
            memoryListActions.Controls.Add(ActionButton("刷新", async delegate { await LoadMemoriesAsync(); }));
            memoryListActions.Controls.Add(ActionButton("新建 Memory", delegate { BeginNewMemory(); }, true));
            memoryListActions.Controls.Add(ActionButton("删除所选", async delegate { await DeleteSelectedMemoryAsync(); }, false, true));
            list.Controls.Add(memoryListActions, 0, 4);
            split.Panel1.Controls.Add(list);

            TableLayoutPanel editorLayout = NewTable(1, 4);
            editorLayout.AutoScroll = false;
            editorLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
            editorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            editorLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            editorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _memoryStatus = new Label
            {
                Dock = DockStyle.Fill,
                Text = "新建或选择一条 Memory。",
                Font = UiTypography.Ui(10F),
                ForeColor = UiPalette.TextMuted,
                Padding = new Padding(12, 16, 12, 8),
                AutoEllipsis = true,
            };
            editorLayout.Controls.Add(_memoryStatus, 0, 0);

            FlowLayoutPanel previewActions = NewButtonBar();
            previewActions.Controls.Add(ActionButton("打开完整内容窗口", delegate { OpenMemoryPreviewWindow(); }, true));
            previewActions.Controls.Add(new Label
            {
                AutoSize = true,
                Text = "独立窗口支持自由缩放和最大化；切换 Memory 时内容会同步更新。",
                Font = UiTypography.Ui(8.75F),
                ForeColor = UiPalette.TextMuted,
                BackColor = Color.Transparent,
                Padding = new Padding(10, 10, 0, 0),
            });
            editorLayout.Controls.Add(previewActions, 0, 1);

            GroupBox editor = NewGroup("Memory 内容");
            TableLayoutPanel form = NewFormTable();
            _memoryScope = AddCombo(form, "作用域", new[] { "workspace", "global" });
            _memoryScope.SelectedIndexChanged += delegate { UpdateMemoryWorkspaceState(); };
            _memoryWorkspace = AddCombo(form, "工作区", new string[0]);
            _memoryTitle = AddText(form, "标题");
            _memoryTags = AddText(form, "标签（逗号分隔）");
            _memoryContent = AddMultiline(form, "内容", 260);
            Panel editorScroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = UiPalette.Surface };
            editorScroll.Controls.Add(form);
            editor.Controls.Add(editorScroll);
            editorLayout.Controls.Add(editor, 0, 2);
            FlowLayoutPanel editorActions = NewButtonBar();
            editorActions.Controls.Add(ActionButton("保存 Memory", async delegate { await SaveMemoryAsync(); }, true));
            editorActions.Controls.Add(ActionButton("清空编辑器", delegate { BeginNewMemory(); }));
            editorLayout.Controls.Add(editorActions, 0, 3);
            split.Panel2.Controls.Add(editorLayout);

            page.Controls.Add(split);
            return page;
        }

        private TabPage BuildLogsTab()
        {
            TabPage page = new TabPage("日志与诊断");
            TableLayoutPanel layout = NewTable(1, 2);
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            FlowLayoutPanel buttons = NewButtonBar();
            buttons.Controls.Add(ActionButton("刷新日志", async delegate { await LoadLogsAsync(); }, true));
            buttons.Controls.Add(ActionButton("打开日志目录", delegate { OpenExternal(Path.Combine(_root, "logs")); }));
            buttons.Controls.Add(ActionButton("运行诊断", async delegate { await RunActionAsync("diagnose"); }));
            layout.Controls.Add(buttons, 0, 0);
            SplitContainer logSplit = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                Size = new Size(1000, 640),
                SplitterWidth = 12,
                BackColor = UiPalette.Background,
            };
            SafeSplitLayout.Bind(logSplit, 180, 160, 0.62D);
            GroupBox dev = NewGroup("DevSpace 日志 · 可拖动分隔条调整大小");
            dev.Controls.Add(_devspaceLog);
            GroupBox tunnel = NewGroup("隧道日志");
            tunnel.Controls.Add(_tunnelLog);
            logSplit.Panel1.Controls.Add(dev);
            logSplit.Panel2.Controls.Add(tunnel);
            layout.Controls.Add(logSplit, 0, 1);
            page.Controls.Add(layout);
            return page;
        }

        private async Task InitializeAsync()
        {
            SetOutput("正在加载本地配置、插件、会话与 Memories……");
            UseWaitCursor = true;
            try
            {
                await AcquireLeaseAsync();
                _heartbeatTimer.Start();
                _statusTimer.Start();
                _computerUseTimer.Start();
                _computerUseIndicatorTimer.Start();
                _remoteAgentRecoveryTimer.Start();
                await LoadConfigurationAsync();
                await LoadPluginsAsync();
                await LoadSessionsAsync();
                await LoadMemoriesAsync();
                await LoadLogsAsync();
                await RefreshDashboardStatusAsync();
            }
            catch (Exception ex) { ShowError(ex); }
            finally { UseWaitCursor = false; }
        }

        private async Task HeartbeatAsync()
        {
            if (_closing || _heartbeatBusy || string.IsNullOrEmpty(_leaseId)) return;
            _heartbeatBusy = true;
            try
            {
                Dictionary<string, object> lease = await _manager.RunJsonAsync("ui-heartbeat", new { leaseId = _leaseId });
                string refreshedLeaseId = GetString(lease, "leaseId");
                if (!string.IsNullOrEmpty(refreshedLeaseId)) _leaseId = refreshedLeaseId;
                UpdateLeaseLabel(lease);
            }
            catch (Exception firstError)
            {
                try { await AcquireLeaseAsync(); }
                catch (Exception recoveryError)
                {
                    _leaseLabel.ForeColor = UiPalette.Danger;
                    _leaseLabel.Text = "本地桌面服务暂不可用 · " + FirstLine(recoveryError.Message ?? firstError.Message);
                }
            }
            finally { _heartbeatBusy = false; }
        }

        private async Task AcquireLeaseAsync()
        {
            Dictionary<string, object> lease = await _manager.RunJsonAsync("ui-open");
            string leaseId = GetString(lease, "leaseId");
            if (string.IsNullOrEmpty(leaseId)) throw new InvalidOperationException("本地桌面服务没有返回有效租约。");
            _leaseId = leaseId;
            UpdateLeaseLabel(lease);
        }

        private void UpdateLeaseLabel(Dictionary<string, object> lease)
        {
            Dictionary<string, object> broker = GetDictionary(lease, "broker");
            bool computerUseEnabled = GetBool(lease, "computerUseEnabled", !GetBool(broker, "disabled"));
            bool ready = GetBool(broker, "ready");
            if (!computerUseEnabled || GetBool(broker, "disabled"))
            {
                _computerUseIndicator.Hide();
                _leaseLabel.ForeColor = UiPalette.TextMuted;
                _leaseLabel.Text = "本地桌面服务在线 · Computer Use 已关闭";
                _computerUseStatus.SetStatus("stopped", "Computer Use 未启用", "可通过右上角开关启用交互式桌面控制。");
            }
            else if (ready)
            {
                _leaseLabel.ForeColor = UiPalette.Success;
                _leaseLabel.Text = "Computer Use 在线 · PID " + GetInt(broker, "pid");
                _computerUseStatus.SetStatus("ready", "Computer Use 已就绪", "本地交互式桌面 Broker 在线 · PID " + GetInt(broker, "pid"));
            }
            else
            {
                _leaseLabel.ForeColor = Color.FromArgb(210, 132, 30);
                _leaseLabel.Text = "Computer Use 正在启动 · " + GetString(broker, "reason", "waiting");
                _computerUseStatus.SetStatus("warning", "Computer Use 正在启动", GetString(broker, "reason", "waiting"));
            }
        }

        private async Task ComputerUseToggleChangedAsync()
        {
            if (_loadingConfiguration || _closing || _featureBoxes.Count == 0) return;
            bool enabled = _computerUseToggle.Checked;
            string profile = Convert.ToString(_accessProfile.SelectedItem ?? "workspace");
            if (enabled && string.Equals(profile, "workspace", StringComparison.OrdinalIgnoreCase))
            {
                _loadingConfiguration = true;
                _computerUseToggle.Checked = false;
                _loadingConfiguration = false;
                ShowInlineNotice("Computer Use 需要 full-access，或在 custom 权限中允许桌面控制；已保持关闭，请先调整访问权限。", false);
                SelectPage(1);
                return;
            }
            _featureBoxes["computerUse"].Checked = enabled;
            if (enabled && _permissionBoxes.ContainsKey("allowComputerUse")) _permissionBoxes["allowComputerUse"].Checked = true;
            await ExecuteBusyAsync(async delegate
            {
                await _manager.RunJsonAsync("set-computer-use", new { enabled = enabled });
                await AcquireLeaseAsync();
                SetOutput(enabled ? "Computer Use 已开启。" : "Computer Use 已关闭，桌面 Broker 已停止。");
            });
        }

        private async Task LoadConfigurationAsync()
        {
            _loadingConfiguration = true;
            try
            {
            _currentConfig = await _manager.RunJsonAsync("show-config");
            _providerUrls.Clear();
            Dictionary<string, object> providerUrls = GetDictionary(_currentConfig, "providerUrls");
            _providerUrls["ngrok"] = GetString(providerUrls, "ngrok");
            _providerUrls["cloudflare"] = GetString(providerUrls, "cloudflare");
            _selectedProviderName = "";
            _provider.SelectedItem = GetString(_currentConfig, "tunnelProvider", "ngrok");
            _selectedProviderName = Convert.ToString(_provider.SelectedItem ?? "ngrok");
            _publicUrl.Text = _providerUrls.ContainsKey(_selectedProviderName) && !string.IsNullOrWhiteSpace(_providerUrls[_selectedProviderName])
                ? _providerUrls[_selectedProviderName]
                : GetString(_currentConfig, "publicBaseUrl");
            _port.Value = Math.Max(_port.Minimum, Math.Min(_port.Maximum, GetInt(_currentConfig, "port", 7676)));
            _toolMode.SelectedItem = GetString(_currentConfig, "toolMode", "full");
            Dictionary<string, object> permissions = GetDictionary(_currentConfig, "permissions");
            _accessProfile.SelectedItem = GetString(permissions, "profile", "workspace");
            foreach (KeyValuePair<string, CheckBox> item in _permissionBoxes) item.Value.Checked = GetBool(permissions, item.Key);
            Dictionary<string, object> features = GetDictionary(_currentConfig, "features");
            foreach (KeyValuePair<string, CheckBox> item in _featureBoxes) item.Value.Checked = GetBool(features, item.Key, item.Key != "computerUse");
            _computerUseToggle.Checked = GetBool(features, "computerUse");
            _roots.Text = string.Join(Environment.NewLine, GetStringList(_currentConfig, "allowedRoots"));
            _allDrives.Checked = GetString(_currentConfig, "permissionMode") == "all-drive-roots";
            _ngrokProxy.Text = GetString(_currentConfig, "ngrokProxyUrl");
            _tunnelNetworkCompatibility.Checked = GetBool(_currentConfig, "tunnelNetworkCompatibility", true);
            _ngrokCas.Checked = GetBool(_currentConfig, "ngrokConnectCasHost");
            _versionLabel.Text = "DevSpace Portable " + GetString(_currentConfig, "portableVersion", "1.1.41") + " · Protocol " + GetString(_currentConfig, "protocolVersion", "1.5");
            PopulateMemoryWorkspaces();
            }
            finally { _loadingConfiguration = false; }
        }

        private void ProviderChanged(object sender, EventArgs e)
        {
            string next = Convert.ToString(_provider.SelectedItem ?? "ngrok");
            if (!string.IsNullOrEmpty(_selectedProviderName)) _providerUrls[_selectedProviderName] = _publicUrl.Text.Trim();
            _selectedProviderName = next;
            string value;
            if (_providerUrls.TryGetValue(next, out value)) _publicUrl.Text = value ?? "";
        }

        private object CollectConfiguration()
        {
            Dictionary<string, object> permissions = new Dictionary<string, object>();
            permissions["profile"] = Convert.ToString(_accessProfile.SelectedItem ?? "workspace");
            foreach (KeyValuePair<string, CheckBox> item in _permissionBoxes) permissions[item.Key] = item.Value.Checked;
            Dictionary<string, object> features = new Dictionary<string, object>();
            foreach (KeyValuePair<string, CheckBox> item in _featureBoxes) features[item.Key] = item.Value.Checked;
            return new
            {
                tunnelProvider = Convert.ToString(_provider.SelectedItem ?? "ngrok"),
                publicBaseUrl = _publicUrl.Text.Trim(),
                port = Decimal.ToInt32(_port.Value),
                toolMode = Convert.ToString(_toolMode.SelectedItem ?? "full"),
                permissions,
                features,
                allowedRoots = _roots.Lines.Select(line => line.Trim()).Where(line => line.Length > 0).ToArray(),
                allowAllFixedDrives = _allDrives.Checked,
                ngrokToken = _ngrokToken.Text,
                ngrokProxyUrl = _ngrokProxy.Text.Trim(),
                tunnelNetworkCompatibility = _tunnelNetworkCompatibility.Checked,
                ngrokConnectCasHost = _ngrokCas.Checked,
                cloudflareToken = _cloudflareToken.Text,
                ownerToken = _ownerToken.Text,
            };
        }

        private async Task SaveConfigurationAsync(bool silent)
        {
            Dictionary<string, object> result = await _manager.RunJsonAsync("configure", CollectConfiguration());
            _ngrokToken.Clear(); _cloudflareToken.Clear(); _ownerToken.Clear();
            if (GetBool(result, "generatedOwnerToken") && !string.IsNullOrEmpty(GetString(result, "ownerToken")))
                OwnerPasswordDialog.Show(
                    this,
                    GetString(result, "ownerToken"),
                    GetString(result, "authFile"));
            if (!silent) SetOutput("配置已保存。\r\nMCP URL: " + GetString(result, "mcpUrl"));
        }

        private void AddWorkspaceRoot()
        {
            using (FolderBrowserDialog folder = new FolderBrowserDialog { Description = "选择允许 DevSpace 访问的工作目录", ShowNewFolderButton = false })
            {
                if (folder.ShowDialog(this) != DialogResult.OK) return;
                List<string> roots = _roots.Lines.Select(line => line.Trim()).Where(line => line.Length > 0).ToList();
                if (!roots.Any(item => string.Equals(item, folder.SelectedPath, StringComparison.OrdinalIgnoreCase))) roots.Add(folder.SelectedPath);
                _roots.Lines = roots.ToArray();
            }
        }

        private async Task DeployAsync()
        {
            await ExecuteBusyAsync(async delegate
            {
                await SaveConfigurationAsync(true);
                SetOutput("正在安装任务并启动本地 MCP……\r\n公网隧道不会在此步骤自动启动；需要远程访问时请单独点击“启动公网隧道”。");
                string install = await _manager.RunAsync("install-tasks");
                string start = await _manager.RunAsync("start-local");
                string status = await _manager.RunAsync("status");
                SetOutput(install + Environment.NewLine + start + Environment.NewLine + status);
                await RefreshStatusAsync(false);
            });
            await RefreshDashboardStatusAsync();
        }

        private async Task RunActionAsync(string action)
        {
            await ExecuteBusyAsync(async delegate { SetOutput(await _manager.RunAsync(action)); });
            await RefreshDashboardStatusAsync();
        }

        private async Task ConfirmActionAsync(string action, string message)
        {
            if (MessageBox.Show(this, message, "确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                await RunActionAsync(action);
        }

        private async Task StopEverythingAsync()
        {
            if (MessageBox.Show(this, "将停止 DevSpace、隧道、Computer Use Broker 和 Portable 自有后台进程，并让现有计划任务保持禁用，随后关闭本程序。不会递归终止 DevSpace 启动的第三方应用。确定继续吗？", "停止全部", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                return;
            await ExecuteBusyAsync(async delegate
            {
                SetOutput(await _manager.RunAsync("shutdown"));
                _leaseId = "";
                _allowUiExit = true;
                Close();
            });
        }

        private async Task RefreshStatusAsync(bool switchTab)
        {
            try
            {
                string status = await _manager.RunAsync("status");
                SetOutput(status);
                if (switchTab) _tabs.SelectedIndex = 0;
            }
            catch (Exception ex) { if (switchTab) ShowError(ex); }
        }

        private async Task ShowDiagnosticsDetailsAsync()
        {
            using (DiagnosticsDetailsDialog dialog = new DiagnosticsDetailsDialog(_root, _manager))
            {
                dialog.StatusChanged += async delegate { await RefreshDashboardStatusAsync(); };
                dialog.ShowDialog(this);
            }
            await RefreshDashboardStatusAsync();
        }

        private async Task RefreshDashboardStatusAsync()
        {
            if (_closing || _dashboardStatusBusy || _busyOperationCount > 0) return;
            _dashboardStatusBusy = true;
            try
            {
                Dictionary<string, object> status = await _manager.RunJsonAsync("dashboard-status");
                ApplyIndicator("overall", _overallStatus, GetDictionary(status, "overall"));
                Dictionary<string, object> indicators = GetDictionary(status, "indicators");
                ApplyIndicator("service", _serviceStatus, GetDictionary(indicators, "service"));
                ApplyIndicator("tunnel", _tunnelStatus, GetDictionary(indicators, "tunnel"));
                ApplyIndicator("http", _httpStatus, GetDictionary(indicators, "http"));
                ApplyIndicator("files", _filesStatus, GetDictionary(indicators, "files"));
                ApplyIndicator("network", _networkStatus, GetDictionary(indicators, "network"));
            }
            catch (Exception ex)
            {
                _overallStatus.SetStatus("warning", "状态自动刷新暂时失败", FirstLine(ex.Message));
                MarkIndicatorAwaitingRefresh(_serviceStatus);
                MarkIndicatorAwaitingRefresh(_tunnelStatus);
                MarkIndicatorAwaitingRefresh(_httpStatus);
                MarkIndicatorAwaitingRefresh(_filesStatus);
                MarkIndicatorAwaitingRefresh(_networkStatus);
            }
            finally { _dashboardStatusBusy = false; }
        }

        private void ApplyIndicator(string key, StatusIndicatorCard card, Dictionary<string, object> value)
        {
            if (card == null) return;
            string state = GetString(value, "state", "working");
            string title = GetString(value, "title", "正在检查");
            string detail = GetString(value, "detail", "正在读取状态……");
            if (state == "error" || state == "stopped")
            {
                int count;
                _dashboardProblemCounts.TryGetValue(key, out count);
                count++;
                _dashboardProblemCounts[key] = count;
                if (count < 2)
                {
                    card.SetStatus("warning", "正在复核：" + title, detail + " · 连续两次确认后才会标记为异常");
                    return;
                }
            }
            else
            {
                _dashboardProblemCounts[key] = 0;
            }
            card.SetStatus(state, title, detail);
        }

        private static void MarkIndicatorAwaitingRefresh(StatusIndicatorCard card)
        {
            if (card != null) card.SetStatus("warning", "等待下一次自动检查", "本轮状态读取失败，未沿用可能已经过期的红色结果。");
        }

        private async Task CheckForUpdatesAsync()
        {
            await Task.Yield();
            string updater = Path.Combine(_root, "Update.exe");
            if (!File.Exists(updater))
                throw new FileNotFoundException("独立更新程序不存在。请重新解压完整 Release。", updater);
            if (Directory.Exists(Path.Combine(_root, ".git")))
            {
                MessageBox.Show(this,
                    "检测到当前目录是 Git 源码工作区。独立 Update.exe 不会覆盖源码检出目录，请在正式 Release 解压目录中使用在线更新。",
                    "源码工作区不执行热更新",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }
            if (TryActivateExistingUpdater(updater))
            {
                SetOutput("检测到当前 Portable 的 Update.exe 已经在运行，已将更新窗口切换到前台。");
                return;
            }
            string arguments = "--parent-ui " + Process.GetCurrentProcess().Id;
            Process process = Process.Start(new ProcessStartInfo
            {
                FileName = updater,
                Arguments = arguments,
                WorkingDirectory = _root,
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Normal,
            });
            if (process == null) throw new InvalidOperationException("Windows 没有返回 Update.exe 进程，更新窗口未启动。");
            using (process)
            {
                IntPtr window = await WaitForVisibleUpdaterWindowAsync(process, 7000);
                if (window != IntPtr.Zero) NativeWindowEffects.ActivateWindow(window);
            }
            SetOutput("已启动或切换到独立 Update.exe。\r\n\r\n检查、下载、校验和安装进度都会在独立更新窗口中显示；主控制中心在下载阶段保持运行，只有真正开始替换文件时才会关闭。");
        }

        private bool TryActivateExistingUpdater(string updater)
        {
            string expected;
            try { expected = Path.GetFullPath(updater); }
            catch { return false; }
            foreach (Process process in Process.GetProcessesByName("Update"))
            {
                using (process)
                {
                    try
                    {
                        if (process.HasExited) continue;
                        string actual = Path.GetFullPath(process.MainModule.FileName);
                        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) continue;
                        process.Refresh();
                        if (process.MainWindowHandle == IntPtr.Zero) continue;
                        NativeWindowEffects.ActivateWindow(process.MainWindowHandle);
                        return true;
                    }
                    catch { }
                }
            }
            return false;
        }

        private async Task<IntPtr> WaitForVisibleUpdaterWindowAsync(Process process, int timeoutMs)
        {
            if (process == null) throw new ArgumentNullException("process");
            Stopwatch stopwatch = Stopwatch.StartNew();
            try
            {
                await Task.Run(delegate
                {
                    try { process.WaitForInputIdle(Math.Min(timeoutMs, 5000)); }
                    catch { }
                });
            }
            catch { }
            while (stopwatch.ElapsedMilliseconds < timeoutMs)
            {
                process.Refresh();
                if (process.HasExited)
                {
                    if (TryActivateExistingUpdater(Path.Combine(_root, "Update.exe")))
                        return IntPtr.Zero;
                    throw new InvalidOperationException("Update.exe 启动后立即退出，退出码 " + process.ExitCode + "。请重新解压完整 Release 或查看 Windows 安全软件拦截记录。");
                }
                if (process.MainWindowHandle != IntPtr.Zero) return process.MainWindowHandle;
                await Task.Delay(100);
            }
            if (TryActivateExistingUpdater(Path.Combine(_root, "Update.exe")))
                return IntPtr.Zero;
            throw new InvalidOperationException("Update.exe 已启动，但 7 秒内没有创建可见更新窗口。请检查 Windows 安全软件或应用程序事件日志。");
        }

        private async Task LoadPluginsAsync()
        {
            Dictionary<string, object> value = await _manager.RunJsonAsync("plugin-list");
            List<Dictionary<string, object>> plugins = GetDictionaryList(value, "plugins");
            List<Dictionary<string, object>> slots = GetDictionaryList(value, "slots");
            _pluginGrid.Rows.Clear();
            _slotPlugin.Items.Clear();
            foreach (Dictionary<string, object> plugin in plugins)
            {
                Dictionary<string, object> dependency = GetDictionary(plugin, "dependencyStatus");
                int row = _pluginGrid.Rows.Add(GetString(plugin, "id"), GetString(plugin, "selectedVersion"), GetBool(plugin, "enabled"), GetString(dependency, "status"), GetString(plugin, "maturity"), GetDictionaryList(plugin, "dispatchTools").Count);
                _pluginGrid.Rows[row].Tag = plugin;
                if (GetBool(plugin, "enabled")) _slotPlugin.Items.Add(new ComboItem(GetString(plugin, "id"), GetString(plugin, "name") + " @ " + GetString(plugin, "selectedVersion"), plugin));
            }
            _slotGrid.Rows.Clear();
            foreach (Dictionary<string, object> slot in slots)
            {
                string binding = GetBool(slot, "bound") ? GetString(slot, "pluginId") + "/" + GetString(slot, "toolName") + " @ " + GetString(slot, "pluginVersion") : "未绑定";
                _slotGrid.Rows.Add(GetInt(slot, "slot"), GetString(slot, "name"), binding, GetString(slot, "status"));
            }
            if (_slotPlugin.Items.Count > 0) _slotPlugin.SelectedIndex = 0;
        }

        private Dictionary<string, object> SelectedPlugin()
        {
            if (_pluginGrid.SelectedRows.Count != 1) throw new InvalidOperationException("请先选择一个插件。 ");
            return (Dictionary<string, object>)_pluginGrid.SelectedRows[0].Tag;
        }

        private void PluginSelectionChanged(object sender, EventArgs e)
        {
            _pluginVersion.Items.Clear();
            if (_pluginGrid.SelectedRows.Count != 1) return;
            Dictionary<string, object> plugin = (Dictionary<string, object>)_pluginGrid.SelectedRows[0].Tag;
            foreach (Dictionary<string, object> version in GetDictionaryList(plugin, "versions")) _pluginVersion.Items.Add(GetString(version, "version"));
            string selected = GetString(plugin, "selectedVersion");
            if (_pluginVersion.Items.Contains(selected)) _pluginVersion.SelectedItem = selected;
        }

        private async Task PluginActionAsync(string action)
        {
            Dictionary<string, object> plugin = SelectedPlugin();
            object payload = action == "plugin-enable"
                ? new { pluginId = GetString(plugin, "id"), version = Convert.ToString(_pluginVersion.SelectedItem ?? GetString(plugin, "selectedVersion")) }
                : new { pluginId = GetString(plugin, "id") };
            await ExecuteBusyAsync(async delegate { await _manager.RunJsonAsync(action, payload); await LoadPluginsAsync(); });
        }

        private async Task InstallPluginAsync()
        {
            using (OpenFileDialog file = new OpenFileDialog { Filter = "DevSpace 插件 ZIP 或 manifest|*.zip;manifest.json|全部文件|*.*" })
            {
                if (file.ShowDialog(this) != DialogResult.OK) return;
                await ExecuteBusyAsync(async delegate { await _manager.RunJsonAsync("plugin-install", new { sourcePath = file.FileName, replace = false }); await LoadPluginsAsync(); });
            }
        }

        private async Task ExportPluginAsync()
        {
            Dictionary<string, object> plugin = SelectedPlugin();
            string id = GetString(plugin, "id");
            string version = Convert.ToString(_pluginVersion.SelectedItem ?? GetString(plugin, "selectedVersion"));
            string suggested = id + "-" + version + ".zip";
            foreach (char invalid in Path.GetInvalidFileNameChars()) suggested = suggested.Replace(invalid, '_');
            using (SaveFileDialog file = new SaveFileDialog
            {
                Filter = "DevSpace 插件包|*.zip",
                DefaultExt = "zip",
                AddExtension = true,
                FileName = suggested,
                OverwritePrompt = true,
                Title = "导出当前选中插件包",
            })
            {
                if (file.ShowDialog(this) != DialogResult.OK) return;
                await ExecuteBusyAsync(async delegate
                {
                    Dictionary<string, object> exported = await _manager.RunJsonAsync("plugin-export", new
                    {
                        pluginId = id,
                        version = version,
                        destinationPath = file.FileName,
                    });
                    Dictionary<string, object> result = GetDictionary(exported, "result");
                    SetOutput("插件包已导出：\r\n" + GetString(result, "destinationPath") + "\r\n\r\n版本：" + GetString(result, "version") + "\r\nSHA-256：" + GetString(result, "sha256"));
                });
            }
        }

        private async Task UninstallPluginAsync(bool allVersions)
        {
            Dictionary<string, object> plugin = SelectedPlugin();
            string id = GetString(plugin, "id");
            if (MessageBox.Show(this, "确定卸载 " + id + (allVersions ? " 的全部版本" : " 的所选版本") + " 吗？", "卸载插件", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            Dictionary<string, object> payload = new Dictionary<string, object> { ["pluginId"] = id };
            if (!allVersions) payload["version"] = Convert.ToString(_pluginVersion.SelectedItem ?? GetString(plugin, "selectedVersion"));
            await ExecuteBusyAsync(async delegate { await _manager.RunJsonAsync("plugin-uninstall", payload); await LoadPluginsAsync(); });
        }

        private void PopulateSlotTools()
        {
            _slotTool.Items.Clear();
            ComboItem selected = _slotPlugin.SelectedItem as ComboItem;
            if (selected == null) return;
            foreach (Dictionary<string, object> tool in GetDictionaryList(selected.Data, "dispatchTools")) _slotTool.Items.Add(GetString(tool, "name"));
            if (_slotTool.Items.Count > 0) _slotTool.SelectedIndex = 0;
        }

        private async Task BindSlotAsync()
        {
            ComboItem plugin = _slotPlugin.SelectedItem as ComboItem;
            if (plugin == null || _slotTool.SelectedItem == null) throw new InvalidOperationException("请选择插件和工具。 ");
            await ExecuteBusyAsync(async delegate
            {
                await _manager.RunJsonAsync("plugin-slot-bind", new { slot = Convert.ToInt32(_slotNumber.SelectedItem), pluginId = plugin.Value, toolName = Convert.ToString(_slotTool.SelectedItem) });
                await LoadPluginsAsync();
            });
        }

        private async Task UnbindSlotAsync()
        {
            await ExecuteBusyAsync(async delegate { await _manager.RunJsonAsync("plugin-slot-unbind", new { slot = Convert.ToInt32(_slotNumber.SelectedItem) }); await LoadPluginsAsync(); });
        }

        private async Task LoadSessionsAsync()
        {
            Dictionary<string, object> value = await _manager.RunJsonAsync("review-list", new
            {
                includeEmpty = _showEmptySessions != null && _showEmptySessions.Checked,
                includeHidden = _showHidden.Checked,
                includeArchived = _showArchived.Checked,
            });
            _allSessions = GetDictionaryList(value, "sessions");
            RenderSessionList();
        }

        private async Task OpenSelectedSessionAsync()
        {
            Dictionary<string, object> session = SelectedSession();
            _sessionDetailTitle.Text = GetString(session, "title", "本轮修改");
            _sessionDetailMeta.Text = "正在读取本轮改动……";
            _sessionPages.SelectedIndex = 1;
            await LoadSelectedSessionDetailsAsync();
        }

        private void ShowSessionListPage()
        {
            _sessionPages.SelectedIndex = 0;
            _pageTitle.Text = "会话与回退";
        }

        private void RenderSessionList()
        {
            string query = (_sessionSearch == null ? "" : _sessionSearch.Text).Trim().ToLowerInvariant();
            string selectedId = SelectedSessionId(false);
            _sessionListLoading = true;
            try
            {
                _sessionGrid.Rows.Clear();
                List<Dictionary<string, object>> visible = _allSessions.Where(session =>
                {
                    string title = GetString(session, "title");
                    string root = GetString(session, "root");
                    return query.Length == 0 || title.ToLowerInvariant().Contains(query) || root.ToLowerInvariant().Contains(query);
                }).ToList();

                IEnumerable<IGrouping<string, Dictionary<string, object>>> groups = visible
                    .GroupBy(session => NormalizeSessionTitle(GetString(session, "title")), StringComparer.OrdinalIgnoreCase)
                    .OrderByDescending(group => group.Any(session => GetBool(session, "pinned")))
                    .ThenByDescending(group => group.Max(SessionUpdatedAt));

                foreach (IGrouping<string, Dictionary<string, object>> group in groups)
                {
                    List<Dictionary<string, object>> sessions = group
                        .OrderByDescending(session => GetBool(session, "pinned"))
                        .ThenByDescending(SessionUpdatedAt)
                        .ToList();
                    bool expanded = query.Length > 0 || _expandedSessionGroups.Contains(group.Key);
                    int groupFiles = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "files"));
                    int groupAdditions = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "additions"));
                    int groupRemovals = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "removals"));
                    int headerIndex = _sessionGrid.Rows.Add(
                        sessions.Any(session => GetBool(session, "pinned")) ? "★" : "",
                        (expanded ? "▼ " : "▶ ") + group.Key + "  ·  " + sessions.Count + " 轮",
                        expanded ? "已展开" : "已折叠",
                        groupFiles,
                        "+" + groupAdditions + " -" + groupRemovals,
                        FormatLocalTime(GetString(sessions[0], "updatedAt")),
                        "");
                    DataGridViewRow header = _sessionGrid.Rows[headerIndex];
                    header.Tag = group.Key;
                    header.Height = 42;
                    header.DefaultCellStyle.BackColor = UiPalette.SurfaceStrong;
                    header.DefaultCellStyle.SelectionBackColor = UiPalette.SurfaceStrong;
                    header.DefaultCellStyle.ForeColor = UiPalette.Text;
                    header.DefaultCellStyle.SelectionForeColor = UiPalette.Text;
                    header.DefaultCellStyle.Font = _sessionGrid.ColumnHeadersDefaultCellStyle.Font;

                    if (!expanded) continue;
                    foreach (Dictionary<string, object> session in sessions)
                    {
                        string root = GetString(session, "root");
                        string folder = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                        folder = Path.GetFileName(folder);
                        if (string.IsNullOrWhiteSpace(folder)) folder = root;
                        Dictionary<string, object> summary = GetDictionary(session, "summary");
                        int row = _sessionGrid.Rows.Add(
                            GetBool(session, "pinned") ? "★" : "",
                            "    " + folder,
                            GetString(session, "status"),
                            GetInt(summary, "files"),
                            "+" + GetInt(summary, "additions") + " -" + GetInt(summary, "removals"),
                            FormatLocalTime(GetString(session, "updatedAt")),
                            root);
                        _sessionGrid.Rows[row].Tag = session;
                        if (GetString(session, "sessionId") == selectedId) _sessionGrid.Rows[row].Selected = true;
                    }
                }
                if (string.IsNullOrWhiteSpace(selectedId)) _sessionGrid.ClearSelection();
            }
            finally { _sessionListLoading = false; }
        }

        private void ToggleSessionGroup(string groupKey)
        {
            if (string.IsNullOrWhiteSpace(groupKey)) return;
            if (!_expandedSessionGroups.Add(groupKey)) _expandedSessionGroups.Remove(groupKey);
            RenderSessionList();
        }

        private void CollapseAllSessionGroups()
        {
            _expandedSessionGroups.Clear();
            RenderSessionList();
        }

        private void ExpandAllSessionGroups()
        {
            foreach (Dictionary<string, object> session in _allSessions)
                _expandedSessionGroups.Add(NormalizeSessionTitle(GetString(session, "title")));
            RenderSessionList();
        }

        private static string NormalizeSessionTitle(string title)
        {
            string value = (title ?? "").Trim();
            return value.Length == 0 ? "未命名会话" : value;
        }

        private static DateTime SessionUpdatedAt(Dictionary<string, object> session)
        {
            DateTime parsed;
            return DateTime.TryParse(GetString(session, "updatedAt"), out parsed) ? parsed.ToUniversalTime() : DateTime.MinValue;
        }

        private string SelectedSessionId(bool required = true)
        {
            if (_sessionGrid.SelectedRows.Count == 1)
            {
                Dictionary<string, object> session = _sessionGrid.SelectedRows[0].Tag as Dictionary<string, object>;
                string id = GetString(session, "sessionId");
                if (!string.IsNullOrWhiteSpace(id)) return id;
            }
            if (required) throw new InvalidOperationException("请选择会话分组内的一轮具体会话。 ");
            return "";
        }

        private async Task LoadSelectedSessionDetailsAsync()
        {
            string id = SelectedSessionId();
            _selectedSessionDetails = await _manager.RunJsonAsync("review-details", new { sessionId = id });
            Dictionary<string, object> session = GetDictionary(_selectedSessionDetails, "session");
            Dictionary<string, object> summary = GetDictionary(_selectedSessionDetails, "summary");
            _sessionDetailTitle.Text = GetString(session, "title", "本轮修改");
            _sessionDetailMeta.Text = GetString(session, "root") + "  ·  " + GetString(session, "backend") + "  ·  " + GetInt(summary, "files") + " 个文件  ·  +" + GetInt(summary, "additions") + " -" + GetInt(summary, "removals") + "  ·  " + (GetBool(_selectedSessionDetails, "canRollback") ? "可完整回退" : "当前不可完整回退");
            _fileGrid.Rows.Clear();
            foreach (Dictionary<string, object> file in GetDictionaryList(_selectedSessionDetails, "files"))
            {
                int row = _fileGrid.Rows.Add(GetString(file, "type"), "+" + GetInt(file, "additions"), "-" + GetInt(file, "removals"), GetString(file, "path"));
                _fileGrid.Rows[row].Tag = file;
            }
            _fullSessionPatch = GetString(_selectedSessionDetails, "patch");
            if (_fileGrid.Rows.Count > 0)
            {
                _fileGrid.ClearSelection();
                _fileGrid.Rows[0].Selected = true;
                RenderSelectedFileDiff();
            }
            else
            {
                if (_diffWindow != null && !_diffWindow.IsDisposed) _diffWindow.ShowEmpty("本轮没有已跟踪文件变化。 ");
            }
            _sessionPages.SelectedIndex = 1;
        }

        private void RenderSelectedFileDiff()
        {
            if (_fileGrid.SelectedRows.Count != 1)
            {
                if (_diffWindow != null && !_diffWindow.IsDisposed) _diffWindow.ShowEmpty("请在主窗口选择一个文件；不会在未选择时展示整轮差异。 ");
                return;
            }
            Dictionary<string, object> file = _fileGrid.SelectedRows[0].Tag as Dictionary<string, object>;
            string path = GetString(file, "path");
            if (_diffWindow != null && !_diffWindow.IsDisposed)
                _diffWindow.UpdateDiff(ExtractPatchForFile(_fullSessionPatch, path), path);
        }

        private void OpenSelectedFileDiff()
        {
            if (_fileGrid.SelectedRows.Count != 1) throw new InvalidOperationException("请先选择一个改动文件。 ");
            if (_diffWindow == null || _diffWindow.IsDisposed)
            {
                _diffWindow = new SessionDiffDialog(
                    async delegate { await RollbackSelectedSessionAsync(); },
                    async delegate { await RestoreSafetySnapshotAsync(); });
                _diffWindow.FormClosed += delegate { _diffWindow = null; };
                _diffWindow.Show(this);
            }
            else
            {
                if (_diffWindow.WindowState == FormWindowState.Minimized) _diffWindow.WindowState = FormWindowState.Normal;
                _diffWindow.BringToFront();
            }
            Dictionary<string, object> file = _fileGrid.SelectedRows[0].Tag as Dictionary<string, object>;
            string filePath = GetString(file, "path");
            _diffWindow.UpdateDiff(ExtractPatchForFile(_fullSessionPatch, filePath), filePath);
        }

        internal static string ExtractPatchForFile(string patch, string filePath)
        {
            string text = (patch ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
            if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(filePath)) return "";
            string normalized = filePath.Replace('\\', '/').TrimStart('/');
            string[] lines = text.Split('\n');
            string oldMarker = "--- a/" + normalized;
            string newMarker = "+++ b/" + normalized;

            for (int index = 0; index < lines.Length; index++)
            {
                if (!PatchPathLineMatches(lines[index], oldMarker)) continue;
                if (index + 1 >= lines.Length || !PatchPathLineMatches(lines[index + 1], newMarker)) continue;

                int start = index;
                if (start > 0 && IsPatchDivider(lines[start - 1])) start--;
                if (start > 0 && lines[start - 1].StartsWith("diff --git ", StringComparison.Ordinal)) start--;

                int end = lines.Length;
                for (int cursor = index + 2; cursor < lines.Length; cursor++)
                {
                    if (IsPatchDivider(lines[cursor]))
                    {
                        end = cursor;
                        break;
                    }
                    if (lines[cursor].StartsWith("diff --git ", StringComparison.Ordinal))
                    {
                        end = cursor;
                        break;
                    }
                }
                return string.Join("\n", lines.Skip(start).Take(end - start)).TrimEnd('\n');
            }

            string binaryMarker = "[Binary, large, or unsupported path changed: " + normalized + "]";
            foreach (string line in lines)
            {
                if (string.Equals(line.Trim(), binaryMarker, StringComparison.Ordinal)) return line.Trim();
            }
            return "";
        }

        private static bool PatchPathLineMatches(string line, string marker)
        {
            if (string.Equals(line, marker, StringComparison.Ordinal)) return true;
            return line.StartsWith(marker + "\t", StringComparison.Ordinal) || line.StartsWith(marker + " ", StringComparison.Ordinal);
        }

        private static bool IsPatchDivider(string line)
        {
            if (string.IsNullOrEmpty(line) || line.Length < 12) return false;
            for (int index = 0; index < line.Length; index++) if (line[index] != '=') return false;
            return true;
        }

        private void PopulateMemoryWorkspaces()
        {
            if (_memoryWorkspace == null) return;
            string selected = Convert.ToString(_memoryWorkspace.SelectedItem ?? "");
            string selectedView = _memoryViewWorkspace == null ? "" : Convert.ToString(_memoryViewWorkspace.SelectedItem ?? "");
            bool priorLoading = _memoryListLoading;
            _memoryListLoading = true;
            try
            {
                _memoryWorkspace.Items.Clear();
                if (_memoryViewWorkspace != null) _memoryViewWorkspace.Items.Clear();
                foreach (string root in GetStringList(_currentConfig, "allowedRoots"))
                {
                    _memoryWorkspace.Items.Add(root);
                    if (_memoryViewWorkspace != null) _memoryViewWorkspace.Items.Add(root);
                }
                if (!string.IsNullOrWhiteSpace(selected))
                {
                    for (int index = 0; index < _memoryWorkspace.Items.Count; index++)
                    {
                        if (string.Equals(Convert.ToString(_memoryWorkspace.Items[index]), selected, StringComparison.OrdinalIgnoreCase))
                        {
                            _memoryWorkspace.SelectedIndex = index;
                            break;
                        }
                    }
                }
                if (_memoryWorkspace.SelectedIndex < 0 && _memoryWorkspace.Items.Count > 0) _memoryWorkspace.SelectedIndex = 0;
                if (_memoryViewWorkspace != null)
                {
                    if (!string.IsNullOrWhiteSpace(selectedView))
                    {
                        for (int index = 0; index < _memoryViewWorkspace.Items.Count; index++)
                        {
                            if (string.Equals(Convert.ToString(_memoryViewWorkspace.Items[index]), selectedView, StringComparison.OrdinalIgnoreCase))
                            {
                                _memoryViewWorkspace.SelectedIndex = index;
                                break;
                            }
                        }
                    }
                    if (_memoryViewWorkspace.SelectedIndex < 0 && _memoryViewWorkspace.Items.Count > 0) _memoryViewWorkspace.SelectedIndex = 0;
                }
            }
            finally { _memoryListLoading = priorLoading; }
            UpdateMemoryWorkspaceState();
        }

        private void UpdateMemoryWorkspaceState()
        {
            if (_memoryScope == null || _memoryWorkspace == null) return;
            bool workspace = string.Equals(Convert.ToString(_memoryScope.SelectedItem ?? "workspace"), "workspace", StringComparison.OrdinalIgnoreCase);
            _memoryWorkspace.Enabled = workspace;
        }

        private async Task LoadMemoriesAsync()
        {
            Dictionary<string, object> value = await _manager.RunJsonAsync("memory-list", new { limit = 200 });
            _allMemories = GetDictionaryList(value, "memories");
            RenderMemoryList();
        }

        private void RenderMemoryList()
        {
            if (_memoryGrid == null) return;
            string query = (_memorySearch == null ? "" : _memorySearch.Text).Trim().ToLowerInvariant();
            string viewWorkspace = _memoryViewWorkspace == null ? "" : Convert.ToString(_memoryViewWorkspace.SelectedItem ?? "");
            bool showOtherWorkspaces = _showOtherWorkspaceMemories != null && _showOtherWorkspaceMemories.Checked;
            string selectedId = SelectedMemoryId(false);
            _memoryListLoading = true;
            try
            {
                _memoryGrid.Rows.Clear();
                IEnumerable<Dictionary<string, object>> visible = _allMemories
                    .Where(memory => showOtherWorkspaces || MemoryVisibleForWorkspace(memory, viewWorkspace))
                    .OrderBy(memory => MemoryCategoryRank(memory, viewWorkspace))
                    .ThenByDescending(memory => MemoryUpdatedAt(memory));
                foreach (Dictionary<string, object> memory in visible)
                {
                    string title = GetString(memory, "title");
                    string content = GetString(memory, "content");
                    string tags = string.Join(", ", GetStringList(memory, "tags"));
                    string workspaceRoot = GetString(memory, "workspaceRoot");
                    if (query.Length > 0 && !title.ToLowerInvariant().Contains(query) && !content.ToLowerInvariant().Contains(query) && !tags.ToLowerInvariant().Contains(query) && !workspaceRoot.ToLowerInvariant().Contains(query)) continue;
                    string category = MemoryCategory(memory, viewWorkspace);
                    int row = _memoryGrid.Rows.Add(category, title, MemoryWorkspaceLabel(memory), tags, FormatLocalTime(GetString(memory, "updatedAt")));
                    _memoryGrid.Rows[row].Tag = memory;
                    if (category == "当前工作区") _memoryGrid.Rows[row].DefaultCellStyle.BackColor = UiPalette.PrimarySoft;
                    else if (category == "全局") _memoryGrid.Rows[row].DefaultCellStyle.BackColor = UiPalette.SurfaceMuted;
                    if (GetString(memory, "id") == selectedId) _memoryGrid.Rows[row].Selected = true;
                }
            }
            finally { _memoryListLoading = false; }
            if (_memoryGrid.SelectedRows.Count == 1) PopulateMemoryEditor(SelectedMemory());
            else if (string.IsNullOrWhiteSpace(_editingMemoryId))
            {
                _memoryPreviewText = "选择一条 Memory 后，点击“打开完整内容窗口”浏览完整内容、作用域、工作区与标签。";
                if (_memoryPreviewWindow != null && !_memoryPreviewWindow.IsDisposed) _memoryPreviewWindow.UpdateContent("", _memoryPreviewText);
            }
        }

        private static bool MemoryVisibleForWorkspace(Dictionary<string, object> memory, string workspaceRoot)
        {
            if (string.Equals(GetString(memory, "scope"), "global", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.IsNullOrWhiteSpace(workspaceRoot)) return false;
            return string.Equals(NormalizeMemoryPath(GetString(memory, "workspaceRoot")), NormalizeMemoryPath(workspaceRoot), StringComparison.OrdinalIgnoreCase);
        }

        private static string MemoryCategory(Dictionary<string, object> memory, string workspaceRoot)
        {
            if (string.Equals(GetString(memory, "scope"), "global", StringComparison.OrdinalIgnoreCase)) return "全局";
            return MemoryVisibleForWorkspace(memory, workspaceRoot) ? "当前工作区" : "其他工作区";
        }

        private static int MemoryCategoryRank(Dictionary<string, object> memory, string workspaceRoot)
        {
            string category = MemoryCategory(memory, workspaceRoot);
            if (category == "当前工作区") return 0;
            if (category == "全局") return 1;
            return 2;
        }

        private static DateTime MemoryUpdatedAt(Dictionary<string, object> memory)
        {
            DateTime parsed;
            return DateTime.TryParse(GetString(memory, "updatedAt"), null, DateTimeStyles.RoundtripKind, out parsed) ? parsed : DateTime.MinValue;
        }

        private static string NormalizeMemoryPath(string value)
        {
            return (value ?? "").Trim().TrimEnd('\\', '/').Replace('\\', '/').ToLowerInvariant();
        }

        private static string MemoryWorkspaceLabel(Dictionary<string, object> memory)
        {
            if (string.Equals(GetString(memory, "scope"), "global", StringComparison.OrdinalIgnoreCase)) return "所有工作区";
            string root = GetString(memory, "workspaceRoot");
            return string.IsNullOrWhiteSpace(root) ? "（未绑定）" : root;
        }

        private string SelectedMemoryId(bool required = true)
        {
            if (_memoryGrid.SelectedRows.Count == 1)
            {
                Dictionary<string, object> memory = _memoryGrid.SelectedRows[0].Tag as Dictionary<string, object>;
                return GetString(memory, "id");
            }
            if (required) throw new InvalidOperationException("请先选择一条 Memory。 ");
            return "";
        }

        private Dictionary<string, object> SelectedMemory()
        {
            if (_memoryGrid.SelectedRows.Count != 1) throw new InvalidOperationException("请先选择一条 Memory。 ");
            return (Dictionary<string, object>)_memoryGrid.SelectedRows[0].Tag;
        }

        private void MemorySelectionChanged(object sender, EventArgs e)
        {
            if (_memoryListLoading || _memoryGrid.SelectedRows.Count != 1) return;
            PopulateMemoryEditor(SelectedMemory());
        }

        private void BeginNewMemory()
        {
            _editingMemoryId = "";
            _memoryTitle.Text = "";
            _memoryTags.Text = "";
            _memoryContent.Text = "";
            _memoryScope.SelectedItem = "workspace";
            PopulateMemoryWorkspaces();
            _memoryPreviewText = "正在新建 Memory；保存前不会写入本地 SQLite。";
            if (_memoryPreviewWindow != null && !_memoryPreviewWindow.IsDisposed) _memoryPreviewWindow.UpdateContent("新建 Memory", _memoryPreviewText);
            _memoryStatus.Text = "正在新建 Memory；保存后才会写入本地 SQLite。";
            _memoryGrid.ClearSelection();
            _memoryTitle.Focus();
        }

        private void PopulateMemoryEditor(Dictionary<string, object> memory)
        {
            _editingMemoryId = GetString(memory, "id");
            _memoryScope.SelectedItem = GetString(memory, "scope", "workspace");
            _memoryTitle.Text = GetString(memory, "title");
            _memoryTags.Text = string.Join(", ", GetStringList(memory, "tags"));
            _memoryContent.Text = GetString(memory, "content");
            string workspaceRoot = GetString(memory, "workspaceRoot");
            if (!string.IsNullOrWhiteSpace(workspaceRoot))
            {
                bool matched = false;
                for (int index = 0; index < _memoryWorkspace.Items.Count; index++)
                {
                    if (string.Equals(Convert.ToString(_memoryWorkspace.Items[index]), workspaceRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        _memoryWorkspace.SelectedIndex = index;
                        matched = true;
                        break;
                    }
                }
                if (!matched) _memoryWorkspace.Items.Add(workspaceRoot);
                if (!matched) _memoryWorkspace.SelectedItem = workspaceRoot;
            }
            UpdateMemoryWorkspaceState();
            RenderMemoryPreview(memory);
            _memoryStatus.Text = "正在编辑：" + GetString(memory, "title") + "  ·  " + GetString(memory, "scope") + "  ·  更新于 " + FormatLocalTime(GetString(memory, "updatedAt"));
        }

        private void RenderMemoryPreview(Dictionary<string, object> memory)
        {
            string scope = GetString(memory, "scope", "workspace");
            string workspace = string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase) ? "所有工作区" : GetString(memory, "workspaceRoot", "（未绑定）");
            string tags = string.Join(", ", GetStringList(memory, "tags"));
            _memoryPreviewText =
                "标题：" + GetString(memory, "title") + Environment.NewLine +
                "作用域：" + (string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase) ? "全局" : "工作区") + Environment.NewLine +
                "工作区：" + workspace + Environment.NewLine +
                "标签：" + (string.IsNullOrWhiteSpace(tags) ? "（无）" : tags) + Environment.NewLine +
                "更新：" + FormatLocalTime(GetString(memory, "updatedAt")) + Environment.NewLine +
                Environment.NewLine +
                GetString(memory, "content");
            if (_memoryPreviewWindow != null && !_memoryPreviewWindow.IsDisposed)
                _memoryPreviewWindow.UpdateContent(GetString(memory, "title"), _memoryPreviewText);
        }

        private void OpenMemoryPreviewWindow()
        {
            Dictionary<string, object> memory = SelectedMemory();
            RenderMemoryPreview(memory);
            if (_memoryPreviewWindow == null || _memoryPreviewWindow.IsDisposed)
            {
                _memoryPreviewWindow = new ContentPreviewDialog();
                _memoryPreviewWindow.FormClosed += delegate { _memoryPreviewWindow = null; };
                _memoryPreviewWindow.Show(this);
            }
            else
            {
                if (_memoryPreviewWindow.WindowState == FormWindowState.Minimized) _memoryPreviewWindow.WindowState = FormWindowState.Normal;
                _memoryPreviewWindow.BringToFront();
            }
            _memoryPreviewWindow.UpdateContent(GetString(memory, "title"), _memoryPreviewText);
        }

        private async Task SaveMemoryAsync()
        {
            string scope = Convert.ToString(_memoryScope.SelectedItem ?? "workspace");
            string workspaceRoot = string.Equals(scope, "workspace", StringComparison.OrdinalIgnoreCase) ? Convert.ToString(_memoryWorkspace.SelectedItem ?? "") : "";
            if (string.Equals(scope, "workspace", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(workspaceRoot))
                throw new InvalidOperationException("工作区作用域需要选择一个允许的工作目录。 ");
            Dictionary<string, object> payload = new Dictionary<string, object>
            {
                ["scope"] = scope,
                ["workspaceRoot"] = workspaceRoot,
                ["title"] = _memoryTitle.Text.Trim(),
                ["content"] = _memoryContent.Text.Trim(),
                ["tags"] = _memoryTags.Text.Split(new[] { ',', '，' }, StringSplitOptions.RemoveEmptyEntries).Select(value => value.Trim()).Where(value => value.Length > 0).ToArray(),
            };
            if (!string.IsNullOrWhiteSpace(_editingMemoryId)) payload["id"] = _editingMemoryId;
            Dictionary<string, object> result = await _manager.RunJsonAsync("memory-upsert", payload);
            Dictionary<string, object> memory = GetDictionary(result, "memory");
            _editingMemoryId = GetString(memory, "id");
            await LoadMemoriesAsync();
            SelectMemoryById(_editingMemoryId);
            _memoryStatus.Text = "已保存：" + GetString(memory, "title") + "  ·  " + GetString(memory, "scope");
        }

        private async Task DeleteSelectedMemoryAsync()
        {
            Dictionary<string, object> memory = SelectedMemory();
            string id = GetString(memory, "id");
            if (MessageBox.Show(this, "确定删除 Memory“" + GetString(memory, "title") + "”吗？此操作会从本地 SQLite 中永久删除该记录。", "删除 Memory", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            await _manager.RunJsonAsync("memory-delete", new { id = id });
            BeginNewMemory();
            await LoadMemoriesAsync();
            _memoryStatus.Text = "Memory 已删除。";
        }

        private void SelectMemoryById(string id)
        {
            if (string.IsNullOrWhiteSpace(id)) return;
            foreach (DataGridViewRow row in _memoryGrid.Rows)
            {
                Dictionary<string, object> memory = row.Tag as Dictionary<string, object>;
                if (GetString(memory, "id") != id) continue;
                _memoryGrid.ClearSelection();
                row.Selected = true;
                _memoryGrid.CurrentCell = row.Cells["memoryTitle"];
                PopulateMemoryEditor(memory);
                break;
            }
        }

        private static string FormatLocalTime(string value)
        {
            DateTime parsed;
            return DateTime.TryParse(value, out parsed) ? parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm") : value;
        }

        private async Task RenameSessionAsync()
        {
            string id = SelectedSessionId();
            Dictionary<string, object> session = SelectedSession();
            string value = PromptDialog.Show(this, "会话名称", "输入新的本地会话名称：", GetString(session, "title"));
            if (value == null) return;
            await _manager.RunJsonAsync("review-update", new { sessionId = id, title = value });
            await LoadSessionsAsync();
        }

        private Dictionary<string, object> SelectedSession()
        {
            if (_sessionGrid.SelectedRows.Count != 1) throw new InvalidOperationException("请选择会话分组内的一轮具体会话。 ");
            Dictionary<string, object> session = _sessionGrid.SelectedRows[0].Tag as Dictionary<string, object>;
            if (session == null || string.IsNullOrWhiteSpace(GetString(session, "sessionId")))
                throw new InvalidOperationException("当前行是会话分组标题，请选择分组内的一轮具体会话。 ");
            return session;
        }

        private async Task ToggleSessionAsync(string field)
        {
            Dictionary<string, object> session = SelectedSession();
            Dictionary<string, object> payload = new Dictionary<string, object> { ["sessionId"] = GetString(session, "sessionId"), [field] = !GetBool(session, field) };
            await _manager.RunJsonAsync("review-update", payload);
            await LoadSessionsAsync();
        }

        private async Task ArchiveSessionAsync()
        {
            Dictionary<string, object> session = SelectedSession();
            string status = GetString(session, "status") == "archived" ? "active" : "archived";
            await _manager.RunJsonAsync("review-update", new { sessionId = GetString(session, "sessionId"), status });
            await LoadSessionsAsync();
        }

        private void OpenSelectedSessionFolder() { OpenExternal(GetString(SelectedSession(), "root")); }

        private async Task RollbackSelectedSessionAsync()
        {
            string id = SelectedSessionId();
            if (_selectedSessionDetails.Count == 0 || GetString(GetDictionary(_selectedSessionDetails, "session"), "sessionId") != id) await LoadSelectedSessionDetailsAsync();
            Dictionary<string, object> selectedSession = GetDictionary(_selectedSessionDetails, "session");
            if (GetString(selectedSession, "executionBackend") == "remote-agent")
            {
                MessageBox.Show(this, "远程 Linux 会话的回退必须通过当前在线的 MCP 会话执行 session_rollback，因为只有正在运行的 DevSpace 服务持有已认证 Agent 连接。这里保留审阅历史，但不会绕过 Agent 身份验证直接恢复远端文件。", "远程会话回退", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!GetBool(_selectedSessionDetails, "canRollback")) { MessageBox.Show(this, "当前会话没有可回退的修改。", "回退", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            string typed = PromptDialog.Show(this, "确认回退", "输入 ROLLBACK 确认恢复到会话基线。执行前会自动保存回退前安全快照。", "");
            if (typed != "ROLLBACK") { MessageBox.Show(this, "确认文字不匹配，未执行回退。", "已取消", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            string confirmation = GetString(_selectedSessionDetails, "confirmationToken");
            await ExecuteBusyAsync(async delegate
            {
                Dictionary<string, object> result = await _manager.RunJsonAsync("review-rollback", new { sessionId = id, confirmation });
                MessageBox.Show(this, "已恢复 " + GetInt(result, "restored") + " 个路径。回退前安全快照已保留。", "回退完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                await LoadSelectedSessionDetailsAsync();
                await LoadSessionsAsync();
            });
        }

        private async Task RestoreSafetySnapshotAsync()
        {
            if (_selectedSessionDetails.Count == 0) await LoadSelectedSessionDetailsAsync();
            Dictionary<string, object> selectedSession = GetDictionary(_selectedSessionDetails, "session");
            if (GetString(selectedSession, "executionBackend") == "remote-agent")
            {
                MessageBox.Show(this, "远程 Linux 会话的安全快照恢复必须通过当前在线的 MCP 会话执行 session_restore_safety。控制中心不会在缺少已认证 Agent 连接时直接修改远端文件。", "远程安全快照", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            List<Dictionary<string, object>> snapshots = GetDictionaryList(_selectedSessionDetails, "safetySnapshots");
            if (snapshots.Count == 0) { MessageBox.Show(this, "当前会话没有回退前安全快照。", "安全快照", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            Dictionary<string, object> snapshot = snapshots[0];
            string id = GetString(snapshot, "id");
            if (MessageBox.Show(this, "恢复最近的回退前安全快照 " + id + " 吗？", "恢复安全快照", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            await ExecuteBusyAsync(async delegate
            {
                await _manager.RunJsonAsync("review-restore-safety", new { sessionId = SelectedSessionId(), snapshotId = id, confirmation = "RESTORE " + id });
                await LoadSelectedSessionDetailsAsync();
                await LoadSessionsAsync();
            });
        }

        private async Task LoadLogsAsync()
        {
            try
            {
                Dictionary<string, object> paths = await _manager.RunJsonAsync("log-paths");
                _devspaceLog.Text = TailFile(GetString(paths, "devspace"), 2000);
                _tunnelLog.Text = TailFile(GetString(paths, "tunnel"), 2000);
                _devspaceLog.SelectionStart = _devspaceLog.TextLength; _devspaceLog.ScrollToCaret();
                _tunnelLog.SelectionStart = _tunnelLog.TextLength; _tunnelLog.ScrollToCaret();
            }
            catch (Exception ex) { _devspaceLog.Text = ex.Message; }
        }

        private async Task ProcessComputerUseQueueAsync()
        {
            if (_closing || _computerUseWorkerBusy || string.IsNullOrEmpty(_leaseId)) return;
            _computerUseWorkerBusy = true;
            try { await Task.Run((Action)ProcessComputerUseQueue); }
            catch { }
            finally { _computerUseWorkerBusy = false; }
        }

        private void ProcessComputerUseQueue()
        {
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
                    Dictionary<string, object> request = _computerUseJson.DeserializeObject(File.ReadAllText(working, Encoding.UTF8)) as Dictionary<string, object>;
                    if (request == null || GetString(request, "requestId") != requestId || GetString(request, "leaseId") != _leaseId)
                        throw new InvalidOperationException("Computer Use request does not match the active native UI lease.");
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
                        if (steps.Count == 0 || steps.Count > 50) throw new InvalidOperationException("Computer Use sequence requires 1 to 50 steps.");
                        List<string> actions = new List<string>();
                        foreach (Dictionary<string, object> step in steps)
                        {
                            string stepAction = GetString(step, "action");
                            if (string.IsNullOrWhiteSpace(stepAction) || string.Equals(stepAction, "snapshot", StringComparison.OrdinalIgnoreCase) || string.Equals(stepAction, "sequence", StringComparison.OrdinalIgnoreCase))
                                throw new InvalidOperationException("Computer Use sequence contains an unsupported step action.");
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
                        ["success"] = true,
                        ["metadata"] = metadata,
                        ["stderr"] = stderr,
                    });
                    NotifyComputerUseActivity(ComputerUseActiveIndicatorHoldMs, true);
                }
                catch (Exception ex)
                {
                    WriteComputerUseResponse(responses, requestId, new Dictionary<string, object>
                    {
                        ["success"] = false,
                        ["error"] = FirstLine(ex.Message),
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
            if (!File.Exists(helper)) throw new FileNotFoundException("Computer Use native input helper is missing.", helper);
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
                    if (!process.WaitForExit(10000)) { process.Kill(); throw new TimeoutException("Computer Use input helper timed out."); }
                    if (process.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? output : stderr);
                    string jsonLine = output.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
                    metadata = string.IsNullOrWhiteSpace(jsonLine)
                        ? new Dictionary<string, object>()
                        : (_computerUseJson.DeserializeObject(jsonLine) as Dictionary<string, object> ?? new Dictionary<string, object>());
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
            if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("Interactive desktop has invalid bounds.");
            Directory.CreateDirectory(Path.GetDirectoryName(outputFile));
            string temporary = outputFile + ".tmp-" + Process.GetCurrentProcess().Id;
            try
            {
                using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    // System.Drawing validates CopyPixelOperation as a defined enum value.
                    // Combining SourceCopy with CaptureBlt produces a raw Win32 raster-op
                    // value that .NET rejects before the capture call is issued.
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
                    if (visible < 8) throw new InvalidOperationException("Native UI received an empty desktop frame. The RDP desktop may be locked or disconnected.");
                    bitmap.Save(temporary, System.Drawing.Imaging.ImageFormat.Png);
                }
                if (File.Exists(outputFile)) File.Delete(outputFile);
                File.Move(temporary, outputFile);
                return new Dictionary<string, object>
                {
                    ["width"] = bounds.Width,
                    ["height"] = bounds.Height,
                    ["left"] = bounds.Left,
                    ["top"] = bounds.Top,
                    ["outputs"] = Screen.AllScreens.Length,
                    ["backend"] = "native-ui-gdi",
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
            File.WriteAllText(temporary, _computerUseJson.Serialize(value), new UTF8Encoding(false));
            if (File.Exists(target)) File.Delete(target);
            File.Move(temporary, target);
        }

        private static string QuoteProcessArgument(string value)
        {
            string text = value ?? "";
            if (text.Length > 0 && text.All(character => !char.IsWhiteSpace(character) && character != '"')) return text;
            return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private async Task ExecuteBusyAsync(Func<Task> operation)
        {
            SetOutput("正在执行，请稍候……");
            _busyOperationCount++;
            UseWaitCursor = true;
            try { await operation(); }
            catch (Exception ex) { ShowError(ex); }
            finally
            {
                _busyOperationCount = Math.Max(0, _busyOperationCount - 1);
                UseWaitCursor = _busyOperationCount > 0;
            }
        }

        private void MainForm_FormClosing(object sender, FormClosingEventArgs e)
        {
            if (_closing) return;
            bool systemShutdown = e.CloseReason == CloseReason.WindowsShutDown
                || e.CloseReason == CloseReason.ApplicationExitCall;
            if (!_allowUiExit && !_closingForUpdate && !systemShutdown)
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
            _heartbeatTimer.Stop(); _statusTimer.Stop(); _noticeTimer.Stop(); _computerUseTimer.Stop(); _computerUseIndicatorTimer.Stop(); _remoteAgentRecoveryTimer.Stop();
            _computerUseIndicator.Dispose();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _trayMenu.Dispose();
            string lease = _leaseId; _leaseId = "";
            if (!string.IsNullOrEmpty(lease))
            {
                try { _manager.RunJson("ui-close", new { leaseId = lease }); }
                catch { }
            }
        }

        private void SetOutput(string text) { _operationOutput.Text = string.IsNullOrWhiteSpace(text) ? "完成。" : text; _operationOutput.SelectionStart = _operationOutput.TextLength; _operationOutput.ScrollToCaret(); }
        private void ShowInlineNotice(string message, bool error)
        {
            if (IsDisposed || Disposing) return;
            if (_contentLayout.RowStyles.Count > 0)
            {
                _contentLayout.RowStyles[0].SizeType = SizeType.Absolute;
                _contentLayout.RowStyles[0].Height = 56;
            }
            _inlineNotice.ShowMessage(message, error);
            _contentLayout.PerformLayout();
            _noticeTimer.Stop();
            _noticeTimer.Start();
        }
        private void CollapseNoticeRow()
        {
            if (_contentLayout.RowStyles.Count == 0) return;
            _contentLayout.RowStyles[0].SizeType = SizeType.Absolute;
            _contentLayout.RowStyles[0].Height = 0;
            _contentLayout.PerformLayout();
        }
        private void ShowError(Exception ex)
        {
            string message = FirstLine(ex == null ? "操作未完成，请检查当前设置。" : ex.Message);
            SetOutput("错误：\r\n" + message);
            ShowInlineNotice(message, true);
        }
        private async Task RunUiActionAsync(Func<Task> action)
        {
            try { await action(); }
            catch (Exception ex) { ShowError(ex); }
        }
        private void OpenExternal(string target) { try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); } catch (Exception ex) { ShowError(ex); } }

        private void ConfigurePluginGrid()
        {
            _pluginGrid.Columns.Add("id", "ID"); _pluginGrid.Columns.Add("version", "版本"); _pluginGrid.Columns.Add(new DataGridViewCheckBoxColumn { Name = "enabled", HeaderText = "启用" }); _pluginGrid.Columns.Add("dependency", "依赖"); _pluginGrid.Columns.Add("maturity", "成熟度"); _pluginGrid.Columns.Add("tools", "工具数");
            _pluginGrid.SelectionChanged += PluginSelectionChanged;
        }
        private void ConfigureSlotGrid() { _slotGrid.Columns.Add("slot", "#"); _slotGrid.Columns.Add("name", "接口"); _slotGrid.Columns.Add("binding", "绑定"); _slotGrid.Columns.Add("status", "状态"); }
        private void ConfigureSessionGrid()
        {
            _sessionGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
            _sessionGrid.Columns.Add("pin", "★");
            _sessionGrid.Columns.Add("title", "会话");
            _sessionGrid.Columns.Add("status", "状态");
            _sessionGrid.Columns.Add("files", "文件");
            _sessionGrid.Columns.Add("lines", "行数");
            _sessionGrid.Columns.Add("updated", "最近更新");
            _sessionGrid.Columns.Add("root", "项目路径");
            _sessionGrid.RowTemplate.Height = 48;
            _sessionGrid.Columns["pin"].Width = 40;
            _sessionGrid.Columns["title"].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            _sessionGrid.Columns["title"].MinimumWidth = 100;
            _sessionGrid.Columns["status"].Width = 70;
            _sessionGrid.Columns["files"].Width = 60;
            _sessionGrid.Columns["lines"].Width = 92;
            _sessionGrid.Columns["updated"].Width = 132;
            _sessionGrid.Columns["root"].Visible = false;
            _sessionGrid.CellMouseClick += delegate(object sender, DataGridViewCellMouseEventArgs e)
            {
                if (_sessionListLoading || e.RowIndex < 0 || e.Clicks != 1) return;
                string groupKey = _sessionGrid.Rows[e.RowIndex].Tag as string;
                if (!string.IsNullOrWhiteSpace(groupKey)) ToggleSessionGroup(groupKey);
            };
            _sessionGrid.CellDoubleClick += async delegate
            {
                if (_sessionListLoading || _sessionGrid.SelectedRows.Count != 1) return;
                if (!(_sessionGrid.SelectedRows[0].Tag is Dictionary<string, object>)) return;
                await RunUiActionAsync(OpenSelectedSessionAsync);
            };
        }
        private void ConfigureFileGrid()
        {
            _fileGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
            _fileGrid.Columns.Add("type", "类型");
            _fileGrid.Columns.Add("add", "新增");
            _fileGrid.Columns.Add("remove", "删除");
            _fileGrid.Columns.Add("path", "文件");
            _fileGrid.Columns["type"].Width = 84;
            _fileGrid.Columns["add"].Width = 72;
            _fileGrid.Columns["remove"].Width = 72;
            _fileGrid.Columns["path"].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            _fileGrid.SelectionChanged += delegate { RenderSelectedFileDiff(); };
            _fileGrid.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e)
            {
                if (e.RowIndex < 0) return;
                try { OpenSelectedFileDiff(); } catch (Exception ex) { ShowError(ex); }
            };
        }
        private void ConfigureMemoryGrid()
        {
            _memoryGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
            _memoryGrid.RowTemplate.Height = 48;
            _memoryGrid.Columns.Add("memoryScope", "范围");
            _memoryGrid.Columns.Add("memoryTitle", "标题");
            _memoryGrid.Columns.Add("memoryWorkspace", "工作区");
            _memoryGrid.Columns.Add("memoryTags", "标签");
            _memoryGrid.Columns.Add("memoryUpdated", "更新");
            _memoryGrid.Columns["memoryScope"].Width = 96;
            _memoryGrid.Columns["memoryTitle"].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            _memoryGrid.Columns["memoryTitle"].MinimumWidth = 120;
            _memoryGrid.Columns["memoryWorkspace"].Width = 180;
            _memoryGrid.Columns["memoryTags"].Width = 120;
            _memoryGrid.Columns["memoryUpdated"].Width = 128;
            _memoryGrid.SelectionChanged += MemorySelectionChanged;
            _memoryGrid.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e)
            {
                if (e.RowIndex < 0) return;
                try { OpenMemoryPreviewWindow(); } catch (Exception ex) { ShowError(ex); }
            };
        }

        private static TableLayoutPanel NewTable(int columns, int rows) { return new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = columns, RowCount = rows, Padding = new Padding(10), AutoScroll = true, BackColor = UiPalette.Background }; }
        private static TableLayoutPanel NewFormTable() { TableLayoutPanel table = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(14), BackColor = UiPalette.Surface }; table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190)); table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); return table; }
        private static FlowLayoutPanel NewButtonBar() { return new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, Padding = new Padding(3), BackColor = Color.Transparent }; }
        private static GroupBox NewGroup(string text) { return new ModernGroupBox { Text = text, Dock = DockStyle.Fill }; }
        private static GroupBox NewAutoGroup(string text) { return new ModernGroupBox { Text = text, Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = new Padding(6) }; }
        private Button ActionButton(string text, Func<Task> action, bool primary = false, bool danger = false)
        {
            ModernButton button = new ModernButton { Text = text, AutoSize = true, Primary = primary, Danger = danger };
            button.Click += async delegate
            {
                if (button.Busy) return;
                button.Busy = true;
                try { await RunUiActionAsync(action); }
                finally { button.Busy = false; }
            };
            return button;
        }
        private Button ActionButton(string text, Action action, bool primary = false, bool danger = false) { ModernButton button = new ModernButton { Text = text, AutoSize = true, Primary = primary, Danger = danger }; button.Click += delegate { try { action(); } catch (Exception ex) { ShowError(ex); } }; return button; }
        private static RichTextBox CreateConsoleBox() { return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = UiPalette.Console, ForeColor = UiPalette.ConsoleText, Font = UiTypography.Code(9.25F), BorderStyle = BorderStyle.None, DetectUrls = false, Margin = new Padding(0) }; }
        private static RichTextBox CreateLogBox() { return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = UiPalette.Surface, ForeColor = Color.FromArgb(55, 65, 82), Font = UiTypography.Code(9.25F), BorderStyle = BorderStyle.None, DetectUrls = false, Margin = new Padding(4), Padding = new Padding(6) }; }
        private static RichTextBox CreateMemoryPreviewBox() { return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = UiPalette.SurfaceMuted, ForeColor = UiPalette.Text, Font = UiTypography.Ui(9.25F), BorderStyle = BorderStyle.None, DetectUrls = false, Margin = new Padding(4), Padding = new Padding(8), WordWrap = true }; }
        private static Control WrapSurface(Control child, bool dark = false)
        {
            SurfacePanel surface = new SurfacePanel { Dock = DockStyle.Fill, Dark = dark, Padding = new Padding(dark ? 14 : 8), Margin = new Padding(4) };
            child.Dock = DockStyle.Fill;
            surface.Controls.Add(child);
            return surface;
        }
        private static DataGridView CreateGrid()
        {
            DataGridView grid = new DataGridView
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                AllowUserToAddRows = false,
                AllowUserToDeleteRows = false,
                AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                MultiSelect = false,
                RowHeadersVisible = false,
                BackgroundColor = UiPalette.Surface,
                BorderStyle = BorderStyle.None,
                CellBorderStyle = DataGridViewCellBorderStyle.Single,
                ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.Single,
                EnableHeadersVisualStyles = false,
                GridColor = Color.FromArgb(226, 232, 243),
                RowTemplate = { Height = 38 },
            };
            grid.ColumnHeadersDefaultCellStyle.BackColor = UiPalette.SurfaceMuted;
            grid.ColumnHeadersDefaultCellStyle.ForeColor = UiPalette.TextMuted;
            grid.ColumnHeadersDefaultCellStyle.Font = UiTypography.Ui(9F, FontStyle.Bold);
            grid.ColumnHeadersDefaultCellStyle.SelectionBackColor = UiPalette.SurfaceMuted;
            grid.DefaultCellStyle.BackColor = UiPalette.Surface;
            grid.DefaultCellStyle.ForeColor = UiPalette.Text;
            grid.DefaultCellStyle.SelectionBackColor = UiPalette.PrimarySoft;
            grid.DefaultCellStyle.SelectionForeColor = UiPalette.Text;
            grid.ColumnHeadersHeight = 40;
            grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.DefaultCellStyle.Padding = new Padding(8, 2, 8, 2);
            grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(247, 249, 253);
            return grid;
        }
        private static Label FormLabel(string text) { return new Label { Text = text, Dock = DockStyle.Fill, ForeColor = UiPalette.TextMuted, TextAlign = ContentAlignment.MiddleLeft, AutoSize = false, MinimumSize = new Size(0, 42), Margin = new Padding(4), Padding = new Padding(0, 2, 0, 2) }; }
        private static Label ToolbarLabel(string text) { return new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, ForeColor = UiPalette.Text, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(6, 0, 6, 0) }; }
        private static void AddRow(TableLayoutPanel table, string label, Control control)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(FormLabel(label), 0, row);
            control.Font = UiTypography.Ui(9F);
            StyleField(control);
            Control visual = control is TextBox || control is ComboBox || control is NumericUpDown ? WrapField(control) : control;
            visual.Dock = DockStyle.Fill;
            visual.Margin = new Padding(4, 4, 4, 4);
            table.Controls.Add(visual, 1, row);
        }
        private static void StyleField(Control control)
        {
            control.BackColor = UiPalette.SurfaceMuted;
            control.ForeColor = UiPalette.Text;
            TextBox text = control as TextBox;
            if (text != null) { text.BorderStyle = BorderStyle.None; }
            ComboBox combo = control as ComboBox;
            if (combo != null) { combo.FlatStyle = FlatStyle.Flat; combo.IntegralHeight = false; combo.DropDownHeight = 260; }
            NumericUpDown number = control as NumericUpDown;
            if (number != null) number.BorderStyle = BorderStyle.None;
        }
        private static FieldHost WrapField(Control control, int width = 0) { return new FieldHost(control, width); }
        private static TextBox AddText(TableLayoutPanel table, string label) { TextBox box = new TextBox(); AddRow(table, label, box); return box; }
        private static TextBox AddPassword(TableLayoutPanel table, string label) { TextBox box = new TextBox { UseSystemPasswordChar = true }; AddRow(table, label, box); return box; }
        private static TextBox AddMultiline(TableLayoutPanel table, string label, int height) { TextBox box = new TextBox { Multiline = true, Height = height, ScrollBars = ScrollBars.Vertical }; AddRow(table, label, box); return box; }
        private static ComboBox AddCombo(TableLayoutPanel table, string label, IEnumerable<string> values) { ComboBox box = new ModernComboBox(); foreach (string value in values) box.Items.Add(value); if (box.Items.Count > 0) box.SelectedIndex = 0; AddRow(table, label, box); return box; }
        private static NumericUpDown AddNumber(TableLayoutPanel table, string label, decimal min, decimal max, decimal value) { NumericUpDown box = new ModernNumericUpDown { Minimum = min, Maximum = max, Value = value }; AddRow(table, label, box); return box; }
        private static CheckBox AddCheck(TableLayoutPanel table, string text, string key)
        {
            int row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            table.Controls.Add(FormLabel(text), 0, row);
            ModernToggle box = new ModernToggle { Text = "", Width = 58, Height = 36, Dock = DockStyle.None, Margin = new Padding(0) };
            Panel host = new Panel { Dock = DockStyle.Fill, Height = 42, MinimumSize = new Size(60, 42), BackColor = Color.Transparent, Margin = new Padding(4) };
            host.Controls.Add(box);
            Action centerToggle = delegate
            {
                box.Location = new Point(Math.Max(0, host.ClientSize.Width - box.Width), Math.Max(0, (host.ClientSize.Height - box.Height) / 2));
            };
            host.Resize += delegate { centerToggle(); };
            centerToggle();
            table.Controls.Add(host, 1, row);
            return box;
        }
        private void AddPermission(TableLayoutPanel table, string text, string key) { CheckBox box = AddCheck(table, text, key); _permissionBoxes[key] = box; }
        private void AddFeature(TableLayoutPanel table, string text, string key) { CheckBox box = AddCheck(table, text, key); _featureBoxes[key] = box; if (key == "computerUse") box.CheckedChanged += delegate { if (!_loadingConfiguration) _computerUseToggle.Checked = box.Checked; }; }

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
        private static bool GetBool(Dictionary<string, object> source, string key, bool fallback = false) { object value; if (source == null || !source.TryGetValue(key, out value) || value == null) return fallback; try { return Convert.ToBoolean(value); } catch { return fallback; } }
        private static int GetInt(Dictionary<string, object> source, string key, int fallback = 0) { object value; if (source == null || !source.TryGetValue(key, out value) || value == null) return fallback; try { return Convert.ToInt32(value); } catch { return fallback; } }
        private static List<Dictionary<string, object>> GetDictionaryList(Dictionary<string, object> source, string key) { object value; if (source == null || !source.TryGetValue(key, out value) || value == null) return new List<Dictionary<string, object>>(); IEnumerable sequence = value as IEnumerable; if (sequence == null || value is string) return new List<Dictionary<string, object>>(); List<Dictionary<string, object>> result = new List<Dictionary<string, object>>(); foreach (object item in sequence) { Dictionary<string, object> dictionary = item as Dictionary<string, object>; if (dictionary != null) result.Add(dictionary); } return result; }
        private static List<string> GetStringList(Dictionary<string, object> source, string key) { object value; if (source == null || !source.TryGetValue(key, out value) || value == null) return new List<string>(); IEnumerable sequence = value as IEnumerable; if (sequence == null || value is string) return new List<string>(); List<string> result = new List<string>(); foreach (object item in sequence) result.Add(Convert.ToString(item)); return result; }
        private static long GetLong(Dictionary<string, object> source, string key, long fallback = 0) { object value; if (source == null || !source.TryGetValue(key, out value) || value == null) return fallback; try { return Convert.ToInt64(value); } catch { return fallback; } }
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
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(560, 290);
            BackColor = UiPalette.Background;
            ForeColor = UiPalette.Text;
            Font = UiTypography.Ui(9F);

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
                Font = UiTypography.Display(15F, FontStyle.Bold),
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

    internal sealed class ComboItem
    {
        public string Value { get; private set; }
        public string Text { get; private set; }
        public Dictionary<string, object> Data { get; private set; }
        public ComboItem(string value, string text, Dictionary<string, object> data) { Value = value; Text = text; Data = data; }
        public override string ToString() { return Text; }
    }

    internal sealed class PromptDialog : Form
    {
        private readonly TextBox _value = new TextBox();
        private PromptDialog(string title, string message, string initial)
        {
            Text = title; Icon = BrandIconFactory.Create(64); StartPosition = FormStartPosition.CenterParent; Size = new Size(520, 190); MinimizeBox = false; MaximizeBox = false; FormBorderStyle = FormBorderStyle.FixedDialog;
            Label label = new Label { Text = message, Dock = DockStyle.Top, Height = 58, Padding = new Padding(12), AutoEllipsis = true };
            _value.Text = initial ?? ""; _value.Dock = DockStyle.Top; _value.Margin = new Padding(12);
            FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
            Button ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Width = 90 };
            Button cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 90 };
            buttons.Controls.Add(ok); buttons.Controls.Add(cancel); Controls.Add(buttons); Controls.Add(_value); Controls.Add(label); AcceptButton = ok; CancelButton = cancel;
        }
        public static string Show(IWin32Window owner, string title, string message, string initial) { using (PromptDialog dialog = new PromptDialog(title, message, initial)) return dialog.ShowDialog(owner) == DialogResult.OK ? dialog._value.Text : null; }
    }

    internal sealed class OwnerPasswordDialog : Form
    {
        private readonly TextBox _token = new TextBox();
        private readonly TextBox _authFile = new TextBox();

        private OwnerPasswordDialog(string token, string authFile)
        {
            Text = "首次部署 · Owner Password";
            Icon = BrandIconFactory.Create(64);
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(720, 330);
            MinimumSize = new Size(720, 330);
            MaximumSize = new Size(920, 430);
            MinimizeBox = false;
            MaximizeBox = false;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            BackColor = UiPalette.Background;
            Font = UiTypography.Ui(9.5F);

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 7,
                Padding = new Padding(24, 20, 24, 18),
                BackColor = UiPalette.Background,
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

            Label title = new Label
            {
                Text = "首次生成的 Owner Password",
                Dock = DockStyle.Fill,
                Font = UiTypography.Display(15F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            Label hint = new Label
            {
                Text = "这是 DevSpace Owner approval 使用的凭据。密码已同时写入下方 auth.json；可分别一键复制密码和 auth.json 路径。关闭窗口后不会再次主动展示明文。",
                Dock = DockStyle.Fill,
                ForeColor = UiPalette.TextMuted,
                TextAlign = ContentAlignment.MiddleLeft,
                AutoEllipsis = true,
            };
            Label tokenLabel = new Label
            {
                Text = "Owner Password",
                Dock = DockStyle.Fill,
                ForeColor = UiPalette.TextMuted,
                TextAlign = ContentAlignment.BottomLeft,
            };
            Label pathLabel = new Label
            {
                Text = "auth.json 位置（Owner Password 已写入此文件）",
                Dock = DockStyle.Fill,
                ForeColor = UiPalette.TextMuted,
                TextAlign = ContentAlignment.BottomLeft,
            };

            TableLayoutPanel tokenRow = BuildValueRow(_token, token ?? "", "复制 Owner Password");
            TableLayoutPanel pathRow = BuildValueRow(_authFile, authFile ?? "", "复制 auth.json 路径");

            FlowLayoutPanel buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                Padding = new Padding(0, 12, 0, 0),
                BackColor = Color.Transparent,
            };
            ModernButton close = new ModernButton
            {
                Text = "我已保存",
                Primary = true,
                Width = 122,
                Height = 42,
                AutoSize = false,
                DialogResult = DialogResult.OK,
            };
            buttons.Controls.Add(close);

            layout.Controls.Add(title, 0, 0);
            layout.Controls.Add(hint, 0, 1);
            layout.Controls.Add(tokenLabel, 0, 2);
            layout.Controls.Add(tokenRow, 0, 3);
            layout.Controls.Add(pathLabel, 0, 4);
            layout.Controls.Add(pathRow, 0, 5);
            layout.Controls.Add(buttons, 0, 6);
            Controls.Add(layout);
            AcceptButton = close;
            CancelButton = close;
        }

        private TableLayoutPanel BuildValueRow(TextBox box, string value, string copyText)
        {
            TableLayoutPanel row = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = Color.Transparent,
                Margin = new Padding(0),
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 166));

            box.Text = value;
            box.ReadOnly = true;
            box.Dock = DockStyle.Fill;
            box.Font = UiTypography.Code(9.25F);
            box.BackColor = Color.White;
            box.ForeColor = UiPalette.Text;
            box.BorderStyle = BorderStyle.FixedSingle;
            box.Margin = new Padding(0, 4, 10, 4);

            ModernButton copy = new ModernButton
            {
                Text = copyText,
                Width = 156,
                Height = 42,
                AutoSize = false,
                Margin = new Padding(0, 4, 0, 4),
            };
            copy.Click += delegate
            {
                if (string.IsNullOrEmpty(box.Text)) return;
                try
                {
                    Clipboard.SetText(box.Text);
                    copy.Text = "已复制";
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "复制失败：" + ex.Message, "复制", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };

            row.Controls.Add(box, 0, 0);
            row.Controls.Add(copy, 1, 0);
            return row;
        }

        public static void Show(IWin32Window owner, string token, string authFile)
        {
            using (OwnerPasswordDialog dialog = new OwnerPasswordDialog(token, authFile))
                dialog.ShowDialog(owner);
        }
    }
}
