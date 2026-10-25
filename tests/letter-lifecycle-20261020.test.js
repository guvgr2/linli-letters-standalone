/**
 * 「一封信从写下到有回信」这条链上的四件要命事（2026-10-20）。
 *
 * 起因：用户说「信件的保存机制和信件的其他部分要向姊妹项目（OliviaSoul 社区版）
 * 学习，看看有没有什么差异」。对着读完，真正会出事的不是"少了几张表"，而是：
 *   ① 生成到一半程序被关掉 ⇒ 那封信永远停在「她还在写……」—— 没有任何代码会再碰它；
 *   ② 账本（她的记忆）**先写、后回信** ⇒ 一封没得到任何回答的信也改了记忆，重试还会写两遍；
 *   ③ 失败的信是死路：卡片版式一直是原版的"失败可重试"，整条链上却没有重试动作；
 *   ④ 往来上下文固定送最近 6 封**全文**，单封上限 4000 字 ⇒ 小上下文模型会被顶爆。
 *
 * 这一份盯的就是这四件事。跑法：
 *   node --test --test-force-exit tests\letter-lifecycle-20261020.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HISTORY_BUDGET_CHARS, pickRecentWithinBudget } from "../app/core.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/**
 * 把注释换成**等长空格**再去看代码顺序。
 * ★ 为什么必须剥：这次的判据要读「两行代码谁在前」。注释里恰好写着这两件事的解释，
 *   而且解释里也出现同样的函数名 —— 不剥注释，`indexOf` 会先命中注释：既可能假红
 *   （注释顺序与代码相反），也可能假绿（有人把真调用注释掉，字符串还在）。换成等长
 *   空格是为了保留下标，报错时还能指着原文说清位置。
 */
function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/gu, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/(?<![:"'`])\/\/[^\n]*/gu, blank);
}

/** 起服务；`dir` 传进来就是在同一个数据目录上重启（"上次被关掉"那种情形要用）。 */
async function boot(dir = null) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "linli-life-")));
  const env = { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_NO_GAME_ASSETS: "1" };
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没起来：\n${out}`)), 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const m = /LINLI_PORT=(\d+)/u.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    // stderr 也要收：起不来时的真因几乎都在 stderr 里，只报"服务没起来"等于没报。
    child.stderr.on("data", (chunk) => { out += chunk.toString(); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}：\n${out}`)); });
  });
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  return {
    port, token, dir: dataDir, dbFile: join(dataDir, "letters.sqlite"), log: () => out,
    async call(path, { method = "GET", body = null } = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "X-Linli-Token": token, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
        body: body === null ? undefined : JSON.stringify(body),
      });
      return { status: res.status, payload: await res.json().catch(() => ({})) };
    },
    kill() {
      if (child.exitCode !== null) return Promise.resolve();
      return new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
    },
    cleanup() { return cleanupDir(dataDir); },
  };
}

/** 直接改库（用来伪造"上次程序被关掉时留下的现场"）。
 *  ★ 只在服务**没在跑**的时候用：delete 日志模式下写库要独占锁，边跑边写是自找 SQLITE_BUSY。 */
function withDb(dbFile, fn) {
  const db = new DatabaseSync(dbFile);
  try { return fn(db); } finally { db.close(); }
}

