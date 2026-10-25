/**
 * 「模型接口」重做的护栏（2026-10-20）。
 *
 * 用户口径（原话）：「模型页面要移到设置向上一点的位置要不太不明显了，模型选择可以学习姊妹项目，
 * 他的模型选择就挺好的，不像咱们还要自己手动输入模型名，模型界面全部都要学习姊妹项目」。
 *
 * ⇒ 三条要守住的东西：
 *   ① **位置**：模型接口是设置页的第一段（不是"页面上有这四个字"）；
 *   ② **选法**：`选择模型` 下拉按服务商分组，选一条就把地址与型号一起填好，
 *      只有「自定义」才展开地址与型号两个输入框；以前那个「服务商下拉 + 自己敲型号」的写法**删干净**；
 *   ③ **查询**：`POST /api/model/models` 真的去问那家的 /models，把编号带回来。
 *
 * ★ 为什么还有必要留静态断言（渲染已经在 analysis/_audit25/settings-cdp.mjs 里真验过）：
 *   那个探针要起服务 + 无头浏览器，不进全量回归；这一份管的是**不被回退**。
 *   所以每条都取**结构**（顺序、函数体、规则块），不取"某个词出现过"。
 *
 * ★★ 纪律（2026-10-19 被反审查打回的教训）：断言前先剥注释 ——
 *   `/* <select id="provider"> *​/` 里那几个字还在，纯文本匹配挡不住"被注释掉"。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 剥注释：CSS 用 /* *​/，JS 用 // 与 /* *​/，HTML 用 <!-- -->。顺序：先块、再行。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** 抽一个函数体：先配平**参数表**的圆括号，再从它后面的 `{` 读到配平的 `}`。
 *  ★ 不能用「第一个 { 就是函数体起点」：`function f(patch = {}) {` 里那个 `{}` 是默认值，
 *    第一版这么写时函数体只截到 `{}`，里面的断言全部形同虚设（而且它还挺"绿"）。 */
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

/** 抽一条 CSS 规则块（先剥注释再找选择器，避免匹配到注释里的名字）。 */
function rule(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") { depth -= 1; if (depth === 0) return css.slice(at, i + 1); }
  }
  return null;
}

const HTML = stripComments(read("app/public/index.html"));
const APP = stripComments(read("app/public/app.js"));
const CSS = stripComments(read("app/public/styles.css"));
const SERVER = stripComments(read("app/server.mjs"));

test("① 模型接口是设置页的第一段（判顺序，不判有没有）", () => {
  const first = HTML.indexOf('class="set-sec"');
  assert.ok(first > 0, "设置页里一段 .set-sec 都没有？");
  const firstSec = HTML.slice(first, first + 400);
  assert.match(firstSec, /id="modelSec"/u,
    "设置页第一段必须是模型接口（#modelSec）—— 用户原话「要移到设置向上一点的位置要不太不明显了」");
  // 顺序：模型接口 在 应用行为 之前
  assert.ok(HTML.indexOf('id="modelSec"') < HTML.indexOf(">应用行为<"),
    "模型接口被挪到「应用行为」后面了 —— 它本该是配置链的第一环");
  // 它以前是 <details class="set-more"> 里那个折叠块，不能再退回去
  const around = HTML.slice(HTML.indexOf('id="modelSec"') - 600, HTML.indexOf('id="modelSec"'));
  assert.ok(!/<details/u.test(around), "模型接口又被收进 <details> 折叠了 —— 那正是「太不明显」的成因");
});

test("① 旧写法（服务商下拉 + 手敲型号）已删净", () => {
  assert.ok(!HTML.includes('id="provider"'), "「服务商」下拉还在 —— 它被「选择模型」下拉取代了");
  assert.ok(!APP.includes('$("provider")'), "app.js 里还有 $(\"provider\") 的接线（那是个已经不存在的元素）");
  assert.ok(!APP.includes("fillModelList"), "fillModelList 已经不画任何东西了，删掉它，别留死函数");
  assert.ok(!HTML.includes("模型接口（回信要用）"), "旧折叠块的标题还在");
});

