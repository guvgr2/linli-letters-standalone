/**
 * A1「记忆可更正」的护栏（2026-10-19 方案 1 节）。
 *
 * 这一份盯的是四件容易被"看起来有功能"糊过去的事：
 *   ① 旧账本（一整块「键　值」文本）真能迁成条目，且旧字段仍然读得到（迁移不许把记忆页打空）；
 *   ② 用户手改之后，行是 `origin='user'`，且**下一封回信的上下文里**能看到"你亲自更正过"；
 *   ③ 删除是软删：默认列表里看不到、`include_deleted=1` 看得到、restore 能回来；
 *   ④ 模型不得覆盖你改过的值（冲突裁决），"保留我的 / 用她的"两条路都走通。
 *
 * 跑法：node --test --test-force-exit tests\memory-items.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decideLedgerWrite, ledgerItemsFromText, parseLedger } from "../app/core.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/** 起服务。`dir` 传进来就是在同一个数据目录上重启（迁移用例要用）。 */
async function boot(dir = null) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "linli-mem-")));
  const env = { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_NO_GAME_ASSETS: "1" };
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务没起来")), 30000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = /LINLI_PORT=(\d+)/u.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on("data", () => {});
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}`)); });
  });
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  return {
    port, token, dir: dataDir, dbFile: join(dataDir, "letters.sqlite"),
    async call(path, { method = "GET", body = null } = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "X-Linli-Token": token, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
        body: body === null ? undefined : JSON.stringify(body),
      });
      return { status: res.status, payload: await res.json().catch(() => ({})) };
    },
    kill() { child.kill(); return new Promise((resolve) => child.on("exit", resolve)); },
    cleanup() { return cleanupDir(dataDir); },
  };
}

/** 直接改库（模拟"上一个版本留下的旧账本"或"另一封信的预检结果"）。 */
function withDb(dbFile, fn) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally { db.close(); }
}

describe("① 纯函数：预检值该写、该跳过、还是该挂冲突", () => {
  test("没有同字段条目 ⇒ 写", () => {
    assert.equal(decideLedgerWrite({ value: "一般朋友", existing: [] }).action, "write");
  });

  test("已经是同一个值 ⇒ 跳过（不许每封信都插一条重复行）", () => {
    const existing = [{ id: "a", value: "一般朋友", origin: "model", status: "active", updated_at: 1 }];
    assert.equal(decideLedgerWrite({ value: "一般朋友", existing }).action, "skip");
  });

  test("★ 你改过且值不同 ⇒ 冲突，不覆盖", () => {
    const existing = [{ id: "u1", value: "还在互相试探", origin: "user", status: "active", updated_at: 9 }];
    const got = decideLedgerWrite({ value: "有点疏远", existing });
    assert.equal(got.action, "conflict");
    assert.equal(got.mine, "还在互相试探");
  });

  test("写新条目时 supersedes 指向同字段上一条 active", () => {
    const existing = [{ id: "m1", value: "一般朋友", origin: "model", status: "active", updated_at: 5 }];
    const got = decideLedgerWrite({ value: "好朋友", existing });
    assert.equal(got.action, "write");
    assert.equal(got.supersedes, "m1");
  });

  test("已删的 user 条不拦模型（撤销之后就该由模型继续记）", () => {
    const existing = [{ id: "u1", value: "还在互相试探", origin: "user", status: "deleted", updated_at: 9 }];
    assert.equal(decideLedgerWrite({ value: "有点疏远", existing }).action, "write");
  });
});

describe("② 迁移：旧账本文本 → 条目，且旧字段不被弄坏", () => {
  test("旧 ledger.body 拆成条目；ledgerText / parseLedger 仍然读得到", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-mig-"));
    const first = await boot(dir);
    await first.kill();

    const text = ["关系　好朋友", "已承认情感　无", "既有边界　不视频"].join("\n");
    withDb(join(dir, "letters.sqlite"), (db) => {
      db.prepare("INSERT INTO ledger(id, body, updated_at) VALUES(1, ?, 1) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
        .run(text);
      // 清掉标记 ⇒ 下次启动才会真跑迁移（真实用户第一次升级时就是这个状态）
      db.prepare("DELETE FROM settings WHERE key = 'ledger_items_migrated_at'").run();
    });

    const ctx = await boot(dir);
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    const res = await ctx.call("/api/memory");
    assert.equal(res.status, 200);
    assert.equal(res.payload.items.length, ledgerItemsFromText(text).length, "条目数应等于行数");
    assert.equal(res.payload.items.every((i) => i.origin === "model" && i.status === "active"), true);
    // 旧字段一个都不能坏：前端还在用它们
    assert.deepEqual(res.payload.ledger, parseLedger(text));
    assert.equal(res.payload.ledgerText, text);
  });

  test("迁移只跑一次：重启后条目数不翻倍", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-once-"));
    const a = await boot(dir);
    await a.kill();
    withDb(join(dir, "letters.sqlite"), (db) => {
      db.prepare("INSERT INTO ledger(id, body, updated_at) VALUES(1, ?, 1) ON CONFLICT(id) DO UPDATE SET body = excluded.body").run("关系　好朋友");
      db.prepare("DELETE FROM settings WHERE key = 'ledger_items_migrated_at'").run();
    });
    const b = await boot(dir);
    const firstCount = (await b.call("/api/memory")).payload.items.length;
    await b.kill();
    const c = await boot(dir);
    t.after(async () => { await c.kill(); await c.cleanup(); });
    const secondCount = (await c.call("/api/memory")).payload.items.length;
    assert.equal(secondCount, firstCount);
  });
});

describe("③ 改 / 删 / 撤销 / 溯源", () => {
  test("改一条 ⇒ origin='user'，旧条软删，上下文里出现「你亲自更正过」", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-edit-"));
    const ctx = await boot(dir);
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    withDb(ctx.dbFile, (db) => {
      db.prepare(`INSERT INTO ledger_items(id, field, value, origin, source_letter_id, status, supersedes, created_at, updated_at)
        VALUES('m1', '关系', '一般朋友', 'model', NULL, 'active', NULL, 10, 10)`).run();
    });
    const patched = await ctx.call("/api/memory/m1", { method: "PATCH", body: { value: "还在互相试探" } });
    assert.equal(patched.status, 200);
    assert.equal(patched.payload.item.origin, "user");
    assert.equal(patched.payload.item.supersedes, "m1");

    const res = await ctx.call("/api/memory");
    const active = res.payload.items.filter((i) => i.status === "active");
    assert.equal(active.filter((i) => i.field === "关系").length, 1, "同字段只许留一条 active");
    assert.equal(active.find((i) => i.field === "关系").value, "还在互相试探");
    // ★ 这条是"改完下次又被写回去"的关键：上下文必须显式标注来源
    assert.match(res.payload.context, /★你亲自更正过/u);
    assert.match(res.payload.context, /还在互相试探/u);
  });

  test("删除 ⇒ 默认列表看不到；include_deleted=1 看得到；restore 回来", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-del-"));
    const ctx = await boot(dir);
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    const made = await ctx.call("/api/memory", { method: "PATCH", body: {} }).catch(() => null);
    assert.ok(made === null || made.status >= 400, "不存在的条目不该被改成什么");
    withDb(ctx.dbFile, (db) => {
      db.prepare(`INSERT INTO ledger_items(id, field, value, origin, source_letter_id, status, supersedes, created_at, updated_at)
        VALUES('m1', '既有边界', '不视频', 'model', NULL, 'active', NULL, 10, 10)`).run();
    });
    assert.equal((await ctx.call("/api/memory/m1", { method: "DELETE" })).status, 200);
    const deleted = await ctx.call("/api/memory");
    assert.equal(deleted.payload.items.some((i) => i.id === "m1"), false);
    // ★ 只从列表里藏起来是不够的：软删的条目**不许**再喂给模型。
    //   （这条断言是变异「已删除的条目仍然喂给模型」的抓手 —— 少了它，删了等于没删也测不出来。）
    withDb(ctx.dbFile, (db) => {
      db.prepare("UPDATE ledger_items SET origin = 'user' WHERE id = 'm1'").run();
    });
    assert.equal((await ctx.call("/api/memory")).payload.items.some((i) => i.id === "m1"), false);
    assert.doesNotMatch((await ctx.call("/api/memory")).payload.context, /不视频/u, "软删的条目还出现在给模型的上下文里");
    assert.equal((await ctx.call("/api/memory?include_deleted=1")).payload.items.some((i) => i.id === "m1"), true);
    assert.equal((await ctx.call("/api/memory/m1/restore", { method: "POST", body: {} })).status, 200);
    assert.equal((await ctx.call("/api/memory")).payload.items.some((i) => i.id === "m1"), true);
  });

  test("溯源：能取到那封信的时间与摘要，且不整封回吐", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-src-"));
    const ctx = await boot(dir);
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    withDb(ctx.dbFile, (db) => {
      db.prepare("INSERT INTO letters(id, content, status, created_at) VALUES('L1', ?, 0, 1700000000)")
        .run("今天在窗边站了很久，想起你说过的那些曲子。".repeat(8));
      db.prepare(`INSERT INTO ledger_items(id, field, value, origin, source_letter_id, status, supersedes, created_at, updated_at)
        VALUES('m1', '关系', '好朋友', 'model', 'L1', 'active', NULL, 10, 10)`).run();
    });
    const res = await ctx.call("/api/memory/m1/source");
    assert.equal(res.status, 200);
    assert.equal(res.payload.letter.id, "L1");
    assert.equal(res.payload.letter.created_at, 1700000000);
    assert.ok(res.payload.letter.excerpt.length <= 80, "只给摘要，不整封回吐");
  });
});

describe("④ 冲突：模型想改、你改过 ⇒ 挂待确认，两条裁决路都通", () => {
  async function withConflict(t, mine = "还在互相试探", theirs = "有点疏远") {
    const dir = await mkdtemp(join(tmpdir(), "linli-mem-conf-"));
    const ctx = await boot(dir);
    t.after(async () => { await ctx.kill(); await ctx.cleanup(); });
    withDb(ctx.dbFile, (db) => {
      db.prepare(`INSERT INTO ledger_items(id, field, value, origin, source_letter_id, status, supersedes, created_at, updated_at)
        VALUES('u1', '关系', ?, 'user', NULL, 'active', NULL, 10, 10)`).run(mine);
      db.prepare("INSERT INTO ledger_conflicts(field, mine, theirs, letter_id, created_at, resolved) VALUES('关系', ?, ?, NULL, 20, NULL)")
        .run(mine, theirs);
    });
    return ctx;
  }

  test("待确认区能读到（含双方的值）", async (t) => {
    const ctx = await withConflict(t);
    const res = await ctx.call("/api/memory/conflicts");
    assert.equal(res.status, 200);
    assert.equal(res.payload.conflicts.length, 1);
    assert.equal(res.payload.conflicts[0].mine, "还在互相试探");
    assert.equal(res.payload.conflicts[0].theirs, "有点疏远");
    assert.equal((await ctx.call("/api/memory")).payload.conflicts.length, 1);
  });

  test("保留我的 ⇒ 关系仍是你写的值", async (t) => {
    const ctx = await withConflict(t);
    const res = await ctx.call("/api/memory/conflicts/1", { method: "POST", body: { keep: "mine" } });
    assert.equal(res.status, 200);
    const items = (await ctx.call("/api/memory")).payload.items.filter((i) => i.field === "关系" && i.status === "active");
    assert.equal(items.length, 1);
    assert.equal(items[0].value, "还在互相试探");
    assert.equal((await ctx.call("/api/memory/conflicts")).payload.conflicts.length, 0);
  });

  test("用她的 ⇒ 换成模型的值，你那条让位", async (t) => {
    const ctx = await withConflict(t);
    assert.equal((await ctx.call("/api/memory/conflicts/1", { method: "POST", body: { keep: "theirs" } })).status, 200);
    const items = (await ctx.call("/api/memory")).payload.items.filter((i) => i.field === "关系" && i.status === "active");
    assert.equal(items.length, 1);
    assert.equal(items[0].value, "有点疏远");
    assert.equal(items[0].origin, "model");
  });

  test("改一条后，同字段的待确认自动以你为准", async (t) => {
    const ctx = await withConflict(t);
    const patched = await ctx.call("/api/memory/u1", { method: "PATCH", body: { value: "只是笔友" } });
    assert.equal(patched.status, 200);
    assert.equal((await ctx.call("/api/memory/conflicts")).payload.conflicts.length, 0);
    const active = (await ctx.call("/api/memory")).payload.items.filter((i) => i.field === "关系" && i.status === "active");
    assert.equal(active[0].value, "只是笔友");
  });
});
