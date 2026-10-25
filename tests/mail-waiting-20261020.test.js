/**
 * 「她正在回信」那一态 + 素材随包（2026-10-20 用户两条口径）。
 *
 * ★ 用户原话：
 *   ① 「在回信的过程中，要播放原版游戏的林离正在回信的动画，你看看这个功能咱们有没有，
 *      如果没有这个功能直接抄原版游戏就行」；
 *   ② 「这些游戏素材必须随包」。
 *
 * ★ 上一版为什么算"没有这个功能"：`.mail-card-waiting*` 三条样式早在抄原版时就跟进来了，
 *   但 mail-ui.js **从来没渲染过它们** —— 等待回信时卡片只有静态底图 postcard_video.webp
 *   加一行「她还在写……」。静态存在性断言挡不住这种"样式在、渲染没有"，
 *   所以这里断言的是**渲染路径**（renderCard 的 kind==="video" 分支真的 append waitingBlock），
 *   而不是"某几个 class 名在文件里出现过"。
 *
 * ★ 「素材随包」不是"记得拷"：整条链有三段 —— 仓库里得有文件、组装脚本得整目录拷、
 *   安装脚本得递归收。任何一段改成白名单，都会变成"开发机上看得到、用户装完是黑框"。
 *   三段各一条断言，缺哪段红在哪段。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 剥 JS 的两种注释：★ 不剥的话，"被注释掉的调用"照样能让断言绿（这个仓踩过）。 */
function stripJs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
/** 剥 CSS 注释：`/* .x{...} *\/` 里那几个字还在，纯文本断言挡不住。 */
function stripCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
/** 剥 .ps1 / .iss 的注释（; 与 #）。 */
function stripScript(src) {
  return src.replace(/^\s*;.*$/gm, "").replace(/^\s*#.*$/gm, "");
}

const UI = stripJs(read("app/public/mail-ui.js"));
const APP = stripJs(read("app/public/app.js"));
const CSS = stripCss(read("app/public/styles-original.css"));
const HTML = read("app/public/index.html");
const BUILD = stripScript(read("build.ps1"));
const ISS = stripScript(read("install.iss"));

/**
 * 取某个函数的函数体。
 * ★ 必须这么干：`video.muted = true;` 在 mail-ui.js 里**出现两次**（写信卡那张也有），
 *   对整份文件断言等于没断言 —— 变异验证当场证明了这一点（把 waitingBlock 里的静音改成
 *   false，断言照样绿，因为它匹配到的是写信卡那一处）。判据必须落在**被测的那个函数里**。
 */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `找不到 function ${name}`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  assert.fail(`function ${name} 的花括号没闭合`);
}

const WAIT = fnBody(UI, "waitingBlock");

test("① 等待回信 = 圆形小视频 + 原版文案（不是静态图 + 一行字）", () => {
  // 原版用的就是 home_idle 这支（main-31595bd3.js 里 mailbox_waiting_for_reply 那一支）
  assert.match(UI, /const WAIT_VIDEO = ASSET\("home_idle-eb9cb735\.mp4"\);/u,
    "等待态的视频必须是 home_idle（原版那一支）");
  assert.match(UI, /const WAIT_TEXT = "林离回信中\.\.\.";/u,
    "文案必须逐字照原版 zh-cn 的 mailbox_waiting_for_reply（林离回信中...）");

  // 视频元素：muted/loop/playsinline 一个都不能少（少一个 WebView2 就不自动播）
  assert.match(WAIT, /video\.muted = true;/u, "必须静音，否则自动播放会被拒");
  assert.match(WAIT, /video\.loop = true;/u, "必须循环（她回信时长不定，播完不能停住）");
  assert.match(WAIT, /video\.playsInline = true;/u, "必须 playsinline");
  assert.match(WAIT, /video\.setAttribute\("muted", ""\);/u,
    "静音要同时落到 HTML 特性上（自动播放策略看的是特性，不是 JS 属性）");
  assert.match(WAIT, /video\.src = WAIT_VIDEO;/u, "视频源要真的挂上去");

  // 播不动要摘掉，不许留一个黑圆
  assert.match(WAIT, /p\.catch\(drop\)/u, "play() 被拒时必须把视频摘掉（否则纸面上是个黑圆）");
  assert.match(WAIT, /video\.addEventListener\("error", drop\)/u, "解码失败也要摘掉");
});

