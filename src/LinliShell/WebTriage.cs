using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace LinliLetters;

/// <summary>
/// 内核某个进程退出时，宿主该做什么。
/// ★ <c>Ignore</c> 是这条链上最重要的一档 —— 见 <see cref="WebTriage.Decide"/> 的注释。
/// </summary>
internal enum ProcessFailedAction
{
    /// <summary>什么都不做：内核自己会把它拉起来。</summary>
    Ignore,

    /// <summary>页面那层没了/卡住，reload 一次（浏览器进程还活着，不必换控件）。</summary>
    Reload,

    /// <summary>只有浏览器进程整个没了才走这一档：换掉控件重来。</summary>
    Rebuild,
}

/// <summary>
/// WebView2 的「进程出事」分诊表 —— 纯判断，三层界面（主窗口 / 壁纸层 / 桌面圆钮）共用一份。
///
/// ★★ 为什么要有这个文件（2026-10-19 第十九轮审查，那个纯黑窗口的直接原因）：
///   原来三层各自把 <c>ProcessFailed</c> 处理成「渲染进程就 Reload，其余一律换控件重建」。
///   可 WebView2 会**自己重启** GPU 进程与各种 Utility 进程（网络/存储/音频），
///   这些退出本来连用户都察觉不到；换控件是要把窗口句柄、内核环境整套推倒重来的重活，
///   而且在崩溃回调里同步做必然失败（实测 <c>0x80070578 无效的窗口句柄</c>）。
///   结果是：本机一次 GPU 抖动 ⇒ 重建 ⇒ 失败 ⇒ 再崩 ⇒ …… 4 秒烧光 3 次额度，
///   主窗口定格在一块 #121214 的纯黑上，连一句解释都没有。
///
///   正确的分诊只有三档：
///     - 浏览器进程没了   ⇒ 换控件（唯一必须重建的情形）
///     - 渲染进程没了/卡住 ⇒ Reload
///     - 其余（GPU / Utility / 其它辅助进程）⇒ **什么都不做**
/// </summary>
internal static class WebTriage
{
    /// <summary>同一波崩溃里，两次重建之间的最小间隔（毫秒）。
    /// ★ 崩溃是成簇来的：一个进程退出往往会在几十毫秒内连报好几次，
    ///   没有这个间隔就会在同一簇里把额度全烧光。</summary>
    public const int CoolDownMs = 2500;

    /// <summary>
    /// 沙箱降级参数。
    /// ★ 2026-10-19 深夜实测：Chromium 的沙箱一旦被安全软件（本机是卡巴斯基的行为检测）
    ///   拦住，GPU / Utility 子进程就会启动即崩 —— 空白页空白工程也一样崩，
    ///   而带上 `--no-sandbox` 后 40 秒零崩溃。所以这是"沙箱不可用"时的正当降级。
    /// ★ 只在**确认沙箱起不来之后**才加（渐进降级），默认仍然是带沙箱的最安全配置。
    /// </summary>
    public const string NoSandboxArg = "--no-sandbox";

    /// <summary>记着"这台机器上沙箱起不来"的那个小文件（放在数据目录里，和信件一个待遇）。</summary>
    private static string FlagFile =>
        System.IO.Path.Combine(System.Environment.GetFolderPath(
            System.Environment.SpecialFolder.ApplicationData), "LinliLetters", "webview2-flags.txt");

    /// <summary>
    /// 上次是不是靠脱沙箱才跑起来的。
    /// ★ 为什么记：不记的话每次启动都要先崩一阵才切换 —— 用户看到的就是"开屏黑几秒"。
    ///   记下来之后，第二次启动直接按脱沙箱建内核，开屏不再黑。
    /// </summary>
    public static bool NoSandboxRemembered()
    {
        try
        {
            return System.IO.File.Exists(FlagFile)
                   && System.IO.File.ReadAllText(FlagFile).Contains(NoSandboxArg);
        }
        catch { return false; }
    }

