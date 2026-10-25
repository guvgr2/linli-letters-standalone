// ★ 2026-10-20 第 22 轮（用户四项界面反馈 + 原版设置页四块）的护栏。
//
// 纪律同 20261020 那份：CSS 断言先剥注释再取规则块；跨文件一致性（返回键的文案、
// Run 项值名、契约与错误码）必须**两头都读**，不能只在一边断言。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** HTML 注释也要剥：改动说明里引用用户原话时难免出现旧文案，断言必须只看真结构。 */
function stripHtml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, "");
}

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

// ---------------------------------------------------------------- #13 返回键

test("[UI-1022] 设置页返回键：← 箭头 + 返回上一页（不再有「返回信箱」）", () => {
  const html = stripHtml(read("app/public/index.html"));
  const page = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-settings"') + 4000);
  // 按钮必须是箭头钮，且**不再**写死回哪一页
  assert.ok(/<button class="page-head-back" id="settingsBack"/.test(page),
    "设置页页头必须有 #settingsBack 返回键");
  assert.ok(!page.includes("返回信箱"), "「返回信箱」文字按钮必须删掉（用户：从曲库进来回信箱会很怪）");
  assert.ok(!/page-head-back[^>]*data-page/.test(page), "返回键不得再带 data-page（去向由导航历史算）");
  assert.ok(/<svg[^>]*><path d="M15 5l-7 7 7 7"/.test(page), "返回键必须是 ← 箭头（照原版截图圈出来的那个）");
  // 按钮排在标题左边（原版就是左上角 ← + 标题）
  assert.ok(page.indexOf("settingsBack") < page.indexOf("page-head-title"),
    "返回键必须排在标题前面（原版在左上角）");

  const css = stripComments(read("app/public/styles-original.css"));
  const back = rule(css, ".page-head-back {");
  assert.ok(back, ".page-head-back 必须有规则");
  assert.ok(/width:\s*30px/.test(back) && /height:\s*30px/.test(back), "返回键必须是 30px 图标钮（跟齿轮同档）");
  assert.ok(!/margin-left:\s*auto/.test(back), "返回键不得再靠右（margin-left:auto 是旧文字钮的）");

  const js = stripComments(read("app/public/app.js"));
  assert.ok(js.includes("const navStack = []"), "必须有导航历史栈");
  assert.ok(js.includes("navStack.push(from)"), "切页时必须记下从哪来");
  assert.ok(/settingsBack.{0,400}navStack\.pop\(\)/s.test(js) || /settingsBack[^;]*navStack/.test(js),
    "返回键必须弹栈回上一页（空栈回信箱）");
  // 旧的「data-page 回退」循环必须删掉
  assert.ok(!js.includes('querySelectorAll(".page-head-back[data-page]")'),
    "旧的 data-page 回退循环必须删除（两套逻辑并存总有一天打到旧的那套）");
});

// ---------------------------------------------------------------- #14 左栏悬空

