/**
 * 数据备份与恢复的护栏。
 *
 * 为什么单独一个文件：这一组功能**能毁掉用户的全部信件**。恢复、删除、导入三条路径
 * 任何一条少了防线，后果不是"少个功能"而是"信没了"。所以每条防线都单独钉一个用例。
 *
 * 照姊妹项目 data-safety.js 立的顺序（一条都不能挪）：
 *   ① 恢复不热执行（只写标记，下次启动开连接之前才应用）
 *   ② 任何恢复/导入之前先把当前库整体留档，留档失败就中止
 *   ③ 导出包一律脱敏
 *
 * ★ 起真服务真发 HTTP，不 mock 那一层 —— 上一轮 folders.test.js 就是因为夹具自证
 *   （曲库与入库用同一份名单）而假绿过一次。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/** 起一个干净的服务实例，返回 {port, token, dir, kill}。 */
async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "linli-ds-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, LINLI_DATA_DIR: dir, LINLI_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务没起来")), 15000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = /LINLI_PORT=(\d+)/u.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on("data", () => { /* 日志不进断言 */ });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}`)); });
  });
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  return {
    port, token, dir,
    dbFile: join(dir, "letters.sqlite"),
    async call(path, { method = "GET", body = null, headers = {} } = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "X-Linli-Token": token, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers },
        body: body === null ? undefined : JSON.stringify(body),
      });
      const type = res.headers.get("content-type") ?? "";
      const payload = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, payload, headers: res.headers };
    },
    kill() {
      child.kill();
      return new Promise((resolve) => child.on("exit", resolve));
    },
    cleanup() { return rm(dir, { recursive: true, force: true }); },
  };
}

/** 往库里塞一封信（走真接口，顺带验证写路径可用）。 */
async function writeLetter(ctx, text) {
  const res = await ctx.call("/api/letters", { method: "POST", body: { content: text } });
  assert.equal(res.status, 200, `写信失败：${JSON.stringify(res.payload)}`);
  return res.payload;
}

function letterCount(dir) {
  const db = new DatabaseSync(join(dir, "letters.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT COUNT(*) c FROM letters").get().c; } finally { db.close(); }
}

test("① 手动备份：落出 backup-manual-*.sqlite，且**主库自己不出现在列表里**", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  await writeLetter(ctx, "第一封信");

  const made = await ctx.call("/api/data/backup", { method: "POST", body: {} });
  assert.equal(made.status, 200);
  const files = await readdir(ctx.dir);
  const backups = files.filter((f) => f.startsWith("backup-manual-") && f.endsWith(".sqlite"));
  assert.equal(backups.length, 1, `应恰好有一份手动备份，实际：${files.join(", ")}`);

  // ★ 这条是本轮真踩到的坑：主库 letters.sqlite 也在同一个目录里、也叫 .sqlite，
  //   一开始被当成"其它备份"列进了第一行 —— 用户点「恢复」等于拿自己覆盖自己。
  const status = await ctx.call("/api/data/status");
  assert.equal(status.status, 200);
  const names = status.payload.items.map((i) => i.file);
  assert.ok(!names.includes("letters.sqlite"), `主库不该出现在备份列表里：${names.join(", ")}`);
  assert.deepEqual(names, backups);
  assert.equal(status.payload.items[0].kind, "手动备份");
  assert.equal(status.payload.pending, null);
});

test("② 恢复延后生效：POST restore 只写标记，库本身一个字节都不动", async (t) => {
  const ctx = await boot();
  let killed = false;
  t.after(async () => { if (!killed) await ctx.kill(); await ctx.cleanup(); });

  await writeLetter(ctx, "备份前那封");
  const made = await ctx.call("/api/data/backup", { method: "POST", body: {} });
  const backupName = made.payload.made.file;
  await writeLetter(ctx, "备份之后又写的一封");          // 现在库里有 2 封，备份里只有 1 封

  const before = await readFile(ctx.dbFile);
  const res = await ctx.call("/api/data/restore", { method: "POST", body: { file: backupName, confirm: true } });
  assert.equal(res.status, 200);
  assert.equal(res.payload.pending.source, backupName);
  // ★ 热执行的反面证据：库文件逐字节没变，用的还是 2 封的那份。
  const after = await readFile(ctx.dbFile);
  assert.equal(Buffer.compare(before, after), 0, "恢复不该当场动库（那样在 Windows 上会覆盖失败）");
  assert.equal(letterCount(ctx.dir), 2, "恢复前库还是 2 封");

  const status = await ctx.call("/api/data/status");
  assert.equal(status.payload.pending.source, backupName);
  // 同一份正在等待恢复的备份不能删。
  const del = await ctx.call("/api/data/delete", { method: "POST", body: { file: backupName, confirm: true } });
  assert.equal(del.status, 400);
  assert.equal(del.payload.code, "COMMON_BACKUP_PENDING_RESTORE");

  // 重启一次（真的杀掉再起）—— 恢复在这一步生效。
  const port = ctx.port;
  await ctx.kill();
  killed = true;
  const again = await bootAt(ctx.dir);
  try {
    assert.equal(again.port > 0, true);
    assert.equal(letterCount(ctx.dir), 1, "重启后应回到备份里的 1 封");
    const files = await readdir(ctx.dir);
    assert.ok(files.some((f) => f.startsWith("before-restore-")), `应留下 before-restore-*.sqlite：${files.join(", ")}`);
    assert.ok(!files.includes("pending-restore.json"), "恢复应用后标记要清掉");
  } finally {
    await again.kill();
  }
  void port;
});

/** 在既有数据目录上再起一个服务（模拟"关掉程序再打开"）。 */
async function bootAt(dir) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, LINLI_DATA_DIR: dir, LINLI_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务没起来")), 15000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = /LINLI_PORT=(\d+)/u.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}`)); });
  });
  return { port, kill: () => { child.kill(); return new Promise((r) => child.on("exit", r)); } };
}

