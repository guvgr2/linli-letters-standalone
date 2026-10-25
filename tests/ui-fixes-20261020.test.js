// ★ 2026-10-20 四项用户反馈修复的护栏（黑屏 / 文件夹对话框 / 曲库页头 / 信箱 footer）。
//
// ★★ 纪律（2026-10-19 被反审查打回的教训）：纯字符串存在性检查证不了「写对地方」，
//   所以 CSS 断言一律**先剥注释再取规则块**，并断言「选择器 + 关键声明」同时命中；
//   C# 侧断言取「方法体片段」而不是 grep 到单词就算。渲染级验证（真开窗口量像素）
//   归 analysis/_audit19 的验收脚本，这里管静态结构不被回退。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 剥掉 /* ... *​/ 与 // 注释（字符串里没有注释符，本项目的 CSS/JS 断言够用）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 从剥注释后的文本里抽「选择器 { ... }」规则块。 */
function rule(css, selector) {
  const idx = css.indexOf(selector);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0, end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return css.slice(open, end + 1);
}

test("[UI-fixes] 曲库「更改」按钮：外壳 host object 走系统文件夹对话框", () => {
  const appjs = stripComments(read("app/public/app.js"));
  // 前端：点「更改」先找桥、弹对话框、取消不动、选中才落库
  // ★★ 2026-10-20 修正这条断言：原来写的是 `hostObjects?.linliShell`（**异步**代理）——
  //    那正是显示屏幕下拉显示 "function 0 { [native code] }" 的根因（异步代理的方法
  //    调用返回 thenable 函数而不是值，见 ui-fixes-20261022.test.js 里那条护栏）。
  //    现在唯一入口是 shellBridge()，且必须穿 .sync 同步代理。
  assert.ok(appjs.includes("function shellBridge()"), "app.js 必须有统一的外壳桥入口 shellBridge()");
  assert.ok(/hostObjects\??\.sync\??\.linliShell/.test(appjs),
    "外壳桥必须走 hostObjects.sync 同步代理（异步代理的方法回 thenable 函数）");
  assert.ok(appjs.includes("PickFolder("), "app.js 必须调用 PickFolder");
  assert.ok(
    appjs.indexOf("PickFolder(") < appjs.indexOf("/api/library/dir", appjs.indexOf("PickFolder(")),
    "选中的路径要先落到 #libraryDir 再 POST /api/library/dir",
  );
  // 外壳：桥必须真的注册给页面（重建控件后也要重新注册 ⇒ 必须在 InitWebAsync 里）
  const mw = read("src/LinliShell/MainWindow.cs");
  const init = mw.slice(mw.indexOf("private async Task InitWebAsync()"));
  assert.ok(init.includes('AddHostObjectToScript("linliShell"'), "InitWebAsync 里必须注册 linliShell host object");
  // 桥本体：真弹的是系统对话框，且取消返回空串
  const bridge = read("src/LinliShell/ShellBridge.cs");
  assert.ok(bridge.includes("FolderBrowserDialog"), "ShellBridge 必须用 FolderBrowserDialog");
  assert.ok(bridge.includes("DialogResult.OK"), "ShellBridge 必须按 DialogResult.OK 判定");
});

test("[UI-fixes] 信箱首屏：.mailbox 改 flex 撑满，不再把「给林离写信」挤到折叠线下", () => {
  const css = stripComments(read("app/public/styles-original.css"));
  const pageMail = rule(css, ".page.is-mail {");
  assert.ok(pageMail, ".page.is-mail 必须有布局规则");
  assert.ok(pageMail.includes("flex-direction: column"), ".page.is-mail 必须是纵向 flex");
  assert.ok(pageMail.includes("overflow: hidden"), ".page.is-mail 必须自己不滚（overflow:hidden）");
  const box = rule(css, ".page.is-mail .mailbox {");
  assert.ok(box, ".page.is-mail .mailbox 必须有覆盖规则");
  assert.ok(/flex:\s*1 1 auto/.test(box), ".mailbox 必须用 flex:1 撑剩余高度");
  assert.ok(box.includes("height: auto"), ".mailbox 必须覆盖掉旧 height:100%");
});

