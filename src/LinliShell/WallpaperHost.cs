// 把「桌面壁纸层」铺成**真正的 Windows 桌面壁纸**。
// ★ 口径更正（2026-10-15）：原版管这层叫 `Wallpaper_Presence`（壁纸），没有"舞台"这个说法。
//
// ★ 原版游戏那个"桌面"就是这么做的：它不是一个占满屏幕的窗口，而是把自己挂到
//   桌面的那一层（WorkerW）上 —— 桌面图标、任务栏、别的窗口全都还在它上面。
//   我们不复刻它的素材，只学这层结构：一层循环播放的视频当壁纸 + 两个悬浮圆钮。
//
// ★ WorkerW 这套是 Windows 上做动态壁纸的通行做法，三步：
//   1. 给 Progman 发一个未公开的消息 0x052C，让它把 WorkerW 拆出来；
//   2. 枚举窗口，找出**孩子里有 SHELLDLL_DefView 的那个**（那就是图标层），
//      它后面那个 WorkerW 就是"图标底下、壁纸那一层"；
//   3. 把我们的窗口 SetParent 过去。
//   哪一步没成都不硬来：找不到就不铺，用户桌面一点都不会被弄乱。
//
// ★ 页面背景是**透明**的（DefaultBackgroundColor = Transparent）：
//   曲库里没有曲子时页面什么都不画，透出来的是用户原来那张壁纸 —— 不是一块黑。
//
// ★ 退出时窗口被销毁，桌面自然回到原样，不需要"恢复原壁纸"这类收尾。

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LinliLetters;

internal sealed class WallpaperHost : Form
{
    private WebView2 _web;
    private readonly string _url;

    /// <summary>页面上的圆钮点了之后要开主窗口的哪一页（"music" / "mail"）。</summary>
    public event EventHandler<string> OpenPageRequested;

    public WallpaperHost(string url)
    {
        _url = url;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;

        Rectangle v = SystemInformation.VirtualScreen;
        Bounds = new Rectangle(0, 0, v.Width, v.Height);

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);

