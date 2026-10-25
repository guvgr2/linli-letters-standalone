// 维护功能：数据搬家 / 一键诊断包 / 问题反馈。
//
// 为什么单独一个文件：这三件事都是「不出事不会碰、出了事必须在」的功能，
// 但它们的代码量比它们在设置页里占的地方大得多（扫描磁盘、读别人的库、
// 打 zip、拼 issue 正文）。放在 server.mjs 里会把那条已经很长的路由链再撑大一截。
//
// ★ 三条硬规则（都有代价，别随手改）：
//   1) 数据搬家只认「自己扫出来的候选」，不接受前端传来的任意路径 —— 否则这就是一个
//      往任意目录写 files 的接口。apply 时**重新**扫一遍再比对，不信任上一次的结果。
//   2) 复制前先给当前库留一份快照。搬家是覆盖，没有退路的功能没人敢点。
//   3) 诊断包只带日志与运行信息，绝不带信件正文、记忆账本、曲库清单、音视频。
//      用户点得下去，才谈得上让他把包发出来。
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { homedir, platform, release, arch } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ERR } from "./error-codes.mjs";
import { makeZip, arrangeRestore, scrubCredentials, stamp } from "./data-safety.mjs";

/** 本程序的库文件名。候选目录里出现它，才算「另一个本程序的安装」。 */
export const DB_NAME = "letters.sqlite";
/** 原版程序的库文件名。跟着一起认，是因为老用户很可能是从那边搬过来的。 */
const SIBLING_DB = join("database", "olivia-local.sqlite");

/** 目录名里带这些词的才值得进去看一眼，不然扫盘会把每个文件夹都读一遍。 */
// ★ 判据是「这个目录里有没有库文件」，不是「目录名像不像本程序」：
//   便携包会被用户改名成任何东西（E:\LinliLetters、E:\林离的信、E:\备份\旧版…），
//   按名字筛必然漏。按库文件筛也天然把空壳目录挡在外面。

/** 固定盘符：A/B 是软驱位，跳过；网络盘不扫（枚举一次可能卡几十秒）。 */
function fixedDrives() {
  const out = [];
  for (let i = 67; i <= 90; i += 1) {
    const root = `${String.fromCharCode(i)}:\\`;
    try {
      if (existsSync(root)) out.push(root);
    } catch {
      /* 光驱空位、权限不足：跳过 */
    }
  }
  return out;
}

/** 只读打开别人的库读两个数：多少首、库里有没有那段设置。读不出来不算致命。 */
function describeDatabase(dbPath) {
  const info = { songCount: 0, letterCount: 0, libraryRoot: "", error: "" };
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      info.songCount = Number(db.prepare("SELECT COUNT(*) AS c FROM songs").get()?.c ?? 0);
    } catch {
      /* 原版程序的表可能叫 user_songs：那边没有 songs 表就当 0 首 */
    }
    try {
      info.letterCount = Number(db.prepare("SELECT COUNT(*) AS c FROM letters").get()?.c ?? 0);
    } catch {
      /* 同上 */
    }
    try {
      info.libraryRoot = String(db.prepare("SELECT value FROM settings WHERE key='library_dir'").get()?.value ?? "");
    } catch {
      info.libraryRoot = "";
    }
  } catch (error) {
    info.error = String(error?.message ?? error).slice(0, 160);
  } finally {
    try {
      db?.close();
    } catch {
      /* 已经关掉了 */
    }
  }
  return info;
}

