// ★ 2026-10-20 第六轮（用户五项反馈 Batch A）的护栏：
//   #16 音量=0 仍有声（窗口层双声源 + 滑块 0/100 不到位）
//   #17 状态卡切换无效（tick 只认 tod，不认 scene/state）
//   #18 待机音乐只循环一首（服务端把环境音钉死一个文件）
//   #19 点任务栏图标无法最小化（无边框窗体缺 WS_MINIMIZEBOX）
//   #20 点播不立即切歌（换首判据缺曲目本身 info.dir）
//
// 纪律同 ui-fixes-20261022：断言前剥注释（HTML/CSS/JS）；assets.mjs 的轮换用**真行为**
// 测（造临时目录放真文件），不是只看源码里有那个词。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanupDir, cleanupDirSync } = require("./support/cleanup.cjs");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripHtml = (src) => src.replace(/<!--[\s\S]*?-->/g, "");
const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------- #20 立即切歌

test("[BATCH-A] 壁纸层换首判据必须含曲目本身（点播立即切，不等时段）", () => {
  const js = stripJs(stripHtml(read("app/public/wallpaper.html")));
  assert.ok(/info\.dir !== songDir \|\| info\.tod !== songTod/.test(js),
    "song 模式必须判 info.dir 变化（同一时段换点播要立刻换片）");
  assert.ok(/songDir = info\.dir/.test(js), "进入 song 模式必须记下当前曲目");
});

test("[BATCH-A] 窗口层 stageTick 同病同治：换首判据也必须含 info.dir", () => {
  const js = stripJs(read("app/public/app.js"));
  assert.ok(/info\.dir !== stage\.dir \|\| info\.tod !== stage\.tod/.test(js),
    "窗口层 song 模式必须判 info.dir 变化");
  assert.ok(/stage\.dir = info\.dir/.test(js), "窗口层进入 song 模式必须记下当前曲目");
  // 回待机时要清掉，否则下一次点同一首歌判不出来
  assert.ok(/stage\.dir = null;/.test(js), "离开 song 模式必须清 stage.dir");
});

// ---------------------------------------------------------------- #17 状态切换

test("[BATCH-A] 壁纸层待机换片判据必须含 scene/state（状态卡点了要有反应）", () => {
  const js = stripJs(stripHtml(read("app/public/wallpaper.html")));
  assert.ok(/n\.scene !== idle\.scene \|\| n\.state !== idle\.state/.test(js),
    "idle 模式必须判 scene/state 变化，不能只认 tod");
  assert.ok(/idle = \{ tod: n\.tod, slot: n\.slot, scene: n\.scene, state: n\.state \}/.test(js),
    "startIdle 必须把 state 记进 idle，否则下一轮永远不相等");
  assert.ok(/idle\.state = n\.state/.test(js), "idleSwitchSlot 必须更新 state");
});

test("[BATCH-A] 窗口层待机换片判据同病同治", () => {
  const js = stripJs(read("app/public/app.js"));
  assert.ok(/n\.scene !== stage\.idle\.scene \|\| n\.state !== stage\.idle\.state/.test(js),
    "窗口层 idle 模式必须判 scene/state 变化");
  assert.ok(/stage\.idle = \{ tod: n\.tod, slot: n\.slot, scene: n\.scene, state: n\.state \}/.test(js),
    "窗口层必须把 state 记进 stage.idle");
});

// ---------------------------------------------------------------- #16 双声源

test("[BATCH-A] 窗口层环境音不得再有写死音量；壁纸层在跑时必须闭嘴", () => {
  const js = stripJs(read("app/public/app.js"));
  assert.ok(!/volume = 0\.45/.test(js), "写死 0.45 的双声源必须删掉（用户：音量调 0 还有声音）");
  assert.ok(/function wallpaperLayerOn\(\)/.test(js), "必须有 wallpaperLayerOn 判定");
  // idleAmbienceStart 里必须先看壁纸层在不在跑（行锚定，防「被注释掉」假绿）
  assert.ok(/^\s*if \(wallpaperLayerOn\(\) \|\| !n\.ambience \|\| n\.ambienceOn === false\) return idleAmbienceStop\(\);/m.test(js),
    "idleAmbienceStart 第一件事就是：壁纸层在跑（或没有环境音）就闭嘴");
  // 浏览器模式出声时，音量必须读设置，不许写死
  assert.ok(/s\.ambienceVolume/.test(js), "窗口层音量必须从 /api/idle/settings 读");
});

// ---------------------------------------------------------------- #16 滑块 0/100

