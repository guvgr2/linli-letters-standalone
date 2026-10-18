// 「OliviaSoul-community独立版」的主窗口。
//
// ★ 为什么要有这个文件：以前界面是外壳用 Edge 的 `--app=` 打开的。那种窗口
//   - 任务栏上写的是 Edge，图标取的是网页 favicon（没有就是 Edge 的地球）；
//   - 不能真正收进托盘，关掉就是关掉；
//   - 用户看到的"没有程序"、以及被报了两次的"还是默认图标"，根子都在这。
//   现在是**我们自己的窗口**：无边框、自绘，图标和标题都是这个程序自己的。
//
// ★ 用 WebView2 而不是自己画界面：界面靠 backdrop-filter 做玻璃质感，
//   只有浏览器引擎能渲染。WebView2 用的是系统里已经装好的运行时（本机 154/155 都在），
//   不必再往包里塞一个几十 MB 的内核。
//
// ★ 无边框窗口的三件事必须自己做，Windows 不会再替你做：拖动、最小化、关闭。
//   做法是页面用 window.chrome.webview.postMessage 发一句话过来，这边照做。

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LinliLetters;

internal sealed class MainWindow : Form
{
    private WebView2 _web;

    /// <summary>现在是不是我们自己设的「放大」状态。
    /// ★ 为什么不用 WindowState：ToggleMaximize 走的是自己设 Bounds（见那段踩坑记录），
    ///   WindowState 一直是 Normal，靠它判断会以为永远没放大过。</summary>
    private bool _maximized;
    /// <summary>放大之前那一刻的位置与大小，用来还原。默认值只在启动时未取到 Bounds 才会用到。</summary>
    private Rectangle _restoreBounds;

    /// <summary>用户点了右上角那个「—」：收进托盘，程序不退出。</summary>
    public event EventHandler RequestHide;
    /// <summary>用户点了右上角那个「×」：默认也只收进托盘（陪伴类程序的习惯）。</summary>
    public event EventHandler RequestClose;
    /// <summary>用户明确要退出（托盘菜单或页面里的「退出」）。</summary>
    public event EventHandler RequestQuit;
    /// <summary>设置页的「桌面壁纸」开关：true = 铺到桌面，false = 撤掉。</summary>
    public event EventHandler<bool> WallpaperRequested;

    public MainWindow(string url, Icon icon)
    {
        Text = App.Title;
        Icon = icon ?? SystemIcons.Application;

        // ★ 无边框。边框一留，玻璃界面外面就多一圈 Windows 的灰边，"程序感"没了。
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        // ★ 2026-10-18（用户：「把桌面或者在这个程序后面的界面当背景就好了」）：
        //   窗口开启 DWM 亚克力（DwmSetWindowAttribute 33 / DWMWA_SYSTEMBACKDROP_TYPE
        //   = DWMSBT_TRANSIENTWINDOW），系统把窗口正后方的桌面实时模糊后垫在窗口底下
        //   —— 这就是 Windows 11 原生「液态玻璃」的材质。页面那边再把 body 底色
        //   去掉、WebView2 设透明，backdrop-filter 模糊的就是这层真实桌面。
        //   兜底链：Acrylic 失败 → Mica(2) → 失败 → 纯色底（现在的样子）。
        //   ★ Win11 22H2+ 才有系统级 backdrop；再老就自己兜住，不崩。
        BackColor = Color.FromArgb(14, 13, 17);   // 兜底底色（亚克力失败时也不闪白）

        // 按屏幕大小收敛：别在小屏上开出一个放不下的窗口。
        // ★ 2026-10-18 改到第 5 轮，前四轮全错，错因各不相同，全记在这里：
        //   ① 原始代码写死 `Math.Min(1180,…)`/`Math.Min(820,…)` ⇒ 屏幕再大也只有 1180×820。
        //   ② 改按 `WorkingArea - 120` ⇒ 实测 1138×679。
        //   ③ 改按 `WorkingArea × 0.88` 并乘 DPI 系数 ⇒ 实测 1001×584。
        //   ④ 去掉系数、直接拿 0.88×0.86 算 ⇒ 实测 1502×876。
        //   ★★ ①②③ 的共同错误前提是"坐标可能是逻辑像素，得乘除 DPI 系数"。
        //      真相：本机物理屏 2560×1600 @150%，而 `Screen.WorkingArea` 与窗口 `Bounds`
        //      报的都是**物理像素**（日志 `bounds={X=153,Y=107,Width=2253,Height=1314}`
        //      与 GetWindowRect 量到的 1502×876 之间正好差 1.5 倍 —— 差的是**页面 CSS px**
        //      与**窗口物理 px**，不是两套 Win32 坐标）。所以任何 k 都是自找。
        //   ⑤ 现在：物理像素直接算，不乘任何系数。
        //      比例 0.88×0.86 ⇒ 2560×0.88=2253、1528×0.86=1314，四周留一圈看得到桌面。
        //      上下限夹在 900×640 到 2300×1400：小屏不挤，大屏也不至于和最大化没区别。
        //      ★ 上限 2300 是**物理像素**：150% 缩放下它折合 1533 CSS px，正好高过原版的
        //        窄屏断点 1150，所以信箱仍是两栏、曲库仍是原版那一套列表。
        Rectangle area = Screen.FromPoint(Cursor.Position)?.WorkingArea
                        ?? Screen.PrimaryScreen?.WorkingArea
                        ?? new Rectangle(0, 0, 1280, 800);
        int w = Math.Clamp((int)Math.Round(area.Width * 0.88), 900, 2300);
        int h = Math.Clamp((int)Math.Round(area.Height * 0.86), 640, 1400);
        int left = area.Left + (area.Width - w) / 2;
        int top = area.Top + (area.Height - h) / 2;
        Bounds = new Rectangle(left, top, w, h);

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);

