// 纯逻辑层：不碰数据库、不发网络、不读文件 —— 这样才能单测。
//
// 从 server.mjs 抽出来的原因：机会判定与自检是这个程序**唯一能挡住「不该发的信被发出去」**的两道闸，
// 埋在 HTTP 处理器里就没法测，而没法测的护栏等于没有护栏（旧项目踩过：沙箱自造前提 ⇒ 全绿却漏 P0）。
//
// ★ 唯一的例外（2026-10-16 T8）：自检阈值改从 `app/harness/行为参数.json` 读，
//   那是上游维护的唯一一份口径。它读不到就抛 —— 不回退、不静默。

import { nearTermLimits, proactiveLimits, replyLimits } from "./behavior-params.mjs";
// ★ 只用于给记忆条目算稳定 id（`ledgerItemId`）—— 不是 IO，也不引随机源，纯函数仍然成立。
import { createHash } from "node:crypto";

export const PROACTIVE_DEFAULTS = Object.freeze({
  // 用户 2026-10-13 定：默认开启，7 天最多 4 封。
  enabled: true,
  windowStart: "09:00",
  windowEnd: "21:30",
  minGapHours: 20,
  maxPerDay: 1,
  maxPerWeek: 4,
  checkIntervalMinutes: 30,
});

export function clockToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// ---------------------------------------------------------------- 借鉴竞品
//
// 下面这几条来自 `analysis/竞品深度拆解-可借鉴清单.md`（逐条对着它的源码定的）。
// ★ 借鉴的是**判据与思路**，不是它的参数：它的 committed 档 5 分钟一封、
//   主动间隔上限 72 次/天，对一个"写信"的程序显然太密，我们按自己的尺度重定。

/**
 * (1) 她自己的作息 —— 闸门是双向的。
 * 竞品 `proactive_runtime.py` 的 world_gates：她睡觉/洗澡/上课/练琴时**她自己**不写。
 * 我们原来只有"用户可打扰时段"这一个维度 ⇒ 缺的正是写信人自己的状态。
 * 这一条直接决定"像不像一个人在写信"。
 */
export const HER_BUSY = Object.freeze({
  sleeping: "她在睡觉",
  bathing: "她在洗澡",
  class: "她在上课",
  practice: "她在练琴",
  errand: "她在外面办事",
  housework: "她在忙家务",
});

/**
 * (2) 未回复是**递增后衰减**，不是永久锁。
 * 竞品原文："The pressure decays with time and does not permanently lock initiative."
 * 我们原来写成「上一封主动信没读 ⇒ 永不发下一封」= 永久锁，对方忙一周就再也不会收到信。
 * 做法：连续没回，等待指数拉长（1.45 倍），但**有 7 天上限**，之后还能恢复。
 */
export const UNANSWERED_BASE = 1.45;
export const UNANSWERED_CAP_HOURS = 168;      // 7 天

export function unansweredWaitHours(unread, baseGapHours) {
  const n = Math.max(0, Math.floor(Number(unread) || 0));
  // 只 1 封没回不算"冷" —— 竞品 committed 档的原话：
  // "One unanswered everyday message does not imply hours of unavailability."
  if (n <= 1) return 0;
  const base = Math.max(Number(baseGapHours) || 0, 4);
  return Math.min(base * Math.pow(UNANSWERED_BASE, n - 2), UNANSWERED_CAP_HOURS);
}

/**
 * (3) 间隔 = **这段关系自己的节奏**，不是强加一个时钟。
 * 竞品 `_usual_user_gap`：取最近 9 次用户主动来信间隔的中位数。
 * 我们原来写死 20 小时 ⇒ 对每天写信的人是 20 小时，对一周写一次的人也是 20 小时，
 * 后者会被"定时轰炸"。
 */
export function medianGapHours(gaps) {
  const list = (Array.isArray(gaps) ? gaps : [])
    .map(Number)
    .filter((g) => Number.isFinite(g) && g >= 0.5 && g <= 168);   // 只留 30 分钟 ~ 7 天
  if (!list.length) return null;
  list.sort((a, b) => a - b);
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** 关系中位间隔 → 实际采用的最小间隔（有样本才用，没样本退回用户填的）。 */
export function effectiveGapHours(settings, usualGap) {
  const s = normalizeSettings(settings);
  const u = medianGapHours(usualGap === undefined ? null : [usualGap]);
  if (u === null) return s.minGapHours;
  return Math.min(Math.max(u * 0.9, 1), 720);
}

/**
 * (4) 离线过久不补发，只给一次带抖动的机会。
 * 竞品：到期了不立刻发，先推迟 1–5 分钟 —— "Expired appointments are not accumulated
 * offline mail."。我们原来一开程序就发（minGapHours 早满足了）。
 * "一开程序就收到信"是打扰，不是惊喜。
 * ★ 可测：抖动由 seed 决定，不直接调 Math.random。
 */
export function offlineGraceSeconds(seed) {
  const n = Number(seed);
  const v = Number.isFinite(n) ? Math.abs(Math.floor(n)) : 0;
  return 60 + (v % 241);                       // 60 ~ 300 秒
}

/**
 * (5) 每个"不发"的原因都有名字，并被记录。
 * 竞品 `_reason()` 返回枚举 + Observer ⇒ 能统计"为什么没发"，也能在设置页给人看一句人话
 * （"她这会儿在睡觉"比"不在可打扰窗口"好得多）。我们原来只返回一个中文字符串。
 */
export const PROACTIVE_REASONS = Object.freeze({
  DISABLED: "disabled",
  BAD_WINDOW: "bad_window",
  OUT_OF_HOURS: "out_of_hours",
  HER_BUSY: "her_busy",
  BUSY: "sending_uncertain",
  UNANSWERED_WAIT: "unanswered_wait",
  NO_EXCHANGE: "no_target",
  GAP: "wait_user",
  DAY_LIMIT: "attempt_limit",
  WEEK_LIMIT: "attempt_limit",
  OFFLINE_GRACE: "restore_delay",
  WEAK_TRIGGER: "reason_floor",
  READY: "ready",
});

/** 由头的"质量下限"：竞品的 reason_floor —— 由头不只是"有来源"，还得**够格**。
 *  ★ 后面四种是我们自己加的（见下面"借鉴多家 + 自己的创新"），权重给高：
 *    它们都要**先有事实**才成立，比"这是一个平常的晚上"硬得多。 */
export const TRIGGER_WEIGHT = Object.freeze({
  open_loop: 4,                       // 她问过的事还没有回音 ⇒ 最该补的一句
  reunion: 3,                         // 久别重聚（我们自己的口径，不是竞品的 quiet_days）
  song_played: 3, library_finding: 3, quiet_days: 3,
  first_open_today: 2,
  // ★ 音乐锚点**只能给 1 档**：它和"这是一个平常的晚上"是同一类东西 ——
  //   不是"发生了一件事"，只是"此刻是这个时候"。
  //   给到 2 档就会让关系还浅的用户也收到"此刻是夜里那一档"这种没有由头的信
  //   （全量测试里那两条 reason_floor 的断言就是被它顶掉的）。
  music_anchor: 1, time_of_day: 1,
});
// 往来少于这么多封时，关系还浅 ⇒ 拒掉"平常的晚上"这类空洞寒暄（竞品 reserved 档明令禁止）
export const SHALLOW_UNTIL = 8;

/**
 * 主动来信机会判定。
 *
 * ctx 是调用方查好的一组事实（不在这里查库，为了可测）：
 *   { nowMinutes, nowSeconds, unreadProactive, busyCount, exchangedCount,
 *     lastCreatedAt, lastProactiveAt, proactive24h, proactive7d,
 *     herActivity, usualGapHours, secondsSinceLaunch, seed,
 *     songTitle, libraryFinding, firstOpenToday }
 *
 * 返回 { ok, code, reason, trigger, waitHours }。任一条不满足即不发 —— 宁可不发，不要打扰。
 */
export function evaluateProactive(settings, ctx = {}) {
  const s = normalizeSettings(settings);
  const no = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

  if (!s.enabled) return no(PROACTIVE_REASONS.DISABLED, "主动来信已关闭，可以在设置里打开");

  // ★ 时段填错时必须拒绝，不能静默回退成默认值：
  //   用户设了 20:00–21:00，写错一个字符就悄悄变回 09:00–21:30 ⇒ 她在不受控的时段写信。
  if (s.invalid.length > 0) {
    return no(PROACTIVE_REASONS.BAD_WINDOW, `可打扰时段格式不对（${s.invalid.join("、")}），已停止主动来信`);
  }

  const start = clockToMinutes(s.windowStart);
  const end = clockToMinutes(s.windowEnd);
  if (start === null || end === null) return no(PROACTIVE_REASONS.BAD_WINDOW, "可打扰时段格式不对");
  const minutes = Number(ctx.nowMinutes);
  if (!Number.isFinite(minutes) || minutes < start || minutes > end) {
    return no(PROACTIVE_REASONS.OUT_OF_HOURS, `不在可打扰窗口（${s.windowStart}–${s.windowEnd}）`);
  }

  // ★ 她自己的状态。放在用户窗口之后：两边都舒服才算数。
  const act = String(ctx.herActivity ?? "").trim();
  if (act && Object.prototype.hasOwnProperty.call(HER_BUSY, act)) {
    return no(PROACTIVE_REASONS.HER_BUSY, `${HER_BUSY[act]}，这会儿不会有信寄出`);
  }

  if ((ctx.busyCount ?? 0) > 0) return no(PROACTIVE_REASONS.BUSY, "还有信在生成中");
  if ((ctx.exchangedCount ?? 0) < 1) return no(PROACTIVE_REASONS.NO_EXCHANGE, "还没有任何往来，林离无从下笔");

  const ts = Number(ctx.nowSeconds);
  const last = Number(ctx.lastCreatedAt);
  const lastPro = Number(ctx.lastProactiveAt);
  const gapHours = (Number.isFinite(ts) && Number.isFinite(last)) ? (ts - last) / 3600 : null;

  // ① 未回复：**递增后衰减**，不再是永久锁
  const unread = Math.max(0, Math.floor(Number(ctx.unreadProactive) || 0));
  if (unread >= 2) {
    const need = unansweredWaitHours(unread, s.minGapHours);
    const since = (Number.isFinite(ts) && Number.isFinite(lastPro)) ? (ts - lastPro) / 3600 : null;
    if (since === null || since < need) {
      return no(PROACTIVE_REASONS.UNANSWERED_WAIT,
        `还有 ${unread} 封没读，先等等（要满 ${need.toFixed(1)} 小时）`, { waitHours: need });
    }
  }

  // ② 最小间隔：**这段关系自己的节奏**，有样本才用
  const minGap = effectiveGapHours(s, ctx.usualGapHours);
  if (gapHours !== null && minGap > 0 && gapHours < minGap) {
    return no(PROACTIVE_REASONS.GAP, `距上一封仅 ${gapHours.toFixed(1)} 小时，未达 ${minGap.toFixed(1)} 小时`);
  }

  // ③ 刚刚打开程序：不立刻发（离线过久不补发）
  const up = Number(ctx.secondsSinceLaunch);
  if (Number.isFinite(up) && Number.isFinite(last) && Number.isFinite(ts)) {
    const quiet = (ts - last) / 3600;
    if (quiet >= 24) {                          // 隔了一天以上才算"离线过久"
      const grace = offlineGraceSeconds(ctx.seed ?? 0);
      if (up < grace) {
        return no(PROACTIVE_REASONS.OFFLINE_GRACE,
          `刚打开，先等 ${Math.ceil((grace - up) / 60)} 分钟 —— 隔了这么久不该一开程序就收到信`);
      }
    }
  }

  if ((ctx.proactive24h ?? 0) >= s.maxPerDay) {
    return no(PROACTIVE_REASONS.DAY_LIMIT, `24 小时内已发 ${ctx.proactive24h} 封，达上限 ${s.maxPerDay}`);
  }
  if ((ctx.proactive7d ?? 0) >= s.maxPerWeek) {
    return no(PROACTIVE_REASONS.WEEK_LIMIT, `7 天内已发 ${ctx.proactive7d} 封，达上限 ${s.maxPerWeek}`);
  }

  // ④ 由头有"质量下限"：关系还浅时，拒掉"平常的晚上"这种空洞由头
  const trigger = pickTrigger(ctx, ts, last);
  const shallow = (ctx.exchangedCount ?? 0) < SHALLOW_UNTIL;
  if (shallow && (TRIGGER_WEIGHT[trigger?.kind] ?? 0) < 2) {
    return no(PROACTIVE_REASONS.WEAK_TRIGGER,
      "这会儿没有一件值得写信的事 —— 宁可不写，也不写一句空洞的寒暄");
  }

  return { ok: true, code: PROACTIVE_REASONS.READY, reason: "可以写", trigger };
}

// ================================================================ 借鉴多家 + 自己的创新
//
// ★ 借鉴的是**思路**，不是代码，也不是它们的参数：
//   · Conscious Pebble —— Open Loop：没闭环的话题她会自己找回来说一句（她惦记着）
//   · Ackem 的 Time 系统 —— 时间感知 / 昼夜节律 / **重聚** / 反思
//   · astrbot 拟人插件 —— 每天的生活日程、重要日期、日记、**低频**主动消息
//   · Tanya —— 分层记忆 + 夜里把当天压成一条"值得记住的"
//   · Stanford Generative Agents —— 记忆要打分、会反思（reflection）
//   · 竞品 —— 她的作息闸门 / 未回复递增后衰减 / 由头质量下限
// ★ 上面各家都没有、属于这个程序的四条：
//   ① **音乐锚点**：触发时按《原游戏口径》取此刻该播的那一档 ⇒ 她的信总是从"我在听什么"下笔。
//      这是把"播放逻辑"和"写信"接上了 —— 它们本来就是同一个人的两个侧面。
//   ② **重聚的口径**：久别之后第一句不是"你怎么这么久才来"（这是把人推开），
//      而是"你不在的这几天，我这边发生了什么" ⇒ 先交待自己，再等对方。取其数据库和方法，避急躁。
//   ③ **又及（P.S.）**：手写信特有的二次投递 —— 信已经封口寄出了，她过一阵还能回来补一句。
//      即时通信的产品没有这个形态；它是"信"才有的。
//   ④ **反思档案是本地确定性算的**：不为了写封信再调一次模型，
//      统计由 herself 在信里提过的曲名/话题得出 ⇒ 既不花钱，也不把用户的信送去别处加工
//      （"用户数据绝不上传"这条红线不能因为加功能就破了）。

/** ① 音乐锚点。《原游戏口径》：06:00–16:00 → TOD12，16:00–20:00 → TOD1730，20:00–06:00 → TOD20。
 *  ★ 这一条必须和播放逻辑同源 —— 她说"我在听的"，就是程序此刻真的会播的那一档。 */
export const MUSIC_SLOTS = Object.freeze([
  { slot: "TOD12", from: 6 * 60, to: 16 * 60, label: "白天的那一档" },
  { slot: "TOD1730", from: 16 * 60, to: 20 * 60, label: "傍晚那一档" },
  { slot: "TOD20", from: 20 * 60, to: 24 * 60, label: "夜里那一档" },
]);

export function musicAnchor(nowMinutes) {
  const m = Number(nowMinutes);
  if (!Number.isFinite(m)) return null;
  const v = ((m % 1440) + 1440) % 1440;
  // 00:00–06:00 归到"夜里那一档"（TOD20 是跨零点的一整段，不能按数值大小比）
  if (v < 6 * 60) return MUSIC_SLOTS[2];
  if (v < 16 * 60) return MUSIC_SLOTS[0];
  if (v < 20 * 60) return MUSIC_SLOTS[1];
  return MUSIC_SLOTS[2];
}

/** ② 未闭环：她最近问过、但一直没有回音的那句话。
 *  ★ 只从**她写过的信**里找最后一句带问号的；用户之后如果又来信了，就不算悬着。
 *  ★★ 这里是纯文本的确定性抽取 —— 不再额外调一次模型去"理解"，理由同 ④。 */
export function openLoop(letters = [], nowSeconds, minAgeHours = 20) {
  const list = Array.isArray(letters) ? letters : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const L = list[i] || {};
    if (L.from === "user") break;                     // 用户之后还说过话 ⇒ 不算悬着
    const body = String(L.body ?? "");
    const q = body.search(/[?？]/);
    if (q < 0) continue;
    // 取最后一个问号所在的那一句（中文句号/换行分句），并在此截断
    const head = body.slice(0, q + 1);
    const parts = head.split(/(?<=[。！？!?])\s*|\n+/).filter(Boolean);
    const sentence = String(parts[parts.length - 1] ?? "").trim();
    if (!sentence) continue;
    const ageHours = Number.isFinite(Number(L.at)) && Number.isFinite(nowSeconds)
      ? (Number(nowSeconds) - Number(L.at)) / 3600 : null;
    if (ageHours !== null && ageHours < minAgeHours) return null;   // 刚问完就追问，太急
    return { sentence, ageHours, letterId: L.id ?? null };
  }
  return null;
}

