/**
 * 数据备份与恢复 —— 纯函数模块（不碰 express、不碰 socket、不读环境变量以外的东西）。
 *
 * 照姊妹项目 `repo\source\local-service\midi\data-safety.js` 的三条硬约束做，
 * 那三条都是踩过坑才立的，一条都不能省：
 *
 * ① **恢复不热执行**。主连接是程序启动时 open、退出才 close 的，Windows 上这个文件
 *    被占着就覆盖不了。所以「恢复」只写一个待恢复标记 `pending-restore.json`，
 *    由**下次启动、打开连接之前**应用。界面上必须写「关掉程序再打开才生效」——
 *    不写这句，用户会以为点了没反应。
 *
 * ② **任何恢复/导入之前先把当前库整体留档**。永远是「留档成功才继续」：
 *    留档失败 = 没有退路 ⇒ 中止本次恢复、标记保留、下次启动再试。反过来（先覆盖再留档）
 *    一旦中途失败，用户既没有新库也没有旧库。
 *
 * ③ **导出包一律脱敏**。备份留完整（那是本机回滚用的，不外发），
 *    但导出包可能被分享、上传、发给别人 —— 里面的凭据必须先清掉。
 *
 * 另外两条是我方自己的情况：
 *  · 我们的库是 **journal_mode=delete**（实测现网 letters.sqlite，数据目录里只有
 *    `letters.sqlite` + 若干 `.bak`，没有 -wal/-shm）。所以复制主库就是完整的一份，
 *    不必像姊妹项目那样先 checkpoint WAL。★ 但**若将来改成 WAL，这里必须先 checkpoint**，
 *    否则备份里会漏掉最近的事务。留这条注释是为了改模式那天能看见。
 *  · 独立版没有 `.osfolder` 分享码那些东西，所以导出包里只有 README + manifest + 库本体。
 */