    /// <summary>脱沙箱之后确实跑起来了 ⇒ 记下来，下次别再崩一遍。</summary>
    public static void RememberNoSandbox()
    {
        try
        {
            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(FlagFile));
            System.IO.File.WriteAllText(FlagFile, NoSandboxArg + "  # 上次本机沙箱起不来，脱沙箱才跑起来");
        }
        catch { /* 记不了就算了，最多是下次再崩一阵 */ }
    }

    /// <summary>
    /// ★ 2026-10-20 补的另一半：原来只记"沙箱起不来"，从不记"沙箱能用"——
    ///   于是**首次启动**没有任何依据，启动动画（splash）只能带沙箱试错，
    ///   一试就崩 ⇒ 用户看到"黑屏几秒、动画都显示不出来"。
    ///   记下"沙箱是好的"之后，splash 才知道可以放心带沙箱；没记录时它按"未知"处理
    ///   （见 SplashWindow：未知 ⇒ 保守脱沙箱，先把动画画出来）。
    /// </summary>
    public static bool SandboxOkRemembered()
    {
        try
        {
            return System.IO.File.Exists(FlagFile)
                   && System.IO.File.ReadAllText(FlagFile).Contains(SandboxOkFlag);
        }
        catch { return false; }
    }

    /// <summary>带沙箱也好好跑起来了 ⇒ 记下来（写之前先确保文件存在）。</summary>
    public static void RememberSandboxOk()
    {
        try
        {
            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(FlagFile));
            // 已经有"脱沙箱"结论时不要覆盖它 —— 那是以实测崩过为代价的结论。
            if (NoSandboxRemembered()) return;
            System.IO.File.WriteAllText(FlagFile, SandboxOkFlag + "  # 上次本机沙箱正常，无需脱沙箱");
        }
        catch { /* 记不了就算了 */ }
    }

    /// <summary>旗标里表示"沙箱能用"的那一行。</summary>
    private const string SandboxOkFlag = "sandbox-ok";

    public static ProcessFailedAction Decide(CoreWebView2ProcessFailedKind kind)
    {
        switch (kind)
        {
            // 浏览器进程是整个 WebView2 的心脏。它没了，控件就真的废了 ⇒ 只能换一个。
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                return ProcessFailedAction.Rebuild;

            // 页面那一层没了或卡住：浏览器进程还活着，Reload 就能救回来。
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                return ProcessFailedAction.Reload;

            // ★ GPU 进程、Utility 进程（网络/存储/音频等）、以及任何将来新增的辅助进程：
            //   内核会自己把它们拉起来，宿主一旦动手反而会把好控件打死。
            //   ⇒ 什么都不做，只记一行日志。
            default:
                return ProcessFailedAction.Ignore;
        }
    }

    /// <summary>日志用的稳定短名（别写在别处拼字符串，grep 的时候要对得上）。</summary>
    public static string Name(ProcessFailedAction action) => action switch
    {
        ProcessFailedAction.Ignore => "ignore",
        ProcessFailedAction.Reload => "reload",
        ProcessFailedAction.Rebuild => "rebuild",
        _ => "unknown",
    };

    // ---------------------------------------------------------------- 渲染冻结：先等它缓过来

    /// <summary>
    /// RenderProcessUnresponsive 的「先等它缓过来」参数（2026-10-20 第二十四轮，黑屏根因）。
    /// ★ 实测证据链（shell.log + CDP 探针 + 无头 Edge 心跳对照，都在
    ///   analysis/_audit22/）：
    ///   ① 开机后约 30 秒，三层界面（主窗口/壁纸层/圆钮）的渲染进程主线程**同时**
    ///      冻结（06:01:46.254/.295/.312 三层同一瞬间的 RenderProcessUnresponsive）；
    ///   ② 冻结的渲染进程**没有任何线程被 OS 挂起**、CDP 的 Debugger 也连得上，
    ///      十几秒后**自己缓过来**（06:02:40 探活 1+1=2）；
    ///   ③ 同一页面同一服务器，在带沙箱的无头 Edge 里 70 秒心跳一秒不落；
    ///      只有真外壳里冻 ⇒ 病不在页面代码，在「无沙箱渲染进程被安全软件批量扫描」。
    ///   原来的处置一收到 Unresponsive 立刻 Reload：控件此时已不可用（实测必抛
    ///   `control is disposed` << 0x8007139F）⇒ 必落到重建 ⇒ 新渲染进程 30 秒后
    ///   又被冻 ⇒ 额度烧光 ⇒ 壁纸层被撤 / 主窗口进死路 —— 用户看到的「黑屏」。
    /// </summary>
    public const int UnresponsiveRecheckMs = 20_000;

    /// <summary>探活用的 ExecuteScript 竞速超时：渲染冻结中它不会返回。</summary>
    public const int ProbeTimeoutMs = 5_000;

    /// <summary>只有渲染进程「卡住没死」才值得等它缓过来；进程真退出了按原分诊走。</summary>
    public static bool IsUnresponsive(CoreWebView2ProcessFailedKind kind) =>
        kind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive;

    /// <summary>探活：主线程还能执行脚本 ⇒ 已经缓过来。冻结中 / 控件没了 ⇒ false。</summary>
    public static async Task<bool> ProbeResponsiveAsync(CoreWebView2 core)
    {
        try
        {
            var task = core.ExecuteScriptAsync("1");
            var done = await Task.WhenAny(task, Task.Delay(ProbeTimeoutMs));
            return done == task;
        }
        catch { return false; }
    }

    /// <summary>这一档是不是「放着不管」（给测试与日志用）。</summary>
    public static bool IsSelfHealing(CoreWebView2ProcessFailedKind kind) =>
        Decide(kind) == ProcessFailedAction.Ignore;
}