/** ③ 重聚口径。区别于竞品的 quiet_days：那句是"你们已经 N 天没有往来了"——
 *  把天数摆在对方面前，像在记账。我们改成她先交待自己。 */
export const REUNION_AFTER_DAYS = 3;

export function reunionTone(daysAway, anchorLabel = "那一档歌") {
  const d = Math.max(0, Math.floor(Number(daysAway) || 0));
  return {
    days: d,
    text: `你已经 ${d} 天没有打开了。这 ${d} 天我把${anchorLabel}又从头听了一遍，` +
          `想起几件想跟你说的 —— 不着急回，我只是想让你知道这边的样子。`,
  };
}

/** ④ 又及（P.S.）：信寄出一段时间后，她还能回来补一句。
 *  ★ 必须满足两个"不像打扰"的条件：① 至少过了 minHours；② 用户**还没回**（回了就不需要补）。
 *  ★ 超出 maxHours 就不再补 —— 隔了一周才想起来补一句，那是尴尬，不是记挂。 */
export function psWindow({ sentAtSeconds, answeredAtSeconds, nowSeconds,
                           minHours = 6, maxHours = 72 } = {}) {
  const now = Number(nowSeconds);
  const sent = Number(sentAtSeconds);
  if (!Number.isFinite(now) || !Number.isFinite(sent)) return { ok: false, reason: "没有可用的时间戳" };
  const hours = (now - sent) / 3600;
  if (hours < 0) return { ok: false, reason: "将来的一封信" };
  if (Number.isFinite(Number(answeredAtSeconds))) return { ok: false, reason: "你已经回信了，不用再补" };
  if (hours < minHours) return { ok: false, hours, reason: `才过去 ${hours.toFixed(1)} 小时，还没到想起话要说的时候` };
  if (hours > maxHours) return { ok: false, hours, reason: `已经是 ${(hours / 24).toFixed(1)} 天前的事了，再补一句只会显得刻意` };
  return { ok: true, hours };
}

/**
 * ⑥ 第一次打开时问一句：主动来信这件事，就这样好不好。
 *
 * ★★ 用户 2026-10-14 定：主动来信**默认开启**（10-13 定的，有测试钉着），
 *   所以这个弹窗问的**不是**"要不要打开" —— 它本来就开着。它问的是
 *   「确认 / 关掉」：告知一次她会在什么时候写信、有多克制，顺便给一次反悔的机会。
 *
 * ★★ 判据只剩一条：**答没答过**。
 *    - 开着也要问，关着也要问 —— 只有"答过"才不问。
 *      （★ 这里踩过坑：早先版本写了 `if (enabled) return {shouldAsk:false}`，
 *        而默认值恰好是 enabled=true ⇒ 全新用户永远看不到这个弹窗，
 *        整个功能一上线就是死的。单测测不出来：单测只喂 {asked,enabled} 组合，
 *        没人去问"默认值到底是什么"。⇒ 端到端跑一遍就露馅了。）
 *    - 点"先不用"、按 Esc、点遮罩 —— 全都算答过（asked=true），不再天天问。
 *
 * @returns {{shouldAsk:boolean, reason?:string}}
 */
export function proactiveIntro({ asked = false } = {}) {
  if (asked) return { shouldAsk: false, reason: "已经问过一次了，不再打扰" };
  return { shouldAsk: true };
}

/** ★ 默认开启 ⇒ 明确的"愿意"⇒ 保持开启；其它一切答案 ⇒ 关掉。不管答什么，asked 都置 true（只问一次）。 */
export function answerProactiveIntro(answer) {
  const yes = answer === "yes";
  return { enabled: yes, asked: true };
}

/** ⑤ 反思档案：把来往压成"她记住的几件事"。本地确定性算，不额外调模型。
 *  返回 { songs: [], unresolvedDays, line } —— line 是直接可以进提示词的一句话。 */
