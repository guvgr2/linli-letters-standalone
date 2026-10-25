// 官方曲目封面的取用层。
//
// ★ 口径（2026-10-19）：封面**随包**。用户明确要求「随包，必须随包」——
//   129 张已经缩成 256×256 JPEG（合计约 1.8 MB）放在 `app\covers\<sha1前16>.jpg`，
//   清单是 `app\covers\manifest.json`（`{ "<曲目目录名>": { cover, composer, duration } }`），
//   由 `analysis\_covers\_export.py` 从本机原版客户端的下载缓存里一次性导出。
//
// ★ 版权提醒（留给发布者自己判断，不再由代码替用户做决定）：
//   这批图不是米哈游原创插画 —— 古典 48 首里 31 张是第三方厂牌专辑封面
//   （Debussy Rêverie 带「CLASSICAL COLLECTIONS」牌匾 + CD 边缘），ACG 组多为 AI 风人像，
//   24 张带 C2PA 的 trainedAlgorithmicMedia 声明。详见 `analysis\_covers\封面调查.md`。
//   随包分发等于把它们连同程序一起再分发 —— 这是**产品/法务决定**，用户已决定随包。
//
// ★ 兜底一：随包清单里找不到（老版本残留、用户删了文件）时，再去本机原版游戏的
//   Chromium 缓存里按 URL 找一份（只读、不复制）。缓存里那条映射没有明文表，
//   只能按实测反推的 blockfile 字段偏移读：
//     data_1 中每条 EntryStore 记录以 `1/0/_dk_` 开头（记其偏移 K）
//       K-64 = key 长度        K-56 = stream0 大小      K-52 = 响应体字节数
//       K-40 = stream0 地址    K-36 = 响应体地址（低 31 位 = f_ 文件号）
//   实测 142/142 条大小自校验通过、129 条 resSong 记录命中 129 个互不相同的文件。
//   两处都没有 ⇒ 界面退回首字母块。
//
// ★ 本模块对缓存目录**只读**：只 stat/read，从不写。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 随包封面目录：`{app}\covers\`（server.mjs 也在 {app}\app\ 下，所以往上一级）。 */
const BUNDLED_DIR = join(HERE, "covers");

let _bundled = null;
/** 随包清单：`{ 曲目目录名: { cover, composer, duration } }`。没有就空表。 */
export function bundledManifest() {
  if (_bundled) return _bundled;
  try {
    _bundled = JSON.parse(readFileSync(join(BUNDLED_DIR, "manifest.json"), "utf8"));
  } catch {
    _bundled = {};   // 没随包 / 读坏了：不影响曲库，只是没有封面
  }
  return _bundled;
}

/** 随包里有没有这一首的封面；有就回绝对路径（只认清单里的文件名，防止路径拼出目录外）。 */
export function bundledCoverFile(songDir) {
  const meta = bundledManifest()[String(songDir ?? "")];
  const name = meta?.cover;
  if (!name || !/^[a-f0-9]{16}\.jpg$/u.test(name)) return null;
  const file = join(BUNDLED_DIR, name);
  return existsSync(file) ? file : null;
}

/** CEF 缓存可能落在的几个位置（按常见程度排）。只认存在的那一个。 */
function cacheCandidates() {
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return [
    join(roaming, "miHoYo", "Olivia-steam", "cache", "web", "Default", "Cache", "Cache_Data"),
    join(local, "miHoYo", "Olivia-steam", "cache", "web", "Default", "Cache", "Cache_Data"),
  ];
}

/** 找到缓存目录（含 data_1 与 f_* 文件才认）。没有就 null。 */
export function coverCacheDir() {
  for (const dir of cacheCandidates()) {
    try {
      if (statSync(join(dir, "data_1")).isFile()) return dir;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * 把缓存里所有 `/resSong/<段>/<文件名>` 响应解成「段 → 本地文件路径」。
 * ★ 段的含义就是曲目目录名（原版拿它当 URL 路径段），所以直接可以当键用。
 * @returns {Map<string, string>} 段 → f_ 文件的绝对路径（键做了小写归一）
 */
export function coverIndex() {
  const dir = coverCacheDir();
  const map = new Map();
  if (!dir) return map;
  let buf;
  try { buf = readFileSync(join(dir, "data_1")); } catch { return map; }

  // f_ 文件按编号建索引：低 31 位就是编号。
  const files = new Map();
  try {
    for (const name of readdirSync(dir)) {
      if (!/^f_[0-9a-f]{6}$/u.test(name)) continue;
      files.set(Number.parseInt(name.slice(2), 16), join(dir, name));
    }
  } catch { return map; }

  const marker = Buffer.from("1/0/_dk_", "latin1");
  for (let k = buf.indexOf(marker); k !== -1; k = buf.indexOf(marker, k + 1)) {
    if (k < 68) continue;
    const keyLen = buf.readUInt32LE(k - 64);
    const bodySize = buf.readUInt32LE(k - 52);
    const bodyAddr = buf.readUInt32LE(k - 36);
    const fileNo = bodyAddr & 0x7fffffff;
    const file = files.get(fileNo);
    if (!file) continue;
    try {
      // ★ 自校验：文件大小必须等于记录里的响应体大小，否则说明偏移没对上。
      if (statSync(file).size !== bodySize) continue;
    } catch { continue; }
    const key = buf.subarray(k, Math.min(buf.length, k + Math.max(keyLen, 512))).toString("latin1");
    const hit = key.match(/\/resSong\/([^?\s"'\\]+)\/[^/?#\s"']+\.(?:jpg|jpeg|png|webp)/iu);
    if (!hit) continue;
    map.set(decodeURIComponent(hit[1]).toLowerCase(), file);
  }
  return map;
}

/** 归一化：去掉标点/空白/书名号，小写。用来兜住"封面用中文标题当路径段"的那几首。 */
export function normalizeKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s"'`《》〈〉「」『』（）()[\]{}<>·:：;；,.，。!！?？\-_—–~～/\\|]+/gu, "");
}

/**
 * 给一首曲子找封面文件。
 * 匹配顺序：① 目录名逐字相等（126/129 首）② 归一化标题相等（3 首 ACG 用中文标题当路径段）。
 * @param {string} songDir 曲目目录名（= 原版 URL 路径段）
 * @param {string} title 显示用曲名（songDisplayName 的结果）
 * @returns {string|null} 本地图片绝对路径
 */
export function coverFileFor(index, songDir, title) {
  // ① 随包封面优先：它跟程序一起装上，任何机器上都有。
  const bundled = bundledCoverFile(songDir);
  if (bundled) return bundled;
  // ② 随包没有再看本机原版缓存（只读兜底）。
  if (!index || !index.size) return null;
  const direct = index.get(String(songDir ?? "").toLowerCase());
  if (direct) return direct;
  const want = normalizeKey(title);
  if (!want) return null;
  for (const [key, file] of index) {
    if (normalizeKey(key) === want) return file;
  }
  return null;
}

/** 读文件头判 MIME：缓存里后缀全写 .jpg，但 50 张实际是 PNG、1 张是 WebP。 */
export function imageMime(head) {
  if (!head || head.length < 12) return "application/octet-stream";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  const riff = head.toString("latin1", 0, 4) === "RIFF";
  const webp = head.toString("latin1", 8, 12) === "WEBP";
  if (riff && webp) return "image/webp";
  return "application/octet-stream";
}

/** 只给个文件名（日志/调试用）。 */
export function coverName(file) {
  return file ? basename(file) : null;
}

export { existsSync };
