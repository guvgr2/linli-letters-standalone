/**
 * 写信规范的统一渲染器（两端同步 · T4）。
 *
 * ★ 为什么要单独抽出来：以前 `harnessFile()` 读不到文件就**静默返回空串**
 *   （`server.mjs` 老实现 `try { readFile } catch { return "" }`）。
 *   规范文本丢了也一样发信 —— 你会拿到一封「没有人设也没有写法」的信，
 *   而不是一条错误。这是整条链上最危险的一处。
 *   ⇒ 现在：文件读不到就抛，变量缺值就抛，缺 `## System` 就抛。
 *
 * ★ 契约与真源侧（OliviaSoul `repo\source\harness\`）一致：
 *   切 `## System` / `## User` + 全量 `{{}}` 替换。
 *   `## System` 这两个字本身**不进**提示词（老实现会把它一起送进 system）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SYSTEM_MARK = "## System";
export const USER_MARK = "## User";

// ★ 两端各自维护这两份名单（`harness-manifest.json` 的 consumers.variables 明文要求
//   「任何变量增删必须同批通知两端」）。`tests/harness-manifest.test.js` 钉住：
//   除 `drift`（S9 近况层，真源待建）之外，这两份必须与真源清单**逐项相等** ——
//   任何一边私加变量都会当场红，不会静默漂移到「未登记变量」才炸。
export const KNOWN = new Set([
  "persona", "rules", "fields", "safe", "ctx", "evidence", "previousState",
  "draft", "check", "trigger", "memory", "anchors", "relationshipMemory",
  "facts", "navigation", "historyResults", "budget", "proactiveNote", "drift",
]);

/** 缺值 ⇒ 空串；其余变量缺值 ⇒ 抛错。 */
export const OPTIONAL = new Set([
  "proactiveNote", "drift", "evidence", "previousState", "relationshipMemory",
  "facts", "navigation", "historyResults", "budget", "draft", "check",
  "memory", "anchors",
]);

/** 读一份规范原文。读不到就抛 —— 绝不返回空串。 */
export async function readHarnessFile(dir, name) {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch (error) {
    throw new Error(`规范文件读不到：${name}（${join(dir, name)}）· ${error.message}`);
  }
}

/**
 * 回信链路的固定引导句（原来写在 `server.mjs` 里，随 `composeReplySystem` 一起搬过来）。
 *
 * ⚠️ 这五条**不是** `00-栏目.md` 的替代品 —— 它们只覆盖了亲密 / 事实 / 未决三个面，
 *   栏目那 15 条还管着挑选、口气、关照、温度、情感、称呼、节奏、形状、声音、
 *   泄漏、载体、茶味、逻辑。两边都要在，缺一边就是漏约束。
 */
export const REPLY_LEAD = [
  "你就是林离，「他」是来信人。只输出回信正文，不要标签、前缀、分析、说明或英文。",
  "预检里的关系、已承认情感、既有亲密和既有边界是跨封账本，不能反写、删除或擅自升级。",
  "本封亲密判定为「未请求，不主动给」时，不得主动写牵手、拥抱、亲吻或其他身体接触。",
  "事实伪造为「有」时，不得把被标出的内容认成自己做过、说过或共同经历过。",
  "「未决」里的设想、疑问和否定，不得写成已经发生的事。",
].join("\n");

