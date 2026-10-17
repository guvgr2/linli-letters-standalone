// core.mjs 的护栏测试。
//
// 为什么单独一套：机会判定与自检是**唯一能挡住「不该发的信被发出去」**的两道闸。
// 判据埋在 HTTP 处理器里就没法测，而没法测的护栏等于没有护栏。
//
// 两条原则：
//   1. 判定必须「宁可不发」—— 任一条件不满足都要 ok:false。
//   2. 自检必须「宁可不发」—— 模型输出踩任何一条禁区就不落库。
//
// 每条断言都要能被变异打红。改这个文件时，同步跑一次 tests/mutation-check.mjs。

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROACTIVE_DEFAULTS,
  PROACTIVE_REASONS,
  HER_BUSY,
  TRIGGER_WEIGHT,
  SHALLOW_UNTIL,
  UNANSWERED_BASE,
  UNANSWERED_CAP_HOURS,
  LIBRARY_DIR_PATTERN,
  SONG_NAME_MAX,
  clockToMinutes,
  effectiveGapHours,
  evaluateProactive,
  inspectProactive,
  inspectReply,
  inspectReplyDegraded,
  medianGapHours,
  normalizeTod,
  offlineGraceSeconds,
  parseLedger,
  parseVariant,
  playbackTimeOfDay,
  pickTrigger,
  prettySongName,
  classifyGenre,
  officialSong,
  songDisplayName,
  reserveDue,
  selectVariant,
  unansweredWaitHours,
  withoutSentences,
  resolveDriftTier,
  driftTextByTier,
} from "../app/core.mjs";
import { nearTermLimits, proactiveLimits, replyLimits } from "../app/behavior-params.mjs";

const ON = { enabled: true, windowStart: "09:00", windowEnd: "21:30", minGapHours: 20, maxPerDay: 1, maxPerWeek: 4 };
const HOUR = 3600;

/**
 * 全部条件都满足的基线上下文（14:00 = 840 分钟）。
 * ★ exchangedCount 必须 ≥ SHALLOW_UNTIL：基线里往来只有 3 封时，会被「由头质量下限」
 *   那条拦下（WEAK_TRIGGER），于是每一个期望 ok:true 的用例都会红 —— 而它红的**原因**
 *   根本不是这条用例要测的东西。基线要代表一段**已经熟起来**的关系。
 */
function okCtx(over = {}) {
  return {
    nowMinutes: 840,
    nowSeconds: 1_000_000,
    busyCount: 0,
    unreadProactive: 0,
    exchangedCount: 12,
    lastCreatedAt: 1_000_000 - 40 * HOUR,
    lastProactiveAt: 1_000_000 - 40 * HOUR,
    proactive24h: 0,
    proactive7d: 0,
    ...over,
  };
}

// ---------------------------------------------------------------- 机会判定

test("关掉开关就永不来信", () => {
  const v = evaluateProactive({ ...ON, enabled: false }, okCtx());
  assert.equal(v.ok, false);
  assert.match(v.reason, /关闭/);
});

test("默认值：默认开启，7 天上限 4 封", () => {
  assert.equal(PROACTIVE_DEFAULTS.enabled, true, "用户 2026-10-13 定：默认开启");
  assert.equal(PROACTIVE_DEFAULTS.maxPerWeek, 4, "用户 2026-10-13 定：7 天最多 4 封");
});

test("不在可打扰窗口内不发", () => {
  assert.equal(evaluateProactive(ON, okCtx({ nowMinutes: 23 * 60 + 30 })).ok, false);
  assert.equal(evaluateProactive(ON, okCtx({ nowMinutes: 8 * 60 + 59 })).ok, false);
  assert.equal(evaluateProactive(ON, okCtx({ nowMinutes: 9 * 60 })).ok, true, "窗口起点应当算在窗口内");
  assert.equal(evaluateProactive(ON, okCtx({ nowMinutes: 21 * 60 + 30 })).ok, true, "窗口终点应当算在窗口内");
});

test("还有信在生成中就不发", () => {
  assert.equal(evaluateProactive(ON, okCtx({ busyCount: 1 })).ok, false);
});

test("★ 未回复是「递增后衰减」，不是永久锁", () => {
  // 1 封没回 ≠ 人不在（竞品 committed 档原话：One unanswered everyday message does not
  //   imply hours of unavailability.）⇒ 只 1 封未读时照发。
  assert.equal(evaluateProactive(ON, okCtx({ unreadProactive: 1 })).ok, true, "只 1 封没读不该锁住");

  // 2 封没回、且上一封是刚发的 ⇒ 等
  const soon = evaluateProactive(ON, okCtx({
    unreadProactive: 2, lastProactiveAt: 1_000_000 - 2 * HOUR,
  }));
  assert.equal(soon.ok, false, "2 封没回应等待");
  assert.equal(soon.code, PROACTIVE_REASONS.UNANSWERED_WAIT, `必须是未回复这条拦下，实际：${soon.code}`);
  assert.ok(soon.waitHours > 0, "★ 要带回还要等多久，设置页才说得清");

  // 连着 6 封没回、但已经隔了很久 ⇒ 恢复，不能永久锁死
  const longAgo = evaluateProactive(ON, okCtx({
    unreadProactive: 6, lastProactiveAt: 1_000_000 - 400 * HOUR, lastCreatedAt: 1_000_000 - 400 * HOUR,
  }));
  assert.equal(longAgo.ok, true, "★ 压力必须随时间衰减，不能永久锁");
});

