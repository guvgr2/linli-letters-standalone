// UserData 导入 · **预览与落库之间那一段**（全是纯函数 + 一个带 TTL 的登记簿）
//
// 为什么单独一个文件：`server.mjs` 一被 import 就会 `listen` 起服务，测试导不进它。
//   而"预览到底算了几个数""过期怎么判"这些恰恰是最该被钉住的地方 ——
//   它们错了，用户看到的预览就是假的，而落库会按另一套数去写。
//
// 为什么预览与落库要分成两步（照 DSH《UserData 一键导入机制说明》§5）：
//   **风险不对称** —— 预览没有任何破坏性，落库要给用户的库动刀，而且没有撤销键。
//   分两步之后，用户在「真的写进去」之前有一次看清楚的机会。

import { letterImportPlan, mapImportedLetter, countSoulVideos, videoSkipNote } from "./import-preview.mjs";

/** 预览的有效期：30 分钟。过了就得重新选文件（与服务端重启同一种表现）。 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/**
 * 把一份**已经解析过**的 `.soul` 算成一份落库计划。
 *
 * @param {object}   o
 * @param {string}   o.id              预览 id（服务端生成，这里只用它做登记簿的键）
 * @param {object}   o.parsed          `parseSoulArchive()` / `parseSoulArchiveFile()` 的结果
 * @param {Iterable<string>} o.existingIds     库里已有的信件 id
 * @param {Iterable<string>} [o.existingHashes] 库里已有的 `content_md5`
 * @param {number|null} [o.archivedAt] 这次落库写进 `archived_at` 的时刻（DSH 口径 = 导入这一刻）
 * @param {number|null} [o.fallbackBase] 信里没有日期时，拿哪一刻当基准（默认"现在"）
 * @returns {{id, rows, counts, skippedIds, conflictIds, total, fallbackIds, videos, note, archivedAt}}
 */
export function buildImportPlan({
  id,
  parsed,
  existingIds,
  existingHashes = [],
  archivedAt = null,
  fallbackBase = null,
}) {
  const list = parsed?.payload?.memory?.exchanges;
  if (!Array.isArray(list)) {
    // 解析器保证了这个字段存在；走到这里说明有人在别处改了解析产物 —— 宁可炸也不要装作 0 封。
    throw new Error("解析结果里没有信件清单，不该走到这一步");
  }

  // `.soul` 的清单是 **newest-first**（DSH `parseStandardMemoryJson` 直接校验 `order === "newest-first"`）。
  // ★ 倒过来落库有两个实际好处：① 时间戳缺省值可以顺着时间递增（最新那封排最后）；
  //   ② 库里 `created_at DESC, rowid DESC` 的排序在任何一封缺日期时都不会被打乱。
  const ordered = [...list].reverse();
  const base = Number.isFinite(fallbackBase) ? fallbackBase : Math.floor(Date.now() / 1000);
  const fallbackIds = [];

  const rows = ordered.map((item, index) => {
    const row = mapImportedLetter(item);
    if (row.createdAt === null) {
      // ★ 缺日期不是"当作 1970"也不是"当作现在" —— 而是**顺着倒数排**，
      //   这样至少先后顺序是对的，且能被统计出来（fallbackIds）如实报给用户。
      row.createdAt = base - (ordered.length - index);
      fallbackIds.push(row.letterId);
    }
    row.archivedAt = archivedAt;
    return row;
  });

  // 分类直接复用 `letterImportPlan` —— 它是被测试钉过的那一份判据，不在这里再写一遍。
  // （rows 自己就带着 `letterId` 与 `contentMd5`，正是它要的两个键。）
  const plan = letterImportPlan(existingIds, rows, existingHashes);
  const videos = countSoulVideos(parsed);

  return {
    id,
    rows: plan.added,
    counts: plan.counts,
    skippedIds: plan.skipped,
    conflictIds: plan.conflicts,
    total: rows.length,
    fallbackIds,
    videos,
    note: videoSkipNote(videos),
    archivedAt,
  };
}

/**
 * 预览的登记簿。
 *
 * 预览结果**只放在内存里**，不落库、不落盘：
 *   - 落库要多一张表 ⇒ 又多一次改用户库的迁移，而预览本身是一次性的；
 *   - 进程重启后预览失效是**正确**表现（那份临时文件也一起没了）。
 * ⇒ 代价是重启后用户得重新选一次文件，报 `IMPORT_PREVIEW_STALE` 让他知道该重来。
 */
export class PreviewRegistry {
  constructor({ ttlMs = PREVIEW_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  put(record) {
    this.prune();
    this.map.set(record.id, { at: this.now(), record });
    return record.id;
  }

  /** 取一份**还没过期**的预览；过期就地丢掉。 */
  get(id) {
    const hit = this.map.get(id);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(id);
      return null;
    }
    return hit.record;
  }

  /** 取走（用过就不再复用 —— 同一份预览不能落库两次）。 */
  take(id) {
    const record = this.get(id);
    if (record) this.map.delete(id);
    return record;
  }

  prune() {
    for (const [id, hit] of this.map) {
      if (this.now() - hit.at > this.ttlMs) this.map.delete(id);
    }
  }

  get size() {
    return this.map.size;
  }
}
