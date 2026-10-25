/**
 * 「有路由、零测试」的那几条的护栏（2026-10-19 七轮审查 F10 点名）。
 *
 * 点名的是 5 条：`/api/memory`、`/api/data/cancel-restore`、`/api/data/periodic-cleanup`、
 * `/api/data/reveal`、`/api/maintenance/reveal`。它们一直没被测，**不是因为不重要**，
 * 而是因为最后两条会真的弹资源管理器窗口 —— 于是"不好测"变成了"不测"。
 *
 * 处理方式（施工单给了两条路，这里选"补用例 + 留痕"）：
 *   · reveal 两条：给服务端加了 `LINLI_NO_SHELL_OPEN=1` 开关（只把"真开窗"换成"只返回目录"，
 *     令牌、参数、返回体、目录口径全部照测）。生产路径不设这个变量，行为与原来一致。
 *   · 另外三条：真起服务、真发 HTTP、真落盘，不 mock。
 *
 * 顺带守住七轮审查 F2：导出包里**不许**出现 `model_key_*` 行（DPAPI 密文也一样要删）。
 * 那条判据必须"真的把 Key 写进库、再真的导出包解开看"，否则测的是空集。
 *
 * 跑法：node --test --test-force-exit tests\maintenance-routes.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { unzipEntries } from "../app/data-safety.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/**
 * 起一个干净的服务实例。
 * ★ 默认带 `LINLI_NO_SHELL_OPEN=1`：不给的话 reveal 用例会在这台机器上真的弹出资源管理器，
 *   跑测试的人会被打断（这正是它以前一条用例都没有的原因）。
 */
async function boot({ noShell = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "linli-mr-"));
  const env = { ...process.env, LINLI_DATA_DIR: dir, LINLI_PORT: "0" };
  if (noShell) env.LINLI_NO_SHELL_OPEN = "1";
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    // ★ 30 秒而不是 15 秒：这一份里有 10 条用例各自起一次服务，机器负载高时
    //   （比如同时在跑变异全套）15 秒会偶发超时，变成"看起来像功能坏了"的假红。
    const timer = setTimeout(() => reject(new Error("服务没起来")), 30000);
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
    async call(path, { method = "GET", body = null, headers = {}, raw = false } = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "X-Linli-Token": token, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers },
        body: body === null ? undefined : JSON.stringify(body),
      });
      if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      const type = res.headers.get("content-type") ?? "";
      const payload = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, payload, headers: res.headers };
    },
    kill() { child.kill(); return new Promise((resolve) => child.on("exit", resolve)); },
    cleanup() { return cleanupDir(dir); },
  };
}

/** 直接在库里插一行设置（绕过 DPAPI：测的是"导出时会不会把它带走"，不是加密本身）。 */
function putSetting(dbFile, key, value) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  } finally { db.close(); }
}

describe("① /api/memory：记忆页读的就是这三个字段", () => {
  test("GET 回 ledger（对象）/ ledgerText（字符串）/ context（字符串）", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    const res = await ctx.call("/api/memory");
    assert.equal(res.status, 200);
    // ★ 形状是量出来的、不是猜的：ledger 是**对象**（账本结构），另两个是给页面直接渲染的字符串。
    assert.equal(typeof res.payload.ledger, "object", "ledger 是账本结构（对象）");
    assert.equal(typeof res.payload.ledgerText, "string", "ledgerText 必须是字符串（前端直接渲染）");
    assert.equal(typeof res.payload.context, "string", "context 必须是字符串（要发给模型的那段）");
  });
});

describe("② /api/data/cancel-restore：幂等，且能真的撤掉待恢复", () => {
  test("没有待恢复任务时回 200 + pending:null（不是 404）", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    const res = await ctx.call("/api/data/cancel-restore", { method: "POST", body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.payload.pending, null);
  });

  test("安排过恢复再取消 ⇒ pending 回到 null", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    const made = await ctx.call("/api/data/backup", { method: "POST", body: {} });
    assert.equal(made.status, 200);
    const file = made.payload.made.file;

    const arranged = await ctx.call("/api/data/restore", { method: "POST", body: { file, confirm: true } });
    assert.equal(arranged.status, 200);
    assert.ok(arranged.payload.pending, "应该有一个待恢复任务");

    const cancelled = await ctx.call("/api/data/cancel-restore", { method: "POST", body: {} });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.payload.pending, null);
    // 再查一次状态，确认标记文件真删了（不是只回了句 null）
    const status = await ctx.call("/api/data/status");
    assert.equal(status.payload.pending, null);
  });
});

