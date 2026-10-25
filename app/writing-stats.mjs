// 连续写信天数（纯函数，便于确定性单测；不碰 DB、不外联）。
//
// 用户 2026-10-21 拍板的口径：
//   · 只数「你写的信」——连续几天给她写过信（不是她先写的那些）。
//   · 断了不惩罚：不飘红、不清零提示；断一天就归零，安静地归零。
//   · 用**本地日期**（setDate 处理跨月/跨年），绝不用 UTC——东八区 00:00–08:00
//     用 toISOString 会被记到"前一天"，streak 就假了。
const pad2 = (n) => String(n).padStart(2, "0");

/** 本地时区的 "YYYY-MM-DD"。 */
export const localDayOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * 从 today 往回数连续有信的天数。
 * - daySet：已有信件的本地日集合（"YYYY-MM-DD"），重复无妨（内部按 Set 处理）。
 * - today：判定基准日，默认现在。
 * 口径：今天还没写 ⇒ 从昨天起算（"今天还没写"不算断，一天还没过完）；
 *   昨天也没有 ⇒ 0（真的断了）。
 */
export function computeStreak(daySet, today = new Date()) {
  const set = daySet instanceof Set ? daySet : new Set(daySet);
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!set.has(localDayOf(base))) base.setDate(base.getDate() - 1);
  let streak = 0;
  while (set.has(localDayOf(base))) {
    streak += 1;
    base.setDate(base.getDate() - 1);
  }
  return streak;
}
