// 桌面上的两个悬浮圆钮（音乐 / 信箱）。
//
// ★ 为什么它是**独立顶层窗口**（2026-10-19 用户：「桌面的这俩小圆钮点不动」）：
//   壁纸层（WallpaperHost）是 SetParent 到 WorkerW 的，排在桌面图标层
//   （SHELLDLL_DefView）**后面** —— 图标层吃掉鼠标事件，那层里的按钮画得出来、点不动。
//   这里改成独立窗口：它天然在图标之上，所以能点；再用 HWND_BOTTOM 沉到所有窗口底下，
//   有窗口盖住桌面时它自然被挡住，不会浮在别人界面上。
//
// ★★ 2026-10-20 重做（用户：「这按钮一点都不还原，甚至是黑的，还移动不了，按钮尺寸还不对」）：
//   上一版是 **WebView2 画 dock.html**，再用 SetWindowRgn 把窗口裁成两个椭圆。
//   本机的 WebView2 在这个窗口里反复崩（shell.log 里那一簇
//   `UtilityProcessExited / GpuProcessExited / RenderProcessExited` 之后就是
//   `关掉沙箱仍崩溃 ⇒ 撤掉圆钮`），窗口留着、页面没了 ⇒ 用户看到两个**黑饼**：
//   没图标、没文字、点不动（拖动是页面发 `drag` 消息叫外壳做的，页面死了自然拖不动）。
//   ⇒ 现在**不用任何浏览器内核、不用 region**：纯 GDI+ 画玻璃圆（见 LayeredLayer.cs），
//     图标与中文标签由 `DrawText` 直接画，拖动由基类的鼠标捕获做。
//     这条路径没有任何外部依赖，也就没有"内核起不来"这一档故障。
//
// ★ 布局照原版（2026-10-20 用户给的两张原版截图）：
//   **音乐在左上、信箱在右下**，两心相对位移约 (+1.1d, +1.2d)（d = 直径）。
//   这里 d = 62dip ⇒ 位移 (70, 77)dip。改这两个圆心必须一起看 `tests/dock-geometry.test.js`。

using System;
using System.Drawing;
using System.Windows.Forms;

namespace LinliLetters;

internal sealed class DesktopDock : LayeredLayer
{
    // ---- 画布与两个圆的几何（DIP，96dpi 基准；运行时乘 DPI 系数）------------------
    // ★ 2026-10-20 第二轮（用户：「桌面的按钮就是尺寸和原版不一样」，附了原版对照图）：
    //   直径 62 → 72 DIP，图标/文字跟着放大。原版那两颗比我们这版明显更大一圈，
    //   而且「图标 : 圆」与「文字 : 圆」的比例和我们原来是一致的 —— 所以整颗等比放大就对了。
    //   两心位移继续守 1.1d / 1.2d（原版那两颗是错开摆的）：72 × 1.1 = 79、72 × 1.2 = 86。
    private const int DockW = 204, DockH = 210;
    private const int Radius = 36;
    private const int MusicCx = 62, MusicCy = 60;
    private const int MailCx = 141, MailCy = 146;

    /// <summary>圆钮的直径（DIP）—— 测试用，也是"两心位移 = 1.1d/1.2d"里那个 d。</summary>
    private const int Diameter = Radius * 2;

    /// <summary>点了哪个圆钮（"library" / "mail"）。</summary>
    public event EventHandler<string> OpenPageRequested;

    private string _posFile;
    private bool _restored;