        _web.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            if (msg.StartsWith("open:", StringComparison.Ordinal))
                OpenPageRequested?.Invoke(this, msg.Substring("open:".Length));
            else if (msg == "state:off")
                // 页面说"没有曲子可播"。这时候留在桌面上就是一块黑 —— 撤掉，
                // 用户原来的壁纸原样露出来，比挂着一个空窗口好解释。
                BeginInvoke(new Action(Close));
        };

        Load += async (_, _) =>
        {
            try
            {
                // ★ 和主窗口分开的用户数据目录：两个 WebView2 共用一个目录会互相锁。
                string dir = System.IO.Path.Combine(App.DataDir, "webview2-wallpaper");
                System.IO.Directory.CreateDirectory(dir);
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: dir);
                await _web.EnsureCoreWebView2Async(env);

                // 透明底：没曲子的时候透出用户原来的壁纸，而不是一块黑。
                _web.DefaultBackgroundColor = Color.Transparent;
                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.Navigate(_url);
            }
            catch
            {
                // 内核起不来就当没有壁纸这回事，什么都不做。
                // 桌面上不该出现任何异常提示 —— 那比没有壁纸更难解释。
                BeginInvoke(new Action(Close));
            }
        };
    }

    // ★ 别抢焦点：壁纸是被看的，不是被点的（圆钮除外）。
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000;   // WS_EX_NOACTIVATE
            return cp;
        }
    }

    // ---------------------------------------------------------------- WorkerW

    private const uint SMTO_NORMAL = 0x0000;
    private static readonly IntPtr INTPTR_ZERO = IntPtr.Zero;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter,
                                              string lpszClass, string lpszWindow);

    /// <summary>取窗口类名。找 Progman 用（FindWindow 在这台机器上返回 0，见 AttachToDesktop）。</summary>
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam,
                                                    IntPtr lParam, uint fuFlags, uint uTimeout,
                                                    out IntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
                                            int x, int y, int cx, int cy, uint uFlags);

    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_NOZORDER = 0x0004;

    /// <summary>把窗口挂到桌面那一层。成功返回 true。</summary>
    private bool AttachToDesktop()
    {
        try
        {
            // ★ 必须用 EnumWindows 自己找 Progman，**不能用 FindWindow("Progman", null)**。
            //   2026-10-18 真机实测：这台机器上 FindWindow("Progman", null)、
            //   FindWindow("Progman", "")、以及 CharSet=Unicode/Ansi 两种编组**全部返回 0**，
            //   而同一时刻 EnumWindows 能扫到 `Progman h=66014 pid=15004`（孩子里有 DefView）。
            //   后果不是"找不到就算了"——AttachToDesktop 第一行就 return false ⇒ StartWallpaper
            //   把窗口 Dispose 掉 ⇒ 桌面壁纸从来没铺上过，而日志里一点错都没有。
            IntPtr progman = IntPtr.Zero;
            EnumWindows((hwnd, _) =>
            {
                var cls = new System.Text.StringBuilder(64);
                GetClassName(hwnd, cls, cls.Capacity);
                if (cls.ToString() == "Progman") { progman = hwnd; return false; }
                return true;
            }, IntPtr.Zero);
            if (progman == IntPtr.Zero) return false;

            // 让 Progman 把 WorkerW 拆出来（0x052C 是未公开消息，动态壁纸的通行做法）
            SendMessageTimeout(progman, 0x052C, INTPTR_ZERO, INTPTR_ZERO,
                               SMTO_NORMAL, 1000, out _);

            // ★ 桌面那一层有两种形态，机器不同不一样，两条路都要走：
            //   甲（教科书那条）：0x052C 之后 DefView 被搬进一个**顶层** WorkerW，
            //      要挂的是排在它后面的另一个顶层 WorkerW；
            //   乙（这台机器实测）：0x052C 什么都没拆出来，DefView 和一个 WorkerW
            //      **同为 Progman 的孩子**，图标层在前、那个 WorkerW 在后 ——
            //      要挂的就是排在 DefView 后面的这个。
            //   只写甲的话，在乙这种机器上 FindWindowEx 直接返回 0 ⇒ 铺不上，
            //   而代码看上去一点错都没有（这也是这次真机跑一遍才抓到的）。
            IntPtr defView = IntPtr.Zero;
            IntPtr defHost = IntPtr.Zero;
            EnumWindows((hwnd, _) =>
            {
                IntPtr d = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (d != IntPtr.Zero) { defView = d; defHost = hwnd; }
                return true;
            }, IntPtr.Zero);

            if (defView == IntPtr.Zero) return false;

            IntPtr worker = IntPtr.Zero;
            if (defHost != IntPtr.Zero && defHost != progman)
                worker = FindWindowEx(IntPtr.Zero, defHost, "WorkerW", null);   // 甲

            if (worker == IntPtr.Zero)
            {
                IntPtr parent = GetParent(defView);                            // 乙
                if (parent != IntPtr.Zero)
                    worker = FindWindowEx(parent, defView, "WorkerW", null);     // ★ 排在 DefView 之后 = 在图标底下
            }

            if (worker == IntPtr.Zero) return false;

            // ★ 2026-10-16 修（审核条目 10）：原来不判 SetParent 的返回值。
            //   它失败时返回 Zero（且置上 Win32 错误码），那时候后面那句 SetWindowPos 照跑，
            //   于是"没挂上去"被当成"挂上了" —— 壁纸层变成一个**浮在桌面上的普通窗口**：
            //   盖住图标、抢焦点，而上层以为一切正常（Attach() 返回 true）。
            //   ⇒ 挂不上就老实说挂不上，让调用方退回"不铺壁纸"。
            if (SetParent(Handle, worker) == IntPtr.Zero && Marshal.GetLastWin32Error() != 0)
                return false;

            Rectangle v = SystemInformation.VirtualScreen;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, v.Width, v.Height,
                         SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
            // ★ 同理：铺完再确认一次，父窗口真的是刚才那个 WorkerW。
            if (GetParent(Handle) != worker) return false;
            return true;
        }
        catch { return false; }
    }

    /// <summary>建好窗口但先不显示，等挂上桌面那一层再显示。</summary>
    public bool Attach()
    {
        IntPtr handle = Handle;        // 逼出窗体句柄
        if (handle == IntPtr.Zero) return false;
        return AttachToDesktop();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web?.Dispose();
        base.Dispose(disposing);
    }
}
