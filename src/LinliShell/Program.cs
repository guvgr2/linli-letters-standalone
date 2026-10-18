// 「OliviaSoul-community独立版」外壳。
//
// 职责只有三件：自检 → 拉起内置 Node 跑本机服务 → 用 WebView2 打开界面 → 退出时把 Node 收干净。
// 不做业务逻辑，不碰信件内容。
//
// 为什么用 WebView2 Runtime（不再是 Edge 的 --app=）：界面要靠 backdrop-filter 做玻璃质感，
// 只有浏览器引擎能渲染；用系统里自带的 WebView2 Runtime，不必再打包一个几十 MB 的内核。
// 没有 WebView2 Runtime 时退回默认浏览器，功能一样，只是没有独立窗口。
//
// ★ 开机自启动（安装程序写的 Run 项带了 --startup）：只进托盘、不弹窗口。
//   自己双击打开才是"要用它"，开机被拉起来只是"让它待命" —— 不该一开机就糊一个窗口到脸上。
//
// ★ 自检：启动动画在放的那几秒不是干等，是在挨个查"能不能真的用起来"。
//   查不过就别进界面 —— 进去了也是一片空白，那比报错更让人懵。
//   每一条失败都有一个**固定代号 + 一句人话 + 一个能自己动手修的办法**（对位竞品
//   Install.ps1 的 Get-SafeSetupErrorCode：用户把代号报过来就能对上号，不用猜是哪一步）。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LinliLetters;

internal static class Program
{
    // ★ 安装程序用这个互斥量认出"林离正在跑"，装之前先请它退出（install.iss 的 AppMutex）。
    private const string AppMutexName = App.MutexName;

    private static NotifyIcon _tray;
    private static Process _node;
    /// <summary>正在主动收摊（正常退出）。为的是把"我叫它退的"和"它自己死了"分开。</summary>
    private static volatile bool _shuttingDown;
    /// <summary>装着 node 的作业对象句柄。句柄一关（含外壳被强杀）⇒ 系统替我们杀掉组内进程。</summary>
    private static IntPtr _nodeJob = IntPtr.Zero;
    private static string _url;
    private static Mutex _single;
    private static MainWindow _window;
    private static WallpaperHost _wall;
    private static SplashWindow _splash;
    private static Stopwatch _splashAge;      // 动画已经放了多久（1.6 秒下限 / 6 秒上限都看它）