import { copyFile, rename, rm, stat, writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { ERR } from "./error-codes.mjs";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------- 常量

/** 备份文件名里那一串时间：`20261018-112233`。 */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 备份种类 → 人话。前缀与文件名编号一一对应，界面直接显示这一列。 */
export const BACKUP_KINDS = [
  ["backup-letter-import-", "导入信件前的自动备份"],
  ["backup-manual-", "手动备份"],
  ["backup-periodic-", "周期自动备份"],
  ["upgrade-backup-", "程序升级前的自动备份"],
  ["before-restore-", "恢复前留的当前库"],
];
export const PERIODIC_PREFIX = "backup-periodic-";
export const MANUAL_PREFIX = "backup-manual-";
/** 恢复/导入时落地的暂存在用的那一类（不是备份，别混进列表里当可用备份展示）。 */
export const STAGING_PREFIX = "import-";

export function kindLabel(file) {
  const name = basename(String(file ?? ""));
  for (const [prefix, label] of BACKUP_KINDS) if (name.startsWith(prefix)) return label;
  return "其它备份";
}

// ---------------------------------------------------------------- 周期备份配置

export const PERIODIC_ENABLED_SETTING = "periodic_backup_enabled";
export const PERIODIC_DAYS_SETTING = "periodic_backup_interval_days";
export const PERIODIC_KEEP_SETTING = "periodic_backup_keep";
export const DEFAULT_PERIODIC_DAYS = 1;
export const DEFAULT_PERIODIC_KEEP = 7;
export const MIN_PERIODIC_KEEP = 1;
export const MAX_PERIODIC_KEEP = 60;
export const MAX_PERIODIC_DAYS = 30;

/**
 * 读周期备份配置。
 * ★ 缺省是**开着**、每天一份：备份这件事的价值在于「出事那天它已经在」，
 *   需要用户先手动开启的功能，等于给 90% 的人没开。
 * ★ 只有明确写 0 / false / off / no 才算关 —— 别把空串或 "  "（用户清空输入框）
 *   当成关，那会让一次误删配置永久关掉备份。
 */
export function readPeriodicBackupConfig(readSetting) {
  const read = (key) => {
    try { return readSetting(key); } catch { return null; }
  };
  const rawEnabled = read(PERIODIC_ENABLED_SETTING);
  const enabled = rawEnabled === null || rawEnabled === undefined || rawEnabled === ""
    ? true
    : !["0", "false", "off", "no"].includes(String(rawEnabled).trim().toLowerCase());

  const days = clampInt(read(PERIODIC_DAYS_SETTING), 1, MAX_PERIODIC_DAYS, DEFAULT_PERIODIC_DAYS);
  const keep = clampInt(read(PERIODIC_KEEP_SETTING), MIN_PERIODIC_KEEP, MAX_PERIODIC_KEEP, DEFAULT_PERIODIC_KEEP);
  return { enabled, days, keep };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- 复制 / 留档

/** 复制主库到 dir 里的 name。**先写 .tmp 再改名**，避免半截文件被当成可用备份。 */
export async function copyDatabase(databasePath, dir, name) {
  if (!databasePath) throw fail(400, ERR.COMMON_BACKUP_DATABASE_MISSING, "找不到数据库文件的位置");
  if (!existsOrThrow(databasePath)) throw fail(404, ERR.COMMON_BACKUP_DATABASE_MISSING, "数据库文件不存在");
  const target = join(dir, name);
  const temp = `${target}.tmp`;
  await mkdir(dir, { recursive: true });
  await copyFile(databasePath, temp);
  await rename(temp, target);
  return target;
}

function existsOrThrow(p) {
  try {
    const s = statSyncSafe(p);
    return Boolean(s && s.isFile());
  } catch { return false; }
}

function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}

/** 手动备份。返回 {file, bytes, at}。 */
export async function manualBackup(databasePath) {
  const dir = dirname(databasePath);
  const at = Date.now();
  const name = `${MANUAL_PREFIX}${stamp()} .sqlite`.replace(" .", ".");
  const target = await copyDatabase(databasePath, dir, name);
  const s = await stat(target);
  return { file: basename(target), bytes: s.size, at };
}

// ---------------------------------------------------------------- 列表 / 检查

/**
 * 列出备份。
 * ★ 只认「名字以 .sqlite 结尾」的文件；`import-*`（恢复暂存）与 `pending-restore.json`
 *   不算备份 —— 把它们混进列表，用户会以为那是可以回退到的一个时间点。
 * ★★ 还要排除**正在用的那份主库**：它也躺在同一个目录里、也叫 .sqlite。
 *   一开始漏了这条，冒烟时列表第一篇就是 `letters.sqlite / 其它备份` ——
 *   用户点「恢复这一个」等于拿当前库覆盖自己，点「删除」更是当场把库删了。
 *   （deleteBackup 里另有一道 COMMON_BACKUP_IS_LIVE 兜底，但列表里就不该出现。）
 */
export async function listBackups(databasePath, { limit = 60 } = {}) {
  const dir = dirname(databasePath);
  const live = basename(resolve(databasePath));
  const entries = await safeReaddir(dir);
  const items = [];
  for (const name of entries) {
    if (!name.endsWith(".sqlite")) continue;
    if (name === live) continue;
    if (name.startsWith(STAGING_PREFIX)) continue;
    const full = join(dir, name);
    const s = statSyncSafe(full);
    if (!s || !s.isFile()) continue;
    items.push({ file: name, bytes: s.size, at: s.mtimeMs, kind: kindLabel(name) });
  }
  items.sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
  const total = items.length;
  const kept = items.slice(0, Math.max(0, limit));
  return {
    dir,
    total,
    bytes: items.reduce((n, x) => n + x.bytes, 0),
    items: kept,
    truncated: total > kept.length,
  };
}

async function safeReaddir(dir) {
  try { return await readdir(dir); } catch { return []; }
}

/**
 * 读一份备份的概览（不打开它、不当成主库用，只读一次数）。
 * ★ 这里用 `node:sqlite` 打开一个**只读**连接，读完立刻关：
 *   备份是用户的真实数据，只许看，绝不许在检查这一步写它。
 */
export async function inspectBackup(databasePath, file) {
  const target = backupPath(databasePath, file);
  const s = statSyncSafe(target);
  if (!s || !s.isFile()) throw fail(404, ERR.COMMON_BACKUP_NOT_FOUND, "这份备份不在了");
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(target, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const counts = {};
    for (const t of tables) {
      try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t.replace(/"/gu, '""')}"`).get().c; } catch { counts[t] = null; }
    }
    return {
      file: basename(target), bytes: s.size, at: s.mtimeMs, kind: kindLabel(target), tables: counts,
    };
  } catch (error) {
    throw fail(400, ERR.COMMON_BACKUP_INVALID, `这份备份打不开：${error.message}`);
  } finally {
    try { db?.close(); } catch { /* 已经关了 */ }
  }
}

// ---------------------------------------------------------------- 删除

/**
 * 删一份备份。
 * ★ 防线顺序不能换：先认文件名（只许 basename、只许 .sqlite）→ 再认它真在备份目录里
 *   → 再拒绝正在用的库与正在等待恢复的那一份 → 最后才删。
 *   少任何一道，`file=../../../某人的.sqlite` 就能删到目录外面去。
 */
export async function deleteBackup(databasePath, file, { pendingRestore = null } = {}) {
  const target = backupPath(databasePath, file);
  if (resolve(target) === resolve(databasePath)) {
    throw fail(400, ERR.COMMON_BACKUP_IS_LIVE, "这是正在用的那一份库，不能删");
  }
  if (pendingRestore && basename(target) === basename(pendingRestore)) {
    throw fail(400, ERR.COMMON_BACKUP_PENDING_RESTORE, "这份正在等待重启后恢复，不能删");
  }
  const s = statSyncSafe(target);
  if (!s || !s.isFile()) throw fail(404, ERR.COMMON_BACKUP_NOT_FOUND, "这份备份不在了");
  await rm(target, { force: true });
  return { file: basename(target) };
}

/**
 * 把外部传进来的名字收敛成备份目录里的一个路径。
 * ★ 「只接受备份目录里的文件」—— 这是所有按名字取文件的接口的**唯一**入口，
 *   包括只看内容的 inspect、要删的 delete、要恢复的 restore。
 */
export function backupPath(databasePath, raw) {
  const clean = basename(String(raw ?? ""));
  if (!clean || clean !== String(raw ?? "")) {
    throw fail(400, ERR.COMMON_BACKUP_NAME_INVALID, "备份文件名无效");
  }
  if (!clean.endsWith(".sqlite")) {
    throw fail(400, ERR.COMMON_BACKUP_NAME_INVALID, "备份文件名无效（必须是 .sqlite）");
  }
  const dir = dirname(databasePath);
  const target = resolve(dir, clean);
  const rel = relative(dir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw fail(400, ERR.COMMON_BACKUP_NAME_INVALID, "备份文件名无效");
  }
  return target;
}

// ---------------------------------------------------------------- 恢复（延后执行）

export function pendingRestorePath(databasePath) {
  return join(dirname(databasePath), "pending-restore.json");
}

export async function readPendingRestore(databasePath) {
  try {
    const text = await readFile(pendingRestorePath(databasePath), "utf8");
    const data = JSON.parse(text);
    if (!data || typeof data.source !== "string") return null;
    return data;
  } catch { return null; }
}

/**
 * 安排一次恢复：**只写标记，不动库**。
 * @returns {{source:string, label:string, at:number}}
 */
export async function arrangeRestore(databasePath, source, { label = "", origin = "backup" } = {}) {
  const dir = dirname(databasePath);
  const abs = resolve(source);
  if (dirname(abs) !== resolve(dir)) {
    // 只从数据目录里取源：恢复的来源要么是备份，要么是我们自己刚从上传里落下的暂存。
    throw fail(400, ERR.COMMON_BACKUP_NAME_INVALID, "恢复来源不在数据目录里");
  }
  if (!existsOrThrow(abs)) throw fail(404, ERR.COMMON_BACKUP_NOT_FOUND, "要恢复的那一份不在了");
  const record = { source: basename(abs), label: String(label || basename(abs)), origin, at: Date.now() };
  await writeFile(pendingRestorePath(databasePath), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function cancelRestore(databasePath) {
  await rm(pendingRestorePath(databasePath), { force: true });
  return { cancelled: true };
}

/**
 * 真正执行待恢复。**只能在「打开主连接之前」调**（server.mjs 启动流程里那一步）。
 *
 * 顺序：读标记 → 确认源在 → 把当前库改名留档（失败即中止）→ 把源复制过来 → 清标记。
 * 每一步失败都返回一个 reason，不抛：启动流程不能因为一次恢复失败就起不来，
 * 但也**不许静默**——调用方要把 reason 写进日志。
 */
export async function applyPendingRestore(databasePath, { log = () => {} } = {}) {
  const record = await readPendingRestore(databasePath);
  if (!record) return { applied: false, reason: "none" };
  const dir = dirname(databasePath);
  const source = join(dir, record.source);
  if (!existsOrThrow(source)) {
    await rm(pendingRestorePath(databasePath), { force: true });
    log(`待恢复的来源不见了（${record.source}），本次跳过并已清掉标记`);
    return { applied: false, reason: "missing" };
  }

  // ① 先把当前库整体留档。留档失败 = 没有退路 ⇒ 中止，标记保留，下次启动再试。
  if (existsOrThrow(databasePath)) {
    const keep = join(dir, `before-restore-${stamp()}.sqlite`);
    try {
      await rename(databasePath, keep);
    } catch (error) {
      log(`恢复前留档失败，本次中止（标记保留）：${error.message}`);
      return { applied: false, reason: "keep-failed", error: error.message };
    }
    log(`恢复前已把当前库留档为 ${basename(keep)}`);
  }

  // ② 主库在 delete 日志模式下没有 -wal/-shm；万一有（将来改了模式或上次异常退出），
  //    它们属于**旧库**，不能让它们配着新库被读 —— 先删掉。
  for (const sidecar of ["-wal", "-shm"]) {
    try { await rm(databasePath + sidecar, { force: true }); } catch { /* 删不掉就下次再说 */ }
  }

  // ③ 换上新库。
  try {
    await copyFile(source, databasePath);
  } catch (error) {
    log(`恢复失败（源：${record.source}）：${error.message}`);
    return { applied: false, reason: "copy-failed", error: error.message };
  }

  await rm(pendingRestorePath(databasePath), { force: true });
  log(`已按 ${record.label} 恢复`);
  return { applied: true, from: record.source, label: record.label };
}

// ---------------------------------------------------------------- 导出（脱敏）

export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const EXPORT_KIND = "linli-letters-userdata";

/**
 * 把 settings 里的凭据清空（就地改）。
 * ★ 四条正则对应四种真实存法：JSON 里的 "apiKey":"…"、env 风格的 API_KEY=…、
 *   裸的 sk-… 片段、Authorization: Bearer …。少一条就等于导出包里还带着 Key。
 */
export function scrubCredentials(value) {
  if (typeof value !== "string") return { value, removed: 0 };
  let removed = 0;
  const rules = [
    [/("apiKey"\s*:\s*")[^"]*(")/gu, "$1$2"],
    [/((?:API_KEY|api_key|apiKey)\s*[=:]\s*)[^\s;,"'}]+/gu, "$1"],
    [/\b(sk-[A-Za-z0-9_-]{8,})\b/gu, "<已移除>"],
    [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gu, "$1<已移除>"],
  ];
  let out = value;
  for (const [re, rep] of rules) {
    out = out.replace(re, (...args) => { removed += 1; return rep.replace(/\$(\d)/gu, (_, i) => args[Number(i)] ?? ""); });
  }
  return { value: out, removed };
}

/** 导出：README + manifest + 脱敏后的库。返回 { zip:Buffer, manifest }。 */
export async function exportUserData(databasePath, { version = "0.0.0" } = {}) {
  const dir = dirname(databasePath);
  if (!existsOrThrow(databasePath)) throw fail(404, ERR.COMMON_BACKUP_DATABASE_MISSING, "数据库文件不存在");
  const temp = join(dir, `export-snapshot-${stamp()}.sqlite`);
  await copyFile(databasePath, temp);
  let manifest;
  let credentialsRemoved = 0;
  try {
    // 在快照上脱敏（绝不动主库）。
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(temp);
    try {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      const upd = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
      for (const row of rows) {
        const { value, removed } = scrubCredentials(String(row.value ?? ""));
        if (removed > 0) { upd.run(value, row.key); credentialsRemoved += removed; }
      }
      const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { return 0; } };
      manifest = {
        kind: EXPORT_KIND,
        version,
        exportedAt: new Date().toISOString(),
        counts: { letters: count("letters"), songs: count("songs"), ledger: count("ledger") },
        credentialsRemoved,
        note: "只含用户数据（信件、曲库条数、账本、设置），不含曲库里的音视频文件，不含 API Key。",
      };
    } finally {
      try { db.close(); } catch { /* 已关 */ }
    }
    const dbBytes = await readFile(temp);
    const readme = [
      "OliviaSoul-community 独立版 · 用户数据导出包",
      "",
      `导出时间：${manifest.exportedAt}`,
      `程序版本：${version}`,
      `信件 ${manifest.counts.letters} 封 · 曲目 ${manifest.counts.songs} 首 · 账本 ${manifest.counts.ledger} 条`,
      credentialsRemoved ? `已移除 ${credentialsRemoved} 处凭据` : "没有检测到凭据",
      "",
      "怎么用：",
      "1. 打开程序 → 设置 → 数据备份与恢复 → 一键导入，选这个 zip；",
      "2. 关掉程序再打开 —— 导入只在下次启动时生效（当前这份库会先自动留档）；",
      "3. 恢复前留的那份在数据目录里，名字以 before-restore- 开头。",
      "",
      "不含什么：曲库里的音频/视频文件本身（只记路径）、API Key。",
    ].join("\n");
    const files = [
      { name: "README.txt", data: Buffer.from(readme, "utf8") },
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
      { name: "database/letters.sqlite", data: dbBytes },
    ];
    const zip = makeZip(files);
    if (zip.length > MAX_EXPORT_BYTES) {
      throw fail(413, ERR.COMMON_EXPORT_TOO_LARGE, "导出包太大了（超过 512 MB）");
    }
    return { zip, manifest };
  } finally {
    await rm(temp, { force: true });
  }
}

// ---------------------------------------------------------------- 导入

export const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

/**
 * 导入一个导出包：解出 `database/letters.sqlite` → 落成暂存 → 安排恢复。
 * ★ 导入**不是**「直接把包里的库覆盖上去」：它走的是和「恢复某一份备份」同一条延后路径，
 *   所以同样享有「先留档、重启生效」那两道保险。
 */
export async function importUserData(databasePath, buffer, { name = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw fail(400, ERR.IMPORT_FILE_REQUIRED, "没有收到文件");
  }
  if (buffer.length > MAX_IMPORT_BYTES) throw fail(413, ERR.IMPORT_TOO_LARGE, "导入包太大了（超过 1 GB）");
  const clean = basename(String(name ?? ""));
  if (clean && !clean.toLowerCase().endsWith(".zip")) {
    throw fail(400, ERR.IMPORT_NAME_INVALID, "导入包必须是 .zip");
  }
  let entries;
  try {
    entries = unzipEntries(buffer);
  } catch (error) {
    throw fail(400, ERR.IMPORT_ZIP_INVALID, `这个 zip 打不开：${error.message}`);
  }
  if (!entries.size) throw fail(400, ERR.IMPORT_ZIP_EMPTY, "这个 zip 里没有文件");
  const dbEntry = entries.get("database/letters.sqlite") ?? entries.get("database/olivia-local.sqlite");
  if (!dbEntry) {
    throw fail(400, ERR.IMPORT_LAYOUT_INVALID, "导入包里没有 database/letters.sqlite（不是本程序导出的包）");
  }
  let manifest = null;
  const manifestEntry = entries.get("manifest.json");
  if (manifestEntry) {
    try { manifest = JSON.parse(manifestEntry.toString("utf8")); } catch { manifest = null; }
  }
  const dir = dirname(databasePath);
  const staged = join(dir, `${STAGING_PREFIX}${stamp()}.sqlite`);
  await mkdir(dir, { recursive: true });
  await writeFile(staged, dbEntry);
  const label = manifest?.exportedAt ? `导出包（${manifest.exportedAt}）` : "导入的导出包";
  const record = await arrangeRestore(databasePath, staged, { label, origin: "import" });
  return { staged: basename(staged), pending: record, manifest };
}

// ---------------------------------------------------------------- 最小 zip 读写

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 打一个只含「存储/deflate」两种方法的 zip（不引第三方库，测试里也好对）。 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date（1980-01-01，只要能读就行）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** 解 zip，返回 Map<name, Buffer>。单条坏了跳过（一个包里有 README 读不出来不该整个失败）。 */
export function unzipEntries(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const start = buffer.readUInt32LE(eocd + 16);
  const out = new Map();
  let p = start;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    p += 46 + nameLength + extraLength + commentLength;
    try {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch { /* 单条坏了跳过 */ }
  }
  return out;
}

function findEocd(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xFFFF; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是 zip 文件");
}

// ---------------------------------------------------------------- 小工具

/** 统一的错误形状：带 HTTP 状态与错误号，server.mjs 那边直接照抄成响应。 */
export function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