test("没有任何往来时不发 —— 林离无从下笔", () => {
  const v = evaluateProactive(ON, okCtx({ exchangedCount: 0, lastCreatedAt: null }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /没有.*往来/);
});

test("距上一封太近不发（默认 20 小时）", () => {
  const v = evaluateProactive(ON, okCtx({ lastCreatedAt: 1_000_000 - 5 * HOUR }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /未达 20/);
});

test("24 小时配额满就不发", () => {
  const v = evaluateProactive(ON, okCtx({ proactive24h: 1 }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /24 小时/);
});

test("7 天配额满就不发（24h 未满但 7 天满了）", () => {
  assert.equal(evaluateProactive(ON, okCtx({ proactive7d: 4 })).ok, false);
  assert.equal(evaluateProactive(ON, okCtx({ proactive7d: 3 })).ok, true, "上限 4、已发 3 应还能发");
});

test("★ 配额是「已发 N 封 >= 上限」就停，不是等超过", () => {
  // 变异常把 >= 写成 >：那样 24h 上限 1 时会允许发第 2 封。
  assert.equal(evaluateProactive(ON, okCtx({ proactive24h: 1, maxPerDay: undefined })).ok, false);
  assert.equal(evaluateProactive({ ...ON, maxPerDay: 2 }, okCtx({ proactive24h: 1 })).ok, true, "上限 2、已发 1 应还能发");
});

test("条件全满足才发", () => {
  const v = evaluateProactive(ON, okCtx());
  assert.equal(v.ok, true);
  assert.ok(v.trigger);
});

test("★ 由头只认程序这侧的事件，绝不来自来信人发言", () => {
  // ★ 后面两个是「借鉴多家 + 自己的创新」加进来的，一样是程序这侧的事实：
  //   open_loop = 她问过、还没有回音的那一句（来自**她自己写过的信**，不是来信人的发言）
  //   music_anchor = 此刻《原游戏口径》该播的那一档
  const allowed = ["song_played", "library_finding", "first_open_today", "quiet_days",
                   "time_of_day", "open_loop", "reunion", "music_anchor"];
  const seen = new Set();
  for (const input of [
    { songTitle: "夜曲 Op.9 No.2" },
    { libraryFinding: "缺 2 首时段" },
    { firstOpenToday: true },
    { lastCreatedAt: 1_000_000 - 5 * 24 * HOUR },
    {},
  ]) {
    const v = evaluateProactive(ON, okCtx(input));
    if (v.ok) seen.add(v.trigger.kind);
  }
  for (const kind of seen) assert.ok(allowed.includes(kind), `出现未知由头：${kind}`);
  assert.ok(seen.has("song_played"));
});

test("由头文本里不带「你说」「你让我」这类伪造用户发言的措辞", () => {
  const v = evaluateProactive(ON, okCtx({ songTitle: "花" }));
  assert.equal(v.ok, true);
  assert.doesNotMatch(v.trigger.text, /你说|你让我|你信里/);
});

test("时段格式非法时不发", () => {
  assert.equal(evaluateProactive({ ...ON, windowStart: "99:99" }, okCtx()).ok, false);
  assert.equal(evaluateProactive({ ...ON, windowEnd: "99:99" }, okCtx()).ok, false, "★ 结束时间填错同样要停，不能只查开始时间");
  assert.equal(evaluateProactive({ ...ON, windowStart: "25:00" }, okCtx()).ok, false);
});

// ---------------------------------------------------------------- 借鉴竞品
//
// 下面几条对着 `analysis/竞品深度拆解-可借鉴清单.md` 逐条落。借鉴的是**判据**，不是它的参数。
// ★ 每条都要能被变异打红：断言的是「哪一条拦下的」，不是「红不红」。

// ★ 为什么要有 FILLER：禁词用例如果太短，会先被「过短」这条拦下，
//   禁词分支根本没跑到 ⇒ 测试全绿却没验证到禁词（变异验证里被抓出来的，见 memory）。
//   所以禁词用例必须先把字数垫够，再断言 reason 命中「禁词」。
const FILLER = "今天练琴练了很久，手有点酸，窗外在下雨，茶也凉了。";
function padTo(text, minCjk) {
  let out = text;
  while ((out.match(/[一-龥]/g) ?? []).length < minCjk) out += FILLER;
  return out;
}
/** 从正文里**量出**某句的 span，不手填下标 —— 手填的下标挪一个字就全错。 */
function spanOf(text, needle) {
  const start = text.indexOf(needle);
  return { start, end: start + needle.length };
}

test("★ 闸门是双向的：她忙的时候是「她」不写，不是「你」不被打扰", () => {
  for (const act of Object.keys(HER_BUSY)) {
    const v = evaluateProactive(ON, okCtx({ herActivity: act }));
    assert.equal(v.ok, false, `她在${HER_BUSY[act]}时不该有信寄出`);
    assert.equal(v.code, PROACTIVE_REASONS.HER_BUSY, `必须是「她在忙」这条拦下，实际：${v.code}`);
    assert.match(v.reason, /她/, "★ 给人看的话要说是她，不是「不在可打扰窗口」");
  }
  // 不认识的状态 / 空值 ⇒ 不拦（不能因为多传一个字段就永远不发）
  assert.equal(evaluateProactive(ON, okCtx({ herActivity: "摸鱼" })).ok, true);
  assert.equal(evaluateProactive(ON, okCtx({ herActivity: "" })).ok, true);
  assert.equal(evaluateProactive(ON, okCtx()).ok, true);
});

test("★ 未回复的等待是递增的，但有上限", () => {
  assert.equal(unansweredWaitHours(0, 20), 0);
  assert.equal(unansweredWaitHours(1, 20), 0, "★ 只 1 封没回不算冷");
  const h2 = unansweredWaitHours(2, 20);
  const h3 = unansweredWaitHours(3, 20);
  assert.ok(h2 > 0 && h3 > h2, `必须递增：${h2} → ${h3}`);
  assert.equal(Math.round((h3 / h2) * 100) / 100, UNANSWERED_BASE, "每多一封按 1.45 倍拉长");
  assert.equal(unansweredWaitHours(30, 20), UNANSWERED_CAP_HOURS, "★ 有 7 天上限，不能无限涨");
  assert.ok(UNANSWERED_CAP_HOURS <= 168);
});

test("★ 最小间隔跟着这段关系自己的节奏，不是写死一个时钟", () => {
  assert.equal(medianGapHours([]), null);
  assert.equal(medianGapHours([1, 2, 3]), 2);
  assert.equal(medianGapHours([1, 2, 3, 4]), 2.5);
  assert.equal(medianGapHours([0.2, 999]), null, "★ 30 分钟以下 / 7 天以上不算样本");
  assert.equal(medianGapHours([1, 2, 999, 3]), 2, "超范围的样本要剔掉，不能把中位数带飞");

  // 一周写一次的人 ⇒ 间隔要跟着放大，而不是照样 20 小时催一封
  const weekly = effectiveGapHours(ON, 168);
  assert.ok(weekly > 24 * 5, `一周一封的关系不该按 20 小时催，实际 ${weekly}`);
  assert.equal(effectiveGapHours(ON, undefined), 20, "没样本就退回用户填的");
  assert.equal(effectiveGapHours(ON, 100000), 20, "离谱的样本当作没有样本");

  // ★ 判据要真的用了它：一周一封的关系，隔 40 小时再来一封就是轰炸
  const v = evaluateProactive(ON, okCtx({ usualGapHours: 168 }));
  assert.equal(v.ok, false);
  assert.equal(v.code, PROACTIVE_REASONS.GAP, `必须是间隔这条拦下，实际：${v.code}`);
});

test("★ 离线过久不补发：刚打开程序不立刻来信", () => {
  const quietLong = { lastCreatedAt: 1_000_000 - 72 * HOUR, lastProactiveAt: 1_000_000 - 72 * HOUR };
  const v = evaluateProactive(ON, okCtx({ ...quietLong, secondsSinceLaunch: 5, seed: 1234 }));
  assert.equal(v.ok, false, "隔了三天不该一开程序就收到信");
  assert.equal(v.code, PROACTIVE_REASONS.OFFLINE_GRACE, `必须是宽限这条拦下，实际：${v.code}`);

  const grace = offlineGraceSeconds(1234);
  const later = evaluateProactive(ON, okCtx({ ...quietLong, secondsSinceLaunch: grace + 1, seed: 1234 }));
  assert.equal(later.ok, true, "★ 等过那一小段就该放行，不能一直拖着");

  // 只隔了 21 小时 ⇒ 不算「离线过久」，不适用这条
  assert.equal(evaluateProactive(ON, okCtx({
    lastCreatedAt: 1_000_000 - 21 * HOUR, secondsSinceLaunch: 5, seed: 1234,
  })).ok, true);
});

test("离线宽限是抖动的、但可复现", () => {
  const seen = new Set();
  for (let s = 0; s < 300; s += 1) {
    const g = offlineGraceSeconds(s);
    assert.ok(g >= 60 && g <= 300, `越界：${g}`);
    seen.add(g);
  }
  assert.ok(seen.size > 30, `★ 抖动要真的抖，不能是常数（只有 ${seen.size} 种）`);
  assert.equal(offlineGraceSeconds(7), offlineGraceSeconds(7), "同 seed 必须同值，否则没法复现");
  assert.equal(offlineGraceSeconds(NaN), 60);
});

test("★ 不发原因的代号是写死的契约（不是拿常量跟常量比）", () => {
  // ★ 只写 `assert.equal(v.code, PROACTIVE_REASONS.HER_BUSY)` 是同义反复：
  //   把常量值改错时，期望值和实际值**一起变** ⇒ 测试永远绿。代号必须用字面量钉住。
  //   （变异验证里被抓出来的，见 memory。）
  assert.equal(PROACTIVE_REASONS.DISABLED, "disabled");
  assert.equal(PROACTIVE_REASONS.BAD_WINDOW, "bad_window");
  assert.equal(PROACTIVE_REASONS.OUT_OF_HOURS, "out_of_hours");
  assert.equal(PROACTIVE_REASONS.HER_BUSY, "her_busy");
  assert.equal(PROACTIVE_REASONS.BUSY, "sending_uncertain");
  assert.equal(PROACTIVE_REASONS.UNANSWERED_WAIT, "unanswered_wait");
  assert.equal(PROACTIVE_REASONS.NO_EXCHANGE, "no_target");
  assert.equal(PROACTIVE_REASONS.GAP, "wait_user");
  assert.equal(PROACTIVE_REASONS.OFFLINE_GRACE, "restore_delay");
  assert.equal(PROACTIVE_REASONS.WEAK_TRIGGER, "reason_floor");
  assert.equal(PROACTIVE_REASONS.READY, "ready");
  // 24h 与 7d 共用 attempt_limit 是**故意**的：对观察端它们都是"这轮配额用完了"。
  assert.equal(PROACTIVE_REASONS.DAY_LIMIT, "attempt_limit");
  assert.equal(PROACTIVE_REASONS.WEEK_LIMIT, "attempt_limit");
});

test("★ 每个「不发」都有名字，且是枚举值", () => {
  const cases = [
    [{ enabled: false }, {}, PROACTIVE_REASONS.DISABLED],
    [{ ...ON, windowStart: "99:99" }, {}, PROACTIVE_REASONS.BAD_WINDOW],
    [ON, { nowMinutes: 23 * 60 + 30 }, PROACTIVE_REASONS.OUT_OF_HOURS],
    [ON, { herActivity: "sleeping" }, PROACTIVE_REASONS.HER_BUSY],
    [ON, { busyCount: 1 }, PROACTIVE_REASONS.BUSY],
    [ON, { exchangedCount: 0, lastCreatedAt: null }, PROACTIVE_REASONS.NO_EXCHANGE],
    [ON, { lastCreatedAt: 1_000_000 - 5 * HOUR }, PROACTIVE_REASONS.GAP],
    [ON, { proactive24h: 1 }, PROACTIVE_REASONS.DAY_LIMIT],
    [ON, { proactive7d: 4 }, PROACTIVE_REASONS.WEEK_LIMIT],
    [ON, { exchangedCount: 2 }, PROACTIVE_REASONS.WEAK_TRIGGER],
  ];
  const all = new Set(Object.values(PROACTIVE_REASONS));
  for (const [settings, over, code] of cases) {
    const v = evaluateProactive(settings, okCtx(over));
    assert.equal(v.ok, false, `应不发：${code}`);
    assert.equal(v.code, code, `原因代号不符：期望 ${code}，实际 ${v.code}（${v.reason}）`);
    assert.ok(all.has(v.code), `代号必须是枚举里的：${v.code}`);
    assert.ok(v.reason && v.reason.length > 0, "★ 代号之外还要有一句人话");
  }
  assert.equal(evaluateProactive(ON, okCtx()).code, PROACTIVE_REASONS.READY);
});

test("★ 由头有质量下限：关系还浅时不写空洞寒暄", () => {
  const shallow = evaluateProactive(ON, okCtx({ exchangedCount: 2 }));
  assert.equal(shallow.ok, false);
  assert.equal(shallow.code, PROACTIVE_REASONS.WEAK_TRIGGER);
  assert.match(shallow.reason, /值得写信|空洞/);

  // 关系浅但**真有事** ⇒ 照发
  for (const input of [
    { songTitle: "花" },
    { libraryFinding: "缺 2 首时段" },
    { lastCreatedAt: 1_000_000 - 5 * 24 * HOUR },
  ]) {
    assert.equal(evaluateProactive(ON, okCtx({ exchangedCount: 2, ...input })).ok, true,
      `有事就不算寒暄：${JSON.stringify(input)}`);
  }
  assert.ok(TRIGGER_WEIGHT.time_of_day < 2 && TRIGGER_WEIGHT.song_played >= 2, "★ 权重表要区分得出空洞与有事");
  assert.ok(SHALLOW_UNTIL >= 2, "下限不能是 0，否则这条闸形同虚设");
});

test("由头权重表覆盖全部由头，没有漏网的 kind", () => {
  const kinds = [
    pickTrigger({ songTitle: "x" }).kind,
    pickTrigger({ libraryFinding: "y" }).kind,
    pickTrigger({ firstOpenToday: true }).kind,
    pickTrigger({}, 1_000_000, 1).kind,
    pickTrigger({}, 1_000_000, 1_000_000).kind,
  ];
  for (const k of kinds) {
    assert.ok(Number.isFinite(TRIGGER_WEIGHT[k]), `权重表漏了：${k}`);
  }
});

test("★ 生成之前先扣掉这次机会：抖动可复现，且必须往后推", () => {
  const now = 1_000_000;
  const due = reserveDue(now, 20, 7);
  assert.ok(due > now, "★ 必须是 now + 间隔，不能只写 now（那样等于没扣）");
  const span = (due - now) / 3600;
  assert.ok(span >= 20 * 0.9 - 1e-6 && span <= 20 * 1.1 + 1e-6, `抖动要落在 0.9~1.1 倍内，实际 ${span}`);
  assert.equal(reserveDue(now, 20, 7), due, "同 seed 必须同值");
  assert.notEqual(reserveDue(now, 20, 8), due, "★ 要有抖动，不能每次都一样");
  assert.equal(reserveDue(NaN, 20, 1), null);
  assert.equal(reserveDue(now, 0, 1), now, "间隔 0 时不该再等");
});

test("★ 回信降级：只删被点名的句子，不是整封重写", () => {
  const body = "开头一句。\n\n中间那句是编的。\n\n结尾一句。";
  const cut = withoutSentences(body, [spanOf(body, "中间那句是编的")]);
  assert.ok(cut.includes("开头"), "★ 不该动的句子必须原样留下");
  assert.ok(cut.includes("结尾"), "★ 不该动的句子必须原样留下");
  assert.ok(!cut.includes("中间"), "被点名的句子要删掉");

  assert.equal(withoutSentences(body, []), body.trim());
  assert.equal(withoutSentences(body, null), body.trim());
  assert.equal(withoutSentences(body, [{ start: 5, end: 5 }]), body.trim(), "空 span 不能误删");
  assert.equal(withoutSentences(body, [{ start: 9, end: 3 }]), body.trim(), "倒挂的 span 要忽略");
  assert.equal(withoutSentences(body, [{ start: NaN, end: 1 }]), body.trim(), "NaN 下标要忽略");
});

test("★ 回信降级只重写一次，且主动信仍然整封拒绝", () => {
  const bad = padTo("今天练琴。由头这词不该出现。手有点酸。", 60);
  const spans = [spanOf(bad, "由头")];
  assert.equal(inspectReply(bad).ok, false, "前提：原文确实踩线");

  const d = inspectReplyDegraded(bad, spans);
  assert.equal(d.ok, true, "删掉那句就该能发");
  assert.equal(d.degraded, true, "★ 要标出来这是删过的，别假装没删");

  // 没有可删的 span ⇒ 不发，且不标 degraded
  const none = inspectReplyDegraded(bad, []);
  assert.equal(none.ok, false);
  assert.equal(none.degraded, false);

  // ★ 主动信没有降级路径：踩线即整封不落库
  assert.equal(inspectProactive(bad).ok, false);
});

test("★ 曲名有长度上限，超长目录名不能把界面撑破", () => {
  const name = prettySongName("solo_" + "a".repeat(400));
  assert.ok(name.length <= SONG_NAME_MAX, `实际 ${name.length}`);
  assert.ok(name.endsWith("…"), "★ 截断要有省略号，不能硬切");
  assert.ok(prettySongName("solo_piano_01").length <= SONG_NAME_MAX, "短名不该被动到");
  assert.ok(SONG_NAME_MAX > 0 && SONG_NAME_MAX <= 200);
});

// ---------------------------------------------------------------- 自检

test("自检：共用禁词两类都要拦（且必须是禁词这一条拦的）", () => {
  // 由头 / 预检 / 账本 / 栏目 / 触发 —— 回信和主动信都不能泄漏内部词
  for (const word of ["由头", "预检", "账本", "栏目", "主动来信"]) {
    const r = inspectReply(padTo(word, 40));
    assert.equal(r.ok, false, `回信应拒绝：${word}`);
    assert.match(r.reason, /禁词/, `回信拒绝原因必须是禁词，实际是：${r.reason}`);

    const p = inspectProactive(padTo(word, 40));
    assert.equal(p.ok, false, `主动信应拒绝：${word}`);
    assert.match(p.reason, /禁词/, `主动信拒绝原因必须是禁词，实际是：${p.reason}`);
  }
});

test("★ 主动信专属禁词：伪造用户发言与关系升级只拦主动信，不拦回信", () => {
  // 回信本来就要引用来信人的话，「你说过」「如你所说」是合理的；
  // 主动信没有来信，出现这些就是伪造用户发言。
  for (const word of ["你说过", "如你所说", "你上次说", "老公", "想我吗"]) {
    const p = inspectProactive(padTo(word, 40));
    assert.equal(p.ok, false, `主动信应拒绝：${word}`);
    assert.match(p.reason, /禁词/, `主动信拒绝原因必须是禁词，实际是：${p.reason}`);

    const r = inspectReply(padTo(word, 40));
    assert.equal(r.ok, true, `回信不该拦「${word}」——那是正常引用，实际拦了：${r.reason}`);
  }
});

test("自检：主动信超长 / 段数过多 / 英文长串 / 过短 都不落库", () => {
  assert.equal(inspectProactive("字".repeat(260)).ok, false, "超长");
  assert.equal(inspectProactive("在吗").ok, false, "过短");
  assert.equal(inspectProactive("").ok, false, "空");

  const withEnglish = padTo("今天练琴。 Also something completely different.", 40);
  const en = inspectProactive(withEnglish);
  assert.equal(en.ok, false, "英文长串");
  assert.match(en.reason, /英文/);

  // 段数：4 段，每段字数够，总字数在 20–200 之间 ⇒ 只能由段数这条拦下
  const four = ["第一段今天调音师傅来过。", "第二段他说这台琴比我还大。", "第三段我弹了三遍开头。", "第四段手有点酸。"]
    .map((s) => padTo(s, 25))
    .join("\n\n");
  const cjk = (four.match(/[一-龥]/g) ?? []).length;
  assert.ok(cjk >= 20 && cjk <= 200, `段落样本字数要落在 20–200，实际 ${cjk}`);
  const para = inspectProactive(four);
  assert.equal(para.ok, false, "段数超限");
  assert.match(para.reason, /段/, `必须由段数这条拦下，实际：${para.reason}`);
});

test("自检：回信带角色名前缀要拦", () => {
  assert.equal(inspectReply("林离：今天练琴练了很久，手有点酸。").ok, false);
});

test("自检：正常文本能过", () => {
  const proactive = "今天下午调音师傅来过，折腾了两个多小时。\n\n他说这台琴比我还大，脾气也比我稳。\n\n你那边今天有没有什么声音忽然变得不太一样？";
  assert.equal(inspectProactive(proactive).ok, true);
  assert.equal(inspectReply(proactive).ok, true);
});

// ------------------------------------------------- T8：硬校验值只认 行为参数.json
//
// 真源侧（DSH）维护 `harness/行为参数.json`，我侧随包带一份 `app/harness/行为参数.json`。
// 这组断言守两件事：① 代码真的在读它（不是抄了一份在 core.mjs 里）；
// ② P2 拍板的「最短长度双条件」真的按 minCharsRule 实现了。

test("★ T8：自检阈值来自 行为参数.json，core.mjs 里不再有第二份数字", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const R = replyLimits();
  const P = proactiveLimits();
  assert.ok(Number.isFinite(R.maxChars) && Number.isFinite(P.maxChars), "两份都要能读到上限");
  assert.ok(P.maxChars < R.maxChars, "★ 主动信必须比回信严，否则同一段文字两端判定不一致");

  // 边界是从 JSON 里量出来的，不是写死的 —— 改 JSON，这条跟着走。
  assert.equal(inspectProactive("字".repeat(P.maxChars)).ok, true, `${P.maxChars} 字应当放行`);
  assert.equal(inspectProactive("字".repeat(P.maxChars + 1)).ok, false, `${P.maxChars + 1} 字应当被上限拦下`);
  assert.equal(inspectReply("字".repeat(R.maxChars)).ok, true, `${R.maxChars} 字应当放行`);
  assert.equal(inspectReply("字".repeat(R.maxChars + 1)).ok, false, `${R.maxChars + 1} 字应当被上限拦下`);

  // ★ 反向断言：core.mjs 不许再出现「阈值字段名 + 数字字面量」—— 出现了就是第二份真源。
  const src = await readFile(join(import.meta.dirname, "..", "app", "core.mjs"), "utf8");
  for (const field of ["maxChars", "minChars", "maxParagraphs", "maxAsciiRun"]) {
    const hit = new RegExp(`${field}:\\s*\\d`).exec(src);
    assert.equal(hit, null, `core.mjs 里又出现了硬编码阈值（${hit?.[0]}）⇒ 改回读 行为参数.json`);
  }
  assert.ok(!src.includes("\"由头\""), "core.mjs 里又出现了手写的禁词表 ⇒ 改回读 行为参数.json");
});

test("★ P2 双条件：一句 12 字的合法主动信要放行，真碎片照拦", () => {
  const P = proactiveLimits();

  // C1 记录的那句：12 个汉字，单段 → 单段门槛 minChars（12）刚好放行。
  const oneLine = "今天路过那家店，忽然很想你。";
  const cjk = (oneLine.match(/[一-龥]/g) ?? []).length;
  assert.ok(cjk >= P.minChars, `样本要落在门槛上（${cjk} vs ${P.minChars}）`);
  assert.equal(inspectProactive(oneLine).ok, true, "★ 单值 minChars=20 会把这句合法信拒掉 —— 这正是 C1");

  // 多段：总字数不到单段门槛，但按 minCharsRule 多段只要求非空 ⇒ 放行。
  const twoShort = "在吗。\n\n想你了。";
  assert.equal(inspectProactive(twoShort).ok, true, "★ 多段走 minCharsWhenMultiParagraph，不该被单段门槛拦下");

  // 单段的真碎片仍然要拦。
  assert.equal(inspectProactive("在吗").ok, false, "单段 2 字仍是碎片");
  assert.equal(inspectProactive("。").ok, false, "只剩标点要拦");
});

test("★ 主动信比回信更严：回信允许的长文本，主动信要拦", () => {
  // 主动信上限 200 字、3 段；回信 240 字、8 段。同一段文字应出现「回信过、主动信不过」。
  const mid = "字".repeat(220);
  assert.equal(inspectReply(mid).ok, true);
  assert.equal(inspectProactive(mid).ok, false);
  assert.equal(inspectReply("字".repeat(300)).ok, false, "★ 回信自己也有上限，不能只给主动信设限");
});

// ------------------------------------------------- T9：近况层档位（只认真源 JSON）
//
// 真源 = `行为参数.json` 的 `nearTerm`（DSH 侧 §4.22 ⑤ 的可执行判定式）。
// 这组断言守四件事：① 开关总闸；② 用户开关；③ 按信件数落档且第 0 档不注入（传 -1）；
// ④ 不回退（删信件也不降档）。阈值全部从 JSON 量出来，不写死。

test("★ T9：近况层档位判定按真源 tiers 落档，第 0 档不注入", () => {
  const N = nearTermLimits();
  assert.equal(N.enabled, true, "真源 nearTerm.enabled 应为 true（P1 已拍板）");
  assert.equal(N.userToggle.key, "keep-current-shape", "★ 键名必须两端同构");
  assert.equal(N.userToggle.default, false, "★ 默认关 = 近况层生效");

  // ★ 总闸关闭（真源 enabled=false）⇒ 一律不注入。
  //   真源的 enabled 恒为 true，若不注入口径这条分支就永远走不到（变异会报「仍绿」）——
  //   所以这里注入一份 enabled:false 的口径，把这条分支真正测到。
  assert.equal(
    resolveDriftTier({ letters: 9999, toggleValue: "0" }, { ...N, enabled: false }),
    -1,
    "★ 总闸关闭（enabled=false）⇒ 不注入",
  );

  // 档位边界从 JSON 的 tiers 量出来（0–3 ⇒ 0 / 4–20 ⇒ 1 / 21–60 ⇒ 2 / 61+ ⇒ 3），
  // 不写死数字 —— 改 JSON，这条跟着走。
  const t0 = N.tiers.find((t) => t.tier === 0);
  const t1 = N.tiers.find((t) => t.tier === 1);
  assert.ok(t0 && t1, "真源应有第 0、1 档");
  // 第 0 档：不注入 ⇒ 传 -1（★ 不是传「第 0 档的文本」）
  assert.equal(resolveDriftTier({ letters: 0, toggleValue: "0" }), -1, "0 封 ⇒ -1");
  assert.equal(resolveDriftTier({ letters: t0.lettersTo, toggleValue: "0" }), -1, "第 0 档上界仍不注入");
  // 第 1 档起点
  assert.equal(resolveDriftTier({ letters: t1.lettersFrom, toggleValue: "0" }), 1, "第 1 档起点应落档 1");
  // 最高档
  assert.equal(resolveDriftTier({ letters: 9999, toggleValue: "0" }), 3, "极多信件 ⇒ 第 3 档");
});

test("★ T9：开关与不回退 —— 用户打开则不注入，删信件也不降档", () => {
  const N = nearTermLimits();
  // 用户开关（真源 key）打开 ⇒ 不注入
  assert.equal(resolveDriftTier({ letters: 9999, toggleValue: "1" }), -1, "★ 打开「保持她现在的样子」⇒ 不注入");
  assert.equal(resolveDriftTier({ letters: 9999, toggleValue: true }), -1, "布尔 true 也要认");
  // ★ 不回退：allowRollback=false 时，历史最高档要兜住
  assert.equal(N.allowRollback, false, "真源 allowRollback 应为 false");
  assert.equal(resolveDriftTier({ letters: 0, toggleValue: "0", maxTier: 2 }), 2, "★ 删信件到 0 封也不许跌回 -1（不回退）");
  assert.equal(resolveDriftTier({ letters: 5, toggleValue: "0", maxTier: 3 }), 3, "历史最高 3 ⇒ 仍算 3");
  // 开关优先级高于不回退（用户没打开，但真源总闸关了 ⇒ -1）
  assert.equal(resolveDriftTier({ letters: 9999, toggleValue: "0", maxTier: 3 }), 3, "未开开关 + 高历史档 ⇒ 维持高档");
});

test("★ T9：近况文本按档累积拼接，-1/0 档返回空串", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const md = await readFile(join(import.meta.dirname, "..", "app", "harness", "近况.md"), "utf8");
  const at = driftTextByTier(md);
  // 第 0 档/ -1 ⇒ 空串（不注入）
  assert.equal(at(-1), "");
  assert.equal(at(0), "");
  // 第 1 档非空
  const t1 = at(1);
  assert.ok(t1.length > 0, "第 1 档应有文本");
  // ★ 第 2 档起累积：档 2 必须**包含**档 1（真源近况.md 顶部写明「第 2 档起累积」）
  const t2 = at(2);
  const t3 = at(3);
  assert.ok(t2.length > t1.length, "★ 档 2 应比档 1 长（累积，不是替换）");
  assert.ok(t2.includes(t1.split("\n")[0].replace(/^-\s*/, "")), "★ 档 2 应含档 1 的内容");
  assert.ok(t3.length > t2.length, "★ 档 3 应比档 2 长（累积）");
  assert.ok(t3.includes(t2.split("\n")[0].replace(/^-\s*/, "")), "★ 档 3 应含档 2 的内容");
  // 超出最高档也不许炸：应按最高档给
  assert.equal(at(9), t3, "超出最高档 ⇒ 按最高档给");
});

test("★ T9：core.mjs 的 resolveDriftTier 不许出现硬编码档位阈值", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(join(import.meta.dirname, "..", "app", "core.mjs"), "utf8");
  // ★ 反向断言：档位判定不许在源码里写「lettersFrom: 数字」这类字面量 —— 那是第二份真源。
  const hit = /lettersFrom:\s*\d/.exec(src);
  assert.equal(hit, null, `core.mjs 里出现了硬编码档位阈值（${hit?.[0]}）⇒ 改回读 行为参数.json`);
  // 开关键名也不许写死在 core.mjs（要从真源 userToggle.key 读）
  assert.ok(!src.includes("\"keep-current-shape\""), "core.mjs 里又写死了开关键名 ⇒ 改回读真源");
});

