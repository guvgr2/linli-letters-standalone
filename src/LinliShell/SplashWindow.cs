// 「OliviaSoul-community独立版」的启动动画窗口。
//
// ★ 为什么要有它：双击 exe 之后到主窗口出来之间有一两秒（起内置 Node、探 /health），
//   以前就是干等 —— 用户明确抱怨过「启动动画也没有」。现在这几秒由一封纸做的信占着：
//   牛皮纸信封 → 开盖 → 抽信纸 → 摊开 → 落墨 → 盖火漆印 → 折成纸飞机 → 飞走（半路变玻璃飞机）。
//   动画不是假进度：外壳把**真实的三步**（预检 → 起运行时 → 探服务）一拍一拍报进来。
//
// ★ 动画本体是 app\public\splash.html（自包含，不许联网，字体走系统栈）。
//   读不到 / WebView2 起不来 ⇒ **退化成一个纯色窗体 + 一句「正在打开……」**，绝不弹报错框。
//   启动画面上蹦一个错误对话框，比没有动画更让人懵。
//
// ★ 用户数据目录必须和主窗口、壁纸窗口分开：三个 WebView2 共用一个目录会互相锁，
//   第二个就起不来（主窗口 webview2 / 壁纸 webview2-wallpaper / 启动 webview2-splash）。
//
// ★ 不抢焦点（WS_EX_NOACTIVATE）：它是被看的，不是被点的。
//   也不进任务栏、不进 Alt+Tab —— 它只活几秒，不配占一个任务栏位置。

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LinliLetters;

internal sealed class SplashWindow : Form
{
    /// <summary>与 install.iss 的 WizardImageBackColor 同一个色 —— 安装和启动是同一套观感。</summary>
    private static readonly Color Bg = Color.FromArgb(0x16, 0x14, 0x1A);

    private WebView2 _web;
    private bool _done;

    public SplashWindow(string appDir)
    {
        Text = App.Title;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        // ★ 2026-10-18 用户指令「把黑框去掉，只留里面的动画」：
        //   页面背景透明 + WebView2 DefaultBackgroundColor=Transparent 之后，
        //   WebView2 挖空的像素透出的是**窗体自己的 BackColor** —— 仍是 Bg 深色，
        //   用户看到的"黑框"就是它。修法：TransparencyKey = Bg，
        //   窗体上所有等于该色的像素整块透空，只有动画有像素的地方可见。
        //   ★ 注意动画本体里有相近的深色（页面 #16141A 残留元素）会一起透空，
        //     页面里所有底色已全部改 transparent，不存在该色像素。
        BackColor = Bg;
        TransparencyKey = Bg;
        Size = new Size(400, 700);

        // 居中偏上：正中偏下的话，主窗口弹出来时两个中心是错开的，看着像跳了一下。
        Rectangle area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1440, 900);
        int x = area.Left + (area.Width - Width) / 2;
        int y = area.Top + (area.Height - Height) / 2 - 28;
        if (Height + 60 > area.Height) y = area.Top + Math.Max(0, (area.Height - Height) / 2);
        Location = new Point(Math.Max(area.Left, x), Math.Max(area.Top, y));

        string html = ReadSplashHtml(appDir);
        if (html == null)
        {
            BuildFallback();
            _done = true;          // 没有动画可放 ⇒ 别让外壳白等
            return;
        }

        _web = new WebView2 { Dock = DockStyle.Fill };
        // ★ 透明底：页面 body 是 transparent 的（去黑框），WebView2 必须跟着透明，
        //   否则内核自己会垫一层白/黑，"只留动画"就白做了。
        _web.DefaultBackgroundColor = Color.Transparent;
        Controls.Add(_web);

