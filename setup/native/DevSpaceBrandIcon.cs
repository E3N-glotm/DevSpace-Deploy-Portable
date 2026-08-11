using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace DevSpaceBranding
{
    internal static class BrandIconFactory
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr hIcon);

        public static Icon Create(int size = 64)
        {
            int edge = Math.Max(32, size);
            using (var bitmap = new Bitmap(edge, edge, PixelFormat.Format32bppArgb))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Transparent);
                float inset = edge * 0.055F;
                RectangleF bounds = new RectangleF(inset, inset, edge - inset * 2F, edge - inset * 2F);
                DrawMark(graphics, bounds);

                IntPtr handle = bitmap.GetHicon();
                try
                {
                    using (Icon temporary = Icon.FromHandle(handle))
                        return (Icon)temporary.Clone();
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        public static void DrawMark(Graphics graphics, RectangleF bounds)
        {
            if (graphics == null || bounds.Width <= 1F || bounds.Height <= 1F) return;
            float edge = Math.Min(bounds.Width, bounds.Height);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;

            float radius = edge * 0.26F;
            using (GraphicsPath path = RoundedRectangle(bounds, radius))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(73, 91, 246)))
                graphics.FillPath(fill, path);

            using (Font font = new Font("Segoe UI", edge * 0.52F, FontStyle.Bold, GraphicsUnit.Pixel))
            using (SolidBrush text = new SolidBrush(Color.White))
            using (var format = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center,
                FormatFlags = StringFormatFlags.NoWrap,
            })
            {
                RectangleF textBounds = new RectangleF(bounds.X, bounds.Y - edge * 0.015F, bounds.Width, bounds.Height * 1.02F);
                graphics.DrawString("D", font, text, textBounds, format);
            }
        }

        private static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
        {
            float diameter = Math.Max(2F, radius * 2F);
            float maxDiameter = Math.Min(bounds.Width, bounds.Height);
            diameter = Math.Min(diameter, maxDiameter);
            var path = new GraphicsPath();
            var arc = new RectangleF(bounds.X, bounds.Y, diameter, diameter);
            path.AddArc(arc, 180, 90);
            arc.X = bounds.Right - diameter;
            path.AddArc(arc, 270, 90);
            arc.Y = bounds.Bottom - diameter;
            path.AddArc(arc, 0, 90);
            arc.X = bounds.Left;
            path.AddArc(arc, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
