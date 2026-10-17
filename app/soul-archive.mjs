// `.soul` 归档容器解析（UserData 导入第二步：读得懂，才谈得上搬）
//
// 为什么这一段仍然是**纯函数**：DSH 2026-10-16《UserData 一键导入机制说明》§5 的建议是
// 「把写库留到契约确认之后」。解析一个文件不写库、不发网络、不改磁盘 —— 它只回答
// 「这份东西是不是一份合法的 .soul、里面有几封信几段视频」。
// 契约谈不拢，这一段删掉即可，留不下任何痕迹。
//
// 容器格式（照 DSH 侧 `parseSoulArchive`，`repo/source/local-service/server.js:2683-2738`）：
//   头 16 字节 = 8 字节 SOUL_MAGIC + readBigUInt64LE(8) 的清单长度
//   → 清单 JSON（schema / version / memory / videos）
//   → 视频裸数据紧跟其后，按清单里的 size 依次累加 offset
//
// ★ 九道校验逐条照搬，**失败信息一字不改**（用户看到的提示两端要一致）。
//
// ★★ 三个常量：**2026-10-16 20:39 DSH 已给字面值**（回执 `6F5381D4B7882C01` §1，
//   出处 `repo/source/local-service/soul-bundle.js:4-6`，`server.js:46-51` 从它 import）。
//   之前不给是因为读不到 —— 现在读到了，就照抄，不再猜。
//
//   ⇒ 但仍然**不做默认值**：调用方必须显式传 `limits`，没传就抛。
//     理由不是"不信任这些数"，而是**这份文件不该自己决定用哪一套上限** ——
//     上限是服务端的政策，政策变了只改服务端一处，不该在解析器里再躺着一份。
//     `SOUL_LIMITS` 只是给调用方一个"当前真值"的现成取值，用不用由调用方决定。
//   ⇒ 缺了就抛 ⇒ 在第一次调用时就现形，而不是等用户拿一份超大归档来导入才炸。

import { createHash } from "node:crypto";

export const SOUL_SCHEMA = "olivia-soul.bundle";
export const MEMORY_SCHEMA = "olivia-soul.memory";
export const SUPPORTED_VERSIONS = new Set([1, 2]);

/**
 * DSH 侧当前的三个真值（`soul-bundle.js:4-6`，2026-10-16 给的）。
 * 调用方可以原样传进来，也可以覆盖 —— 这里**不给** `parseSoulArchive` 当默认值，理由见文件头。
 */
export const SOUL_LIMITS = Object.freeze({
  magic: Buffer.from("SOUL0001", "ascii"),
  maxBytes: 10 * 1024 * 1024 * 1024,      // 10 GiB
  maxManifestBytes: 16 * 1024 * 1024,     // 16 MiB
  maxVideoBytes: 512 * 1024 * 1024,       // 512 MiB —— DSH 侧 server.js:132
});

/** 头 16 字节：8 字节魔法头 + 8 字节（LE）清单长度。 */
export const HEADER_BYTES = 16;
/** 每段视频至少 12 字节，且第 4..8 字节必须是 `ftyp`（这是 mp4 的盒子标识）。 */
export const VIDEO_MIN_BYTES = 12;
export const FTYP = "ftyp";
/** 视频的 `contentMd5` 必须是这个形状（32 位小写十六进制）。 */
export const MD5_RE = /^[0-9a-f]{32}$/u;

function fail(msg) {
  throw new Error(msg);
}

/**
 * 往来指纹 —— **DSH 侧 `exchangeContentMd5()` 的同一把尺子**（`server.js:653-657`）。
 * 来信与回信一起算，中间夹 `\n---\n`。两侧对账要逐位相等，所以这里不多一个字少一个字。
 */
export function exchangeMd5(incoming, reply) {
  return createHash("md5")
    .update(`${String(incoming ?? "").trim()}\n---\n${String(reply ?? "").trim()}`, "utf8")
    .digest("hex");
}

/** 稀疏视图还缺这段字节 ⇒ 交给文件版去读（内部信号，不导出）。 */
class NeedBytes extends Error {
  constructor(start, end) {
    super(`需要读取 ${start}..${end}`);
    this.name = "NeedBytes";
    this.start = start;
    this.end = end;
  }
}

