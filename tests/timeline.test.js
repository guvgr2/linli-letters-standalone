/**
 * 「时间轴 / 日历」的护栏（2026-10-21）。
 *
 * 这一块是用户 7 项功能清单里的第 ③ 项（P0：信件+日记时间线视图）。
 * 它自己不带任何新数据 —— 全部来自 letters 与 diary 两张现成的表，
 * 按**本地日**聚合而已。正因为"只是聚合"，最容易出的错不是接口报错，而是：
 *   ① 分日用了 UTC ⇒ 东八区每天 00:00–08:00 的信被记到前一天（时间轴与日记对不上）；
 *   ② "哪天有东西"的算法在服务端与前端各写一份 ⇒ 时间轴有、日历没有；
 *   ③ 视图切换之后，5 秒轮询每一次都把列表重画并拽回顶部 ⇒ 根本没法往下翻。
 * 所以判据分三层：纯函数的聚合口径（最多条）、真起服务的路由、前端的静态接线。
 *
 * 跑法：node --test --test-force-exit tests\timeline.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildTimelineDays, indexDaysByDay, localDayOf } from "../app/timeline.mjs";
import { cleanupDir } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

/** 本地时区的某个时刻（unix 秒）。★ 用 `new Date(y, m, d, hh, mm)` 构造，
 *  这样测试在任何时区跑都指向"本地的那一天那一小时"，不会被 CI 的 TZ 带偏。 */
const at = (y, m, d, hh = 12, mm = 0) => Math.floor(new Date(y, m - 1, d, hh, mm, 0, 0).getTime() / 1000);

/** 一封信的库行（字段与 server.mjs 的 SELECT 对齐）。 */
const letter = (over = {}) => ({
  id: "L1",
  content: "今天下了很久的雨。",
  reply_text: null,
  origin: null,
  status: 0,
  error: null,
  created_at: at(2026, 10, 21, 14, 22),
  replied_at: null,
  is_read: 1,
  ...over,
});

// ---------------------------------------------------------------- ① 聚合口径