test("[BATCH-A] 音量滑块改自绘：填充比例由 setRange 写 --fill，两端贴到头", () => {
  const css = stripCss(read("app/public/styles.css"));
  const main = css.slice(css.indexOf(".set-item-c .set-range {"));
  assert.ok(/-webkit-appearance:\s*none/.test(main), "必须关掉原生外观（原生圆头行程不含端点）");
  assert.ok(/--fill/.test(main), "必须用 --fill 画填充");
  assert.ok(/::-webkit-slider-runnable-track/.test(css), "必须有自绘轨道");
  assert.ok(/::-webkit-slider-thumb/.test(css), "必须有自绘圆头");

  const js = stripJs(read("app/public/app.js"));
  assert.ok(/^\s*input\.style\.setProperty\("--fill"/m.test(js),
    "setRange 必须把值写进 --fill（否则填充永远是初始值）");
  assert.ok(/^\s*setRange\(input, input\.value\);\s*\/\/ ★ 2026-10-20/m.test(js) ||
            /wireVolume\(input\) \{[\s\S]*?setRange\(input, input\.value\)/.test(js),
    "wireVolume 必须首屏画一次填充（不然闪 50%）");
});

// ---------------------------------------------------------------- #18 环境音轮换（真行为）

test("[BATCH-A] 环境音按时段轮换：同时段稳定、换时段换一首、手动钉死最优先", async () => {
  const { idleAmbienceFile } = await import("../app/assets.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linli-amb-"));
  try {
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `ambient_loop_${i}.mp3`), "x");
    const noop = () => "";
    // 同一时段内：钉住不动（不能每轮 tick 都换）
    const a1 = idleAmbienceFile(dir, 7, noop, "1200");
    const a2 = idleAmbienceFile(dir, 7, noop, "1200");
    assert.equal(a1, a2, "同一时段两次取值必须相同");
    assert.match(a1, /^ambient_loop_\d\.mp3$/u);
    // 换时段：盐值混了 slot，六个文件、三个时段，至少两个时段给出不同文件
    const slots = ["1200", "1730", "2000"];
    const picks = slots.map((s) => idleAmbienceFile(dir, 7, noop, s));
    assert.ok(new Set(picks).size >= 2, `换时段必须轮换（拿到 ${picks.join(",")}）`);
    // 用户手动钉过的最优先，且文件必须真实存在才认
    const pinned = idleAmbienceFile(dir, 7, (k) => (k === "idle_ambience" ? "ambient_loop_3.mp3" : ""), "1200");
    assert.equal(pinned, "ambient_loop_3.mp3", "手动钉死要赢过轮换");
    // 钉的名字不存在 ⇒ 退回轮换，不许返回不存在的文件
    const ghost = idleAmbienceFile(dir, 7, (k) => (k === "idle_ambience" ? "ambient_loop_99.mp3" : ""), "1200");
    assert.match(ghost, /^ambient_loop_[1-6]\.mp3$/u, "钉了不存在的文件要退回轮换");
  } finally {
    cleanupDirSync(dir);
  }
});

// ---------------------------------------------------------------- #19 任务栏最小化