test("[UI-1022] 左栏已搬出页面：页面里没有 rail/rb，导航由外壳的独立浮层画", () => {
  // ★ 2026-10-20 改判据。上一版这条守的是"页面里的 .rail 去掉玻璃横条"，
  //   但用户后来的口径是「这个按钮不在程序界面里，在程序外面」「独立浮层必须做」
  //   ⇒ 页面里连 .rail 都不该有了，判据跟着换成"整块搬走"，
  //     否则这条会一直绿着去守一个已经删掉的盒子。
  const css = stripComments(read("app/public/styles.css"));
  assert.ok(!/^\.rail\b/m.test(css), "styles.css 里不许再留 .rail（导航已经不在页面里了）");
  assert.ok(!/\.rb-glass/.test(css), "折射覆盖层的规则也不许留（页面里没有 .rb 可折射）");

  const html = stripHtml(read("app/public/index.html"));
  assert.ok(!/class="rail"/.test(html), "index.html 里不许再有 .rail");
  assert.ok(!/data-page=/.test(html), "index.html 里不许再有 data-page");

  // 搬去哪儿了：外壳的 NavRail 浮层（贴主窗口左沿外面、Owner 绑定、米色选中）
  const rail = read("src/LinliShell/NavRail.cs");
  assert.ok(/Owner = owner;/.test(rail), "导航浮层必须是主窗口的 Owned 窗口");
  // ★ 2026-10-20 口径变了一次：原来只往外让 4dip（胶囊压着窗口边），
  //   用户说「那个浮窗太靠近主窗口了，再往左移一点」⇒ 现在整颗退到窗口外面 22dip。
  //   所以这里从 `- pillW + overlap` 改成 `- pillW - gap`，并守住"缝不许再缩小"。
  assert.ok(/b\.Left - pillW - gap/.test(rail),
    "位置必须按「窗口左沿 − 胶囊宽 − 缝」算（整颗在窗口外面，不许压在窗口边上）");
  const gapDip = Number(/private const int OutsideGap = (\d+);/.exec(rail)?.[1] ?? 0);
  assert.ok(gapDip >= 16, `OutsideGap=${gapDip}dip 太小 —— 胶囊会重新贴上窗口边（用户明确要求再往左移）`);
  assert.ok(/0xD8, 0xCF, 0xC4/.test(rail), "选中态必须是米色实心圆（原版口径）");
});

// ---------------------------------------------------------------- #15 四块设置（HTML 结构）

test("[UI-1022] 设置页新增四块：应用行为 / 弹唱视角 / 状态 / 显示屏幕（顺序照原版）", () => {
  const html = stripHtml(read("app/public/index.html"));
  const i0 = html.indexOf('id="page-settings"');
  const page = html.slice(i0, html.indexOf("</section>", i0));
  const at = (sel) => page.indexOf(sel);
  for (const sel of ['id="appAutostart"', 'id="closeBehavior"', 'id="viewCards"',
                     'id="stateCards"', 'id="stageScreen"']) {
    assert.ok(at(sel) >= 0, `设置页必须有 ${sel}`);
  }
  // 顺序：应用行为 → 弹唱视角 → 状态 → 显示屏幕 →（既有的）显示与桌面
  assert.ok(at('id="appAutostart"') < at('id="closeBehavior"'), "开机自启与关闭时同属应用行为，顺序别乱");
  assert.ok(at('id="viewCards"') < at('id="stateCards"'), "弹唱视角必须在状态前面（原版顺序）");
  assert.ok(at('id="stateCards"') < at('id="stageScreen"'), "状态必须在显示屏幕前面（原版顺序）");
  assert.ok(at('id="stageScreen"') < page.indexOf("显示与桌面"), "显示屏幕必须在「显示与桌面」之前（原版顺序）");

  // 弹唱视角两张卡：NI / WI（曲库视频文件名里的视角段，不是随便起的缩写）
  const viewCards = page.slice(at('id="viewCards"'), at('id="stateCards"'));
  assert.ok(/data-view="NI"/.test(viewCards) && /data-view="WI"/.test(viewCards), "弹唱视角必须两张卡 NI/WI");
  assert.ok(viewCards.includes("专注演奏") && viewCards.includes("视线交互"),
    "卡片名照原版语言包：专注演奏 / 视线交互（不是「视听交互」——那个是我看截图看错的）");
  // 状态三张卡：R1/R2/R3 = 日常/创作/思考
  const stateCards = page.slice(at('id="stateCards"'), at('id="stageScreen"'));
  for (const s of ['data-state="R1"', 'data-state="R2"', 'data-state="R3"']) {
    assert.ok(stateCards.includes(s), `状态卡必须有 ${s}`);
  }
  for (const name of ["日常模式", "创作模式", "思考模式"]) {
    assert.ok(stateCards.includes(name), `状态卡必须有「${name}」`);
  }
  // 关闭时三档（原版语言包 a_/i_/c_ 三条原文）
  const close = page.slice(at('id="closeBehavior"'), at('id="viewCards"'));
  assert.ok(close.includes("不设置（每次关闭提示）"), "关闭时必须有「不设置」档");
  assert.ok(close.includes("最小化到托盘后台运行"), "关闭时必须有托盘档");
  assert.ok(close.includes("直接退出应用"), "关闭时必须有退出档");
  // 选中态的唯一真源是 aria-checked（CSS 照它画 ✓）
  assert.ok(/aria-checked="false"/.test(viewCards), "卡片初始 aria-checked=false（由 JS 按服务端值打勾）");
});