describe("③ /api/data/periodic-cleanup：不带确认不许删，带了才删", () => {
  test("不带 confirm ⇒ 400，且一份备份都没少", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    await ctx.call("/api/data/backup", { method: "POST", body: {} });
    const before = (await ctx.call("/api/data/status")).payload.items.length;
    const res = await ctx.call("/api/data/periodic-cleanup", { method: "POST", body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.payload.code, "COMMON_BACKUP_DELETE_NOT_CONFIRMED");
    const after = (await ctx.call("/api/data/status")).payload.items.length;
    assert.equal(after, before, "没确认就删了 —— 这是会毁数据的路径");
  });

  test("带 confirm ⇒ 200，回 {removed: 数组, kept: 数字}", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    await ctx.call("/api/data/backup", { method: "POST", body: {} });
    const res = await ctx.call("/api/data/periodic-cleanup", { method: "POST", body: { confirm: true } });
    assert.equal(res.status, 200);
    // ★ 形状是量出来的：removed 是**被删的文件名数组**（不是个数），kept 是留下的条数。
    assert.ok(Array.isArray(res.payload.removed), `removed 应该是数组，实际 ${typeof res.payload.removed}`);
    assert.equal(typeof res.payload.kept, "number");
  });
});

describe("④ reveal 两条：目录口径固定为数据目录，不接受前端传路径", () => {
  for (const [name, path] of [["/api/data/reveal", "/api/data/reveal"], ["/api/maintenance/reveal", "/api/maintenance/reveal"]]) {
    test(`${name} 回 200 + dir，且 dir 就是本实例的数据目录`, async (t) => {
      const ctx = await boot();
      t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
      const res = await ctx.call(path, { method: "POST", body: { dir: "C:\\Windows" } });
      assert.equal(res.status, 200);
      assert.equal(res.payload.dir, ctx.dir, "回给前端的目录必须是本实例的数据目录（不吃 body 里的路径）");
    });

    test(`${name} 不带令牌 ⇒ 403（这两条会开窗，不能裸放）`, async (t) => {
      const ctx = await boot();
      t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
      const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${ctx.port}` },
        body: "{}",
      });
      assert.equal(res.status, 403);
    });
  }
});

describe("⑤ 导出包不许带走凭据（七轮审查 F2）", () => {
  test("库里写了 model_key_dpapi / model_key_plain ⇒ 导出包里一行都不剩", async (t) => {
    const ctx = await boot();
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    // 两种形态都写：DPAPI 密文（十六进制，四条正则都不认）与一个像明文的。
    putSetting(ctx.dbFile, "model_key_dpapi", "dpapi-v1:01000000d08c9ddf0115d1118c7a00c04fc297ebdeadbeef");
    putSetting(ctx.dbFile, "model_key_plain", "sk-AUDITLEAK-EXPORT-TEST");

    const res = await ctx.call("/api/data/export", { method: "POST", body: {}, raw: true });
    assert.equal(res.status, 200, "导出应该成功");
    const zip = unzipEntries(res.bytes);
    const dbBytes = zip.get("database/letters.sqlite");
    assert.ok(dbBytes, `导出包里应该有 database/letters.sqlite，实际：${[...zip.keys()].join(", ")}`);

    const tmp = join(ctx.dir, "export-check.sqlite");
    await writeFile(tmp, dbBytes);
    const db = new DatabaseSync(tmp, { readOnly: true });
    let rows;
    try {
      rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'model_key_%'").all();
    } finally { db.close(); }
    assert.deepEqual(rows, [], `导出包里还留着凭据行：${JSON.stringify(rows)}`);

    const manifest = JSON.parse(zip.get("manifest.json").toString("utf8"));
    assert.ok(manifest.credentialsRemoved >= 1, "删了几行要如实记进 manifest");
  });
});
