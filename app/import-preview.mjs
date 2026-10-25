// 信件导入 · 只读预览与分类（UserData 导入的第一步）
//
// 为什么先做这一段：原版 2026-10-16《UserData 一键导入机制说明》§5 的建议是
// 「从预览 + 分类 + 三个计数开始，把写库留到契约确认之后」。理由不是保守，是**风险不对称**：
// 覆盖式导入没有撤销键，而预览/分类/计数这前三步**一行用户数据都不写** ——
// 契约谈不拢也留不下痕迹。
//
// ⇒ 本文件刻意**不碰数据库、不发网络请求、不写文件**。它只做纯函数：
//   给一批「已有身份」和一批「待导入信件」，回三个桶 + 三个数。
//   HTTP 层、sqlite 层、落库前备份那一步，**等契约（U1–U5）确认后再接**。
//
// ★ 核心只有 letterImportPlan() 十来行，但里面有一条**判据顺序绝对不能反**：
//   「文件内重复」必须先于「库里重复」判断。理由（连注释从 原版 letterImportPlan()
//   一并抄来，连措辞都不动）：它描述的是文件本身的问题，与库里有没有无关，
//   所以第二次导入同一份文件时仍然报「冲突 1」，不会漂移成「跳过 3」。
//   ⇒ 这条顺序会**直接改变给用户看的数字**，tests/import-preview.test.js 与
//     tests/mutation-check.mjs 各钉一道。

import { createHash } from "node:crypto";

/**
 * 预览分类：把待导入信件分成 added / skipped / conflicts 三个桶。
 *
 * @param {Iterable<string>} existingIds  库里已存在的信件 id（我们这一步**只用到 id**，不读表）
 * @param {Array|{letters: Array}} lettersOrParsed  待导入信件数组，或形如 { letters: [...] } 的解析结果
 * @param {Iterable<string>} [existingHashes]  库里已存在的 `content_md5`（可选）
 * @returns {{added: Array, skipped: string[], conflicts: string[], counts: {added: number, skipped: number, conflicts: number}}}
 */
export function letterImportPlan(existingIds, lettersOrParsed, existingHashes = null) {
  const list = Array.isArray(lettersOrParsed) ? lettersOrParsed : (lettersOrParsed?.letters ?? []);
  const known = new Set(existingIds);
  // ★ 2026-10-17 补第三道判据：**内容指纹**。
  //   只认 id 有个真实的漏：同一对往来在两边各自生成过 id 时，id 对不上、内容却一模一样
  //   ⇒ 第二次导入会把同一封信又搬进来一份。原版用的是**双键**（`id:` 与 `hash:`，
  //   `server.js:2955-2960`），这里把 hash 那一半补上。
  //   ⚠️ 顺序放在 id 之后：id 命中说明「就是同一封」，比「内容恰好相同」更确定。
  const knownHashes = new Set(existingHashes ?? []);
  const seen = new Set();
  const added = [];
  const skipped = [];
  const conflicts = [];

  for (const letter of list) {
    const id = letter?.letterId;
    // 「文件内重复」先判：它描述的是文件本身的问题，与库里有没有无关，
    // 所以第二次导入同一份文件时仍然报「冲突 1」，不会漂移成「跳过 3」。
    // （原话：勿调整与本块内下面那个 if 的先后顺序）
    if (seen.has(id)) { conflicts.push(id); continue; }
    seen.add(id);
    if (known.has(id)) { skipped.push(id); continue; }
    const hash = letter?.contentMd5;
    if (typeof hash === "string" && hash !== "" && knownHashes.has(hash)) { skipped.push(id); continue; }
    added.push(letter);
  }

  return {
    added,
    skipped,
    conflicts,
    counts: { added: added.length, skipped: skipped.length, conflicts: conflicts.length },
  };
}

/**
 * 内容指纹：给一封信一个稳定的身份键。
 *
 * 为什么要：这是导入后「到底搬进来几封、有没有丢」唯一可复算的证据 ——
 * 落库后再算一遍比对，比任何日志都硬。原版同样用 md5（`content_md5`），
 * 两边口径一致，将来对账不用翻译。
 *
 * ★ 不是安全用途（不抗碰撞），只是内容指纹。
 */
export function contentFingerprint(text) {
  return createHash("md5").update(String(text ?? ""), "utf8").digest("hex");
}