export function reflectLetters(letters = [], top = 3) {
  const list = Array.isArray(letters) ? letters : [];
  const counts = new Map();
  for (const L of list) {
    for (const m of String(L.body ?? "").matchAll(/《([^》]{1,40})》/g)) {
      const k = m[1].trim();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const songs = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([t]) => t);
  const last = list.length ? Number(list[list.length - 1].at) : null;
  const line = songs.length
    ? `她反复提过的歌：${songs.map((s) => `《${s}》`).join("、")} —— 这是她记得的事，写信时应当用得上。`
    : "";
  return { songs, lastAt: Number.isFinite(last) ? last : null, line };
}

/** 由头只认程序这侧能观测到的真实事件，绝不来信人的发言。
 *  ★ 优先级里前两条是我们自己的：她惦记着的 ＞ 久别重聚 ＞ 刚发生的事 ＞ 泛泛的时刻。 */
export function pickTrigger(ctx = {}, ts, last) {
  // ★ 顺序是有讲究的：**"你此刻在做什么" ＞ "她惦记着的" ＞ "我们多久没见了"**。
  //   把"久别"排在"刚听完一首歌"前面是不对的 —— 人都坐在面前弹完了，
  //   她却先说"你已经三天没打开了"，那是在翻旧账，不是写信。
  if (ctx.songTitle) return { kind: "song_played", text: `你刚刚听完《${ctx.songTitle}》。` };
  if (ctx.libraryFinding) return { kind: "library_finding", text: `整理时发现：${ctx.libraryFinding}` };

  const letters = Array.isArray(ctx.herLetters) ? ctx.herLetters : [];
  const loop = openLoop(letters, ts);
  if (loop) return { kind: "open_loop", text: `你还欠她一个回音：${loop.sentence}`, loop };

  if (Number.isFinite(ts) && Number.isFinite(last)) {
    const days = Math.floor((ts - last) / 86400);
    if (days >= REUNION_AFTER_DAYS) {
      const anchor = musicAnchor(Number.isFinite(ctx.nowMinutes) ? ctx.nowMinutes : 720);
      return { kind: "reunion", text: reunionTone(days, anchor?.label).text, days };
    }
  }

  // ★ 音乐锚点放在"泛泛的时刻"之前：即使这一刻没有别的由头，
  //   "她正在听这一档里的歌"也比"这是一个平常的晚上"更像一件真事。
  if (Number.isFinite(ctx.nowMinutes)) {
    const a = musicAnchor(ctx.nowMinutes);
    if (a) return { kind: "music_anchor", text: `此刻是${a.label}（${a.slot}），她正在听这一档里的歌。` };
  }

  if (Number.isFinite(ts) && Number.isFinite(last)) {
    const days = Math.floor((ts - last) / 86400);
    if (days >= 2) return { kind: "quiet_days", text: `你们已经有 ${days} 天没有往来了。` };
  }
  if (ctx.firstOpenToday) return { kind: "first_open_today", text: "你今天第一次打开程序。" };
  const hour = Number.isFinite(ctx.nowMinutes) ? Math.floor(ctx.nowMinutes / 60) : 12;
  return { kind: "time_of_day", text: `这是一个平常的${hour < 12 ? "早上" : hour < 18 ? "下午" : "晚上"}。` };
}

/** 由头代号 → **给人看**的说法。
 *  ★★ 界面绝不能直接显示 `kind`。原来的设置页写的是
 *     `现在可以写（${'${'}trigger.kind}）` ⇒ 用户会看到「现在可以写（song_played）」——
 *     内部代号漏到界面上了。这类东西静态看不出来（字符串都在），
 *     只有把界面渲染出来、逐字读一遍才会发现。 */
export const TRIGGER_LABELS = Object.freeze({
  song_played: "刚听完一首歌",
  library_finding: "整理曲库时有发现",
  open_loop: "你还没回她上一封的问话",
  reunion: "你们有阵子没见了",
  music_anchor: "这会儿是她常听歌的时段",
  quiet_days: "好几天没打开",
  first_open_today: "今天第一次打开",
  time_of_day: "一个平常的时段",
});

/** 未知代号也要给中文 —— 宁可含糊，也不能把 `some_new_code` 原样吐给用户。 */
export function triggerLabel(kind) {
  return TRIGGER_LABELS[kind] ?? "她惦记着一件小事";
}

/**
 * (6) 生成之前先"消耗掉"这次机会 —— 竞品 `reserve()`：
 *   "Durably consume this opportunity before generation, without changing eligibility."
 * 我们是**生成完才落库**；生成过程中崩了/被关 ⇒ 会重新生成一次 ⇒ 可能重复发。
 * 返回新的 due（秒）。调用方必须**在生成之前**落盘。
 */
export function reserveDue(nowSeconds, minGapHours, jitterSeed = 0) {
  const now = Number(nowSeconds);
  if (!Number.isFinite(now)) return null;
  const base = Math.max(Number(minGapHours) || 0, 0) * 3600;
  return now + base * (0.9 + (Math.abs(Math.floor(Number(jitterSeed) || 0)) % 21) / 100);
}

/**
 * (7) 回信的**降级路径** —— 竞品 `_without_unsupported_facts`：
 *   找出被判为伪造事实的**句子**，只删那些句子，其余保留。
 * ★ 主动信仍然"踩线即整封不落库"，这条只给**回信**：删完要重跑一次自检，
 *   并且**全局最多重写一次**（竞品也是这样，防止越改越不像人写的）。
 */
export function withoutSentences(text, spans) {
  // ★ 2026-10-16 修（与原版互查 F2）：以前这里**不 trim**，而调用方 `inspectReplyDegraded:464`
  //   比较时**trim 了** ⇒ 若 spans 是按 trimmed 文本算的，删除会落在首尾空白上（删了空白、
  //   没删句子），随后判等成立 ⇒ 静默返回「降级失败」：不抛错、不告警。
  //   ⇒ 进函数第一件事统一坐标系：**一律相对 trimmed 文本**。
  const body = String(text ?? "").trim();
  const list = (Array.isArray(spans) ? spans : [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => b.start - a.start);            // 从后往前删，前面的下标才不会被挪动
  let out = body;
  for (const s of list) out = out.slice(0, s.start) + out.slice(s.end);
  return out.replace(/\n{3,}/gu, "\n\n").trim();
}

/** 回信降级：删掉被判定的句子后重检一次。通过就发，并标记 degraded。 */
export function inspectReplyDegraded(text, spans) {
  const first = inspectReply(text);
  if (first.ok) return { ...first, degraded: false };
  const cut = withoutSentences(text, spans);
  if (!cut || cut === String(text ?? "").trim()) return { ok: false, reason: first.reason, degraded: false };
  const again = inspectReply(cut);
  return again.ok
    ? { ...again, degraded: true }
    : { ok: false, reason: again.reason, degraded: false };
}

/**
 * 主动信设置**落盘前**的整批校验（2026-10-16，规范 §9.2）。
 *
 * 为什么要有这道：原版 `POST /toy/letter/proactive` 的缺陷是「先落盘、后校验」⇒
 * 其余设置非法时开关已经被改掉（界面表现为「保存失败，但那个勾选框变了」）。
 * 本程序的形态其实**更松** —— 原来压根没有校验，是**逐键 setSetting 直接写**：
 *   `windowStart: "99:99"`、`minGapHours: -5` 这类值会原样进库，而且中途任一键抛错时
 *   前面已经写进去的键不会回滚。
 *
 * ⇒ 修法是**顺序**：先整批校验，全部合法才落盘（一个都不写）。落盘那一行不在这里。
 *
 * ★ 只做「类型 / 格式 / 范围」，**不新增产品约束** —— 例如 `maxPerWeek: 0`（等于关掉主动来信）
 *   是用户的合法意图，这里不拦。拦的是脏值：NaN、负数、非整数、`"99:99"`、字符串冒充布尔。
 */
// ★ 2026-10-17 修（审核）：开关的布尔判据**只此一份**，校验层与落库层共用。
//   原来 server.mjs 落库时另写了一份 `value ? "1" : "0"`，而字符串 "0" 是**非空**
//   ⇒ 真值 ⇒ 写成 "1" ⇒ `{enabled:"0"}`（校验层明确放行）被写成"开"。
//   两处判据一旦漂移，就会变成"校验说合法、落库是反的"。
//   ★ 只认布尔与 1/0（含 "1"/"0" 字符串，trim 后比）；"abc"、"2"、"" 一律不算真。
export function proactiveBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v).trim();
  if (s === "1") return true;
  if (s === "0") return false;
  return undefined; // 不是合法的布尔写法 ⇒ 交给校验层报错，不要猜
}

export function validateProactivePatch(patch) {
  const errors = [];
  const p = patch ?? {};
  const has = (k) => p[k] !== undefined && p[k] !== null;

  // 时间窗：HH:MM，且必须是一天里真实存在的时刻
  for (const k of ["windowStart", "windowEnd"]) {
    if (!has(k)) continue;
    if (clockToMinutes(p[k]) === null) errors.push(`${k} 不是 HH:MM（实际 ${JSON.stringify(p[k])}）`);
  }
  // 数值：非负有限整数
  for (const k of ["minGapHours", "maxPerDay", "maxPerWeek", "checkIntervalMinutes"]) {
    if (!has(k)) continue;
    const n = Number(p[k]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      errors.push(`${k} 必须是非负整数（实际 ${JSON.stringify(p[k])}）`);
    }
  }
  // 开关：只认布尔与 "1"/"0"/1/0；字符串 "abc" 这类一律拒（它会被 truthy 当成 true）
  for (const k of ["enabled", "asked", "keepCurrentShape"]) {
    if (!has(k)) continue;
    const v = p[k];
    if (proactiveBool(v) === undefined) errors.push(`${k} 必须是布尔或 1/0（实际 ${JSON.stringify(v)}）`);
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeSettings(raw) {
  // ★ 2026-10-17 修（审核）：**幂等短路**。
  //   evaluateProactive()（core.mjs:157）会拿传进来的 settings 再走一遍本函数，
  //   并用**重算出来的** invalid 决定是否拦（core.mjs:164）。而生产路径
  //   server.mjs:559-570 的 proactiveSettings() 传进来的**已经是归一化过的对象**
  //   ⇒ windowStart 早已被替换成合法的 "09:00" ⇒ 第二遍重算的 invalid 必然是 []
  //   ⇒ BAD_WINDOW 护栏永不触发。
  //   实测：用户填 "99:99"，传原始 DB 行 ⇒ bad_window（拦截）；传归一化对象 ⇒
  //   不再是 bad_window，且 99:99 被静默改成 09:00–21:30 —— 正是本护栏要防的
  //   「写错一个字符就悄悄变回默认 ⇒ 她在不受控的时段写信」，结果自己 fail-open。
  //   ★ invalid 是唯一能证明「这一轮真的校验过」的痕迹，见到它就说明已归一化，
  //     直接透传，别再抹一遍。
  if (raw && Array.isArray(raw.invalid)) return raw;
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(raw?.[v]);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const provided = (k) => raw?.[k] !== undefined && raw?.[k] !== null && String(raw[k]).trim() !== "";
  const invalid = [];
  // 「没填」用默认值；「填了但填错」记进 invalid，由上层的机会判定拒绝。
  if (provided("windowStart") && clockToMinutes(raw.windowStart) === null) invalid.push("windowStart");
  if (provided("windowEnd") && clockToMinutes(raw.windowEnd) === null) invalid.push("windowEnd");
  return {
    enabled: raw?.enabled === true || raw?.enabled === 1 || raw?.enabled === "1",
    windowStart: clockToMinutes(raw?.windowStart) === null ? PROACTIVE_DEFAULTS.windowStart : String(raw.windowStart),
    windowEnd: clockToMinutes(raw?.windowEnd) === null ? PROACTIVE_DEFAULTS.windowEnd : String(raw.windowEnd),
    minGapHours: clamp("minGapHours", 0, 720, PROACTIVE_DEFAULTS.minGapHours),
    // ★ 2026-10-15 修（审核）：这两个**下限必须是 1，不能是 0**。
    //   判据是 `已发 >= 上限`，上限为 0 时恒真 ⇒ 主动来信被静默永久关停，
    //   界面上还会写成「7 天内已发 0 封，达上限 0」，看着像正常配置。
    //   想要"不发"请走 enabled=false，那才是表达这个意思的地方。
    maxPerDay: clamp("maxPerDay", 1, 10, PROACTIVE_DEFAULTS.maxPerDay),
    maxPerWeek: clamp("maxPerWeek", 1, 30, PROACTIVE_DEFAULTS.maxPerWeek),
    invalid,
  };
}

// ------------------------------------------------------------------ 自检
//
// ★ 2026-10-16（行为参数统一）：下面这批阈值**不再是本文件里的数字**。
//   唯一真源是随包下发的 `app/harness/行为参数.json`（上游维护、随清单推送）。
//   改口径请改那份 JSON，两边同时生效；本文件**不留任何回退用的硬编码副本**
//   （留了就是第二份真源，两边漂移正是从"为了不崩先给个默认值"开始的）。
//   `tests/core.test.js` 有一条反向断言钉住这件事：本文件不许再出现「字段名 + 数字字面量」的写法。

const FORBIDDEN_REPLY = replyLimits().forbiddenWords;

const FORBIDDEN_PROACTIVE = [
  ...FORBIDDEN_REPLY,
  ...proactiveLimits().extraForbiddenWords,
];

function baseInspect(text, { forbidden, maxChars, minChars, minCharsWhenMultiParagraph, maxParagraphs, maxAsciiRun }) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, reason: "空正文" };
  for (const word of forbidden) {
    if (body.includes(word)) return { ok: false, reason: `正文出现禁词：${word}` };
  }
  const cjk = (body.match(/[一-龥]/g) ?? []).length;
  if (cjk > maxChars) return { ok: false, reason: `正文 ${cjk} 字，超过 ${maxChars} 字` };
  const paragraphs = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  // ★ P2 双条件（真源 `proactive.minCharsRule`，2026-10-16 用户拍板）：
  //   单段须 ≥ minChars（12）；多段只须 ≥ minCharsWhenMultiParagraph（1）。
  //   ⇒ 一句 12 字的合法主动信放行，「在吗」这种真碎片照拦。
  //   ⚠️ 只读 minChars 会把「短到一句也可以」的合法信拒掉 —— 那正是 C1 记的问题。
  const floor = paragraphs.length >= 2 ? (minCharsWhenMultiParagraph ?? minChars) : minChars;
  if (cjk < floor) return { ok: false, reason: `正文仅 ${cjk} 字，过短` };
  if (paragraphs.length > maxParagraphs) return { ok: false, reason: `正文 ${paragraphs.length} 段，超过 ${maxParagraphs} 段` };
  const run = body.match(/[A-Za-z]+/g)?.sort((a, b) => b.length - a.length)[0] ?? "";
  if (run.length > maxAsciiRun) return { ok: false, reason: "正文出现英文长串" };
  return { ok: true, body, paragraphs };
}