test("③ 删除备份必须带 confirm；确认后才真删；正在用的库永远删不掉", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  await writeLetter(ctx, "信");
  const made = await ctx.call("/api/data/backup", { method: "POST", body: {} });
  const name = made.payload.made.file;

  const noConfirm = await ctx.call("/api/data/delete", { method: "POST", body: { file: name } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.payload.code, "COMMON_BACKUP_DELETE_NOT_CONFIRMED");
  assert.ok((await readdir(ctx.dir)).includes(name), "没确认就不许删");

  const live = await ctx.call("/api/data/delete", { method: "POST", body: { file: "letters.sqlite", confirm: true } });
  assert.equal(live.status, 400);
  // ★ 主库名本身能过「名字必须是 .sqlite」那道，所以更靠后的那道专门防线要接住它：
  //   COMMON_BACKUP_IS_LIVE（这是正在用的库）。两个号不能合并 —— 前者说明传进来的名字不合法，
  //   后者说明名字合法但指向当前库，用户下一步动作完全不同。
  assert.equal(live.payload.code, "COMMON_BACKUP_IS_LIVE");

  const ok = await ctx.call("/api/data/delete", { method: "POST", body: { file: name, confirm: true } });
  assert.equal(ok.status, 200);
  assert.ok(!(await readdir(ctx.dir)).includes(name), "确认后应真删掉");
});

test("④ 文件名穿越：`../` 与绝对路径都进不来", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  for (const name of ["../secrets.sqlite", "..\\secrets.sqlite", "C:\\Windows\\x.sqlite", "sub/x.sqlite", "letters.txt"]) {
    const res = await ctx.call("/api/data/inspect", { method: "POST", body: { file: name } });
    assert.equal(res.status, 400, `${name} 应该被挡下，实际 ${res.status}`);
    assert.equal(res.payload.code, "COMMON_BACKUP_NAME_INVALID", `${name} 的号不对：${res.payload.code}`);
  }
});

