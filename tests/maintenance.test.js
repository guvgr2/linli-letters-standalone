/**
 * 维护模块的护栏：数据搬家、诊断包、反馈入口。
 *
 * 这三条都在「设置 → 维护 / 诊断与反馈」里，平常一辈子不点，点的时候往往已经出了事。
 * 所以这里守的不是"功能能跑"，而是三件出事了会真的伤到人的事：
 *   ① 搬家只认**本次扫描出来的候选** —— 否则它就是一个「往任意目录写文件」的接口；
 *   ② 搬家不热执行 —— 主库被替换时本进程还握着旧的连接，热换 = 覆盖失败或数据错位；
 *   ③ 诊断包不含信件/记忆/曲库 —— 用户敢把它发给作者，才谈得上排查。
 *
 * ★ 测试一律在临时目录里造「假安装」，不扫真机、不碰真实数据目录：
 *   detectCandidates 的 roots/roamingRoots 两个参数就是为这件事留的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  applyMigration,
  buildDiagnosticPackage,
  detectCandidates,
  diagnosticContents,
  feedbackIssueUrl,
  FEEDBACK_REPO,
  DB_NAME,
  DIAG_KEEP,
} from "../app/maintenance.mjs";
import { unzipEntries } from "../app/data-safety.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

/** 造一份「像本程序」的数据目录：库 + 几封信。 */
function makeInstall(dir, { letters = 1, songs = 1 } = {}) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, DB_NAME));
  db.exec("CREATE TABLE letters (id INTEGER PRIMARY KEY, content TEXT)");
  db.exec("CREATE TABLE songs (dir TEXT PRIMARY KEY, name TEXT)");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  for (let i = 0; i < letters; i += 1) db.prepare("INSERT INTO letters (content) VALUES (?)").run(`第 ${i + 1} 封信`);
  for (let i = 0; i < songs; i += 1) db.prepare("INSERT INTO songs (dir, name) VALUES (?, ?)").run(`Song_${i}`, `曲子 ${i}`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('library_dir', '')").run();
  db.close();
  return dir;
}

test("① 扫描：当前目录永远在结果里，且排第一；只认有库的目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "linli-scan-"));
  const current = makeInstall(join(root, "current-nope"), { letters: 2 });
  // 目录名不像本程序，但有库 → 仍应被认出来（盘根下一层是逐个目录看库，不看名字）
  const twin = makeInstall(join(root, "LinliTwin"), { letters: 5 });
  // 名字像、但没有库 → 不该出现（空壳目录搬过去什么也没有）
  mkdirSync(join(root, "LinliEmpty"));

  const scan = await detectCandidates({ dataDir: current, roots: [root], roamingRoots: [] });
  const paths = scan.items.map((it) => it.path);
  assert.equal(paths[0].toLowerCase(), current.toLowerCase(), "当前目录必须排第一");
  assert.ok(paths.some((p) => p.toLowerCase() === twin.toLowerCase()), "有库的兄弟目录要扫出来");
  assert.ok(!paths.some((p) => p.includes("LinliEmpty")), "空壳目录不该进列表");
  assert.equal(scan.items[0].isCurrent, true);
  assert.equal(scan.items.find((it) => it.path === twin)?.letterCount, 5, "要能读出对方有多少封信");
  assert.ok(scan.items.every((it) => it.isCurrent || it.letterCount >= 1), "非当前项必须真有库");
});

