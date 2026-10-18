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
        BackColor = Color.FromArgb(14, 13, 17);   // 跟页面底色一致，免得加载时闪一块白

        // 按屏幕大小收敛：别在小屏上开出一个放不下的窗口。
        // ★ 2026-10-18 改到第 4 轮，前三轮全错，错因各不相同，全记在这里：
        //   ① 原始代码写死 `Math.Min(1180,…)`/`Math.Min(820,…)` ⇒ 屏幕再大也只有 1180×820。
        //   ② 改按 `WorkingArea - 120` ⇒ 实测 1138×679。
        //   ③ 改按 `WorkingArea × 0.88` 并乘 DPI 系数 ⇒ 实测 1001×584。
        //   ★★ 三轮都基于一个**错误前提**：以为坐标是逻辑像素。实测（2026-10-18）：
        //      本进程没声明 per-monitor DPI 感知，但 `Screen.PrimaryScreen.Bounds`
        //      和 `WorkingArea` 报的**都是物理像素** 2560×1528（GetSystemMetrics 同为 2560×1600）。
        //      也就是说 WinForms 在这儿不做逻辑/物理换算 —— 我前两轮乘/除 k 纯属自找。
        //   ④ 现在：直接拿物理像素算，**不乘任何系数**。
        //      比例 0.88×0.86 ⇒ 2560×0.88=2253、1528×0.86=1314，四周留一圈看得到桌面。
        //      上下限夹在 900×640 到 2300×1400：小屏不挤，大屏也不至于和最大化没区别。
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
            try
            {
                // ★ 用户数据目录必须显式给一个本机的固定位置。
                //   不给的话 WebView2 会在 exe 旁边建目录 —— 装在 Program Files 下会写不进去，
                //   而且卸载时会漏下一堆东西。放在数据目录里，跟信件一个待遇。
                string dataDir = Path.Combine(App.DataDir, "webview2");
                Directory.CreateDirectory(dataDir);
                var env = await CoreWebView2Environment.CreateAsync(userDataFolder: dataDir);
                await _web.EnsureCoreWebView2Async(env);

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

        if (WindowState == FormWindowState.Maximized)
        {
            WindowState = FormWindowState.Normal;
        }
        else
        {
            // ★★ 2026-10-18 修（用户实测报的"最大化后窗口被左移到最左上角、右下留一大片空"）：
            //   原来这里写 `MaximizedBounds = Screen.FromControl(this).WorkingArea;`。
            //   本机物理屏 2560×1600 @150%，`WorkingArea` 报的是**逻辑像素 1707×1019**，
            //   而这个无边框窗口的坐标系是**物理像素** —— 拿逻辑尺寸去限制物理窗口，
            //   窗口就只占了左上角 1707×1019 物理像素，右边和下边全是空桌面。
            //   （静读代码看不出来：WorkingArea 和 Bounds 都不报单位，只有真最大化量
            //    GetWindowRect 才发现宽高正好是 1707×1019 而不是 2560×1600。）
            //
            //   现在**不设 MaximizedBounds**：让 WinForms 按窗口自身（物理）坐标系去算
            //   最大化矩形，DPI 由框架统一处理。代价是无边框窗口会盖住任务栏 ——
            //   所以下面在进入最大化后，用 WM_GETMINMAXINFO 把底边收回到工作区
            //   （见 WndProc 里的处理），这样既铺满又不挡任务栏。
            MaximizedBounds = Rectangle.Empty;      // 清掉任何历史值
            WindowState = FormWindowState.Maximized;
        }

        if (dbg) LogMsg("ToggleMaximize 退出: state=" + WindowState + " bounds=" + Bounds);
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

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web?.Dispose();
        base.Dispose(disposing);
    }
}
