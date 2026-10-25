// 排障日志，两路：
//   ① Log()      —— 只在设了 LINLI_DEBUG_MSG=1 时才写，排查具体链路时用，平时一行都不落地。
//   ② Critical() —— 永远开着的"出事日志"（崩溃、内核掉线），落 %APPDATA%\LinliLetters\shell.log。
//
// ★ 为什么外壳需要这么个东西：桌面上铺壁纸、页面发消息给窗口这些链路，
//   失败的表现全都是"什么也没发生" —— 没有异常、没有提示框，界面上完全看不出来断在哪一环。
//   真机跑一遍却找不到原因时，唯一能用的办法就是让每一环自己说一句话。
//   用法：set LINLI_DEBUG_MSG=1 再启动，然后看 %TEMP%\linli-shell.log。

using System;
using System.IO;
using System.Text;

namespace LinliLetters;

internal static class Dbg
{
    private static readonly bool On =
        Environment.GetEnvironmentVariable("LINLI_DEBUG_MSG") == "1";

    private static readonly object Gate = new();

    public static bool Enabled => On;

    public static string Path => System.IO.Path.Combine(System.IO.Path.GetTempPath(), "linli-shell.log");

    /// <summary>
    /// 出事日志落在哪儿。
    ///
    /// ★ 2026-10-20 补：可以用环境变量 LINLI_SHELL_LOG 把这一路指到别处。
    ///   默认还是数据目录里的 shell.log（用户现场那一份完全不受影响）。
    ///   为什么要有这个开关：
    ///     ① 测试隔离 —— 以前 shell-recovery / web-triage 两条用例都去读
    ///        %APPDATA%\LinliLetters\shell.log。两路全量并行时两个用例各写各的、
    ///        读的是同一份文件 ⇒ 一路可能把另一路的日志当成自己的证据（假绿），
    ///        先后顺序也不定（假红）。60 分钟压测里实测到 2/42 次红。
    ///     ② 诊断方便 —— 用户想把出事日志发出来时，可以让它落到自己指定的地方。
    /// </summary>
    public static string LogFile
    {
        get
        {
            string custom = Environment.GetEnvironmentVariable("LINLI_SHELL_LOG");
            if (!string.IsNullOrWhiteSpace(custom)) return custom;
            return System.IO.Path.Combine(App.DataDir, "shell.log");
        }
    }

    /// <summary>
    /// 出事才写的那一路：**永远开着**，落在数据目录里（%APPDATA%\LinliLetters\shell.log）。
    ///
    /// ★ 为什么另开一路：崩溃/内核掉线这类事，用户现场不可能带着 LINLI_DEBUG_MSG=1 去复现。
    ///   上一版只在调试开关打开时写日志，结果用户报「闪退」「卡黑屏」时我们手上一个字节的证据都没有
    ///   —— 事件查看器里只有 .NET 包起来的那条，看不到是哪一环断的。
    ///   这一路只记异常与内核事件，量很小；超过 256 KB 就滚成 shell.log.1，不会长成垃圾。
    /// </summary>
    public static void Critical(string message)
    {
        try
        {
            string file = LogFile;
            lock (Gate)
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file) ?? App.DataDir);
                var fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 256 * 1024)
                {
                    string old = file + ".1";
                    try { if (File.Exists(old)) File.Delete(old); File.Move(file, old); }
                    catch { /* 滚不动就接着往后写 */ }
                }
                File.AppendAllText(file,
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + Environment.NewLine,
                    Encoding.UTF8);
            }
        }
        catch { /* 日志写不进去不该影响程序本身 */ }
    }

    public static void Log(string message)
    {
        if (!On) return;
        try
        {
            lock (Gate)
            {
                File.AppendAllText(Path,
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine,
                    Encoding.UTF8);
            }
        }
        catch { /* 日志写不进去不该影响程序本身 */ }
    }

    /// <summary>把异常摊平成一行：类型 + 消息 + 第一层 InnerException。</summary>
    public static string Ex(Exception ex)
    {
        if (ex == null) return "(null)";
        var sb = new StringBuilder();
        sb.Append(ex.GetType().Name).Append(": ").Append(ex.Message);
        // ★ 2026-10-20 补堆栈首帧：这一轮「ArgumentException: Value does not fall
        //   within the expected range」只有 Message 没法定位是哪一行抛的，查了很久。
        //   堆栈只要第一帧（抛点）就够了，整段太吵。
        var st = ex.StackTrace;
        if (!string.IsNullOrEmpty(st))
        {
            var first = st.Split('\n')[0].Trim();
            sb.Append(" @ ").Append(first);
        }
        if (ex.InnerException != null)
            sb.Append(" << ").Append(ex.InnerException.GetType().Name).Append(": ").Append(ex.InnerException.Message);
        return sb.ToString();
    }
}
