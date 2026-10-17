/**
 * 变量登记护栏（DSH 补遗 3 点名要的那一道）。
 *
 * 要防的是**静默降级**，而且它有两种对称的形态：
 *   - 我们这边可能的形态：模板里写了 `{{drift}}`，但渲染器没登记 ⇒ 一段字面量 `{{drift}}`
 *     原样进了 prompt。`03-中段生成.md` 那 30 行约束全都还在，**只有近况层悄悄失效了**。
 *   - DSH 那边已经发生的形态（`00-栏目.md`）：规则写了，但没有任何脚本把它喂给模型。
 *
 * ⇒ 两者都不报错。所以必须有一条**主动去扫**的断言：把 `app/harness/` 下每个模板里
 *    出现的 `{{变量}}` 全抽出来，逐个在我的注册表里查，查不到就红。
 *
 * ★ 只扫 `.md`（模板）。`行为参数.json` / `harness-manifest.json` 里也含有 `{{...}}` 字样的
 *   字段描述，但它们是**数据**，不参与渲染 —— 把它们算进来会得到一堆假红。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { KNOWN, OPTIONAL } from "../app/harness-render.mjs";

const HARNESS = join(import.meta.dirname, "..", "app", "harness");
const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;

/** 抽出某个文件里出现的全部变量名（去重、排序）。 */
async function varsIn(file) {
  const text = await readFile(join(HARNESS, file), "utf8");
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]))].sort();
}

const templates = (await readdir(HARNESS)).filter((f) => f.endsWith(".md")).sort();

test("① 模板里出现的每一个变量，都必须在渲染器的登记表里", async () => {
  const unregistered = new Map();
  const seen = new Set();

  for (const file of templates) {
    for (const v of await varsIn(file)) {
      seen.add(v);
      if (!KNOWN.has(v)) {
        if (!unregistered.has(v)) unregistered.set(v, new Set());
        unregistered.get(v).add(file);
      }
    }
  }

  const detail = [...unregistered].map(([v, files]) => `${v}（出现在 ${[...files].join("、")}）`);
  assert.deepEqual(
    detail,
    [],
    `模板里有 ${detail.length} 个变量没在 harness-render.mjs 的 KNOWN 里登记 ⇒ ` +
      `渲染时它们会原样变成字面量 {{x}} 进 prompt，而**不报错**：${detail.join("；")}`,
  );

  // 反向的自证：如果扫出来 0 个变量，那要么是模板目录空了、要么正则坏了 —— 都是假绿。
  assert.ok(seen.size >= 10, `只扫出 ${seen.size} 个变量 ⇒ 扫描逻辑或模板目录不对，这条断言失去意义`);
});

test("② 可选变量表里的每一个，也都必须是已登记变量", () => {
  const stray = [...OPTIONAL].filter((v) => !KNOWN.has(v));
  assert.deepEqual(stray, [], `OPTIONAL 里有 KNOWN 之外的变量：${stray.join("、")}`);
});

test("③ `{{drift}}` 必须在登记表里，且是可选的（近况层未启用时赋空串，不是省略）", async () => {
  // DSH 补遗 3 §二：第 0 档 / 未启用时赋**空串**，不是省略该键 ⇒ 它必须在 OPTIONAL 里，
  // 否则「近况层没开」会变成「必填变量缺值 ⇒ 直接抛」，把一封本来能正常生成的信挡掉。
  assert.ok(KNOWN.has("drift"), "drift 不在 KNOWN 里");
  assert.ok(OPTIONAL.has("drift"), "drift 必须是可选变量：近况层第 0 档要能赋空串而不是抛错");
  const inMidStep = await varsIn("03-中段生成.md");
  assert.ok(inMidStep.includes("drift"), "03-中段生成.md 里应当有 {{drift}}（近况层的注入点）");
});

test("④ `00-栏目.md` 的接入状态：已接入（server.mjs generateReply → composeReplySystem）", async () => {
  // ★ 2026-10-16 已接入：`app\server.mjs` generateReply 里 `harnessFile("00-栏目.md")`
  //   传入 `composeReplySystem({ rules, persona, fields })`，后者把 `# 栏目` 整段
  //   拼进回信 system prompt（`app\harness-render.mjs`）。DSH [#11] 🟡-4 指出
  //   本条旧注释谎报「尚未接入」⇒ 现按事实订正。
  // ⇒ 真正的护栏（「必须原文整段进 prompt」的 assert）在 `harness-render.test.js`
  //   的 00-栏目 那条 + 空段抛错三组，这里只钉文件本身的形状。
  const files = await readdir(HARNESS);
  assert.ok(files.includes("00-栏目.md"), "00-栏目.md 应当已推过来");

  const text = await readFile(join(HARNESS, "00-栏目.md"), "utf8");
  // ★ 它是「栏目名 + 全角空格 + 约束」的 15 行，并**没有**数字编号。
  //   （我第一版按 `/^\s*\d+[.、]/` 数编号 ⇒ 数出 0 条 ⇒ 假红。判据必须按文件实际形态定，
  //   不是按"我以为它长什么样"定。）
  const lines = text.split(/\r?\n/u).filter((l) => l.trim());
  assert.equal(lines.length, 15, `00-栏目.md 应当是 15 条栏目约束，实际 ${lines.length} 条 ⇒ 文件被换过或没推全`);
  const notShaped = lines.filter((l) => !/^[^　\s]+　\S/u.test(l));
  assert.deepEqual(notShaped, [], `有 ${notShaped.length} 行不是「栏目名　约束」的形状 ⇒ 格式变了`);

  // ★★ 2026-10-17 二修：**上一版这条断言是没有牙齿的**，实跑证明如下 ——
  //   它把 00-栏目.md 正文塞进 **rules** 参数，再断言「输出包含它」；
  //   可 `rules` 本来就是被 `# 写法` 原样拼进去的 ⇒ 实际测的是「rules 实参被包含」，
  //   而**不是**「栏目正文进了 prompt」。而生产链路（app/server.mjs:528-529）恰恰是把
  //   00-栏目.md 走 **fields** 参数传进去的。
  //   ⇒ 实测：把 composeReplySystem 里的 `, "", "# 栏目", fields` 删掉，这条断言**仍然绿**。
  //      即「00-栏目.md 从 prompt 里整段消失」这种真实故障，它一条都抓不住。
  //   修法：① 按生产链路的**真实参数名**传（栏目正文走 fields）；
  //        ② 三段**分别**断言（原来只断言一段，另两段丢了不红）。
  const { composeReplySystem } = await import("../app/harness-render.mjs");
  const system = composeReplySystem({ rules: "R", persona: "P", fields: text });
  assert.ok(system.includes("R"), "写法段丢了 ⇒ 回信 prompt 里没有写法规范（三段各断言一次，别只测一段）");
  assert.ok(system.includes("P"), "人设段丢了 ⇒ 回信 prompt 里没有人设");
  assert.ok(
    system.includes(text),
    "00-栏目.md 的原文必须**整段**进回信 system prompt（走 fields 参数，与 server.mjs:528-529 的调用一致）",
  );
});