test("[UI-1022] 关闭询问弹层：三个出口 + 「记住该设定」", () => {
  const html = stripHtml(read("app/public/index.html"));
  assert.ok(html.includes('id="closeAskModal"'), "必须有 #closeAskModal（关闭时=不设置档每次问一句）");
  const modal = html.slice(html.indexOf('id="closeAskModal"'), html.indexOf('id="closeAskModal"') + 2000);
  assert.ok(modal.includes('id="closeAskTray"') && modal.includes('id="closeAskQuit"'),
    "弹层必须有「最小化到托盘」与「直接退出」两个按钮");
  assert.ok(modal.includes('id="closeAskRemember"'), "弹层必须有「记住该设定」勾选（原版同款）");
  const js = stripComments(read("app/public/app.js"));
  assert.ok(js.includes('"/api/app/behavior"'), "记住该设定必须写进 /api/app/behavior");
});

// ---------------------------------------------------------------- #15 服务端

test("[UI-1022] 弹唱视角：/api/stage/view 白名单校验 + stageNext 跟设置走", () => {
  const src = stripComments(read("app/server.mjs"));
  assert.ok(src.includes('path === "/api/stage/view"'), "必须有 /api/stage/view 路由");
  assert.ok(src.includes("ERR.LIBRARY_PLAY_VIEW_INVALID"), "非法视角必须报 LIBRARY_PLAY_VIEW_INVALID");
  assert.ok(/PLAY_VIEWS\s*=\s*\["NI",\s*"WI"\]/.test(src), "视角白名单必须且只能是 NI/WI");
  assert.ok(src.includes("function playViewSetting()"), "必须有 playViewSetting() 读取函数");
  // ★ 关键：stageNext 不许再写死 "NI" —— 否则设置页选了 WI 桌面根本不换
  const stageNext = src.slice(src.indexOf("async function stageNext()"), src.indexOf("async function stageNext()") + 900);
  assert.ok(!stageNext.includes('"NI"'), "stageNext 不得写死 NI（必须走 playViewSetting()）");
  assert.ok(stageNext.includes("playViewSetting()"), "stageNext 必须按 playViewSetting() 挑视角");
  // 她练琴那条路（worldPractice）同样不许写死
  const world = src.slice(src.indexOf("function worldPractice"), src.indexOf("function worldPractice") + 1500);
  if (world) assert.ok(!world.includes('selectVariant(variants, tod, "NI")'),
    "她练琴也不得写死 NI");
});

test("[UI-1022] 状态：/api/idle/settings 收 R1/R2/R3，且必须连同场景一起钉住", () => {
  const src = stripComments(read("app/server.mjs"));
  const post = src.slice(src.indexOf('POST" && path === "/api/idle/settings"'),
                         src.indexOf('POST" && path === "/api/idle/settings"') + 2200);
  assert.ok(post.includes("ERR.IDLE_STATE_INVALID"), "非法状态必须报 IDLE_STATE_INVALID");
  assert.ok(post.includes("IDLE_STATES.includes(state)"), "状态必须过 IDLE_STATES 白名单");
  // ★★ 只写 state 不写 scene 的话，idleChoice 见 scene 未钉 ⇒ 连 state 一起回落随机，
  //   用户选的状态会被当场盖掉（界面说"已保存"、桌面下一轮就变）。
  assert.ok(post.includes('setSetting("idle_scene"'), "写 state 必须同时钉住 scene");
  assert.ok(post.includes('setSetting("idle_state"'), "写 state 必须落 idle_state");
});