/**
 * 扫本机旧版本（其它安装）的数据目录，供「数据搬家」搬进当前程序。
 * ★ 方向口径（2026-10-20 用户原话）：搬家 = 把以前旧版本的数据搬进来，
 *   不是把现在的数据搬到别处 —— 这条只负责「找来源」，永远不往外写。
 * 只扫「盘根下一层」（A:\ 下的每个文件夹），不递归 —— 全盘递归在机械盘上能跑几分钟，
 * 用户会以为程序卡死。命中目录名像本程序的，再看它自己 / 它的 UserData 里有没有库。
 *
 * @param {object} [opts]
 * @param {string} opts.dataDir 当前正在用的数据目录（永远排在结果第一行）
 * @param {number} [opts.budgetMs] 扫盘时间上限，超了就不再往下看
 * @param {string[]} [opts.roots] 要扫的根，缺省=本机所有固定盘；测试传临时目录
 * @param {string[]} [opts.roamingRoots] 要扫的 Roaming 根，缺省=当前用户的
 */
export async function detectCandidates({ dataDir, budgetMs = 1500, roots = fixedDrives(), roamingRoots = [join(homedir(), "AppData", "Roaming")] } = {}) {
  const started = Date.now();
  const current = resolve(dataDir);
  const found = new Map();

  const consider = (dir) => {
    const abs = resolve(dir);
    if (found.has(abs.toLowerCase())) return;
    if (existsSync(join(abs, DB_NAME)) || existsSync(join(abs, SIBLING_DB))) found.set(abs.toLowerCase(), abs);
  };

  // 1) 当前数据目录永远在列表里（标成「正在使用」），用户才知道自己在搬什么。
  consider(current);
  // 2) Roaming 下同级的兄弟目录（同一台机器装过好几个版本时最常见）。
  for (const roaming of roamingRoots) {
    if (Date.now() - started > budgetMs) break;
    try {
      for (const name of await readdir(roaming)) {
        if (Date.now() - started > budgetMs) break;
        consider(join(roaming, name));
      }
    } catch {
      /* 读不到 Roaming 就算了，不影响扫盘 */
    }
  }
  // 3) 盘根下一层：便携包解压在哪个盘都能找到。
  //    roots 可传：测试不该去扫整台机器（也会撞上用户真实的其它安装）。
  for (const root of roots) {
    if (Date.now() - started > budgetMs) break;
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() - started > budgetMs) break;
      if (!entry.isDirectory()) continue;
      const base = join(root, entry.name);
      // 两种常见摆法：库就在这个目录里（E:\林离的信），或包一层 UserData
      // （E:\LinliLetters\UserData）。existsSync 两次，代价可以忽略。
      consider(base);
      consider(join(base, "UserData"));
    }
  }

  const items = [];
  for (const dir of found.values()) {
    const item = {
      path: dir,
      exists: false,
      isCurrent: dir.toLowerCase() === current.toLowerCase(),
      sizeBytes: 0,
      songCount: 0,
      letterCount: 0,
      libraryRoot: "",
      error: "",
    };
    const dbPath = [join(dir, DB_NAME), join(dir, SIBLING_DB)].find((p) => existsSync(p));
    if (dbPath) {
      item.exists = true;
      try {
        item.sizeBytes = (await stat(dbPath)).size;
      } catch {
        /* 读不到大小不影响别的 */
      }
      Object.assign(item, describeDatabase(dbPath));
    }
    items.push(item);
  }

  // 当前这份永远排最前，其余按「有多少信」降序 —— 用户找的是他那份旧数据。
  items.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.letterCount - a.letterCount);
  return { items, scannedMs: Date.now() - started, current };
}

/** 把 Windows 的文件占用错误翻成人话。搬家最常见的失败就是「那边的程序还开着」。 */
function describeCopyError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error);
  if (["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(code) || /sharing violation|另一个程序正在使用|being used/iu.test(message)) {
    return "文件正被另一个程序占用：请完全退出那边的程序（含托盘图标）再试。";
  }
  return message.slice(0, 200);
}

/**
 * 把候选目录里的库搬过来。
 * ★ 目标必须是本次重新扫出来的候选之一：前端传来的路径只当「键」用，不当路径用。
 * ★ 不直接覆盖正在用的那个库 —— 本进程正握着它（SQLite 连接还开着），
 *   在 Windows 上覆盖会被共享锁挡下（EBUSY）。所以走仓库已有的那条路：
 *   源库先落到数据目录里当暂存 → arrangeRestore 写标记 → 下次启动才真正替换。
 *   那条路径顺带自带「先把当前库留档」这一步（applyPendingRestore 里做）。
 */
