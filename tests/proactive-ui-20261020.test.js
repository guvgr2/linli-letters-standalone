/**
 * 「林离主动来信」重做的护栏（2026-10-20）。
 *
 * 用户口径（原话）：「主动来信界面设计的还是不够全，依旧学习姊妹项目，你别等我一个一个查了，
 * 你自己看一遍姊妹项目，看看有什么可以借鉴的」。
 *
 * 照姊妹项目 `public/proactive-settings.js` 补的六件事，逐条钉住：
 *   ① 「现在为什么不写」**进页面就有**（以前只在点了按钮之后才有一行字）；
 *   ② 额度给成「已发 x / 上限」；
 *   ③ 「她自己的作息」读世界状态；
 *   ④ 时段是 type="time"（自由文本写错一个字符会被判定层直接停掉主动来信）；
 *   ⑤ 「恢复默认」只填输入框、**不落库**；
 *   ⑥ 开关是勾选框，不是"开/关"下拉。
 *
 * ★★ 还有一条更要紧的：「保持她现在的样子」以前是个**空开关** ——
 *   界面上摆着、POST 不落库、拼提示词时也没人读 ⇒ 勾了等于没勾。
 *   本文件把它锁成"真的会被消费"，见最后两条。
 *
 * ★ 渲染级验证（真起服务 + 无头浏览器）在 `analysis/_audit25/settings-cdp.mjs`；
 *   这一份管的是不被回退，所以断言一律取**结构**（函数体 / 规则块 / 表成员）。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 抽函数体：先配平参数表的圆括号，再从它后面的 `{` 读到配平的 `}`。
 *  ★ 不能拿「第一个 { 」当函数体起点：`function f(patch = {}) {` 里那个 `{}` 是默认值。 */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `找不到 function ${name}( —— 被改名了？断言会形同虚设`);
  let j = src.indexOf("(", i);
  let paren = 0;
  for (; j < src.length; j += 1) {
    if (src[j] === "(") paren += 1;
    else if (src[j] === ")") { paren -= 1; if (paren === 0) break; }
  }
  const open = src.indexOf("{", j);
  let depth = 0;
  for (let k = open; k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) return src.slice(open, k + 1); }
  }
  assert.fail(`function ${name} 的花括号没闭合`);
}

/** 取 `id="x"` 那个元素的开标签（含属性），方便按属性断言。 */
function tag(html, id) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at > 0, `设置页里没有 #${id}`);
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf(">", at);
  return html.slice(start, end + 1);
}

/** 取某个按钮的事件处理函数体：`$("id").addEventListener("click", async () => { ... });`
 *  ★ 这两处是**匿名箭头函数**（不是 function 声明），所以不能用 fnBody。
 *    找 `=> {` 之后按花括号配平读 —— 里面还有嵌套的 if/for，按缩进猜会截错。 */
function handler(src, id) {
  const at = src.indexOf(`$("${id}").addEventListener("click"`);
  assert.ok(at > 0, `找不到 #${id} 的 click 处理器`);
  const arrow = src.indexOf("=> {", at);
  assert.ok(arrow > 0, `#${id} 的处理器不是 \`=> { ... }\` 形状`);
  let depth = 0;
  for (let k = arrow + 3; k < src.length; k += 1) {
    if (src[k] === "{") depth += 1;
    else if (src[k] === "}") { depth -= 1; if (depth === 0) return src.slice(arrow, k + 1); }
  }
  assert.fail(`#${id} 的处理器花括号没闭合`);
}

const HTML = stripComments(read("app/public/index.html"));
const APP = stripComments(read("app/public/app.js"));
const CSS = stripComments(read("app/public/styles.css"));
const SERVER = stripComments(read("app/server.mjs"));

test("① 开关是勾选框，不是「开/关」下拉", () => {
  const t = tag(HTML, "pEnabled");
  assert.match(t, /<input/u, `开关不是 input：${t}`);
  assert.match(t, /type="checkbox"/u, `开关不是勾选框：${t}`);
  // 用设置页统一的药丸开关，不要原生方框（用户截图里那一格小方块非常突兀）
  const wrap = HTML.slice(Math.max(0, HTML.indexOf('id="pEnabled"') - 200), HTML.indexOf('id="pEnabled"'));
  assert.match(wrap, /class="switch"/u, "开关没套 .switch —— 设置页里所有布尔项都是药丸开关");
});

test("① 进页面就显示判定：loadSettings 里没有「等点了按钮才填」的分支", () => {
  const load = fnBody(APP, "loadSettings");
  assert.match(load, /\$\("proactiveVerdict"\)\.textContent/u,
    "loadSettings 没填「现在为什么不写」—— 那格会一直停在「正在读取…」");
  assert.match(load, /\$\("proactiveStats"\)\.textContent/u, "没填「已发 x / 上限」");
  assert.match(load, /\$\("proactiveHer"\)\.textContent/u, "没填「她自己的作息」");
  assert.match(load, /proactiveDefaults = data\.defaults/u, "没留住默认值 —— 「恢复默认」会没数可填");
});