    public DesktopDock() : base(DockW, DockH)
    {
        // ★ 位置不在这里定：句柄还没建，DeviceDpi 还读不到真实缩放，
        //   按 96dpi 算出来的宽高在 150% 的屏上会小一圈 ⇒ 摆到右下角会露出一截在屏幕外。
        //   真正的定位放在 OnHandleCreated（那时 Rebuild 已经按真实 DPI 算好 W/H）。
        _posFile = System.IO.Path.Combine(App.DataDir, "dock-pos.txt");
        Shown += (_, _) => SinkToBottom();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        // 基类在这里 Rebuild（按真实 DPI 算画布、画第一帧）。
        base.OnHandleCreated(e);
        if (!_placed)
        {
            _placed = true;
            // 拖过位置的老用户优先；没有记录（或大半在屏外）就落回右下角默认位。
            RestorePosition();
            _restored = true;
            Present();           // 位置变了，layer 按新坐标重推一次
        }
        SinkToBottom();
    }

    private bool _placed;

    // ------------------------------------------------------------------ 外观

    protected override void Compose()
    {
        // 两颗钮的"数据"：圆心、图标字、中文标签、点开的页面。
        var items = new (float Cx, float Cy, string Icon, string Label)[]
        {
            (D(MusicCx), D(MusicCy), "♪", "音乐"),
            (D(MailCx), D(MailCy), "✉", "信箱"),
        };

        for (int i = 0; i < items.Length; i++)
        {
            var it = items[i];
            float r = D(Radius);
            bool hot = Hover == i;
            bool down = Pressed == i;

            // ① 落影：一层贴地的柔和暗影，是"悬空"观感的主要来源。
            ShadowCircle(it.Cx, it.Cy, r, D(11), D(5), hot ? 0.50f : 0.42f);

            // ② 玻璃本体：上半亮、下半沉（原版那两颗是半透明玻璃，不是实心圆）。
            int topA = down ? 40 : (hot ? 74 : 58);
            int botA = down ? 12 : (hot ? 32 : 20);
            FillCircleGradient(it.Cx, it.Cy, r,
                Color.FromArgb(topA, 255, 255, 255),
                Color.FromArgb(botA, 255, 255, 255));

            // ③ 边缘：一圈比内部更亮的描边（玻璃厚边），再压一条极淡的外沿暗边定形。
            StrokeCircle(it.Cx, it.Cy, r - D(0.6f), D(1.1f),
                Color.FromArgb(down ? 70 : (hot ? 132 : 96), 255, 255, 255));
            StrokeCircle(it.Cx, it.Cy, r + D(0.5f), D(1.2f), Color.FromArgb(26, 0, 0, 0));

            // ④ 图标 + 中文标签。原版就是"上面一个图形、下面两个字"。
            using (var fi = new Font("Segoe UI Symbol", D(21), FontStyle.Regular, GraphicsUnit.Pixel))
            using (var fl = new Font("Microsoft YaHei UI", D(12), FontStyle.Regular, GraphicsUnit.Pixel))
            {
                DrawText(it.Icon, fi,
                    new RectangleF(it.Cx - D(26), it.Cy - D(28), D(52), D(36)),
                    Color.FromArgb(242, 255, 255, 255));
                DrawText(it.Label, fl,
                    new RectangleF(it.Cx - D(32), it.Cy + D(8), D(64), D(16)),
                    Color.FromArgb(230, 255, 255, 255));
            }
        }
    }

    /// <summary>命中：以圆心 + 半径（含 4dip 容差）判，超出两个圆的地方一律当空白（点击穿透）。</summary>
    protected override int IndexAt(int x, int y)
    {
        float r = D(Radius + 4);
        float[] cxs = { D(MusicCx), D(MailCx) };
        float[] cys = { D(MusicCy), D(MailCy) };
        for (int i = 0; i < cxs.Length; i++)
        {
            float dx = x - cxs[i], dy = y - cys[i];
            if (dx * dx + dy * dy <= r * r) return i;
        }
        return -1;
    }

    protected override void OnItemClicked(int index)
    {
        // 0 = 音乐 → 曲库页（页面 id 叫 library）；1 = 信箱。
        string page = index == 0 ? "library" : "mail";
        Dbg.Log("DesktopDock: 点了 " + page);
        OpenPageRequested?.Invoke(this, page);
    }