// ================================================================ 契约已到：导入映射
//
// 2026-10-16 20:39 与原版核对的结果（§1 + 补遗 2 + 视频裁决）：
// `BC7C99DB4ACD1D81` —— U1/U2/U3/U4/U5 全部有答，且**两列 ALTER 已由用户拍板批准**。
// 下面这一段把那些口径写成纯函数，钉在测试里。**仍然一行用户数据都不写**：
// ALTER 与落库要等真接路由时再做，且必须遵守「备份 → ALTER → 回读校验 → 导入」的顺序。

/** 本程序 `letters.status` 的取值（我们没有 2 AUDITING，原版那边也没有任何写入点 ⇒ 不需要映射）。 */
export const STATUS = Object.freeze({ PENDING: 1, LLM_PROCESSING: 3, REPLIED: 4, FAILED: 5 });
/** 导入**只允许**落这两个值。1 会被队列捞起来替她补一封（= 伪造新信），3 是「正在跑」的瞬时态。 */
export const IMPORT_STATUSES = Object.freeze({ REPLIED: 4, UNREPLIED: 5 });

/**
 * U1 · 来源判定：`origin`。
 *
 * ★ 判据是「`content` 是不是空串」，**不是** 原版的 `source` 字段 ——
 *   因为 `.soul` 的 manifest 里**根本没有 `source` 字段**（只有
 *   `letterId / contentMd5 / date / time / incoming / reply / replyLabel`），
 *   只能从内容形态反推。这与他 `source='proactive'` 的定义逐字等价。
 *
 * ⇒ 标错的代价是「她主动写来的信」被当成用户来信、重复触发回信，所以这条不能写反。
 *
 * @returns {string|null} `'proactive'` = 她先写；`null` = 用户来信 + 她的回信（成对）
 */
export function resolveOrigin(item) {
  return incomingOf(item) === "" ? "proactive" : null;
}

/**
 * 来信正文的取值口径 —— **`.soul` 里它叫 `incoming`，不叫 `content`。**
 *
 * ★ 2026-10-17 实测 原版 `memoryExchange()`（`server.js:2364-2385`）产出的字段是
 *   `letterId / date / time / incoming / reply / replyLabel / contentMd5 / summary / replyVideoUrl`
 *   —— **没有 `content`、没有 `replyText`**。本文件原先全按 `content` 判，拿真实 `.soul`
 *   跑会把每一封都读成空串：整批信被判成 `proactive`、状态全落 5、md5 全 NULL。
 *   测试没抓到是因为 mock 也写的 `content` —— 这正是它能活下来的原因。
 * ⇒ 取值顺序：`incoming` 优先，`content` 兜底（兼容旧 mocks 与将来别的导出格式）。
 */
function incomingOf(item) {
  const v = item?.incoming ?? item?.content;
  return v === undefined || v === null ? "" : String(v);
}

/** 回信正文的取值口径：`reply` 是 原版 的真实字段名，`replyText` 兜底。 */
function replyOf(item) {
  const v = item?.reply ?? item?.replyText;
  return v === undefined || v === null ? "" : String(v);
}

/**
 * U2 · 状态归一。
 *
 * 有 `reply`（她已回过）⇒ 4 REPLIED；没有 ⇒ 5 FAILED。
 * **导入永远不产生 1，也不产生 3。**（原话：3 是「正在跑」的瞬时态，历史数据里不该有。）
 *
 * ⚠️ 原版 `AUDITING = 2` 全仓只有声明、没有写入点 ⇒ 不会出现在 `.soul` 里，本程序没有 2 是对的。
 */
export function resolveImportStatus(item) {
  return replyOf(item) === "" ? IMPORT_STATUSES.UNREPLIED : IMPORT_STATUSES.REPLIED;
}

/**
 * 往来指纹：**这是 原版 `content_md5` 的真实口径**，不是「来信正文的 md5」。
 *
 * ★ 2026-10-17 实测：`server.js:653-657` 的 `exchangeContentMd5(exchange)` 原文是
 *   ```js
 *   createHash("md5").update(`${exchange.incoming.trim()}\n---\n${exchange.reply.trim()}`, "utf8")
 *   ```
 *   —— 来信与回信**一起**算，中间夹一个 `\n---\n`。
 *
 * ⇒ 本程序原先只算 `md5(content)`，与 `.soul` 里自带的 `contentMd5` **永远对不上**。
 *   那样「导入后重算一遍比对」会整批假红，反过来会让人以为是数据坏了。
 *   对账的两个数必须是同一把尺子 —— 所以这里照抄他的式子，不自己发明。
 */