/**
 * 稀疏视图：`size` 是文件总长，`slice()` 只对**已经读过**的区间有效。
 * 内存版把整个 Buffer 当成一个全覆盖的视图；文件版按需往里填。
 *
 * ★ 为什么要这层抽象：一份 `.soul` 上限 10 GB，**不能整个读进内存**（DSH 侧也是
 *   文件句柄 + 偏移读，`server.js:2870-2874`）。但校验判据又不能写两份 ——
 *   两份判据迟早分叉，而分叉的表现是「同一个文件在一端能导、另一端不能导」。
 *   ⇒ 所以判据只有 `inspectSoul()` 一份，它向视图要字节；视图给不出来就抛
 *   `NeedBytes`，文件版读回那段再重来。**下一次一定会推进**（每次至少多覆盖
 *   一个原本缺失的区间），所以循环是有界的；仍然加了次数上限兜底。
 */
class SparseView {
  constructor(size) {
    this.size = size;
    this.ranges = [];
  }

  add(offset, buf) {
    this.ranges.push({ offset, buf });
  }

  slice(start, end) {
    for (const r of this.ranges) {
      if (start >= r.offset && end <= r.offset + r.buf.length) {
        return r.buf.subarray(start - r.offset, end - r.offset);
      }
    }
    throw new NeedBytes(start, end);
  }
}

/**
 * 解析一份 `.soul` 归档（**内存版**：调用方已经把整个文件读进来了）。
 *
 * ⚠️ 真实归档上限 10 GB ⇒ 生产路径请用 `parseSoulArchiveFile()`（按需读，不占内存）。
 *   这个同步版留给测试与小文件，判据与文件版**完全相同**（同一个 `inspectSoul`）。
 *
 * @param {Buffer} buf      整个文件的字节
 * @param {object} limits   **必填**：`{ magic, maxBytes, maxManifestBytes, maxVideoBytes }`
 * @returns {{ payload: object, videos: Array<{offset:number,size:number}>, manifestBytes: number }}
 */
export function parseSoulArchive(buf, limits = {}) {
  if (!Buffer.isBuffer(buf)) fail(".soul 文件格式不正确");
  const whole = new SparseView(buf.length);
  whole.add(0, buf);
  return inspectSoul(whole, limits);
}

/**
 * 解析一份 `.soul` 归档（**文件版**：随机读，不把文件读进内存）。
 *
 * 与内存版的差别只有「字节从哪来」。失败信息、判据顺序、连注释都共用一份。
 *
 * @param {string} filePath
 * @param {object} limits  同上
 * @returns {Promise<{ payload: object, videos: Array<{offset:number,size:number}>, manifestBytes: number, bytesRead: number }>}
 *   ⚠️ 比内存版多一个 `bytesRead`（累计真读进来的字节数）。它是**证据**：
 *   一份 10 GB 的归档只该读「16 字节头 + 清单 + 每段 12 字节」，测试靠它钉住这件事。
 */
export async function parseSoulArchiveFile(filePath, limits = {}) {
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const view = new SparseView(size);
    let bytesRead = 0;
    const need = async (offset, length) => {
      // 越界的读请求只可能是「文件真的短了」，不是「还缺数据」——
      // 与 DSH 侧读不满就报 `.soul 文件不完整` 同一处理（`server.js:2873-2874`）。
      if (offset + length > size) fail(".soul 文件不完整");
      const buf = Buffer.alloc(length);
      const { bytesRead: got } = await handle.read(buf, 0, length, offset);
      if (got !== length) fail(".soul 文件不完整");
      view.add(offset, buf);
      bytesRead += length;
    };
    // 头 16 字节先拿到手：`.soul 文件格式不正确` 那条判据要靠它，而它又只能读了才知道。
    if (size >= HEADER_BYTES) await need(0, HEADER_BYTES);
    for (let round = 0; round < MAX_READ_ROUNDS; round += 1) {
      try {
        return { ...inspectSoul(view, limits), bytesRead };
      } catch (error) {
        if (!(error instanceof NeedBytes)) throw error;
        await need(error.start, error.end - error.start);
      }
    }
    fail(".soul 文件结构异常：读取轮次超出上限");
  } finally {
    await handle.close();
  }
}

