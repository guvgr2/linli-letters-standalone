// 挂在主窗口**左沿外面**的导航浮层（2026-10-20 用户口径）。
//
// ★★ 用户原话（两句，都是硬要求）：
//   ① 「这个按钮不在程序界面里，在程序外面，我还特意给你圈出来」；
//   ② 「独立浮层必须做，你照抄原版游戏的浮层逻辑不就完了」。
//   ⇒ 它**不是**页面里的一条左栏，而是和桌面圆钮同一套做法的**独立顶层窗口**
//     （见 LayeredLayer.cs：layered window + 逐像素 alpha + 纯 GDI+ 自绘）。
//     贴着主窗口左沿、垂直居中、压在桌面上、跟着主窗口走。
//
// ★ 为什么原版也是这样（拆 `resources/feapp.dat` 的结论，2026-10-20）：
//   `feapp.dat` 是个 ZIP，里面 75 个 Vue 组件里**没有任何 nav / rail / side 组件**，
//   JS 里连"信箱""音乐"这些中文都没有（那些只是 i18n 页面文案）。也就是说导航胶囊
//   根本不是网页画的，是 Qt 外壳画的一层独立浮层 —— 它才会"挂在窗口左沿外面"。
//
// ★ 观感照原版：近黑不透明胶囊（#121214）+ 当前页米色实心圆（--p2 = #D8CFC4）
//   + 其余只有浅灰图标、没有底。带柔和落影（"悬空"的来源）。
//
// ★ 跟随：`Owner = 主窗口` ⇒ 主窗口最小化/隐藏时它自动消失、永远压在主窗口之上；
//   位置由 LocationChanged / SizeChanged 自己算（不靠 Windows 的父子裁剪）。

using System;
using System.Drawing;
using System.Windows.Forms;

namespace LinliLetters;

internal sealed class NavRail : LayeredLayer
{
    // ---- 几何（DIP）--------------------------------------------------------------
    // 画布 = 胶囊 + 四周留给落影的余量（ShadowPad）。
    private const int ShadowPad = 16;
    private const int Pad = 8;          // 胶囊内边距
    private const int Item = 46;        // 圆钮直径（与页面时代 .rb 一样，观感不跳）
    private const int Gap = 7;

    private const int PillW = Item + Pad * 2;                        // 62
    private const int PillH = Item * 3 + Gap * 2 + Pad * 2;          // 168
    private const int RailW = PillW + ShadowPad * 2;                  // 94
    private const int RailH = PillH + ShadowPad * 2;                  // 200

    /// <summary>
    /// 胶囊离主窗口左沿的空隙（DIP）。★ 2026-10-20 用户口径：「那个浮窗太靠近主窗口了，再往左移一点」
    /// —— 原来只往外让 4dip（几乎贴着窗口边），现在整颗退到窗口外面 22dip：
    /// 落在桌面上、与窗口之间留一道看得见的缝，才是原版那种「挂在外面的东西」。
    /// ⚠️ 别再改回小值：`tests/dock-geometry.test.js` ⑦ 守在 16dip 以上。
    /// </summary>
    private const int OutsideGap = 22;

    /// <summary>三颗钮：页面 id + 图标字 + 字体族 + 字号（DIP）。</summary>
    private static readonly (string Page, string Glyph, string Family, float Size)[] Items =
    {
        ("mail",    "✉", "Segoe UI Symbol",   17f),
        ("library", "♪", "Segoe UI Symbol",   18f),
        ("memory",  "记", "Microsoft YaHei UI", 14f),
    };

    private string _active = "mail";

    /// <summary>用户点了某一颗（页面 id）。</summary>
    public event EventHandler<string> PageRequested;

    private Form _owner;

    public NavRail() : base(RailW, RailH) { }

    /// <summary>贴到主窗口上。重复调用无副作用（会把旧的挂钩摘掉）。</summary>
    public void AttachTo(Form owner)
    {
        if (owner == null || owner.IsDisposed) return;
        if (ReferenceEquals(_owner, owner)) { Reposition(); return; }

        Detach();
        _owner = owner;
        try { Owner = owner; } catch (Exception ex) { Dbg.Log("NavRail: 设 Owner 失败 " + Dbg.Ex(ex)); }

        owner.LocationChanged += OnOwnerMoved;
        owner.SizeChanged += OnOwnerMoved;
        owner.VisibleChanged += OnOwnerVisible;
        Reposition();
    }

    private void Detach()
    {
        if (_owner != null && !_owner.IsDisposed)
        {
            try
            {
                _owner.LocationChanged -= OnOwnerMoved;
                _owner.SizeChanged -= OnOwnerMoved;
                _owner.VisibleChanged -= OnOwnerVisible;
            }
            catch { /* 窗口已经没了 */ }
        }
        _owner = null;
    }

    private void OnOwnerMoved(object sender, EventArgs e) => Reposition();

    private void OnOwnerVisible(object sender, EventArgs e)
    {
        if (_owner == null) return;
        if (_owner.Visible && !Visible) Show();
        else if (!_owner.Visible && Visible) Hide();
    }