test("[BATCH-A] 主窗口必须补 WS_MINIMIZEBOX|WS_SYSMENU（任务栏图标点了要最小化）", () => {
  const cs = read("src/LinliShell/MainWindow.cs");
  assert.ok(/protected override CreateParams CreateParams/.test(cs),
    "必须有 CreateParams override");
  assert.ok(/0x00020000\s*\/\*\s*WS_MINIMIZEBOX\s*\*\//.test(cs), "必须带 WS_MINIMIZEBOX(0x20000)");
  assert.ok(/0x00080000\s*\/\*\s*WS_SYSMENU\s*\*\//.test(cs), "必须带 WS_SYSMENU(0x80000)");
  assert.ok(/cp\.Style \|=/.test(cs), "必须是加进 Style，不是替换");
});

// ---------------------------------------------------------------- #25 曲库底部播放条

test("[BAR] 播放条必须整条在曲库页里，#playerPage 的旧拷贝删干净（同批 id 只许一份）", () => {
  const html = stripHtml(read("app/public/index.html"));
  const lib = html.slice(html.indexOf('id="page-library"'), html.indexOf('id="page-memory"'));
  assert.ok(lib.includes('id="playerBar"') && lib.includes("is-lib-bar"),
    "曲库页底部必须有播放条（用户圈原版截图指定）");
  for (const id of ["pbMode", "pbPrev", "pbPlay", "pbNext", "pbMute", "pbNow", "pbLine", "pbFill", "pbTime"])
    assert.ok(lib.includes(`id="${id}"`), `曲库播放条缺 id=${id}（app.js 的接线会落空）`);
  const playerPage = html.slice(html.indexOf('id="playerPage"'));
  assert.ok(!playerPage.includes('id="playerBar"'),
    "旧播放条必须从 #playerPage 删掉（同批 id 只能有一份，否则接线打到 hidden 副本）");
});

test("[BAR] 播放键=暂停回待机 + 断点续播（用户两句口径合并）；进度条可点击跳转；进度靠壁纸层上报", () => {
  const js = stripJs(read("app/public/app.js"));
  // ★ 2026-10-20 用户原话：「不应该是点了暂停以后回到待机吗」⇒ pbPlay 在放时回待机，
  //   **不做画面冻结式暂停**；playback:toggle 那条链路必须删干净。
  //   （本文件写完后用户又补了「暂停后再点播放要续播，姊妹项目有，直接抄过来」
  //   ⇒ 回待机前先把断点记到服务端：playIdle(pbState.t)，见 resume-volume 测试文件。）
  assert.ok(/if \(player\.dir\) return void playIdle\(pbState\.has \? pbState\.t : null\);/.test(js),
    "pbPlay 在放时必须回待机，且把当前秒数作为断点传下去（不是冻结画面）");
  assert.ok(!/playback:toggle/.test(js), "冻结式暂停的 toggle 指令必须删干净（没有死指令）");
  assert.ok(/async function playIdle\(pauseAt = null\)/.test(js), "playIdle 必须存在（带可选断点参数）");
  assert.ok(/async function resumePaused\(\)/.test(js), "resumePaused 必须存在（断点续播）");
  assert.ok(/const ICON_PAUSE/.test(js), "播放中要显示暂停图标（两竖杠，表示再点回待机前的状态）");
  // 点进度条跳转（自研，原版没有）
  assert.ok(/\$\("pbLine"\)\?\.addEventListener\("click"/.test(js), "进度条必须可点击");
  assert.ok(js.includes('seek:${(ratio * pbState.d).toFixed(3)}'), "跳转必须按比例换算成秒发出去");
  // 真进度：听外壳转发 + 画真值
  assert.ok(/m\.playback/.test(js) && /fill\.style\.width = pct \+ "%"/.test(js),
    "必须吃外壳转发的播放进度并画进进度条");

  const wall = stripJs(stripHtml(read("app/public/wallpaper.html")));
  assert.ok(!/toggleFrontVideo/.test(wall), "壁纸层不得残留冻结式暂停的实现（死代码）");
  assert.ok(/setInterval\(reportPlayback, 1000\)/.test(wall), "壁纸层必须每秒上报真实进度");
  assert.ok(/typeof d\.seek === "number"/.test(wall), "壁纸层必须吃 seek 指令设 currentTime");
});

test("[BAR] 外壳链路：壁纸层上报 → MainWindow 转发；窗口指令 → WallpaperHost 执行", () => {
  const host = read("src/LinliShell/WallpaperHost.cs");
  assert.ok(/msg\.StartsWith\("playback:", StringComparison\.Ordinal\)/.test(host),
    "壁纸层的进度上报必须被外壳接住");
  assert.ok(!/public void TogglePlayback\(\)/.test(host), "WallpaperHost 不得残留 toggle 入口（死代码）");
  assert.ok(/public void SeekTo\(double/.test(host), "WallpaperHost 必须有跳转入口");
  assert.ok(/InvariantCulture/.test(host), "seek 的秒数必须用 InvariantCulture 拼 JSON（zh-CN 小数逗号会产出非法 JSON）");

  const main = read("src/LinliShell/MainWindow.cs");
  assert.ok(!/PlaybackToggleRequested/.test(main), "MainWindow 不得残留 toggle 事件（死代码）");
  assert.ok(/msg\.StartsWith\("seek:"/.test(main), "MainWindow 必须分发 seek 指令");
  assert.ok(/public void ForwardPlayback\(string json\)/.test(main), "必须有进度转发入口");

  const prog = read("src/LinliShell/Program.cs");
  assert.ok(/_wall\.PlaybackReported \+= \(_, json\) => _window\?\.ForwardPlayback\(json\)/.test(prog),
    "订阅必须挂在 _wall 创建处（OpenWindow 可能晚于铺壁纸）");
  assert.ok(/_window\.SeekRequested \+= \(_, sec\) => _wall\?\.SeekTo\(sec\)/.test(prog),
    "seek 事件必须接到壁纸宿主");
  assert.ok(!/PlaybackToggleRequested/.test(prog), "Program 不得残留 toggle 接线（死代码）");
});

// ---------------------------------------------------------------- #19b 渲染冻结自愈

test("[FREEZE] 渲染冻结必须先等再探活，不许立刻 Reload 烧额度（黑屏根因）", () => {
  const triage = read("src/LinliShell/WebTriage.cs");
  assert.ok(/UnresponsiveRecheckMs = 20_000/.test(triage), "必须有等待参数");
  assert.ok(/public static async Task<bool> ProbeResponsiveAsync\(CoreWebView2 core\)/.test(triage),
    "必须有共享探活函数");
  assert.ok(/kind == CoreWebView2ProcessFailedKind\.RenderProcessUnresponsive/.test(triage),
    "只对「卡住没死」的渲染进程等待；进程真退出按原分诊走");
  // 三个宿主都要接同一条（一处病一次治完所有处）
  // ★ 2026-10-20：DesktopDock 已不再用 WebView2（改成纯 GDI+ 自绘，见 LayeredLayer.cs），
  //   它不再是 WebView2 宿主 ⇒ 从这里移出。现在只剩两层内核要分诊。
  for (const f of ["MainWindow.cs", "WallpaperHost.cs"]) {
    const src = read(`src/LinliShell/${f}`);
    assert.ok(/WebTriage\.IsUnresponsive\(e\.ProcessFailedKind\)/.test(src),
      `${f} 必须拦下 Unresponsive 走等一拍探活`);
    assert.ok(/HandleUnresponsiveAsync\(\)/.test(src), `${f} 必须有探活处置`);
  }
});
