// 暴露给页面（AddHostObjectToScript）的外壳小能力。
//
// ★ 2026-10-20（用户口径）：「曲库指定按钮要能在资源管理器里选文件夹」——
//   网页自己弹不了系统文件夹对话框（WebView2 没有这个 API，HTML input 只能选文件），
//   由外壳把 FolderBrowserDialog 包成 host object 给页面调用（原版就是系统对话框）。
//
// ★ host object 的方法调用会被 WebView2 marshal 回 UI 线程（STA）执行，
//   模态文件夹对话框正好需要 STA —— 与 WinForms 主线程同线程，安全。
//   ShowDialog 自带模态消息泵，等待期间页面与外壳消息照常流转。
//
// ★ 2026-10-20 第二轮（用户口径）：「原版游戏的设置界面是可以让用户选择弹唱视角、状态、
//   显示屏幕、应用行为的……而咱们不行，你弄一下。」其中两件只有外壳能做：
//     开机自启  —— 写 HKCU 的 Run 项（安装程序 install.iss 写的就是那一项，
//                  值名必须一致，否则会多出一个重复的启动项；卸载时 uninsdeletevalue 清的是同一个名）。
//     显示屏幕  —— 枚举 Screen.AllScreens 给设置页下拉，选中后把壁纸层 / 桌面圆钮 /
//                  主窗口搬到那块屏（都是普通顶层窗口或 WorkerW 子窗口，100% 可控）。
//   落盘位置在 App.DataDir（%APPDATA%\LinliLetters），用户数据区，卸载不动它。

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LinliLetters;

// ★ 2026-10-20 第一版是 internal sealed，真机一启动就
//   「WebView2 起不来：ArgumentException: Value does not fall within the expected range」
//   ⇒ 整个内核初始化被 catch 判死、直接退浏览器（用户截图：程序跑到了 Edge 里）。
//   WebView2 的 AddHostObjectToScript 要给 host object 包一层 COM IDispatch，
//   类型必须 COM 可见 —— internal 类型包装失败就抛 E_INVALIDARG。
//   修法：public + [ComVisible(true)]。
[ComVisible(true)]
public sealed class ShellBridge
{
    /// <summary>
    /// 弹系统「选择文件夹」对话框。用户取消/直接关掉返回空串（页面据此不动）。
    /// </summary>
    public string PickFolder(string title)
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = string.IsNullOrWhiteSpace(title) ? "选择文件夹" : title,
            ShowNewFolderButton = true,
            UseDescriptionForTitle = true,
        };
        return dlg.ShowDialog() == DialogResult.OK ? dlg.SelectedPath : "";
    }

    // ---------------------------------------------------------------- 开机自启动

    /// <summary>Run 项的值名。必须与 install.iss 的 `ValueName: "{#MyAppName}"` 一致
    /// （那里 MyAppName = "OliviaSoul-community独立版"）—— 不一致就会同时存在两个启动项，
    /// 用户在任务管理器→启动应用里看到两行，卸也卸不干净。</summary>
    private const string RunValueName = "OliviaSoul-community独立版";
    private const string RunSubKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>"on" / "off"。读不出来按"没设"算（设置页据此显示未勾选）。</summary>
    public string GetAutostart()
    {
        try
        {
            using RegistryKey k = Registry.CurrentUser.OpenSubKey(RunSubKey, false);
            var v = k?.GetValue(RunValueName) as string;
            return string.IsNullOrEmpty(v) ? "off" : "on";
        }
        catch
        {
            return "off";
        }
    }

    /// <summary>写 / 删 HKCU Run 项。回 "ok" 或 "err:原因"（页面弹给用户，不静默）。</summary>
    public string SetAutostart(bool on)
    {
        try
        {
            using RegistryKey k = Registry.CurrentUser.OpenSubKey(RunSubKey, true);
            if (k == null) return "err:打不开开机启动项（注册表）";
            if (on)
            {
                // 值与安装程序写的同构： exe 路径 + --startup（开机只进托盘、不弹窗口）。
                string exe = Application.ExecutablePath;
                k.SetValue(RunValueName, "\"" + exe + "\" --startup", RegistryValueKind.String);
            }
            else
            {
                k.DeleteValue(RunValueName, false);   // false = 没有也不算错
            }
            return "ok";
        }
        catch (Exception ex)
        {
            return "err:" + ex.Message;
        }
    }

    // ---------------------------------------------------------------- 显示屏幕

    /// <summary>屏幕偏好落在这里（空 = 默认铺满桌面）。跟 dock-pos.txt 一个目录、一套口径。</summary>
    private static string ScreenFile => Path.Combine(App.DataDir, "screen.txt");

    /// <summary>
    /// 当前选中的屏幕设备名（如 \\.\DISPLAY2）；空串 = 默认（铺满整个桌面）。
    /// </summary>
    public string GetScreen()
    {
        try { return File.Exists(ScreenFile) ? File.ReadAllText(ScreenFile).Trim() : ""; }
        catch { return ""; }
    }

    /// <summary>
    /// 枚举全部屏幕，回「名字|左|上|宽|高|是否主屏;…」。
    /// ★ 为什么不用 JSON：DeviceName 里全是反斜杠（\\.\DISPLAY1），手拼 JSON
    ///   转义容易漏；竖线分隔对这些名字永远安全（设备名里不会有 | 或 ;）。
    /// </summary>
    public string ListScreens()
    {
        var rows = new System.Collections.Generic.List<string>();
        foreach (var s in Screen.AllScreens)
        {
            rows.Add(string.Join("|",
                s.DeviceName, s.Bounds.Left, s.Bounds.Top, s.Bounds.Width, s.Bounds.Height,
                s.Primary ? "1" : "0"));
        }
        return string.Join(";", rows);
    }

    /// <summary>
    /// 换屏幕：先落盘（下次启动还认这块），再让 Program 把三层窗口搬过去。
    /// 空名 = 恢复默认（壁纸层铺满整个桌面）。
    /// </summary>
    public string SetScreen(string name)
    {
        try
        {
            Directory.CreateDirectory(App.DataDir);
            File.WriteAllText(ScreenFile, name ?? "");
        }
        catch (Exception ex)
        {
            return "err:" + ex.Message;
        }
        try
        {
            ApplyScreen?.Invoke(name ?? "");
        }
        catch (Exception ex)
        {
            return "err:" + ex.Message;
        }
        return "ok";
    }

    /// <summary>
    /// Program 启动时赋值一次：屏幕偏好换好了，把壁纸层 / 桌面圆钮 / 主窗口搬过去。
    /// ★ 静态而不是实例事件：host object 每次重建内核都会 new 一个（MainWindow.InitWebAsync），
    ///   挂在实例上会随重建丢掉；而"现在铺着哪几层窗口"是进程级的事。
    /// </summary>
    public static Action<string> ApplyScreen;
}