    [STAThread]
    private static void Main(string[] args)
    {
        // ★ 2026-10-18：DPI 感知必须自己声明，而且必须在**任何窗口创建之前**。
        //   抓证据的过程：本机物理屏 2560×1600 @150%（缩放），可窗口怎么算都不对 ——
        //   曾以为 Screen.WorkingArea 报的是逻辑像素、于是乘除 DPI 系数，连错三轮（历史见
        //   MainWindow.cs 里那段）。真正的根因在这里：csproj 写了
        //   <ApplicationHighDpiMode>PerMonitorV2</ApplicationHighDpiMode>，可那个 MSBuild
        //   属性只对 ApplicationConfiguration.Initialize() 生成器生效，而这个程序用的是
        //   手写 Main + Application.EnableVisualStyles()，生成器根本没参与 ⇒ 进程是
        //   DPI-unaware ⇒ 系统把整块画面按 150% 拉大，Windows 看到的和窗口用到的不是同一套
        //   坐标，怎么算都对不上。
        //   PerMonitorV2：跨屏拖动时按各屏自己的缩放重算，Windows 原生应用的标准选择。
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool startup = Array.Exists(args ?? Array.Empty<string>(),
            a => string.Equals(a, "--startup", StringComparison.OrdinalIgnoreCase));

        // 只允许一个实例。第二个实例把已经开着的那一个叫醒就够了。
        // ★ LINLI_MUTEX 是**测试用的口子**：自动化要验证"窗口到底出不出来"时，
        //   用户那份可能正开着，第二个实例会被这个互斥量挡在门外、静默退出，
        //   看起来就像"窗口没出来"。换个名字就能另起一个，互不干扰。
        //   （和 LINLI_PORT 同一个套路；不设这个变量就还是默认的那个名字。）
        string mutexName = Environment.GetEnvironmentVariable("LINLI_MUTEX") ?? AppMutexName;
        _single = new Mutex(true, mutexName, out bool owned);
        if (!owned)
        {
            _single.Dispose();
            _single = null;
            if (!startup) Native.BringExistingToFront();
            return;                       // 已经在跑了 —— 静默退出，不弹"已在运行"的框
        }

        string appDir = ResolveAppDir();
        string nodeExe = Path.Combine(appDir, "runtime", "node", "node.exe");
        string server = Path.Combine(appDir, "app", "server.mjs");

        // ★ 启动动画必须**在自检之前**就出来：起 Node 那一两秒才是它最该盖住的空档，
        //   等窗口出来再放就等于没有。--startup（开机自启）不放 —— 那条路只进托盘。
        if (!startup) ShowSplash(appDir);

        Check check = Preflight.Run(appDir, nodeExe, server);
        if (!check.Ok)
        {
            Report(check, null);
            _single?.ReleaseMutex();
            return;
        }
        _splash?.SetStage(1, "这台机器可以用。");   // 第 1 拍：预检

        if (!StartNode(nodeExe, server, appDir, out int port, out Check nodeErr))
        {
            Report(nodeErr, null);
            _single?.ReleaseMutex();
            return;
        }

        _url = $"http://127.0.0.1:{port}/";
        _splash?.SetStage(2, "运行时起来了。");     // 第 2 拍：起运行时

        // ★ 服务起来了 ≠ 能用。再探一次 /health，确认它真的在应答。
        Check health = WaitForHealth(port, TimeSpan.FromSeconds(15));
        if (!health.Ok)
        {
            Report(health, _url);
            KillNode();
            _single?.ReleaseMutex();
            return;
        }
        _splash?.SetStage(3, "她应声了。");         // 第 3 拍：探服务

        // ★ 三步都过了 ⇒ 让她放飞。动画有下限（1.6 秒）也有上限（6 秒）。
        CloseSplash();

        BuildTray(appDir);
        StartWallpaper();                 // 桌面壁纸：开机自启动也要铺，它就是"待命"时的样子
        if (!startup) OpenWindow();       // --startup ⇒ 只进托盘
        Application.Run();

        _single?.ReleaseMutex();
    }

    // ---------------------------------------------------------------- 启动动画

    /// <summary>
    /// 把启动动画放出来。
    /// ★ 页面读不到 / WebView2 起不来时，SplashWindow 自己退化成一句「正在打开……」，
    ///   这里也不许抛 —— 启动画面上蹦一个报错框，比没有动画更让人懵。
    /// </summary>
    private static void ShowSplash(string appDir)
    {
        try
        {
            _splash = new SplashWindow(appDir);
            _splash.Show();
            _splashAge = Stopwatch.StartNew();
            Application.DoEvents();            // 先把窗体真的画出来，再去跑自检
        }
        catch
        {
            try { _splash?.Dispose(); } catch { /* 已经没了 */ }
            _splash = null;
        }
    }

    /// <summary>
    /// 收掉启动动画。
    /// ★ 有下限也有上限：至少放 <b>1.6 秒</b>（再快就等于闪一下，等于没有），
    ///   最多 <b>6 秒</b>（用户机器的 Node 再慢也不能把人晾在那儿 —— 到点就走）。
    /// ★ playOut=false 用在失败分支：报错框要立刻出来，不该再等动画放完。
    /// </summary>
    private static void CloseSplash(bool playOut = true)
    {
        if (_splash == null) return;
        try
        {
            if (playOut)
            {
                long age = _splashAge?.ElapsedMilliseconds ?? 0;
                if (age < 1600) PumpWait((int)(1600 - age));
                _splash.Finish();               // 折飞机 + 飞走；跑完页面自己报回来
                while (!_splash.Done && (_splashAge?.ElapsedMilliseconds ?? 0) < 6000)
                    PumpWait(40);
            }
        }
        catch { /* 收不掉就算了，主窗口照样要出来 */ }
        try { _splash.Close(); _splash.Dispose(); } catch { /* 退出时不纠缠 */ }
        _splash = null;
    }