test("② 搬家：来源必须是本次扫出来的候选（传别的路径一律拒绝，不落任何文件）", async () => {
  const root = mkdtempSync(join(tmpdir(), "linli-mig-gate-"));
  const current = makeInstall(join(root, "current"), { letters: 1 });
  makeInstall(join(root, "OldOne"), { letters: 2 });
  // ★ 攻击面：一个外面随便写的目录。它不在扫描结果里，即使有库也不许搬。
  const outsider = makeInstall(mkdtempSync(join(tmpdir(), "linli-outsider-")), { letters: 3 });

  const before = readdirSync(current).sort();
  for (const [label, path, code] of [
    ["空来源", "", "COMMON_MIGRATE_SOURCE_REQUIRED"],
    ["扫描结果之外", outsider, "COMMON_MIGRATE_SOURCE_NOT_DETECTED"],
    ["当前目录", current, "COMMON_MIGRATE_SOURCE_IS_CURRENT"],
  ]) {
    const result = await applyMigration({
      sourcePath: path,
      dataDir: current,
      dbFile: join(current, DB_NAME),
      // 注入扫描面（生产代码不传这两个参数）
    });
    assert.equal(result.ok, false, `${label} 必须失败`);
    assert.equal(result.code, code, `${label} 的号不对`);
  }
  assert.deepEqual(readdirSync(current).sort(), before, "被拒绝的搬家不许在数据目录里留下任何文件");
});

test("③ 搬家：只在扫描结果里挑来源；复制成暂存 + 写 pending-restore（下次启动才换）", async () => {
  const root = mkdtempSync(join(tmpdir(), "linli-mig-ok-"));
  const current = makeInstall(join(root, "current"), { letters: 1 });
  const source = makeInstall(join(root, "JiuBan"), { letters: 7 });
  const sourceDb = join(source, DB_NAME);
  const sourceBytes = statSync(sourceDb).size;

  const scan = await detectCandidates({ dataDir: current, roots: [root], roamingRoots: [] });
  const candidate = scan.items.find((it) => it.path === source);
  assert.ok(candidate, "来源应被扫出来");

  const liveBefore = statSync(join(current, DB_NAME)).size;
  const scanOpt = { roots: [root], roamingRoots: [] };
  const done = await applyMigration({ sourcePath: candidate.path, dataDir: current, dbFile: join(current, DB_NAME), scan: scanOpt });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.letterCount, 7);
  assert.equal(done.note, "关掉程序再打开才生效");

  // ① 暂存文件在数据目录里，大小与源库一致
  const staged = join(current, done.staged);
  assert.ok(existsSync(staged), "暂存文件必须落盘");
  assert.equal(statSync(staged).size, sourceBytes, "暂存必须是源库原样");
  // ② 正在用的库**没被换掉**（热替换会撞上我们自己的连接）
  assert.equal(statSync(join(current, DB_NAME)).size, liveBefore, "搬家当场不许覆盖正在用的库");
  // ③ 标记写对了，且带 origin=migrate（跟"从备份恢复"分得开）
  const pending = JSON.parse(readFileSync(join(current, "pending-restore.json"), "utf8"));
  assert.equal(pending.source, done.staged);
  assert.equal(pending.origin, "migrate");
  assert.match(pending.label, /数据搬家/u);
  // ④ 来源那份**只读**：一个字节都不该被改
  assert.equal(statSync(sourceDb).size, sourceBytes, "来源库不能被改动");
});

test("④ 搬家：重复点不会把暂存文件越攒越多（上一次的暂存先清掉）", async () => {
  const root = mkdtempSync(join(tmpdir(), "linli-mig-twice-"));
  const current = makeInstall(join(root, "current"));
  const source = makeInstall(join(root, "JiuBan"));
  const scan = await detectCandidates({ dataDir: current, roots: [root], roamingRoots: [] });
  const path = scan.items.find((it) => it.path === source).path;

  await applyMigration({ sourcePath: path, dataDir: current, dbFile: join(current, DB_NAME), scan: { roots: [root], roamingRoots: [] } });
  // 人为造一份"上一次"留下的旧暂存（时间戳不同，模拟隔了几秒再点一次）
  writeFileSync(join(current, "import-migrate-20200101-000000.sqlite"), "old");
  await applyMigration({ sourcePath: path, dataDir: current, dbFile: join(current, DB_NAME), scan: { roots: [root], roamingRoots: [] } });

  const staged = readdirSync(current).filter((n) => n.startsWith("import-migrate-"));
  assert.equal(staged.length, 1, `暂存文件应只剩一份，实际：${staged.join("、")}`);
  assert.ok(!staged.includes("import-migrate-20200101-000000.sqlite"), "旧的那份必须被清掉");
});