test("② 渲染路径真的走到等待块（样式在 ≠ 界面有）", () => {
  assert.match(UI, /function waitingBlock\(\)/u, "必须有 waitingBlock()");
  assert.match(UI, /box\.className = "mail-card-waiting";/u, "容器类名对得上样式");
  assert.match(UI, /video\.className = "mail-card-waiting-video";/u, "视频类名对得上样式");
  assert.match(UI, /text\.className = "mail-card-waiting-text";/u, "文案类名对得上样式");
  // ★ 关键：renderCard 的 video 分支要 append 它，而不是走"静态正文"那条路
  assert.match(UI, /if \(view\.kind === "video"\) \{[\s\S]{0,220}card\.appendChild\(waitingBlock\(\)\);/u,
    "renderCard 在 kind==='video' 时必须挂 waitingBlock（上一版这里是静态 text）");
  assert.match(APP, /kind: "video", from: "林离", when: formatTime\(item\.created_at\), text: "林离回信中\.\.\."/u,
    "app.js 的 replyCard 文案也要跟原版一致");
});

test("③ 样式：圆角裁切 + 2px 深墨描边 + 文案贴底", () => {
  const rule = (sel) => {
    const i = CSS.indexOf(sel);
    assert.ok(i >= 0, `找不到规则 ${sel}`);
    const open = CSS.indexOf("{", i);
    const close = CSS.indexOf("}", open);
    return CSS.slice(open + 1, close);
  };
  const video = rule(".mail-card-waiting-video");
  assert.match(video, /border-radius: 50%;/u, "必须是圆形（原版 rounded-full）");
  assert.match(video, /object-fit: cover;/u, "必须 cover，否则脸会被压扁");
  assert.match(video, /border: 2px solid var\(--tp-grey-0\);/u, "2px 深墨描边（原版同款）");
  assert.match(video, /aspect-ratio: 1;/u, "正方形，否则椭圆");
  const text = rule(".mail-card-waiting-text");
  assert.match(text, /position: absolute;/u, "文案绝对定位（原版 absolute bottom-5）");
  assert.match(text, /bottom: 20px;/u, "底距 20px，跟原版 bottom-5 一致");
  // 两份样式表都得被页面加载，否则规则等于没写
  assert.match(HTML, /href="styles-original\.css"/u, "styles-original.css 必须被 index.html 加载");
});

test("④ 素材随包：仓库里有 → 组装时整目录拷 → 安装时递归收", () => {
  // (1) 仓库里真的有这些文件，而且不是 0 字节
  const referenced = new Set();
  for (const m of UI.matchAll(/ASSET\("([^"]+)"\)/gu)) referenced.add(m[1]);
  assert.ok(referenced.size >= 8, `mail-ui.js 里应该有一批素材引用，实际 ${referenced.size} 个`);
  const assetsDir = path.join(ROOT, "app", "public", "assets");
  for (const name of referenced) {
    const p = path.join(assetsDir, name);
    assert.ok(fs.existsSync(p), `素材缺失：app/public/assets/${name}`);
    assert.ok(fs.statSync(p).size > 0, `素材是空文件：${name}`);
  }
  // 等待态那支必须在里面（它是本轮新接上的那个功能）
  assert.ok(referenced.has("home_idle-eb9cb735.mp4"), "等待回信的视频没被引用？");

  // (2) 组装：整个 app 目录递归拷进 dist\package（不是白名单）
  assert.match(BUILD,
    /Copy-Item -LiteralPath \$appDir -Destination \(Join-Path \$packageDir 'app'\) -Recurse -Force/u,
    "build.ps1 必须整目录递归拷 app —— 改成逐个文件列举就等于埋『用户装完没有素材』");

  // (3) 安装：Inno 的 [Files] 必须递归收 app 子树
  assert.match(ISS,
    /Source: "dist\\package\\app\\\*"; DestDir: "\{app\}\\app"; Flags: [^\n]*recursesubdirs/u,
    "install.iss 必须 recursesubdirs 收 app 子树，否则 mp4/webp 装不进用户机器");

  // (4) 已经组装好的包（如果有）里也得看得见
  const pkgAssets = path.join(ROOT, "dist", "package", "app", "public", "assets");
  if (fs.existsSync(pkgAssets)) {
    for (const name of referenced) {
      assert.ok(fs.existsSync(path.join(pkgAssets, name)),
        `dist/package 里少了 ${name} —— 组装那一步把它漏了`);
    }
    const idle = path.join(pkgAssets, "home_idle-eb9cb735.mp4");
    assert.ok(fs.statSync(idle).size > 1000000,
      "包内 home_idle 视频大小不对（应该是 2.4MB 那个）");
  }
});
