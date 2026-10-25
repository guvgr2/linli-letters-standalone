/**
 * 时间轴 / 日历的聚合口径（2026-10-21）。
 *
 * 为什么单独一个文件：这两个视图其实只是「同一份数据、两种看法」——
 *   时间轴＝按本地日倒序一路往下捋（信件与她的日记混在一条线上）；
 *   日历  ＝把同一份按日聚合的结果摊进月历格子。
 * 所以聚合只写一次，两边共用；而且做成**纯函数**，不碰 db、不碰 DOM，
 * 可以直接拿假数据单测（服务端与前端之间的约定就靠它钉住）。
 *
 * ★ 分日一律用**本地时区**（本机 +08:00）：跟 server.mjs 的 localDay 同一个口径。
 *   用 UTC 会把每天 00:00–08:00 的信记到前一天，时间轴与日记的"那天"就对不上。
 */

const pad2 = (n) => String(n).padStart(2, "0");

/** unix 秒 → 本地 'YYYY-MM-DD'。与 server.mjs 的 localDay 同口径（那边要 nowSeconds 默认值，这边只转给定秒）。 */
export function localDayOf(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 一行正文压成一行预览（换行/连续空白都收掉），超长截断加省略号。 */
function preview(text, limit = 48) {
  const one = String(text ?? "").replace(/\s+/gu, " ").trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

/** 一封「失败」的信：项目既有口径 —— status 5 **且** error 有内容才算失败。
 *  （旧程序搬进来的信也是 status 5，但它们没出过错。） */
const isFailed = (row) => Number(row.status) === 5 && Boolean(String(row.error ?? "").trim());

/**
 * 把信件行与日记行聚成「按本地日倒序」的天数组。
 *
 * @param {object} input
 * @param {Array} input.letters  信件行：{ id, content, reply_text, origin, status, error, created_at, replied_at, is_read }
 * @param {Array} input.diary    日记行：{ day, excerpt, mood, created_at, song_dir }
 * @param {number} input.maxPerDay  每天最多带几封信的明细（计数仍是全量）。默认 30。
 * @returns {Array} [{ day, letterCount, unreadCount, hasFailed, hasDiary, letters, diary }]
 */
export function buildTimelineDays({ letters = [], diary = [], maxPerDay = 30 } = {}) {
  const byDay = new Map();

  /** 取（或新建）某天的桶。 */
  const bucket = (day) => {
    let hit = byDay.get(day);
    if (!hit) {
      hit = {
        day,
        letterCount: 0,
        unreadCount: 0,
        hasFailed: false,
        hasDiary: false,
        letters: [],
        diary: null,
        // 内部用：全量里最晚的时刻，拿来给"天"排序的第二关键字（同一天多封信时朝下稳定）
        _all: [],
      };
      byDay.set(day, hit);
    }
    return hit;
  };

  for (const row of letters) {
    if (row?.created_at === null || row?.created_at === undefined) continue;
    const day = localDayOf(row.created_at);
    const item = bucket(day);
    item.letterCount += 1;
    const her = row.origin === "proactive";
    const failed = isFailed(row);
    if (failed) item.hasFailed = true;
    // 未读只看"有回信的信"：她还没回的那封本来就没有可读内容，不该算成红点。
    if (Number(row.is_read) === 0 && String(row.reply_text ?? "").trim()) item.unreadCount += 1;
    item._all.push({
      id: row.id,
      origin: her ? "proactive" : null,
      preview: preview(her ? row.reply_text : row.content),
      // ★ 失败要显式带出去：时间轴上一个"!"比一行灰字更能说明这天发生了什么。
      failed,
      status: Number(row.status ?? 0),
      is_read: Number(row.is_read ?? 1),
      created_at: Number(row.created_at),
      replied_at: row.replied_at === null || row.replied_at === undefined ? null : Number(row.replied_at),
    });
  }

  for (const row of diary) {
    if (!row?.day) continue;
    const item = bucket(row.day);
    item.hasDiary = true;
    // 一天只有一篇日记（day 是主键）；真出现重复也只认最新那条，不叠加。
    if (!item.diary) {
      item.diary = {
        excerpt: preview(row.excerpt ?? row.body, 80),
        mood: row.mood ?? null,
        created_at: row.created_at ?? null,
        song_dir: row.song_dir ?? null,
      };
    }
  }

  const days = [...byDay.values()];
  for (const item of days) {
    // 每天内部按时间倒序（最新的在最上面），再截到 maxPerDay —— 计数不受截断影响。
    item._all.sort((a, b) => b.created_at - a.created_at);
    item.letters = item._all.slice(0, Math.max(1, maxPerDay));
    delete item._all;
  }
  // 天按字符串倒序：'YYYY-MM-DD' 的字典序就是时间序，不用再转 Date。
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return days;
}

/** 把天数组摊成「day → 那天有没有信/日记」的索引，专给日历格子用。 */
export function indexDaysByDay(days = []) {
  const map = new Map();
  for (const item of days) {
    map.set(item.day, {
      letterCount: item.letterCount,
      unreadCount: item.unreadCount,
      hasFailed: item.hasFailed,
      hasDiary: item.hasDiary,
    });
  }
  return map;
}