// ---------------------------------------------------------------- 账本

test("账本解析：全角分隔、只认已知字段", () => {
  const text = [
    "关系　好朋友",
    "未决　疑问：吉他",
    "结论　通过",
    "关系依据　无",
    "瞎写的字段　应被忽略",
    "没有分隔符的行",
  ].join("\n");
  const ledger = parseLedger(text);
  assert.equal(ledger["关系"], "好朋友");
  assert.equal(ledger["未决"], "疑问：吉他");
  assert.equal(ledger["结论"], "通过");
  assert.equal(ledger["瞎写的字段"], undefined);
});

test("账本解析：空输入返回空对象，不抛", () => {
  assert.deepEqual(parseLedger(""), {});
  assert.deepEqual(parseLedger(null), {});
});

// ---------------------------------------------------------------- 工具

test("clockToMinutes 边界", () => {
  assert.equal(clockToMinutes("00:00"), 0);
  assert.equal(clockToMinutes("23:59"), 1439);
  assert.equal(clockToMinutes("24:00"), null);
  assert.equal(clockToMinutes("9:5"), null);
  assert.equal(clockToMinutes("abc"), null);
});

// ---------------------------------------------------------------- 曲库变体
//
// 口径不是我定的，是从 OliviaSoul 旧项目逐行抄来的一手证据：
//   midi/playback-clock.js —— 06:00–16:00→TOD12，16:00–20:00→TOD1730，20:00–06:00→TOD20。
//     ★ 傍晚从 16:00 开始，不是 17:30。TOD1730 只是素材标签，别被名字骗了。
//   selectSongVariant —— tod+view 精确 → 同 tod 无 view → 同 tod → 兜底。

