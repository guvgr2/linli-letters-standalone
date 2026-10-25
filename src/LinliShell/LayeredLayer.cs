// 纯 GDI+ 自绘的「逐像素透明浮层」基类。
//
// ★★ 为什么要有这个文件（2026-10-20 用户第三次拍桌子）：
//   用户原话：「这按钮一点都不还原，甚至是黑的，还移动不了，按钮尺寸还不对，排布还不一样」。
//   上一版桌面圆钮是**WebView2 画页面**（dock.html）+ `SetWindowRgn` 把窗口裁成两个椭圆。
//   本机（卡巴斯基环境）WebView2 在这个窗口里反复崩，崩完窗口还在、页面没了 ⇒
//   用户看到的就是 `BackColor(20,20,22)` 被裁出来的**两个黑饼**：没图标、没文字、点不动。
//   试图靠"关沙箱 / 换控件重建"救内核，是在给一个本来没必要存在的东西续命。
//   ⇒ 圆钮和左侧导航**都不再用浏览器内核**：它们只是两个圆 / 一个胶囊，
//     纯 GDI+ 画一遍就够了，没有任何外部依赖，也就不存在"内核起不来"这件事。
//
// ★★ 为什么不能再用 SetWindowRgn：
//   region 只能给出**硬边**（没有抗锯齿、不能半透明、不能投影）。原版那两颗钮是
//   玻璃圆：柔边 + 半透明 + 落影 —— 硬边椭圆怎么调都不像。
//   ⇒ 改用 layered window：`WS_EX_LAYERED` + `UpdateLayeredWindow(..., ULW_ALPHA)`，
//     逐像素 alpha。alpha=0 的地方**系统直接把手势递给下面的桌面/窗口**（这是
//     UpdateLayeredWindow 的既定行为），所以不需要 region 也不会挡住桌面。
//
// ★★ 为什么自己写合成器（而不是直接拿 Graphics 画到 DIB 上）：
//   GDI+ 画到 32bpp 透明位图上到底写**直通 alpha** 还是**预乘 alpha**，不同路径说法不一
//   （文字边缘的"黑边"就是这个歧义造成的）。一旦猜错，半透明的字边会发黑。
//   ⇒ 这里一律：**自己开一块直通 ARGB 缓冲 → 自己按 SrcOver 合成 → 最后统一预乘一次**
//     交给 UpdateLayeredWindow。文字只取 GDI+ 输出的 **alpha 通道**当覆盖度、颜色自己上，
//     于是那条歧义在整条链路上都不存在（两条分支下 alpha 都等于覆盖度）。
//
// ★ 坐标口径：所有 `DIP(x)` 都是 96dpi 基准的设计值，乘当前 DPI 系数变成物理像素。
//   子类画图时一律用**物理像素**（`D(...)` 换算后再传进来），这样和 Bounds 同一套坐标。

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LinliLetters;

internal abstract class LayeredLayer : Form
{
    /// <summary>设计画布尺寸（DIP）。子类在构造时给。</summary>
    protected readonly int CssW;
    protected readonly int CssH;

    /// <summary>直通 alpha 的 ARGB（0xAARRGGBB）。每帧重画都从全透明开始。</summary>
    protected int[] Buf;

    /// <summary>物理像素画布尺寸。</summary>
    protected int W, H;

    private byte[] _bgra;
    private IntPtr _memDc, _dib, _dibBits, _oldBmp;
    private int _dibW, _dibH;

    protected LayeredLayer(int cssW, int cssH)
    {
        CssW = cssW;
        CssH = cssH;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;          // 看不见：窗口内容全在 layer 位图里
        SetStyle(ControlStyles.UserPaint | ControlStyles.Opaque, true);
    }

    /// <summary>当前 DPI 系数（96dpi = 1）。</summary>
    protected float S => DeviceDpi / 96f;

    /// <summary>DIP → 物理像素。</summary>
    protected float D(float dip) => dip * S;

    protected int Px => Math.Max(1, (int)Math.Round(CssW * S));
    protected int Py => Math.Max(1, (int)Math.Round(CssH * S));

    /// <summary>按当前 DPI 重算画布并把窗口尺寸对齐过去（窗口尺寸 = 画布尺寸）。</summary>
    protected void Rebuild()
    {
        int w = Px, h = Py;
        if (w == W && h == H && Buf != null) { Recompose(); return; }
        W = w;
        H = h;
        Buf = new int[W * H];
        _bgra = null;
        if (IsHandleCreated) Bounds = new Rectangle(Bounds.X, Bounds.Y, W, H);
        Recompose();
    }

