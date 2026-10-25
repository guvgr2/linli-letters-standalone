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

    /// <summary>
    /// 壁纸层每秒上报的真实播放进度（JSON：{"t":秒,"d":总长,"playing":在不在播}）。
    /// ★ 2026-10-20：曲库底部播放条要画真进度，而片子只在这层放 —— 由外壳转给主窗口。
    /// </summary>
    public event EventHandler<string> PlaybackReported;

    public WallpaperHost(string url)
    {
        _url = url;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        // ★ 2026-10-19：这里原来是 Color.Black。这扇窗盖着整个桌面，页面首帧之前
        //   （或者内核挂掉以后）露出来的就是它 —— 一整块纯黑，用户看到的就是
        //   「卡黑屏」。改成页面自己的底色，最坏情况也只是深色，不会是一块死黑。
        BackColor = Color.FromArgb(18, 18, 20);

        Rectangle v = SystemInformation.VirtualScreen;
        Bounds = new Rectangle(0, 0, v.Width, v.Height);

        _web = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(_web);

        _web.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (string.IsNullOrEmpty(msg)) return;
            Dbg.Log("WallpaperHost 收到页面消息: " + msg);
            if (msg.StartsWith("open:", StringComparison.Ordinal))
                OpenPageRequested?.Invoke(this, msg.Substring("open:".Length));
            else if (msg.StartsWith("playback:", StringComparison.Ordinal))
                // ★ 2026-10-20：真实播放进度（曲库底部播放条用）。剥掉前缀后**再包一层
                //   {"playback":…}** 转给主窗口——页面那边按 m.playback 认领。
                PlaybackReported?.Invoke(this,
                    "{\"playback\":" + msg.Substring("playback:".Length) + "}");
            else if (msg == "state:off")
                // 页面说"没有曲子可播"。这时候留在桌面上就是一块黑 —— 撤掉，
                // 用户原来的壁纸原样露出来，比挂着一个空窗口好解释。
                BeginInvoke(new Action(Close));
        };

        Load += async (_, _) => await InitWebAsync();
    }

    /// <summary>
    /// 建内核并导航。抽成方法是为了内核掉线后能重建（重建出来的控件不会再触发 Load）。
    /// </summary>
    private async Task InitWebAsync()
    {
        Dbg.Log("WallpaperHost.Load: 开始建 WebView2");
        try
        {
            // ★ 和主窗口分开的用户数据目录：两个 WebView2 共用一个目录会互相锁。
            string dir = System.IO.Path.Combine(App.DataDir, "webview2-wallpaper");
            System.IO.Directory.CreateDirectory(dir);
            // ★ 2026-10-19：壁纸层要**出声**（曲子模式解除 muted，见 wallpaper.html）。
            //   有声音的自动播放会被 Chromium 的 autoplay 策略拦下 —— 桌面那层永远
            //   没有用户手势可以"解禁"，所以只能把策略本身放宽。
            //   ★ 只放宽这一层（壁纸页只有一个本地视频 + 一个环境音），主窗口那份
            //     WebView2 不加，那边依旧守默认策略。
            var options = new CoreWebView2EnvironmentOptions
            {
                // 沙箱起不来时才追加 --no-sandbox（见 WebTriage.NoSandboxArg 的实测）
                AdditionalBrowserArguments = (_noSandbox ? WebTriage.NoSandboxArg + " " : "")
                                             + "--autoplay-policy=no-user-gesture-required",
            };
            // ★ 只给自检用的调试口（2026-10-20 第二十四轮）：壁纸层渲染进程「导航后整 30 秒
            //   冻结」的病灶要抓现行 —— 同一页面在无头 Edge 里 70 秒心跳一秒不落，
            //   只有真外壳里冻 ⇒ 必须能连上这层的 CDP 才能拿到冻结时的调用栈。
            //   套路照主窗口的 LINLI_VERIFY_CDP_PORT（追加、不顶掉 --no-sandbox）；
            //   用户机器上没人设这个变量，生产路径与改动前逐字节等价。
            var dbgPort = Environment.GetEnvironmentVariable("LINLI_VERIFY_CDP_PORT_WALLPAPER");
            if (!string.IsNullOrEmpty(dbgPort))
            {
                var dbg = $"--remote-debugging-port={dbgPort}";
                options.AdditionalBrowserArguments = string.IsNullOrEmpty(options.AdditionalBrowserArguments)
                    ? dbg
                    : options.AdditionalBrowserArguments + " " + dbg;
            }
            // ★★ 2026-10-20：原来这行强制建句柄写在建内核**之后**，等于没写 ——
            //   壁纸层因此报 `0x8007139F 组或资源的状态不是执行请求操作的正确状态`
            //   （跟主窗口当初 0x80070578 是同一个病）。必须在 CreateAsync 之前逼出句柄。
            if (!_web.IsHandleCreated) { var _ = _web.Handle; }

            var env = await CoreWebView2Environment.CreateAsync(null, dir, options);
            await _web.EnsureCoreWebView2Async(env);

            // 透明底：没曲子的时候透出用户原来的壁纸，而不是一块黑。
            _web.DefaultBackgroundColor = Color.Transparent;

            var core = _web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // 页面导航成功 ⇒ 这层确实在正常干活 ⇒ 以前的账一笔勾销（原计数器终身累计）。
            core.NavigationCompleted += (_, e) =>
            {
                if (e.IsSuccess)
                {
                    _successfulNavigation = true;
                    _budget.NoteHealthy();
                    // ★ 2026-10-20：壁纸层比主窗口先起来，让它也参与记账 ——
                    //   它先探测出来的结论，主窗口和启动动画下次就能直接用。
                    if (_noSandbox) WebTriage.RememberNoSandbox();
                    else WebTriage.RememberSandboxOk();
                }
            };
            // ★ 2026-10-19：用户报「卡黑屏」。桌面这一层盖着整个屏幕，内核一挂就冻在
            //   最后一帧（或干脆一块黑）—— 而且没有任何人能点它一下让它恢复。
            //   必须自己爬起来：渲染进程挂 ⇒ 重载；浏览器进程没了 ⇒ 换个控件重建。
            core.ProcessFailed += OnProcessFailed;
            core.Navigate(_url);
            Dbg.Log("WallpaperHost.Load: 已 Navigate " + _url);
        }
        catch (Exception ex)
        {
            // 内核起不来就当没有壁纸这回事，什么都不做。
            // 桌面上不该出现任何异常提示 —— 那比没有壁纸更难解释。
            Dbg.Log("WallpaperHost.Load: 失败 " + Dbg.Ex(ex));
            Dbg.Critical("WallpaperHost: WebView2 起不来：" + Dbg.Ex(ex));
            BeginInvoke(new Action(Close));
        }
    }

    /// <summary>
    /// 重建预算（滑动窗口 + 冷却 + 成功清零）。
    /// ★ 原来是一个只增不减的 int：桌面这一层整晚开着，零零散散攒够两次就永久撤掉，
    ///   而这层是全屏铺在最底下的 —— 撤早了用户以为"壁纸开关失灵了"。
    /// </summary>
    private readonly RebuildBudget _budget = new(2, TimeSpan.FromMinutes(10),
                                                 TimeSpan.FromMilliseconds(WebTriage.CoolDownMs));

    /// <summary>已经排了一次延迟重建，同簇里其余事件不再排队。</summary>
    private bool _rebuildQueued;

    /// <summary>
    /// 页面那侧刚换了"现在该放哪首"（用户在曲库里点了播放/回到待机）⇒ 叫桌面这层立刻重算。
    /// ★ 不这么做只能等页面自己的 30 秒轮询：用户点了播放，桌面半分钟后才变，
    ///   第一反应一定是"没生效"。（页面对这个消息的处理在 wallpaper.html 的 listenShell。）
    /// </summary>
    /// <summary>
    /// 2026-10-20（设置页「显示屏幕」）：把这一层搬到选中的那块屏（Bounds = 那块屏）。
    /// ★ 它是 WorkerW 的子窗口，WorkerW 通常是整块虚拟屏大小，子窗口可以在里面任意定位，
    ///   只铺目标屏是可行的；找不到目标屏（屏被拔了）就原地不动。
    /// </summary>
    public void MoveToScreen(Screen s)
    {
        if (s == null) return;
        try
        {
            Bounds = new Rectangle(s.Bounds.Location, s.Bounds.Size);
            Dbg.Log("WallpaperHost: 已搬到 " + s.DeviceName);
        }
        catch (Exception ex)
        {
            Dbg.Log("WallpaperHost: 搬屏失败 " + Dbg.Ex(ex));
        }
    }

    public void RefreshStage()
    {
        try
        {
            _web?.CoreWebView2?.PostWebMessageAsJson("{\"stage\":\"changed\"}");
            Dbg.Log("WallpaperHost: 已通知桌面页换片");
        }
        catch (Exception ex)
        {
            Dbg.Log("WallpaperHost: 通知换片失败 " + Dbg.Ex(ex));
        }
    }

    /// <summary>设置页改了音量 / 环境音开关 ⇒ 桌面这层只重设 volume，不掐断正在响的声音。</summary>
    public void RefreshVolume()
    {
        try
        {
            _web?.CoreWebView2?.PostWebMessageAsJson("{\"volume\":\"changed\"}");
            Dbg.Log("WallpaperHost: 已通知桌面页重设音量");
        }
        catch (Exception ex)
        {
            Dbg.Log("WallpaperHost: 通知音量失败 " + Dbg.Ex(ex));
        }
    }

    /// <summary>主窗口播放条上的静音键：声音在桌面这一层出，所以静音也得在这边落。</summary>
    public void SetMuted(bool muted)
    {
        try
        {
            _web?.CoreWebView2?.PostWebMessageAsJson(muted ? "{\"mute\":true}" : "{\"mute\":false}");
        }
        catch (Exception ex)
        {
            Dbg.Log("WallpaperHost: 通知静音失败 " + Dbg.Ex(ex));
        }
    }

    /// <summary>
    /// 曲库底部播放条点进度条跳转（2026-10-20，**自研**——原版没有这个功能，用户点名要）。
    /// ★ 播放键是「回待机」语义（走 stage:play idle 那条既有链路），
    ///   不做画面冻结式暂停 ⇒ 这里只有 seek，没有 toggle。
    /// </summary>
    public void SeekTo(double seconds)
    {
        try
        {
            // ★ JSON 里的数字必须用 InvariantCulture：zh-CN 的小数逗号会产出非法 JSON。
            _web?.CoreWebView2?.PostWebMessageAsJson(
                "{\"seek\":" + seconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + "}");
            Dbg.Log("WallpaperHost: 已通知桌面页 seek " + seconds.ToString("0.###"));
        }
        catch (Exception ex)
        {
            Dbg.Log("WallpaperHost: 通知 seek 失败 " + Dbg.Ex(ex));
        }
    }

    private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
    {
        // ★ 换过控件之后，前一个 CoreWebView2 还会把最后那次故障再报一次；照着它动手
        //   就是 `control is disposed`。来源不是当前控件 ⇒ 丢掉。
        if (!ReferenceEquals(sender, SafeCore()))
        {
            Dbg.Critical($"WallpaperHost: 旧控件的遗言（kind={e.ProcessFailedKind}），忽略");
            return;
        }

        Dbg.Critical($"WallpaperHost: WebView2 进程出事 kind={e.ProcessFailedKind} reason={e.Reason}");

        // ★ 2026-10-20 第二十四轮（黑屏根因，证据链见 WebTriage.UnresponsiveRecheckMs）：
        //   渲染冻结会自己缓过来（实测 06:02:40 探活 1+1=2），先等一拍再探活；
        //   原来立刻 Reload 必抛 0x8007139F ⇒ 必烧额度 ⇒ 额度烧光撤壁纸层 ⇒ 桌面黑屏。
        if (WebTriage.IsUnresponsive(e.ProcessFailedKind))
        {
            Dbg.Critical($"WallpaperHost: 渲染进程冻结（多半是安全软件在扫描）⇒ 等 {WebTriage.UnresponsiveRecheckMs / 1000} 秒再探活");
            BeginInvoke(new Action(() => _ = HandleUnresponsiveAsync()));
            return;
        }

        var action = WebTriage.Decide(e.ProcessFailedKind);
        Dbg.Critical($"WallpaperHost: 分诊 ⇒ {WebTriage.Name(action)}");
        switch (action)
        {
            case ProcessFailedAction.Ignore:
                // GPU / Utility 进程内核自己会重启，宿主插手反而把这层也打死。
                NoteSelfHealing();
                return;

            case ProcessFailedAction.Reload:
                try
                {
                    _web.CoreWebView2?.Reload();
                    Dbg.Critical("WallpaperHost: 已按重载处理");
                    return;
                }
                catch (Exception ex)
                {
                    Dbg.Critical("WallpaperHost: 重载失败，改走延迟重建：" + Dbg.Ex(ex));
                }
                break;
        }

        if (!_budget.TryTake())
        {
            Dbg.Critical($"WallpaperHost: 重建额度用完（{_budget.Used}/{_budget.Max}）⇒ 撤掉壁纸层");
            try { BeginInvoke(new Action(Close)); } catch { /* 已经在关了 */ }
            return;
        }

        ScheduleRebuild();
    }

    /// <summary>同一轮冻结只排一次探活（冻结成簇，事件会连发好几次）。</summary>
    private bool _unresponsiveProbePending;

    /// <summary>
    /// 渲染冻结的「等一拍再探活」（2026-10-20 第二十四轮，与 MainWindow 同款）：
    /// 缓过来了就一笔勾销（不动控件、不烧额度）；真还在冻才走重载/重建。
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
                Dbg.Critical("WallpaperHost: 冻结等待期内控件没了 ⇒ 走重建");
                ScheduleRebuild();
                return;
            }
            if (await WebTriage.ProbeResponsiveAsync(core))
            {
                _budget.NoteHealthy();
                Dbg.Critical("WallpaperHost: 渲染冻结已自愈 ⇒ 不动控件、不烧额度");
                return;
            }
            Dbg.Critical("WallpaperHost: 冻结仍未恢复 ⇒ 走重载/重建");
            try
            {
                core.Reload();
                Dbg.Critical("WallpaperHost: 已按重载处理（冻结未恢复）");
                return;
            }
            catch (Exception ex)
            {
                Dbg.Critical("WallpaperHost: 重载失败，改走延迟重建：" + Dbg.Ex(ex));
            }
            ScheduleRebuild();
        }
        finally { _unresponsiveProbePending = false; }
    }

    /// <summary>
    /// 排一次延迟重建（从 OnProcessFailed 的内联代码抽出来：探活失败后也要走同一条路）。
    /// ★ 不在崩溃回调里就地重建：那个回调未必在 UI 线程，而且崩溃成簇，
    ///   就地重建会同时起好几个新控件（主窗口实测报 0x80070578 无效窗口句柄）。
    /// </summary>
    private void ScheduleRebuild()
    {
        if (_rebuildQueued) return;
        _rebuildQueued = true;
        BeginInvoke(new Action(async () =>
        {
            try
            {
                await Task.Delay(WebTriage.CoolDownMs);
                _rebuildQueued = false;
                Rebuild();
            }
            catch (Exception ex)
            {
                _rebuildQueued = false;
                Dbg.Critical("WallpaperHost: 延迟重建自己崩了：" + Dbg.Ex(ex));
            }
        }));
    }

    /// <summary>当前的 CoreWebView2（还没建好或已经 disposed 时返回 null）。</summary>
    private CoreWebView2 SafeCore()
    {
        try { return _web?.CoreWebView2; }
        catch { return null; }
    }

    /// <summary>沙箱降级开关（见 <see cref="MainWindow.NoteSelfHealing"/> 的实测结论）。</summary>
    private bool _noSandbox = WebTriage.NoSandboxRemembered();

    /// <summary>页面有没有成功画出来过。</summary>
    private bool _successfulNavigation;

    /// <summary>启动时刻（崩溃冷静期从它算起）。</summary>
    private readonly DateTime _startedAt = DateTime.UtcNow;
    private const int BootGraceSeconds = 30;

    /// <summary>60 秒滑动窗内的「可自愈崩溃」时间戳（见 MainWindow.NoteSelfHealing 的说明）。</summary>
    private readonly List<DateTime> _selfHealHits = new();
    private bool _stormDone;

    /// <summary>内核进程一直崩：先关掉沙箱重建一次；还崩才撤掉这层。</summary>
    private void NoteSelfHealing()
    {
        if (_stormDone) return;
        var now = DateTime.UtcNow;
        _selfHealHits.RemoveAll(t => (now - t).TotalSeconds > 60);
        _selfHealHits.Add(now);
        if (_selfHealHits.Count < 3) return;
        // 页面没画出来过 + 已崩多次 ⇒ 别等冷静期，立即换 --no-sandbox（开屏黑就是这么来的）
        if (!_noSandbox && !_successfulNavigation)
        {
            _noSandbox = true;
            _selfHealHits.Clear();
            _budget.NoteHealthy();
            Dbg.Critical("WallpaperHost: 开屏即崩 ⇒ 立即换 --no-sandbox 重建");
            BeginInvoke(new Action(Rebuild));  // 事件可能不在 UI 线程，回主线程再动控件
            return;
        }
        // 冷静期：启动那一阵的崩溃只记账不动手（见 MainWindow.BootGraceSeconds 的实测）
        if ((now - _startedAt).TotalSeconds < BootGraceSeconds)
        {
            _selfHealHits.Clear();
            return;
        }
        _selfHealHits.Clear();
        if (!_noSandbox)
        {
            _noSandbox = true;
            _budget.NoteHealthy();
            Dbg.Critical("WallpaperHost: 沙箱起不来 ⇒ 换 --no-sandbox 重建");
            Rebuild();
            return;
        }
        _stormDone = true;
        Dbg.Critical("WallpaperHost: 关掉沙箱仍崩溃 ⇒ 撤掉壁纸层（内核在本机不可用）");
        try { BeginInvoke(new Action(Close)); } catch { /* 已经在关了 */ }
    }

    /// <summary>换一个新控件，重新初始化。</summary>
    private async void Rebuild()
    {
        try
        {
            var old = _web;
            try { Controls.Remove(old); } catch { /* 已经没了 */ }
            try { old.Dispose(); } catch { /* 已经没了 */ }
            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            Dbg.Critical($"WallpaperHost: 重建 WebView2（第 {_budget.Used} 次）");
            await InitWebAsync();
        }
        catch (Exception ex)
        {
            Dbg.Critical("WallpaperHost: 重建失败：" + Dbg.Ex(ex));
        }
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

    /// <summary>
    /// ★ 判"挂上没挂上"必须用 GetAncestor(GA_PARENT)，**不能用 GetParent**。
    ///   2026-10-18 真机实测（analysis\_probe-workerw.ps1）：SetParent 明明成功了，
    ///   紧接着 GetParent(我们的窗口) 却返回 0 —— 因为我们的窗口没有 WS_CHILD 样式，
    ///   在系统看来仍是"顶层窗口"，而 GetParent 对顶层窗口返回的是 owner（这里是 0）。
    ///   同一时刻 GetAncestor(h, GA_PARENT) 如实返回 WorkerW。
    ///   后果：原来那句校验每次都判失败 ⇒ StartWallpaper 把窗口 Dispose ⇒
    ///   桌面壁纸从来没铺上过，而且外面看只是"什么也没发生"。
    /// </summary>
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    private const uint GA_PARENT = 1;

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
            if (progman == IntPtr.Zero) return Fail("找不到 Progman");

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

            if (defView == IntPtr.Zero) return Fail("找不到 SHELLDLL_DefView");

            IntPtr worker = IntPtr.Zero;
            if (defHost != IntPtr.Zero && defHost != progman)
                worker = FindWindowEx(IntPtr.Zero, defHost, "WorkerW", null);   // 甲

            if (worker == IntPtr.Zero)
            {
                IntPtr parent = GetParent(defView);                            // 乙
                if (parent != IntPtr.Zero)
                    worker = FindWindowEx(parent, defView, "WorkerW", null);     // ★ 排在 DefView 之后 = 在图标底下
            }

            if (worker == IntPtr.Zero) return Fail("找不到可挂的 WorkerW");

            // ★ 2026-10-16 修（审核条目 10）：原来不判 SetParent 的返回值。
            //   它失败时返回 Zero（且置上 Win32 错误码），那时候后面那句 SetWindowPos 照跑，
            //   于是"没挂上去"被当成"挂上了" —— 壁纸层变成一个**浮在桌面上的普通窗口**：
            //   盖住图标、抢焦点，而上层以为一切正常（Attach() 返回 true）。
            //   ⇒ 挂不上就老实说挂不上，让调用方退回"不铺壁纸"。
            IntPtr prev = SetParent(Handle, worker);
            int err = Marshal.GetLastWin32Error();
            IntPtr nowParent = GetAncestor(Handle, GA_PARENT);
            Dbg.Log("AttachToDesktop: SetParent 返回 prev=" + prev + " lastError=" + err
                    + "，随后 GA_PARENT=" + nowParent + "，目标 worker=" + worker);
            if (prev == IntPtr.Zero && err != 0) return Fail("SetParent 失败（Win32 错误 " + err + "）");

            Rectangle v = SystemInformation.VirtualScreen;
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, v.Width, v.Height,
                         SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
            // ★ 同理：铺完再确认一次，祖先是刚才那个 WorkerW（不能用 GetParent，见上面 DllImport 注释）。
            if (GetAncestor(Handle, GA_PARENT) != worker) return Fail("挂上了，但 GA_PARENT 不是那个 WorkerW");
            Dbg.Log("AttachToDesktop: OK（progman=" + progman + " defView=" + defView
                    + " worker=" + worker + " 屏幕=" + v.Width + "x" + v.Height + "）");
            return true;
        }
        catch (Exception ex) { Dbg.Log("AttachToDesktop: 抛异常 " + Dbg.Ex(ex)); return false; }
    }

    private static bool Fail(string why)
    {
        Dbg.Log("AttachToDesktop: " + why + " ⇒ 不铺壁纸");
        return false;
    }

    /// <summary>建好窗口但先不显示，等挂上桌面那一层再显示。</summary>
    public bool Attach()
    {
        IntPtr handle = Handle;        // 逼出窗体句柄
        if (handle == IntPtr.Zero) return Fail("窗体句柄没建出来");
        return AttachToDesktop();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web?.Dispose();
        base.Dispose(disposing);
    }
}
