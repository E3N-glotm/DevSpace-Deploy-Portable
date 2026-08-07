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
            using (Font titleFont = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold))
                TextRenderer.DrawText(e.Graphics, Title ?? Text, titleFont, new Rectangle(60, 10, Math.Max(0, Width - 72), 24), Selected ? Color.White : UiPalette.Text,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            using (Font subtitleFont = new Font("Segoe UI Variable Text", 8.25F))
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
            Font = new Font("Microsoft YaHei UI", 9F);
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
            Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold);
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
        public FieldHost(Control child, int width = 0)
        {
            BackColor = Color.Transparent;
            Margin = new Padding(3, 3, 3, 6);
            bool multiline = child is TextBox && ((TextBox)child).Multiline;
            Padding = multiline
                ? new Padding(10)
                : child is ComboBox
                    ? new Padding(10, 3, 8, 3)
                    : new Padding(10, 7, 8, 6);
            Height = multiline ? Math.Max(72, child.Height + 12) : 38;
            MinimumSize = new Size(40, Height);
            if (width > 0) Width = width;
            child.Dock = DockStyle.Fill;
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
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
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
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            base.OnPaintBackground(e);
            if (ClientSize.Width <= 1 || ClientSize.Height <= 1) return;
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = DrawingUtil.Rounded(bounds, 15))
            using (SolidBrush fill = new SolidBrush(UiPalette.Primary))
                e.Graphics.FillPath(fill, path);
            using (Font mark = new Font("Segoe UI Variable Display", 19F, FontStyle.Bold))
                TextRenderer.DrawText(e.Graphics, "D", mark, bounds, Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
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
            Font = new Font("Microsoft YaHei UI", 9F);
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
            _path.Font = new Font("Cascadia Mono", 9.5F, FontStyle.Bold);
            _path.ForeColor = Color.FromArgb(223, 225, 229);
            _path.AutoEllipsis = true;
            _path.Text = "未选择文件";
            _meta.Dock = DockStyle.Bottom;
            _meta.Height = 18;
            _meta.Font = new Font("Segoe UI Variable Text", 8.25F);
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
            _content.Font = new Font("Cascadia Mono", 9F);
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
            using (Font placeholder = new Font("Segoe UI Variable Text", 10F))
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
            using (Font regular = new Font("Cascadia Mono", 9F, FontStyle.Regular))
            using (Font bold = new Font("Cascadia Mono", 9F, FontStyle.Bold))
            {
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

                    _content.SelectionColor = Color.FromArgb(91, 95, 103);
                    _content.SelectionBackColor = Color.FromArgb(30, 31, 34);
                    _content.SelectionFont = regular;
                    _content.AppendText((index + 1).ToString().PadLeft(5) + "  ");

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
            report["logs"] = manager.RunJson("log-paths");
            report["processes"] = manager.RunJson("portable-processes");
            using (MainForm form = new MainForm(root))
            {
                form.CreateControl();
                report["uiTabs"] = FindControls<TabControl>(form).SelectMany(tab => tab.TabPages.Cast<TabPage>()).Select(page => page.Text).ToArray();
                report["uiButtons"] = FindControls<Button>(form).Select(button => button.Text).Where(text => !string.IsNullOrWhiteSpace(text)).Distinct().OrderBy(text => text).ToArray();
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
        private readonly InlineNotice _inlineNotice = new InlineNotice();
        private readonly TableLayoutPanel _contentLayout = new TableLayoutPanel();
        private readonly RichTextBox _operationOutput = CreateConsoleBox();
        private readonly RichTextBox _devspaceLog = CreateLogBox();
        private readonly RichTextBox _tunnelLog = CreateLogBox();
        private readonly DataGridView _pluginGrid = CreateGrid();
        private readonly DataGridView _slotGrid = CreateGrid();
        private readonly DataGridView _sessionGrid = CreateGrid();
        private readonly DataGridView _fileGrid = CreateGrid();
        private readonly ModernDiffViewer _diffViewer = new ModernDiffViewer();
        private readonly BorderlessTabControl _sessionPages = new BorderlessTabControl();
        private readonly DataGridView _memoryGrid = CreateGrid();
        private readonly System.Windows.Forms.Timer _heartbeatTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _statusTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _noticeTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _computerUseTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _computerUseIndicatorTimer = new System.Windows.Forms.Timer();
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
        private int _busyOperationCount;
        private Dictionary<string, object> _currentConfig = new Dictionary<string, object>();
        private Dictionary<string, object> _selectedSessionDetails = new Dictionary<string, object>();
        private List<Dictionary<string, object>> _allSessions = new List<Dictionary<string, object>>();
        private List<Dictionary<string, object>> _allMemories = new List<Dictionary<string, object>>();
        private string _fullSessionPatch = "";
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
        private Label _sessionSummary;
        private Label _sessionDetailTitle;
        private Label _sessionDetailMeta;
        private TextBox _memorySearch;
        private ComboBox _memoryScope;
        private ComboBox _memoryWorkspace;
        private TextBox _memoryTitle;
        private TextBox _memoryTags;
        private TextBox _memoryContent;
        private Label _memoryStatus;

        public MainForm(string root)
        {
            _root = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            _manager = new ManagerClient(_root);
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
            BuildUi();
            Shown += async delegate { await RunUiActionAsync(InitializeAsync); };
            FormClosing += MainForm_FormClosing;
            _heartbeatTimer.Interval = 1500;
            _heartbeatTimer.Tick += async delegate { await HeartbeatAsync(); };
            _statusTimer.Interval = 15000;
            _statusTimer.Tick += async delegate { await RefreshStatusAsync(false); };
            _noticeTimer.Interval = 9000;
            _noticeTimer.Tick += delegate { _noticeTimer.Stop(); _inlineNotice.Dismiss(); };
            _computerUseTimer.Interval = 15;
            _computerUseTimer.Tick += async delegate { await ProcessComputerUseQueueAsync(); };
            _computerUseIndicatorTimer.Interval = 100;
            _computerUseIndicatorTimer.Tick += delegate { _computerUseIndicator.Tick(); };
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
            _trayMenu.Font = new Font("Microsoft YaHei UI", 9F);
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
            _notifyIcon.Icon = SystemIcons.Application;
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
                Font = new Font("Segoe UI Variable Display", 18.5F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(82, 15),
            };
            _pageTitle.Text = "状态与部署";
            _pageTitle.Font = new Font("Microsoft YaHei UI", 9.5F);
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
            _versionLabel.Text = "DevSpace Portable 1.1.15 · Protocol 1.5";
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
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 118));
            FlowLayoutPanel buttons = NewButtonBar();
            buttons.Controls.Add(ActionButton("保存并自动部署", async delegate { await DeployAsync(); }, true));
            buttons.Controls.Add(ActionButton("启动服务", async delegate { await RunActionAsync("start"); }));
            buttons.Controls.Add(ActionButton("重启服务", async delegate { await ConfirmActionAsync("restart", "确定重启 DevSpace 和公网隧道吗？"); }));
            buttons.Controls.Add(ActionButton("停止全部并退出", async delegate { await StopEverythingAsync(); }, false, true));
            buttons.Controls.Add(ActionButton("停止并禁用", async delegate { await ConfirmActionAsync("disable", "确定停止并禁用 DevSpace 与隧道计划任务吗？"); }, false, true));
            buttons.Controls.Add(ActionButton("恢复并启动", async delegate { await RunActionAsync("enable"); }));
            buttons.Controls.Add(ActionButton("卸载计划任务", async delegate { await ConfirmActionAsync("uninstall-tasks", "确定卸载 DevSpace 与隧道计划任务吗？配置和认证数据不会删除。"); }, false, true));
            buttons.Controls.Add(ActionButton("刷新状态", async delegate { await RefreshStatusAsync(true); }));
            buttons.Controls.Add(ActionButton("检查更新", async delegate { await CheckForUpdatesAsync(); }, true));
            buttons.Controls.Add(ActionButton("重置关闭选择", delegate
            {
                SaveClosePreference("");
                ShowInlineNotice("已恢复为每次点击关闭按钮时询问。", false);
            }));
            buttons.Controls.Add(ActionButton("验证 HTTP", async delegate { await RunActionAsync("test"); }));
            buttons.Controls.Add(ActionButton("诊断隧道", async delegate { await RunActionAsync("diagnose"); }));
            buttons.Controls.Add(ActionButton("验证文件", async delegate { await RunActionAsync("verify-files"); }));
            buttons.Controls.Add(ActionButton("任务计划程序", delegate { OpenExternal("taskschd.msc"); }));
            buttons.Controls.Add(ActionButton("打开日志目录", delegate { OpenExternal(Path.Combine(_root, "logs")); }));
            layout.Controls.Add(buttons, 0, 0);
            GroupBox statusGroup = NewGroup("服务状态");
            statusGroup.Controls.Add(WrapSurface(_operationOutput, true));
            layout.Controls.Add(statusGroup, 0, 1);
            GroupBox help = NewGroup("运行说明");
            Label helpText = new Label
            {
                Dock = DockStyle.Fill,
                ForeColor = UiPalette.TextMuted,
                Font = new Font("Microsoft YaHei UI", 9.5F),
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(10, 4, 10, 4),
                Text = "停止全部会结束当前 Portable 的服务、隧道和桌面 Broker，并在确认无残留后台进程后退出。",
            };
            help.Controls.Add(helpText);
            layout.Controls.Add(help, 0, 2);
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
            actions.Controls.Add(ActionButton("只保存设置", async delegate { await SaveConfigurationAsync(false); }, true));
            actions.Controls.Add(ActionButton("保存并自动部署", async delegate { await DeployAsync(); }));
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

        private TabPage BuildPluginsTab()
        {
            TabPage page = new TabPage("插件管理");
            SplitContainer split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                SplitterDistance = 350,
                BorderStyle = BorderStyle.None,
                BackColor = UiPalette.Background,
            };
            split.SizeChanged += delegate
            {
                if (split.Height > 620 && split.SplitterDistance > split.Height - 280)
                    split.SplitterDistance = split.Height - 280;
            };
            TableLayoutPanel top = NewTable(1, 2);
            FlowLayoutPanel actions = NewButtonBar();
            actions.Controls.Add(ActionButton("刷新插件", async delegate { await LoadPluginsAsync(); }, true));
            actions.Controls.Add(ActionButton("安装插件", async delegate { await InstallPluginAsync(); }));
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
                Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(10, 8),
            };
            Label listHint = new Label
            {
                Text = "选择一轮会话进入独立审阅页，查看改动文件、逐文件差异并执行回退。",
                Font = new Font("Microsoft YaHei UI", 9.25F),
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
            _showHidden = new ModernToggle { Text = "显示隐藏", Width = 122, Margin = new Padding(8, 3, 2, 0) };
            _showArchived = new ModernToggle { Text = "显示归档", Width = 122, Margin = new Padding(8, 3, 2, 0) };
            _showHidden.CheckedChanged += async delegate { await RunUiActionAsync(LoadSessionsAsync); };
            _showArchived.CheckedChanged += async delegate { await RunUiActionAsync(LoadSessionsAsync); };
            Control searchHost = WrapField(_sessionSearch);
            searchHost.Dock = DockStyle.Fill;
            searchHost.MinimumSize = new Size(90, searchHost.MinimumSize.Height);
            searchRow.Controls.Add(ToolbarLabel("搜索"), 0, 0);
            searchRow.Controls.Add(searchHost, 1, 0);
            searchRow.Controls.Add(ActionButton("刷新", async delegate { await LoadSessionsAsync(); }, true), 2, 0);
            optionRow.Controls.Add(_showHidden);
            optionRow.Controls.Add(_showArchived);
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
            TableLayoutPanel details = NewTable(1, 4);
            details.AutoScroll = false;
            details.RowStyles.Add(new RowStyle(SizeType.Absolute, 96));
            details.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            details.RowStyles.Add(new RowStyle(SizeType.Percent, 38));
            details.RowStyles.Add(new RowStyle(SizeType.Percent, 62));

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
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(6, 8),
            };
            _sessionDetailMeta = new Label
            {
                Text = "正在读取会话详情……",
                Font = new Font("Microsoft YaHei UI", 9.25F),
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
            reviewActions.Controls.Add(ActionButton("回退此次修改", async delegate { await RollbackSelectedSessionAsync(); }, false, true));
            reviewActions.Controls.Add(ActionButton("恢复回退前快照", async delegate { await RestoreSafetySnapshotAsync(); }));
            reviewActions.Controls.Add(ActionButton("打开项目目录", delegate { OpenSelectedSessionFolder(); }));
            details.Controls.Add(reviewActions, 0, 1);

            ConfigureFileGrid();
            GroupBox filesGroup = NewGroup("本轮改动文件");
            filesGroup.Controls.Add(WrapSurface(_fileGrid));
            details.Controls.Add(filesGroup, 0, 2);
            GroupBox diffGroup = NewGroup("文件差异 · 仅显示当前选择");
            SurfacePanel diffSurface = new SurfacePanel { Dock = DockStyle.Fill, Dark = true, Padding = new Padding(1), Margin = new Padding(4) };
            diffSurface.Controls.Add(_diffViewer);
            diffGroup.Controls.Add(diffSurface);
            details.Controls.Add(diffGroup, 0, 3);
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
                SplitterDistance = 470,
                Panel1MinSize = 390,
                Panel2MinSize = 460,
                SplitterWidth = 14,
                BorderStyle = BorderStyle.None,
                BackColor = UiPalette.Background,
            };
            split.SizeChanged += delegate
            {
                int available = Math.Max(0, split.ClientSize.Width - split.SplitterWidth);
                if (available < split.Panel1MinSize + split.Panel2MinSize) return;
                split.SplitterDistance = Math.Max(split.Panel1MinSize, Math.Min((int)(available * 0.43), available - split.Panel2MinSize));
            };

            TableLayoutPanel list = NewTable(1, 4);
            list.AutoScroll = false;
            list.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
            list.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            list.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            list.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Panel intro = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Padding = new Padding(10, 8, 10, 4) };
            intro.Controls.Add(new Label
            {
                Text = "显式 Memories",
                Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold),
                ForeColor = UiPalette.Text,
                AutoSize = true,
                Location = new Point(8, 8),
            });
            intro.Controls.Add(new Label
            {
                Text = "这些记录由用户明确维护，不会从命令输出或浏览历史中自动推断。",
                Font = new Font("Microsoft YaHei UI", 9.25F),
                ForeColor = UiPalette.TextMuted,
                AutoSize = true,
                Location = new Point(10, 44),
            });
            list.Controls.Add(intro, 0, 0);

            TableLayoutPanel search = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 3, BackColor = Color.Transparent, Padding = new Padding(3) };
            search.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            search.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            search.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            _memorySearch = new TextBox();
            StyleField(_memorySearch);
            _memorySearch.TextChanged += delegate { RenderMemoryList(); };
            Control memorySearchHost = WrapField(_memorySearch);
            memorySearchHost.Dock = DockStyle.Fill;
            search.Controls.Add(ToolbarLabel("搜索"), 0, 0);
            search.Controls.Add(memorySearchHost, 1, 0);
            search.Controls.Add(ActionButton("刷新", async delegate { await LoadMemoriesAsync(); }, true), 2, 0);
            list.Controls.Add(search, 0, 1);
            ConfigureMemoryGrid();
            list.Controls.Add(WrapSurface(_memoryGrid), 0, 2);
            FlowLayoutPanel memoryListActions = NewButtonBar();
            memoryListActions.Controls.Add(ActionButton("新建 Memory", delegate { BeginNewMemory(); }, true));
            memoryListActions.Controls.Add(ActionButton("删除所选", async delegate { await DeleteSelectedMemoryAsync(); }, false, true));
            list.Controls.Add(memoryListActions, 0, 3);
            split.Panel1.Controls.Add(list);

            TableLayoutPanel editorLayout = NewTable(1, 3);
            editorLayout.AutoScroll = false;
            editorLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
            editorLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            editorLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _memoryStatus = new Label
            {
                Dock = DockStyle.Fill,
                Text = "新建或选择一条 Memory。",
                Font = new Font("Microsoft YaHei UI", 10F),
                ForeColor = UiPalette.TextMuted,
                Padding = new Padding(12, 16, 12, 8),
                AutoEllipsis = true,
            };
            editorLayout.Controls.Add(_memoryStatus, 0, 0);
            GroupBox editor = NewGroup("Memory 内容");
            TableLayoutPanel form = NewFormTable();
            _memoryScope = AddCombo(form, "作用域", new[] { "workspace", "global" });
            _memoryScope.SelectedIndexChanged += delegate { UpdateMemoryWorkspaceState(); };
            _memoryWorkspace = AddCombo(form, "工作区", new string[0]);
            _memoryTitle = AddText(form, "标题");
            _memoryTags = AddText(form, "标签（逗号分隔）");
            _memoryContent = AddMultiline(form, "内容", 260);
            editor.Controls.Add(form);
            editorLayout.Controls.Add(editor, 0, 1);
            FlowLayoutPanel editorActions = NewButtonBar();
            editorActions.Controls.Add(ActionButton("保存 Memory", async delegate { await SaveMemoryAsync(); }, true));
            editorActions.Controls.Add(ActionButton("清空编辑器", delegate { BeginNewMemory(); }));
            editorLayout.Controls.Add(editorActions, 0, 2);
            split.Panel2.Controls.Add(editorLayout);

            page.Controls.Add(split);
            return page;
        }

        private TabPage BuildLogsTab()
        {
            TabPage page = new TabPage("日志与诊断");
            TableLayoutPanel layout = NewTable(1, 3);
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 58));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 42));
            FlowLayoutPanel buttons = NewButtonBar();
            buttons.Controls.Add(ActionButton("刷新日志", async delegate { await LoadLogsAsync(); }, true));
            buttons.Controls.Add(ActionButton("打开日志目录", delegate { OpenExternal(Path.Combine(_root, "logs")); }));
            buttons.Controls.Add(ActionButton("运行诊断", async delegate { await RunActionAsync("diagnose"); }));
            layout.Controls.Add(buttons, 0, 0);
            GroupBox dev = NewGroup("DevSpace 日志"); dev.Controls.Add(_devspaceLog); layout.Controls.Add(dev, 0, 1);
            GroupBox tunnel = NewGroup("隧道日志"); tunnel.Controls.Add(_tunnelLog); layout.Controls.Add(tunnel, 0, 2);
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
                await LoadConfigurationAsync();
                await LoadPluginsAsync();
                await LoadSessionsAsync();
                await LoadMemoriesAsync();
                await LoadLogsAsync();
                await RefreshStatusAsync(false);
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
            }
            else if (ready)
            {
                _leaseLabel.ForeColor = UiPalette.Success;
                _leaseLabel.Text = "Computer Use 在线 · PID " + GetInt(broker, "pid");
            }
            else
            {
                _leaseLabel.ForeColor = Color.FromArgb(210, 132, 30);
                _leaseLabel.Text = "Computer Use 正在启动 · " + GetString(broker, "reason", "waiting");
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
            _ngrokCas.Checked = GetBool(_currentConfig, "ngrokConnectCasHost");
            _versionLabel.Text = "DevSpace Portable " + GetString(_currentConfig, "portableVersion", "1.1.15") + " · Protocol " + GetString(_currentConfig, "protocolVersion", "1.5");
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
                MessageBox.Show(this, "首次生成的 Owner Password：\r\n\r\n" + GetString(result, "ownerToken") + "\r\n\r\n请立即保存到密码管理器。", "Owner Password", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                SetOutput("正在安装任务并启动服务……");
                string install = await _manager.RunAsync("install-tasks");
                string start = await _manager.RunAsync("start");
                string test;
                try { test = await _manager.RunAsync("test"); }
                catch (Exception ex) { test = "HTTP 验证未通过：" + ex.Message; }
                SetOutput(install + Environment.NewLine + start + Environment.NewLine + test);
                await RefreshStatusAsync(false);
            });
        }

        private async Task RunActionAsync(string action)
        {
            await ExecuteBusyAsync(async delegate { SetOutput(await _manager.RunAsync(action)); });
        }

        private async Task ConfirmActionAsync(string action, string message)
        {
            if (MessageBox.Show(this, message, "确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                await RunActionAsync(action);
        }

        private async Task StopEverythingAsync()
        {
            if (MessageBox.Show(this, "将停止计划任务、DevSpace、隧道、Computer Use Broker 和 Portable 根目录所属后台进程，随后关闭本程序。确定继续吗？", "停止全部", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                return;
            await ExecuteBusyAsync(async delegate
            {
                await _manager.RunAsync("stop");
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

        private async Task CheckForUpdatesAsync()
        {
            await ExecuteBusyAsync(async delegate
            {
                SetOutput("正在通过 GitHub Releases 检查稳定版更新……");
                Dictionary<string, object> status = await _manager.RunJsonAsync("update-check");
                string current = GetString(status, "currentVersion", "1.1.15");
                string latest = GetString(status, "latestVersion", current);
                if (!GetBool(status, "updateAvailable"))
                {
                    SetOutput("当前版本 " + current + " 已是 GitHub 最新稳定版。\r\n" + GetString(status, "releaseUrl"));
                    MessageBox.Show(this, "当前版本 " + current + " 已是最新稳定版。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                if (GetBool(status, "sourceCheckout"))
                {
                    SetOutput("检测到 Git 源码工作区。在线更新器不会覆盖源码检出目录；请在正式 Release 解压目录中使用更新功能。\r\n最新版本：" + latest);
                    MessageBox.Show(this, "检测到当前目录包含 .git。为避免覆盖源码和未提交改动，在线更新仅允许在正式 Release 解压目录中执行。\r\n\r\n最新版本：" + latest, "源码工作区不执行热更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                long size = GetLong(status, "assetSize");
                string prompt = "发现 DevSpace Portable " + latest + "。\r\n\r\n"
                    + "安装包：" + GetString(status, "assetName") + "\r\n"
                    + "大小：" + FormatBytes(size) + "\r\n\r\n"
                    + "将从公开 GitHub Release 下载并校验 SHA-256；下载完成后会关闭控制中心、停止当前 Portable 服务、替换程序文件、重新启动服务和 UI。data、logs 与 reports 会保留。现在继续吗？";
                if (MessageBox.Show(this, prompt, "发现新版本 " + latest, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                {
                    SetOutput("已取消更新。当前版本仍为 " + current + "。");
                    return;
                }

                SetOutput("正在下载 DevSpace Portable " + latest + "，并验证文件大小、SHA-256 与压缩包路径安全……");
                Dictionary<string, object> staged = await _manager.RunJsonAsync("update-stage");
                if (!GetBool(staged, "staged"))
                {
                    SetOutput("更新检查完成，但没有需要安装的新版本。");
                    return;
                }
                string stagingPath = GetString(staged, "stagingPath");
                SetOutput("更新包已完成校验并暂存。\r\n目标版本：" + latest + "\r\n暂存目录：" + stagingPath);
                if (MessageBox.Show(this, "更新包已完成下载与校验。现在关闭控制中心并执行受控更新吗？\r\n\r\n如果替换失败，更新器会恢复原版本并重新启动。", "准备安装 " + latest, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                {
                    SetOutput("更新包已暂存，但尚未安装。再次点击“检查更新”可以重新开始更新流程。 ");
                    return;
                }
                Dictionary<string, object> launched = await _manager.RunJsonAsync("update-launch", new
                {
                    stagingPath = stagingPath,
                    uiPid = Process.GetCurrentProcess().Id,
                });
                if (!GetBool(launched, "launched")) throw new InvalidOperationException("更新器没有成功启动。 ");
                _closingForUpdate = true;
                _allowUiExit = true;
                Close();
            });
        }

        private static string FormatBytes(long value)
        {
            if (value < 1024) return value + " B";
            if (value < 1024L * 1024L) return (value / 1024D).ToString("0.0") + " KiB";
            if (value < 1024L * 1024L * 1024L) return (value / 1024D / 1024D).ToString("0.0") + " MiB";
            return (value / 1024D / 1024D / 1024D).ToString("0.00") + " GiB";
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
            Dictionary<string, object> value = await _manager.RunJsonAsync("review-list", new { includeHidden = _showHidden.Checked, includeArchived = _showArchived.Checked });
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
                    int groupFiles = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "files"));
                    int groupAdditions = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "additions"));
                    int groupRemovals = sessions.Sum(session => GetInt(GetDictionary(session, "summary"), "removals"));
                    int headerIndex = _sessionGrid.Rows.Add(
                        sessions.Any(session => GetBool(session, "pinned")) ? "★" : "",
                        group.Key + "  ·  " + sessions.Count + " 轮",
                        "分组",
                        groupFiles,
                        "+" + groupAdditions + " -" + groupRemovals,
                        FormatLocalTime(GetString(sessions[0], "updatedAt")),
                        "");
                    DataGridViewRow header = _sessionGrid.Rows[headerIndex];
                    header.Tag = null;
                    header.Height = 42;
                    header.DefaultCellStyle.BackColor = UiPalette.SurfaceStrong;
                    header.DefaultCellStyle.SelectionBackColor = UiPalette.SurfaceStrong;
                    header.DefaultCellStyle.ForeColor = UiPalette.Text;
                    header.DefaultCellStyle.SelectionForeColor = UiPalette.Text;
                    header.DefaultCellStyle.Font = _sessionGrid.ColumnHeadersDefaultCellStyle.Font;

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
                _diffViewer.ShowEmpty("本轮没有已跟踪文件变化。 ");
            }
            _sessionPages.SelectedIndex = 1;
        }

        private void RenderSelectedFileDiff()
        {
            if (_fileGrid.SelectedRows.Count != 1)
            {
                _diffViewer.ShowEmpty("请在上方选择一个文件；不会在未选择时展示整轮差异。 ");
                return;
            }
            Dictionary<string, object> file = _fileGrid.SelectedRows[0].Tag as Dictionary<string, object>;
            string path = GetString(file, "path");
            RenderDiff(ExtractPatchForFile(_fullSessionPatch, path), path);
        }

        private static string ExtractPatchForFile(string patch, string filePath)
        {
            string text = patch ?? "";
            if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(filePath)) return text;
            string normalized = filePath.Replace('\\', '/');
            string marker = "diff --git a/" + normalized + " b/" + normalized;
            int start = text.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0)
            {
                string plusMarker = "+++ b/" + normalized;
                int plus = text.IndexOf(plusMarker, StringComparison.Ordinal);
                if (plus < 0) return "";
                start = text.LastIndexOf("diff --git ", plus, StringComparison.Ordinal);
                if (start < 0) start = 0;
            }
            int end = text.IndexOf("\ndiff --git ", start + 1, StringComparison.Ordinal);
            return end < 0 ? text.Substring(start) : text.Substring(start, end - start);
        }

        private void RenderDiff(string patch, string title)
        {
            _diffViewer.Render(patch, title);
        }

        private void PopulateMemoryWorkspaces()
        {
            if (_memoryWorkspace == null) return;
            string selected = Convert.ToString(_memoryWorkspace.SelectedItem ?? "");
            _memoryWorkspace.Items.Clear();
            foreach (string root in GetStringList(_currentConfig, "allowedRoots")) _memoryWorkspace.Items.Add(root);
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
            string selectedId = SelectedMemoryId(false);
            _memoryListLoading = true;
            try
            {
                _memoryGrid.Rows.Clear();
                foreach (Dictionary<string, object> memory in _allMemories)
                {
                    string title = GetString(memory, "title");
                    string content = GetString(memory, "content");
                    string tags = string.Join(", ", GetStringList(memory, "tags"));
                    if (query.Length > 0 && !title.ToLowerInvariant().Contains(query) && !content.ToLowerInvariant().Contains(query) && !tags.ToLowerInvariant().Contains(query)) continue;
                    int row = _memoryGrid.Rows.Add(GetString(memory, "scope"), title, tags, FormatLocalTime(GetString(memory, "updatedAt")));
                    _memoryGrid.Rows[row].Tag = memory;
                    if (GetString(memory, "id") == selectedId) _memoryGrid.Rows[row].Selected = true;
                }
            }
            finally { _memoryListLoading = false; }
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
            _memoryStatus.Text = "正在编辑：" + GetString(memory, "title") + "  ·  " + GetString(memory, "scope") + "  ·  更新于 " + FormatLocalTime(GetString(memory, "updatedAt"));
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
            _heartbeatTimer.Stop(); _statusTimer.Stop(); _noticeTimer.Stop(); _computerUseTimer.Stop(); _computerUseIndicatorTimer.Stop();
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
            _sessionGrid.CellDoubleClick += async delegate { if (!_sessionListLoading && _sessionGrid.SelectedRows.Count == 1) await RunUiActionAsync(OpenSelectedSessionAsync); };
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
        }
        private void ConfigureMemoryGrid()
        {
            _memoryGrid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.None;
            _memoryGrid.RowTemplate.Height = 48;
            _memoryGrid.Columns.Add("memoryScope", "作用域");
            _memoryGrid.Columns.Add("memoryTitle", "标题");
            _memoryGrid.Columns.Add("memoryTags", "标签");
            _memoryGrid.Columns.Add("memoryUpdated", "更新");
            _memoryGrid.Columns["memoryScope"].Width = 86;
            _memoryGrid.Columns["memoryTitle"].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            _memoryGrid.Columns["memoryTitle"].MinimumWidth = 120;
            _memoryGrid.Columns["memoryTags"].Width = 140;
            _memoryGrid.Columns["memoryUpdated"].Width = 128;
            _memoryGrid.SelectionChanged += MemorySelectionChanged;
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
        private static RichTextBox CreateConsoleBox() { return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = UiPalette.Console, ForeColor = UiPalette.ConsoleText, Font = new Font("Cascadia Mono", 9.25F), BorderStyle = BorderStyle.None, DetectUrls = false, Margin = new Padding(0) }; }
        private static RichTextBox CreateLogBox() { return new RichTextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = UiPalette.Surface, ForeColor = Color.FromArgb(55, 65, 82), Font = new Font("Cascadia Mono", 9.25F), BorderStyle = BorderStyle.None, DetectUrls = false, Margin = new Padding(4), Padding = new Padding(6) }; }
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
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
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
            control.Font = new Font("Microsoft YaHei UI", 9F);
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
            Text = title; StartPosition = FormStartPosition.CenterParent; Size = new Size(520, 190); MinimizeBox = false; MaximizeBox = false; FormBorderStyle = FormBorderStyle.FixedDialog;
            Label label = new Label { Text = message, Dock = DockStyle.Top, Height = 58, Padding = new Padding(12), AutoEllipsis = true };
            _value.Text = initial ?? ""; _value.Dock = DockStyle.Top; _value.Margin = new Padding(12);
            FlowLayoutPanel buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 52, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
            Button ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Width = 90 };
            Button cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 90 };
            buttons.Controls.Add(ok); buttons.Controls.Add(cancel); Controls.Add(buttons); Controls.Add(_value); Controls.Add(label); AcceptButton = ok; CancelButton = cancel;
        }
        public static string Show(IWin32Window owner, string title, string message, string initial) { using (PromptDialog dialog = new PromptDialog(title, message, initial)) return dialog.ShowDialog(owner) == DialogResult.OK ? dialog._value.Text : null; }
    }
}