        // 页面跑完最后一段会发这一句过来 ⇒ 由外壳关窗口
        _web.WebMessageReceived += (_, e) =>
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            if (msg == "splash:done") _done = true;
        };

        Load += async (_, _) =>
        {
            try
            {
                // ★ 独立的用户数据目录（见文件头）：与主窗口、壁纸窗口各用一份。
                string dir = Path.Combine(App.DataDir, "webview2-splash");
                Directory.CreateDirectory(dir);

                // ★★ 2026-10-20（用户口径「黑屏几秒、启动动画都显示不出来」）：
                //   启动动画自己也是一块 WebView2，在这台机器上一样会被第三方拦沙箱
                //   ⇒ 内核崩 ⇒ 页面冻在黑底（或干脆没画）⇒ 用户看到的就是"黑几秒"。
                //   修法跟主窗口同一套：① 按记忆旗标决定是否 --no-sandbox
                //   ② 建内核**之前**先把句柄逼出来（顺序错了这行等于没写，
                //      壁纸层就是这么坏的，报 0x8007139F）
                //   ③ 内核崩了立刻退化成纯色窗体，不许留一块黑。
                var options = new CoreWebView2EnvironmentOptions();
                // ★ 只有明确记着"这台机器沙箱能用"才带沙箱；**没记录（首次）也脱沙箱**：
                //   动画只加载一段本地 HTML 字符串、只活几秒、不碰任何外部内容，
                //   与它在启动瞬间崩成一块黑相比，稳稳把画放出来更重要。
                if (!WebTriage.SandboxOkRemembered())
                    options.AdditionalBrowserArguments = WebTriage.NoSandboxArg;
                if (!_web.IsHandleCreated) { var _ = _web.Handle; }

                var env = await CoreWebView2Environment.CreateAsync(null, dir, options)
                                                       .ConfigureAwait(true);
                await _web.EnsureCoreWebView2Async(env).ConfigureAwait(true);

                _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                // ★ 动画这一层不搞分诊重建（它只活几秒，不值得换控件）：
                //   内核一挂就退化成那句「正在打开……」—— 一句字也比一块黑强。
                _web.CoreWebView2.ProcessFailed += (_, _) =>
                {
                    Dbg.Log("SplashWindow: 动画内核掉了 ⇒ 退化成纯色窗体，不留黑块");
                    BeginInvoke(new Action(() => { Degrade(); _done = true; }));
                };

                _web.CoreWebView2.NavigateToString(html);
            }
            catch
            {
                // 内核起不来 ⇒ 退化成纯色窗体。启动画面上不该出现任何异常提示。
                Degrade();
                _done = true;
            }
        };
    }

    /// <summary>动画自己放完了没有（外壳据此关窗口）。</summary>
    public bool Done => _done;

    /// <summary>
    /// 把外壳真实的三步报进去：0 准备 / 1 预检 / 2 起运行时 / 3 探服务 / 4 完成 / 5 折纸飞机 / 6 放飞。
    /// text 传空就沿用页面里那一句。
    /// </summary>
    public void SetStage(int n, string text)
    {
        Run($"window.__splash && window.__splash.setStage({n}, {JsonSerializer.Serialize(text ?? "")})");
    }

    /// <summary>跑最后一段（折飞机 + 飞走）。跑完页面发 splash:done 过来，外壳再关窗口。</summary>
    public void Finish()
    {
        if (_web == null) { _done = true; return; }
        Run("window.__splash && window.__splash.finish()");
    }

    private void Run(string script)
    {
        if (_web?.CoreWebView2 == null) return;
        try { _ = _web.CoreWebView2.ExecuteScriptAsync(script); }
        catch { /* 页面还没就绪就算了：它自己也带自动推进，不会卡住 */ }
    }

    // ------------------------------------------------------------------ 退化

    private static string ReadSplashHtml(string appDir)
    {
        try
        {
            if (string.IsNullOrEmpty(appDir)) return null;
            string path = Path.Combine(appDir, "app", "public", "splash.html");
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch { return null; }
    }

    private void Degrade()
    {
        if (_web != null)
        {
            try { Controls.Remove(_web); _web.Dispose(); } catch { /* 已经没了 */ }
            _web = null;
        }
        BuildFallback();
    }

    private void BuildFallback()
    {
        var label = new Label
        {
            Text = "正在打开……",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(0xB3, 0xA6, 0x9A),
            BackColor = Bg,
            Font = new Font("Microsoft YaHei UI", 13f),
        };
        Controls.Add(label);
    }

    // ------------------------------------------------------------------ 圆角 / Win32

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        ApplyRoundedRegion();
    }

    private void ApplyRoundedRegion()
    {
        if (ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
        const int r = 20;
        var b = new Rectangle(0, 0, ClientSize.Width, ClientSize.Height);
        using var path = new GraphicsPath();
        path.AddArc(b.X, b.Y, r * 2, r * 2, 180, 90);
        path.AddArc(b.Right - r * 2, b.Y, r * 2, r * 2, 270, 90);
        path.AddArc(b.Right - r * 2, b.Bottom - r * 2, r * 2, r * 2, 0, 90);
        path.AddArc(b.X, b.Bottom - r * 2, r * 2, r * 2, 90, 90);
        path.CloseFigure();
        Region = new Region(path);
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000;   // WS_EX_NOACTIVATE：别把焦点从用户正在用的窗口上抢走
            return cp;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web?.Dispose();
        base.Dispose(disposing);
    }
}