    /// <summary>当前页（外壳收到页面的 `page:` 消息后调这里）。</summary>
    public void SetActive(string page)
    {
        if (string.IsNullOrEmpty(page) || page == _active) return;
        // 设置页/其它页在导轨上没有对应钮 ⇒ 保留上一次的选中态会误导，全部置灰更诚实。
        _active = page;
        Recompose();
    }

    // ------------------------------------------------------------------ 位置

    /// <summary>
    /// 贴到主窗口左沿外侧、垂直居中。
    /// ★ 左侧放不下时（窗口贴着屏幕左沿 / 最大化）改成**压在窗口内沿**：宁可让出 10dip，
    ///   也不能让胶囊跑到屏幕外面去 —— 那等于导航消失。
    /// </summary>
    public void Reposition()
    {
        if (_owner == null || _owner.IsDisposed) return;
        try
        {
            Rectangle b = _owner.Bounds;
            int pillW = (int)Math.Round(D(PillW));
            int pad = (int)Math.Round(D(ShadowPad));
            int gap = (int)Math.Round(D(OutsideGap));

            int pillLeft = b.Left - pillW - gap;
            Rectangle wa = Screen.FromRectangle(b).WorkingArea;
            bool inside = false;
            if (pillLeft < wa.Left + 2)
            {
                // 外面放不下 ⇒ 收到窗口内侧
                pillLeft = b.Left + (int)Math.Round(D(10));
                inside = true;
            }

            int x = pillLeft - pad;
            int y = b.Top + (b.Height - Py) / 2;
            Bounds = new Rectangle(x, y, Px, Py);
            Present();           // 目标坐标变了，layer 按新位置重推

            if (!_reportedInside || inside != _reportedInside)
            {
                _reportedInside = inside;
                Dbg.Critical($"NavRail: 贴靠 {(_owner.Visible ? "" : "(窗口藏着)")} {(inside ? "窗口内侧" : "窗口外侧")} @ {x},{y}");
            }
        }
        catch (Exception ex)
        {
            Dbg.Log("NavRail: 定位失败 " + Dbg.Ex(ex));
        }
    }

    private bool _reportedInside;

    // ------------------------------------------------------------------ 外观

    protected override void Compose()
    {
        float pad = D(ShadowPad);
        float pillW = D(PillW), pillH = D(PillH);
        float pillX = pad, pillY = pad;
        float radius = pillW / 2f;

        // ① 落影（胶囊悬空）。
        ShadowRoundRect(pillX, pillY, pillW, pillH, radius, D(10), D(6), 0.52f);

        // ② 胶囊本体：近黑不透明（#121214，取自原版截图实测色）。
        FillRoundRect(pillX, pillY, pillW, pillH, radius, Color.FromArgb(255, 0x12, 0x12, 0x14));
        // ③ 一圈极淡的内描边：没有它，黑胶囊在暗色桌面上没有轮廓。
        StrokeRoundRect(pillX, pillY, pillW, pillH, radius, D(1), Color.FromArgb(18, 255, 255, 255));

        float itemR = D(Item) / 2f;
        float cx = pillX + pillW / 2f;

        for (int i = 0; i < Items.Length; i++)
        {
            var it = Items[i];
            float cy = pillY + D(Pad) + itemR + i * (D(Item) + D(Gap));
            bool on = string.Equals(it.Page, _active, StringComparison.Ordinal);
            bool hot = Hover == i;
            bool down = Pressed == i;

            if (on)
            {
                // 当前页：米色实心圆 + 深色图标（原版就是这一颗，胶囊里没有别的指示）。
                FillCircle(cx, cy, itemR, Color.FromArgb(255, 0xD8, 0xCF, 0xC4));
                if (down) FillCircle(cx, cy, itemR, Color.FromArgb(28, 0, 0, 0));
            }
            else if (hot || down)
            {
                FillCircle(cx, cy, itemR, Color.FromArgb(down ? 24 : 23, 255, 255, 255));
            }

            Color ink = on
                ? Color.FromArgb(255, 0x17, 0x18, 0x1C)
                : (hot ? Color.FromArgb(255, 0xF4, 0xF4, 0xF5) : Color.FromArgb(148, 255, 255, 255));

            using var f = new Font(it.Family, D(it.Size), FontStyle.Regular, GraphicsUnit.Pixel);
            DrawText(it.Glyph, f, new RectangleF(cx - itemR, cy - itemR, itemR * 2, itemR * 2), ink);
        }
    }

    protected override int IndexAt(int x, int y)
    {
        float itemR = D(Item) / 2f;
        float cx = D(ShadowPad) + D(PillW) / 2f;
        for (int i = 0; i < Items.Length; i++)
        {
            float cy = D(ShadowPad) + D(Pad) + itemR + i * (D(Item) + D(Gap));
            float dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= itemR * itemR) return i;
        }
        return -1;
    }

    /// <summary>导航固定贴在窗口边上，不许拖（拖走了就对不上窗口了）。</summary>
    protected override bool AllowDrag => false;

    protected override void OnItemClicked(int index)
    {
        if (index < 0 || index >= Items.Length) return;
        PageRequested?.Invoke(this, Items[index].Page);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Detach();
        base.Dispose(disposing);
    }
}
