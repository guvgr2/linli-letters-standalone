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

    /// <summary>页面地址。内核掉线后要按同一个地址重建，所以留着。
    /// ★ 用户报过「有很大概率卡黑屏」：WebView2 的渲染进程一挂，控件就停在最后一帧上，
    ///   不 reload 就是永久黑屏 —— 必须能自己爬起来。</summary>
    private string _pageUrl;
    private Icon _icon;

    /// <summary>死路说明已经画上去了（ProcessFailed 会连着来好几次，别叠一堆 Label）。</summary>
    private bool _deadScreen;
    /// <summary>已经排了一次延迟重建，同簇里其余的事件不再排队。</summary>
    private bool _rebuildQueued;

    /// <summary>
    /// 重建预算（滑动窗口）。
    /// ★ 原来是 <c>private int _rebuilds;</c> 只增不减 ⇒ 程序跑够久，内核零散崩够三次，
    ///   主窗口就永久停在死路。现在：窗口期内累计 + 冷却 + 页面一成功导航就清零。
    /// ★ 自检模式不设冷却：那条链要在几十毫秒内把三档推到底，冷却只会把它拖成超时。
    /// </summary>
    private readonly RebuildBudget _budget = new(
        WebRecovery.MaxRebuilds,
        TimeSpan.FromMinutes(10),
        TimeSpan.FromMilliseconds(WebRecovery.IsSelfCheckRun() ? 0 : WebTriage.CoolDownMs));

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
    /// <summary>页面换了"现在桌面该放哪首"（曲库里点了播放 / 回到待机）⇒ 让桌面那层立刻重算。</summary>
    public event EventHandler StageChanged;
    /// <summary>设置页改了音量/环境音开关。桌面那层只需重设 volume，不要掐断声音。</summary>
    public event EventHandler StageVolumeChanged;
    /// <summary>播放条上的静音键。声音在桌面那层出，所以静音也发到那边。</summary>
    public event EventHandler<bool> StageMuteRequested;

    /// <summary>曲库底部播放条点进度条跳转（秒；**自研**，原版没有）。
    /// ★ 2026-10-20：播放键定为「回待机」语义（用户明确），走 stage:changed 既有链路，
    ///   不做画面冻结式暂停 ⇒ 没有 toggle 事件。</summary>
    public event EventHandler<double> SeekRequested;

    public MainWindow(string url, Icon icon)
    {
        Text = App.Title;
        Icon = icon ?? SystemIcons.Application;

        // ★ 无边框。边框一留，玻璃界面外面就多一圈 Windows 的灰边，"程序感"没了。
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        // ★★ 2026-10-19 定稿（用户第四轮反馈：「背景只透过壁纸视频试试，就是不透过
        //   后面程序的界面」+「我圈的地方的黑边还是没修好」）：
        //   前几轮为了让"真实桌面"透进窗口，开了 DWM 亚克力 + DwmExtendFrameIntoClientArea(-1)
        //   + 页面透明。代价有三个，全被用户一眼看见：
        //     ① 窗口背后**任何**程序都会透进来（用户的照片查看器、浏览器、桌面图标都进来了）
        //        ——「背景太乱」；
        //     ② 页面透明后，WebView2 把透明像素合成成窗口 BackColor（0x0E0D11），
        //        客户区边缘就是一圈实心黑 ——「黑边」；
        //     ③ 亚克力那层 30% 黑 tint 又把整扇窗压灰、字压沉 ——「字体看不清」。
        //   ⇒ 现在窗口**不透明**：底色就是页面自己的 --bg（#121214），壁纸视频由
        //     页面在窗口**内部**画（app.js 的 #stage，native 下重模糊压暗当背景）。
        //     背后是别的程序还是桌面都进不来，玻璃透的只能是这层视频。
        //   ★ 因此这里不再调 EnableBackdrop()/DwmExtendFrameIntoClientArea ——
        //     透明窗口一关，它们既没用又只剩副作用。
        BackColor = Color.FromArgb(18, 18, 20);   // = styles.css 的 --bg，闪白也不会闪

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

        _pageUrl = url;
        _icon = icon;

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);
        WireWeb(_web);

        // ★ 2026-10-19：原来这里给页面送「窗口背后的桌面帧」（DesktopCapture.cs），
        //   页面拿它当液态玻璃的折射源。窗口改成不透明 + 背景就是壁纸视频之后，
        //   那帧桌面图既不该出现（会把别的程序画进窗口）也没人该用 ⇒ 整条链路删掉。
        //   页面侧的 GlassPanel 因此拿不到纹理，退回纯 CSS 玻璃（样式在 styles.css 里）。
        // ★ 2026-10-20（用户口径「不应该是启动动画结束后进入程序吗」）：启动动画没收完
        //   之前窗口可能一直藏着（不 Show）——而 Load 只在显示时触发，内核就永远起不来。
        //   ⇒ 起内核改走 BootWeb()（幂等）：显示路径由 Load 叫，藏着的路径由 Program 叫。
        //   重建路径（OnProcessFailed）仍直接调 InitWebAsync，不受这个闸门影响。
        Load += (_, _) => BootWeb();
    }

    private bool _webBooted;

    /// <summary>起内核（只认第一次）。窗口藏着时 Load 不会触发，由 Program.OpenWindow 显式叫起。</summary>
    public void BootWeb()
    {
        if (_webBooted) return;
        _webBooted = true;
        // ★★ 2026-10-20（本轮 shell-recovery 抓到的真回归）：启动时序改成「动画放完再显形」
        //   之后，窗口在建它的时候**不 Show**，于是它的窗口句柄可能还没建出来。而
        //   InitWebAsync 的失败分支要用 `BeginInvoke(...)` 把「第二档重建」接下去 ——
        //   没有句柄时它会抛
        //     InvalidOperationException: Invoke or BeginInvoke cannot be called on a control
        //     until the window handle has been created
        //   这个异常落在 `_ = InitWebAsync()` 这个 fire-and-forget 任务里，**没人看得见**：
        //   shell.log 里只剩第一档（退浏览器），第二三档永远不出现，20 秒后 deadman 把窗口
        //   强显出来 —— 表现成「WebView2 起不来时兜底链断了一半」。
        //   所以这里先逼出句柄再起内核；建句柄不会让窗口显形（显形仍只走 RevealMainWindow）。
        if (!IsHandleCreated) { var _ = Handle; }
        _ = InitWebAsync().ContinueWith(
            (task) => Dbg.Critical("MainWindow: 内核初始化任务抛了没人接的异常：" + Dbg.Ex(task.Exception)),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    /// <summary>
    /// 任务栏图标点一下 = 最小化 / 还原（2026-10-20 用户反馈：「我点底部这个任务栏图标
    /// 想把它缩小到任务栏，却发现点了没用」）。
    /// ★ 根因：FormBorderStyle.None 的无边框窗体，Win32 默认不带 WS_MINIMIZEBOX ——
    ///   Windows 不认它「可以最小化」，点任务栏图标就什么都不发生。
    ///   把 WS_MINIMIZEBOX | WS_SYSMENU 补进 Style，系统手势（点任务栏最小化/还原）就回来了，
    ///   外观仍是全无边框，页面上的 min/max 按钮也不受影响。
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.Style |= 0x00020000 /* WS_MINIMIZEBOX */ | 0x00080000 /* WS_SYSMENU */;
            return cp;
        }
    }

    /// <summary>
    /// 2026-10-20（设置页「显示屏幕」）：把主窗口搬到目标屏中央，尺寸不变。
    /// ★ 定位口径与构造时一致（WorkingArea 居中、夹在 900×640..2300×1400 的同一套算法），
    ///   只是把"鼠标在哪块屏"换成"用户选的那块屏"。找不到目标屏就原地不动。
    /// </summary>
    public void MoveToScreen(Screen s)
    {
        if (s == null) return;
        try
        {
            var area = s.WorkingArea;
            int w = Math.Clamp((int)Math.Round(area.Width * 0.88), 900, 2300);
            int h = Math.Clamp((int)Math.Round(area.Height * 0.86), 640, 1400);
            Bounds = new Rectangle(area.Left + (area.Width - w) / 2,
                                   area.Top + (area.Height - h) / 2, w, h);
        }
        catch (Exception ex)
        {
            Dbg.Log("MainWindow: 搬屏失败 " + Dbg.Ex(ex));
        }
    }

    /// <summary>给一个 WebView2 控件接上线（消息、调试日志）。重建时也要走同一条，所以抽出来。</summary>
    private void WireWeb(WebView2 web)
    {
        web.WebMessageReceived += OnWebMessage;

        // ★ 2026-10-18：页面右上角「放大」按钮点了没反应，查下来两边代码都对，
        //   只能靠日志定位断在哪一环。这一行只在设了 LINLI_DEBUG_MSG 时才写，
        //   平常不产生任何文件（用户机器上不留日志垃圾）。用法：set LINLI_DEBUG_MSG=1
        //   再启动，点一次按钮，看 %TEMP%\linli-msg.log 里有没有 "recv: max"。
        if (Environment.GetEnvironmentVariable("LINLI_DEBUG_MSG") == "1")
        {
            web.WebMessageReceived += (_, e) =>
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
    }

    /// <summary>沙箱降级开关。见 <see cref="NoteSelfHealing"/> 里的实测结论。
    /// ★ 初值读上次的记忆：这台机器若上次就是脱沙箱才起来的，这次直接这么建，
    ///   省下"先崩一阵再切换"的那几秒 —— 用户看到的开屏黑就是那几秒。</summary>
    private bool _noSandbox = WebTriage.NoSandboxRemembered();

    /// <summary>页面有没有成功画出来过（决定崩溃时走"冷静等待"还是"立即降级"）。</summary>
    private bool _successfulNavigation;

    /// <summary>启动时刻：崩溃冷静期从它算起。</summary>
    private readonly DateTime _startedAt = DateTime.UtcNow;

    /// <summary>
    /// 启动后的冷静期（秒）。这段时间内内核进程怎么崩都只记日志、不动控件 ——
    /// 实测（2026-10-20 00:30 用户）：启动那十几秒崩一阵，之后自己就好了。
    /// </summary>
    private const int BootGraceSeconds = 30;

    /// <summary>本次建内核用的参数（只在沙箱起不来时才带 --no-sandbox）。</summary>
    private CoreWebView2EnvironmentOptions BuildOptions()
    {
        var o = new CoreWebView2EnvironmentOptions();
        if (_noSandbox) o.AdditionalBrowserArguments = WebTriage.NoSandboxArg;

        // ★ 只给自检用的调试口：显式设了环境变量 LINLI_VERIFY_CDP_PORT 才拼进来。
        //   2026-10-20 第二十三轮：修好「显示屏幕信息不准」之后要端到端验证，CDP 却连不上：
        //   本机 webview2-flags.txt 记着 --no-sandbox ⇒ _noSandbox=true ⇒ 上面那行会自设浏览器参数，
        //   把环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（含 --remote-debugging-port）整个顶掉。
        //   手工绕一圈不可取：找到了就得改，不能每轮都靠临时刷环境变量。
        //   用户机器上没人设这个变量，生产路径与改动前逐字节等价。
        var dbgPort = Environment.GetEnvironmentVariable("LINLI_VERIFY_CDP_PORT");
        if (!string.IsNullOrEmpty(dbgPort))
        {
            var dbg = $"--remote-debugging-port={dbgPort}";
            o.AdditionalBrowserArguments = string.IsNullOrEmpty(o.AdditionalBrowserArguments)
                ? dbg
                : o.AdditionalBrowserArguments + " " + dbg;
        }

        return o;
    }

    /// <summary>
    /// 建内核并导航。★ 抽成方法是因为渲染进程掉线后要重建一次（见 OnProcessFailed）——
    /// 重建出来的是新控件，Load 事件不会再触发，只能直接调这里。
    /// </summary>
    private async Task InitWebAsync()
    {
        try
        {
            // ★ 自检开关（2026-10-19 第十六轮 §5）：正常机器上 WebView2 永远起得来，
            //   于是「起不来之后怎么办」这三档在真机上永远走不到、也就永远没人验过。
            //   设 LINLI_FORCE_WEBVIEW_FAIL=1 就在建内核之前直接抛 ⇒ 可以把三档真跑一遍。
            //   **只在被显式设置时生效**，生产环境不会有人有这个变量。
            if (Environment.GetEnvironmentVariable("LINLI_FORCE_WEBVIEW_FAIL") == "1")
                throw new InvalidOperationException("LINLI_FORCE_WEBVIEW_FAIL=1（自检：假装 WebView2 内核起不来）");

            // ★★ 新控件的窗口句柄此时还没建好。原来重建几乎必然失败，报的就是
            //   `0x80070578 无效的窗口句柄`（Every rebuild fails ⇒ 一次 GPU 抖动就能把
            //   三次额度烧光）。访问 Handle 会逼 WinForms 立刻把句柄建出来再做内核。
            if (!_web.IsHandleCreated) { var _ = _web.Handle; }

            // ★ 用户数据目录必须显式给一个本机的固定位置。
            //   不给的话 WebView2 会在 exe 旁边建目录 —— 装在 Program Files 下会写不进去，
            //   而且卸载时会漏下一堆东西。放在数据目录里，跟信件一个待遇。
            string dataDir = Path.Combine(App.DataDir, "webview2");
            Directory.CreateDirectory(dataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir, BuildOptions());
            await _web.EnsureCoreWebView2Async(env);

            // ★ 页面自己是不透明深底（body.native 的 --bg），这里只是别让
            //   WebView2 在首帧前垫一块白 —— 颜色取同一个 --bg。
            _web.DefaultBackgroundColor = Color.FromArgb(18, 18, 20);

            var core = _web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;  // 别弹出浏览器的右键菜单
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // ★ 2026-10-20（用户口径）：曲库「更改」按钮要弹系统的文件夹选择对话框。
            //   网页弹不了系统对话框 ⇒ 外壳把它包成 host object 给页面（见 ShellBridge）。
            //   放在 InitWebAsync 里：重建控件后这里会再跑一遍，桥跟着重新注册。
            core.AddHostObjectToScript("linliShell", new ShellBridge());
            core.NavigationCompleted += (_, e) =>
            {
                // ★ 页面认认真真导航成功一次 ⇒ 控件确实在正常干活 ⇒ 以前的账全部勾销。
                //   计数原来是"终身累计"：跑上一天，内核零零散散崩够三次就永久进死路。
                if (e.IsSuccess)
                {
                    _successfulNavigation = true;
                    _budget.NoteHealthy();
                    // ★ 2026-10-20：正反两种结论都要记。只记"崩过"不记"没崩过"的话，
                    //   启动动画下次仍然没有依据，只能带沙箱试错 ⇒ 又是黑几秒。
                    if (_noSandbox) WebTriage.RememberNoSandbox();  // 下次直接脱沙箱建，开屏不再黑
                    else WebTriage.RememberSandboxOk();             // 下次放心带沙箱
                    Program.NotifyPageReady();  // ★ 2026-10-20：首帧画好了才收启动动画（消除开屏黑屏几秒）
                }
                FlushPage();
            };
            core.NewWindowRequested += (_, e) =>
            {
                // 页面要开外链：交给系统默认浏览器，别在我们这个窗口里开。
                e.Handled = true;
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
                catch { /* 开不了就算了 */ }
            };
            // ★ 卡黑屏的根：内核进程一挂，控件就冻在最后一帧，没人重载就永远是黑屏。
            core.ProcessFailed += OnProcessFailed;

            core.Navigate(_pageUrl);
            Dbg.Log("MainWindow: 已 Navigate " + _pageUrl);
        }
        catch (Exception ex)
        {
            Dbg.Critical("MainWindow: WebView2 起不来：" + Dbg.Ex(ex));
            // ★ 2026-10-19（第十六轮审查 §5）：这里原来是「首次失败退浏览器，其余什么都不做，
            //   留给下一次重建」。可"下一次重建"只能由 ProcessFailed 触发，而控件已经死透、
            //   不会再发事件 ⇒ 用户看到的就是一块 #121214 的死黑屏，零提示、零退路。
            //   现在按剩余次数分三档（判断本身在 WebRecovery.Decide，纯函数、有自检）：
            //   首次退浏览器；还有次数就再重建；次数用尽给出路。
            var action = WebRecovery.Decide(_budget.Used);
            Dbg.Critical($"MainWindow: 内核起不来的处置 rebuilds={_budget.Used} ⇒ {WebRecovery.Name(action)}");
            switch (action)
            {
                case WebRecoveryAction.FallbackBrowser:
                    FallbackToBrowser(_pageUrl, ex);
                    break;
                case WebRecoveryAction.Rebuild:
                    RebuildWeb();   // RebuildWeb 自己封顶，不会死循环
                    break;
                default:
                    ShowDeadEnd("界面内核起不来。\n\n请关掉本程序再重新打开一次；数据和信件都在本机，不会丢。");
                    break;
            }

            if (WebRecovery.IsSelfCheckRun())
            {
                // ★ 自检链（2026-10-19 第十六轮 §5）：真机上"三档都走到"几乎不可能 ——
                //   第一档退回浏览器之后就再没有东西触发下一次初始化了，第二三档永远轮不到。
                //   所以自检模式下把这条链**主动推下去**：走完第一档再重建、重建再失败、直到死路，
                //   然后把每一步的决策写进 shell.log，最后自己退出（不留窗口、不挂模态框）。
                //   ★ 这段只在 LINLI_SELF_CHECK_CHAIN=1 时存在；只设 FORCE 而不设 CHAIN 时，
                //     走的就是"真用户第一档"那条路（不重建、不退出），可作对照组。
                if (!WebRecovery.IsSelfCheckChain()) return;
                if (action != WebRecoveryAction.DeadEnd)
                {
                    BeginInvoke(new Action(() => RebuildWeb()));
                }
                else
                {
                    Dbg.Critical("MainWindow: [自检] 三档全部走完，退出");
                    BeginInvoke(new Action(() =>
                    {
                        // Application.Exit 还要走一遍消息泵收尾，自检里可能卡在托盘上；
                        // 这是自检专用出口，直接结束进程最干净。
                        Application.Exit();
                        Environment.Exit(0);
                    }));
                }
            }
        }
    }

    /// <summary>
    /// WebView2 的某个内核进程出事。★ 处置按 <see cref="WebTriage.Decide"/> 分三档，
    ///   其中最重要的恰恰是「什么都不做」那一档 —— 事故原委写在那边文件头上。
    /// </summary>
    private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
    {
        // ★ 控件换过之后，被丢掉的那个 CoreWebView2 还会把它最后那次故障再报一次。
        //   照着它动手就是日志里那 6 次 `CoreWebView2 members cannot be accessed after
        //   the WebView2 control is disposed`。来源不是当前控件 ⇒ 直接丢掉。
        if (!ReferenceEquals(sender, SafeCore()))
        {
            Dbg.Critical($"MainWindow: 旧控件的遗言（kind={e.ProcessFailedKind}），忽略");
            return;
        }

        Dbg.Critical($"MainWindow: WebView2 进程出事 kind={e.ProcessFailedKind} reason={e.Reason}");

        // ★ 2026-10-20 第二十四轮（黑屏根因，证据链见 WebTriage.UnresponsiveRecheckMs 的注释）：
        //   渲染进程「卡住没死」多半是安全软件在批量扫描，十几秒后自己缓过来。
        //   原来立刻 Reload ⇒ 控件此时已不可用（必抛 0x8007139F）⇒ 必落到重建 ⇒
        //   新渲染进程 30 秒后又被冻 ⇒ 额度烧光进死路。先等一拍再探活，自愈就当没发生。
        if (WebTriage.IsUnresponsive(e.ProcessFailedKind))
        {
            Dbg.Critical($"MainWindow: 渲染进程冻结（多半是安全软件在扫描）⇒ 等 {WebTriage.UnresponsiveRecheckMs / 1000} 秒再探活");
            BeginInvoke(new Action(() => _ = HandleUnresponsiveAsync()));
            return;
        }

        var action = WebTriage.Decide(e.ProcessFailedKind);
        Dbg.Critical($"MainWindow: 分诊 ⇒ {WebTriage.Name(action)}");
        switch (action)
        {
            case ProcessFailedAction.Ignore:
                // GPU / Utility 进程由内核自己重启，宿主一动反而把好控件打死。
                NoteSelfHealing();
                return;

            case ProcessFailedAction.Reload:
                try
                {
                    SafeCore()?.Reload();
                    Dbg.Critical("MainWindow: 已按重载处理");
                    return;
                }
                catch (Exception ex)
                {
                    Dbg.Critical("MainWindow: 重载失败，改走延迟重建：" + Dbg.Ex(ex));
                }
                break;
        }

        ScheduleRebuild();
    }

    /// <summary>当前的 CoreWebView2（还没建好或已经 disposed 时返回 null）。</summary>
    private CoreWebView2 SafeCore()
    {
        try { return _web?.CoreWebView2; }
        catch { return null; }
    }

    /// <summary>同一轮冻结只排一次探活（冻结成簇，事件会连发好几次）。</summary>
    private bool _unresponsiveProbePending;

    /// <summary>
    /// 渲染冻结的「等一拍再探活」（2026-10-20 第二十四轮）：
    /// 等 <see cref="WebTriage.UnresponsiveRecheckMs"/> 后用 ExecuteScript 探活 ——
    /// 缓过来了就一笔勾销（不动控件、不烧重建额度）；真还在冻才走重载/重建。
    /// </summary>
    private async Task HandleUnresponsiveAsync()
    {
        if (_unresponsiveProbePending) return;
        _unresponsiveProbePending = true;
        try
        {
            await Task.Delay(WebTriage.UnresponsiveRecheckMs);
            var core = SafeCore();
            if (core == null)
            {
                Dbg.Critical("MainWindow: 冻结等待期内控件没了 ⇒ 走重建");
                ScheduleRebuild();
                return;
            }
            if (await WebTriage.ProbeResponsiveAsync(core))
            {
                _budget.NoteHealthy();
                Dbg.Critical("MainWindow: 渲染冻结已自愈 ⇒ 不动控件、不烧额度");
                return;
            }
            Dbg.Critical("MainWindow: 冻结仍未恢复 ⇒ 走重载/重建");
            try
            {
                core.Reload();
                Dbg.Critical("MainWindow: 已按重载处理（冻结未恢复）");
                return;
            }
            catch (Exception ex)
            {
                Dbg.Critical("MainWindow: 重载失败，改走延迟重建：" + Dbg.Ex(ex));
            }
            ScheduleRebuild();
        }
        finally { _unresponsiveProbePending = false; }
    }

    /// <summary>60 秒滑动窗内的「可自愈崩溃」时间戳。</summary>
    private readonly List<DateTime> _selfHealHits = new();
    /// <summary>风暴已经处理过，别反复拉浏览器。</summary>
    private bool _stormHandled;

    /// <summary>
    /// 可自愈崩溃的记账。它们「不用管」没错，但**一直崩**说明内核在这台机器上根本起不来
    /// （2026-10-19：WebView2 运行时自动更新之后，连最简空白页都 1 秒崩十几次 —— 见
    /// analysis\_audit19\barehost 的对照实验）。60 秒 6 次 ⇒ 别守着一块黑窗口了，
    /// 直接退系统浏览器：功能一样能用，总比黑屏强。
    /// </summary>
    private void NoteSelfHealing()
    {
        if (_stormHandled) return;
        var now = DateTime.UtcNow;
        _selfHealHits.RemoveAll(t => (now - t).TotalSeconds > 60);
        _selfHealHits.Add(now);
        if (_selfHealHits.Count < 3) return;

        // ★★ 页面还没成功画出来过 + 已经崩了好几次 ⇒ 不要等冷静期，立即关沙箱重建。
        //   （00:33 用户实测：干等 30 秒只是让开屏黑得更久。沙箱被拦的机器上，
        //     --no-sandbox 实测 40 秒零崩溃，早换早解脱。）
        //   冷静期只保护「曾经成功画出来过」的场合 —— 那种崩一阵会自愈，别去动它。
        if (!_noSandbox && !_successfulNavigation && _selfHealHits.Count >= 3)
        {
            _noSandbox = true;
            _selfHealHits.Clear();
            _budget.NoteHealthy();
            Dbg.Critical("MainWindow: 开屏即崩、页面没画出来过 ⇒ 立即换 --no-sandbox 重建");
            ScheduleRebuild();
            return;
        }

        var now2 = DateTime.UtcNow;
        _selfHealHits.RemoveAll(t => (now2 - t).TotalSeconds > 60);
        if (_selfHealHits.Count < 6) return;

        // ★★ 2026-10-20 00:30 用户实测纠正：内核崩溃是**启动那一阵**，之后自己就好了。
        //   我原来一攒够次数就撤层/退浏览器，结果把本来能自愈的窗口误杀 —— 用户点了
        //   提示框的确定之后程序明明是好的。所以先给一段冷静期：这段时间只记日志，
        //   什么都不动；等它自己爬起来。
        if ((now2 - _startedAt).TotalSeconds < BootGraceSeconds)
        {
            _selfHealHits.Clear();   // 冷静期里的账不算，期满后重新数
            return;
        }
        _selfHealHits.Clear();

        // ★ 2026-10-19 深夜实测（analysis/_audit19/barehost）：这台机器上
        //   默认（带沙箱）空白页 40 秒崩 16 次、`--in-process-gpu` 崩 977 次、
        //   **`--no-sandbox` 崩 0 次** ⇒ 崩的是 Chromium 沙箱（被安全软件拦住），
        //   不是渲染也不是页面。所以第一反应不是退浏览器，而是**关掉沙箱再建一次** ——
        //   这样用户拿到的还是自己的独立窗口。
        if (!_noSandbox)
        {
            _noSandbox = true;
            _budget.NoteHealthy();     // 降级是一次新的尝试，额度重新开始算
            Dbg.Critical("MainWindow: 沙箱起不来 ⇒ 换 --no-sandbox 重建（沙箱常被安全软件拦）");
            ScheduleRebuild();
            return;
        }

        _stormHandled = true;
        Dbg.Critical($"MainWindow: 关掉沙箱之后内核进程仍在崩溃 ⇒ 内核在本机不可用，退回系统浏览器");
        HideDeadEnd();
        FallbackToBrowser(_pageUrl,
            new InvalidOperationException("界面内核的进程在反复崩溃（详见 shell.log）"));
    }

    /// <summary>
    /// 排一次延迟重建。★ 为什么不能在 <see cref="OnProcessFailed"/> 里就地重建：
    ///   ① 那个回调是从内核那边过来的，未必在 UI 线程 —— 直接 Controls.Add 会跨线程；
    ///   ② 崩溃是成簇来的：一个进程退出常常在几十毫秒内连报好几次，就地重建会
    ///      在同一簇里同时起好几个新控件（实测 `0x80070578 无效的窗口句柄` 就出自这批）。
    /// </summary>
    private void ScheduleRebuild()
    {
        if (_rebuildQueued) return;
        _rebuildQueued = true;
        BeginInvoke(new Action(async () =>
        {
            try
            {
                // 自检链要一口气把三档推到底，等冷却只会把它拖成超时。
                if (!WebRecovery.IsSelfCheckChain())
                    await Task.Delay(WebTriage.CoolDownMs);
                _rebuildQueued = false;
                RebuildWeb();
            }
            catch (Exception ex)
            {
                _rebuildQueued = false;
                Dbg.Critical("MainWindow: 延迟重建自己崩了：" + Dbg.Ex(ex));
            }
        }));
    }

    /// <summary>把 WebView2 控件整个换掉（浏览器进程整个没了只能这样）。</summary>
    private void RebuildWeb()
    {
        if (!_budget.TryTake())
        {
            Dbg.Critical($"MainWindow: 重建额度用完（窗口内已重建 {_budget.Used}/{_budget.Max} 次）");
            ShowDeadEnd("界面内核反复出错，已经停止自动恢复。\n\n可以点下面的「重试」让它再试一次；\n数据和信件都在本机，不会丢。");
            return;
        }
        if (_deadScreen) HideDeadEnd();
        try
        {
            var old = _web;
            try { Controls.Remove(old); } catch { /* 已经没了 */ }
            try { old.Dispose(); } catch { /* 已经没了 */ }

            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            WireWeb(_web);
            Dbg.Critical($"MainWindow: 重建 WebView2（第 {_budget.Used} 次）");
            _ = InitWebAsync();
        }
        catch (Exception ex)
        {
            Dbg.Critical("MainWindow: 重建失败：" + Dbg.Ex(ex));
            ShowDeadEnd("界面内核起不来。\n\n请点下面的「重试」；数据和信件都在本机，不会丢。");
        }
    }

    /// <summary>
    /// 自救失败时窗口里显示的说明（原生绘制，不依赖 WebView2 —— 它已经不可用了）。
    /// 不弹 MessageBox：那是模态的，会把用户卡在这儿；这里只是把窗口变成一张"说明书"。
    /// </summary>
    private void ShowDeadEnd(string text)
    {
        // ★ 先落日志：这段字在窗口里，测试抓不到；但"走到死路"这件事必须可被外部观察到
        //   （tests\shell-recovery.test.js 就是靠这一行判定第三档真的触发了）。
        Dbg.Critical("MainWindow: 进入死路界面 ⇒ " + text.Replace("\n", " ").Replace("\r", " "));
        // ★ 崩溃是成簇的，这个函数会被连着调好几次；不幂等就会一层一层往上叠 Label。
        if (_deadScreen) return;
        try
        {
            SuspendLayout();
            foreach (Control c in Controls) c.Visible = false;

            var panel = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(18, 18, 20), Tag = DeadEndTag };
            var label = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(232, 233, 235),
                BackColor = Color.FromArgb(18, 18, 20),
                Font = new Font("Microsoft YaHei UI", 11f),
                Text = text,
            };
            panel.Controls.Add(label);

            // ★ 原来只有一句话让用户"自己重开"：窗口还在托盘里，点开还是这块死画面，
            //   等于没有出路。现在给一个真的能动作的按钮。
            var retry = new Button
            {
                Text = "重试",
                Size = new Size(168, 40),
                Anchor = AnchorStyles.Bottom,
                ForeColor = Color.FromArgb(232, 233, 235),
                BackColor = Color.FromArgb(38, 38, 42),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                Font = new Font("Microsoft YaHei UI", 10f),
            };
            retry.FlatAppearance.BorderColor = Color.FromArgb(72, 72, 78);
            panel.Layout += (_, _) => retry.Location = new Point((panel.Width - retry.Width) / 2, panel.Height - 96);
            panel.Controls.Add(retry);
            retry.BringToFront();
            retry.Click += (_, _) =>
            {
                Dbg.Critical("MainWindow: 用户点了「重试」");
                HideDeadEnd();
                _budget.NoteHealthy();     // 用户主动要试 ⇒ 这笔账从零开始算
                RebuildWeb();
            };

            Controls.Add(panel);
            panel.BringToFront();
            _deadScreen = true;
            ResumeLayout();
        }
        catch (Exception ex)
        {
            Dbg.Critical("MainWindow: 死路说明也画不出来：" + Dbg.Ex(ex));
        }
    }

    private const string DeadEndTag = "dead-end";

    /// <summary>把死路说明撤掉，让界面回到 WebView2 那层（点「重试」或重建成功前都要走这一步）。</summary>
    private void HideDeadEnd()
    {
        try
        {
            SuspendLayout();
            for (int i = Controls.Count - 1; i >= 0; i--)
            {
                var c = Controls[i];
                if ((c.Tag as string) == DeadEndTag)
                {
                    Controls.Remove(c);
                    c.Dispose();
                }
                else
                {
                    c.Visible = true;
                }
            }
            _deadScreen = false;
            ResumeLayout();
        }
        catch (Exception ex)
        {
            Dbg.Critical("MainWindow: 死路说明撤不掉：" + Dbg.Ex(ex));
        }
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

    /// <summary>
    /// 页面当前在哪一页（外壳那边给左沿导航浮层用）。
    /// ★ 初值 "mail"：页面还没报第一句 `page:` 时，信箱就是默认页。
    /// </summary>
    public string CurrentPage { get; private set; } = "mail";

    /// <summary>页面切页了（`page:&lt;id&gt;` 消息）。导航浮层靠它同步选中态。</summary>
    public event EventHandler<string> PageChanged;

    /// <summary>
    /// 壁纸层每秒上报的真实播放进度转给页面（2026-10-20，曲库底部播放条画真进度用）。
    /// </summary>
    public void ForwardPlayback(string json)
    {
        if (string.IsNullOrEmpty(json)) return;
        try { SafeCore()?.PostWebMessageAsJson(json); }
        catch { /* 内核还没就绪，下一秒的报表会再来 */ }
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
        // ★ 2026-10-20：页面切页了 ⇒ 告诉外壳。左沿外面那枚导航浮层是**独立窗口**，
        //   它看不见页面里的 class 变化，只能靠这一句跟着亮（用户从齿轮进设置、
        //   点返回、点明信片跳曲库，导轨都得跟上，否则"当前位置"就是假的）。
        if (msg.StartsWith("page:", StringComparison.Ordinal))
        {
            CurrentPage = msg.Substring("page:".Length);
            // ★ 记一行常开日志：导航浮层的选中态全靠这一句，用户报「导航亮错页」时
            //   要能一眼看出是页面没报、还是外壳没接（量很小，切一次一行）。
            Dbg.Critical("MainWindow: 页面切到 " + CurrentPage);
            PageChanged?.Invoke(this, CurrentPage);
            return;
        }
        // ★ 2026-10-19：页面在曲库里点了播放/回到待机 ⇒ 通知桌面那层立刻换片。
        //   视频只在桌面放（用户口径 m01034），窗口这边只负责发号令。
        if (msg == "stage:changed")
        {
            StageChanged?.Invoke(this, EventArgs.Empty);
            return;
        }
        // ★ 2026-10-19：设置页拖了音量滑块 / 拨了环境音开关。跟 stage:changed 分开，
        //   因为两件事在桌面那层的动作相反：换片要**先掐掉环境音**，改音量只是重设 volume
        //   （若混成一个消息，拖一下滑块就会把正在响的环境音掐断）。
        if (msg == "stage:volume")
        {
            StageVolumeChanged?.Invoke(this, EventArgs.Empty);
            return;
        }
        if (msg.StartsWith("stage:mute:", StringComparison.Ordinal))
        {
            StageMuteRequested?.Invoke(this, msg.EndsWith("1", StringComparison.Ordinal));
            return;
        }
        // ★ 2026-10-20：曲库底部播放条（用户圈原版截图指定）。片子在桌面壁纸层放，
        //   点进度条跳转（自研，原版没有）转发给壁纸宿主。
        //   ★ 播放键是「回待机」语义（用户明确），走 stage:changed 既有链路，
        //     不做画面冻结式暂停 ⇒ 没有 playback:toggle 这条指令。
        if (msg.StartsWith("seek:", StringComparison.Ordinal))
        {
            if (double.TryParse(msg.Substring("seek:".Length),
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var sec))
                SeekRequested?.Invoke(this, sec);
            return;
        }
        switch (msg)
        {
            case "drag":    StartDrag(); break;
            // ★ 2026-10-19 用户口径：「我点了最小化，他不缩小到任务栏，而是缩到（任务栏溢出区）」
            //   —— 「—」本来就该是**最小化**，不是收进托盘。收进托盘是「×」那件事。
            //   以前两者都走 RequestHide，于是点个最小化，人要去托盘溢出区里找程序。
            case "min":     WindowState = FormWindowState.Minimized; break;
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
    ///   ShellExecute 交出去了。目前只允许字体官网那两个域名 + GitHub（反馈入口）。
    /// ★ 同时限死 https：挡掉 file: / javascript: / 自定义协议那些。
    /// ★ 2026-10-19 审查 N1：设置页「反馈问题 / 建议新功能」的地址是 github.com/<owner>/<repo>/issues/new，
    ///   原先不在名单里 —— 前端放行、这里静默 return，用户点了完全没反应（连提示都没有）。
    ///   只加 github.com / www.github.com，不要顺手放 api.github.com：那个域名能取到任意仓库数据，
    ///   而 issues/new 只会落在网页域名上。
    /// </summary>
    private static readonly string[] AllowedExternalHosts =
    {
        "sentyfont.com", "www.sentyfont.com",
        "hanyi.com.cn",  "www.hanyi.com.cn",
        "github.com",    "www.github.com",
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

    // ★ 2026-10-19：原来的 EnableBackdrop()（WCA_ACCENT_POLICY 亚克力 + DWMWA_SYSTEMBACKDROP_TYPE
    //   + DwmExtendFrameIntoClientArea(-1)）连同它那几个 P/Invoke 一并删掉了。
    //   窗口底色现在由页面自己给（--bg），玻璃透的是窗口内的壁纸视频，不再需要系统级 blur；
    //   留着它只会在不透明窗口上白做一次跨进程调用。

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
            if (WebRecovery.IsSelfCheckRun())
            {
                // 自检：不真的拉起浏览器、也不弹框（否则自动化会挂在模态框上）。
                Dbg.Critical("MainWindow: [自检] 本应退回系统浏览器，已跳过外链与弹窗");
                return;
            }
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
        if (disposing) { _web?.Dispose(); }
        base.Dispose(disposing);
    }
}
