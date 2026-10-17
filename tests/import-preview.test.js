/**
 * 信件导入预览分类（UserData 导入第一步，只读）。
 *
 * ★ 每一条都必须是「会失败」的测试 —— 尤其前三条，钉的是那条不能反的判据顺序：
 *   1. 文件内重复 ⇒ 记 conflicts；同一份文件第二次导，仍然报「冲突 1」而不是「跳过 3」
 *   2. 与库里重复 ⇒ 记 skipped
 *   3. 判据顺序：既有重复又已在库里时，首封判 skipped、副本判 conflicts，
 *      副本**不会**再变成第二笔 skipped —— mutation-check 里钉了同一处
 *   4. 全新信 ⇒ 进 added，原对象不被复制/改写
 *   5. 空输入 / 脏输入 ⇒ 不抛，回三个 0
 *   6. counts 与三个桶的长度必须一致（给 UI 看的数字不能自己算一套）
 */

import test from "node:test";
import assert from "node:assert/strict";

import {letterImportPlan, contentFingerprint, exchangeFingerprint, exchangeCreatedAt, resolveOrigin, resolveImportStatus, resolveContentMd5, resolveArchivedAt, mapImportedLetter, countReplyVideos, videoSkipNote, IMPORT_STATUSES, STATUS, countSoulVideos} from "../app/import-preview.mjs";

/**
 * 一封**用真实字段名**写的往来。
 *
 * ★ 2026-10-17 修正：夹具原先写的是 `{letterId, content}` —— 那是**臆想的字段名**，
 *   真实 `.soul` 里叫 `incoming` / `reply`（DSH `memoryExchange()`，`server.js:2364-2385`）。
 *   夹具与实现同时写错，所以 15 条测试全绿而真实导入会整批错。
 *   这一版夹具一律用真字段名；`content` 只在「兜底兼容」那条里刻意出现。
 */
const letter = (id, incoming = "", reply = "") => ({
  letterId: id,
  incoming,
  reply,
});

test("导入预览(1)-文件内重复记 conflicts，同一份文件重导仍是冲突1不漂移", () => {
  const file = [letter("a"), letter("a"), letter("b")];
  const first = letterImportPlan([], file);
  assert.deepEqual(first.conflicts, ["a"]);
  assert.deepEqual(first.skipped, []);
  assert.equal(first.added.length, 2);
  assert.deepEqual(first.counts, { added: 2, skipped: 0, conflicts: 1 });

  // 第二次导入同一份文件：结论不能漂 —— 三封全都已在库里，若把「文件内重复」
  // 挪到「库里重复」后面判，这三条会全落进 skipped（＝ DSH 原话里的「漂移成跳过 3」）。
  // 正确结论是「跳过 2 + 冲突 1」，那个「冲突 1」是文件自己的毛病，与库无关。
  const second = letterImportPlan(["a", "b"], file);
  assert.deepEqual(second.conflicts, ["a"]);
  assert.deepEqual(second.skipped, ["a", "b"]);
  assert.deepEqual(second.counts, { added: 0, skipped: 2, conflicts: 1 });
});

test("导入预览(2)-库里已有记 skipped，且不重复计数", () => {
  const r = letterImportPlan(["x", "y"], [letter("x"), letter("y"), letter("z")]);
  assert.deepEqual(r.skipped, ["x", "y"]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.added.map((l) => l.letterId), ["z"]);
  assert.deepEqual(r.counts, { added: 1, skipped: 2, conflicts: 0 });
});

test("导入预览(3)-判据顺序：副本进 conflicts，不再叠一笔 skipped", () => {
  // a 既在文件里出现两次、也在库里：
  //   首封 ⇒ 「文件内未见」→ 落进 seen → 再被「库里已有」判进 skipped
  //   副本 ⇒ 已被 seen 拦下 ⇒ conflicts
  // ⇒ 关键在于 seen.add() 发生在「判 skipped」**之前**，所以副本轮不到再判一次库。
  const r = letterImportPlan(["a"], [letter("a"), letter("a")]);
  assert.deepEqual(r.skipped, ["a"]);
  assert.deepEqual(r.conflicts, ["a"]);
  assert.equal(r.skipped.length, 1, "副本不能变成第二笔 skipped");
  assert.deepEqual(r.counts, { added: 0, skipped: 1, conflicts: 1 });
});

test("导入预览(4)-全新信进 added 且原对象逐字保留", () => {
  const original = letter("n1", "正文在此");
  const r = letterImportPlan([], [original]);
  assert.deepEqual(r.added, [original]);
  assert.equal(r.added[0], original, "原样返回同一个对象，不要在 classifier 里复制或改写");
  assert.deepEqual(r.counts, { added: 1, skipped: 0, conflicts: 0 });
});

