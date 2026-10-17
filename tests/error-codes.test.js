/**
 * 错误号的护栏。
 *
 * 用户 2026-10-17 的要求原文：「程序报错代码一定要有能让程序快速识别的报错号，
 *   和方便用户查看的显式报错。」⇒ 两条腿：界面上一句话（中文+号），日志/响应里一个纯号。
 *
 * 这里防的不是「号写得不好看」，是三件**会真出事**的事：
 *   ① 表本身自洽 —— 键=值、值不重复（一码两义会让 grep 出两个不同地点）；
 *   ② 出口不许漏号 —— 新加一处错误时报错没号，等于体系白建（这是最会复发的一条）；
 *   ③ 号与文档不许脱钩 —— 姊妹项目 2026-10-17 的真实教训：
 *      `LOCAL_AI_PROCESS_REMOVED` 收表时改名成 `MODEL_LOCAL_PROCESS_REMOVED`，
 *      代码测试都跟了，唯独 `docs/本地服务API清单.md` 没跟，而那份文档没有任何
 *      机器校验会读它 ⇒ 名字悄悄漂了。本文件第 ⑥ 条就是为它立的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ERR, codeMessage, ApiError } from "../app/error-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SERVER = read("app/server.mjs");
const DOC = read("错误号一览.md");

/**
 * 取源码里某次调用的文本片段：从 `call` 出现处，到该调用自己的 `;`（或窗口上限）为止。
 *
 * ★ 为什么不用 `\(([^)]*)\)` 精确配对：message 里会出现半角括号
 *   （如 `` `字体文件太大了（上限 ${Math.round(limit / 1024 / 1024)} MB）` `` 里的
 *   `Math.round(`），正则会在那儿提前截断，把带号的调用误判成没带号。
 *   按字符窗口取段是本项目既有先例（proactive-validate.test.js 第 ⑨ 条同套路）。
 */
function callSlices(src, call, window = 500) {
  const out = [];
  for (let i = src.indexOf(call); i >= 0; i = src.indexOf(call, i + call.length)) {
    const semi = src.indexOf(";", i);
    const end = semi < 0 ? i + window : Math.min(semi + 1, i + window);
    out.push({ at: i, line: src.slice(0, i).split("\n").length, text: src.slice(i, end) });
  }
  return out;
}

const codes = Object.values(ERR);

test("① 错误号表自洽：键=值、无重复值、命名规范、域前缀合法", () => {
  for (const [key, value] of Object.entries(ERR)) {
    assert.equal(key, value, `键与值必须一致（改一半会让 grep 出两个名字）：${key} → ${value}`);
    assert.match(value, /^[A-Z][A-Z0-9_]*$/, `号只能是「大写字母/数字/下划线」：${value}`);
  }

  const seen = new Map();
  for (const code of codes) {
    assert.equal(seen.has(code), false, `一码两义（值重复）：${code}`);
    seen.set(code, true);
  }

  const DOMAINS = ["COMMON", "LETTER", "LIBRARY", "IDLE", "FONT", "IMPORT", "PROACTIVE", "MODEL", "REPLY"];
  for (const code of codes) {
    const domain = code.split("_")[0];
    assert.ok(DOMAINS.includes(domain), `号必须以已知域开头（${DOMAINS.join("/")}）：${code}`);
  }

  assert.ok(codes.length >= 20, `号太少（${codes.length} 个）—— 是不是表被删了一块？`);
});

test("② codeMessage：把号拼进给用户看的那句话，格式是「中文（号）」", () => {
  assert.equal(codeMessage("信是空的", ERR.LETTER_EMPTY), "信是空的（LETTER_EMPTY）");
  // 全角括号，不是半角 —— 中文句子里两个半角括号看着像代码，不像话
  assert.ok(codeMessage("信是空的", ERR.LETTER_EMPTY).includes("（LETTER_EMPTY）"));
});

test("③ ApiError：不给号时落到 COMMON_INTERNAL，给了就用自己的", () => {
  assert.equal(new ApiError(400, "随便什么").code, ERR.COMMON_INTERNAL);
  assert.equal(new ApiError(400, "随便什么").status, 400);
  const e = new ApiError(404, "没有这一封信", ERR.LETTER_NOT_FOUND);
  assert.equal(e.code, ERR.LETTER_NOT_FOUND);
  assert.equal(e.message, "没有这一封信", "message 里不许预先拼号（拼了会在 fail/落库处再拼一次）");
  assert.ok(e instanceof Error);
});

test("④ server.mjs 里每一处 new ApiError 都必须带号（第三个参数）", () => {
  const calls = callSlices(SERVER, "new ApiError(");
  assert.ok(calls.length >= 7, `只找到 ${calls.length} 处 new ApiError，抽取逻辑可能坏了`);
  const naked = calls.filter((c) => !/\bERR\.[A-Z_]+\b/.test(c.text));
  assert.equal(naked.length, 0,
    `这些 new ApiError 没给号（第 ${naked.map((c) => c.line).join("、")} 行）：\n`
    + naked.map((c) => `  L${c.line}: ${c.text.split("\n")[0].trim()}`).join("\n"));
});