describe("buildTimelineDays：信件与她的日记按本地日聚合", () => {
  test("空输入给空数组，不编造空天", () => {
    assert.deepEqual(buildTimelineDays(), []);
    assert.deepEqual(buildTimelineDays({ letters: [], diary: [] }), []);
  });

  test("同一天的几封信聚成一天，天内的信按时间倒序", () => {
    const days = buildTimelineDays({
      letters: [
        letter({ id: "a", created_at: at(2026, 10, 21, 9, 5) }),
        letter({ id: "b", created_at: at(2026, 10, 21, 21, 40) }),
      ],
    });
    assert.equal(days.length, 1);
    assert.equal(days[0].day, "2026-10-21");
    assert.equal(days[0].letterCount, 2);
    assert.equal(days[0].letters[0].id, "b", "最新的那封要排在最上面");
    assert.equal(days[0].letters[1].id, "a");
  });

  test("天按日期倒序（最近的在最上面）", () => {
    const days = buildTimelineDays({
      letters: [
        letter({ id: "old", created_at: at(2026, 9, 2, 10) }),
        letter({ id: "new", created_at: at(2026, 10, 21, 10) }),
        letter({ id: "mid", created_at: at(2026, 10, 1, 10) }),
      ],
    });
    assert.deepEqual(days.map((d) => d.day), ["2026-10-21", "2026-10-01", "2026-09-02"]);
  });

  test("★ 分日用本地时区：23:30 那封属于当天，不许被算到第二天", () => {
    const days = buildTimelineDays({ letters: [letter({ id: "late", created_at: at(2026, 10, 21, 23, 30) })] });
    assert.equal(days[0].day, "2026-10-21", "本地 23:30 必须落在 10-21（用 UTC 会滑到 10-21 15:30 仍是同一天，但 00:30 那种就会滑到前一天）");
    const early = buildTimelineDays({ letters: [letter({ id: "early", created_at: at(2026, 10, 21, 0, 30) })] });
    assert.equal(early[0].day, "2026-10-21", "本地 00:30 属于 10-21；用 toISOString 会算成 10-20");
  });

  test("她的日记并进同一天，跟信混在一条线上", () => {
    const days = buildTimelineDays({
      letters: [letter()],
      diary: [{ day: "2026-10-21", excerpt: "想把今天的雨记下来。", mood: null, created_at: at(2026, 10, 22, 0, 5) }],
    });
    assert.equal(days.length, 1, "信与日记同一天 ⇒ 还是一个「天」块，不是两块");
    assert.equal(days[0].letterCount, 1);
    assert.equal(days[0].hasDiary, true);
    assert.equal(days[0].diary.excerpt, "想把今天的雨记下来。");
  });

  test("只有日记、没有信的那天也要出现（否则日历上她写过的日子是空的）", () => {
    const days = buildTimelineDays({ diary: [{ day: "2026-10-19", excerpt: "今天很安静。", created_at: at(2026, 10, 20, 0, 5) }] });
    assert.equal(days.length, 1);
    assert.equal(days[0].day, "2026-10-19");
    assert.equal(days[0].letterCount, 0);
    assert.equal(days[0].hasDiary, true);
  });

  test("★ 失败的判据是「status 5 且 error 有内容」，不是「status 5 就是失败」", () => {
    const failed = buildTimelineDays({ letters: [letter({ id: "f", status: 5, error: "没有配置 API Key" })] });
    assert.equal(failed[0].letters[0].failed, true);
    assert.equal(failed[0].hasFailed, true);

    // 从旧程序搬进来的信也是 status 5，但它们从来没出过错 —— 不许给它们盖"没写成"。
    const imported = buildTimelineDays({ letters: [letter({ id: "i", status: 5, error: null })] });
    assert.equal(imported[0].letters[0].failed, false);
    assert.equal(imported[0].hasFailed, false);
  });

  test("未读数只算「有回信的信」：她还没回的那封不该亮红点", () => {
    const days = buildTimelineDays({
      letters: [
        letter({ id: "replied", is_read: 0, reply_text: "雨停得比想象中晚。" }),
        letter({ id: "waiting", is_read: 0, reply_text: null }),
      ],
    });
    assert.equal(days[0].unreadCount, 1, "只有带 reply_text 的那封算未读");
  });

  test("她先写的那封，预览取她的回信正文而不是空 content", () => {
    const days = buildTimelineDays({ letters: [letter({ id: "her", origin: "proactive", content: "", reply_text: "我先写一封给你。" })] });
    assert.equal(days[0].letters[0].preview, "我先写一封给你。");
    assert.equal(days[0].letters[0].origin, "proactive");
  });

  test("一天里信太多时明细截断，但计数仍是全量（日历格子上的数字不能缩水）", () => {
    const many = Array.from({ length: 40 }, (_, i) => letter({ id: `m${i}`, created_at: at(2026, 10, 21, 10) + i * 60 }));
    const days = buildTimelineDays({ letters: many, maxPerDay: 30 });
    assert.equal(days[0].letterCount, 40);
    assert.equal(days[0].letters.length, 30);
  });

  test("预览把换行与连续空白收成一行，超长截断", () => {
    const days = buildTimelineDays({ letters: [letter({ content: "第一行\n\n第二行   接着写".padEnd(10) + "啊".repeat(120) })] });
    const text = days[0].letters[0].preview;
    assert.ok(!text.includes("\n"), "预览里不许留换行");
    assert.ok(text.length <= 49, `预览要截断，实际 ${text.length} 个字符`);
  });

  test("created_at 缺失的行直接跳过，不制造一个 'NaN-NaN-NaN' 的天", () => {
    const days = buildTimelineDays({ letters: [letter({ id: "x", created_at: null })] });
    assert.deepEqual(days, []);
  });

  test("indexDaysByDay 只带日历要用的计数，不带正文", () => {
    const days = buildTimelineDays({
      letters: [letter({ is_read: 0, reply_text: "嗯。" })],
      diary: [{ day: "2026-10-21", excerpt: "雨。", created_at: at(2026, 10, 22, 0, 5) }],
    });
    const index = indexDaysByDay(days);
    const hit = index.get("2026-10-21");
    assert.equal(hit.letterCount, 1);
    assert.equal(hit.unreadCount, 1);
    assert.equal(hit.hasDiary, true);
    assert.equal(hit.letters, undefined, "日历索引里不该夹带明细");
  });
});