/**
 * 回信链路的 system 组装（2026-10-16 · 补上 `# 栏目` 这一节）。
 *
 * ★ 为什么要从 `server.mjs` 搬出来变成纯函数：`00-栏目.md` 那 15 条栏目约束
 *   （挑选 / 口气 / 关照 / 温度 / 情感 / 称呼 / 亲密 / 事实 / 节奏 / 形状 / 声音 /
 *     泄漏 / 载体 / 茶味 / 逻辑）在我侧**一直没进 prompt** ——
 *   `{{fields}}` 只在六步链模板（`03-中段生成` / `04-尾端检查` / `05-反馈重写`）里被消费，
 *   而我侧回信是手工拼装的、不走那三个模板 ⇒ 文件躺在盘上，模型一个字都没见过。
 *
 *   DSH 2026-10-16 补遗 2 `95613D39A580867F` B.1 点名：这在**他侧也一样**
 *   （「全仓只有工程文档、打包清单、一个断言测试提到它」），并建议我
 *   「并入自己的 prompt 组装，**并加一条测试证明它真的进了**」——
 *   ⇒ 要有那条"证明它进了"的测试，组装就得是可单测的纯函数。这就是它搬过来的唯一理由。
 *
 * ⚠️ `00-栏目.md:8` 的「共同事实必须有往来依据；不认领强加经历」正是**禁补史**口径的
 *    出处，与我侧 P4 定案（强加经历：不认领、不延续、不引用为事实，但不否认不纠正不争辩）
 *    逐字对得上 —— 它是这 15 条里最不该缺的一条。
 *
 * @param {{rules:string, persona:string, fields:string}} parts  三段规范原文
 * @returns {string} 完整 system
 */
export function composeReplySystem({ rules, persona, fields } = {}) {
  // ★ 规范文本丢了照样发信，是整条链上最危险的一类错（你会拿到一封"没有人设也没有写法"
  //   的信，而不是一条错误）⇒ 任一段为空就抛，绝不静默留个空标题。
  for (const [label, text] of [["写法", rules], ["人设", persona], ["栏目", fields]]) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`${label} 规范为空 ⇒ 拒绝组装提示词（规范丢了必须炸，不能发一封没规矩的信）`);
    }
  }
  return [REPLY_LEAD, "", "# 写法", rules, "", "# 人设", persona, "", "# 栏目", fields].join("\n");
}

/**
 * 渲染一步：切 System/User 并展开 `{{}}`。
 * @returns {{ system: string, user: string }}
 */
export async function renderStep(dir, fileName, vars = {}) {
  const raw = await readHarnessFile(dir, fileName);
  // ★ 2026-10-16（DSH 指出的同类坑）：模板**正文里**若出现字面的 `## System` / `## User`
  //   （比如举例、说明文字），`indexOf` 会切到那一行去 ⇒ 切出来的是说明文字、还不报错。
  //   ⇒ 这两个标记必须各恰好出现一次，多一个就当场炸。
  for (const mark of [SYSTEM_MARK, USER_MARK]) {
    const n = raw.split(mark).length - 1;
    if (n !== 1) throw new Error(`${fileName} 里的 ${mark} 出现 ${n} 次（必须恰好 1 次）—— 正文里的字面 ${mark} 会让分段切错`);
  }
  const iSys = raw.indexOf(SYSTEM_MARK);
  const iUser = raw.indexOf(USER_MARK);
  if (iSys < 0 || iUser < 0 || iUser <= iSys) {
    throw new Error(`规范文件缺 ## System/## User：${fileName}`);
  }
  const sys = raw.slice(iSys + SYSTEM_MARK.length, iUser).trim();
  const user = raw.slice(iUser + USER_MARK.length).trim();
  // ★ 2026-10-16（DSH 指出的同类坑）：老正则不容忍空格 ⇒ 模板写 `{{ trigger }}` 时
  //   匹配不到、原样进 prompt、还不报错。现在两种形态都能替换；未登记的仍然当场炸。
  const expand = (text) => text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu, (_, key) => {
    if (!KNOWN.has(key)) throw new Error(`未登记的变量 {{${key}}}（${fileName}）`);
    const v = vars[key];
    if (v === undefined || v === null || v === "") {
      if (OPTIONAL.has(key)) return "";
      throw new Error(`必填变量 {{${key}}} 缺值（${fileName}）`);
    }
    return String(v);
  });
  return { system: expand(sys), user: expand(user) };
}