    /// <summary>清空缓冲、让子类重画、再推给系统。</summary>
    protected void Recompose()
    {
        if (Buf == null) { Rebuild(); return; }
        Array.Clear(Buf, 0, Buf.Length);
        Compose();
        Present();
    }

    /// <summary>子类在这里把内容画进 <see cref="Buf"/>。</summary>
    protected abstract void Compose();

    // ------------------------------------------------------------------ 命中与交互

    /// <summary>某个客户区坐标落在哪一颗上（-1 = 空白）。</summary>
    protected abstract int IndexAt(int x, int y);

    /// <summary>点了第 i 颗。</summary>
    protected virtual void OnItemClicked(int index) { }

    /// <summary>按下第 i 颗（画"按下"态用）。</summary>
    protected virtual void OnItemPressed(int index) { }

    /// <summary>拖完了（子类把新位置存起来）。</summary>
    protected virtual void OnDragEnded() { }

    /// <summary>能不能拖动整块。左侧导航固定贴在主窗口边上，不许拖 ⇒ 子类关掉。</summary>
    protected virtual bool AllowDrag => true;

    protected int Hover = -1;
    protected int Pressed = -1;

    private Point _downScreen, _downLoc;
    private bool _pressed, _dragging;
    private int _pressIndex = -1;

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        _pressed = true;
        _dragging = false;
        _downScreen = Cursor.Position;
        _downLoc = Location;
        _pressIndex = IndexAt(e.X, e.Y);
        Pressed = _pressIndex;
        if (_pressIndex >= 0) OnItemPressed(_pressIndex);
        Capture = true;
        Recompose();
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);

        if (_pressed)
        {
            if (!_dragging && AllowDrag)
            {
                Point now = Cursor.Position;
                // ★ 阈值：没有它"点一下手抖"就变成拖动，圆钮永远点不中（原版也这样）。
                if (Math.Abs(now.X - _downScreen.X) > 4 || Math.Abs(now.Y - _downScreen.Y) > 4)
                {
                    _dragging = true;
                    Pressed = -1;
                }
            }
            if (_dragging)
            {
                Point now = Cursor.Position;
                Location = new Point(_downLoc.X + now.X - _downScreen.X,
                                     _downLoc.Y + now.Y - _downScreen.Y);
                Present();            // 目标位置变了，layer 要按新坐标重推一次
                return;
            }
        }

        int idx = IndexAt(e.X, e.Y);
        if (idx != Hover)
        {
            Hover = idx;
            Recompose();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        Capture = false;

        bool dragged = _dragging;
        int pressed = _pressIndex;
        _pressed = false;
        _dragging = false;
        _pressIndex = -1;
        Pressed = -1;

        int idx = IndexAt(e.X, e.Y);
        if (dragged) OnDragEnded();
        else if (idx >= 0 && idx == pressed) OnItemClicked(idx);

        Hover = idx;
        Recompose();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (_pressed) return;          // 拖动时鼠标出了窗口不算离开
        if (Hover != -1) { Hover = -1; Recompose(); }
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        // 换屏/改缩放：画布按新 DPI 重算，窗口尺寸跟着变（老的 region 方案也踩过这条）。
        W = 0;
        Rebuild();
    }

    // ------------------------------------------------------------------ 绘制原语

    /// <summary>把一种颜色按覆盖度盖到缓冲上（直通 alpha 的 SrcOver）。</summary>
    protected void Blend(int x, int y, float cover, Color c)
    {
        if (cover <= 0f) return;
        if ((uint)x >= (uint)W || (uint)y >= (uint)H) return;
        if (cover > 1f) cover = 1f;

        float sa = (c.A / 255f) * cover;
        if (sa <= 0f) return;

        int i = y * W + x;
        int dst = Buf[i];
        float da = ((dst >> 24) & 0xFF) / 255f;
        float oa = sa + da * (1f - sa);
        if (oa <= 0f) { Buf[i] = 0; return; }
        float k = da * (1f - sa);

        int r = (int)((c.R * sa + ((dst >> 16) & 0xFF) * k) / oa + 0.5f);
        int g = (int)((c.G * sa + ((dst >> 8) & 0xFF) * k) / oa + 0.5f);
        int b = (int)((c.B * sa + (dst & 0xFF) * k) / oa + 0.5f);
        int a = (int)(oa * 255f + 0.5f);
        Buf[i] = (Clamp255(a) << 24) | (Clamp255(r) << 16) | (Clamp255(g) << 8) | Clamp255(b);
    }

    private static int Clamp255(int v) => v < 0 ? 0 : (v > 255 ? 255 : v);

    protected void FillCircle(float cx, float cy, float r, Color c)
    {
        int x0 = Math.Max(0, (int)Math.Floor(cx - r - 1)), x1 = Math.Min(W - 1, (int)Math.Ceiling(cx + r + 1));
        int y0 = Math.Max(0, (int)Math.Floor(cy - r - 1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(cy + r + 1));
        for (int y = y0; y <= y1; y++)
            for (int x = x0; x <= x1; x++)
            {
                float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
                float d = MathF.Sqrt(dx * dx + dy * dy);
                Blend(x, y, Math.Clamp(r + 0.5f - d, 0f, 1f), c);
            }
    }

    /// <summary>竖向渐变的实心圆（玻璃上半亮、下半沉，就是靠这一层）。</summary>
    protected void FillCircleGradient(float cx, float cy, float r, Color top, Color bottom)
    {
        int x0 = Math.Max(0, (int)Math.Floor(cx - r - 1)), x1 = Math.Min(W - 1, (int)Math.Ceiling(cx + r + 1));
        int y0 = Math.Max(0, (int)Math.Floor(cy - r - 1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(cy + r + 1));
        float span = Math.Max(1f, r * 2f);
        for (int y = y0; y <= y1; y++)
        {
            float t = Math.Clamp((y + 0.5f - (cy - r)) / span, 0f, 1f);
            Color c = Lerp(top, bottom, t);
            for (int x = x0; x <= x1; x++)
            {
                float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
                float d = MathF.Sqrt(dx * dx + dy * dy);
                Blend(x, y, Math.Clamp(r + 0.5f - d, 0f, 1f), c);
            }
        }
    }

    protected static Color Lerp(Color a, Color b, float t)
        => Color.FromArgb(
            (int)(a.A + (b.A - a.A) * t + 0.5f),
            (int)(a.R + (b.R - a.R) * t + 0.5f),
            (int)(a.G + (b.G - a.G) * t + 0.5f),
            (int)(a.B + (b.B - a.B) * t + 0.5f));

    /// <summary>圆环描边（1px 级别的玻璃边缘）。</summary>
    protected void StrokeCircle(float cx, float cy, float r, float width, Color c)
    {
        float half = width / 2f;
        int x0 = Math.Max(0, (int)Math.Floor(cx - r - half - 1)), x1 = Math.Min(W - 1, (int)Math.Ceiling(cx + r + half + 1));
        int y0 = Math.Max(0, (int)Math.Floor(cy - r - half - 1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(cy + r + half + 1));
        for (int y = y0; y <= y1; y++)
            for (int x = x0; x <= x1; x++)
            {
                float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
                float d = MathF.Sqrt(dx * dx + dy * dy);
                float cov = Math.Clamp(half + 0.5f - Math.Abs(d - r), 0f, 1f);
                Blend(x, y, cov, c);
            }
    }

    /// <summary>圆角矩形（胶囊就是 radius = 高度/2）。用有向距离场算抗锯齿，边缘干净。</summary>
    protected void FillRoundRect(float x, float y, float w, float h, float radius, Color c)
    {
        float rad = Math.Min(radius, Math.Min(w, h) / 2f);
        int x0 = Math.Max(0, (int)Math.Floor(x - 1)), x1 = Math.Min(W - 1, (int)Math.Ceiling(x + w + 1));
        int y0 = Math.Max(0, (int)Math.Floor(y - 1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(y + h + 1));
        float cx = x + w / 2f, cy = y + h / 2f;
        float hx = w / 2f - rad, hy = h / 2f - rad;
        for (int py = y0; py <= y1; py++)
            for (int px = x0; px <= x1; px++)
            {
                float qx = Math.Abs(px + 0.5f - cx) - hx;
                float qy = Math.Abs(py + 0.5f - cy) - hy;
                float ax = MathF.Max(qx, 0f), ay = MathF.Max(qy, 0f);
                float outside = MathF.Sqrt(ax * ax + ay * ay);
                float inside = MathF.Min(MathF.Max(qx, qy), 0f);
                float d = outside + inside - rad;
                Blend(px, py, Math.Clamp(0.5f - d, 0f, 1f), c);
            }
    }

    /// <summary>圆的柔和投影：遮罩 → 两趟盒式模糊 → 当黑色半透明盖上去。</summary>
    protected void ShadowCircle(float cx, float cy, float r, float blur, float dy, float alpha)
    {
        if (alpha <= 0f) return;
        int pad = (int)Math.Ceiling(blur * 2f) + 2;
        int x0 = Math.Max(0, (int)Math.Floor(cx - r) - pad), x1 = Math.Min(W - 1, (int)Math.Ceiling(cx + r) + pad);
        int y0 = Math.Max(0, (int)Math.Floor(cy + dy - r) - pad), y1 = Math.Min(H - 1, (int)Math.Ceiling(cy + dy + r) + pad);
        int bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        if (bw <= 2 || bh <= 2) return;

        var m = new float[bw * bh];
        for (int y = 0; y < bh; y++)
            for (int x = 0; x < bw; x++)
            {
                float dx = x0 + x + 0.5f - cx, dyy = y0 + y + 0.5f - (cy + dy);
                float d = MathF.Sqrt(dx * dx + dyy * dyy);
                m[y * bw + x] = Math.Clamp(r + 0.5f - d, 0f, 1f);
            }

        var tmp = new float[bw * bh];
        int rad = Math.Max(1, (int)Math.Round(blur * 0.5f));
        for (int pass = 0; pass < 2; pass++)
        {
            BoxBlurH(m, tmp, bw, bh, rad);
            BoxBlurV(tmp, m, bw, bh, rad);
        }

        var col = Color.FromArgb(Clamp255((int)(alpha * 255f + 0.5f)), 0, 0, 0);
        for (int y = 0; y < bh; y++)
            for (int x = 0; x < bw; x++)
            {
                float a = m[y * bw + x];
                if (a > 0.002f) Blend(x0 + x, y0 + y, a, col);
            }
    }

    /// <summary>圆角矩形的描边（胶囊的一圈发丝内沿就是它）。</summary>
    protected void StrokeRoundRect(float x, float y, float w, float h, float radius, float width, Color c)
    {
        float rad = Math.Min(radius, Math.Min(w, h) / 2f);
        float half = width / 2f;
        int x0 = Math.Max(0, (int)Math.Floor(x - 1)), x1 = Math.Min(W - 1, (int)Math.Ceiling(x + w + 1));
        int y0 = Math.Max(0, (int)Math.Floor(y - 1)), y1 = Math.Min(H - 1, (int)Math.Ceiling(y + h + 1));
        float cx = x + w / 2f, cy = y + h / 2f;
        float hx = w / 2f - rad, hy = h / 2f - rad;
        for (int py = y0; py <= y1; py++)
            for (int px = x0; px <= x1; px++)
            {
                float qx = Math.Abs(px + 0.5f - cx) - hx;
                float qy = Math.Abs(py + 0.5f - cy) - hy;
                float ax = MathF.Max(qx, 0f), ay = MathF.Max(qy, 0f);
                float d = MathF.Sqrt(ax * ax + ay * ay) + MathF.Min(MathF.Max(qx, qy), 0f) - rad;
                Blend(px, py, Math.Clamp(half + 0.5f - Math.Abs(d), 0f, 1f), c);
            }
    }

    /// <summary>圆角矩形的柔和投影（胶囊"悬空"的暗影）。</summary>
    protected void ShadowRoundRect(float x, float y, float w, float h, float radius, float blur, float dy, float alpha)
    {
        if (alpha <= 0f) return;
        int pad = (int)Math.Ceiling(blur * 2f) + 2;
        int x0 = Math.Max(0, (int)Math.Floor(x) - pad), x1 = Math.Min(W - 1, (int)Math.Ceiling(x + w) + pad);
        int y0 = Math.Max(0, (int)Math.Floor(y + dy) - pad), y1 = Math.Min(H - 1, (int)Math.Ceiling(y + h + dy) + pad);
        int bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        if (bw <= 2 || bh <= 2) return;

        float rad = Math.Min(radius, Math.Min(w, h) / 2f);
        float ccx = x + w / 2f, ccy = y + dy + h / 2f;
        float hx = w / 2f - rad, hy = h / 2f - rad;

        var m = new float[bw * bh];
        for (int py = 0; py < bh; py++)
            for (int px = 0; px < bw; px++)
            {
                float qx = Math.Abs(x0 + px + 0.5f - ccx) - hx;
                float qy = Math.Abs(y0 + py + 0.5f - ccy) - hy;
                float ax = MathF.Max(qx, 0f), ay = MathF.Max(qy, 0f);
                float d = MathF.Sqrt(ax * ax + ay * ay) + MathF.Min(MathF.Max(qx, qy), 0f) - rad;
                m[py * bw + px] = Math.Clamp(0.5f - d, 0f, 1f);
            }

        var tmp = new float[bw * bh];
        int br = Math.Max(1, (int)Math.Round(blur * 0.5f));
        for (int pass = 0; pass < 2; pass++)
        {
            BoxBlurH(m, tmp, bw, bh, br);
            BoxBlurV(tmp, m, bw, bh, br);
        }

        var col = Color.FromArgb(Clamp255((int)(alpha * 255f + 0.5f)), 0, 0, 0);
        for (int py = 0; py < bh; py++)
            for (int px = 0; px < bw; px++)
            {
                float a = m[py * bw + px];
                if (a > 0.002f) Blend(x0 + px, y0 + py, a, col);
            }
    }

    private static void BoxBlurH(float[] src, float[] dst, int w, int h, int r)
    {
        float norm = 1f / (r * 2 + 1);
        for (int y = 0; y < h; y++)
        {
            int row = y * w;
            float sum = 0f;
            for (int i = -r; i <= r; i++) sum += src[row + Math.Clamp(i, 0, w - 1)];
            for (int x = 0; x < w; x++)
            {
                dst[row + x] = sum * norm;
                sum -= src[row + Math.Clamp(x - r, 0, w - 1)];
                sum += src[row + Math.Clamp(x + r + 1, 0, w - 1)];
            }
        }
    }

    private static void BoxBlurV(float[] src, float[] dst, int w, int h, int r)
    {
        float norm = 1f / (r * 2 + 1);
        for (int x = 0; x < w; x++)
        {
            float sum = 0f;
            for (int i = -r; i <= r; i++) sum += src[Math.Clamp(i, 0, h - 1) * w + x];
            for (int y = 0; y < h; y++)
            {
                dst[y * w + x] = sum * norm;
                sum -= src[Math.Clamp(y - r, 0, h - 1) * w + x];
                sum += src[Math.Clamp(y + r + 1, 0, h - 1) * w + x];
            }
        }
    }

    private static StringFormat _centered;

    protected static StringFormat Centered
    {
        get
        {
            if (_centered == null)
            {
                _centered = new StringFormat(StringFormat.GenericTypographic)
                {
                    Alignment = StringAlignment.Center,
                    LineAlignment = StringAlignment.Center,
                    FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip,
                };
            }
            return _centered;
        }
    }

    /// <summary>
    /// 画一段文字。★ 只取 GDI+ 输出的 **alpha 通道**当覆盖度，颜色自己上（见文件头说明）。
    /// </summary>
    protected void DrawText(string text, Font font, RectangleF box, Color color)
    {
        if (string.IsNullOrEmpty(text) || font == null) return;
        using var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            // ★ 必须 AntiAlias，不能 ClearType：ClearType 把覆盖度写进 rgb、alpha 全 255，
            //   那样"按 alpha 取覆盖度"就失效（字会整块不透明地拍上去）。
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.DrawString(text, font, Brushes.White, box, Centered);
        }

        BitmapData data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            var raw = new byte[stride * H];
            Marshal.Copy(data.Scan0, raw, 0, raw.Length);
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    byte a = raw[y * stride + x * 4 + 3];
                    if (a != 0) Blend(x, y, a / 255f, color);
                }
        }
        finally { bmp.UnlockBits(data); }
    }

    // ------------------------------------------------------------------ 推给系统

    private void EnsureSurface()
    {
        if (_memDc != IntPtr.Zero && _dibW == W && _dibH == H) return;
        ReleaseSurface();

        IntPtr screenDc = GetDC(IntPtr.Zero);
        try { _memDc = CreateCompatibleDC(screenDc); }
        finally { ReleaseDC(IntPtr.Zero, screenDc); }

        var bmi = new BITMAPINFO
        {
            bmiHeader = new BITMAPINFOHEADER
            {
                biSize = Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = W,
                biHeight = -H,          // 负高度 = 自上而下，省得每帧倒着拷
                biPlanes = 1,
                biBitCount = 32,
                biCompression = 0,      // BI_RGB
            },
        };
        _dib = CreateDIBSection(_memDc, ref bmi, 0 /* DIB_RGB_COLORS */, out _dibBits, IntPtr.Zero, 0);
        if (_dib == IntPtr.Zero || _dibBits == IntPtr.Zero)
        {
            Dbg.Critical("LayeredLayer: CreateDIBSection 失败 err=" + Marshal.GetLastWin32Error());
            return;
        }
        _oldBmp = SelectObject(_memDc, _dib);
        _dibW = W;
        _dibH = H;
    }

    protected void Present()
    {
        if (!IsHandleCreated || Buf == null || W <= 0 || H <= 0) return;
        EnsureSurface();
        if (_dibBits == IntPtr.Zero) return;

        int n = W * H;
        if (_bgra == null || _bgra.Length != n * 4) _bgra = new byte[n * 4];

        // 直通 ARGB → 预乘 BGRA（UpdateLayeredWindow 的 AC_SRC_ALPHA 要求预乘）。
        for (int i = 0; i < n; i++)
        {
            int c = Buf[i];
            int a = (c >> 24) & 0xFF;
            int o = i * 4;
            if (a == 0)
            {
                _bgra[o] = 0; _bgra[o + 1] = 0; _bgra[o + 2] = 0; _bgra[o + 3] = 0;
                continue;
            }
            _bgra[o]     = (byte)(((c & 0xFF) * a + 127) / 255);
            _bgra[o + 1] = (byte)((((c >> 8) & 0xFF) * a + 127) / 255);
            _bgra[o + 2] = (byte)((((c >> 16) & 0xFF) * a + 127) / 255);
            _bgra[o + 3] = (byte)a;
        }
        Marshal.Copy(_bgra, 0, _dibBits, _bgra.Length);

        IntPtr screenDc = GetDC(IntPtr.Zero);
        try
        {
            var size = new SIZE { cx = W, cy = H };
            var src = new POINT { x = 0, y = 0 };
            var dst = new POINT { x = Bounds.X, y = Bounds.Y };
            var blend = new BLENDFUNCTION
            {
                BlendOp = AC_SRC_OVER,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = AC_SRC_ALPHA,
            };
            if (!UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, _memDc, ref src, 0, ref blend, ULW_ALPHA))
            {
                // 只在第一次报，别把日志刷爆（拖动时每帧都会走这里）。
                if (!_ulwFailed)
                {
                    _ulwFailed = true;
                    Dbg.Critical("LayeredLayer: UpdateLayeredWindow 失败 err=" + Marshal.GetLastWin32Error());
                }
            }
        }
        finally { ReleaseDC(IntPtr.Zero, screenDc); }
    }

    private bool _ulwFailed;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (W <= 0) { Rebuild(); return; }
        Present();
    }

    protected override void OnPaintBackground(PaintEventArgs e) { /* layer 位图说了算 */ }
    protected override void OnPaint(PaintEventArgs e) { /* 同上 */ }

    /// <summary>显示时不抢焦点（它只是贴在桌面/窗口边上的一层装饰）。</summary>
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x00080000;   // WS_EX_LAYERED：UpdateLayeredWindow 的前提
            cp.ExStyle |= 0x00000080;   // WS_EX_TOOLWINDOW：不进任务栏 / Alt+Tab
            cp.ExStyle |= 0x08000000;   // WS_EX_NOACTIVATE：点它不抢主窗口焦点
            return cp;
        }
    }

    private void ReleaseSurface()
    {
        if (_memDc != IntPtr.Zero)
        {
            if (_oldBmp != IntPtr.Zero) { try { SelectObject(_memDc, _oldBmp); } catch { } }
            if (_dib != IntPtr.Zero) { try { DeleteObject(_dib); } catch { } }
            try { DeleteDC(_memDc); } catch { }
        }
        _memDc = IntPtr.Zero;
        _dib = IntPtr.Zero;
        _dibBits = IntPtr.Zero;
        _oldBmp = IntPtr.Zero;
        _dibW = _dibH = 0;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) ReleaseSurface();
        base.Dispose(disposing);
    }

    // ------------------------------------------------------------------ Win32

    private const int ULW_ALPHA = 0x00000002;
    private const byte AC_SRC_OVER = 0x00;
    private const byte AC_SRC_ALPHA = 0x01;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx, cy; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public int bmiColors;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage,
                                                  out IntPtr bits, IntPtr hSection, uint offset);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst,
                                                   ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc,
                                                   int crKey, ref BLENDFUNCTION pblend, int dwFlags);
}
