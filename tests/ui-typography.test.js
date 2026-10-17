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

/** 剥掉 /* *\/ 注释（含跨行），返回纯规则文本。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//gu, "");
}
const css = stripComments(raw);

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

test("③ ★ 明信片正文必须能滚（长信不许被静默裁掉）", () => {
  // 取 .reply-card .reply-text 那段规则体
  const m = /\.reply-card\s+\.reply-text\s*\{([^}]*)\}/u.exec(css);
  assert.ok(m, "没找到 .reply-card .reply-text 规则");
  const body = m[1];
  assert.match(body, /overflow-y:\s*auto/u, "正文必须 overflow-y:auto —— 否则长信最后一截被吞掉且没法滚");
  assert.doesNotMatch(body, /overflow:\s*hidden/u, "正文不能再是 overflow:hidden（会把内容静默裁掉）");
});

test("④ 居中必须用 safe（否则 flex 居中会把溢出两端对切，顶上几行永远滚不到）", () => {
  const card = /\.reply-card\s*\{([^}]*)\}/u.exec(css);
  assert.ok(card, "没找到 .reply-card 规则");
  assert.match(card[1], /align-items:\s*safe\s+center/u, ".reply-card 必须是 align-items: safe center");
});