test("⑤ 诊断包：只带 info/files（+ 日志），并对日志里的凭据脱敏", async () => {
  const dir = makeInstall(mkdtempSync(join(tmpdir(), "linli-diag-")), { letters: 3 });
  // 日志里故意塞一个"像真凭据"的串，验证脱敏这一步真的跑了
  writeFileSync(join(dir, "shell.log"), "2026-10-19 00:00:00 apiKey=sk-abcdef0123456789ABCDEF 崩了\n");
  const dbFile = join(dir, DB_NAME);
  const dbBytes = statSync(dbFile).size;

  const made = await buildDiagnosticPackage({ dataDir: dir, dbFile, version: "9.9.9", about: { libraryDir: "E:\\music" } });
  assert.ok(existsSync(made.file), "诊断包要落盘到数据目录");
  const names = made.entries.map((e) => e.name);
  assert.deepEqual(names.sort(), ["files.json", "info.json", "shell.log"], "只允许这三样");

  const zipBytes = readFileSync(made.file);
  const byName = new Map([...unzipEntries(zipBytes)].map(([name, data]) => [name, data.toString("utf8")]));

  // ① 不含库本体：任何一份内容里都不许出现信件正文
  for (const [name, text] of byName) {
    assert.ok(!text.includes("封信"), `${name} 里出现了信件内容`);
  }
  // ② 日志被带上了，但凭据被抹掉了
  assert.match(byName.get("shell.log"), /崩了/u, "日志内容要在");
  assert.ok(!byName.get("shell.log").includes("sk-abcdef0123456789ABCDEF"), "日志里的 Key 必须被抹掉");
  // ③ info.json 里有版本与库大小，但没有 Key；且没有任何路径指向别的安装
  const info = JSON.parse(byName.get("info.json"));
  assert.equal(info.version, "9.9.9");
  assert.equal(info.databaseBytes, dbBytes);
  assert.equal(info.databasePresent, true);

  const contents = diagnosticContents({ dataDir: dir, dbFile });
  assert.ok(contents.excludes.some((x) => x.includes("信件")), "清单里要明说信件不在包里");
  // ★ 2026-10-19 修 F6：清单里也要明说"本机用户名会被收敛"，别让用户以为路径原样公开
  assert.ok(contents.excludes.some((x) => x.includes("<user>")), "清单里要明说用户名会写成 <user>");
});

test("⑤b 诊断包里的本机路径已收敛（F6：Windows 用户名收成 <user>，盘符与层级保留）", async () => {
  // 造一个"长得像真安装"的数据目录：temp\Users\alice\AppData\Roaming\LinliLetters
  const base = mkdtempSync(join(tmpdir(), "linli-diag-path-"));
  const dir = join(base, "Users", "alice", "AppData", "Roaming", "LinliLetters");
  mkdirSync(dir, { recursive: true });
  makeInstall(dir, { letters: 1 });
  writeFileSync(join(dir, "shell.log"), `LINLI_DATA=C:\\Users\\alice\\AppData\\Roaming\\LinliLetters\n`);

  const made = await buildDiagnosticPackage({
    dataDir: dir,
    dbFile: join(dir, DB_NAME),
    version: "1.0.0",
    about: { libraryDir: "C:\\Users\\alice\\Music\\曲库", assetsDir: "D:\\Games\\Olivia\\assets" },
  });
  const byName = new Map([...unzipEntries(readFileSync(made.file))].map(([name, data]) => [name, data.toString("utf8")]));

  const info = JSON.parse(byName.get("info.json"));
  assert.match(info.dataDir, /Users[\\/]<user>/u, `dataDir 里的用户名要收掉：${info.dataDir}`);
  assert.ok(!info.dataDir.includes("alice"), "info.json 不许带 Windows 用户名");
  assert.match(info.libraryDir, /Users[\\/]<user>/u, "libraryDir 同样要收");
  assert.ok(info.libraryDir.includes("Music"), "只收用户名，目录层级要保留（排查路径问题靠它）");
  assert.equal(info.assetsDir, "D:\\Games\\Olivia\\assets", "不含用户名的路径原样保留");

  const log = byName.get("shell.log");
  assert.ok(!log.includes("alice"), "日志里的用户名同样要收掉");
  assert.match(log, /Users\\<user>/u);

  // ★ 2026-10-25 补（压测 D4 实测泄漏）：diagnosticContents() 自己返回的那枚 `dir`
  //   原本是**原样**吐的（实测 `C:\Users\guvgr\AppData\Local\Temp\...`），而它的 excludes
  //   又白纸黑字承诺"用户名会写成 <user>" —— 说到没做到。这份清单正是要贴到公开 issue 上的。
  //   放在这条用例里是因为它专门造了 `…\Users\alice\…`，与跑测试的机器无关（不会假红）。
  const listing = diagnosticContents({ dataDir: dir, dbFile: join(dir, DB_NAME) });
  assert.ok(!listing.dir.includes("alice"), `contents.dir 不许带 Windows 用户名，实际是 ${listing.dir}`);
  assert.match(listing.dir, /Users[\\/]<user>/u, `contents.dir 里的用户名要收成 <user>，实际是 ${listing.dir}`);
  cleanupDirSync(base);
});