export function exchangeFingerprint(incoming, reply) {
  return contentFingerprint(`${String(incoming ?? "").trim()}\n---\n${String(reply ?? "").trim()}`);
}

/**
 * U3 · `content_md5`：落库后的对账依据。
 *
 * ★ 取值优先级：**`.soul` 自带的 `contentMd5` 优先**（解析阶段已复算比对过，它就是权威值）
 *   → 没有才现算，且必须按 `exchangeFingerprint()` 那把尺子（来信+回信一起算）。
 *
 * ★★ 2026-10-17 更正（原先这条写错了，留痕以免有人再改回去）：
 *   旧注释说「她先写的信（正文为空）留 `NULL`，因为 `md5("")` 是恒等值、会把它们撞成一封」。
 *   那条理由建立在**只算来信正文**的错误算式上；换成 原版 的真式子以后它就不成立了：
 *   `archiveReply()`（`server.js:3406-3419`）对主动信照算不误 —— 那时 incoming 是空串、
 *   reply 是她的正文 ⇒ `md5("\n---\n" + 正文)`，每封各不相同，不会撞。
 *   而且**主动信恰恰最需要这个键**：`memory_order` 那套重建回填全靠 `content_md5` 认人。
 *
 * ⇒ 现在只有一种情况留 `NULL`：**来信与回信都是空的** —— 那时真的没有任何可校验的内容。
 */
export function resolveContentMd5(item) {
  // ★ 首选：`.soul` 里自带的那把钥匙。解析阶段已经复算比对过它（`parseSoulArchive` ⑨），
  //   所以它就是权威值 —— 落库原样保留，将来对账才逐位相等。
  const declared = String(item?.contentMd5 ?? "");
  if (/^[0-9a-f]{32}$/u.test(declared)) return declared;
  // 次选：自己按 原版 的同一把尺子现算（见 exchangeFingerprint 的注释）。
  const incoming = incomingOf(item);
  const reply = replyOf(item);
  if (incoming === "" && reply === "") return null;
  return exchangeFingerprint(incoming, reply);
}

/**
 * U3 · 这封信的**发生时间**（秒级时间戳）。
 *
 * 原版唯一的算式是 `exchangeTimestamp()`（`server.js:357-360`）：
 * ```js
 * if (!exchange.date) return fallback;
 * return Math.floor(new Date(`${exchange.date}T${exchange.time}:00`).getTime() / 1000);
 * ```
 * ⇒ `.soul` 里**没有**时间戳字段，只有 `date`（`"YYYY-MM-DD"`）与 `time`（`"HH:MM"`）
 *   两个字符串，且它们是**本地时间**（`new Date()` 不带 `Z` ⇒ 按本机时区解析）。
 *   本程序 `created_at` 也是本地机器上 `Date.now()` 折出来的秒 ⇒ 两边口径天然一致。
 *
 * ⚠️ 这是**来信时间**，不是归档时间（原版 `archiveReply()` 明写
 *   `letter_date = localDate(row.created_at)`）。别拿它当 `archived_at`。
 *
 * @param {object} item
 * @param {number|null} fallback 拿不到时间时回什么（默认 null —— 不编一个时间）
 */