test("[UI-1022] 关闭时行为：/api/app/behavior 三档白名单", () => {
  const src = stripComments(read("app/server.mjs"));
  assert.ok(src.includes('path === "/api/app/behavior"'), "必须有 /api/app/behavior 路由");
  assert.ok(src.includes("ERR.APP_CLOSE_BEHAVIOR_INVALID"), "非法值必须报 APP_CLOSE_BEHAVIOR_INVALID");
  assert.ok(/CLOSE_BEHAVIORS\s*=\s*\["ask",\s*"tray",\s*"quit"\]/.test(src),
    "关闭行为白名单必须且只能是 ask/tray/quit");
});

test("[UI-1022] 错误号三件套：表 / 一览文档 / HTTP 契约都不许脱钩", () => {
  const codes = read("app/error-codes.mjs");
  for (const code of ["LIBRARY_PLAY_VIEW_INVALID", "IDLE_STATE_INVALID", "APP_CLOSE_BEHAVIOR_INVALID"]) {
    assert.ok(codes.includes(code), `error-codes.mjs 必须登记 ${code}`);
    assert.ok(read("错误号一览.md").includes(code), `错误号一览.md 必须写 ${code}（文档脱钩是真实踩过的坑）`);
  }
  const contract = readJson("app/contracts/http_contract.json");
  const routes = contract.routes;
  assert.ok(routes["/api/stage/view"], "契约必须登记 /api/stage/view");
  assert.ok(routes["/api/app/behavior"], "契约必须登记 /api/app/behavior");
  assert.ok(routes["/api/idle/settings"].error_codes.includes("IDLE_STATE_INVALID"),
    "契约里 /api/idle/settings 的错误号必须含 IDLE_STATE_INVALID");
  assert.deepStrictEqual(routes["/api/stage/view"].error_codes, ["LIBRARY_PLAY_VIEW_INVALID"]);
  assert.deepStrictEqual(routes["/api/app/behavior"].error_codes, ["APP_CLOSE_BEHAVIOR_INVALID"]);
});

// ---------------------------------------------------------------- #15 外壳

test("[UI-1022] ShellBridge：开机自启 + 屏幕枚举/搬迁，Run 项值名与安装程序一致", () => {
  const bridge = read("src/LinliShell/ShellBridge.cs");
  for (const m of ["public string ListScreens(", "public string GetScreen(", "public string SetScreen(",
                   "public string GetAutostart(", "public string SetAutostart("]) {
    assert.ok(bridge.includes(m), `ShellBridge 必须有 ${m.trim()}`);
  }
  assert.ok(bridge.includes("public static Action<string> ApplyScreen"),
    "必须给屏幕切换留进程级回调（host object 每次重建内核都会 new 一个）");
  assert.ok(bridge.includes("App.DataDir"), "屏幕偏好必须落 App.DataDir（用户数据区，卸载不动它）");
  // ★★ 跨文件一致性：Run 项值名写两处就会多出一个开机启动项、卸也卸不干净。
  const iss = read("install.iss");
  const m = /ValueName:\s*"\{#MyAppName\}"/.exec(iss);
  assert.ok(m, "install.iss 必须用 {#MyAppName} 写 Run 项值名");
  const define = /#define MyAppName "([^"]+)"/.exec(iss);
  assert.ok(define, "install.iss 必须 #define MyAppName");
  assert.ok(bridge.includes(`private const string RunValueName = "${define[1]}";`),
    `ShellBridge 的 RunValueName 必须与安装程序的值名一致（${define[1]}）`);
  assert.ok(bridge.includes("--startup"), "开机自启写的值必须带 --startup（开机只进托盘、不弹窗口）");
});