export async function applyMigration({ sourcePath, dataDir, dbFile, scan = {} } = {}) {
  const wanted = String(sourcePath ?? "").trim();
  if (!wanted) {
    return { ok: false, status: 400, code: ERR.COMMON_MIGRATE_SOURCE_REQUIRED, message: "请指定要搬过来的数据目录" };
  }
  const detected = await detectCandidates({ dataDir, budgetMs: 3000, ...scan });
  const match = detected.items.find((it) => resolve(it.path).toLowerCase() === resolve(wanted).toLowerCase() && it.exists);
  if (!match) {
    return { ok: false, status: 400, code: ERR.COMMON_MIGRATE_SOURCE_NOT_DETECTED, message: "这个目录不在本机探测结果里，拒绝复制" };
  }
  if (match.isCurrent) {
    return { ok: false, status: 400, code: ERR.COMMON_MIGRATE_SOURCE_IS_CURRENT, message: "这就是当前正在使用的数据目录" };
  }

  const sourceDb = [join(match.path, DB_NAME), join(match.path, SIBLING_DB)].find((p) => existsSync(p));
  if (!sourceDb) {
    return { ok: false, status: 400, code: ERR.COMMON_MIGRATE_NOTHING_TO_COPY, message: "对方目录里没有可复制的数据库文件" };
  }

  const targetDir = resolve(dataDir);
  await mkdir(targetDir, { recursive: true });
  // 上一次搬完（或搬到一半放弃）留下的暂存文件先清掉：它们只对那一次 pending 有效，
  // 攒着只会在用户的数据目录里堆出一串没人认领的 .sqlite。
  try {
    for (const name of await readdir(targetDir)) {
      if (!/^import-migrate-.*\.sqlite(?:-wal)?$/u.test(name)) continue;
      await rm(join(targetDir, name), { force: true });
    }
  } catch {
    /* 清不掉不影响这次搬家（新的暂存名带秒级时间戳，撞不上） */
  }
  // 暂存名沿用仓库里的 import- 前缀：它是「从外面拿进来、等下次启动生效」的那一类，
  // 恢复流程、备份列表、清理逻辑都已经认得它，不必再造一套。
  const staged = join(targetDir, `import-migrate-${stamp()}.sqlite`);
  try {
    await copyFile(sourceDb, staged);
  } catch (error) {
    return { ok: false, status: 409, code: ERR.COMMON_MIGRATE_SOURCE_LOCKED, message: `读不到对方的数据库：${describeCopyError(error)}` };
  }

  // -wal 里可能有没并回主库的提交，带上它暂存文件才是「对方最后一次关程序时的样子」。
  // -shm 永远不带：它只是本机进程间的共享映射，拷过来只会把两边配错。
  const skipped = ["-shm（本程序会自己重建）"];
  let warning = "";
  if (existsSync(`${sourceDb}-wal`)) {
    try {
      await copyFile(`${sourceDb}-wal`, `${staged}-wal`);
    } catch {
      skipped.push("-wal");
      warning = "对方的数据库正被另一个程序占用，最近一次改动可能不在搬过来的库里。建议完全退出那边的程序后重试。";
    }
  }

  try {
    const record = await arrangeRestore(resolve(dbFile), staged, {
      label: `数据搬家：${basename(match.path)}`,
      origin: "migrate",
    });
    return {
      ok: true,
      source: match.path,
      target: targetDir,
      staged: basename(staged),
      pending: record,
      skipped,
      warning,
      letterCount: match.letterCount,
      songCount: match.songCount,
      note: "关掉程序再打开才生效",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      code: ERR.COMMON_INTERNAL,
      message: `安排替换失败：${String(error?.message ?? error).slice(0, 160)}`,
    };
  }
}