// ---------------------------------------------------------------- ② 路由

async function boot(dir = null) {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "linli-timeline-")));
  const env = { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_NO_GAME_ASSETS: "1" };
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没起来：\n${out}`)), 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const hit = /LINLI_PORT=(\d+)/u.exec(out);
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    });
    child.stderr.on("data", (chunk) => { out += chunk.toString(); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出了 code=${code}：\n${out}`)); });
  });
  const token = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()).token;
  return {
    dir: dataDir,
    dbFile: join(dataDir, "letters.sqlite"),
    log: () => out,
    async get(query = "") {
      const res = await fetch(`http://127.0.0.1:${port}/api/timeline${query}`, { headers: { "X-Linli-Token": token } });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    kill() {
      if (child.exitCode !== null) return Promise.resolve();
      return new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
    },
    cleanup() { return cleanupDir(dataDir); },
  };
}

/** 直接改库（只在服务没在跑的时候用：delete 日志模式下边跑边写会 SQLITE_BUSY）。 */
function withDb(dbFile, fn) {
  const db = new DatabaseSync(dbFile);
  try { return fn(db); } finally { db.close(); }
}

const todayDay = () => localDayOf(Math.floor(Date.now() / 1000));

describe("/api/timeline 路由", () => {
  test("不给参数 ⇒ 走默认窗口（最近 13 个月），响应里自报 from/to/source", async () => {
    const srv = await boot();
    try {
      const { status, body } = await srv.get();
      assert.equal(status, 200);
      assert.equal(body.source, "default");
      assert.equal(body.clamped, false);
      assert.match(body.from, /^\d{4}-\d{2}-\d{2}$/u);
      assert.match(body.to, /^\d{4}-\d{2}-\d{2}$/u);
      assert.ok(body.from <= body.to, `窗口反了：${body.from} → ${body.to}`);
      assert.equal(body.to, todayDay(), "默认窗口的右端就是今天（回顾要能看到今天刚写的信）");
      assert.ok(Array.isArray(body.days));
    } finally { await srv.kill(); await srv.cleanup(); }
  });

  test("?month= 给整月：1 号到最后一天（含 2 月与闰年）", async () => {
    const srv = await boot();
    try {
      const oct = await srv.get("?month=2026-10");
      assert.equal(oct.body.source, "month");
      assert.equal(oct.body.from, "2026-10-01");
      assert.equal(oct.body.to, "2026-10-31");
      const feb = await srv.get("?month=2026-02");
      assert.equal(feb.body.to, "2026-02-28");
      const leap = await srv.get("?month=2024-02");
      assert.equal(leap.body.to, "2024-02-29", "闰年二月是 29 天");
    } finally { await srv.kill(); await srv.cleanup(); }
  });

  test("参数写错不报错，回落默认窗口（回顾不该打断写信）", async () => {
    const srv = await boot();
    try {
      for (const bad of ["?month=2026-13", "?month=abc", "?from=2026/10/01&to=2026-10-31", "?from=&to="]) {
        const { status, body } = await srv.get(bad);
        assert.equal(status, 200, `${bad} 应当仍然 200`);
        assert.equal(body.source, "default", `${bad} 应当回落默认窗口`);
      }
    } finally { await srv.kill(); await srv.cleanup(); }
  });

  test("from/to 传反了自动对调，而不是给一片空白", async () => {
    const srv = await boot();
    try {
      const { body } = await srv.get("?from=2026-10-31&to=2026-10-01");
      assert.equal(body.from, "2026-10-01");
      assert.equal(body.to, "2026-10-31");
    } finally { await srv.kill(); await srv.cleanup(); }
  });

  test("跨度超过 400 天要截断，并显式告诉调用方 clamped", async () => {
    const srv = await boot();
    try {
      const { body } = await srv.get("?from=2000-01-01&to=2030-12-31");
      assert.equal(body.clamped, true);
      assert.equal(body.to, "2030-12-31");
      assert.equal(body.from, "2029-11-27", "右端固定，左端往前推 399 天");
    } finally { await srv.kill(); await srv.cleanup(); }
  });

  test("★ 库里真实的一封信 + 一篇日记：在时间轴上并成同一天，且日历索引能看见", async () => {
    const first = await boot();
    await first.kill();
    const day = todayDay();
    withDb(first.dbFile, (db) => {
      db.prepare("INSERT INTO letters(id, content, reply_text, origin, status, created_at, is_read) VALUES(?,?,?,?,?,?,?)")
        .run("t-1", "今天想跟你说件事。", "嗯，我在听。", null, 3, Math.floor(Date.now() / 1000), 0);
      db.prepare("INSERT INTO diary(day, body, mood, song_dir, facts, source, created_at) VALUES(?,?,?,?,?,?,?)")
        .run(day, "他今天写了一封信。", null, null, "{}", "auto", Math.floor(Date.now() / 1000));
    });

    const srv = await boot(first.dir ?? null);
    try {
      const { status, body } = await srv.get();
      assert.equal(status, 200);
      const hit = body.days.find((d) => d.day === day);
      assert.ok(hit, `时间轴里找不到今天那一块，实际 days=${JSON.stringify(body.days.map((d) => d.day))}`);
      assert.equal(hit.letterCount, 1);
      assert.equal(hit.hasDiary, true, "同一天的日记必须并进去");
      assert.equal(hit.unreadCount, 1, "is_read=0 且有回信 ⇒ 算一封未读");
      assert.equal(hit.letters[0].id, "t-1");

      const cal = await srv.get(`?month=${day.slice(0, 7)}`);
      const calHit = cal.body.days.find((d) => d.day === day);
      assert.ok(calHit, "按月的窗口里也要有这一天（日历格子靠它点亮）");
      assert.equal(calHit.hasDiary, true);
    } finally { await srv.kill(); await srv.cleanup(); }
  });
});