test("② 预设表：每家都有 label / baseUrl / models，且条目能摊平", () => {
  const start = APP.indexOf("const PROVIDER_PRESETS = {");
  assert.ok(start > 0, "找不到 PROVIDER_PRESETS");
  // 粗切到第一个 `\n};` 结束
  const end = APP.indexOf("\n};", start);
  const table = APP.slice(start, end);
  for (const provider of ["deepseek", "zhipu", "moonshot", "qwen", "minimax", "custom"]) {
    assert.ok(table.includes(`${provider}: {`), `预设表缺 ${provider}`);
  }
  // 每一家都要有 label（下拉的 optgroup 用它）与 baseUrl（选中即填）
  const labels = table.match(/label: "/gu) ?? [];
  const bases = table.match(/baseUrl: "/gu) ?? [];
  assert.ok(labels.length >= 6, `只有 ${labels.length} 个 label —— 下拉分组会退化成一堆没名字的组`);
  assert.ok(bases.length >= 6, `只有 ${bases.length} 个 baseUrl —— 选中预设就填不出地址`);

  // 摊平函数：一条 = 一家 × 一个型号
  const flat = fnBody(APP, "presetItems");
  assert.match(flat, /flatMap/u, "presetItems 必须把「一家 × 多个型号」摊平，否则下拉只有 6 条");
  assert.match(flat, /baseUrl: preset\.baseUrl/u, "摊平出来的条目要带上它自己那家的地址");
});

test("② 下拉按服务商分组，并且只画一次", () => {
  const render = fnBody(APP, "renderModelPresets");
  assert.match(render, /createElement\("optgroup"\)/u, "没按服务商分组（optgroup）");
  assert.match(render, /group\.label/u, "optgroup 没写 label（用户会看到一堆没名字的组）");
  assert.match(render, /dataset\.ready === "1"\) return/u,
    "必须挡重入：loadSettings 会被调用很多次，每次重建 optgroup 会把用户正展开的面板弹回去");
  assert.match(render, /CUSTOM_PRESET/u, "下拉末尾必须有「自定义」这一条");
});

test("② 选预设 ⇒ 地址与型号一起填好；选自定义 ⇒ 才展开两格", () => {
  const apply = fnBody(APP, "applyModelPreset");
  assert.match(apply, /\$\("baseUrl"\)\.value = item\.baseUrl/u, "选预设没把地址填进去");
  assert.match(apply, /\$\("modelName"\)\.value = item\.model/u, "选预设没把型号填进去");

  const sync = fnBody(APP, "syncModelRows");
  assert.match(sync, /\$\("modelCustom"\)\.hidden = !isCustom/u,
    "自定义两格必须按「是不是自定义」来收放，否则选预设时那两格还杵在那儿");
});

test("② 保存时 provider 由预设反查，Key 留空不覆盖已存的那份", () => {
  const save = fnBody(APP, "saveModelConfig");
  // ★ 2026-10-20 改判据（不是放宽，是收紧）：原来这里是
  //   `provider: preset ? preset.provider : "custom"` —— 型号不在清单里时（本机就是
  //   `deepseek-chat`）它会把库里原本正确的 "deepseek" 悄悄写成 "custom"。
  //   现在要求：预设认不出就**按地址再认一次**，都认不出才是 custom。
  assert.match(save, /providerOfBaseUrl\(baseUrl\)/u,
    "provider 认不出预设时必须按地址再认一次，否则型号不在清单里的用户一保存就被降级成 custom");
  assert.ok(!/provider:\s*preset \? preset\.provider : "custom"/u.test(save),
    "又退回「认不出就直接写 custom」的老写法了 —— 那会把用户原本对的 provider 改坏");
  // ★ 这一条是数据安全：接口从不回显 Key，输入框平时是空的 —— 空串绝不能当成"清空 Key"。
  assert.match(save, /if \(key\) patch\.apiKey = key;/u,
    "Key 留空时必须**不提交** apiKey（提交空串会把用户已保存的 Key 清掉）");
});

test("③ 服务端有 /api/model/models，且协议白名单 + Key 回落 + 两种 payload 都认", () => {
  assert.match(SERVER, /req\.method === "POST" && path === "\/api\/model\/models"/u,
    "路由没挂上（界面上的「查询模型列表」会 404）");
  const fn = fnBody(SERVER, "listModelIds");
  // ★ 用 includes 而不是正则去匹配"一条正则的源码"：转义层数一多，写错的那条自己会永远绿。
  assert.ok(fn.includes("^https?:\\/\\/"), "地址必须只认 http/https —— 这条地址会被拼进 fetch");
  assert.match(fn, /String\(patch\.apiKey \?\? ""\)\.trim\(\) \|\| saved\.apiKey/u,
    "Key 留空时要沿用已保存的那个（接口不回显 Key，前端提交空串是常态）");
  assert.match(fn, /payload\?\.data/u, "认不出 OpenAI 形状的 data[]");
  assert.match(fn, /payload\?\.models/u, "认不出 Ollama 那类 models[] 形状");
  assert.match(fn, /redirect: "error"/u, "必须禁重定向 —— 否则请求会被带到一个没校验过的地址");
  assert.match(fn, /catch \(error\) \{\s*return \{ ok: false, error: error\.message \}/u,
    "失败必须回 { ok:false, error }（与 /api/model/test 同一套口径），别抛出去变成 500");
});

test("④ 两个并排的 time 输入必须单独收窄，否则右栏被撑出屏幕", () => {
  const block = rule(CSS, ".set-item-c input.set-time");
  assert.ok(block, "少了 .set-item-c input.set-time 这条规则");
  assert.match(block, /width: 108px/u, "时段控件宽度不是 108px（两个 320px 并排 = 640px）");
});

test("④ 模型卡在亮壁纸上也要看得清（说明文字提到 --tx3，卡给暗底）", () => {
  const block = rule(CSS, "#modelSec .card .hint");
  assert.ok(block, "少了 #modelSec .card .hint 这条");
  assert.match(block, /var\(--tx3\)/u, "卡里的说明文字还在用 --tx4（亮壁纸上读不出来）");
  const bg = rule(CSS, "#modelSec .card");
  assert.ok(bg, "少了 #modelSec .card 的底色");
  assert.match(bg, /rgba\(10, 12, 16, \.8/u, "模型卡没有暗底，壁纸一亮就糊成一片");
});

// ---------------------------------------------------------------- 2026-10-20 追加：兜住"已保存但不在清单里"
//
// 真实事故（终轮审查 F5）：本机库里保存的是 `deepseek-chat`，而预设表里只有 v4 系列。
// 于是 `currentPreset()` 返回 null ⇒ 下拉落到「自定义」、手填两格展开、提示换成"本地或中转"、
// 「当前在用」连厂商名都没了 —— **正是用户这次要消掉的那个状态**。
// 为什么之前的 9 条 + CDP 12 条全绿还没抓到：夹具都写 `deepseek-v4-flash`（表里的好值）。
// 夹具喂理想值，判据就绕过了真实状态。
//
// 真渲染的 A/B 在 `analysis/_audit26/preset-current.mjs`（组 1 = deepseek-chat，组 2 = 对照组）；
// 下面这一组管的是**不被回退**。

test("⑤ 已保存但不在清单里的型号：下拉要停在「当前在用」，不能把人扔回「自定义」", () => {
  const ensure = fnBody(APP, "ensureCurrentOption");
  // 幂等：loadSettings 会跑很多次，重复 prepend 会长出一串一样的条目
  assert.match(ensure, /querySelectorAll\(`option\[value="\$\{CURRENT_PRESET\}"\]`\)/u,
    "没清掉上一次插进去的「当前在用」条目 —— loadSettings 跑两次就会出现两条");
  assert.match(ensure, /select\.prepend\(option\)/u, "没能把「当前在用」放回下拉里");
  assert.match(ensure, /providerOfBaseUrl\(model\.baseUrl\)/u,
    "型号不在清单里时还要按地址认出是哪一家，否则提示框会显示「本地或中转」");
  // 认得出就不要再插（否则用户选了预设之后又冒出个"当前在用"）
  assert.match(ensure, /presetItems\(\)\.some\(/u,
    "少了「已经在清单里就不用插」的判断");

  const load = fnBody(APP, "loadSettings");
  assert.match(load, /ensureCurrentOption\(model\)/u, "loadSettings 没调用 ensureCurrentOption");
  assert.match(load, /currentEntry \? CURRENT_PRESET : CUSTOM_PRESET/u,
    "下拉回填只认「清单里有的」，没有「当前在用」这一档 —— 用户还是会被扔进自定义");
});

test("⑤ 「当前在用」这一档不展开手填两格，且提示给的是那一家的原话", () => {
  const sync = fnBody(APP, "syncModelRows");
  assert.match(sync, /hidden = !isCustom/u, "两格的收放必须只看「是不是自定义」");
  assert.ok(!/CURRENT_PRESET[\s\S]{0,120}?hidden = false/u.test(sync),
    "别把「当前在用」也展开 —— 地址和型号都是已知的，展开等于让人以为要重填");
  assert.match(sync, /PROVIDER_PRESETS\[currentEntry\.provider\]\?\.note/u,
    "提示必须给那一家的 note（DeepSeek 那句「已退役，别再填」才是用户要看的）");

  const apply = fnBody(APP, "applyModelPreset");
  assert.match(apply, /value === CURRENT_PRESET && currentEntry/u,
    "选回「当前在用」时要把原来那份地址与型号填回去（否则用户点来点去就把它弄丢了）");

  const current = fnBody(APP, "renderModelCurrent");
  assert.match(current, /providerOfBaseUrl\(model\.baseUrl\)/u,
    "「当前在用」型号不在清单里时也要报出厂商名，否则分不清是哪一家");
});

test("⑤ 模型卡说明写全了 Key 的三个外发点（含「查询模型列表」）", () => {
  // ★ 用「结构 + 关键短语」定位，不要逐字匹配整句中文 ——
  //   第一版写的是 `回信、整理记忆要…`，而原文是「记忆**都**要」，差一个字就永远匹配不上（白跑一趟）。
  const sub = /<p class="set-sub">([^<]*Key 只存在[^<]*)<\/p>/u.exec(HTML);
  assert.ok(sub, "找不到模型卡那段说明（被改名/挪走了？）");
  const text = sub[1];
  assert.match(text, /保存并测试/u, "说明里少了「保存并测试」这个外发点");
  assert.match(text, /查询模型列表/u,
    "说明里少了「查询模型列表」—— 那个按钮同样把 Key 发给对方，漏写就是承诺比事实窄");
  assert.match(text, /写回信/u, "说明里少了「真的写回信」这个外发点");
});

test("⑤ 协议里不许再写「例外只有一处」（现在是两条 + Key 的三个时刻）", () => {
  const agreement = fs.readFileSync(path.join(ROOT, "协议.txt"), "utf8");
  assert.ok(!/例外只有一处/u.test(agreement),
    "协议第一条又写回「例外只有一处」了 —— 会离开本机的现在有回信与检查更新两件事");
  assert.match(agreement, /检查更新/u, "协议里没写「检查更新」这条外发");
  assert.match(agreement, /查询模型列表/u, "协议里没写「查询模型列表」会带走 Key");
  // legal.js 是 协议.txt 生成物，两边必须逐字一致（legal.test.js 也在守，这里就近加一道）
  const legal = fs.readFileSync(path.join(ROOT, "app", "public", "legal.js"), "utf8");
  assert.ok(!/例外只有一处/u.test(legal), "legal.js 是旧版 —— 改完 协议.txt 要跑 tools/sync-legal.mjs");
});