export function inspectReply(text) {
  const R = replyLimits();
  const r = baseInspect(text, {
    forbidden: FORBIDDEN_REPLY,
    maxChars: R.maxChars,
    minChars: R.minChars,
    maxParagraphs: R.maxParagraphs,
    maxAsciiRun: R.maxAsciiRun,
  });
  if (!r.ok) return r;
  if (R.namePrefix.test(r.body)) return { ok: false, reason: "正文带了角色名前缀" };
  return r;
}

export function inspectProactive(text) {
  const P = proactiveLimits();
  return baseInspect(text, {
    forbidden: FORBIDDEN_PROACTIVE,
    maxChars: P.maxChars,
    minChars: P.minChars,
    minCharsWhenMultiParagraph: P.minCharsWhenMultiParagraph,
    maxParagraphs: P.maxParagraphs,
    maxAsciiRun: P.maxAsciiRun,
  });
}

// ------------------------------------------------------------------ 近况层（T9）
//
// ★ 2026-10-16（近况层接线）：近况层档位判定。真源 = `行为参数.json` 的 `nearTerm`
//   （原版 §4.22 ⑤ 给了可执行判定式，封锁解除）。本函数是**纯函数**：
//   输入「信件数 / 用户开关 / 历史最高档 / 关系」，输出档位号（-1 = 不注入）。
//
// 判定顺序（与真源 §4.22 ⑤ 的 5 步逐条对应）：
//   1. `nearTerm.enabled !== true`                ⇒ -1
//   2. 用户开关（`keep-current-shape === "1"`）    ⇒ -1
//   3. 按信件数落档 0–3 ⇒ 0 / 4–20 ⇒ 1 / 21–60 ⇒ 2 / 61+ ⇒ 3
//   4. 命中「不注入」的档（inject=false，即第 0 档）⇒ -1（★ 传 -1，不是传第 0 档的文本）
//   5. 与历史最高档取较高者（allowRollback=false ⇒ 不回退）
//
// ⚠️ 关系覆盖（tierOverride：账本「关系」≥ 密友 ⇒ 第 3 档）由调用方在**查询里**解析后
//   作为 `relationshipTier` 传入；本函数只负责与信件数取较高者，不自己去解析账本。
//
// ── 近况层档位的计数口径 ────────────────────────────────────────────────
// 真源 `行为参数.json` 的 `tierDataSource`（2026-10-16 版）逐字写的是：
//   「只算『用户自己写的、且已经回过信』的那些
//     （`WHERE person = ? AND source <> 'proactive' AND status = 4(REPLIED)`）：
//     排除主动信（她自己写来的信不该推高『往来多久』的档位）；
//     排除在途信（生成回信时那封信已在表里，不排除会比已回信数提前 1 封）。」
//
// 本程序列名不同但语义一一对应：`person` 无（单人）· `source` ⇒ `origin`
// （NULL = 用户来信，'proactive' = 林离先写）· `status` ⇒ 同为 `status`。
//
// ⚠️ 两个会写错的地方（都是真踩过的）：
//   ① SQLite 里 `origin <> 'proactive'` 对 `origin IS NULL` 的行返回 **NULL**，
//      而 NULL **不入选** ⇒ 只写这一句会把「用户来信」全漏掉，档位永远停在 0。
//      必须显式带上 `origin IS NULL OR`。
//   ② 这里**必须**带 `status = 4`：不带就把在途信（1/3）和失败信（5）算进「往来多久」。
export const TIER_COUNT_SQL =
  "SELECT COUNT(*) value FROM letters WHERE (origin IS NULL OR origin <> 'proactive') AND status = 4";

/** 档位计数认定的「已回信」状态值；须与 `app/server.mjs` 的 `STATUS.REPLIED` 同值（有测试守）。 */
export const TIER_COUNTED_STATUS = 4;

/**
 * 与 {@link TIER_COUNT_SQL} **同口径**的行级判定（纯函数，可单测）。
 * SQL 与这个函数是同一条规则的两处表达 —— 任一侧改了另一侧没跟上，
 * `tests/tier-count.test.js` 里那条「两边对同一批行必须同结果」会红。
 * @param {{origin?:string|null, status?:number}} row
 */
export function isTierCounted(row = {}) {
  const proactive = row.origin != null && String(row.origin) === "proactive";
  return !proactive && Number(row.status) === TIER_COUNTED_STATUS;
}

/**
 * @param {{letters:number, toggleValue?:string|boolean, maxTier?:number, relationshipTier?:number}} ctx
 * @param {object} [limits] 注入真源口径（**仅测试用**）。缺省则读 `行为参数.json`。
 *   为什么留这个口：真源 `nearTerm.enabled` 当前恒为 `true`，若不注入就无法测「总闸关闭」那条分支
 *   ⇒ 那条分支会变成「写了但永远不走」的摆设（变异会报「仍绿」）。注入口让每条分支都能被打红。
 * @returns {number} 档位号；-1 表示「不注入近况层」
 */
export function resolveDriftTier(ctx = {}, limits = null) {
  const N = limits ?? nearTermLimits();
  // 步 1：开关总闸
  if (!N.enabled) return -1;
  // 步 2：用户开关（真源 key 由 JSON 给，值 "1" = 打开 = 停用近况层）
  const raw = ctx.toggleValue;
  const on = raw === true || raw === 1 || String(raw ?? "").trim() === "1";
  if (on) return -1;
  // 步 3：按信件数落档
  const letters = Number(ctx.letters);
  const count = Number.isFinite(letters) && letters > 0 ? Math.floor(letters) : 0;
  let tier = 0;
  for (const t of N.tiers) {
    if (count >= t.lettersFrom && (t.lettersTo === null || count <= t.lettersTo)) {
      tier = t.tier;
      break;
    }
  }
  // 步 3b：账本「关系」覆盖（与信件数取较高者）
  const rel = Number(ctx.relationshipTier);
  if (Number.isFinite(rel)) tier = Math.max(tier, Math.floor(rel));
  // 步 4：不回退 —— 与历史最高档取较高者。
  //   ⚠️ **必须在「第 0 档不注入」判定之前**做：关系推进过就不会生疏，
  //     删信件把 count 降回第 0 档时，历史最高档要把它兜回来，否则「不回退」等于没实现。
  if (!N.allowRollback) {
    const max = Number(ctx.maxTier);
    if (Number.isFinite(max)) tier = Math.max(tier, Math.floor(max));
  }
  // 步 5：命中「不注入」的档（第 0 档）⇒ -1（★ 传 -1，不是传第 0 档的文本）
  const hit = N.tiers.find((t) => t.tier === tier);
  if (!hit || hit.inject === false) return -1;
  return tier;
}

/**
 * 把 `近况.md` 拆成「档位 → 该档注入的文本」。
 * ★ 第 2 档起**累积**：档 2 = 第 1+2 档；档 3 = 第 1+2+3 档（真源 `近况.md` 顶部已写明）。
 * 返回的是数组，`tierAt(2)` = [第1档, 第2档] 拼接后的文本。
 * @param {string} markdown `近况.md` 全文
 * @returns {(tier:number)=>string} 传 -1 或 0 返回空串
 */