/** 诊断包里允许出现的东西：只有文件名与内容，内容一律脱敏。 */
async function readTail(file, maxBytes) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const handle = await readFile(file);
    const buf = handle.length > maxBytes ? handle.subarray(handle.length - maxBytes) : handle;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 打包一份诊断包。
 * ★ 白名单式收集：只读下面这几个明确的文件/字段，不做「遍历数据目录找东西」——
 *   数据目录里有 letters.sqlite（信件正文）与账本，遍历迟早会把它们带进包里。
 */
export async function buildDiagnosticPackage({ dataDir, dbFile, version, about = {} } = {}) {
  const entries = [];
  const dir = resolve(dataDir);

  const info = {
    version,
    exportedAt: new Date().toISOString(),
    platform: `${platform()} ${release()} ${arch()}`,
    node: process.versions.node,
    dataDir: scrubPath(dir),
    libraryDir: scrubPath(about.libraryDir),
    assetsDir: about.assetsDir ? scrubPath(about.assetsDir) : null,
    databaseBytes: 0,
    databasePresent: existsSync(dbFile),
  };
  try {
    info.databaseBytes = statSync(dbFile).size;
  } catch {
    /* 没有库就当 0 */
  }
  // 脱敏：这里的字段都来自设置，Key 之类一律抹掉（scrubCredentials 是全仓唯一口径）。
  const cleanInfo = scrubCredentials(JSON.stringify(info, null, 2)).value;
  entries.push({ name: "info.json", data: Buffer.from(cleanInfo, "utf8") });

  // 日志：外壳的 shell.log（崩溃与关键事件）+ 服务端 server.log（如果外壳在写）。
  // ★ 2026-10-19 修（七轮审查 F6）：日志里带着启动行 `LINLI_DATA=C:\Users\<用户名>\…`，
  //   而诊断包的用途就是贴到公开 issue 上 ⇒ 用户名会跟着公开。路径先收敛、再脱敏凭据。
  for (const name of ["shell.log", "server.log"]) {
    const text = await readTail(join(dir, name), 512 * 1024);
    if (text != null) entries.push({ name, data: Buffer.from(scrubPath(scrubCredentials(text).value), "utf8") });
  }

  // 备份与字体只报「有几个、多大」，不带内容：用户的东西不该为了排查被打包出去。
  const listing = { backups: [], fonts: [] };
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith("backup-") && name.endsWith(".sqlite")) {
        try {
          listing.backups.push({ name, bytes: statSync(join(dir, name)).size });
        } catch {
          /* 读不到大小就不列 */
        }
      }
    }
  } catch {
    /* 目录读不了，info.json 里已经有 dataDir 了 */
  }
  try {
    const fontsDir = join(dir, "fonts");
    for (const name of await readdir(fontsDir)) {
      try {
        listing.fonts.push({ name, bytes: statSync(join(fontsDir, name)).size });
      } catch {
        /* 同上 */
      }
    }
  } catch {
    /* 没装字体就没有这个目录 */
  }
  entries.push({ name: "files.json", data: Buffer.from(JSON.stringify(listing, null, 2), "utf8") });

  const buffer = makeZip(entries);
  // ★ 2026-10-19 审查 N3：文件名原来只精确到秒（`stamp()`）。两个并发请求在同一秒里
  //   会算出同一个名字，Windows 上"两个进程同时 open 同一个新建文件"会直接给 EPERM，
  //   于是其中一路 500，还把英文 errno 原样吐给用户（压测 10 分钟能出 8 次）。
  //   现在名字里带 3 字节随机后缀 + 用 `wx`（存在即失败）让撞名变成可重试的确定行为，
  //   重试换的是**新名字**，不是同一个名字硬撞。
  let outPath = "";
  let fileName = "";
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fileName = `oliviasoul-community-diagnostic-${stamp()}-${randomBytes(3).toString("hex")}.zip`;
    outPath = join(dir, fileName);
    try {
      await writeFile(outPath, buffer, { flag: "wx" });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const code = String(error?.code ?? "");
      // 撞名（EEXIST）和 Windows 上的同名并发（EPERM/EACCES）都值得换个名字再试；
      // 磁盘满、目录不可写这类重试也不会好，直接抛。
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") break;
    }
  }
  if (lastError) {
    // 不给用户看 errno：他要做的是"把诊断包发给作者"，不是读懂 EPERM。
    const error = new Error("诊断包没写成（文件可能正被占用，或数据目录不可写）");
    error.cause = lastError;
    throw error;
  }
  await pruneDiagnostics(dir);
  return {
    file: outPath,
    name: fileName,
    bytes: buffer.length,
    entries: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
  };
}