test("⑥ 诊断包：没有日志也能出包（新装用户的第一次反馈）", async () => {
  const dir = makeInstall(mkdtempSync(join(tmpdir(), "linli-diag-empty-")));
  const made = await buildDiagnosticPackage({ dataDir: dir, dbFile: join(dir, DB_NAME), version: "1.0.0" });
  assert.deepEqual(made.entries.map((e) => e.name), ["info.json", "files.json"]);
  assert.ok(made.bytes > 0);
});

test("⑦ 反馈入口：配置了就拼出这个仓库的 issue 地址，没配置就如实回 null", () => {
  // 2026-10-19 作者公布了仓库：guvgr2/OliviaSoul-community-standalone。
  // ★ 两条分支都要锁住 —— 只测「配置了」的话，将来谁把常量清空，用户点按钮会
  //   静默无反应（接口回 409 没问题，但地址拼成 https://github.com//issues/new
  //   这种半成品就是假的）。所以 repo 参数化。
  assert.match(FEEDBACK_REPO, /^[\w.-]+\/[\w.-]+$/u, "常量必须是 owner/repo");
  assert.equal(feedbackIssueUrl("bug", ""), null);
  assert.equal(feedbackIssueUrl("idea", "   "), null);
  // ★ 2026-10-19 三轮审查：repo 参数没校验时，把整条 URL / 带 ? # 的串传进来会拼出可疑地址。
  //   宁可如实回 null（上层提示"还没公布仓库"），也不拼一个看着像 GitHub 的地址。
  for (const bad of [
    "guvgr2",                                  // 只有一段
    "https://github.com/guvgr2/x",             // 整条 URL
    "guvgr2/x?labels=pwned",                   // 注入查询串
    "guvgr2/x#frag",                           // 注入锚点
    "guvgr2/x/y",                              // 三段
    "guv gr2/x",                               // 空格
    "../x",                                    // 相对路径
  ]) {
    assert.equal(feedbackIssueUrl("bug", bad), null, `不该接受：${bad}`);
  }

  const bug = feedbackIssueUrl("bug");
  assert.ok(bug.startsWith(`https://github.com/${FEEDBACK_REPO}/issues/new?`), bug);
  assert.match(bug, /labels=bug/u);
  assert.match(decodeURIComponent(bug), /问题反馈/u);

  const idea = feedbackIssueUrl("idea");
  assert.match(idea, /labels=enhancement/u);
  assert.match(decodeURIComponent(idea), /建议新功能/u);
});