    /// <summary>
    /// ★★ 泵着消息等：<c>Application.DoEvents()</c> + 短暂 Sleep。
    ///   原来这几处都是 <c>ready.Wait(...)</c> / <c>Thread.Sleep(...)</c> —— **阻塞 UI 线程**，
    ///   splash 于是冻在那儿不动，动画等于没放。
    ///   改成"边等边泵"是最小改动：等待之外的逻辑一行没动，也不引入新线程。
    /// </summary>
    private static void PumpWait(int ms)
    {
        if (ms <= 0) return;
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            Application.DoEvents();
            int left = (int)(ms - sw.ElapsedMilliseconds);
            Thread.Sleep(Math.Min(15, Math.Max(1, left)));
        }
    }

    /// <summary>等一个信号，等的同时泵消息（同上）。</summary>
    private static bool WaitPumped(ManualResetEventSlim ev, TimeSpan limit)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < limit)
        {
            if (ev.Wait(40)) return true;
            Application.DoEvents();
        }
        return ev.IsSet;
    }

    // ---------------------------------------------------------------- 桌面壁纸

    /// <summary>桌面壁纸的开关记在数据目录里。没这个文件 = 默认开（这就是这个程序的样子）。</summary>
    private static string StageFlagPath => Path.Combine(App.DataDir, "desktop-stage.txt");

    private static bool StageEnabled()
    {
        try { return File.ReadAllText(StageFlagPath).Trim() != "0"; }
        catch { return true; }
    }

    private static void SetStageEnabled(bool on)
    {
        try
        {
            Directory.CreateDirectory(App.DataDir);
            File.WriteAllText(StageFlagPath, on ? "1" : "0");
        }
        catch { /* 写不进去就算了，这次开着照样生效，下次打开回到默认 */ }
    }

    /// <summary>
    /// 有没有曲子可播。
    /// ★ 没有就**根本不往桌面上铺窗口** —— 铺上去是一个空窗口，用户看到的就是桌面被糊了一块。
    ///   （页面那边也有 state:off 兜底：铺上去之后才发现没曲子，会自己请外壳关掉。）
    /// </summary>
    private static bool HasStageVideo()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(_url + "api/stage/next");
            req.Timeout = 4000;
            req.ServicePoint.Expect100Continue = false;
            using var resp = (HttpWebResponse)req.GetResponse();
            using var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8);
            using var doc = System.Text.Json.JsonDocument.Parse(reader.ReadToEnd());
            return doc.RootElement.TryGetProperty("url", out var u) && u.ValueKind == System.Text.Json.JsonValueKind.String;
        }
        catch { return false; }
    }

    private static void StartWallpaper()
    {
        if (_wall != null) return;
        if (!StageEnabled()) return;
        if (!HasStageVideo()) return;     // 曲库是空的 ⇒ 一点也不动用户的桌面
        try
        {
            _wall = new WallpaperHost(_url + "wallpaper.html");
            _wall.OpenPageRequested += (_, page) =>
            {
                OpenWindow();             // 主窗口可能还没建：先建，再让它翻到那一页
                _window?.Go(page);
            };
            // ★ Attach() 只是把窗口 SetParent 到桌面（含 SetWindowPos SWP_SHOWWINDOW），
            //   但 **Win32 的 SWP_SHOWWINDOW 不会触发 WinForms 的 Load 事件** ——
            //   Load 走的是托管路径 SetVisibleCore → OnLoad，SetParent 进来时窗口已创建，
            //   不会再走一遍。而 WallpaperHost 的 WebView2 创建与 Navigate 整段挂在 Load 里
            //   ⇒ 少了这一句 Show()，桌面就被一块「已挂到桌面层、但里面没内容」的纯黑
            //   矩形盖住，且页面侧的兜底（没曲子请外壳关窗）挂在 WebMessageReceived 上、
            //   页面根本没加载 ⇒ 不会自愈，直到用户退出。
            //   （实测：.NET 探针 f.Handle → SetParent → SetWindowPos(SWP_SHOWWINDOW)
            //    → 20×DoEvents ⇒ loadFired=False；补一次 Show() 后 loadFired=True。）
            if (!_wall.Attach())          // 挂不上桌面（多半是 Explorer 没在）⇒ 当没这回事
            {
                _wall.Dispose();
                _wall = null;
            }
            else _wall.Show();            // ★ 必须在 Attach() 之后：Load 依赖这一次可见化
        }
        catch
        {
            if (_wall != null) { try { _wall.Dispose(); } catch { /* 已经没了 */ } }
            _wall = null;
        }
    }

    private static void StopWallpaper()
    {
        if (_wall == null) return;
        try { _wall.Dispose(); } catch { /* 退出时不纠缠 */ }
        _wall = null;
    }

    // ---------------------------------------------------------------- 自检

    private static Check WaitForHealth(int port, TimeSpan limit)
    {
        var sw = Stopwatch.StartNew();
        Exception last = null;
        while (sw.Elapsed < limit)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{port}/health");
                req.Timeout = 2000;
                req.ServicePoint.Expect100Continue = false;
                using var resp = (HttpWebResponse)req.GetResponse();
                if ((int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300)
                    return Check.Pass();
            }
            catch (Exception ex)
            {
                last = ex;
                PumpWait(400);                // ★ 干等会让启动动画冻住，改成边等边泵消息
            }
        }
        return Check.Fail("E-HEALTH-NO-ANSWER",
            "服务起来了，但它一直没回应。",
            "通常是端口被安全软件拦了，或者上一次的林离没退干净。\n" +
            "试试：退出托盘里的林离再打开一次；还不行就把安全软件里 127.0.0.1 的本机连接放行。",
            last?.Message);
    }

    private static void Report(Check c, string url)
    {
        CloseSplash(false);                   // ★ 先把动画收掉再弹框，否则动画会糊在报错框后面
        var text = new StringBuilder();
        text.AppendLine(c.Title);
        text.AppendLine();
        text.AppendLine(c.Detail);
        if (!string.IsNullOrWhiteSpace(c.Fix))
        {
            text.AppendLine();
            text.AppendLine("可以这样做：");
            text.AppendLine(c.Fix);
        }
        if (!string.IsNullOrWhiteSpace(c.Technical))
        {
            text.AppendLine();
            text.AppendLine("（给排查用的原始信息：" + c.Technical + "）");
        }
        if (!string.IsNullOrEmpty(url))
        {
            text.AppendLine();
            text.AppendLine("服务地址是 " + url + "，也可以自己用浏览器打开看看。");
        }
        text.AppendLine();
        text.Append("错误代号：" + c.Code);

        MessageBox.Show(text.ToString(), "OliviaSoul-community独立版 · 没能起来",
            MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    // ---------------------------------------------------------------- 起 Node

    private static string ResolveAppDir()
    {
        // 发布形态：LinliLetters.exe 在 <root>\ 下，app\ 与 runtime\ 与它同级。
        string exeDir = AppContext.BaseDirectory;
        for (int i = 0; i < 4; i++)
        {
            string candidate = exeDir;
            if (File.Exists(Path.Combine(candidate, "app", "server.mjs"))) return candidate;
            DirectoryInfo parent = Directory.GetParent(candidate);
            if (parent == null) break;
            exeDir = parent.FullName;
        }
        return AppContext.BaseDirectory;
    }

    private static bool StartNode(string nodeExe, string server, string appDir, out int port, out Check error)
    {
        port = 0;
        error = null;
        var info = new ProcessStartInfo(nodeExe)
        {
            Arguments = $"\"{server}\"",
            WorkingDirectory = Path.Combine(appDir, "app"),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        info.Environment["LINLI_PORT"] = "0";

        var ready = new ManualResetEventSlim(false);
        int foundPort = 0;
        string firstError = null;
        var stderr = new StringBuilder();

        var proc = new Process { StartInfo = info, EnableRaisingEvents = true };
        proc.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            const string marker = "LINLI_PORT=";
            if (e.Data.StartsWith(marker, StringComparison.Ordinal))
            {
                if (int.TryParse(e.Data.Substring(marker.Length).Trim(), out int p)) foundPort = p;
                ready.Set();
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            stderr.AppendLine(e.Data);
            firstError ??= e.Data;
        };

        try
        {
            if (!proc.Start())
            {
                error = Check.Fail("E-NODE-NO-START", "没能拉起内置运行时。",
                    "重装一次就能修好；如果还不行，多半是安全软件把 node.exe 隔离开了。", "CreateProcess 返回 false");
                return false;
            }
        }
        catch (Exception ex)
        {
            error = Check.Fail("E-NODE-NO-START", "没能拉起内置运行时。",
                "重装一次就能修好；如果还不行，多半是安全软件把 node.exe 隔离开了。", ex.Message);
            return false;
        }

        _node = proc;
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        // ★ 2026-10-16 修（审核条目 10 之三）：这里原来设了 EnableRaisingEvents，却**从来没订阅 Exited**。
        //   服务自己退了（2026-10-16 起致命错误会走 process.exit(1)）时，外壳毫无察觉
        //   ⇒ 窗口还在、界面全废，用户只能靠猜。⇒ 现在听见它退，就如实告诉用户并收摊。
        proc.Exited += (_, _) =>
        {
            if (_shuttingDown) return;
            int code = -1;
            try { code = proc.ExitCode; } catch { }
            try
            {
                if (_tray != null)
                    _tray.ShowBalloonTip(8000, App.Title,
                        "后台服务已经退出（代码 " + code + "），程序即将关闭。\n再打开一次就好；反复出现请重装。",
                        ToolTipIcon.Error);
            }
            catch { }
            try { Application.Exit(); } catch { }
        };

        // ★ 同条：把 node 挂进本进程的作业对象 —— 外壳被强杀时系统替我们收掉它。
        //   不做这一步，用户"结束任务"一次就留一个野 node，第二次打开撞上端口被占。
        AssignNodeToJob(proc);

        // ★ 等端口那 20 秒原来是 ready.Wait(...) 干等 ⇒ UI 线程被堵死、动画是冻的。
        //   换成 WaitPumped：同样的时间上限，等的同时把消息泵出去。
        if (!WaitPumped(ready, TimeSpan.FromSeconds(20)))
        {
            string why = firstError ?? (stderr.Length > 0 ? stderr.ToString() : "（没有任何输出）");
            error = Check.Fail("E-NODE-NO-PORT",
                "内置运行时起来了，但它一直没告诉我们要用哪个端口。",
                "最常见的原因是本机端口被占，或者上一次的林离没退干净、还在后台占着。\n" +
                "试试：退出托盘里的林离，再打开一次。", why);
            KillNode();
            return false;
        }

        port = foundPort;
        if (port <= 0)
        {
            error = Check.Fail("E-NODE-BAD-PORT", "内置运行时报了一个不能用的端口。",
                "重装一次就能修好。", "port=" + foundPort);
            KillNode();
            return false;
        }
        return true;
    }

    // ---- Job Object：外壳没了，node 也必须没 --------------------------------------
    // ★ 2026-10-16 修（审核条目 10 之三）：外壳被任务管理器结束时，它拉起来的 node 会活下来，
    //   占着端口；用户第二次打开只看到"端口被占"，却不知道第一次的进程还活着。
    //   ⇒ 把 node 放进一个"关闭句柄即杀掉组内所有进程"的作业对象里。这个句柄属于外壳，
    //     外壳以任何方式消失（含被强杀），Windows 都会把它关掉 ⇒ node 跟着走。
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static void AssignNodeToJob(Process proc)
    {
        try
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return;                 // 建不出来就不强求，退化为"不托管"
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint len = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, len) ||
                !AssignProcessToJobObject(job, proc.Handle))
            {
                CloseHandle(job);                            // 没配成就别留着这个作业
                return;
            }
            _nodeJob = job;
        }
        catch { /* 托管不上不影响主流程 */ }
    }

    private static void KillNode()
    {
        _shuttingDown = true;
        try
        {
            if (_node != null && !_node.HasExited)
            {
                _node.Kill(true);
                _node.WaitForExit(3000);
            }
        }
        catch { /* 退出时不再纠缠 */ }
        if (_nodeJob != IntPtr.Zero)
        {
            try { CloseHandle(_nodeJob); } catch { }
            _nodeJob = IntPtr.Zero;
        }
        _node = null;
    }

    // ---------------------------------------------------------------- 托盘 / 窗口

    private static void BuildTray(string appDir)
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开", null, (_, _) => OpenWindow());
        menu.Items.Add("打开数据目录", null, (_, _) =>
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LinliLetters");
            if (Directory.Exists(dir)) Process.Start("explorer.exe", dir);
        });
        // ★ 桌面壁纸的开关。默认开 —— 这就是这个程序"在的时候"的样子。
        //   关掉它不该需要卸载：有人就是不想让别人看见自己的桌面在动。
        var stageItem = new ToolStripMenuItem("桌面壁纸层") { CheckOnClick = true, Checked = StageEnabled() };
        stageItem.CheckedChanged += (_, _) =>
        {
            SetStageEnabled(stageItem.Checked);
            if (stageItem.Checked) StartWallpaper(); else StopWallpaper();
        };
        menu.Items.Add(stageItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => Shutdown());

        Icon icon = LoadIcon(appDir);
        _tray = new NotifyIcon { Icon = icon ?? SystemIcons.Application, Text = "OliviaSoul-community独立版", Visible = true, ContextMenuStrip = menu };
        _tray.DoubleClick += (_, _) => OpenWindow();
    }

    private static Icon LoadIcon(string appDir)
    {
        try
        {
            string path = Path.Combine(appDir, "app", "icon.ico");
            return File.Exists(path) ? new Icon(path) : null;
        }
        catch { return null; }
    }

    /// <summary>
    /// 打开主窗口。
    /// ★ 现在是**我们自己的窗口**（MainWindow + WebView2），不再是 Edge 的应用窗口。
    ///   换来三件事：任务栏上是这个程序自己的名字和图标；能真的收进托盘；
    ///   页面能反过来叫它拖动 / 最小化 / 关闭。
    /// ★ 窗口只建一次、之后复用 —— 关掉只是藏起来，不是销毁。
    ///   否则每次"打开"都要重新初始化一次内核（一两秒，而且滚动位置和未读状态都丢）。
    /// </summary>
    private static void OpenWindow()
    {
        try
        {
            if (_window == null || _window.IsDisposed)
            {
                _window = new MainWindow(_url, LoadIcon(ResolveAppDir()));
                _window.RequestHide += (_, _) => HideWindow();
                _window.RequestClose += (_, _) => HideWindow();
                _window.RequestQuit += (_, _) => Shutdown();
                // 设置页那个「桌面壁纸」开关：页面不播视频了，铺/撤桌面那一层归外壳。
                _window.WallpaperRequested += (_, on) =>
                {
                    SetStageEnabled(on);
                    if (on) StartWallpaper(); else StopWallpaper();
                };
                _window.FormClosing += (_, e) =>
                {
                    // Alt+F4 这类系统关闭也按"收进托盘"处理：陪伴类程序不该一点就死。
                    e.Cancel = true;
                    HideWindow();
                };
            }
            if (!_window.Visible) _window.Show();
            if (_window.WindowState == FormWindowState.Minimized) _window.WindowState = FormWindowState.Normal;
            _window.Activate();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"打不开界面：{ex.Message}\n也可以自己打开 {_url}", App.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private static void HideWindow()
    {
        if (_window == null) return;
        _window.Hide();
        // ★ 第一次收进托盘时说一句。不说的话，用户会以为"关掉了 = 没了"，
        //   然后每次都去桌面找图标重开，越开越多实例（虽然第二个只会叫醒第一个）。
        if (_tray != null && !_shownTrayHint)
        {
            _shownTrayHint = true;
            _tray.ShowBalloonTip(4000, App.Title, "我在托盘里。要开的时候点一下就够了。", ToolTipIcon.Info);
        }
    }

    private static bool _shownTrayHint;

    private static void Shutdown()
    {
        KillNode();
        StopWallpaper();                  // 窗口销毁后桌面自动回到原样，不用"恢复壁纸"这类收尾
        if (_window != null && !_window.IsDisposed) { _window.Dispose(); _window = null; }
        if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
        Application.Exit();
    }
}

/// <summary>一条自检结果：代号 + 一句人话 + 一个能自己动手修的办法 + 原始信息。</summary>
internal sealed class Check
{
    public bool Ok { get; private init; }
    public string Code { get; private init; } = "";
    public string Title { get; private init; } = "";
    public string Detail { get; private init; } = "";
    public string Fix { get; private init; } = "";
    public string Technical { get; private init; } = "";

    public static Check Pass() => new() { Ok = true };
    public static Check Fail(string code, string detail, string fix, string technical = null) =>
        new() { Ok = false, Code = code, Title = "林离没能起来。", Detail = detail, Fix = fix, Technical = technical ?? "" };
}

/// <summary>
/// 启动自检：进界面之前先把"能不能真的用"挨个查一遍。
/// 顺序按"最可能出问题、也最好修"排：文件在不在 → 数据目录能不能写 → 浏览器有没有。
/// </summary>
internal static class Preflight
{
    public static Check Run(string appDir, string nodeExe, string server)
    {
        if (!File.Exists(nodeExe) || !File.Exists(server))
        {
            var missing = new StringBuilder();
            if (!File.Exists(nodeExe)) missing.AppendLine(nodeExe);
            if (!File.Exists(server)) missing.AppendLine(server);
            return Check.Fail("E-FILES-MISSING",
                "少了运行要用到的文件。",
                "这一版没装完整，重装一次就好。\n" +
                "如果重装后还是这样，多半是安全软件把这两个文件删了 —— 把安装目录加进白名单再装一次。",
                missing.ToString().TrimEnd());
        }

        // ★ 数据目录写不进去 ⇒ 信写完了存不下。这必须在进界面**之前**说，
        //   等用户在界面里写完一封才发现存不了，那才是真坑。
        string dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LinliLetters");
        try
        {
            Directory.CreateDirectory(dataDir);
            string probe = Path.Combine(dataDir, ".write-probe.tmp");
            File.WriteAllText(probe, "probe");
            File.Delete(probe);
        }
        catch (Exception ex)
        {
            return Check.Fail("E-DATA-DIR-READONLY",
                "你的信件和设置存不进去。",
                $"数据目录是：{dataDir}\n" +
                "它写不进去，多半是被安全软件或磁盘权限挡住了。\n" +
                "把上面这个目录加进安全软件的白名单，或者换个有权限的账户再打开。",
                ex.Message);
        }

        return Check.Pass();
    }
}

/// <summary>第二个实例：把已经开着的那一个叫到前面来（best-effort，叫不动就算了）。</summary>
internal static class Native
{
    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private const int SW_RESTORE = 9;
    private const int SW_SHOW = 5;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public static void BringExistingToFront()
    {
        try
        {
            IntPtr h = FindWindow(null, "OliviaSoul-community独立版");
            if (h == IntPtr.Zero) return;
            // ★ 2026-10-16 修（审核条目 10 之四）：原来只判 IsIconic（最小化）。
            //   我们收进托盘走的是 **Hide**（窗口还在、只是不可见），IsIconic 是 false
            //   ⇒ 那一支什么也不做，直接跳到 SetForegroundWindow，而 Windows 不允许
            //   把前台给一个隐藏窗口 ⇒ **第二次双击图标没反应**。
            //   ⇒ 先判"看不见"，看不见就 Show；再判"最小化"，最小化了才 Restore。
            if (!IsWindowVisible(h)) ShowWindow(h, SW_SHOW);
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            SetForegroundWindow(h);
        }
        catch { /* 叫不动就算了，托盘图标还在 */ }
    }
}