/** 数据目录里最多留几份诊断包 —— 多了就是垃圾（审查方测试时一次堆了 37 个）。 */
export const DIAG_KEEP = 5;

/**
 * 把本机路径里的**用户名**收成 `<user>`（2026-10-19 修 F6）。
 * ★ 为什么必须收敛：诊断包的用法就是附到公开的 GitHub issue 上，
 *   而 `C:\Users\<user>\…` 等于把 Windows 账户名一起公开了。
 * ★ 只收用户名这一段，**保留**盘符与目录结构：排查"是不是数据目录没权限/曲库路径不对"
 *   时，盘符和层级正是有用信息。
 * ★ 同时认 Windows（`X:\Users\名`）与 POSIX（`/home/名`、`/Users/名`），
 *   免得将来跨平台时代码默默失效。
 */
export function scrubPath(value) {
  if (value == null || value === "") return value ?? "";
  return String(value)
    // ★ 盘符可有可无都要认：审查方的夹具把数据目录放在 `%TEMP%\…\Users\alice\…` 这样的路径下，
    //   只匹配 `X:\Users\` 的话第二段 `\Users\alice` 会漏掉（实测就是这么漏的）。
    .replace(/((?:[A-Za-z]:)?[\\/]Users[\\/])[^\\/\s]+/gu, "$1<user>")
    .replace(/(\/(?:home)\/)[^/\s]+/gu, "$1<user>");
}

/**
 * 删掉旧的诊断包，只留最新的 keep 份。
 * ★ 只碰 `oliviasoul-community-diagnostic-*.zip` 这一个模式，其它文件一概不碰。
 * ★ 删不掉不算失败：本次导出已经成功，清理是顺手的事，不该把它变成一次报错。
 */
export async function pruneDiagnostics(dir, keep = DIAG_KEEP) {
  const target = resolve(dir);
  let names;
  try {
    names = await readdir(target);
  } catch {
    return { removed: 0 };
  }
  const mine = [];
  for (const name of names) {
    if (!name.startsWith("oliviasoul-community-diagnostic-") || !name.endsWith(".zip")) continue;
    try {
      mine.push({ name, mtime: (await stat(join(target, name))).mtimeMs });
    } catch {
      /* 刚好被别处删了 */
    }
  }
  mine.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const { name } of mine.slice(keep)) {
    try {
      await rm(join(target, name), { force: true });
      removed += 1;
    } catch {
      /* 正在被打开就留着，下次再说 */
    }
  }
  return { removed };
}

