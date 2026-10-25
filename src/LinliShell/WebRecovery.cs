using System;

namespace LinliLetters;

/// <summary>
/// 「WebView2 起不来的时候到底该做什么」—— 纯判断，不碰任何 UI 或系统调用。
///
/// 为什么单拎出来（2026-10-19 第十六轮审查 §5，advisor 复核）：
///   这段逻辑原来直接写在 <see cref="MainWindow.InitWebAsync"/> 的 catch 里，
///   于是它**只有读代码才能被检查**：正常机器上 WebView2 永远起得来，
///   三档分支里的两档（重建、死路）在真机上根本触发不到，测试也进不去。
///   审查方指出的原话是「这一项修复目前无人验证」—— 它是四条 P1 里唯一没有证据的。
///   抽成纯函数之后，`--check-recovery` 与 `tests\shell-recovery.test.js` 能直接
///   覆盖 0/1/2/3/4 次的每一个决策，不需要真的把内核弄坏。
///
/// ★ 边界口径（改这里之前先想清楚这四句话）：
///   1. 第一次失败（rebuilds==0）：内核可能只是第一次没起来，**退回系统浏览器**最稳 ——
///      功能一样能用，用户不会卡在一块黑屏前。
///   2. 还有重建余量：重来。重建次数由 <c>MaxRebuilds</c> 封顶，避免"起来就崩"死循环。
///   3. 余量用尽：必须给一句人话 + 一条出路（关掉重开），不许静默留在死画面上。
///   4. 负数（坏入参）按 0 处理：宁可先退浏览器，也不要当成"已经重建过很多次"。
/// </summary>
internal enum WebRecoveryAction
{
    /// <summary>退回系统浏览器打开界面（功能一样，只是没有独立窗口）。</summary>
    FallbackBrowser,

    /// <summary>把 WebView2 控件整个换掉再试一次。</summary>
    Rebuild,

    /// <summary>不再重试，把「关掉重开」这一步摆到窗口里。</summary>
    DeadEnd,
}

internal static class WebRecovery
{
    /// <summary>自动重建的上限（与 <see cref="MainWindow"/> 的 _rebuilds 封顶一致）。</summary>
    public const int MaxRebuilds = 3;

    /// <summary>
    /// 已经重建过 <paramref name="rebuilds"/> 次之后，这一次初始化失败该怎么办。
    /// </summary>
    /// <param name="rebuilds">已经成功走过的重建次数（0 表示还没重建过）。</param>
    /// <param name="maxRebuilds">上限，默认 <see cref="MaxRebuilds"/>。</param>
    public static WebRecoveryAction Decide(int rebuilds, int maxRebuilds = MaxRebuilds)
    {
        var used = Math.Max(0, rebuilds);
        var limit = Math.Max(1, maxRebuilds);
        if (used == 0) return WebRecoveryAction.FallbackBrowser;
        if (used >= limit) return WebRecoveryAction.DeadEnd;
        return WebRecoveryAction.Rebuild;
    }

    /// <summary>给日志与自检用的稳定短名（别在日志里写中文，方便 grep）。</summary>
    public static string Name(WebRecoveryAction action) => action switch
    {
        WebRecoveryAction.FallbackBrowser => "fallback-browser",
        WebRecoveryAction.Rebuild => "rebuild",
        WebRecoveryAction.DeadEnd => "dead-end",
        _ => "unknown",
    };

    /// <summary>
    /// 自检模式下要不要**跳过弹窗与外部程序**（`LINLI_FORCE_WEBVIEW_FAIL` 那套会把三档真跑一遍，
    /// 其中第一档会拉起系统浏览器、第三档会弹 MessageBox —— 自动化里这两样都会卡住或扰民）。
    /// 这个判断也放这里，方便一起被测。
    /// </summary>
    public static bool IsSelfCheckRun() =>
        Environment.GetEnvironmentVariable("LINLI_FORCE_WEBVIEW_FAIL") == "1";

    /// <summary>
    /// 要不要把三档**主动推下去**（走完第一档就接着重建，直到死路）。
    /// ★ 与 <see cref="IsSelfCheckRun"/> 分开是必须的：只设 `LINLI_FORCE_WEBVIEW_FAIL=1`
    ///   得到的是「真用户走第一档」那个状态 —— 那条路上不会有任何后续重建，正好用来判断
    ///   别的组件（例如壁纸层）是不是被这次失败连累了。两者混成一个开关就做不了对照组。
    /// </summary>
    public static bool IsSelfCheckChain() =>
        Environment.GetEnvironmentVariable("LINLI_SELF_CHECK_CHAIN") == "1";
}