/**
 * ⑧ 反馈地址必须真的能被打开。
 * ★ 2026-10-19 审查 N1 的护栏：地址由后端拼、由前端 `openExternal()` 交给系统浏览器，
 *   而这条通道有**两道**白名单（页面 ALLOWED_EXTERNAL_HOSTS、外壳 AllowedExternalHosts）。
 *   上一版两道都只有字体官网域名 ⇒ 点「反馈问题」时前端先拦、外壳再静默丢，
 *   表现就是「按钮点了没反应」。这段测试守三件事：
 *   ① 拼出来的地址主机名必须是白名单里的一个；
 *   ② 两道白名单必须**完全一致**（改一处忘另一处，症状是只在打包版里坏，最难发现）；
 *   ③ 白名单不许被顺手放大（github.io / api.github.com 之类不该出现）。
 */
test("⑧ 反馈地址的主机名在前端与外壳两道白名单里，且两份名单一致", () => {
  const root = join(import.meta.dirname, "..");
  const appJs = readFileSync(join(root, "app", "public", "app.js"), "utf8");
  const shell = readFileSync(join(root, "src", "LinliShell", "MainWindow.cs"), "utf8");

  /** 从「某个常量名 → 数组字面量收尾」的片段里抠出所有带引号的域名。 */
  const hostsOf = (text, marker) => {
    const start = text.indexOf(marker);
    assert.ok(start >= 0, `没找到 ${marker}`);
    const tail = text.slice(start);
    // 收尾就三种写法：JS `]);` / `];`，C# `};`。取最先出现的那个。
    const ends = ["]);", "];", "};"].map((t) => tail.indexOf(t)).filter((i) => i > 0);
    assert.ok(ends.length > 0, `${marker} 的收尾没找到`);
    return [...tail.slice(0, Math.min(...ends)).matchAll(/"([a-z0-9.-]+)"/gu)].map((m) => m[1]).sort();
  };

  const front = hostsOf(appJs, "const ALLOWED_EXTERNAL_HOSTS");
  const back = hostsOf(shell, "string[] AllowedExternalHosts");
  assert.deepEqual(front, back, "前端与外壳的外链白名单必须一致");

  const url = new URL(feedbackIssueUrl("bug"));
  assert.equal(url.protocol, "https:");
  assert.ok(front.includes(url.hostname), `反馈地址的主机名 ${url.hostname} 不在白名单里：${front.join(", ")}`);

  // 白名单只该是「官网 + GitHub 网页」；api.github.com 能取任意仓库数据，不该放进来。
  assert.ok(!front.includes("api.github.com"), "不要把 api.github.com 放进来");
  assert.ok(front.every((h) => !h.endsWith("github.io")), "不要把 github.io 放进来");
});

/**
 * ⑨ 并发导出诊断包不许 500、不许撞名、也不许把数据目录堆满。
 * ★ 2026-10-19 审查 N3：文件名原来只精确到秒，两个并发请求同秒撞名 ⇒ Windows 同名并发写
 *   EPERM ⇒ 500 且把英文 errno 吐给用户（压测 10 分钟 8 次）。现在名字带随机后缀 + wx 写入 +
 *   换名重试，并且只留最新 DIAG_KEEP 份。
 */
test("⑨ 诊断包：并发导出不撞名、不报错，且数据目录里最多留 DIAG_KEEP 份", async () => {
  const dir = makeInstall(mkdtempSync(join(tmpdir(), "linli-diag-race-")), { letters: 2 });
  const dbFile = join(dir, DB_NAME);
  const rounds = 16;

  const made = await Promise.all(Array.from({ length: rounds }, () => buildDiagnosticPackage({ dataDir: dir, dbFile, version: "1.0.0" })));
  const names = made.map((m) => m.name);
  assert.equal(new Set(names).size, rounds, "每个包的名字都必须是唯一的");
  assert.ok(names.every((n) => /^oliviasoul-community-diagnostic-\d{8}-\d{6}-[0-9a-f]{6}\.zip$/u.test(n)), names.join(", "));

  const left = readdirSync(dir).filter((n) => n.startsWith("oliviasoul-community-diagnostic-") && n.endsWith(".zip"));
  assert.ok(left.length <= DIAG_KEEP, `只该留 ${DIAG_KEEP} 份，实际 ${left.length}`);
  assert.ok(made.every((m) => m.bytes > 0));
});