test("⑤ server.mjs 里每一处 json(res, 4xx/5xx, { error … }) 都必须带 code 字段", () => {
  const calls = [];
  for (const m of SERVER.matchAll(/json\(res,\s*[45]\d\d\s*,\s*\{/g)) {
    const semi = SERVER.indexOf(";", m.index);
    const end = semi < 0 ? m.index + 700 : Math.min(semi + 1, m.index + 700);
    calls.push({ line: SERVER.slice(0, m.index).split("\n").length, text: SERVER.slice(m.index, end) });
  }
  const naked = calls.filter((c) => !/\bcode:/.test(c.text));
  assert.equal(naked.length, 0,
    `这些错误响应没带 code（第 ${naked.map((c) => c.line).join("、")} 行）——`
    + " 前端/测试要按号分支，只给中文文案等于没给：\n"
    + naked.map((c) => `  L${c.line}: ${c.text.split("\n")[0].trim()}`).join("\n"));
});

test("⑥ server.mjs 里每一处 fail(res, …) 都必须带 ERR 表里的号", () => {
  // `fail(res,` 也会命中函数**定义**那一行（`function fail(res, status, code, …)`），
  //   定义行当然没有号 —— 按前缀排掉，别把定义当调用。
  const calls = callSlices(SERVER, "fail(res,")
    .filter((c) => SERVER.slice(c.at - 9, c.at) !== "function ");
  assert.ok(calls.length >= 12, `只找到 ${calls.length} 处 fail() 调用，抽取逻辑可能坏了`);
  const naked = calls.filter((c) => !/\bERR\.[A-Z_]+\b/.test(c.text));
  assert.equal(naked.length, 0,
    `这些 fail() 没带号（第 ${naked.map((c) => c.line).join("、")} 行）：\n`
    + naked.map((c) => `  L${c.line}: ${c.text.split("\n")[0].trim()}`).join("\n"));
});

test("⑦ 源码里不许出现写死的号字面量（只能引用 ERR 表）", () => {
  // ★ 判据是「形如 `域_事` 的全大写串」⇒ **不**按「在不在表里」放行：
  //   写了表里已有的号的字面量，同样是"绕过了 ERR 表"（表改名时它不会跟着改），
  //   这正是姊妹项目号名漂移的病根，必须一起抓。
  // ★ 与第①条的 DOMAINS 同步：两份白名单一旦漂移，本测试自己就成了它要防的那种病
  //   （某域被第①条放行、却被这里漏掉 ⇒ 该域的字面量悄悄绕过 ERR 表）。
  const KNOWN_DOMAINS = ["COMMON", "LETTER", "LIBRARY", "IDLE", "FONT", "IMPORT", "PROACTIVE", "MODEL", "REPLY"];
  // 这些是**别的**体系的大写常量，不是错误号（状态、来源、时段、模式、主动信原因）。
  const ALLOW = new Set([
    "PENDING", "LLM_PROCESSING", "REPLIED", "FAILED",
    "DISABLED", "BAD_WINDOW", "OUT_OF_HOURS", "HER_BUSY", "BUSY",
    "UNANSWERED_WAIT", "NO_EXCHANGE", "GAP", "DAY_LIMIT", "WEEK_LIMIT",
    "OFFLINE_GRACE", "WEAK_TRIGGER", "READY",
  ]);
  const literal = [...SERVER.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)]
    .map((m) => m[1])
    .filter((s) => !ALLOW.has(s) && KNOWN_DOMAINS.includes(s.split("_")[0]));
  assert.deepEqual([...new Set(literal)], [],
    "源码里出现了写死的大写串字面量（看着像错误号）：只能引用 ERR 表；"
    + "若它其实不是错误号，加进本测试的白名单并写清它是什么");
});

test("⑧ 号与文档双向覆盖：表里每个号文档都要写，文档里每个号表里都要有", () => {
  // ★ 排除 `>` 引用块：那里写的是**别人家**的号（姊妹项目改名漂移的教训），
  //   是说明文字不是本项目的号表；把它们算进来会让这条永远红，然后被人加白名单绕过。
  const body = DOC.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n");
  const docCodes = new Set([...body.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]));
  const missingInDoc = codes.filter((c) => !docCodes.has(c));
  const missingInTable = [...docCodes].filter((c) => !codes.includes(c));
  assert.deepEqual(missingInDoc, [],
    `这些号没写进「错误号一览.md」（用户查不到就失去了"显式报错"的意义）：${missingInDoc.join("、")}`);
  assert.deepEqual(missingInTable, [],
    `「错误号一览.md」里出现了表里没有的号（八成是改了名没同步）：${missingInTable.join("、")}`);
});