        _web.CoreWebView2InitializationCompleted += (_, _) => { /* 拿到了内核再导航 */ };
        _web.WebMessageReceived += OnWebMessage;
        // ★ 2026-10-18：页面右上角「放大」按钮点了没反应，查下来两边代码都对，
        //   只能靠日志定位断在哪一环。这一行只在设了 LINLI_DEBUG_MSG 时才写，
        //   平常不产生任何文件（用户机器上不留日志垃圾）。
        //   用法：set LINLI_DEBUG_MSG=1 再启动，然后点一次按钮，
        //   看 %TEMP%\linli-msg.log 里有没有 "recv: max"。有 ⇒ 外壳收到了；
        //   没有 ⇒ 断在 WebView2 通道（页面那边 postMessage 没发出去）。
        if (Environment.GetEnvironmentVariable("LINLI_DEBUG_MSG") == "1")
        {
            _web.WebMessageReceived += (_, e) =>
            {
                try
                {
                    string raw = e?.TryGetWebMessageAsString() ?? "(null)";
                    File.AppendAllText(Path.Combine(Path.GetTempPath(), "linli-msg.log"),
                        DateTime.Now.ToString("HH:mm:ss.fff") + " recv: " + raw + Environment.NewLine);
                }
                catch (Exception ex)
                {
                    try
                    {
                        File.AppendAllText(Path.Combine(Path.GetTempPath(), "linli-msg.log"),
                            DateTime.Now.ToString("HH:mm:ss.fff") + " recv-ERR: " + ex.GetType().Name + ": " + ex.Message + Environment.NewLine);
                    }
                    catch { /* 连日志都写不了就算了 */ }
                }
            };
        }