export function exchangeCreatedAt(item, fallback = null) {
  const date = String(item?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return fallback;
  const rawTime = String(item?.time ?? "");
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(rawTime) ? rawTime : "12:00";
  const ms = new Date(`${date}T${time}:00`).getTime();
  if (!Number.isFinite(ms)) return fallback;
  return Math.floor(ms / 1000);
}

/**
 * U3 · `archived_at`：这个只有本程序的列，语义 = 「这条记录走完了流程」。
 *
 * ★ 2026-10-17 更正（旧注释写错了，留痕）：原写「原版口径：有回信取 `replied_at`，
 *   没回信取 `created_at`」—— **源码不是这样**。原版在导入时
 *   `insert.run(…, timestamp, timestamp, timestamp, nowSeconds(), …)`（`server.js:2989`）
 *   即 `created_at = available_at = replied_at = 信件时间`，而 `archived_at = nowSeconds()`
 *   ＝**导入这一刻**；`archiveReply()`（`:3399-3423`）里同样是 `nowSeconds()`（归档那一刻）。
 *   ⇒ 统一语义是「进入已归档状态的时间」，与信里写的时间无关。
 *
 * ⚠️ 拿不到就返回 `null`，绝不编一个时间。原版明确警告过：写 `NULL` 之后又拿它做
 * 过滤，会重现原版程序「只导 `archived_at IS NULL` ⇒ 丢掉所有已回信的信」那个坑。
 * ⇒ 所以调用方必须统计 `null` 的条数并报告出来，不能静默当 0。
 *
 * ⚠️ `.soul` 里**根本没有** `repliedAt` / `createdAt` 这两个键（原版回执逐字：「没有，
 *   一个都没有」）⇒ 走 `.soul` 这条路时这里**永远**回 `null`，落库方要自己填
 *   `nowSeconds()`（与 原版 一致），别指望这个函数能算出来。
 */
export function resolveArchivedAt(item) {
  const replied = item?.repliedAt ?? item?.replied_at;
  if (replied !== undefined && replied !== null) return Number(replied);
  const created = item?.createdAt ?? item?.created_at;
  if (created !== undefined && created !== null) return Number(created);
  return null;
}

/**
 * 把一封 `.soul` 里的往来映射成本程序 `letters` 的一行（**只算，不写**）。
 * @returns {{letterId:string, content:string, replyText:string, origin:string|null,
 *            status:number, contentMd5:string|null, createdAt:number|null, archivedAt:number|null}}
 */
export function mapImportedLetter(item) {
  return {
    letterId: String(item?.letterId ?? ""),
    content: incomingOf(item),
    replyText: replyOf(item),
    origin: resolveOrigin(item),
    status: resolveImportStatus(item),
    contentMd5: resolveContentMd5(item),
    createdAt: exchangeCreatedAt(item),
    archivedAt: resolveArchivedAt(item),
  };
}

/**
 * 视频裁决 · `N` 的口径 —— **⚠️ 2026-10-16 更正：报告里的 N 不要用这个。**
 *
 * 这是**源库** `letters.reply_video IS NOT NULL` 的行数。原版回执 §3 实测给出结论：
 * `.soul` 的 `videos.length` **必然 ≤** 这个数 —— 因为导出侧只对「`memory_order` 非空
 * （已归档）**且**能在 `exchanges` 里匹配上」的行收视频 ⇒ 有视频但未归档的信**不进 `.soul`**。
 *
 * ⇒ 用户看到的「未搬运 N 个」必须是**.soul 里真实搬了多少**，用这里的数会**偏大**。
 *   要报数请用 `countSoulVideos()`。这个函数保留下来只用于「读源库做体检」这类场景。
 *
 * ★ 另：路由无关 —— 原版 `server.js:2774` 的 `.soul` 导入路径也会写 `reply_video`，
 *   所以不能把它描述成「用户手动上传的视频」，那只是其中一条来源。
 */
export function countReplyVideos(rows) {
  let n = 0;
  for (const row of rows ?? []) {
    if (row?.reply_video !== null && row?.reply_video !== undefined) n += 1;
  }
  return n;
}

/**
 * 视频裁决 · **报告里那个 N 的正式口径**：`.soul` 里实际装了几段视频。
 *
 * @param {{videos?: Array}|null} parsed `parseSoulArchive()` 的结果
 * @returns {number|null} 数不出来返回 **null**（不是 0 —— 0 是「确实一个都没有」，
 *                        null 是「不知道」，两者在报告里必须分开写）
 */
export function countSoulVideos(parsed) {
  const v = parsed?.videos;
  if (!Array.isArray(v)) return null;
  return v.length;
}

/**
 * 视频裁决 · 报告里那一句话。
 * 原话要求：「数不出来就写『未统计』，但不要写 0 装作没有」——
 * ⇒ 所以 `n = 0` 也要老老实实写「未搬运 0 个」，只有**真的数不出来**才说未统计。
 */
export function videoSkipNote(n) {
  if (!Number.isInteger(n) || n < 0) return "本次导入未搬运回信视频：未统计";
  return `本次导入未搬运 ${n} 个回信视频。`;
}