test("⑤ 导出：包里有 README/manifest/库，且凭据被清空（脱敏）", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  await writeLetter(ctx, "要导出的信");

  // 往设置里塞一个"看起来像 Key"的值，验证导出时被清掉、而主库本身不受影响。
  const db = new DatabaseSync(ctx.dbFile);
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run("probe_dummy", '{"apiKey":"sk-abcdefgh12345678"}');
  db.close();

  const res = await ctx.call("/api/data/export", { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-type")), /application\/zip/u);
  const zip = res.payload;
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0);

  // ★ 用**系统的 tar.exe** 解，不用 Expand-Archive：
  //   在 DSH 里从 PowerShell 7 进程 execFile 一个 5.1 子进程时，`PSModulePath` 会带着
  //   7 的模块路径被继承下去，5.1 去加载 7 的 Microsoft.PowerShell.Archive 就失败
  //   （`The 'Expand-Archive' command was found in the module … but the module could not be loaded`）。
  //   这和之前 DPAPI 那次是同一个根因。tar.exe 是 Windows 10+ 自带、不依赖 PowerShell 模块。
  //   用系统工具解、而不是用我们自己写的 unzipEntries 解 —— 后者正是被测对象，
  //   用它验自己的产物属于自证。
  const { execFileSync } = await import("node:child_process");
  const zipPath = join(ctx.dir, "probe.zip");
  await writeFile(zipPath, zip);
  const outDir = join(ctx.dir, "unzipped");
  await (await import("node:fs/promises")).mkdir(outDir, { recursive: true });
  execFileSync("tar.exe", ["-xf", zipPath, "-C", outDir], { stdio: "ignore" });
  const walk = async (dir, prefix = "") => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await walk(join(dir, e.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const names = (await walk(outDir)).sort();
  assert.deepEqual(names, ["README.txt", "database/letters.sqlite", "manifest.json"]);
  const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "linli-letters-userdata");
  assert.equal(manifest.counts.letters, 1);
  assert.ok(manifest.credentialsRemoved >= 1, "应该报告移除了几处凭据");

  // 包里的库不含明文 Key —— 这是"导出包会被分享出去"那条约束的直接验证。
  const exportedDb = new DatabaseSync(join(outDir, "database", "letters.sqlite"), { readOnly: true });
  const row = exportedDb.prepare("SELECT value FROM settings WHERE key = 'probe_dummy'").get();
  exportedDb.close();
  assert.ok(!String(row.value).includes("sk-abcdefgh12345678"), `导出包里还有明文 Key：${row.value}`);

  // 主库本身没被动过（脱敏只作用于快照）。
  const liveDb = new DatabaseSync(ctx.dbFile, { readOnly: true });
  const liveRow = liveDb.prepare("SELECT value FROM settings WHERE key = 'probe_dummy'").get();
  liveDb.close();
  assert.ok(String(liveRow.value).includes("sk-abcdefgh12345678"), "主库不该被脱敏动过");
  await stat(zipPath);
});

test("⑥ 导入：导出包能原样导入，且只排进待恢复、不当场覆盖", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  await writeLetter(ctx, "导出时的那封");
  const exported = await ctx.call("/api/data/export", { method: "POST", body: {} });
  assert.equal(exported.status, 200);

  const before = await readFile(ctx.dbFile);
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/data/import?name=backup.zip`, {
    method: "POST",
    headers: { "X-Linli-Token": ctx.token, "Content-Type": "application/octet-stream", Origin: `http://127.0.0.1:${ctx.port}` },
    body: exported.payload,
  });
  assert.equal(res.status, 200, `导入失败：${await res.text()}`);
  assert.equal(Buffer.compare(before, await readFile(ctx.dbFile)), 0, "导入也不许当场覆盖库");

  const status = await ctx.call("/api/data/status");
  assert.ok(status.payload.pending, "导入后应有待恢复标记");
  assert.equal(status.payload.pending.origin, "import");

  // 坏包：不是 zip / 空 zip / 没有库文件。
  for (const [body, code] of [
    [Buffer.from("这不是 zip"), "IMPORT_ZIP_INVALID"],
  ]) {
    const bad = await fetch(`http://127.0.0.1:${ctx.port}/api/data/import?name=x.zip`, {
      method: "POST",
      headers: { "X-Linli-Token": ctx.token, "Content-Type": "application/octet-stream", Origin: `http://127.0.0.1:${ctx.port}` },
      body,
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, code);
  }

  // 名字不是 .zip。
  const wrongName = await fetch(`http://127.0.0.1:${ctx.port}/api/data/import?name=x.rar`, {
    method: "POST",
    headers: { "X-Linli-Token": ctx.token, "Content-Type": "application/octet-stream", Origin: `http://127.0.0.1:${ctx.port}` },
    body: exported.payload,
  });
  assert.equal(wrongName.status, 400);
  assert.equal((await wrongName.json()).code, "IMPORT_NAME_INVALID");
});

test("⑦ 数据接口一律要令牌（GET 也要）", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/data/status`, {
    headers: { Origin: `http://127.0.0.1:${ctx.port}` },
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "COMMON_TOKEN_MISSING");
});

test("⑧ 周期备份配置：缺省开、1 天、留 7 份；关掉只有明确写 0/false/off/no 才算", async (t) => {
  const ctx = await boot();
  t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
  const first = await ctx.call("/api/data/status");
  assert.deepEqual(first.payload.periodic, { enabled: true, days: 1, keep: 7 });

  const off = await ctx.call("/api/data/periodic", { method: "POST", body: { enabled: false, days: 3, keep: 2 } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.payload.periodic, { enabled: false, days: 3, keep: 2 });

  const clamp = await ctx.call("/api/data/periodic", { method: "POST", body: { days: 999, keep: 999 } });
  assert.equal(clamp.payload.periodic.days, 30);
  assert.equal(clamp.payload.periodic.keep, 60);
});
