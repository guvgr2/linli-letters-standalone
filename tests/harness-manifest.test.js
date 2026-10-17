/**
 * 真源哈希清单校验（DSH [#2-C] 点名要的：「请照它自己实现一遍校验」）。
 *
 * 三件事：
 *   ① 我侧**存在**的文件，逐项复算 bytes + sha256，必须与清单一致（差一个字节就红）。
 *   ② **两端变量白名单必须一致**（清单 `variables` / `optionalVariables` ↔ 本侧
 *      `KNOWN` / `OPTIONAL`）—— 只允许多出 `drift`（S9 近况层，真源待建）。
 *      这是防漂移的关键：任一端私加变量 ⇒ 这里先红，不会等到「未登记变量」才炸。
 *   ③ 真源文件我侧**一个都不能缺**（2026-10-17 起是硬门禁，原来是只打印不判红）——
 *      免得把「没推过来」当成「已经一致」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { KNOWN, OPTIONAL } from "../app/harness-render.mjs";

const HARNESS = join(import.meta.dirname, "..", "app", "harness");
const MANIFEST = join(HARNESS, "harness-manifest.json");

/**
 * 允许本侧比真源多出来的变量。
 * 2026-10-16 06:38 真源清单已把 `drift`（S9 近况层）登记进来 ⇒ 现在两边应当**完全相等**。
 * ⇒ 这个集合是空的，而且**应当保持为空**：任一端加变量都必须同批改另一端，否则这里先红。
 */
const ALLOWED_EXTRA = new Set();

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));

/**
 * 真源已改、我侧**故意**还没跟的文件（带理由与日期）。
 * 这些不判红，但会在 ③ 里被大声列出来 —— 目的就是别让它变成永久的静默差异：
 * 同步完一个就从这个表里删一个，删完 ① 就自动把它纳入硬校验。
 */
// 2026-10-16 08:0x：`林离人设.md` 已同步（7550 B / f43562f9…，哈希校验通过）⇒ 从表里撤下、
// 纳入 ① 的硬校验。**这个表现在应当保持为空** —— 再往里加东西就必须写清理由与最晚同步时间。
const PENDING_SYNC = new Map();

/**
 * ★ B6 的本侧配套：真源 `林离人设.md` 在 harness 的**上一级**（`relPath: "../林离人设.md"`），
 *   而我侧它就在 `app/harness/` 里面 ⇒ 直接吃清单的 relPath 会解析到不存在的 `app/林离人设.md`，
 *   于是它永远待在「尚缺」里、**永远不会被硬校验**。
 *   DSH 已同意在清单里加 `pathOverrides`（他下一批做）；在那之前，本侧自己在解析时覆盖。
 */
const LOCAL_PATH_OVERRIDES = new Map([["林离人设.md", "林离人设.md"]]);
const resolveLocal = (name, entry) => join(HARNESS, LOCAL_PATH_OVERRIDES.get(name) ?? entry.relPath ?? name);

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

test("① 清单里我侧有的文件：bytes 与 sha256 逐项一致", async () => {
  const checked = [];
  for (const [name, entry] of Object.entries(manifest.files)) {
    const p = resolveLocal(name, entry);
    if (!(await exists(p)) || PENDING_SYNC.has(name)) continue;   // 没推过来 / 待同步 ⇒ 归 ③
    const buf = await readFile(p);
    const sha = createHash("sha256").update(buf).digest("hex");
    assert.equal(buf.length, entry.bytes, `${name} 字节数不符（清单 ${entry.bytes}，实际 ${buf.length}）`);
    assert.equal(sha, entry.sha256, `${name} 的 sha256 不符`);
    checked.push(name);
  }
  // ---------------------------------------------------------------- W7 加固
  // 以前的兜底是 `checked.length >= 3` —— 清单被误删到只剩 3 件它照样绿，
  // 而且抓不住「relPath 解析到了不存在的位置」这类静默失败（B6 那个洞就是这么来的）。
  //
  // ★ 独立审查 [审查-3] 🟡-W7 当初建议「断言 `requiredBy.sister` 的每一项」——
  //   我在 2026-10-16 核过：那时 `requiredBy` **16 项全是 null**，照字面实现会得到
  //   「期望集合 = 空集」的**恒绿断言**（比 >=3 更松），所以没采用，改用下面的相对判据。
  //   **2026-10-17 00:30 重出的清单已把它修好**（DSH `[#8]` §1：`requiredBy` 改为
  //   运行时现扫，不再手写常量），`sister` 现在是实打实的 7 项 ⇒
  //   **审查者要的那条断言从这一刻起才真正成立**，见下面的 ①b。
  //
  // ①a 相对判据（不依赖任何清单元数据）：**盘上真实存在的规范文件，必须一个不落都被校验过**。
  //   它同样能抓住审查者担心的场景（清单丢条目 ⇒ 那些文件没人校验 ⇒ 这里立刻红），
  //   而且顺带覆盖了「路径语义错了导致 join 到空」—— 那正是 B6 的成因。
  const onDisk = (await readdir(HARNESS)).filter((f) => /\.(md|json)$/u.test(f) && f !== "harness-manifest.json").sort();
  const unchecked = onDisk.filter((f) => !checked.includes(f));
  assert.deepEqual(
    unchecked,
    [],
    `盘上有 ${unchecked.length} 个规范文件没被真正校验：${unchecked.join("、")} ⇒ ` +
      "清单被删了条目、或路径语义又对不上了（这两种以前都是静默绿）",
  );

  // ①b 绝对判据（🟡-W7 的正解，等了一天才有依据）：真源点名「姊妹侧应当存在」的文件，
  //     必须**每一个都被上面的哈希校验真正走过**，而不只是「在盘上」。
  //     先守字段本身不退化回 null/空 —— 否则 ①b 会静默变成空集断言，重演昨天的恒绿。
  const sister = manifest.requiredBy?.sister;
  assert.ok(Array.isArray(sister) && sister.length > 0,
    "清单 requiredBy.sister 为空 ⇒ 真源扫描器又退化成手写/null 了（那 ①b 会变恒绿断言）");
  const sisterUnverified = sister.filter((f) => !checked.includes(f));
  assert.deepEqual(
    sisterUnverified,
    [],
    `真源点名我侧必须有的 ${sister.length} 个文件里，有 ${sisterUnverified.length} 个没被哈希校验：${sisterUnverified.join("、")}`,
  );
});

