/**
 * 写信规范渲染器（两端同步 T4）。
 *
 * ★ 这四条是 DSH 指定的验收 —— 每条都必须是「会失败」的测试：
 *   1. 缺 `## System` ⇒ 抛错
 *   2. 用了未登记的变量 ⇒ 抛错
 *   3. `proactiveNote` 缺省 ⇒ 空串（不抛错）
 *   4. 必填变量缺值 ⇒ 抛错
 * 另加两条我们自己踩过的：
 *   5. 文件读不到 ⇒ 抛错（老实现是静默返回空串，最危险的一处）
 *   6. 真文件渲染后 system 里不许残留 `## System` 与未展开的 `{{}}`
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderStep, readHarnessFile, composeReplySystem } from "../app/harness-render.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HARNESS = join(import.meta.dirname, "..", "app", "harness");

async function withTemp(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), "harness-render-"));
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, "utf8");
    return await fn(dir);
  } finally {
    await cleanupDir(dir);
  }
}

test("① 缺 ## System ⇒ 抛错", async () => {
  await withTemp({ "a.md": "# 只有标题\n\n## User\n{{persona}}\n" }, async (dir) => {
    await assert.rejects(() => renderStep(dir, "a.md", { persona: "林离" }), /## System/u);
  });
});

test("② 未登记的变量 ⇒ 抛错", async () => {
  await withTemp({ "a.md": "## System\n你是林离。\n## User\n{{triger}}\n" }, async (dir) => {
    await assert.rejects(() => renderStep(dir, "a.md", {}), /未登记的变量/u);
  });
});

test("③ proactiveNote 缺省 ⇒ 空串，不抛错", async () => {
  await withTemp({ "a.md": "## System\n你是林离。\n## User\n开头{{proactiveNote}}结尾\n" }, async (dir) => {
    const out = await renderStep(dir, "a.md", {});
    assert.equal(out.user, "开头结尾");
  });
});

test("④ 必填变量缺值 ⇒ 抛错", async () => {
  await withTemp({ "a.md": "## System\n你是林离。\n## User\n{{persona}}\n" }, async (dir) => {
    await assert.rejects(() => renderStep(dir, "a.md", {}), /必填变量 \{\{persona\}\}/u);
  });
});

test("⑤ 文件读不到 ⇒ 抛错（不再静默返回空串）", async () => {
  await withTemp({}, async (dir) => {
    await assert.rejects(() => renderStep(dir, "不存在.md", {}), /规范文件读不到/u);
    await assert.rejects(() => readHarnessFile(dir, "不存在.md"), /规范文件读不到/u);
  });
});

test("⑥ 真文件渲染：system 不含字面 ## System，两边都不剩 {{}}", async () => {
  const out = await renderStep(HARNESS, "主动来信.md", {
    trigger: "一个平常的晚上",
    persona: "（人设）",
    rules: "（写法）",
    memory: "",
    anchors: "（语料）",
  });
  assert.ok(out.system.length > 0, "system 不该是空的");
  assert.ok(!out.system.includes("## System"), "system 里不该残留字面的 ## System");
  assert.ok(!out.user.includes("## User"), "user 里不该残留字面的 ## User");
  assert.ok(!/\{\{[a-zA-Z0-9_]+\}\}/u.test(out.system), "system 里不该有未展开的变量");
  assert.ok(!/\{\{[a-zA-Z0-9_]+\}\}/u.test(out.user), "user 里不该有未展开的变量");
  assert.ok(out.user.includes("一个平常的晚上"), "{{trigger}} 没被展开");
});

// ---------------------------------------------------------------- 栏目那 15 条必须真的进 prompt

/**
 * ★ DSH 2026-10-16 补遗 2 `95613D39A580867F` B.1 的原话：
 *   「（建议）把它的 15 条并入你自己的 prompt 组装，并**加一条测试证明它真的进了**
 *     （否则你就复制了我们这个『规则写了但没喂给模型』的结构性缺口）」。
 *
 * ⇒ 这一条就是那个「证明」。它读的是**盘上真实的** `00-栏目.md`，不是测试自己造的替身 ——
 *   换成替身就退化成「证明这个函数会拼字符串」，那正是他说的假证明。
 */
test("回信 prompt 必须真的把 00-栏目.md 那 15 条带进去（原文整段，不是标题）", async () => {
  const fields = await readHarnessFile(HARNESS, "00-栏目.md");
  const sys = composeReplySystem({ rules: "写法正文", persona: "人设正文", fields });

  assert.ok(sys.includes(fields), "00-栏目.md 必须**原文整段**进 prompt —— 只进标题或被截断都算没进");
  assert.ok(sys.includes("# 栏目"), "栏目这一节必须有个标题，不能和写法/人设糊在一起");

  // 15 条一条都不能少（少了任何一条都是静默漏约束）
  for (const key of ["挑选", "口气", "关照", "温度", "情感", "称呼", "亲密",
    "事实", "节奏", "形状", "声音", "泄漏", "载体", "茶味", "逻辑"]) {
    assert.ok(sys.includes(key), `栏目「${key}」没进 prompt —— 15 条少了这一条`);
  }

  // ★ 禁补史口径的出处（00-栏目.md:8）必须真的在 —— 这是 P4 定案在规范里的落点
  assert.ok(sys.includes("不认领强加经历"), "禁补史那条不在 prompt 里");

  // 引导句那五条不能因为搬了家就丢
  for (const lead of ["你就是林离", "跨封账本", "未请求，不主动给", "事实伪造为「有」", "「未决」"]) {
    assert.ok(sys.includes(lead), `引导句里「${lead}」丢了`);
  }
});

test("三段规范任一段为空 ⇒ 抛，绝不发一封没规矩的信", () => {
  const full = { rules: "写法", persona: "人设", fields: "栏目" };
  for (const key of ["rules", "persona", "fields"]) {
    assert.throws(
      () => composeReplySystem({ ...full, [key]: "" }),
      /规范为空/u,
      `${key} 空了还让发信 ⇒ 会拿到一封没规矩的信`,
    );
    assert.throws(() => composeReplySystem({ ...full, [key]: undefined }), /规范为空/u);
  }
  // ★ 这一条钉的是「别把 00-栏目.md 悄悄去掉」：不传 fields 直接抛，
  //   防止哪天有人嫌它长就删掉这一节 —— 那等于又回到"规则写了但没喂给模型"。
  assert.throws(() => composeReplySystem({ rules: "写法", persona: "人设" }), /规范为空/u);
});
