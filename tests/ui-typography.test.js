/**
 * 字体兜底链 / 明信片长信可滚 的护栏（独立审查「字体适配与排版」🟠 必修-1、必修-2）。
 *
 * 为什么用**源码断言**而不是真机像素指纹：真机那套（canvas 像素哈希）我这边跑不了，
 * 但这两个缺陷的本质都是「CSS 里写错了」，而且改回去**不会有任何测试变红**。
 * ⇒ 先把「两支字的兜底不许撞车」「正文不许 hidden」钉成静态断言，
 *   真机验收交给审查那边跑他们给的 Console 命令。
 *
 * ★ 解析前**必须先剥掉 CSS 注释**：我为了解释这次修改写的注释里就含有
 *   `STKaiti` / `KaiTi` 这些字样，不剥会把注释当成字体栈的一部分（假绿/假红）。
 *   这是本项目反复强调的那条：静态检查挡不住「被注释掉的内容」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CSS = new URL("../app/public/styles.css", import.meta.url);
const raw = await readFile(CSS, "utf8");
// ★ 2026-10-18：信卡那一族的规则在 styles-original.css（照原版排版的那张表），
//   不在这里。护栏必须看**真实生效的那张表**，否则守的是一堆没人用的旧类（见 ③ 的注释）。
const CSS_ORIGINAL = new URL("../app/public/styles-original.css", import.meta.url);
const rawOriginal = await readFile(CSS_ORIGINAL, "utf8");

/** 剥掉 /* *\/ 注释（含跨行），返回纯规则文本。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//gu, "");
}
const css = stripComments(raw);
const cssOriginal = stripComments(rawOriginal);

/** 取某个 `--变量: …;` 的完整值（变量定义可能跨行）。 */
function cssVar(name) {
  const re = new RegExp(`(?:^|[;{\\s])${name}\\s*:([^;}]*)`, "u");
  const m = re.exec(css);
  return m ? m[1] : null;
}

/** 把字体栈拆成有序的名字数组（去引号、去空格）。 */
function stackOf(value) {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/gu, ""))
    .filter(Boolean);
}

/** 本机可能真有的那几支楷体/行楷 —— 兜底就落在这批里。 */
const SYSTEM_FALLBACKS = new Set(["STKaiti", "STKaiTi", "华文楷体", "KaiTi", "楷体", "STXingkai", "华文行楷"]);

test("① ★ 两支信纸字的兜底**不许撞车**（没导入字体时也必须分得开）", () => {
  const letter = stackOf(cssVar("--letter-font"));
  const compose = stackOf(cssVar("--compose-font"));
  assert.ok(letter.length, "没解析到 --letter-font");
  assert.ok(compose.length, "没解析到 --compose-font");

  const fb = (list) => list.find((n) => SYSTEM_FALLBACKS.has(n)) ?? null;
  const a = fb(letter);
  const b = fb(compose);
  assert.ok(a, `--letter-font 的兜底里没有系统楷体：${letter.join(" / ")}`);
  assert.ok(b, `--compose-font 的兜底里没有系统楷体：${compose.join(" / ")}`);
  assert.notEqual(
    a,
    b,
    `两支字又落到同一支兜底了（都是 ${a}）⇒ 没装字体的机器上「她写的」和「我写的」是同一支笔，` +
      "`.letter .body.mine` 那条规则等于白写",
  );
});

test("② 兜底里 STXingkai 不许再排在楷体/华文楷体之前（行楷当 20px 正文兜底太飘）", () => {
  for (const name of ["--letter-font", "--compose-font"]) {
    const list = stackOf(cssVar(name));
    const iXing = list.indexOf("STXingkai");
    const iKai = list.findIndex((n) => ["STKaiti", "KaiTi", "楷体"].includes(n));
    if (iXing < 0) continue; // 没有行楷就不用管
    assert.ok(iKai >= 0, `${name} 里有 STXingkai 却没有任何楷体兜底`);
    assert.ok(iXing > iKai, `${name} 里 STXingkai(${iXing}) 又排到楷体(${iKai}) 前面了`);
  }
});

/** ★ 2026-10-18 改：守**真实生效的类**，不是没人用的旧类。
 *
 * 改之前这两条断言查的是 `.reply-card .reply-text` / `.reply-card` —— 那套类是
 * app.js 早期版本画的明信片卡，**全仓已经没有任何 JS 产出它**（grep `reply-card`
 * 只命中 styles.css 自己与这两个测试）。也就是说护栏一直绿着，而真正在读信用的那套
 * （mail-ui.js 的 renderCard → `.mail-responsive-card` + `.mail-box-reply-content-text`）
 * **一条样式都没有**：
 *   实测（浏览器里调 renderCard 画长信）改前 → 字号 14px、微软雅黑、色 #e8e9eb（浅色字
 *   印在米白纸纹上）、overflow-y:visible、卡片 384×500（被压成竖条）。长信溢出卡外，
 *   既看不到也滚不到。
 * ⇒ 护栏改到真实类上，并补一条「这些类必须真有宿主」的反向断言：
 *    守一个没人用的选择器，比不守更糟 —— 它给的是「已保护」的错觉。
 */
const CARD = ".mail-responsive-card";
const TEXT = ".mail-box-reply-content-text";

test("③ ★ 明信片正文必须能滚（长信不许被静默裁掉）", () => {
  const m = new RegExp(`\\${TEXT}\\s*\\{([^}]*)\\}`, "u").exec(cssOriginal);
  assert.ok(m, `没找到 ${TEXT} 规则（styles-original.css）`);
  const body = m[1];
  assert.match(body, /overflow-y:\s*auto/u, "正文必须 overflow-y:auto —— 否则长信最后一截被吞掉且没法滚");
  assert.doesNotMatch(body, /overflow:\s*hidden/u, "正文不能再是 overflow:hidden（会把内容静默裁掉）");
  // 字与色也必须钉住：没有 font/color 时浏览器按继承算，实测就是 14px 浅灰字的「隐形信」。
  assert.match(body, /font-size:\s*16px/u, "正文字号必须是原版的 16px");
  assert.match(body, /color:\s*var\(--tp-grey-0\)/u, "正文必须是暖墨 --tp-grey-0（浅色字印在米白纸上读不出来）");
  assert.match(body, /font-family:\s*SentyTEA/u, "正文必须优先 SentyTEA（原版信件体）");
});

test("④ 居中必须用 safe（否则 flex 居中会把溢出两端对切，顶上几行永远滚不到）", () => {
  const card = new RegExp(`\\${CARD}\\s*\\{([^}]*)\\}`, "u").exec(cssOriginal);
  assert.ok(card, `没找到 ${CARD} 规则（styles-original.css）`);
  assert.match(card[1], /align-items:\s*safe\s+center/u, `${CARD} 必须是 align-items: safe center`);
  assert.match(card[1], /aspect-ratio:\s*16\s*\/\s*9/u, `${CARD} 必须锁住 16:9（不锁会被容器压成竖条）`);
});

test("⑤ 信卡的类必须真有 JS 产出（反向断言：守无人使用的选择器等于没守）", async () => {
  const js = stripComments(await readFile(new URL("../app/public/mail-ui.js", import.meta.url), "utf8"));
  for (const cls of ["mail-responsive-card", "mail-card-meta", "mail-box-reply-content-text"]) {
    assert.ok(js.includes(cls), `mail-ui.js 里没有产出 .${cls} —— 那么 CSS 里那组规则就是死的`);
  }
});
