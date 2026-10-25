/**
 * A2「她的日记」的护栏（2026-10-19 方案 2 节）。
 *
 * 盯的是五件容易做成"假功能"的事：
 *   ① 有来信的那天会真生成一篇，且 `facts` 落库（"她当时基于什么写的"要查得到）；
 *   ② 没有任何往来的那天**不写空日记**（这是明确的产品口径，不是漏写）；
 *   ③ 列表接口只回摘要（excerpt），全文走单日接口 —— 列表页不该一次性搬全文；
 *   ④ 手动重写会把旧版本存进 `diary_history`，不覆盖掉"当时的事实"；
 *   ⑤ 不存在的日期是 404，不是 200 空壳。
 *
 * 跑法：node --test --test-force-exit tests\diary.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/** 昨天的本地日期（YYYY-MM-DD）。直接跟服务端的 `localDay()` 用同一种算法。 */
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 往库里塞一封信（不走模型：这一份测的是日记，不是回信管线）。 */
function seedLetter(dbFile, { at, content }) {
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare(`
      INSERT INTO letters(id, content, reply_text, origin, status, created_at, replied_at, is_read, trigger_kind)
      VALUES (?, ?, ?, 'user', 'replied', ?, ?, 1, NULL)
    `).run(`seed-${at}`, content, "嗯，我在。", at, at + 60);
  } finally {
    db.close();
  }
}

