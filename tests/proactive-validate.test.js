/**
 * 主动信设置「落盘前整批校验」的护栏（两端同步 §9.2）。
 *
 * 要防的不是「校验不严」，是**顺序**：先落盘、后校验 ⇒ 其余设置非法时开关已经被改掉，
 * 界面表现为「保存失败，但那个勾选框变了」。我侧原来的形态更松 —— 压根没有校验，
 * 逐键 setSetting 直接写。
 *
 * ⇒ 本文件的判据是纯函数 `validateProactivePatch()`；「落盘那一步必须在这之后」
 *   由 `app/server.mjs` 的 POST /api/proactive 保证（先校验、不 ok 直接 400 返回）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateProactivePatch } from "../app/core.mjs";

/** 界面 `app/public/app.js` 的 saveProactive 实际提交的那一份（真实形态）。 */
const REAL_PATCH = Object.freeze({
  enabled: true,
  windowStart: "09:00",
  windowEnd: "21:30",
  minGapHours: 20,
  maxPerDay: 1,
  maxPerWeek: 4,
  keepCurrentShape: false,
});

test("① 界面真实提交的那一整份必须通过 —— 别把合法保存误挡了", () => {
  const r = validateProactivePatch(REAL_PATCH);
  assert.deepEqual(r.errors, [], `界面正常保存被挡了：${r.errors.join("；")}`);
  assert.equal(r.ok, true);
});

test("② 时间窗非法 ⇒ 不通过", () => {
  for (const bad of ["99:99", "9", "24:00", "ab:cd", "", "09-00"]) {
    const r = validateProactivePatch({ windowStart: bad });
    assert.equal(r.ok, false, `windowStart=${JSON.stringify(bad)} 竟然通过了`);
  }
  // 边界内的真值要放行
  assert.equal(validateProactivePatch({ windowStart: "00:00", windowEnd: "23:59" }).ok, true);
});

test("③ 数值脏值 ⇒ 不通过（负数 / 非整数 / NaN / 字符串数字）", () => {
  for (const bad of [-5, 1.5, NaN, Infinity, "12abc"]) {
    const r = validateProactivePatch({ minGapHours: bad });
    assert.equal(r.ok, false, `minGapHours=${JSON.stringify(bad)} 竟然通过了`);
  }
});

test("④ 字符串冒充布尔 ⇒ 不通过", () => {
  // 关键：`"abc"` 在旧代码里会被 truthy 当成 true 写进去
  const r = validateProactivePatch({ enabled: "abc" });
  assert.equal(r.ok, false, `enabled="abc" 竟然通过了`);
  // 而 "1"/"0" 与真布尔要放行（界面与脚本都可能这么传）
  assert.equal(validateProactivePatch({ enabled: "1", keepCurrentShape: "0" }).ok, true);
  assert.equal(validateProactivePatch({ enabled: false, asked: true }).ok, true);
});

test("⑤ 不新增产品约束：`maxPerWeek = 0`（等于关掉主动来信）是用户合法意图，必须放行", () => {
  // 这条是防我自己「顺手加一条 min 1」—— 那是产品决策，不该藏在校验里。
  assert.equal(validateProactivePatch({ maxPerWeek: 0 }).ok, true);
  assert.equal(validateProactivePatch({ maxPerDay: 0 }).ok, true);
});

test("⑥ 整批报告：多个错误一次列全，不是遇错即返", () => {
  const r = validateProactivePatch({ windowStart: "99:99", minGapHours: -1, enabled: "abc" });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3, `只报了 ${r.errors.length} 条（应 3 条）：${r.errors.join("；")}`);
});

test("⑦ 未知键忽略（与落盘时 `if (!settingKey) continue` 的语义一致）", () => {
  assert.equal(validateProactivePatch({ ...REAL_PATCH, 完全不认识的键: "x" }).ok, true);
});

test("⑧ 空 / 缺参数不炸，且算通过（只校验「给了的」）", () => {
  assert.equal(validateProactivePatch({}).ok, true);
  assert.equal(validateProactivePatch(undefined).ok, true);
});

test("⑨ ★ 落盘顺序钉死：POST /api/proactive 里，校验必须出现在第一次 setSetting 之前", async () => {
  // 纯函数测不到「顺序」—— 而这正是 §9.2 那个缺陷的全部内容（先写后验）。
  // ⇒ 用一条源码级断言把它钉死：谁把顺序调回去，这里立刻红。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app/server.mjs", import.meta.url), "utf8");
  const start = src.indexOf('req.method === "POST" && path === "/api/proactive"');
  assert.ok(start > 0, "没找到 POST /api/proactive 的处理段");
  const seg = src.slice(start, start + 1500);

  const iCheck = seg.indexOf("validateProactivePatch");
  const iWrite = seg.indexOf("setSetting(");
  assert.ok(iCheck > 0, "处理段里没有调用 validateProactivePatch ⇒ 校验被摘掉了");
  assert.ok(iWrite > 0, "处理段里没有 setSetting ⇒ 段落取错了");
  assert.ok(
    iCheck < iWrite,
    `顺序反了：setSetting 出现在校验之前（校验 @${iCheck}、写入 @${iWrite}）⇒ ` +
      "非法值会先落盘，这正是 DSH 侧那个缺陷",
  );
});