test("② 两端变量白名单一致（只允许多出 drift）", () => {
  const vars = new Set(manifest.variables);
  const opt = new Set(manifest.optionalVariables);

  const extraKnown = [...KNOWN].filter((k) => !vars.has(k));
  const missingKnown = [...vars].filter((k) => !KNOWN.has(k));
  const extraOptional = [...OPTIONAL].filter((k) => !opt.has(k));
  const missingOptional = [...opt].filter((k) => !OPTIONAL.has(k));

  assert.deepEqual(new Set(extraKnown), ALLOWED_EXTRA,
    `本侧 KNOWN 比真源多出 ${JSON.stringify(extraKnown)}（只允许 drift）`);
  assert.deepEqual(missingKnown, [],
    `真源有、本侧 KNOWN 没有的变量：${JSON.stringify(missingKnown)} —— 真源加了变量没通知我`);
  assert.deepEqual(new Set(extraOptional), ALLOWED_EXTRA,
    `本侧 OPTIONAL 比真源多出 ${JSON.stringify(extraOptional)}（只允许 drift）`);
  assert.deepEqual(missingOptional, [],
    `真源有、本侧 OPTIONAL 没有的变量：${JSON.stringify(missingOptional)}`);
});

test("③ 真源文件我侧必须一个不缺（硬门禁）", async () => {
  // ★ 2026-10-17 01:3x 由 console.log 升级为 assert —— DSH `[#8]` §3（D2）点名要求，
  //   且他给的前置条件此刻已成立：`requiredBy.source` 16 项与 `files` 双向差集为空、
  //   我侧「尚缺 0 个」、两端 16 份逐字节相同。
  //   之前只打印不判红，是因为他侧推送还没收口；现在再缺一个就是**真的缺**，不是"在路上"。
  //   ⚠️ 若将来真出现"故意不同步"的文件，走 `PENDING_SYNC` 登记（它会跳过 ① 但**不跳过这里**），
  //      不许再把它降回 console.log —— 那正是当初静默差异养出来的路子。
  const absent = [];
  for (const [name, entry] of Object.entries(manifest.files)) {
    const p = resolveLocal(name, entry);
    if (!(await exists(p))) absent.push(`${name}${entry.relPath ? ` (relPath=${entry.relPath})` : ""}`);
  }
  assert.deepEqual(
    absent,
    [],
    `真源共 ${Object.keys(manifest.files).length} 个文件，我侧尚缺 ${absent.length} 个：${absent.join("、")} ⇒ ` +
      "真源推了新文件但没推到我侧，或 relPath 语义又变了（B6 同型问题）",
  );
  // PENDING_SYNC 是"故意不跟"的登记表 —— 它现在必须为空；非空说明有人又开了口子。
  assert.deepEqual([...PENDING_SYNC.keys()], [],
    `PENDING_SYNC 里还有故意未同步的文件：${[...PENDING_SYNC.keys()].join("、")} ⇒ 同步完就该从表里删掉`);
});

test("④ 林离人设.md 的 relPath 两侧语义不同 —— 钉住这个差异，别让 join 静默 ENOENT", async () => {
  const entry = manifest.files["林离人设.md"];
  assert.ok(entry, "清单里应当有 林离人设.md");
  // 真源侧它在 harness 的**上一级**（relPath="../林离人设.md"）；
  // 我侧它就在 app/harness/ 里 ⇒ 同一份 relPath 在我侧会解析到 app/林离人设.md（不存在）。
  // ⇒ 校验时必须按本侧布局解析，不能直接吃清单的 relPath。这里把差异本身钉成一条断言。
  assert.equal(entry.relPath, "../林离人设.md", "真源侧 relPath 变了 ⇒ 本侧的解析分支要一起改");
  assert.ok(await exists(join(HARNESS, "林离人设.md")), "我侧 林离人设.md 就在 app/harness/ 里（与真源不同级）");
});