        Load += async (_, _) =>
        {
            // ★ 液态玻璃三件套之三：窗口一建好就开 backdrop（不等 WebView2）。
            //   开早了页面还没铺底色，正好让用户第一眼就看到玻璃后面是真的桌面。
            EnableBackdrop();
            try
            {
                // ★ 用户数据目录必须显式给一个本机的固定位置。
                //   不给的话 WebView2 会在 exe 旁边建目录 —— 装在 Program Files 下会写不进去，
                //   而且卸载时会漏下一堆东西。放在数据目录里，跟信件一个待遇。
                string dataDir = Path.Combine(App.DataDir, "webview2");
                Directory.CreateDirectory(dataDir);
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDir);
                await _web.EnsureCoreWebView2Async(env);

                // ★ 液态玻璃三件套之二：WebView2 页面底色透明。
                //   DWM 亚克力负责把桌面模糊后垫在窗口底下；这里不透明的话，
                //   网页自己的近黑底色会把那层桌面整个盖住，亚克力就白开了。
                _web.DefaultBackgroundColor = Color.Transparent;

                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;  // 别弹出浏览器的右键菜单
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.NavigationCompleted += (_, _) => FlushPage();
                _web.CoreWebView2.NewWindowRequested += (_, e) =>
                {
                    // 页面要开外链：交给系统默认浏览器，别在我们这个窗口里开。
                    e.Handled = true;
                    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
                    catch { /* 开不了就算了 */ }
                };

                _web.CoreWebView2.Navigate(url);
            }
            catch (Exception ex)
            {
                // 内核起不来 ⇒ 退回系统浏览器。功能一样，只是没有独立窗口。
                FallbackToBrowser(url, ex);
            }
        };
    }

    /// <summary>
    /// 让页面切到某一页（桌面壁纸上的圆钮点了之后走这条路）。
    /// ★ 页面可能还在加载 —— 那时候消息发出去没人接。先存着，等导航完成再补一次，
    ///   否则"点圆钮没反应"会变成只在窗口还没开出来时才复现的怪毛病。
    /// </summary>
    public void Go(string page)
    {
        if (string.IsNullOrEmpty(page)) return;
        _pendingPage = page;
        FlushPage();
    }

    private string _pendingPage;

    private void FlushPage()
    {
        if (_pendingPage == null) return;
        // ★ 2026-10-16 修（审核条目 10）：原来写成
        //     `_web.CoreWebView2?.PostWebMessageAsString(...)`，然后无条件 `_pendingPage = null`。
        //   内核还没就绪时 `?.` 什么都不做（也不抛），可下面那句照样把待发页面清掉了
        //   ⇒ **页面永久丢失**：窗口刚开那一下点的圆钮永远不响应，而且只在那一瞬间复现。
        //   ⇒ 送不出去就别清，等 NavigationCompleted 再补发一次。
        var core = _web.CoreWebView2;
        if (core == null) return;
        try
        {
            core.PostWebMessageAsString("go:" + _pendingPage);
            _pendingPage = null;          // 只有真送出去了才算发过
        }
        catch { /* 内核还没就绪，等 NavigationCompleted 再送一次 */ }
    }

    private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); } catch { return; }
        switch (msg)
        {
            case "drag":    StartDrag(); break;
            case "min":     RequestHide?.Invoke(this, EventArgs.Empty); break;
            case "max":     ToggleMaximize(); break;
            case "close":   RequestClose?.Invoke(this, EventArgs.Empty); break;
            case "quit":    RequestQuit?.Invoke(this, EventArgs.Empty); break;
            // 设置页那个「桌面壁纸」开关：页里不播视频了，开关交给外壳去铺/撤桌面那一层。
            case "wallpaper:on":  WallpaperRequested?.Invoke(this, true); break;
            case "wallpaper:off": WallpaperRequested?.Invoke(this, false); break;
            default:
                // "open:<url>" —— 设置页「去官网下载字体」那一处要用系统浏览器打开。
                if (msg.StartsWith("open:", StringComparison.Ordinal))
                    OpenExternal(msg.Substring("open:".Length));
                break;
        }
    }

    /// <summary>
    /// 页面要求用系统浏览器打开一个网址。
    /// ★ 必须走白名单。这条通道等于"页面能指挥外壳去打开任意网址"—— 页面是本机
    ///   服务吐出来的、理论上可信，但一旦页面被注入点什么，不加白名单就等于把
    ///   ShellExecute 交出去了。目前只允许字体官网那两个域名（唯一用到的地方）。
    /// ★ 同时限死 https：挡掉 file: / javascript: / 自定义协议那些。
    /// </summary>
    private static readonly string[] AllowedExternalHosts =
    {
        "sentyfont.com", "www.sentyfont.com",
        "hanyi.com.cn",  "www.hanyi.com.cn",
    };

    private void OpenExternal(string url)
    {
        Uri uri;
        if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttps) return;
        bool allowed = false;
        foreach (string host in AllowedExternalHosts)
            if (string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase)) { allowed = true; break; }
        if (!allowed) return;
        try
        {
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch { /* 起不来就算了 —— 页面上把网址明文写着，用户能自己复制 */ }
    }

    /// <summary>
    /// 开启系统级「窗后模糊」：Win11 22H2+ 走 DWMWA_SYSTEMBACKDROP_TYPE(33)=Acrylic(3)，
    /// 失败退 Mica(2)，再失败退 undocumented SetWindowCompositionAttribute AccentState
    /// ACCENT_ENABLE_ACRYLICBLURBEHIND(4)（Win10 也能吃）。三段全失败就保持纯色 ——
    /// 界面降级成现在的样子，不会更差。
    /// ★ backdrop 生效的前提：窗口延伸进客户区（WS_EX_NOREDIRECTIONBITMAP 不用；
    ///   DWM 对普通窗口也吃 SYSTEMBACKDROP），且页面背景透明（Load 里已设）。
    /// </summary>
    private void EnableBackdrop()
    {
        // ---- 第 1 段：DWMWA_SYSTEMBACKDROP_TYPE（Win11 22H2+）----
        // 逐个试：Acrylic(3) 是真正的"窗后模糊玻璃"，Mica(2) 只是取壁纸主色。
        foreach (uint backdrop in new uint[] { 3, 2 })
        {
            uint v = backdrop;
            int hr = DwmSetWindowAttribute(Handle, 33, ref v, sizeof(uint));
            if (hr == 0) return;   // 挂上了
        }

        // ---- 第 2 段： undocumented composition attribute（Win10 / 早期 Win11）----
        try
        {
            var accent = new AccentPolicy
            {
                AccentState = 4,   // ACCENT_ENABLE_ACRYLICBLURBEHIND
                // GradientColor AABBGGRR：alpha 0xCC ≈ 80% —— 留 20% 透桌面。
                AccentFlags = 2,
                GradientColor = 0xCC000000,
            };
            IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AccentPolicy)));
            try
            {
                Marshal.StructureToPtr(accent, ptr, false);
                var data = new WindowCompositionAttribData
                {
                    Attribute = 19,   // WCA_ACCENT_POLICY
                    SizeOfData = Marshal.SizeOf(typeof(AccentPolicy)),
                    Data = ptr,
                };
                SetWindowCompositionAttribute(Handle, ref data);
            }
            finally { Marshal.FreeHGlobal(ptr); }
        }
        catch { /* 全失败就纯色，不崩 */ }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public uint AccentState;
        public uint AccentFlags;
        public uint GradientColor;
        public uint AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttribData
    {
        public uint Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [DllImport("user32.dll")]
    private static extern bool SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttribData data);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, uint attr, ref uint value, int size);

    /// <summary>无边框窗口要自己实现拖动：骗 Windows 一下，说"按在了标题栏上"。</summary>
    private void StartDrag()
    {
        const int WM_NCLBUTTONDOWN = 0xA1;
        const int HTCAPTION = 0x2;
        ReleaseCapture();
        SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    }

    /// <summary>
    /// 放大 / 还原。
    /// ★ 2026-10-18 补：页面右上角原来只有「收进托盘」和「退出」，没有放大按钮 ——
    ///   无边框窗口（FormBorderStyle.None）连系统那个都不给，用户就没法把窗口放大了。
    /// ★ MaximizedBounds 按当前屏幕的工作区（Screen.WorkingArea）而不是整屏：
    ///   不设的话最大化会盖住任务栏，用户找不回底下的东西。
    /// </summary>
    private void ToggleMaximize()
    {
        bool dbg = Environment.GetEnvironmentVariable("LINLI_DEBUG_MSG") == "1";
        if (dbg) LogMsg("ToggleMaximize 进入: state=" + WindowState + " bounds=" + Bounds);

        if (_maximized)
        {
            Bounds = _restoreBounds;
            _maximized = false;
        }
        else
        {
            // ★★ 2026-10-18 定稿（前两版都错，记在这里免得再走回头路）：
            //   第 1 版 `MaximizedBounds = Screen.FromControl(this).WorkingArea;` ——
            //     用户实测"最大化后窗口被左移到最左上角、右下留一大片空桌面"。
            //     本机物理屏 2560×1600 @150%，那条路径下窗口落在 1707×1019，
            //     正好是 2560/1.5 与 1528/1.5 —— 也就是说 WorkingArea 与窗口坐标系
            //     在那一版里不是一个单位，拿逻辑尺寸去限制物理窗口，必然只占左上角。
            //   第 2 版 `MaximizedBounds = Rectangle.Empty; WindowState = Maximized;`
            //     又在 WndProc 里用 WM_GETMINMAXINFO 把底边收回工作区 —— 加了调试输出
            //     证明消息收到了（日志 `工作区 2560x1528 偏移 0,0`），但量 GetWindowRect
            //     结果**仍然是 1707×1019**：交给系统算的话，它按自己那套（受 .NET 单文件
            //     宿主与 DPI 感知时机影响）又推回去了，我们设的值被覆盖。
            //   现在这版不再问系统：自己量当前显示器的工作区、自己设 Bounds，
            //   WindowState 恒为 Normal。少一层"谁在替我算"，就少一处对不上的地方。
            //   ★ 用 MonitorFromWindow 而不是 Screen.FromControl：窗口拖到第二块屏上
            //     再点放大，要铺满**它所在那块**屏，而不是主屏。
            _restoreBounds = Bounds;
            Rectangle work = WorkingAreaOf(Handle);
            if (dbg) LogMsg("ToggleMaximize 目标工作区: " + work);
            Bounds = work;
            _maximized = true;
        }

        if (dbg) LogMsg("ToggleMaximize 退出: maximized=" + _maximized + " bounds=" + Bounds);
    }

    /// <summary>当前窗口所在显示器的工作区（物理像素，与窗口坐标系一致；已扣掉任务栏）。</summary>
    private static Rectangle WorkingAreaOf(IntPtr hwnd)
    {
        const uint MONITOR_DEFAULTTONEAREST = 0x00000002;
        IntPtr mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (mon != IntPtr.Zero && GetMonitorInfo(mon, ref info))
        {
            RECT w = info.rcWork;
            return Rectangle.FromLTRB(w.Left, w.Top, w.Right, w.Bottom);
        }
        // 拿不到显示器信息时退回 WinForms 的说法 —— 宁可尺寸不对，也不要不动。
        return Screen.FromHandle(hwnd).WorkingArea;
    }

    /// <summary>诊断日志：只在 LINLI_DEBUG_MSG=1 时写 %TEMP%\linli-msg.log。</summary>
    private static void LogMsg(string text)
    {
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "linli-msg.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + text + Environment.NewLine);
        }
        catch { /* 写不了就算了，不能因为日志把功能弄挂 */ }
    }

    private void FallbackToBrowser(string url, Exception ex)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
            RequestHide?.Invoke(this, EventArgs.Empty);
            MessageBox.Show(
                "内置的浏览内核没起来，先用系统浏览器打开了界面。\n" +
                "功能一样，只是没有独立窗口。\n\n（" + ex.Message + "）",
                App.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch { /* 连浏览器也起不来 —— 托盘还在，用户可以从那里拿地址 */ }
    }

    // ------------------------------------------------------------------ Win32

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    private const int WM_GETMINMAXINFO = 0x0024;
    private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    /// <summary>最大化时把窗口收回工作区（不盖任务栏）。
    /// ★ 为什么要自己接这一条（2026-10-18）：
    ///   无边框窗口（FormBorderStyle.None）没有系统标题栏，最大化时 Windows 给的默认
    ///   最大化矩形是**整个屏幕**，任务栏会被压在底下 —— 用户找不回来。
    ///   常规做法是设 MaximizedBounds，但那是逻辑像素、而这个窗口在物理像素坐标系里
    ///   （见 ToggleMaximize 里那段踩坑记录），所以改成在 WM_GETMINMAXINFO 里
    ///   直接告诉系统「最大就到这块工作区为止」，单位跟系统一致，不用换算。
    /// ★ 每次最大化都会问一次，所以这里**按当前所在显示器**现算 —— 换屏、改分辨率、
    ///   任务栏换边都不用重启程序。
    /// ★ 2026-10-18：这条**留着有用**，但已经不再是 ToggleMaximize 的主要手段 ——
    ///   ToggleMaximize 现在自己设 Bounds（日志证明这里设的值会被系统那趟算法推回去，
    ///   实测仍是 1707×1019）。留着是因为用户还可能用别的路子把窗口最大化
    ///   （自动化脚本发 SC_MAXIMIZE、将来接回系统标题栏），届时仍要挡住任务栏。
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_GETMINMAXINFO)
        {
            Rectangle work = WorkingAreaOf(Handle);
            Rectangle mon = MonitorBoundsOf(Handle);
            MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
            // 坐标是相对所在显示器的：左/上取工作区偏移，宽高取工作区尺寸。
            mmi.ptMaxPosition.X = work.Left - mon.Left;
            mmi.ptMaxPosition.Y = work.Top - mon.Top;
            mmi.ptMaxSize.X = work.Width;
            mmi.ptMaxSize.Y = work.Height;
            Marshal.StructureToPtr(mmi, m.LParam, false);
            if (Environment.GetEnvironmentVariable("LINLI_DEBUG_MSG") == "1")
            {
                LogMsg("WM_GETMINMAXINFO: 工作区 " + work.Width + "x" + work.Height
                    + " 偏移 " + mmi.ptMaxPosition.X + "," + mmi.ptMaxPosition.Y);
            }
        }
        base.WndProc(ref m);
    }

    /// <summary>当前窗口所在显示器的整块矩形（物理像素）。拿不到时退回工作区。</summary>
    private static Rectangle MonitorBoundsOf(IntPtr hwnd)
    {
        IntPtr mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (mon != IntPtr.Zero && GetMonitorInfo(mon, ref info))
        {
            RECT r = info.rcMonitor;
            return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        }
        return WorkingAreaOf(hwnd);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web?.Dispose();
        base.Dispose(disposing);
    }
}