test("[UI-fixes] 页头（曲库/信箱共用）：字号加大、更贴窗口顶", () => {
  const css = stripComments(read("app/public/styles-original.css"));
  const title = rule(css, ".page-head-title {");
  assert.ok(title, ".page-head-title 规则必须存在");
  assert.ok(/font-size:\s*32px/.test(title), "标题字号必须是 32px（26px 是被用户判死刑的旧值）");
  assert.ok(/line-height:\s*40px/.test(title), "行高必须跟着 40px");
  const pad = rule(css, ".page:has(> .page-head) {");
  assert.ok(pad && /padding-top:\s*26px/.test(pad),
    "页头必须钉在 26px（14px 是用户圈红「快贴最大化键」的旧值，34px 是「太靠下」的旧值）");
  const head = rule(css, ".page-head {");
  assert.ok(head && /top:\s*26px/.test(head), "sticky 页头钉住位置也必须是 26px（四页一致）");
});

test("[UI-fixes] 记忆页页头：必须钉住不随滑动走，位置在 26 与 44 之间（36px）", () => {
  const css = stripComments(read("app/public/styles-original.css"));
  const mem = rule(css, "#page-memory > .page-head {");
  assert.ok(mem, "#page-memory > .page-head 规则必须存在");
  assert.ok(/position:\s*sticky/.test(mem), "记忆页页头必须 sticky（static = 跟着内容滚走，用户明确不要）");
  // ★ 2026-10-20 第三轮：44px 被用户判「太靠下、字重合」，26px 被上一轮判「快贴最大化键」。
  //   取中间 36px。这个数是被用户两轮截图夹出来的，不是拍脑袋 —— 改动前先看那两轮的反馈。
  assert.ok(/top:\s*36px/.test(mem), "记忆页钉住位置必须是 36px（26 太靠上、44 太靠下，两个都被用户判过）");
  const memPage = rule(css, "#page-memory {");
  assert.ok(memPage && /padding-top:\s*36px/.test(memPage),
    "#page-memory 的 padding-top 必须跟 sticky top 同值（36px），否则滚动前后标题会跳");
  // 标题与说明文字之间要拉开（用户看到的"重合"主要来自这里）
  assert.ok(/margin-bottom:\s*28px/.test(mem), "记忆页页头与说明文字之间必须再拉开（28px）");
  // 滚动后要有淡底，否则钉住的透明页头会看着像压字
  assert.ok(/is-scrolled/.test(css), "滚起来之后必须给页头一层淡底（.is-scrolled）");
  const js = stripComments(read("app/public/app.js"));
  assert.ok(js.includes("is-scrolled"), "app.js 必须在滚动时切 .is-scrolled");
});

test("[UI-fixes] 设置页页头单独往下（用户：设置字样太靠上）", () => {
  const css = stripComments(read("app/public/styles-original.css"));
  const page = rule(css, "#page-settings {");
  assert.ok(page && /padding-top:\s*40px/.test(page),
    "设置页必须单独落到 40px（26px 是用户说「太靠上」的旧值；设置页是 static 页，padding 就是它的位置）");
});

test("[UI-fixes] 待机环境音不循环：去掉 audio#amb 的 loop", () => {
  // ★ 用户「待机音乐一直在重播」；原版（exe+app 双取证）没有循环背景音这个概念。
  const wp = stripComments(read("app/public/wallpaper.html"));
  const m = wp.match(/<audio[^>]*id="amb"[^>]*>/);
  assert.ok(m, "wallpaper.html 必须有 audio#amb");
  assert.ok(!/loop/.test(m[0]), "audio#amb 不得带 loop（播完一遍就停，换时段再起）");
});