// ---------------------------------------------------------------- ③ 契约与前端接线

function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/gu, " ");
  return src.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/(?<![:"'`])\/\/[^\n]*/gu, blank);
}

const read = (p) => readFile(join(ROOT, p), "utf8");

describe("契约与前端接线", () => {
  test("契约里登记了 /api/timeline（只读、available）", async () => {
    const contract = JSON.parse(await read("app/contracts/http_contract.json"));
    const entry = contract.routes?.["/api/timeline"];
    assert.ok(entry, "契约里必须登记 /api/timeline，否则客户端不知道它存在");
    assert.deepEqual(entry.methods, ["GET"]);
    assert.equal(entry.read_only, true);
    assert.equal(entry.state, "available");
    assert.equal(entry.capability, "letters.timeline");
  });

  test("信箱里有三档视图切换（列表 / 时间轴 / 日历）", async () => {
    const html = (await read("app/public/index.html")).replace(/<!--[\s\S]*?-->/gu, "");
    assert.match(html, /id="mailViewSwitch"/u, "要有视图切换的容器");
    for (const view of ["list", "timeline", "calendar"]) {
      assert.match(html, new RegExp(`data-view="${view}"`, "u"), `缺 ${view} 这一档按钮`);
    }
  });

  test("三种看法共用一个出口：renderLetterList 里按 mailView 分流", async () => {
    const js = stripComments(await read("app/public/app.js"));
    assert.match(js, /function renderLetterList\(\)/u);
    assert.match(js, /mailView === "timeline"[\s\S]{0,120}renderTimeline\(host\)/u, "时间轴必须由 renderLetterList 分流过去");
    assert.match(js, /mailView === "calendar"[\s\S]{0,120}renderCalendar\(host\)/u, "日历必须由 renderLetterList 分流过去");
    assert.match(js, /function renderTimeline\(/u);
    assert.match(js, /function renderCalendar\(/u);
    assert.match(js, /function setMailView\(/u);
  });

  test("★ 重画要保住滚动位置：5 秒轮询不许把人拽回顶部", async () => {
    const js = stripComments(await read("app/public/app.js"));
    assert.match(js, /const keepScroll = host\.scrollTop;/u, "重画前要先记下滚动位置");
    const restores = (js.match(/host\.scrollTop = keepScroll;/gu) ?? []).length;
    assert.ok(restores >= 3, `列表/时间轴/日历三条路都要还原滚动位置，实际只找到 ${restores} 处`);
  });

  test("数据只从 /api/timeline 来：前端不自己算哪天有信", async () => {
    const js = stripComments(await read("app/public/app.js"));
    assert.match(js, /api\("\/api\/timeline"\)/u, "时间轴走 /api/timeline");
    assert.match(js, /\/api\/timeline\?month=/u, "日历按月取同一份数据");
    // 反向判据：前端不许自己拿 lettersCache 去分日聚合（那就会出现第二份口径）。
    assert.ok(!/lettersCache\.reduce\(/u.test(js), "前端不该再写一份按日聚合");
  });

  test("启动时挂上切换与点击（一次性委托），且寄出/重试后时间轴作废", async () => {
    const js = stripComments(await read("app/public/app.js"));
    const bindAt = js.indexOf("bindMailReview();");
    const pollAt = js.indexOf("setInterval(loadLetters, 5000);");
    assert.ok(bindAt > 0, "启动区必须调用 bindMailReview()");
    assert.ok(pollAt > bindAt, "要在开始轮询之前挂好，否则第一次重画时点击是死的");
    const invalidate = (js.match(/invalidateTimeline\(\);/gu) ?? []).length;
    assert.ok(invalidate >= 2, `寄出与重试之后都要作废缓存，实际只有 ${invalidate} 处`);
  });

  test("样式：三种视图的规则都在（且不是被注释掉的）", async () => {
    const css = (await read("app/public/styles-original.css")).replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const cls of [".mail-viewswitch {", ".mail-viewswitch-btn.is-active", ".timeline-day {", ".timeline-row {", ".cal-grid {", ".cal-cell.has-mark", ".cal-dot.is-diary"]) {
      assert.ok(css.includes(cls), `缺样式 ${cls}`);
    }
  });

  test("★ 状态点四态都要有样式：失败 / 她写的 / 已回 / 待回（暗底上分不开等于没有）", async () => {
    const css = (await read("app/public/styles-original.css")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const js = stripComments(await read("app/public/app.js"));
    for (const cls of [".timeline-dot.is-error", ".timeline-dot.is-her", ".timeline-dot.is-send", ".timeline-dot.is-waiting"]) {
      assert.ok(css.includes(cls), `缺状态点样式 ${cls}`);
    }
    // 判据不能只是"四个类名都出现过"——要它们在同一个三元里被真正选出来。
    assert.match(js, /letter\.failed \? "is-error" : her \? "is-her" : replied \? "is-send" : "is-waiting"/u,
      "四种状态的选法必须写在一处，别分散到别处又分叉");
    assert.match(js, /const replied = letter\.status === 4;/u, "「已回信」认的是 status === 4（与 STATUS.REPLIED 同值）");
    assert.ok(!/timeline-dot[^\n]*is-pending/u.test(js), "别再用 is-pending 那种深色（暗底上看不见）");
  });

  test("★ 列表标题必须能省略号截断，不许把侧栏撑破（真机量到过 65px 溢出）", async () => {
    const css = (await read("app/public/styles-original.css")).replace(/\/\*[\s\S]*?\*\//gu, "");
    const rule = css.slice(css.indexOf(".mail-item-content {"), css.indexOf("}", css.indexOf(".mail-item-content {")));
    // 行内 span 上的 overflow / text-overflow 不生效 —— 必须先把父级变成 flex 容器（子项块级化）。
    assert.match(rule, /display:\s*flex/u, ".mail-item-content 必须是 flex 容器，否则子 span 的 ellipsis 不生效");
    assert.match(rule, /flex-direction:\s*column/u);
    assert.match(rule, /min-width:\s*0/u, "作为 flex item 必须允许收缩，否则整行被文字顶宽");
  });

  test("错峰：列表模板里不出现时间轴/日历的类名（免得两套版式互相串）", async () => {
    const js = stripComments(await read("app/public/app.js"));
    const listBody = js.slice(js.indexOf("host.innerHTML = lettersCache.map"), js.indexOf("for (const row of host.querySelectorAll(\".mail-item\")"));
    assert.ok(listBody.length > 100, "没抓到列表那段模板，判据失效");
    assert.ok(!listBody.includes("timeline-row"), "列表模板里不该出现 timeline-row");
    assert.ok(!listBody.includes("cal-cell"), "列表模板里不该出现 cal-cell");
  });
});