test("② 额度给成「已发 / 上限」，两边的数都来自同一次响应", () => {
  const load = fnBody(APP, "loadSettings");
  assert.match(load, /data\.stats/u, "没读 stats —— 额度只能靠用户自己数");
  assert.match(load, /s\.maxPerDay/u, "上限没从 settings 里取");
  assert.match(load, /已发：24 小时/u, "文案不是「已发：24 小时 …」");
});

test("③ 「她自己的作息」：服务端把世界状态翻成核心认的代号，界面照实说", () => {
  const fn = fnBody(SERVER, "herActivityNow");
  assert.match(fn, /SELECT activity FROM world_state ORDER BY at DESC LIMIT 1/u,
    "没读 world_state 最新一行（别在这里重新算一次世界，GET 不该有副作用）");
  assert.match(SERVER, /\["练琴", "practice"\]/u, "「练琴」没翻成核心的 practice");
  assert.match(SERVER, /\["睡了", "sleeping"\]/u, "「睡了」没翻成核心的 sleeping");
  // ★ 这道闸门以前只有单测喂过：生产路径从不传 herActivity ⇒ 她练着琴也会写信。
  const ctx = SERVER.slice(SERVER.indexOf("function evaluateProactive("), SERVER.indexOf("function evaluateProactive(") + 1200);
  assert.match(ctx, /herActivity: herActivityNow\(\)\.busy/u,
    "判定的 ctx 里没喂 herActivity —— 「她自己在忙就不写」那道闸门在生产里等于不存在");
});

test("④ 时段是 time 控件（自由文本会给判定层送进 BAD_WINDOW）", () => {
  for (const id of ["pStart", "pEnd"]) {
    assert.match(tag(HTML, id), /type="time"/u, `#${id} 不是 type="time"`);
  }
  // 两个并排的 time 控件必须单独收窄，否则右栏被撑出屏幕（实测 640px）
  assert.match(CSS, /\.set-item-c input\.set-time \{ width: 108px; \}/u, "少了 .set-time 的宽度");
});

test("⑤ 「恢复默认」只填输入框，不调接口", () => {
  assert.ok(tag(HTML, "resetProactive").length > 0);
  const fn = handler(APP, "resetProactive");
  for (const id of ["pDay", "pWeek", "pGap", "pStart", "pEnd"]) {
    assert.match(fn, new RegExp(`\\$\\("${id}"\\)\\.value = proactiveDefaults`, "u"),
      `恢复默认没把 #${id} 填回默认值`);
  }
  // ★ 关键：不落库。填完还要用户自己点保存 —— 与姊妹项目同一口径。
  assert.ok(!fn.includes('api("/api/proactive"'), "恢复默认自己去调接口了 —— 那会把用户没确认的值直接写进去");
});

test("⑥ 保存读的是 .checked（下拉早就删了）", () => {
  const fn = handler(APP, "saveProactive");
  assert.match(fn, /enabled: \$\("pEnabled"\)\.checked/u, "保存还在读 .value —— 勾选框没有 .value 这回事");
  assert.ok(!fn.includes('$("pEnabled").value'), "保存里还留着 $(\"pEnabled\").value");
});

test("★ 「保持她现在的样子」不再是空开关：落库 + 被消费", () => {
  // a) POST 的落盘表里有它，而且按布尔写（否则 "false" 会被存成非空字符串 ⇒ 关不掉）
  const post = SERVER.slice(SERVER.indexOf('path === "/api/proactive"'), SERVER.indexOf('path === "/api/proactive"') + 2000);
  assert.match(post, /BOOL = \{ enabled: true, asked: true, keepCurrentShape: true \}/u,
    "keepCurrentShape 不在 BOOL 表里 ⇒ false 会被 String() 成 \"false\" ⇒ 关不掉");
  assert.match(post, /keepCurrentShape: "proactive_keep_shape"/u, "keepCurrentShape 没有落盘键 ⇒ 勾了等于没勾");

  // b) 真的有人读它：打开时「她此刻」那一行不进提示词
  const mem = fnBody(SERVER, "memoryContext");
  assert.match(mem, /const near = keepCurrentShape\(\) \? "" : worldContext\(\)/u,
    "memoryContext 没读 keepCurrentShape —— 这个开关又变成摆设了");
  assert.match(mem, /\.\.\.\(near \?/u, "算出来的 near 没用上（那行还在无条件注入）");

  // c) GET 把真值送到界面上
  assert.match(SERVER, /nearTerm: near/u, "GET /api/proactive 没回 nearTerm，界面只能永远显示未勾选");
});