    /// <summary>拖完了才落盘（拖动过程中会连续改 Location，别一次拖拽写几百次文件）。</summary>
    protected override void OnDragEnded()
    {
        SavePosition();
        SinkToBottom();          // 拖到别处之后重新沉底，别飘在别的窗口上面
        Dbg.Log($"DesktopDock: 拖到 {Location.X},{Location.Y}");
    }

    // ------------------------------------------------------------------ 位置

    /// <summary>
    /// 2026-10-20（设置页「显示屏幕」）：把两个圆钮搬到目标屏的右下角。
    /// ★ 拖过位置的老用户：dock-pos.txt 优先，这里的定位只在新铺/换屏时用；
    ///   找不到目标屏（屏被拔了）就原地不动。
    /// </summary>
    public void MoveToScreen(Screen s)
    {
        if (s == null) return;
        try
        {
            Rectangle work = s.WorkingArea;
            Bounds = new Rectangle(work.Right - W - 24, work.Bottom - H - 12, W, H);
            Present();           // layer 的目标坐标变了，重推一次
            Dbg.Log("DesktopDock: 已搬到 " + s.DeviceName);
        }
        catch (Exception ex)
        {
            Dbg.Log("DesktopDock: 搬屏失败 " + Dbg.Ex(ex));
        }
    }

    /// <summary>上次拖到的位置；没有记录 / 读不懂 / 大半在屏外 ⇒ 落回右下角默认位。</summary>
    private void RestorePosition()
    {
        if (!TryRestorePosition()) PlaceDefault();
    }

    private void PlaceDefault()
    {
        Rectangle work = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Bounds = new Rectangle(work.Right - W - 24, work.Bottom - H - 12, W, H);
        Dbg.Critical($"DesktopDock: 落到默认位 {Bounds.X},{Bounds.Y} ({W}×{H})");
    }

    private bool TryRestorePosition()
    {
        try
        {
            if (string.IsNullOrEmpty(_posFile) || !System.IO.File.Exists(_posFile)) return false;
            string[] parts = System.IO.File.ReadAllText(_posFile).Trim().Split(',');
            if (parts.Length != 2
                || !int.TryParse(parts[0], out int x)
                || !int.TryParse(parts[1], out int y)) return false;

            // ★ 判"还在屏上"用**面积过半**，不是"点是否落在某块屏"：
            //   老记录里有过把整块窗口拖到屏幕边缘外面的情形，只判点会让它半截看不见。
            var saved = new Rectangle(x, y, W, H);
            foreach (Screen sc in Screen.AllScreens)
            {
                Rectangle hit = Rectangle.Intersect(saved, sc.WorkingArea);
                if (hit.Width >= W / 2 && hit.Height >= H / 2)
                {
                    Location = new Point(x, y);
                    Dbg.Critical($"DesktopDock: 恢复位置 {x},{y}");
                    return true;
                }
            }
            Dbg.Critical($"DesktopDock: 记录里的位置 {x},{y} 大半在屏外 ⇒ 回到默认位");
            return false;
        }
        catch { return false; }
    }

    private void SavePosition()
    {
        if (!_restored) return;      // 还没读完就写回去 = 把用户的老位置冲掉
        try
        {
            if (string.IsNullOrEmpty(_posFile)) return;
            System.IO.File.WriteAllText(_posFile, Location.X + "," + Location.Y);
        }
        catch { /* 写不进去就算了，位置只是顺手记一下 */ }
    }

    /// <summary>沉到所有窗口底下（但仍在桌面图标之上）。</summary>
    public void SinkToBottom()
    {
        try
        {
            SetWindowPos(Handle, HWND_BOTTOM, 0, 0, 0, 0,
                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        catch { /* 沉不下去就算了，顶多是它盖住别人一点 */ }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) SavePosition();
        base.Dispose(disposing);
    }

    private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
                                            int x, int y, int cx, int cy, uint uFlags);
}