/** 诊断包里会出现哪些东西（先看内容再导出）。 */
export function diagnosticContents({ dataDir, dbFile } = {}) {
  const dir = resolve(dataDir);
  const names = ["info.json", "files.json"];
  for (const name of ["shell.log", "server.log"]) {
    if (existsSync(join(dir, name))) names.push(name);
  }
  return {
    // ★ 2026-10-25 修（压测 D4 实测泄漏）：这里的 dir 原本是**原样**吐出去的
    //   （实测返回形如 `C:\Users\<用户名>\AppData\Local\Temp\...` 的完整本机路径），
    //   而下面 excludes 又白纸黑字承诺「本机路径里的用户名会写成 <user>」—— 说到没做到，
    //   而且这份清单正是**要附到公开 GitHub issue 上**的东西，等于把 Windows 账户名公开出去。
    //   ★ 注：注释里也不许写真用户名（源码不随包发，但仓库是公开的）。
    //   判据：凡是会离开本机的字符串，一律过 scrubPath()；只有留在本地 UI 看的才用原路径。
    dir: scrubPath(dir),
    databasePresent: existsSync(dbFile),
    entries: names,
    excludes: [
      "letters.sqlite（信件正文）",
      "记忆账本",
      "曲库清单",
      "音视频",
      "模型 API Key（info.json 里已脱敏）",
      // ★ 2026-10-19 修 F6：路径里 Windows 用户名会被收敛成 <user>，但盘符与目录层级照留
      //   （排查"数据目录没权限 / 曲库路径不对"时这些是有用的）。这句是给用户看的告知。
      "本机路径里的用户名（会写成 <user>，盘符与目录层级保留）",
    ],
  };
}

/**
 * 反馈地址。仓库地址由作者定，写死在这里而不是让前端拼：
 * 前端拼 URL 就等于把「往哪里发用户的数据」交给了页面。
 * ★ 留空 = 还没公布仓库。这时接口如实回「没配置」，前端只提示发诊断包，
 *   不要假装打开了一个页面（那是最容易让人以为"反馈发出去了"的假动作）。
 */
// ★ 2026-10-19 用户给的地址（`guvgr2/OliviaSoul-community-standalone`）。
//   写成 "owner/repo" 而不是整条 URL：issue 模板由这里拼，少一段解析。
export const FEEDBACK_REPO = "guvgr2/OliviaSoul-community-standalone";

/** 仓库地址只接受 `owner/repo` 这种两段式。
 * ★ 2026-10-19 三轮审查（低）：这个函数会把 target 直接拼进 URL，而 repo 参数原本没有任何校验。
 *   生产路径只传常量，但"将来换仓库时手滑写进 `?`、`#`、空格、整条 URL"就会拼出一个
 *   看着像 GitHub、实际指向别处的地址 —— 用户点开的是一个我们没验证过的页面。
 *   校验放在这里而不是调用方：只要经过这个函数，出口就只有一种形状。 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** owner/repo 两段都要"像名字"：不能是 `.` 或 `..`（`../x` 能过上面那条正则），
 *  也不能只由点号组成。GitHub 的实际规则比这宽松，我们只需要"不可能被解释成路径"。 */
function repoLooksSane(target) {
  if (!REPO_RE.test(target)) return false;
  return target.split("/").every((seg) => !/^\.+$/u.test(seg));
}

/** 拼「新建 issue」地址。repo 可传（默认用上面的常量）—— 只为让测试能同时覆盖
 *  「配置了」和「还没配置」两条分支，生产调用一律不传。
 * ★ 格式不对（空、单段、带 ? # 空格、整条 URL、`../x`）一律回 null ⇒ 上层按"还没公布仓库"处理，
 *   宁可让用户看到"暂时只能导出诊断包"，也不拼一个可疑地址出去。 */
export function feedbackIssueUrl(kind = "bug", repo = FEEDBACK_REPO) {
  const target = String(repo || "").trim();
  if (!repoLooksSane(target)) return null;
  const isIdea = kind === "idea";
  const title = isIdea ? "建议新功能：" : "问题反馈：";
  const labels = isIdea ? "enhancement" : "bug";
  const body = [
    isIdea ? "**我想要的功能**" : "**发生了什么**",
    "",
    "",
    isIdea ? "**它应该怎么用**" : "**怎么复现**",
    "",
    "1. ",
    "",
    "**期望的结果**",
    "",
    "",
    "---",
    "（可附上「设置 → 诊断与反馈 → 一键诊断包」导出的 zip；里面不含信件、记忆、曲库与音视频）",
  ].join("\n");
  return `https://github.com/${target}/issues/new?labels=${encodeURIComponent(labels)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