test("★ 时段边界跟着原游戏：16:00 进傍晚，20:00 进夜晚", () => {
  assert.equal(playbackTimeOfDay(6 * 60), "TOD12", "06:00 是白天起点");
  assert.equal(playbackTimeOfDay(15 * 60 + 59), "TOD12");
  assert.equal(playbackTimeOfDay(16 * 60), "TOD1730", "★ 16:00 就切傍晚，不是 17:30");
  assert.equal(playbackTimeOfDay(17 * 60 + 30), "TOD1730");
  assert.equal(playbackTimeOfDay(19 * 60 + 59), "TOD1730");
  assert.equal(playbackTimeOfDay(20 * 60), "TOD20");
  assert.equal(playbackTimeOfDay(0), "TOD20", "午夜是夜晚");
  assert.equal(playbackTimeOfDay(5 * 60 + 59), "TOD20");
});

test("编号归一：1200/12→TOD12，1730/17→TOD1730，2000/20→TOD20", () => {
  assert.equal(normalizeTod("TOD1200"), "TOD12");
  assert.equal(normalizeTod("TOD12"), "TOD12");
  assert.equal(normalizeTod("TOD1730"), "TOD1730");
  assert.equal(normalizeTod("TOD17"), "TOD1730");
  assert.equal(normalizeTod("TOD2000"), "TOD20");
  assert.equal(normalizeTod("TOD20"), "TOD20");
  assert.equal(normalizeTod("TOD99"), null);
  assert.equal(normalizeTod(""), null);
});