/** 起服务（`dataDir` 由调用方给：要"先落信再启动"就得复用同一个目录）。 */
async function startOn(dataDir, extraEnv = {}) {
  const env = { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_NO_GAME_ASSETS: "1", ...extraEnv };
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString(); });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`服务没起来：${stderr}`)), 30000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = /LINLI_PORT=(\d+)/u.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}：${stderr}`)); });
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

async function boot(extraEnv = {}) {
  return startOn(await mkdtemp(join(tmpdir(), "linli-diary-")), extraEnv);
}

/** ★ 为什么要有这个：这份测的是"启动时补写昨天那篇"，所以信必须在**启动之前**就在库里。
 *  第一次启动只是为了建表、拿到 dbFile，然后关掉、塞信、再启动 —— 这就是真实的
 *  "用户昨天写了信，今天打开程序"那条路径。 */
async function bootWithYesterdayLetter(content, extraEnv = {}) {
  const yesterday = localDay(-1);
  const first = await boot(extraEnv);
  await first.kill();
  seedLetter(first.dbFile, {
    at: Math.floor(new Date(`${yesterday}T12:00:00`).getTime() / 1000),
    content,
  });
  const second = await startOn(first.dir, extraEnv);
  return { s: second, yesterday };
}

/**
 * ★ 等"某天那篇"真的出现，而不是启动即断言。
 *   为什么：`diaryTick` 是 `void` 触发的（不 await），断在毫秒级时序上是碰运气。
 *   ★ 上限刻意取 15 秒 —— **远小于周期 tick 的 5 分钟**。
 *     所以"启动补写被 00:05 闸门挡住"（要拖到下一个 5 分钟 tick 才写）依然必然红，
 *     这条等待没有把 bug 放过，只是不再靠毫秒运气。
 */
async function waitForDiary(s, day, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await s.call(`/api/diary/${day}`);
    if (last.status === 200) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

describe("她的日记", () => {
  test("① 昨天有来信 ⇒ 启动就补写一篇，facts 落库可查", async () => {
    const { s, yesterday } = await bootWithYesterdayLetter("今天下雨了，我带了伞。");
    try {
      const detail = await waitForDiary(s, yesterday);
      assert.equal(detail.status, 200, "启动补写应当已经写好昨天那篇");
      assert.match(detail.payload.body, /封信/u, "日记里应当提到他来了信");
      const facts = typeof detail.payload.facts === "string" ? JSON.parse(detail.payload.facts) : detail.payload.facts;
      assert.ok(Array.isArray(facts.letters) && facts.letters.length >= 1, "facts 必须记下当天的信");
      assert.equal(facts.day, yesterday);
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("② 没有往来的那天不写空日记（也不许 200 空壳）", async () => {
    const s = await boot();
    try {
      const dayBefore = localDay(-5);
      const missing = await s.call(`/api/diary/${dayBefore}`);
      assert.equal(missing.status, 404, "没有内容的日子应当 404，而不是编一篇");
      const list = await s.call("/api/diary");
      assert.equal(list.status, 200);
      assert.ok(!list.payload.items.some((it) => it.day === dayBefore), "列表里也不该出现空日记");
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("③ 列表只回摘要：有 excerpt、没有全文", async () => {
    const { s, yesterday } = await bootWithYesterdayLetter("昨天你说的那句我一直记着。");
    try {
      await waitForDiary(s, yesterday); // 先确保昨天那篇已补写出来，再验列表
      const list = await s.call("/api/diary");
      assert.equal(list.status, 200);
      const item = list.payload.items.find((it) => it.day === yesterday);
      assert.ok(item, "列表里应当有昨天那篇");
      assert.ok(typeof item.excerpt === "string" && item.excerpt.length > 0);
      assert.equal(item.body, undefined, "列表不许把全文搬出来");
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("④ 手动重写：旧版本进 diary_history，不吞掉当时的事实", async () => {
    const { s, yesterday } = await bootWithYesterdayLetter("我在听你上次说的那首。");
    try {
      const first = await waitForDiary(s, yesterday);
      assert.equal(first.status, 200);
      const regen = await s.call(`/api/diary/${yesterday}/regenerate`, { method: "POST" });
      assert.equal(regen.status, 200);
      assert.equal(regen.payload.day, yesterday);

      const db = new DatabaseSync(s.dbFile);
      try {
        const rows = db.prepare("SELECT day, body, facts FROM diary_history WHERE day = ?").all(yesterday);
        assert.equal(rows.length, 1, "重写前的版本必须留一份");
        assert.ok(String(rows[0].body).length > 0);
        assert.ok(String(rows[0].facts).includes("letters"), "旧 facts 也要留着 —— 否则说不清当时依据什么写的");
      } finally {
        db.close();
      }
      // 重写后仍然只有一篇（不是又插一条）
      const db2 = new DatabaseSync(s.dbFile);
      try {
        const n = db2.prepare("SELECT COUNT(*) AS n FROM diary WHERE day = ?").get(yesterday).n;
        assert.equal(n, 1);
      } finally { db2.close(); }
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("⑤ 没有内容时重写回 400，不写空文章", async () => {
    const s = await boot();
    try {
      const day = localDay(-3);
      const r = await s.call(`/api/diary/${day}/regenerate`, { method: "POST" });
      assert.equal(r.status, 400, "没内容就别硬写一篇空的");
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("⑥ 午夜 00:00–00:05 开程序：昨天的日记必须立刻补写，不能拖到下一个 5 分钟 tick", async () => {
    // ★ 用 LINLI_FAKE_NOW 把「现在」钉到今天 00:02 —— 正是 diaryDue() 返回 false 的窗口
    //   （getHours()===0 && getMinutes()<5）。不钉住时钟就只能等真正的午夜才发现这毛病。
    const fakeNow = (() => {
      const d = new Date();
      d.setHours(0, 2, 0, 0); // 本地今天 00:02:00
      return Math.floor(d.getTime() / 1000);
    })();
    const { s, yesterday } = await bootWithYesterdayLetter(
      "零点刚过我还在听那首。", { LINLI_FAKE_NOW: String(fakeNow) });
    try {
      // 上限 15 秒：修好（启动补写 ignoreDue: true）⇒ 秒级就有；
      // 若退回「启动也走闸门」⇒ 要等下一个 5 分钟 tick，这条必然红。
      const detail = await waitForDiary(s, yesterday, 15000);
      assert.equal(detail.status, 200,
        `00:02 开程序时昨天(${yesterday})的日记必须立刻补写出来 —— 被 00:05 闸门挡住的话要拖到下一个 5 分钟 tick`);
      assert.match(detail.payload.body, /封信/u, "日记里应当提到他来了信");

      // ★ 时钟自证：服务端写库用的必须就是上面钉住的那一刻。
      //   否则（比如有人把 LINLI_FAKE_NOW 这个接缝删了）这条用例会变成"白天永远绿"，
      //   却根本没测到午夜窗口 —— 那就是假绿，正是要防的东西。
      const db = new DatabaseSync(s.dbFile);
      try {
        const row = db.prepare("SELECT created_at FROM diary WHERE day = ?").get(yesterday);
        assert.ok(row, "日记行应当在库里");
        assert.equal(Number(row.created_at), fakeNow,
          `服务端没有采用 LINLI_FAKE_NOW（库里 created_at=${row?.created_at}，期望 ${fakeNow}）—— 时钟没钉住的话这条用例测不到午夜窗口`);
      } finally {
        db.close();
      }
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });
});