/** 读轮次上限：正常一份文件最多 2 + 视频段数 轮（头、清单、每段 12 字节头）。 */
const MAX_READ_ROUNDS = 4096;

/**
 * 校验内核 —— **只认视图，不认字节是从内存还是从磁盘来的**。
 * 所有 `.soul` 的判据都在这里，且只有这一份。
 */
function inspectSoul(view, limits = {}) {
  const { magic, maxBytes, maxManifestBytes, maxVideoBytes } = limits;

  // ① 三个上限/魔法头必须由调用方给 —— 见文件头注释，缺省即抛，绝不自己补。
  if (!Buffer.isBuffer(magic) || magic.length === 0) {
    fail("SOUL_MAGIC 未给定：DSH 侧 server.js:47-49 的字面值还没拿到，拒绝跳过魔法头校验");
  }
  if (!Number.isFinite(maxBytes)) fail("MAX_SOUL_BYTES 未给定：拒绝用猜测值做体积上限");
  if (!Number.isFinite(maxManifestBytes)) fail("MAX_SOUL_MANIFEST_BYTES 未给定：拒绝用猜测值做清单上限");
  // ★ 2026-10-17 补：DSH 侧对单段视频还有 512 MB 上限（`server.js:2909`），
  //   我侧原先没有 ⇒ 一份声明了 4 GB「视频」的清单会被原样接受，落库时才发现装不下。
  if (!Number.isFinite(maxVideoBytes)) fail("MAX_VIDEO_BYTES 未给定：拒绝用猜测值做单段视频上限");

  // ② 体积上限
  if (view.size > maxBytes) fail(".soul 文件不能超过 10 GB");
  // ③ 至少 16 字节（连头都不够）
  if (view.size < HEADER_BYTES) fail(".soul 文件格式不正确");
  // ④ 魔法头
  if (magic.length > HEADER_BYTES) fail("SOUL_MAGIC 长度超过 16 字节的头 ⇒ 常量给错了");
  // ⚠️ 视图给不出这段就抛 `NeedBytes` —— 文件版读到之后会把这一段补进来重来一次。
  if (!view.slice(0, magic.length).equals(magic)) fail(".soul 文件格式不正确");

  // ⑤ 清单长度
  const manifestBytes = Number(view.slice(8, HEADER_BYTES).readBigUInt64LE(0));
  if (!Number.isFinite(manifestBytes) || manifestBytes < 0) fail(".soul 文件格式不正确");
  if (manifestBytes > maxManifestBytes) fail(".soul 信件清单过大");
  // ⑥ 文件长度必须装得下「头 + 清单」
  if (view.size < HEADER_BYTES + manifestBytes) fail(".soul 文件不完整");

  // ⑦ 清单 JSON 可解析
  const raw = view.slice(HEADER_BYTES, HEADER_BYTES + manifestBytes).toString("utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail(".soul 信件清单格式不正确");
  }
  if (!payload || typeof payload !== "object") fail(".soul 信件清单格式不正确");

  // ⑧ 版本号受支持
  if (payload.schema !== SOUL_SCHEMA) fail(".soul 信件清单格式不正确");
  if (!SUPPORTED_VERSIONS.has(payload.version)) fail("不支持的 .soul 文件版本");

  // ⑨ 信件信息校验（含 md5）
  const exchanges = payload?.memory?.exchanges ?? payload?.exchanges ?? [];
  if (!Array.isArray(exchanges)) fail(".soul 信件信息校验失败");
  for (const x of exchanges) {
    if (!x || typeof x !== "object") fail(".soul 信件信息校验失败");
    if (typeof x.letterId !== "string" || !x.letterId) fail(".soul 信件信息校验失败");
    // 给了 contentMd5 就必须是 32 位十六进制；给了正文就现算一遍比对。
    // ★ 2026-10-17 修正：**字段名与算式都照 DSH 侧**（原先按 `content` 判、算 `md5(content)`，
    //   与真实的 `incoming` + `md5(incoming.trim() + "\n---\n" + reply.trim())` 对不上 ⇒
    //   拿真 .soul 跑会整批假红）。出处 `server.js:653-657` 与 `:2891-2892`。
    if (x.contentMd5 !== undefined && x.contentMd5 !== null) {
      if (!MD5_RE.test(String(x.contentMd5))) fail(".soul 信件信息校验失败");
      // ★ 给了正文就现算一遍比对 —— 不比对等于白存这个字段，
      //   而「导入后到底有没有丢」唯一可复算的证据就是它。（不注入任何可开关的钩子：
      //   一旦能跳过，将来就是默认跳过。）
      const incoming = x.incoming ?? x.content;
      if (typeof incoming === "string") {
        const reply = typeof x.reply === "string" ? x.reply : "";
        if (exchangeMd5(incoming, reply) !== String(x.contentMd5)) {
          fail(".soul 信件信息校验失败");
        }
      }
    }
  }

  // ⑩ 视频清单格式
  const videos = [];
  const list = payload.videos ?? [];
  if (!Array.isArray(list)) fail(".soul 视频清单格式不正确");
  // ★ 2026-10-17 补两道（DSH 侧 `server.js:2893-2894`）：视频数不能超过信件数 ——
  //   每段视频都挂在某封信上，比信还多说明这份清单是拼出来的。
  if (list.length > exchanges.length) fail(".soul 视频清单格式不正确");

  // 视频靠 `contentMd5` / `letterId` 认领自己的那封信（version 2 起 letterId 也用）。
  // ⇒ 这两个键必须**在信件清单里真的存在**，且**同一段只出现一次**；
  //   否则会出现「视频搬进来了、却没有任何一封信认领它」的孤儿视频。
  const exchangeHashes = new Set(exchanges.map((x) => x?.contentMd5).filter(Boolean).map(String));
  const exchangeIds = new Set(exchanges.map((x) => x?.letterId).filter(Boolean).map(String));
  const seenHashes = new Set();
  const seenIds = new Set();

  let offset = HEADER_BYTES + manifestBytes;
  for (const v of list) {
    if (!v || typeof v !== "object") fail(".soul 视频清单格式不正确");
    const contentMd5 = String(v.contentMd5 ?? "");
    const letterId = String(v.letterId ?? "");
    // ⚠️ 形状不对 / 认领不到信 / 重复认领 —— 三条都归「关联信息不正确」。
    //   只有当清单**根本没带** contentMd5 时才退回旧的宽松判据（旧版本导出没有这个键）。
    if (contentMd5 !== "" || v.contentMd5 !== undefined) {
      if (!MD5_RE.test(contentMd5) || !exchangeHashes.has(contentMd5) || seenHashes.has(contentMd5)) {
        fail(".soul 视频关联信息不正确");
      }
    }
    if (payload.version === 2 && letterId !== "" && (!exchangeIds.has(letterId) || seenIds.has(letterId))) {
      fail(".soul 视频信件 ID 不正确");
    }
    if (!Number.isSafeInteger(v.size) || v.size < 0) fail(".soul 视频清单格式不正确");
    // ★ 单段上限（DSH `server.js:2909` 用 `Number.isSafeInteger` + 512 MB）
    if (v.size < VIDEO_MIN_BYTES || v.size > maxVideoBytes) fail(".soul 视频大小不正确");
    videos.push({ offset, size: v.size, letterId: letterId || null, contentMd5: contentMd5 || null });
    if (contentMd5 !== "") seenHashes.add(contentMd5);
    if (letterId !== "") seenIds.add(letterId);
    offset += v.size;
  }
  // 收尾 offset 必须正好等于文件大小：有多余字节说明容器被改过，直接拒。
  if (offset !== view.size) fail(".soul 文件不完整");
  // 每段视频第 4..8 字节必须是 `ftyp`（MP4 盒子标识）
  for (const v of videos) {
    if (view.slice(v.offset + 4, v.offset + 8).toString("ascii") !== FTYP) fail(".soul 包含无效 MP4");
  }

  return { payload, videos, manifestBytes };
}