test("文件名解析：时段 / 视角 / 朝向", () => {
  assert.deepEqual(parseVariant("Song_TOD1200_NI_L.mp4"), { tod: "TOD12", view: "NI", hand: "L" });
  assert.deepEqual(parseVariant("Song_TOD2000_WI_R.mp4"), { tod: "TOD20", view: "WI", hand: "R" });
  assert.deepEqual(parseVariant("Song_TOD1200.mp4"), { tod: "TOD12", view: null, hand: null });
  assert.equal(parseVariant("Song_NoTag.mp4"), null);
});

test("★ 选变体优先级：tod+view 精确 → 同 tod 无 view → 同 tod → 兜底", () => {
  const list = [
    { file: "a_TOD1200_NI_L.mp4", tod: "TOD12", view: "NI", hand: "L" },
    { file: "a_TOD1200_WI_L.mp4", tod: "TOD12", view: "WI", hand: "L" },
    { file: "a_TOD2000_NI_L.mp4", tod: "TOD20", view: "NI", hand: "L" },
  ];
  assert.equal(selectVariant(list, "TOD12", "NI").file, "a_TOD1200_NI_L.mp4", "精确命中同 tod 同 view");
  assert.equal(selectVariant(list, "TOD12", "WI").file, "a_TOD1200_WI_L.mp4");

  // 没有 NI 视角 ⇒ 退到「同 tod 无 view」，绝不能串到别的时段去
  const noNi = [{ file: "b_TOD1200.mp4", tod: "TOD12", view: null }, { file: "b_TOD2000_NI.mp4", tod: "TOD20", view: "NI" }];
  assert.equal(selectVariant(noNi, "TOD12", "NI").file, "b_TOD1200.mp4", "★ 视缺省不能串时段");

  // 该时段完全没有 ⇒ 兜底，但不能返回 undefined
  assert.ok(selectVariant(list, "TOD1730", "NI"), "缺时段时也要能播，不能不返回");
  assert.equal(selectVariant([], "TOD12", "NI"), null);
});