test("[UI-1022] 三层窗口都能搬屏 + Program 有应用入口", () => {
  for (const f of ["MainWindow.cs", "WallpaperHost.cs", "DesktopDock.cs"]) {
    const src = read("src/LinliShell/" + f);
    assert.ok(src.includes("public void MoveToScreen(Screen"), `${f} 必须有 MoveToScreen(Screen)`);
  }
  const prog = read("src/LinliShell/Program.cs");
  assert.ok(prog.includes("private static void ApplyScreenPref(string deviceName)"), "Program 必须有 ApplyScreenPref");
  assert.ok(prog.includes("ShellBridge.ApplyScreen = ApplyScreenPref"), "Main 里必须把回调接到 ApplyScreenPref");
  assert.ok(prog.includes("ApplyScreenPref(new ShellBridge().GetScreen())"),
    "铺壁纸层 / 圆钮 / 建主窗口时都必须套用屏幕偏好（漏一处就是换屏只换一半）");
});

test("[UI-1022] 点 × 按「关闭时」设置走，不再无条件退出", () => {
  const js = stripComments(read("app/public/app.js"));
  assert.ok(js.includes("function closeWindowWithBehavior()"), "必须有 closeWindowWithBehavior()");
  assert.ok(js.includes('wcQuit') && /wcQuit[^;]*closeWindowWithBehavior\(\)/.test(js),
    "wcQuit 必须走 closeWindowWithBehavior（无条件 say(\"quit\") 是旧行为）");
  assert.ok(js.includes("tellShell(\"close\")") || js.includes('tellShell(action === "tray" ? "close" : "quit")'),
    "托盘档必须发 close（C# 侧 RequestClose ⇒ 收进托盘）");
  // 卡片点击必须落库 + 喊桌面层换片
  assert.ok(/api\(\"\/api\/stage\/view\"/.test(js), "视角卡必须 POST /api/stage/view");
  assert.ok(/api\(\"\/api\/idle\/settings\"/.test(js), "状态卡必须 POST /api/idle/settings");
  assert.ok(/api\(\"\/api\/app\/behavior\"/.test(js), "关闭行为必须 POST /api/app/behavior");
});

test("[UI-1022] 卡片选中态样式：aria-checked 驱动 ✓ 与描边", () => {
  const css = stripComments(read("app/public/styles.css"));
  assert.ok(css.includes(".view-cards"), "必须有 .view-cards 容器样式");
  const card = rule(css, ".view-card {");
  assert.ok(card, "必须有 .view-card 样式");
  const on = rule(css, '.view-card[aria-checked="true"] {');
  assert.ok(on, "选中态必须按 aria-checked 画（这是唯一真源，别让 JS 直接改 style）");
  assert.ok(/opacity:\s*1/.test(rule(css, '.view-card[aria-checked="true"] .view-card-tick {') ?? ""),
    "选中时 ✓ 必须露出来");
});

// ---------------------------------------------------------------- #16 外壳桥走 .sync

test("[UI-1022] 外壳桥必须走 hostObjects.sync 同步代理（异步代理的方法回 thenable 函数）", () => {
  // ★★ 2026-10-20 用户截图实证：显示屏幕下拉里躺着 "function 0 { [native code] }"。
  //    根因：shellBridge() 拿的是不带 .sync 的异步代理，`String(bridge.ListScreens())`
  //    把**方法调用返回的 thenable 函数**字符串化了。探针实测（同机同 WebView2）：
  //      同步代理 ListScreens() ⇒ "S1|0|0|1920|1080|1;…"（直接就是值）
  //      异步代理 ListScreens() ⇒ function，String() ⇒ "function () { [native code] }"
  //    证据文件：analysis/_audit22/hostobj-probe/result.txt
  const js = stripComments(read("app/public/app.js"));
  assert.ok(/hostObjects\??\.sync\??\.linliShell/.test(js),
    "shellBridge() 必须返回 hostObjects.sync.linliShell（同步代理直接回值）");
  assert.ok(!/hostObjects\??\.linliShell/.test(js),
    "不许再直接摸不带 .sync 的异步代理（其方法调用返回 thenable 函数，不是值）");
  // 每个桥调用都要能兜住：旧外壳没这些方法时，抛出来不许把整个 loadBehavior 掀翻
  assert.ok(js.includes("function bridgeRead("), "必须有 bridgeRead() 兜底读取");
  for (const m of ["GetAutostart", "GetScreen", "ListScreens", "SetAutostart", "SetScreen"]) {
    assert.ok(new RegExp("bridgeRead\\(\\(\\) => String\\(bridge\\." + m + "\\(").test(js),
      `${m} 必须走 bridgeRead 兜底（一个方法抛了，后面的屏幕枚举还得跑）`);
  }
});

// ---------------------------------------------------------------- #16 卡片图片演示

test("[UI-1022] 卡片要有图片演示（视角卡 webp / 状态卡 mp4 首帧，原版同款素材）", () => {
  const html = stripHtml(read("app/public/index.html"));
  const viewCards = html.slice(html.indexOf('id="viewCards"'), html.indexOf('id="stateCards"'));
  assert.ok(/<img class="view-card-media" src="assets\/mode-focus-/.test(viewCards),
    "专注演奏卡必须有配图（用户：原版弹唱视角底下有图片演示）");
  assert.ok(/<img class="view-card-media" src="assets\/mode-interactive-/.test(viewCards),
    "视线交互卡必须有配图");
  const stateCards = html.slice(html.indexOf('id="stateCards"'), html.indexOf('id="stageScreen"'));
  for (const f of ["idle_normal", "idle_creative", "idle_thinking"]) {
    assert.ok(stateCards.includes(`<video class="view-card-media" src="assets/${f}-`),
      `状态卡必须有 ${f} 视频首帧（用户：原版状态卡也有演示）`);
  }
  assert.ok(/preload="metadata"/.test(stateCards),
    "状态卡视频只预加载元数据（画首帧就够，别把三段整片下下来）");
  // 写了路径就得有文件：裂图比没图更难看
  for (const f of ["mode-focus-389eb413.webp", "mode-interactive-d934cb4a.webp",
                   "idle_normal-c800bce5.mp4", "idle_creative-0c55f284.mp4",
                   "idle_thinking-fe70ce7a.mp4"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "app/public/assets", f)),
      `app/public/assets/${f} 必须存在（卡片引用了它）`);
  }
  const css = stripComments(read("app/public/styles.css"));
  assert.ok(rule(css, ".view-card-media {"), "必须有 .view-card-media 样式");
  assert.ok(/object-fit:\s*cover/.test(rule(css, ".view-card-media {")),
    "卡片媒体必须 cover 裁切（16:10 的画框，原图比例不一）");
  assert.ok(/pointer-events:\s*none/.test(rule(css, ".view-card-media {")),
    "媒体不许吃点击（整张卡是一个按钮）");
  // ★★ 卡片自己是 <button>：全局 `button { height: 36px }` 会级联下来把卡片钉在
  //   36px 高、把 101px 的媒体裁成一条（button,.rb 那条还给的是 overflow:hidden，
  //   裁得干干净净）。CDP 实测过这一刀（cardRect.h=36 vs mediaRect.h=101.3）。
  const card = rule(css, ".view-card {");
  assert.ok(card, ".view-card 规则必须存在");
  assert.ok(/height:\s*auto/.test(card),
    ".view-card 必须显式 height:auto 压掉全局 button 的 36px 固定高");
  assert.ok(/width:\s*\d+px/.test(card),
    ".view-card 必须定宽（媒体的 width:100% 要确定基准，否则被自然尺寸撑爆）");
});

// ------------------------------------------------- #17 自检 CDP 调试口

test("[UI-1022] 自检 CDP 调试口：只在显式设 LINLI_VERIFY_CDP_PORT 时才开", () => {
  // ★★ 2026-10-20 第二十三轮：修好「显示屏幕显示 function 0」后要端到端复验，
  //    CDP 却连不上真外壳。根因：本机 webview2-flags.txt 记着 --no-sandbox
  //    ⇒ _noSandbox=true ⇒ BuildOptions() 自设 AdditionalBrowserArguments
  //    ⇒ 环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 被整个顶掉。
  //    ⇒ 照 LINLI_FORCE_WEBVIEW_FAIL 的既有套路，给 BuildOptions 留一个显式开关。
  const mw = stripComments(read("src/LinliShell/MainWindow.cs"));
  assert.ok(/GetEnvironmentVariable\("LINLI_VERIFY_CDP_PORT"\)/.test(mw),
    "BuildOptions 必须读 LINLI_VERIFY_CDP_PORT（否则每轮验证都连不上真外壳）");
  assert.ok(mw.includes("--remote-debugging-port={dbgPort}") || mw.includes("--remote-debugging-port="),
    "必须把它拼成 --remote-debugging-port 浏览器参数");
  // 关键安全性质：端口值必须来自环境变量本身，不能写死；且必须走拼接而非替换
  // （替换会把 --no-sandbox 吃掉 ⇒ 本机直接崩）。
  assert.ok(/dbgPort/.test(mw), "端口必须取自环境变量（不许写死某个端口）");
  assert.ok(/AdditionalBrowserArguments \+ " " \+ dbg|AdditionalBrowserArguments \+ "\s*"\s*\+ dbg/.test(mw) || mw.includes('+ " " + dbg'),
    "必须追加而不是替换 AdditionalBrowserArguments（替换会吃掉 --no-sandbox）");
  assert.ok(/IsNullOrEmpty\(o\.AdditionalBrowserArguments\)/.test(mw),
    "原来没设参数时要能单独成立（不脱沙箱的机器上也要能开调试口）");
  // 开关名必须与验证脚本一致，两边写两个名字就等于没开
  // ★ 2026-10-24：这个文件原本住在 analysis/_audit22/，而 analysis/ 被 .gitignore 忽略
  //   ⇒ 目录被清一次，这条护栏就 ENOENT 红一次（实测发生过）。已挪进已追踪的 tools/。
  const js = read("tools/verify-screen-e2e.js");
  assert.ok(js.includes("env.LINLI_VERIFY_CDP_PORT"),
    "verify-screen-e2e.js 必须设 LINLI_VERIFY_CDP_PORT（脚本与外壳对不上名就是白改）");
});

// ------------------------------------------------- #18 数据搬家方向口径

test("[UI-1022] 数据搬家方向口径：只搬进来（旧版本 → 当前程序），不往外搬", () => {
  // ★★ 2026-10-20 用户原话：「咱们的数据搬家功能是把以前旧版本的数据搬到现在的
  //    程序，不是从咱们这搬到他那」。旧按钮「扫描本机其它安装」会被读成往外搬。
  const html = stripHtml(read("app/public/index.html"));
  assert.ok(/<button id="migrateScan"[^>]*>扫描本机的旧版本数据<\/button>/.test(html),
    "扫描按钮必须叫「扫描本机的旧版本数据」（方向口径）");
  assert.ok(!html.includes("扫描本机其它安装"), "旧按钮文案「扫描本机其它安装」必须改掉（读起来像往外搬）");
  const sec = html.slice(html.indexOf("数据搬家"), html.indexOf("数据搬家") + 900);
  assert.ok(sec.includes("以前旧版本"), "说明必须点明来源是「以前旧版本」");
  assert.ok(sec.includes("搬进"), "说明必须写明「搬进现在这个程序」");
  assert.ok(sec.includes("不会把现在的数据搬到别处"), "说明必须写明「不会把现在的数据搬到别处」");
  // 前端空结果 / 扫描提示同口径
  const js = stripComments(read("app/public/app.js"));
  assert.ok(js.includes("没有扫到旧版本的数据"), "空结果必须说「没有扫到旧版本的数据」");
  assert.ok(!js.includes("没有扫到别的安装"), "旧的空结果文案必须删掉");
  // 服务端只负责「找来源」：migrate 只收候选键、复制方向是候选 → 当前数据目录。
  // 注意用原文（不剥注释）：方向口径恰恰写在 JSDoc 里，剥了就没了。
  const msrv = read("app/maintenance.mjs");
  assert.ok(msrv.includes("把以前旧版本的数据搬进来"), "maintenance.mjs 必须带着方向口径注释");
});