/** 轮询等某个状态出现。库是别人（服务进程）在写的，读到 BUSY 就重试，别把抖动当结论。 */
async function waitForRow(dbFile, id, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      const db = new DatabaseSync(dbFile);
      try { last = db.prepare("SELECT * FROM letters WHERE id = ?").get(id) ?? null; } finally { db.close(); }
    } catch { /* 正赶上别人写，下一轮再看 */ }
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`等不到 id=${id} 的目标状态，最后读到：${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("① 启动收尾：生成中的信不许永远卡住", () => {
  test("上次关程序时正在生成的那封，重启后会被重新处理（而不是一直「她还在写」）", async () => {
    const first = await boot();
    await first.kill();
    withDb(first.dbFile, (db) => {
      db.prepare("INSERT INTO letters(id, content, origin, status, created_at, is_read) VALUES(?,?,?,?,?,1)")
        .run("stuck-1", "上次程序关掉时我正在回的那封", null, 3, 1700000000);
    });

    const again = await boot(first.dir);
    try {
      // 没配 Key ⇒ 这一轮会落成失败，但**关键在它确实被重新处理过**：
      // 没有启动收尾的话这行会一直是 3，等多久都不变。
      const row = await waitForRow(again.dbFile, "stuck-1", (r) => r.status !== 3);
      assert.equal(row.status, 5, "被中断的信重新跑一遍后应落在「失败」（本机没配模型 Key）");
      assert.match(String(row.error), /API Key|模型/u, "失败要带上真因，而不是一句空话");
      assert.match(again.log(), /LINLI_RECOVERED=1/u, "收了尾就该在日志里说一声收了几封");
    } finally {
      await again.kill();
      await again.cleanup();
    }
  });
});

describe("② 账本与回信同一条命：回信没成功，记忆一个字段都不许改", () => {
  test("模型失败的来信：信件落 FAILED，ledger_items / ledger 都还是空的", async () => {
    const server = await boot();
    try {
      const sent = await server.call("/api/letters", { method: "POST", body: { content: "我下个月要搬去杭州了。" } });
      assert.equal(sent.status, 200);
      const row = await waitForRow(server.dbFile, sent.payload.id, (r) => r.status === 5);
      assert.match(String(row.error), /API Key|模型/u);

      withDb(server.dbFile, (db) => {
        const items = db.prepare("SELECT COUNT(*) AS n FROM ledger_items").get().n;
        const blob = db.prepare("SELECT body FROM ledger WHERE id = 1").get();
        assert.equal(items, 0, "回信没成功，就不该往账本条目里塞东西");
        assert.equal(blob, undefined, "回信没成功，就不该覆盖旧账本文本");
      });
    } finally {
      await server.kill();
      await server.cleanup();
    }
  });

  test("源码顺序：先拿到并通过自检的回信，再在同一个事务里写账本 + 落库", async () => {
    const src = stripComments(await readFile(SERVER, "utf8"));
    // ★ 只在生成队列这一个函数体里搜：同一个文件里「导入」那一段也有 BEGIN / COMMIT，
    //   从整个文件里搜，会把"事务开在别的地方"当成"开在这里"——那是假绿。
    const start = src.indexOf("async function processQueue()");
    assert.ok(start > 0, "找不到串行生成队列");
    const body = src.slice(start);

    const gen = body.indexOf("await generateReply(row.content, ledger)");
    const rec = body.indexOf("recordPrecheckItems(ledger, row.id)");
    const upd = body.indexOf("SET status = ?, reply_text = ?, replied_at = ?");
    assert.ok(gen > 0, "找不到「调模型写回信」那一行");
    assert.ok(rec > 0, "找不到「把预检结论写进账本」那一行");
    assert.ok(upd > 0, "找不到「把回信写进这封信」那一行");
    assert.ok(gen < rec, "账本必须写在回信成功之后（否则失败的信也会改她的记忆）");

    // 三件事必须在同一个 BEGIN … COMMIT 之间，缺一件就不是原子的。
    const begin = body.lastIndexOf('db.exec("BEGIN")', rec);
    const commit = body.indexOf('db.exec("COMMIT")', rec);
    assert.ok(begin > 0 && begin < rec, "写账本之前要在队列里开事务");
    assert.ok(commit > rec, "写完之后要提交");
    assert.ok(upd > rec && upd < commit, "回信落库必须在同一个事务里（不然账本改了、信没回）");
  });
});

describe("③ 失败的信可以重试", () => {
  test("重试只认「真的失败过」的信：不存在 404、搬进来的旧信 409、失败的信 200 并重新跑", async () => {
    const first = await boot();
    await first.kill();
    withDb(first.dbFile, (db) => {
      const insert = db.prepare(
        "INSERT INTO letters(id, content, reply_text, origin, status, error, created_at, is_read) VALUES(?,?,?,?,?,?,?,1)",
      );
      // 真失败过的一封（error 有内容）
      insert.run("bad-1", "写坏的一封", null, null, 5, "旧的失败（LETTER_OLD）", 1700000001);
      // 从旧程序搬进来的信：也是 5，但那是"未回信"，从来没失败过
      insert.run("imported-1", "搬进来的旧信", "", null, 5, null, 1700000002);
    });

    const server = await boot(first.dir);
    try {
      const missing = await server.call("/api/letters/nope/retry", { method: "POST" });
      assert.equal(missing.status, 404);
      assert.match(String(missing.payload.error), /LETTER_NOT_FOUND/u);

      const no = await server.call("/api/letters/imported-1/retry", { method: "POST" });
      assert.equal(no.status, 409, "不是失败过的不许假装重排");
      assert.match(String(no.payload.error), /LETTER_NOT_RETRYABLE/u);

      const yes = await server.call("/api/letters/bad-1/retry", { method: "POST" });
      assert.equal(yes.status, 200);
      // 证明它真的又跑了一遍：错误文案换成了这一轮的真因（没配 Key），不是原来那句。
      const row = await waitForRow(server.dbFile, "bad-1", (r) => r.error && r.error !== "旧的失败（LETTER_OLD）");
      assert.equal(row.status, 5);
      assert.match(String(row.error), /API Key|模型/u);
    } finally {
      await server.kill();
      await server.cleanup();
    }
  });
});

describe("④ 往来上下文按预算取舍（纯函数）", () => {
  const row = (content, reply) => ({ content, reply_text: reply });

  test("整封取舍：绝不截断某一封的正文", () => {
    const rows = [row("一".repeat(300), "甲".repeat(300)), row("二".repeat(300), "乙".repeat(300)), row("三".repeat(300), "丙".repeat(300))];
    const picked = pickRecentWithinBudget(rows, 1300);
    assert.equal(picked.length, 2, "1300 字装不下三封 1200 字的往来");
    // 留下的是最近两封，且正文一个字都没被切
    assert.deepEqual(picked.map((r) => r.content.slice(0, 1)), ["二", "三"]);
    for (const r of picked) {
      assert.equal(r.content.length, 300);
      assert.equal(r.reply_text.length, 300);
    }
  });

  test("最新的那一封永远保留 —— 哪怕它一封就超出预算", () => {
    const rows = [row("旧".repeat(50), "旧"), row("新".repeat(5000), "新")];
    const picked = pickRecentWithinBudget(rows, 200);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].content.length, 5000, "最新的那封是这封回信唯一必须接住的上文，不许丢");
  });

  test("时间正序不变；预算内的全留下；空输入不炸", () => {
    const rows = [row("甲", "一"), row("乙", "二"), row("丙", "三")];
    assert.deepEqual(pickRecentWithinBudget(rows, HISTORY_BUDGET_CHARS).map((r) => r.content), ["甲", "乙", "丙"]);
    assert.deepEqual(pickRecentWithinBudget([], 100), []);
    assert.deepEqual(pickRecentWithinBudget(null), []);
    // 预算给成垃圾值 ⇒ 退回默认预算，而不是把历史清空
    assert.equal(pickRecentWithinBudget(rows, Number.NaN).length, 3);
  });
});