test("曲库目录筛选口径：只认 solo / playsing 开头", () => {
  for (const dir of ["solo_piano_01", "PlaySing_The_Road", "SOLO_x", "playsing_y", "solo", "playsing"]) {
    assert.ok(LIBRARY_DIR_PATTERN.test(dir), `应命中：${dir}`);
  }
  for (const dir of ["bgm_01", "MySolo", "ost_playsing", "background_solo", ""]) {
    assert.equal(LIBRARY_DIR_PATTERN.test(dir), false, `不该命中：${dir}`);
  }
  assert.equal(LIBRARY_DIR_PATTERN.source.includes("^"), true, "★ 必须锚在开头，否则 MySolo 会被算进来");
});

test("曲名美化：去掉来源尾巴，但不能把曲名削没", () => {
  assert.equal(prettySongName("PlaySing_The_Road_Not_Taken_Ziyun_original"), "PlaySing The Road Not Taken");
  assert.equal(prettySongName("solo_piano_01"), "solo piano 01");
  assert.equal(prettySongName(""), "");
  assert.ok(prettySongName("solo_ziyun_original").length > 0, "★ 只剩尾巴时也要留下可显示的名字");
});

test("官方曲名表：129 首对过表的曲子显示原版曲名（契约值用字面量钉死）", async () => {
  // ★ 三重指纹（模式列 98/31 + ffprobe 时长 + 目录名语义）对表的结果，样例逐字钉住。
  //   别把期望值写成 OFFICIAL_SONGS 的常量 —— 那是同义反复，表值改错时永远绿。
  assert.equal(officialSong("PlaySing_The_Road_Not_Taken_Ziyun_original")?.title, "未行之路 The Road Not Taken");
  assert.equal(officialSong("Solo_Schumann_Papillons_Op2")?.title, "Papillons, Op.2（蝴蝶）");
  assert.equal(officialSong("Solo_Schumann_Papillons_Op2")?.composer, "Schumann");
  assert.equal(officialSong("PlaySing_Fen_Shua_Jiang_Ziyun_original")?.title, "粉刷匠");
  assert.equal(officialSong("Solo_Croatian_Rhapsody")?.title, "Croatian Rhapsody（克罗地亚狂想曲）");
  assert.equal(officialSong("PlaySing_Moon_Halo_Ziyun_original")?.composer, "HOYO-MIX");
  assert.equal(officialSong("Solo_Turkish_March")?.composer, "Tchaikovsky");
  // 表外（个人上传 / 不存在的目录）不乱给名字
  assert.equal(officialSong("midi_100022_1784248593"), null);
  assert.equal(officialSong("solo_user_made_song"), null);
  // songDisplayName：表内走原版曲名、表外走裸名清洗
  assert.equal(songDisplayName("PlaySing_The_Road_Not_Taken_Ziyun_original"), "未行之路 The Road Not Taken");
  assert.equal(songDisplayName("solo_piano_01"), "solo piano 01");
  // ★ 覆盖面：fixture 里的 129 条每一条都能被 officialSong 查到（表和 fixture 不许漂移）
  const { readFile } = await import("node:fs/promises");
  const fx = JSON.parse(await readFile(new URL("./fixtures/official-song-names.json", import.meta.url), "utf8"));
  const dirs = Object.keys(fx);
  assert.equal(dirs.length, 129);
  for (const dir of dirs) {
    const hit = officialSong(dir);
    assert.ok(hit, `表里查不到：${dir}`);
    assert.equal(hit.title, fx[dir].title, `曲名漂移：${dir}`);
    assert.equal(hit.composer, fx[dir].composer, `作曲家漂移：${dir}`);
  }
  // genre/mode 与分类表同源一致（fixture 的 genre 应与 classifyGenre 一致）
  for (const dir of dirs) {
    if (fx[dir].genre !== "我的上传") {
      assert.equal(classifyGenre(dir), fx[dir].genre, `分类漂移：${dir}`);
    }
  }
});