export function driftTextByTier(markdown) {
  const raw = String(markdown ?? "");
  // 按 `## 第 N 档` 切段（真源标题形如 `## 第 1 档 · 回应比重上升（4–20 封）`）。
  // ⚠️ 用行首锚点切，别用 lookahead + `$`（带 m 标志时 `\s*$` 会在换行处立即命中 ⇒ 每段都被切成空）。
  const lines = raw.split(/\r?\n/);
  const parts = [];
  let cur = null;
  const head = /^##\s*第\s*(\d+)\s*档/;
  for (const line of lines) {
    const m = head.exec(line);
    if (m) {
      if (cur) parts.push(cur);
      cur = { tier: Number(m[1]), buf: [] };
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  if (cur) parts.push(cur);
  const sections = parts.map((p) => ({ tier: p.tier, body: p.buf.join("\n").trim() })).filter((p) => p.body);
  return (tier) => {
    const n = Number(tier);
    if (!Number.isFinite(n) || n <= 0) return "";
    return sections
      .filter((p) => p.tier >= 1 && p.tier <= n)
      .sort((a, b) => a.tier - b.tier)
      .map((p) => p.body)
      .join("\n\n");
  };
}

// ------------------------------------------------------------------ 曲库变体
//
// 口径来自 OliviaSoul 旧项目的一手证据（不是猜的）：
//   midi/playback-clock.js —— 边界跟着原版桌面播放器的 localtime64：
//     06:00–16:00 → TOD12（白天）；16:00–20:00 → TOD1730（傍晚）；20:00–06:00 → TOD20（夜晚）。
//     ★ TOD1730 只是素材标签，傍晚实际从 16:00 开始，不是 17:30。
//   midi/library-importer.js:73 —— 文件名解析 TOD(1200|1730|2000)[_-](NI|WI)[_-](L|R)。
//   midi/song-metadata.js —— 编号归一：1200|12→TOD12，1730|17→TOD1730，2000|20→TOD20。
//   selectSongVariant —— 精确 tod+view → 同 tod 无 view → 同 tod → 兜底。

export const TIME_SLOTS = Object.freeze(["TOD12", "TOD1730", "TOD20"]);
export const TIME_SLOT_LABELS = Object.freeze({ TOD12: "白天", TOD1730: "傍晚", TOD20: "夜晚" });

// 曲库目录筛选口径。
// ★ 2026-10-13 用户指定过"只要 solo / playsing 开头的"；2026-10-14 要了「我的上传」这一档，
//   而那一档就是 midi_ / oliviasoul_ 那批（原版右栏里写的"个人上传 · mid_11565_…"也是它们）——
//   不加进来的话，这一档永远是空的，等于摆了个点不动的按钮。
//   放在这里而不是 server.mjs，是因为「哪些目录算曲目」是一条判据 —— 判据要能被变异打红。
export const LIBRARY_DIR_PATTERN = /^(?:solo|playsing|midi|oliviasoul)/iu;

/**
 * 目录名 → 曲名：去掉 _ziyun_original 这类来源尾巴，下划线还原成空格。
 * ★ 曲名长度上限（竞品 `local_song_library.py`：曲名 ≤120 字符）：
 *   我们原来没限，一个超长目录名会把曲目那一行撑破。夹到 120，超了给个省略号。
 */
export const SONG_NAME_MAX = 120;

export function prettySongName(dirName) {
  const name = String(dirName ?? "")
    .replace(/_?(?:ziyun|original)(?:[_-]?(?:ziyun|original))*/giu, "")
    .replace(/^[_-]+|[_-]+$/gu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return name.length > SONG_NAME_MAX ? name.slice(0, SONG_NAME_MAX - 1).trimEnd() + "…" : name;
}

// ---------------------------------------------------------------- 曲库分类
//
// ★ 用户口径（2026-10-14）：页签照原版分「古典 / ACG / 轻音乐 / 我的上传」，
//   但**不要用户自己去挑** —— 导入曲库时按目录名与曲名自动判，判完就摆好。
//
// ★★ 为什么下面对表而不是只写关键词：
//   用户 2026-10-14 把原版那四档**逐张截图**发过来校准（古典 7 张 / ACG 10 张 /
//   轻音乐 2 张）。把那些曲目和曲库里的目录名逐首对上之后，得到一个可复核的事实：
//       古典 48 + ACG 68 + 轻音乐 13 = 129，
//   而 129 正好就是 `<曲库目录>` 里 `Solo_` 98 + `PlaySing_` 31 的**全集**。
//   也就是说这套命名与原版四档是**一一对应**的 —— 分类不是猜，是查表。
//   （`midi_` / `oliviasoul_` 那 2455 个目录全是「我的上传」，见下。）
//
// ★ 表是**按目录名**写的，不按显示名：显示名会被 prettySongName 改掉，目录名不会。
//   前缀 `Solo_` / `PlaySing_` 与尾巴 `_Ziyun_original` 在 songKey() 里统一去掉。
//
// ★ 为什么放 core.mjs：这是一条**判据**（"这首算哪一类"），放这里才能被单测和变异打红。
export const GENRES = Object.freeze(["古典", "ACG", "轻音乐", "我的上传"]);

/** 播放方式（原版表头那一列「模式」）：独奏 / 弹唱 / 个人上传。
 *  ★ 原版写的是**弹唱**，不是"演唱"（2026-10-14 的截图里 20 多行都写着弹唱）——
 *    PlaySing 那批本来也是边弹边唱。照它的字。 */
export const SONG_MODES = Object.freeze({ solo: "独奏", sing: "弹唱", upload: "个人上传" });

/** 「古典」那一档：48 首（原版第 1–48 首）。 */
const CLASSICAL_KEYS = Object.freeze([
  "Air_On_The_G_String_From_Orchestral_Suite_No3_In_D_Major_BWV_1068",
  "Arabesque_No2",
  "Beethoven_Piano_Sonata_No8_In_C_Minor_Op13_2_Adagio_Cantabile",
  "Canon_In_D",
  "Chopin_Etude_Op10_No1", "Chopin_Etude_Op10_No12", "Chopin_Etude_Op10_No3",
  "Chopin_Etude_Op10_No5", "Chopin_Etude_Op10_No8", "Chopin_Etude_Op10_No9",
  "Chopin_Etude_Op25_No12_In_C_Minor", "Chopin_Etude_Op25_No2",
  "Chopin_Nocturne_Op9_No2", "Chopin_Op25_No3", "Chopin_Op28_No4",
  "Chopin_Op40_No1", "Chopin_Op64_No2",
  "Consolation_No3_In_D_Flat_Major",
  "Dance_Of_The_Gnomes_No2",
  "Debussy_Moonlight", "Debussy_Reverie",
  "Flight_Of_The_Bumblebee_Jazz_Version",
  "Grande_Polonaise_Brillante_Op22_P1", "Grande_Polonaise_Brillante_Op22_P2",
  "Gymnopedie_No1",
  "Impromptu_In_G_Flat_Major_Op90_No3",
  "Minute_Waltz_Op64_No1",
  "Moment_Musical_No3_In_F_Minor_Op94",
  "Nocturne_No3_In_B_Major_For_Piano_Solo", "Notturno_Op_54_No4",
  "Pavane_For_A_Dead_Princess",
  "Piano_Sonata_No13_K333", "Piano_Sonata_No16_K545",
  "Piano_Sonata_No17_In_D_Minor_Op31_No2_Tempest_1_Largo",
  "Prelude_And_Fugue_In_C_Minor_BWV_847_P1", "Prelude_And_Fugue_In_C_Minor_BWV_847_P2",
  "Prelude_In_G_Minor_Op23_No5",
  "Rhapsodie_Espagnole_S254_P1", "Rhapsodie_Espagnole_S254_P2",
  "Scarlatti_Sonata_In_D_Minor_K213",
  "Scene_From_Childhood_Op_15_No7_Dreaming",
  "Schumann_Papillons_Op2",
  "Scriabin_Etude_In_C_Sharp_Minor_Op19_No2",
  "Song_Without_Words_Op67_No2",
  "The_Little_Bell_No3",
  "The_Seasons_Op_37a_X_October_Autumn_Song",
  "The_Swan", "Turkish_March",
]);

/** 「轻音乐」那一档：13 首 = 10 首童谣（弹唱）+ 3 首轻钢琴（独奏）。
 *  ★ 这一档**必须列表**：10 首童谣的目录名是拼音（`PlaySing_Yao_Lan_Qu`），
 *    关键词认不出来；而 `Solo_Croatian_Rhapsody` 又会撞上古典的 "rhapsody"。
 *    （克罗地亚狂想曲在原版是轻音乐，不是古典 —— 这是逐首对表才知道的事。） */
const LIGHT_KEYS = Object.freeze([
  "Croatian_Rhapsody", "Lyphard_Melody", "Wedding_Of_Love",
  "Fen_Shua_Jiang", "Liang_Zhi_Lao_Hu", "Mo_Li_Hua", "Sheng_Ri_Kuai_Le_Ge",
  "Song_Bie", "Wai_Po_Qiao", "Xiao_Tu_Zi_Guai_Guai", "Yao_Lan_Qu",
  "You_Yi_Di_Jiu_Tian_Chang", "Zhao_Peng_You",
]);

/** 「ACG」那一档：68 首 = 47 首独奏 + 21 首弹唱（原神 / 崩坏 / 星穹铁道那批）。 */
const ACG_KEYS = Object.freeze([
  "A_Dramatic_Irony", "A_New_Day_With_Hope", "Above_The_Sea_Of_Clouds",
  "Another_Hopeful_Tomorrow", "Clear_Sky_Over_Liyue", "Dawn_Winery_Theme",
  "Down_By_The_Forgotten_Gardens", "Dream_Of_Scattered_Petals",
  "Dwelling_In_The_Past", "Ethereal_Mildness", "Footprints",
  "For_Riddles_For_Wonders", "Good_Night_Liyue", "Gymnopedies_Of_Lune",
  "Hanachirusato", "Hence_Begins_The_Journey", "Honkai_Star_Rail_Opening_Theme",
  "Le_Duc_Sous_leau", "Leisure_In_Painting", "Liyue", "Lustrous_Stars",
  "Moonlike_Smile", "Once-Joyful_Dream", "Ondulations_Du_Rythme",
  "Pathway_To_The_Hidden_Isles", "Peaceful_Wishes", "Pure_Sky",
  "Qingyun_Peak_Theme", "Rays_Of_Sunlight", "Resonance_Of_Khvarena",
  "Rex_Incognito", "Simurghs_Dream", "Sink_Into_Oblivion",
  "Sipping_In_The_Soft_Breeze", "Slight_Distress", "Soliloquy_Of_The_Star",
  "Spacewalk", "Stroll_Along_The_Beach", "Tagelied_Nachtlicher_Gedanken",
  "Tender_Strength", "The_Fading_Stories", "The_Shimmering_Voyage",
  "The_Wind_Catcher_From_A_Foreign_Land", "Traum_Durch_Die_Dammerung_Erster_Satz",
  "Vespers_Of_Pluviose", "Where_Did_You_Go", "Wildfire",
  "Da_Capo", "Devastation_And_Redemption", "Emberfire", "Her_Wishes",
  "If_I_Can_Stop_One_Heart_From_Breaking", "Lucens_Ut_Risus",
  "Melody_Of_Brave_Seeds", "Moon_Halo", "Natlan", "Nod-Krai",
  "Petala_Ceciderunt", "Qing_Lian", "Rubia", "Ruu_Melody", "Somnias_A_Luna",
  "Star_Odyssey", "The_Long_Way_Home", "The_Rime_Of_The_Ancient_Bargeman_III",
  "The_Road_Not_Taken", "The_Sanctification_Of_Tao_Dou", "White_Night",
]);

const GENRE_BY_KEY = new Map([
  ...CLASSICAL_KEYS.map((k) => [k, "古典"]),
  ...ACG_KEYS.map((k) => [k, "ACG"]),
  ...LIGHT_KEYS.map((k) => [k, "轻音乐"]),
]);

/** 目录名 → 查表用的键：去掉前缀与来源尾巴。
 *  `Solo_Chopin_Etude_Op10_No1` → `Chopin_Etude_Op10_No1`
 *  `PlaySing_Moon_Halo_Ziyun_original` → `Moon_Halo` */
export function songKey(dirName) {
  return String(dirName ?? "")
    .replace(/_Ziyun_original$/iu, "")
    .replace(/^(?:Solo|PlaySing)_/iu, "");
}

// 兜底（表外的曲子才走这里）：作曲家 / 曲式关键词 → 古典；日系与 Hoyo 关键词 → ACG。
// ★ 表内的 129 首**不走**这两条 —— 所以"克罗地亚狂想曲"不会被 "rhapsody" 抢走。
const CLASSICAL_HINT = new RegExp([
  "chopin", "rachmanin", "schumann", "liszt", "debussy", "brahms", "tchaikovsky",
  "mendelssohn", "satie", "saint-?saens", "bach", "beethoven", "mozart", "haydn",
  "handel", "vivaldi", "grieg", "dvo[rř][aá]k|dvorak", "scarlatti", "ravel",
  "rimsky|korsakov", "scriabin", "pachelbel", "schubert", "paganini", "albeniz",
  "肖邦", "拉赫", "舒曼", "李斯特", "德彪西", "勃拉姆斯", "柴可夫斯基", "门德尔松",
  "萨蒂", "圣桑", "巴赫", "贝多芬", "莫扎特", "海顿", "亨德尔", "维瓦尔第", "格里格",
  "德沃夏克", "斯卡拉蒂", "拉威尔",
  "nocturne", "夜曲", "prelude", "前奏曲", "[eé]tude", "练习曲", "waltz", "圆舞曲",
  "sonata", "奏鸣曲", "polonaise", "波兰舞曲", "mazurka", "ballade", "arabesque",
  "gymnop", "impromptu", "consolation", "pavane", "bumblebee|野蜂", "kinderszenen",
  "tr[aä]umerei|梦幻曲", "moment musical", "rhapsody|狂想曲", "fugue|赋格",
  "clair de lune|月光", "turkish march|土耳其", "the seasons|四季", "campanella|钟",
  "song without words|无词歌", "the swan|天鹅", "air on the g string|g弦",
  "f[uü]r elise|致爱丽丝", "canon|卡农", "bwv", "\\bop\\.?\\s?\\d",
].join("|"), "iu");
const ACG_HINT = /(genshin|honkai|star[\s_-]?rail|原神|崩坏|星穹|moon[\s_-]?halo|natlan|emberfire|nod[\s_-]?krai|somnias|rubia|liyue|璃月|hoyo|二次元|anime|初音|vocaloid|bilibili|東方|东方)/iu;

/**
 * 这一首算哪一类。
 * ★ 顺序即优先级：先认"个人上传"（midi_ / oliviasoul_ 是用户自己传上去的那批），
 *   再查对过表的 129 首（这是**真值**），表外才走关键词，关键词也认不出就兜底轻音乐。
 * ★ 判据不依赖任何网络与元数据文件 —— 只吃目录名和曲名，离线可用。
 */
export function classifyGenre(dirName, songName = "") {
  const dir = String(dirName ?? "");
  if (/^(?:midi|oliviasoul)/iu.test(dir)) return "我的上传";
  const known = GENRE_BY_KEY.get(songKey(dir));
  if (known) return known;
  const text = `${dir} ${songName}`;
  if (CLASSICAL_HINT.test(text)) return "古典";
  if (ACG_HINT.test(text)) return "ACG";
  return "轻音乐";
}

// ---------------------------------------------------------------- 官方曲名表
//
// ★ 来源（2026-10-15 定稿）：用户 2026-10-14 深夜截的**原版曲库页** 19 张截图
//   （古典 7 + ACG 10 + 轻音乐 2），逐行读出后与 `<曲库目录>` 的 129 个目录
//   用「模式列（独奏98/弹唱31）+ 实测时长 + 目录名语义」三重指纹对表 —— 129/129
//   零歧义（见 analysis/songs/）。**没有这层，用户电脑里有官方歌曲时界面只会显示
//   裸目录名**（`PlaySing The Road Not Taken`），这是用户明确在意的事。
// ★ 曲名只收截图上完整可读的文本，被截断的中文名**不补编**；时长是 ffprobe 实测
//   （截图上被悬浮提示遮挡/误读的行一律以实测为准）。
// ★ 契约值（曲名/作曲家）全部用**字面量**钉死，好让变异测试打得到。
//   测试对照副本在 tests/fixtures/official-song-names.json（含时长）。
const OFFICIAL_SONGS = new Map([
  ["Da_Capo", ["Da Capo 《毕业旅行》动画曲", "HOYO-MIX"]],
  ["Devastation_And_Redemption", ["神女劈观·唤情", "HOYO-MIX"]],
  ["Emberfire", ["烬火", "HOYO-MIX"]],
  ["Fen_Shua_Jiang", ["粉刷匠", "童谣"]],
  ["Her_Wishes", ["她的期许", "HOYO-MIX"]],
  ["If_I_Can_Stop_One_Heart_From_Breaking", ["使一颗心免于哀伤", "HOYO-MIX"]],
  ["Liang_Zhi_Lao_Hu", ["两只老虎", "童谣"]],
  ["Lucens_Ut_Risus", ["新月的摇篮曲（其二）：宵晖下的笑颜", "HOYO-MIX"]],
  ["Melody_Of_Brave_Seeds", ["和合大梦的曲调", "HOYO-MIX"]],
  ["Mo_Li_Hua", ["茉莉花", "童谣"]],
  ["Moon_Halo", ["Moon Halo 《新炎永燃》动画短片印象曲", "HOYO-MIX"]],
  ["Natlan", ["纳塔", "HOYO-MIX"]],
  ["Nod-Krai", ["摆德卡莱", "HOYO-MIX"]],
  ["Petala_Ceciderunt", ["新月的摇篮曲（其三）：眉间落英", "HOYO-MIX"]],
  ["Qing_Lian", ["剧情PV-「轻透」", "HOYO-MIX"]],
  ["Rubia", ["Rubia《渡尘》动画短片印象曲", "HOYO-MIX"]],
  ["Ruu_Melody", ["阿瑠的歌", "HOYO-MIX"]],
  ["Sheng_Ri_Kuai_Le_Ge", ["生日快乐歌", "童谣"]],
  ["Somnias_A_Luna", ["新月的摇篮曲（其一）：伴月同眠", "HOYO-MIX"]],
  ["Song_Bie", ["送别", "童谣"]],
  ["Star_Odyssey", ["尘间星旅", "HOYO-MIX"]],
  ["The_Long_Way_Home", ["回家的路", "HOYO-MIX"]],
  ["The_Rime_Of_The_Ancient_Bargeman_III", ["幽谷舟咏·其三", "HOYO-MIX"]],
  ["The_Road_Not_Taken", ["未行之路 The Road Not Taken", "HOYO-MIX"]],
  ["The_Sanctification_Of_Tao_Dou", ["八奇炼桃都", "HOYO-MIX"]],
  ["Wai_Po_Qiao", ["外婆桥", "童谣"]],
  ["White_Night", ["不眠之夜", "HOYO-MIX"]],
  ["Xiao_Tu_Zi_Guai_Guai", ["小兔子乖乖", "童谣"]],
  ["Yao_Lan_Qu", ["摇篮曲", "童谣"]],
  ["You_Yi_Di_Jiu_Tian_Chang", ["友谊地久天长", "童谣"]],
  ["Zhao_Peng_You", ["找朋友", "童谣"]],
  ["A_Dramatic_Irony", ["卡芙卡角色PV——戏剧性反讽", "HOYO-MIX"]],
  ["A_New_Day_With_Hope", ["希望的新一天 A New Day with Hope", "HOYO-MIX"]],
  ["Above_The_Sea_Of_Clouds", ["云海之上", "HOYO-MIX"]],
  ["Air_On_The_G_String_From_Orchestral_Suite_No3_In_D_Major_BWV_1068", ["Air on the G String, BWV 1068", "Bach"]],
  ["Another_Hopeful_Tomorrow", ["希望的明日", "HOYO-MIX"]],
  ["Arabesque_No2", ["Arabesque No.2 in G major", "Debussy"]],
  ["Beethoven_Piano_Sonata_No8_In_C_Minor_Op13_2_Adagio_Cantabile", ["Sonata No.8 in C minor, Op.13 \"Pathétique\"", "Beethoven"]],
  ["Canon_In_D", ["Canon in D（卡农）", "Johann Pachelbel"]],
  ["Chopin_Etude_Op10_No1", ["Étude Op.10 No.1", "Chopin"]],
  ["Chopin_Etude_Op10_No12", ["Étude Op.10 No.12", "Chopin"]],
  ["Chopin_Etude_Op10_No3", ["Étude Op.10 No.3", "Chopin"]],
  ["Chopin_Etude_Op10_No5", ["Étude Op.10 No.5", "Chopin"]],
  ["Chopin_Etude_Op10_No8", ["Étude Op.10 No.8", "Chopin"]],
  ["Chopin_Etude_Op10_No9", ["Étude Op.10 No.9", "Chopin"]],
  ["Chopin_Etude_Op25_No12_In_C_Minor", ["Étude in C minor, Op.25 No.12", "Chopin"]],
  ["Chopin_Etude_Op25_No2", ["Étude Op.25 No.2", "Chopin"]],
  ["Chopin_Nocturne_Op9_No2", ["Nocturne Op.9 No.2", "Chopin"]],
  ["Chopin_Op25_No3", ["Étude in F major, Op.25 No.3", "Chopin"]],
  ["Chopin_Op28_No4", ["Prelude in E minor, Op.28 No.4", "Chopin"]],
  ["Chopin_Op40_No1", ["Polonaise in A major, Op.40 No.1", "Chopin"]],
  ["Chopin_Op64_No2", ["Waltz in C# minor, Op.64 No.2", "Chopin"]],
  ["Clear_Sky_Over_Liyue", ["琄月的晴空", "HOYO-MIX"]],
  ["Consolation_No3_In_D_Flat_Major", ["Consolation No.3 in D♭ major（慰藉曲）", "Liszt"]],
  ["Croatian_Rhapsody", ["Croatian Rhapsody（克罗地亚狂想曲）", "Maksim Mrvica"]],
  ["Dance_Of_The_Gnomes_No2", ["Gnomenreigen, Concert Study S.145 No.2", "Liszt"]],
  ["Dawn_Winery_Theme", ["晨曦酒庄", "HOYO-MIX"]],
  ["Debussy_Moonlight", ["Clair de Lune（月光）", "Debussy"]],
  ["Debussy_Reverie", ["Rêverie（梦幻曲）", "Debussy"]],
  ["Down_By_The_Forgotten_Gardens", ["行于繁花侧畔", "HOYO-MIX"]],
  ["Dream_Of_Scattered_Petals", ["华散之梦", "HOYO-MIX"]],
  ["Dwelling_In_The_Past", ["久住往昔 Dwelling in the Past", "HOYO-MIX"]],
  ["Ethereal_Mildness", ["绿枝新柔", "HOYO-MIX"]],
  ["Flight_Of_The_Bumblebee_Jazz_Version", ["Flight of the Bumblebee（野蜂飞舞）", "Rimsky-Korsakov"]],
  ["Footprints", ["足迹", "HOYO-MIX"]],
  ["For_Riddles_For_Wonders", ["凡初的智慧 For Riddles, for Wonders", "HOYO-MIX"]],
  ["Good_Night_Liyue", ["晚安，璃月", "HOYO-MIX"]],
  ["Grande_Polonaise_Brillante_Op22_P1", ["Polonaise in F# minor, Op.22 Part 1", "Chopin"]],
  ["Grande_Polonaise_Brillante_Op22_P2", ["Polonaise in F# minor, Op.22 Part 2", "Chopin"]],
  ["Gymnopedie_No1", ["Gymnopédie No.1", "Erik Satie"]],
  ["Gymnopedies_Of_Lune", ["淡月之舞", "HOYO-MIX"]],
  ["Hanachirusato", ["华散之缘 Hanachirusato", "HOYO-MIX"]],
  ["Hence_Begins_The_Journey", ["旅途的开始 Hence, Begins the Journey", "HOYO-MIX"]],
  ["Honkai_Star_Rail_Opening_Theme", ["星穹铁道 Star Rail", "HOYO-MIX"]],
  ["Impromptu_In_G_Flat_Major_Op90_No3", ["Impromptu in G♭ major, Op.90 No.3", "Schubert"]],
  ["Le_Duc_Sous_leau", ["水下的公爵", "HOYO-MIX"]],
  ["Leisure_In_Painting", ["画景的游憩", "HOYO-MIX"]],
  ["Liyue", ["瑶月", "HOYO-MIX"]],
  ["Lustrous_Stars", ["寒星遥遥", "HOYO-MIX"]],
  ["Lyphard_Melody", ["Lyphard Melody（星空的旋律）", "理查德克莱德曼"]],
  ["Minute_Waltz_Op64_No1", ["Waltz in D♭ major, Op.64 No.1 \"Minute Waltz\"", "Chopin"]],
  ["Moment_Musical_No3_In_F_Minor_Op94", ["Moment Musical in F minor, Op.94 No.3", "Schubert"]],
  ["Moonlike_Smile", ["皎洁的笑颜 Moonlike Smile", "HOYO-MIX"]],
  ["Nocturne_No3_In_B_Major_For_Piano_Solo", ["Nocturne No.3", "Daniel Hellbach"]],
  ["Notturno_Op_54_No4", ["Notturno, Op.54 No.4（夜曲）", "Grieg"]],
  ["Once-Joyful_Dream", ["往昔的乐园", "HOYO-MIX"]],
  ["Ondulations_Du_Rythme", ["轻漪的节音", "HOYO-MIX"]],
  ["Pathway_To_The_Hidden_Isles", ["狭径绌幽", "HOYO-MIX"]],
  ["Pavane_For_A_Dead_Princess", ["Pavane for a Dead Princess", "Ravel"]],
  ["Peaceful_Wishes", ["和平的祝愿", "HOYO-MIX"]],
  ["Piano_Sonata_No13_K333", ["Piano Sonata No.13 in B-flat major, K.333", "Mozart"]],
  ["Piano_Sonata_No16_K545", ["Piano Sonata No.16 in C major, K.545", "Mozart"]],
  ["Piano_Sonata_No17_In_D_Minor_Op31_No2_Tempest_1_Largo", ["Piano Sonata No.17 in D minor, Op.31 No.2 \"Tempest\"", "Beethoven"]],
  ["Prelude_And_Fugue_In_C_Minor_BWV_847_P1", ["Prelude in C minor, BWV 847 Part 1", "Bach"]],
  ["Prelude_And_Fugue_In_C_Minor_BWV_847_P2", ["Fugue in C minor, BWV 847 Part 2", "Bach"]],
  ["Prelude_In_G_Minor_Op23_No5", ["Prelude in G minor, Op.23 No.5", "Rachmaninoff"]],
  ["Pure_Sky", ["青空 Pure Sky", "HOYO-MIX"]],
  ["Qingyun_Peak_Theme", ["庆云顶主题曲", "HOYO-MIX"]],
  ["Rays_Of_Sunlight", ["天霁日出 Rays of Sunlight", "HOYO-MIX"]],
  ["Resonance_Of_Khvarena", ["灵光的回响", "HOYO-MIX"]],
  ["Rex_Incognito", ["「钟离：听书人」尘世闲游", "HOYO-MIX"]],
  ["Rhapsodie_Espagnole_S254_P1", ["Spanish Rhapsody Part 1", "Liszt"]],
  ["Rhapsodie_Espagnole_S254_P2", ["Spanish Rhapsody Part 2", "Liszt"]],
  ["Scarlatti_Sonata_In_D_Minor_K213", ["Sonata in D minor, K.213 (L.108)", "Scarlatti"]],
  ["Scene_From_Childhood_Op_15_No7_Dreaming", ["Kinderszenen, Op.15 No.7 \"Träumerei\"", "Schumann"]],
  ["Schumann_Papillons_Op2", ["Papillons, Op.2（蝴蝶）", "Schumann"]],
  ["Scriabin_Etude_In_C_Sharp_Minor_Op19_No2", ["Nocturne No.2, Op.19", "Scriabin"]],
  ["Simurghs_Dream", ["花海之梦", "HOYO-MIX"]],
  ["Sink_Into_Oblivion", ["湮没的忆念", "HOYO-MIX"]],
  ["Sipping_In_The_Soft_Breeze", ["柔风浅韵", "HOYO-MIX"]],
  ["Slight_Distress", ["淡淡的不安", "HOYO-MIX"]],
  ["Soliloquy_Of_The_Star", ["幽星的独言", "HOYO-MIX"]],
  ["Song_Without_Words_Op67_No2", ["Song Without Words, Op.67 No.2", "Mendelssohn"]],
  ["Spacewalk", ["太空漫步", "HOYO-MIX"]],
  ["Stroll_Along_The_Beach", ["信步行时", "HOYO-MIX"]],
  ["Tagelied_Nachtlicher_Gedanken", ["拽夜的晓歌", "HOYO-MIX"]],
  ["Tender_Strength", ["同伴的力量", "HOYO-MIX"]],
  ["The_Fading_Stories", ["不再年轻的村庄 The Fading Stories", "HOYO-MIX"]],
  ["The_Little_Bell_No3", ["La Campanella（钟）", "Liszt"]],
  ["The_Seasons_Op_37a_X_October_Autumn_Song", ["The Seasons, Op.37a No.10 \"October\"", "Tchaikovsky"]],
  ["The_Shimmering_Voyage", ["珍珠之歌", "HOYO-MIX"]],
  ["The_Swan", ["The Swan（天鹅）", "Saint-Saëns"]],
  ["The_Wind_Catcher_From_A_Foreign_Land", ["捕风的异乡人 The Wind Catcher from a Foreign Land", "HOYO-MIX"]],
  ["Traum_Durch_Die_Dammerung_Erster_Satz", ["暮景遐思·其一", "HOYO-MIX"]],
  ["Turkish_March", ["Turkish March（土耳其进行曲）", "Tchaikovsky"]],
  ["Vespers_Of_Pluviose", ["雨月的晚祷", "HOYO-MIX"]],
  ["Wedding_Of_Love", ["Mariage d'amour（梦中的婚礼）", "理查德克莱德曼"]],
  ["Where_Did_You_Go", ["Where Did You Go", "HOYO-MIX"]],
  ["Wildfire", ["野火", "HOYO-MIX"]],
]);

/** 目录名 → 官方曲名信息；表外（个人上传、用户自建）返回 null。 */
export function officialSong(dirName) {
  const hit = OFFICIAL_SONGS.get(songKey(dirName));
  return hit ? { title: hit[0], composer: hit[1] } : null;
}

/** 曲库显示名：官方曲目用原版曲名，表外走 prettySongName 的裸名清洗。 */
export function songDisplayName(dirName) {
  return officialSong(dirName)?.title ?? prettySongName(dirName);
}

/** 播放方式：独奏 / 弹唱 / 个人上传（跟分类同一套命名口径）。 */
export function songMode(dirName) {
  const dir = String(dirName ?? "");
  if (/^(?:midi|oliviasoul)/iu.test(dir)) return SONG_MODES.upload;
  if (/^playsing/iu.test(dir)) return SONG_MODES.sing;
  return SONG_MODES.solo;
}

export function playbackTimeOfDay(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return "TOD12";
  return m >= 360 && m < 960 ? "TOD12" : m >= 960 && m < 1200 ? "TOD1730" : "TOD20";
}

// ---------------------------------------------------------------- 待机素材（场景/状态 + 时段后缀）
//
// ★ 时段 → 文件名后缀，来自原版素材自己的命名（`A_R1_1200.mp4` 那一批）：
//   TOD12→1200、TOD1730→1730、TOD20→2000。跟上面 TIME_SLOTS 是同一套时段，只是换了个写法。
//   有了它，前端/服务端挑场景状态之后只要按当前时段换个后缀，就能拼出该播的那个文件。
export const TOD_SLOT = Object.freeze({ TOD12: "1200", TOD1730: "1730", TOD20: "2000" });
export const SLOT_ORDER = Object.freeze(["1200", "1730", "2000"]);

/**
 * 过场片名：`{场景}_Transition_{旧}_{新}.mp4`。
 * ★ 方向必须跟时钟方向一致 —— `2000_1200` 是「夜晚→白天」（跨零点那一跳），不是笔误，
 *   也不是"倒着写"。所以这里按 SLOT_ORDER 的**环形**顺序判"是不是下一档"。
 * ★ 只有相邻时段原版才做过场片（1200→1730 / 1730→2000 / 2000→1200）；不是相邻就返回 null，
 *   调用方直接切正片 —— 别去拼一个根本不存在的文件名，那会拼出一片黑。
 */
export function transitionFile(scene, fromSlot, toSlot) {
  const s = String(scene ?? "");
  const from = String(fromSlot ?? "");
  const to = String(toSlot ?? "");
  if (!/^[ABC]$/u.test(s)) return null;
  const i = SLOT_ORDER.indexOf(from);
  const j = SLOT_ORDER.indexOf(to);
  // 环形相邻：在 3 档里 (to - from) 恰好前进一格。
  if (i < 0 || j < 0 || (j - i + SLOT_ORDER.length) % SLOT_ORDER.length !== 1) return null;
  return `${s}_Transition_${from}_${to}.mp4`;
}

export function normalizeTod(token) {
  const raw = String(token ?? "").toUpperCase();
  const m = /^TOD(1200|1730|2000|12|17|20)$/u.exec(raw);
  if (!m) return null;
  return ({ 1200: "TOD12", 12: "TOD12", 1730: "TOD1730", 17: "TOD1730", 2000: "TOD20", 20: "TOD20" })[m[1]];
}

/** 从文件名里拆出时段 / 视角 / 朝向。 */
export function parseVariant(fileName) {
  const stem = String(fileName ?? "").replace(/\.[^.]+$/u, "");
  const m = /(TOD(?:1200|1730|2000|12|17|20))(?:[_-](NI|WI))?(?:[_-]([LR]))?/iu.exec(stem);
  if (!m) return null;
  return { tod: normalizeTod(m[1]), view: (m[2] ?? "").toUpperCase() || null, hand: (m[3] ?? "").toUpperCase() || null };
}

/** 选变体：tod+view 精确 → 同 tod 无 view → 同 tod → 兜底。 */
export function selectVariant(variants, tod, view) {
  const list = Array.isArray(variants) ? variants.filter(Boolean) : [];
  if (!list.length) return null;
  const pool = list.filter((v) => v.tod === tod);
  return pool.find((v) => v.view === view)
    ?? pool.find((v) => !v.view)
    ?? pool[0]
    ?? list.find((v) => v.tod === "TOD12")
    ?? list[0]
    ?? null;
}

// ------------------------------------------------------------------ 账本

export const LEDGER_FIELDS = Object.freeze([
  "性描写", "涉党涉政", "提示注入", "事实伪造", "关系", "关系依据",
  "已承认情感", "已承认称呼", "既有亲密", "既有边界", "亲密上限",
  "本封亲密请求", "本封亲密判定",
  "说话者", "未决", "摘要待核实", "结论",
]);

export function parseLedger(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("　");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (LEDGER_FIELDS.includes(key)) out[key] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- 账本条目化（A1 记忆可更正）

/** 把「键　值」文本拆成条目数组。与 `parseLedger` 的唯一区别是**保留顺序与重复**：
 *  parseLedger 是「同键后者覆盖前者」，条目化需要知道"这一版是第几次写"，所以不能合并。 */
export function ledgerItemsFromText(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("　");
    if (idx < 0) continue;
    const field = trimmed.slice(0, idx).trim();
    if (!LEDGER_FIELDS.includes(field)) continue;
    const value = trimmed.slice(idx + 1).trim();
    if (!value) continue;
    out.push({ field, value });
  }
  return out;
}

/** 稳定 id：同一 (字段, 值) 的哈希 + 修订号。
 *  ★ 为什么不用自增主键：迁移与"用户在另一台机器上改过"都要能对上同一条记忆；
 *    用内容哈希 + 修订号，同一内容重跑迁移不会产生新 id（重复跑出不同 id 会让"撤销"失效）。
 *  ★ 为什么带修订号：用户把「关系」从 A 改成 B 再改回 A 时，id 必须不同 ——
 *    否则 supersedes 链会指回自己。 */
export function ledgerItemId(field, value, revision = 1) {
  const hash = createHash("sha1").update(`${field}\u0000${value}`).digest("hex").slice(0, 12);
  return `${hash}-v${revision}`;
}

/** 同字段只留最新的 `perFieldLimit` 条（其余视为过期）。
 *  ★ 为什么不是"全留"：账本字段是**当前状态**，不是流水；留一堆历史会让
 *    「给模型看的上下文」里出现自相矛盾的两条（旧的是"一般朋友"、新的是"密友"）。 */
export function mergeLedgerItems(items, { perFieldLimit = 5 } = {}) {
  const byField = new Map();
  for (const item of items) {
    if (!item || item.status === "deleted") continue;
    const list = byField.get(item.field) ?? [];
    list.push(item);
    byField.set(item.field, list);
  }
  const out = [];
  for (const [field, list] of byField) {
    list.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    for (const item of list.slice(0, perFieldLimit)) out.push({ ...item, field });
  }
  return out;
}

/** 把条目拼回「键　值」文本（只给仍然 active 的、每字段最新一条）。 */
export function ledgerItemsToText(items) {
  const latest = new Map();
  for (const item of items) {
    if (!item || item.status !== "active") continue;
    const seen = latest.get(item.field);
    if (!seen || (item.updated_at ?? 0) >= (seen.updated_at ?? 0)) latest.set(item.field, item);
  }
  return [...latest.values()].map((item) => `${item.field}　${item.value}`).join("\n");
}

// ---------------------------------------------------------------- 她的世界（A3）
//
// ★ 这里只放**纯函数**：同一组输入必须给同一组输出，不碰数据库、不碰网络、不读文件。
//   原因不是洁癖 —— 世界状态要能单测（"不同信号给不同状态"），
//   而模型只允许改写 `detail` 的措辞，不允许新增事实，所以"算状态"与"写句子"必须分开。

export const WORLD_ACTIVITIES = Object.freeze([
  "练琴", "听歌", "写信", "发呆", "收拾", "睡了", "在忙", "等你",
]);

const HOUR = 3600;
const DAY = 86400;

function localParts(seconds) {
  const d = new Date(seconds * 1000);
  return { hour: d.getHours(), month: d.getMonth() + 1, day: d.getDate() };
}

/** 她此刻在做什么。
 *  信号优先级（高 → 低）：重要日子 › 你很久没来信 › 刚写完回信 › 在练你常放的曲子 › 你的惯常时段 › 按钟点的基础作息。
 *  ★ 「没有信号时退化成基础作息，绝不硬编」—— 这是与竞品最大的区别：
 *    竞品是时钟驱动的生理模拟器，我们是"她的当下由你的行为供料，并且说得清"。 */
export function worldAt({ now, lastLetterAt = null, lastReplyAt = null, plays = [], habits = [], importantDates = [] } = {}) {
  const at = Number(now);
  if (!Number.isFinite(at) || at <= 0) throw new Error("worldAt 需要 now（秒）");
  const { hour, month, day } = localParts(at);

  const today = importantDates
    .map((item) => (typeof item === "string" ? { label: item } : item))
    .find((item) => Number(item.month) === month && Number(item.day) === day);
  if (today) {
    return {
      activity: "收拾",
      detail: `在收拾一下屋子 —— 今天是${today.label ? `「${today.label}」` : "个要紧的日子"}。`,
      reason: `今天是${today.label ?? "你提过的日子"}，她提前收拾`,
      evidence: { date: `${month}-${day}`, label: today.label ?? null },
      source: "date",
    };
  }

  if (Number.isFinite(Number(lastLetterAt)) && lastLetterAt) {
    const days = Math.floor((at - Number(lastLetterAt)) / DAY);
    if (days >= 3) {
      return {
        activity: "等你",
        detail: "把之前的信翻出来又看了一遍，信纸摊着。",
        reason: `你已经 ${days} 天没来信了`,
        evidence: { daysSince: days, lastLetterAt: Number(lastLetterAt) },
        source: "letter",
      };
    }
  }

  if (Number.isFinite(Number(lastReplyAt)) && lastReplyAt) {
    const since = at - Number(lastReplyAt);
    if (since >= 0 && since < 6 * HOUR) {
      return {
        activity: "写信",
        detail: "刚把那封回信写完，笔还没收。",
        reason: "她刚给你写完回信",
        evidence: { lastReplyAt: Number(lastReplyAt), hoursSince: Math.round(since / HOUR) },
        source: "letter",
      };
    }
  }

  // plays: [{ dir, at, count }] —— 只统计最近 24 小时；同一首放过 >=2 次才算"常放"
  const recent = (Array.isArray(plays) ? plays : [])
    .filter((p) => p && p.dir && Number(p.at) > 0 && at - Number(p.at) <= DAY)
    .sort((a, b) => Number(b.at) - Number(a.at));
  if (recent.length) {
    const counts = new Map();
    for (const p of recent) counts.set(p.dir, (counts.get(p.dir) ?? 0) + (Number(p.count) || 1));
    const [dir, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count >= 2) {
      return {
        activity: "练琴",
        detail: `在练那首你最近总放的曲子（${count} 次）。`,
        reason: `你最近放过这首 ${count} 次`,
        evidence: { songDir: dir, count, lastPlayedAt: Number(recent[0].at) },
        source: "song",
      };
    }
  }

  const habit = (Array.isArray(habits) ? habits : []).find((h) => hour >= Number(h.fromHour) && hour < Number(h.toHour));
  if (habit) {
    return {
      activity: "写信",
      detail: "把信纸摊开了 —— 你常在这个时候来。",
      reason: "这是你惯常来信的时段",
      evidence: { fromHour: Number(habit.fromHour), toHour: Number(habit.toHour) },
      source: "habit",
    };
  }

  if (hour < 6) {
    return { activity: "睡了", detail: "已经睡了。", reason: "按时间的基础作息：深夜", evidence: { hour }, source: "clock" };
  }
  if (hour < 9) {
    return { activity: "在忙", detail: "刚醒，在忙自己的事。", reason: "按时间的基础作息：早晨", evidence: { hour }, source: "clock" };
  }
  if (hour < 12) {
    return { activity: "听歌", detail: "戴着耳机听一会儿。", reason: "按时间的基础作息：上午", evidence: { hour }, source: "clock" };
  }
  if (hour < 18) {
    return { activity: "发呆", detail: "坐在窗边发呆。", reason: "按时间的基础作息：下午", evidence: { hour }, source: "clock" };
  }
  if (hour < 24) {
    return { activity: "练琴", detail: "在练琴。", reason: "按时间的基础作息：傍晚", evidence: { hour }, source: "clock" };
  }
  return { activity: "睡了", detail: "已经睡了。", reason: "按时间的基础作息：深夜", evidence: { hour }, source: "clock" };
}

/** 校验一条世界状态：activity 必须是枚举、evidence 必须存在。
 *  ★ 放成导出函数是为了让"非法值直接抛，不落库"这条能被单测钉住。 */
export function assertWorldState(state) {
  if (!state || typeof state !== "object") throw new Error("世界状态必须是对象");
  if (!WORLD_ACTIVITIES.includes(state.activity)) {
    throw new Error(`世界状态的 activity 不在枚举里：${state.activity}`);
  }
  if (!state.evidence || typeof state.evidence !== "object") throw new Error("世界状态必须有 evidence");
  if (!state.reason) throw new Error("世界状态必须有 reason");
  if (!state.source) throw new Error("世界状态必须有 source");
  return state;
}

// ---------------------------------------------------------------- 她的日记（A2）

/** 锁住"那一天发生过什么"。
 *  ★ 这是日记的唯一事实来源，生成后**不再重算**：改设定、改信件都不许让旧日记改写。
 *    只存 id 与摘要，绝不存正文副本（数据安全底线：新表里不出现信件正文）。 */
export function diaryFacts({ day, letters = [], plays = [], world = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(day ?? ""))) throw new Error("日记的 day 必须是 YYYY-MM-DD");
  return {
    day,
    letters: (Array.isArray(letters) ? letters : []).map((l) => ({
      id: String(l.id ?? ""),
      at: Number(l.at ?? 0),
      excerpt: String(l.excerpt ?? "").slice(0, 40),
    })),
    plays: (Array.isArray(plays) ? plays : []).map((p) => ({ dir: String(p.dir ?? ""), count: Number(p.count) || 1 })),
    world: world ? { activity: world.activity, reason: world.reason } : null,
  };
}

/** 日记该不该写：默认"这一天和她没有任何往来就不写"，除非用户显式打开那个开关。
 *  ★ 这条规则放在纯函数里，是因为它决定了"日记会不会变成机械流水账"。 */
export function shouldWriteDiary({ facts, writeEmptyDay = false } = {}) {
  const hasLetters = (facts?.letters?.length ?? 0) > 0;
  const hasMusic = (facts?.plays?.length ?? 0) > 0;
  if (hasLetters || hasMusic) return true;
  return Boolean(writeEmptyDay);
}

/** 「最近往来」能塞进 prompt 的字符预算。
 *  ★ 为什么要有预算：以前固定送最近 6 封**全文**，单封上限 4000 字 ⇒ 最坏 48000 字
 *    （中文差不多就是四万多个 token），再加上人设 + 写法 + 预检，小上下文的模型直接被顶爆，
 *    表现成 callModel 抛 400，那封信变「生成失败」—— 用户看不出是"信写太长了"。
 *  ★ 原版程序的做法是给每封信存一条 LLM 摘要（`letter_summaries`），
 *    再按摘要压缩历史。那套要额外的整理任务、要缓存、要版本号，代价不小；这里先做**便宜的
 *    那半**：按预算整段取舍，绝不截断某一封的正文（截断会把一句话切掉半句，模型会当真的读）。
 *  12000 字 ≈ 中文 1.2 万 token 量级，给 6 封往来留够位置，也不至于压垮 8k 上下文以外的常见模型。 */
export const HISTORY_BUDGET_CHARS = 12000;

/** 从「时间正序」的往来里挑出能放进预算的一段（还是时间正序）。
 *  ★ 永远保留最近一封 —— 哪怕它一封就超预算：最新的那封是这封回信唯一必须接住的上文，
 *    为了"守预算"把它丢掉，等于让林离忘了刚说完的话。
 *  ★ 只在**整封**的边界上取舍，绝不切正文。 */
export function pickRecentWithinBudget(rows, budget = HISTORY_BUDGET_CHARS) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number.isFinite(budget) && budget > 0 ? budget : HISTORY_BUDGET_CHARS;
  const picked = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const row = list[i] ?? {};
    const cost = String(row.content ?? "").length + String(row.reply_text ?? "").length;
    if (picked.length && used + cost > limit) break;
    picked.unshift(row);
    used += cost;
  }
  return picked;
}

/** 预检回来的值该不该落库（A1 的核心规则，抽成纯函数才测得住）。
 *  ① 你亲手改过这一字段且值不同 ⇒ 不覆盖，挂冲突；
 *  ② 已经是同一个值 ⇒ 跳过（不要每封信都插一条重复行）；
 *  ③ 否则写一条新条目，`supersedes` 指向同字段上一条 active。
 *  ★ 这条规则就是"改完下次又被模型写回去"这个痛点的解 —— 放在纯函数里，
 *    测试可以直接喂三种情形，不必起服务、更不必真调模型。 */
export function decideLedgerWrite({ value, existing = [] } = {}) {
  const active = (Array.isArray(existing) ? existing : []).filter((item) => item && item.status === "active");
  const mine = active.filter((item) => item.origin === "user").sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  if (mine && mine.value !== value) return { action: "conflict", mine: mine.value };
  if (active.some((item) => item.value === value)) return { action: "skip" };
  const prev = [...active].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  return { action: "write", supersedes: prev?.id ?? null };
}