test("[UI-fixes] 三层 WebView2 都必须「先逼出句柄、再建内核」（顺序错了等于没写）", () => {
  // ★ 教训（2026-10-20 01:27 实测）：壁纸层把 `if (!_web.IsHandleCreated) { var _ = _web.Handle; }`
  //   写在 CreateAsync **之后** ⇒ 报 0x8007139F；圆钮层压根没写这行。同一处病在主窗口报过
  //   0x80070578。三层必须一致，且句柄那行的下标必须小于 CreateAsync。
  // ★ 2026-10-20：DesktopDock 不再是 WebView2 宿主（改纯 GDI+ 自绘）⇒ 移出这一组。
  for (const f of ["MainWindow.cs", "WallpaperHost.cs",
                   // 启动动画也是一块 WebView2，一样要逼句柄（它黑着就是"开屏黑几秒"）
                   "SplashWindow.cs"]) {
    const src = stripComments(read("src/LinliShell/" + f));
    const iHandle = src.indexOf("IsHandleCreated");
    const iCreate = src.indexOf("CreateAsync(");
    assert.ok(iHandle >= 0, `${f} 必须在建内核前逼出句柄（缺 IsHandleCreated 那一行）`);
    assert.ok(iCreate >= 0, `${f} 必须建内核`);
    assert.ok(iHandle < iCreate, `${f} 的强制建句柄必须写在 CreateAsync 之前（顺序错=没写）`);
  }
});

test("[UI-fixes] 启动动画自己也要防崩：沙箱按旗标降级 + 崩了退化不留黑块", () => {
  const sp = stripComments(read("src/LinliShell/SplashWindow.cs"));
  assert.ok(sp.includes("CoreWebView2EnvironmentOptions"), "启动动画必须按旗标决定沙箱参数");
  assert.ok(sp.includes("ProcessFailed"), "启动动画必须接 ProcessFailed（崩了才不会一直黑着）");
  // 崩了要退化成带字的纯色窗体，而不是留一块黑
  const iPf = sp.indexOf("ProcessFailed");
  assert.ok(sp.slice(iPf, iPf + 400).includes("Degrade()"), "内核掉了必须 Degrade() 退化");
  // 旗标要能表达"沙箱能用"，否则首次启动没有依据（动画只能带沙箱试错）
  const wt = stripComments(read("src/LinliShell/WebTriage.cs"));
  assert.ok(wt.includes("RememberSandboxOk()"), "WebTriage 必须能记下「沙箱能用」");
  assert.ok(wt.includes("SandboxOkRemembered()"), "WebTriage 必须能读出「沙箱能用」");
});

test("[UI-fixes] 开屏黑屏：splash 盖到主窗口首帧，不再探完服务就收", () => {
  const prog = stripComments(read("src/LinliShell/Program.cs"));
  // 探活成功（SetStage(3, "她应声了。")）到 BuildTray 之间不允许再出现 CloseSplash()
  const i3 = prog.indexOf('SetStage(3, "她应声了。")');
  assert.ok(i3 > 0, "探活第三拍必须存在");
  const iTray = prog.indexOf("BuildTray(appDir)", i3);
  const between = prog.slice(i3, iTray);
  assert.ok(!between.includes("CloseSplash()"), "探活成功后不得立即 CloseSplash（那就是黑屏几秒的根）");
  assert.ok(prog.includes("public static void NotifyPageReady()"), "必须提供 NotifyPageReady 给主窗口回调");
  assert.ok(prog.includes("ArmSplashDeadman()"), "必须有 splash 兜底强收（主窗口 20 秒没 ready 不能永挂）");
  // 主窗口：导航成功回调里必须通知
  const mw = stripComments(read("src/LinliShell/MainWindow.cs"));
  const iNav = mw.indexOf("core.NavigationCompleted");
  const seg = mw.slice(iNav, iNav + 900);
  assert.ok(seg.includes("Program.NotifyPageReady()"), "NavigationCompleted 成功分支里必须调 Program.NotifyPageReady()");
});