/// <summary>
/// 重建预算：**滑动窗口**，不再是"这辈子累计"。
///
/// ★ 原来的写法是 <c>private int _rebuilds;</c> 只增不减 —— 意味着程序跑上一天，
///   只要内核零零散散崩够三次，主窗口就永久停在死路上，唯一出路是重启程序。
///   现在改成：窗口期内累计；并且只要页面**成功导航**一次就清零（证明控件真的在正常工作）。
/// </summary>
internal sealed class RebuildBudget
{
    private readonly List<DateTime> _hits = new();
    private DateTime _last = DateTime.MinValue;

    /// <param name="max">窗口期内允许重建的次数。</param>
    /// <param name="window">滑动窗口长度。</param>
    /// <param name="coolDown">同簇崩溃的最小重建间隔。</param>
    public RebuildBudget(int max, TimeSpan window, TimeSpan coolDown)
    {
        Max = Math.Max(1, max);
        Window = window;
        CoolDown = coolDown;
    }

    public int Max { get; }
    public TimeSpan Window { get; }
    public TimeSpan CoolDown { get; }

    /// <summary>窗口期内已经用掉几次。</summary>
    public int Used
    {
        get { Prune(); return _hits.Count; }
    }

    /// <summary>还有没有额度（只看不算，不消耗）。</summary>
    public bool HasRoom() => Used < Max;

    /// <summary>
    /// 取一次额度。冷却期内不给 —— 冷却是专门用来吸收"崩溃成簇"的：
    /// 一个内核进程退出往往连报好几次，不该被算成好几次独立的故障。
    /// </summary>
    public bool TryTake()
    {
        Prune();
        var now = DateTime.UtcNow;
        if (_hits.Count >= Max) return false;
        if ((now - _last) < CoolDown) return false;
        _hits.Add(now);
        _last = now;
        return true;
    }

    /// <summary>页面成功导航 ⇒ 控件确实在正常干活 ⇒ 以前的账一笔勾销。</summary>
    public void NoteHealthy()
    {
        _hits.Clear();
        _last = DateTime.MinValue;
    }

    private void Prune()
    {
        var edge = DateTime.UtcNow - Window;
        _hits.RemoveAll(t => t < edge);
    }
}