test("导入预览(5)-空输入与脏输入不抛错，回三个0", () => {
  for (const empty of [[], {}, { letters: [] }, undefined, null]) {
    const r = letterImportPlan([], empty);
    assert.deepEqual(r.counts, { added: 0, skipped: 0, conflicts: 0 });
  }
  // 缺 letterId 的信：不能把它当成 undefined->undefined 的重复而崩掉，
  // 两封都缺 id 时按「同一把空钥匙」判冲突，而不是悄悄各插入一封。
  const blank = letterImportPlan([], [{}, {}]);
  assert.equal(blank.counts.conflicts, 1);
});

test("导入预览(6)-counts 必须与三个桶的长度逐项一致", () => {
  const r = letterImportPlan(["b"], [letter("a"), letter("b"), letter("b"), letter("c")]);
  assert.equal(r.counts.added, r.added.length);
  assert.equal(r.counts.skipped, r.skipped.length);
  assert.equal(r.counts.conflicts, r.conflicts.length);
  // 而且三个数加起来必须等于输入条数 —— 一封信只能落一个桶，不许重复计也不许丢。
  assert.equal(r.counts.added + r.counts.skipped + r.counts.conflicts, 4);
});

test("内容指纹(7)-稳定、可复算、且与 md5 标准值对齐", () => {
  assert.equal(contentFingerprint("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(contentFingerprint(""), "d41d8cd98f00b204e9800998ecf8427e");
  // ★ 必须有一条**超过 10 个字符**的标准值：指纹若被悄悄截断成前 10 字符，
  //   短用例照样能过（→ 变异存活）。这条把「到底算了几字符」钉死。
  assert.equal(
    contentFingerprint("林离给的第一封信，导入到这里之后必须逐字一样，一个标点都不许少"),
    "301908d2bcd00f31c7ff9178ab354f77",
  );
  // 同一内容两次调用必须同结果（这是「导入后再算一遍比对」的前提）
  assert.equal(contentFingerprint("林离"), contentFingerprint("林离"));
  // 差一个字必须变
  assert.notEqual(contentFingerprint("林离"), contentFingerprint("林离 "));
  // 空值兜底：undefined / null 按空串算，不抛
  assert.equal(contentFingerprint(undefined), contentFingerprint(""));
});

// ---------------------------------------------------------------- 契约已到后的映射（U1/U2/U3 + 视频）

test("U1(8)-origin 按来信正文是否空串判，不看 source 字段", () => {
  // .soul 的 manifest 里没有 source 字段，只能从内容形态反推
  assert.equal(resolveOrigin({ incoming: "今天下班路上看到一只猫", reply: "回信在此" }), null);
  assert.equal(resolveOrigin({ incoming: "", reply: "她先写的" }), "proactive");
  // ★ 反例钉死：把判据写成「正文非空 ⇒ proactive」会整批标反，
  //   代价是「她主动写来的信」被当成用户来信、重复触发回信。
  assert.equal(resolveOrigin({ incoming: "   ", reply: "" }), null, "纯空格不算空串 —— 不能 trim 后判");
  // 缺字段按空串处理 ⇒ 她先写（与「正文空、正文在 reply」这条特征一致）
  assert.equal(resolveOrigin({}), "proactive");
  // 兼容旧字段名 `content`（兜底），两条路径结论必须一致
  assert.equal(resolveOrigin({ content: "有正文" }), resolveOrigin({ incoming: "有正文" }));
});

test("U2(9)-状态归一：有回信 4、无回信 5，永不产生 1 或 3", () => {
  assert.equal(resolveImportStatus({ reply: "她回了" }), 4);
  assert.equal(resolveImportStatus({ reply: "" }), 5);
  assert.equal(resolveImportStatus({}), 5);
  // ★ 这两条是 DSH 的硬要求，也是最容易被"顺手改成 1"的地方：
  //   落 1 ⇒ 我侧队列只挑 status=1 ⇒ 立刻替她补一封回信 = 伪造新信；
  //   落 3 ⇒ 卡在"正在跑"的瞬时态，那封信永远出不来。
  assert.notEqual(resolveImportStatus({ reply: "" }), STATUS.PENDING);
  assert.notEqual(resolveImportStatus({ reply: "x" }), STATUS.LLM_PROCESSING);
  assert.deepEqual([...new Set([IMPORT_STATUSES.REPLIED, IMPORT_STATUSES.UNREPLIED])], [4, 5]);
});

test("U3(10)-content_md5：有自带值原样保留、没有才按 DSH 那把尺子现算", () => {
  // ★ 首选路径：`.soul` 自带的 `contentMd5` 是权威值（解析阶段已复算比对过），落库原样保留。
  const declared = "0123456789abcdef0123456789abcdef";
  assert.equal(resolveContentMd5({ incoming: "随便", contentMd5: declared }), declared);
  // 大写不算合法值（真 `.soul` 一律小写）⇒ 退回现算，而不是原样落库
  assert.notEqual(resolveContentMd5({ incoming: "随便", contentMd5: declared.toUpperCase() }), declared.toUpperCase());

  // ★ 现算路径：照 DSH 的同一把尺子（来信 + 回信一起算），**不是** md5(来信)。
  assert.equal(resolveContentMd5({ incoming: "今天下班路上看到一只猫" }), exchangeFingerprint("今天下班路上看到一只猫", ""));
  assert.equal(resolveContentMd5({ incoming: "今天下班路上看到一只猫" }), "c7b18216846e500e08bc90a8305bd688");
  // 只算来信正文的旧口径必须**不同** —— 否则这条测试是空的
  assert.notEqual(resolveContentMd5({ incoming: "今天下班路上看到一只猫" }), contentFingerprint("今天下班路上看到一只猫"));

  // ★ 2026-10-17 更正：原先写「她先写的信留 NULL」，理由是「md5("") 是恒等值会把它们撞成一封」——
  //   那条理由建立在**只算来信正文**的错误算式上。DSH 的 `archiveReply()`（`server.js:3406-3419`）
  //   对主动信照算：那时 incoming 是空串、reply 是她的正文 ⇒ md5("\n---\n" + 正文)，各不相同。
  assert.equal(resolveContentMd5({ incoming: "", reply: "她先写的" }), "d7a41238e431a7d6333fdfc2a06e30a4");
  assert.notEqual(resolveContentMd5({ incoming: "", reply: "她先写的" }), resolveContentMd5({ incoming: "", reply: "另一封" }));

  // 两样都空 ⇒ 真的没有任何可校验的内容 ⇒ NULL（只有这一种情况才留空）
  assert.equal(resolveContentMd5({}), null);
  assert.equal(resolveContentMd5({ incoming: "", reply: "" }), null);

  // 兼容旧字段名（`content` 兜底），但**不能**因此绕过同一把尺子
  assert.equal(resolveContentMd5({ content: "今天下班路上看到一只猫" }), resolveContentMd5({ incoming: "今天下班路上看到一只猫" }));
});

test("U3(11)-发生时间：从 date/time 折成秒级时间戳，折不出来就 NULL 绝不编", () => {
  // ★ 唯一权威算式 = DSH 的 `exchangeTimestamp()`（`server.js:357-360`）：
  //   `Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000)`，本地时区。
  assert.equal(
    exchangeCreatedAt({ date: "2026-02-07", time: "08:30" }),
    Math.floor(new Date("2026-02-07T08:30:00").getTime() / 1000),
  );
  // 只给日期 ⇒ 按正午算（DSH `normalizeExchanges()` 的缺省值就是 "12:00"）
  assert.equal(exchangeCreatedAt({ date: "2026-02-07" }), Math.floor(new Date("2026-02-07T12:00:00").getTime() / 1000));
  // 时间形状不对也退回正午 —— 不能让一个坏字符串把时间算成 Invalid Date
  assert.equal(exchangeCreatedAt({ date: "2026-02-07", time: "25:99" }), exchangeCreatedAt({ date: "2026-02-07" }));
  // 没有日期 ⇒ NULL（不是 0，不是 now）
  assert.equal(exchangeCreatedAt({}), null);
  assert.equal(exchangeCreatedAt({ date: "昨天" }), null);
  assert.notEqual(exchangeCreatedAt({}), 0);
  assert.notEqual(exchangeCreatedAt({ date: "2026-02-07" }), null);
});

test("U3(11b)-archived_at：有显式戳就用，没有就 NULL（.soul 里根本没有时间戳字段）", () => {
  assert.equal(resolveArchivedAt({ repliedAt: 1700000000, createdAt: 1600000000 }), 1700000000);
  assert.equal(resolveArchivedAt({ createdAt: 1600000000 }), 1600000000);
  assert.equal(resolveArchivedAt({}), null);
  // ★ DSH 的警告：写 NULL 之后又拿它做过滤 ⇒ 重现他侧「只导 archived_at IS NULL
  //   ⇒ 丢掉所有已回信的信」那个坑。所以 NULL 必须能被统计出来，而不是静默当 0。
  assert.notEqual(resolveArchivedAt({}), 0);
  // ★★ 这条钉死「`.soul` 走这条路时永远拿不到」：真 `.soul` 里只有 date/time，
  //    没有 repliedAt/createdAt（DSH 回执逐字「没有，一个都没有」）
  //    ⇒ 落库方必须自己填 nowSeconds()，不能指望这里算出值来。
  assert.equal(resolveArchivedAt({ date: "2026-02-07", time: "08:30" }), null);
});

test("映射(12)-mapImportedLetter 一次给出整行，且状态永不落 1/3", () => {
  const row = mapImportedLetter({
    letterId: "L1", incoming: "今天下班路上看到一只猫", reply: "她的回信",
    date: "2026-02-07", time: "08:30", repliedAt: 1700000000,
  });
  assert.deepEqual(row, {
    letterId: "L1",
    content: "今天下班路上看到一只猫",
    replyText: "她的回信",
    origin: null,
    status: 4,
    contentMd5: exchangeFingerprint("今天下班路上看到一只猫", "她的回信"),
    createdAt: Math.floor(new Date("2026-02-07T08:30:00").getTime() / 1000),
    archivedAt: 1700000000,
  });
  assert.notEqual(row.contentMd5, contentFingerprint("今天下班路上看到一只猫"), "必须是两段一起算的往来指纹");

  const proactive = mapImportedLetter({ letterId: "L2", incoming: "", reply: "她先写的", createdAt: 1600000000 });
  assert.equal(proactive.origin, "proactive");
  assert.equal(proactive.status, 4, "她先写的信本身带着回信 ⇒ 4，不是 5");
  assert.equal(proactive.contentMd5, exchangeFingerprint("", "她先写的"));
  assert.equal(proactive.archivedAt, 1600000000);
  // 真 `.soul` 那一份：只有 date/time ⇒ createdAt 算得出来、archivedAt 是 NULL
  const real = mapImportedLetter({ letterId: "L3", incoming: "在吗", reply: "在的", date: "2026-02-07", time: "08:30" });
  assert.notEqual(real.createdAt, null);
  assert.equal(real.archivedAt, null);
});

test("视频(13)-N 的口径是 reply_video 非空的行数，且路由无关", () => {
  const rows = [
    { id: "a", reply_video: "v1.mp4" },  // 用户在界面手动上传的
    { id: "b", reply_video: "v2.mp4" },  // 更早一次 .soul 导入带进来的（server.js:2774 那条路径也会写）
    { id: "c", reply_video: null },
    { id: "d" },
  ];
  assert.equal(countReplyVideos(rows), 2);
  assert.equal(countReplyVideos([]), 0);
  assert.equal(countReplyVideos(undefined), 0);
  // ★ 只数"非空"，不区分来源 —— 所以描述里不能说成"用户手动上传的视频"
});

test("视频(14)-报告文案：数出来就写实，数不出来才说未统计", () => {
  assert.equal(videoSkipNote(0), "本次导入未搬运 0 个回信视频。", "0 也要老实写，不能装作没有");
  assert.equal(videoSkipNote(3), "本次导入未搬运 3 个回信视频。");
  assert.equal(videoSkipNote(undefined), "本次导入未搬运回信视频：未统计");
  assert.equal(videoSkipNote(-1), "本次导入未搬运回信视频：未统计");
  assert.equal(videoSkipNote(1.5), "本次导入未搬运回信视频：未统计");
});

// ---------------------------------------------------------------- 视频 N 的口径（两端同步 §3）
test("视频 N 必须取 .soul 里的 videos.length，不是源库 reply_video 行数", () => {
  // DSH 回执 §3：导出侧只收「已归档且能匹配上」的行 ⇒ .soul 的 videos.length **必然 ≤** 源库行数。
  // 用源库行数报数会**偏大**（把未归档的信也算进去了）。
  assert.equal(countSoulVideos({ videos: [{ size: 1 }, { size: 2 }] }), 2);
  assert.equal(countSoulVideos({ videos: [] }), 0, "确实一个都没有 ⇒ 报 0，不是「未统计」");
  assert.equal(countSoulVideos(null), null, "数不出来 ⇒ null（报告写『未统计』，不能装作 0）");
  assert.equal(countSoulVideos({}), null);
  // 旧的源库口径仍在，但它**不是**报告口径
  assert.equal(countReplyVideos([{ reply_video: "a.mp4" }, { reply_video: null }, {}]), 1);
});
