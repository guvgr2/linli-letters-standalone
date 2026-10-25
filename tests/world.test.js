/**
 * A3「她的世界」的护栏（2026-10-19 方案 3 节 + UI 规格 4.3/5.3）。
 *
 * 盯的是六件"看着有、其实没有"的事：
 *   ① 纯函数 `worldAt()` 在边界上不出界：activity 只能是枚举里的四种，跨零点不抖；
 *   ② `/api/world/now` 回出来的形状与规格一致，且**真的落了库**（"依据"弹层要能点开）；
 *   ③ 用户点了曲子时 `practice` 必须是 null —— 她让开不是前端自己判断的；
 *   ④ 开关关着时 `practice` 也是 null（关掉就是关掉，不留后门）；
 *   ⑤ 同一首半小时内不重复、一小时内最多两次（限频在服务端，刷新页面绕不过去）；
 *   ⑥ `enabled` 非布尔要 400，不许把字符串当真值存进去。
 *
 * 跑法：node --test --test-force-exit tests\world.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { worldAt, WORLD_ACTIVITIES, assertWorldState } from "../app/core.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "app", "server.mjs");

async function boot({ library = null, bootGraceMs = "0" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "linli-world-"));
  // ★ bootGraceMs：练琴的开机宽限（2026-10-20 用户口径「启动后要先播待机」）。
  //   测试里默认 "0"（练琴立刻可用，⑤⑥ 的老行为不变）；宽限本身由 ⑧ 真行为测。
  const env = {
    ...process.env,
    LINLI_DATA_DIR: dataDir,
    LINLI_PORT: "0",
    LINLI_NO_GAME_ASSETS: "1",
    LINLI_WORLD_BOOT_GRACE_MS: bootGraceMs,
  };
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
  const call = async (path, { method = "GET", body = null } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "X-Linli-Token": token, "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: body === null ? undefined : JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  };
  if (library) {
    const r = await call("/api/library/dir", { method: "POST", body: { dir: library } });
    assert.equal(r.status, 200, "设置曲库目录应当成功");
  }
  return {
    port, token, dir: dataDir,
    call,
    async enable(enabled = true) {
      const r = await call("/api/world/stage", { method: "POST", body: { enabled } });
      assert.equal(r.status, 200);
      return r.payload;
    },
    kill() { child.kill(); return new Promise((resolve) => child.on("exit", resolve)); },
    cleanup() { return cleanupDir(dataDir); },
  };
}

/** 造一个小曲库：两首曲子，各一段视频（服务端只判文件名与存在性）。 */
async function makeLibrary() {
  const dir = await mkdtemp(join(tmpdir(), "linli-world-lib-"));
  // ★ 三首，不是两首：只有三首时"一小时最多两次"才可能被单独抓到 ——
  //   两首的情况下，第三次请求即使限频判断失效也会因为"两首都刚练过"而返回 null，
  //   于是「限频失效」这个变异在测试里看不见（变异跑出来是假绿）。
  for (const name of ["Solo_Alpha", "Solo_Bravo", "Solo_Charlie"]) {
    const songDir = join(dir, name);
    await mkdir(songDir, { recursive: true });
    await writeFile(join(songDir, `${name}_TOD1200_NI_L.mp4`), "x");
    await writeFile(join(songDir, `${name}_TOD1730_NI_L.mp4`), "x");
    await writeFile(join(songDir, `${name}_TOD2000_NI_L.mp4`), "x");
  }
  return dir;
}

describe("worldAt：纯函数的边界", () => {
  test("① activity 永远是枚举里的值，且 24 小时扫一遍不抛", () => {
    const base = 1792378670; // 2026-10-19 前后某个时刻，取整点即可
    for (let h = 0; h < 24; h += 1) {
      const now = base - (base % 3600) + h * 3600;
      const state = assertWorldState(worldAt({ now, lastLetterAt: null, lastReplyAt: null, plays: [], habits: [] }));
      assert.ok(WORLD_ACTIVITIES.includes(state.activity), `h=${h} 给出了枚举外的 activity：${state.activity}`);
      assert.equal(typeof state.reason, "string");
      assert.ok(state.reason.length > 0, "reason 不许为空 —— 界面要拿它解释");
    }
  });

  test("② 你最近常放的那首会盖过作息，证据里带曲名与次数", () => {
    const now = 1792378670;
    const state = worldAt({
      now,
      lastLetterAt: null,              // 不给来信时间：否则 >=3 天会先落到「等你」分支
      lastReplyAt: null,
      plays: [
        { dir: "Solo_Alpha", at: now - 1800, count: 1 },
        { dir: "Solo_Alpha", at: now - 3600, count: 1 },
        { dir: "Solo_Bravo", at: now - 7200, count: 1 },
      ],
      habits: [],
    });
    // ★ 「你最近总放」在纯函数里落在 activity = 「练琴」（她在练你常放的那首），
    //   一开始按「听歌」写，是测试自己写错 —— 以 core.mjs 的实现为准。
    assert.equal(state.activity, "练琴");
    assert.equal(state.evidence.songDir, "Solo_Alpha");
    assert.ok(state.evidence.count >= 2, `次数应 >= 2，实际 ${state.evidence.count}`);
  });

  test("③ 她刚写完回信时是「写信」，来源标记为 letter", () => {
    const now = 1792378670;
    // ★ 判据是 lastReplyAt（"她刚写完回信"），不是 lastLetterAt —— 后者 3 天没信才是「等你」。
    //   这一条一开始写成只给 lastLetterAt，结果按作息落到「听歌」，是测试自己写错了。
    const state = worldAt({ now, lastLetterAt: now - 60, lastReplyAt: now - 300, plays: [], habits: [] });
    assert.equal(state.activity, "写信", "刚回完信应当是「写信」");
    assert.equal(state.source, "letter");
  });
});

describe("她的世界接口", () => {
  test("④ 形状对：state/practice/enabled，且真的写进了 world_state", async () => {
    const s = await boot();
    try {
      const first = await s.call("/api/world/now");
      assert.equal(first.status, 200);
      assert.equal(first.payload.enabled, false, "默认必须是关的 —— 首次询问默认关，不许自作主张");
      assert.equal(first.payload.practice, null, "关着的时候不许给她安排练琴");
      assert.ok(WORLD_ACTIVITIES.includes(first.payload.state.activity));

      await s.enable(true);
      const second = await s.call("/api/world/now");
      assert.equal(second.status, 200);
      assert.equal(second.payload.enabled, true);

      const list = await s.call("/api/world");
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.payload.recent) && list.payload.recent.length >= 1, "「依据」要能查历史");
      const at = list.payload.recent[0].at;
      const one = await s.call(`/api/world/${at}`);
      assert.equal(one.status, 200, "按时间戳取单条应当能取到");
      assert.equal(one.payload.at, at);
      const missing = await s.call("/api/world/1");
      assert.equal(missing.status, 404);
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("⑤ 用户点了曲子 ⇒ practice 必须是 null（她让开）", async () => {
    const lib = await makeLibrary();
    const s = await boot({ library: lib });
    try {
      await s.enable(true);
      const idle = await s.call("/api/world/now");
      assert.ok(idle.payload.practice, "开着开关、库里有歌时应当安排她练一首");
      assert.ok(idle.payload.practice.url.startsWith("/api/media?"), "给的必须是能直接播的地址");

      const play = await s.call("/api/stage/play", { method: "POST", body: { dir: "Solo_Alpha" } });
      assert.equal(play.status, 200);
      const after = await s.call("/api/world/now");
      assert.equal(after.payload.practice, null, "用户点播之后她还占着桌面 = 没让开");
    } finally {
      await s.kill();
      await s.cleanup();
      await cleanupDir(lib);
    }
  });

  test("⑥ 一场之内反复轮询必须给**同一首**（这就是「练琴放一半被切断」的根因），收场后才换、且限频", async () => {
    const lib = await makeLibrary();
    const s = await boot({ library: lib });
    try {
      await s.enable(true);
      const a = await s.call("/api/world/now");
      assert.equal(a.payload.practice.dir, "Solo_Alpha");
      // ★★ 2026-10-20 用户：「练琴音乐还没播完就中断了」。原来的 /api/world/now **每被问一次
      //   就重新挑一首**（还记一笔），壁纸层 30 秒问一次 ⇒ 两次就烧完限额，第三次返回 null，
      //   页面落回待机，正在放的练琴曲当场被切。所以这条必须断言"同一场不会换曲"。
      const again = await s.call("/api/world/now");
      assert.equal(again.payload.practice.dir, "Solo_Alpha", "同一场之内不许换曲（换了就是「放一半被切」）");
      const third = await s.call("/api/world/now");
      assert.equal(third.payload.practice.dir, "Solo_Alpha", "轮询多少次都还是这一场");

      // 放完了 ⇒ 收场 ⇒ 下一次才换另一首（同一首 30 分钟内不许重复）
      const done = await s.call("/api/world/practice/done", { method: "POST", body: {} });
      assert.equal(done.status, 200, "收场接口要能调通");
      const b = await s.call("/api/world/now");
      assert.equal(b.payload.practice.dir, "Solo_Bravo", "上一场收场后应当换另一首");
      await s.call("/api/world/practice/done", { method: "POST", body: {} });
      const c = await s.call("/api/world/now");
      assert.equal(c.payload.practice, null, "一小时最多两次，第三场必须让位");
    } finally {
      await s.kill();
      await s.cleanup();
      await cleanupDir(lib);
    }
  });

  test("⑦ enabled 不是布尔 ⇒ 400，且不会把开关改成开", async () => {
    const s = await boot();
    try {
      const bad = await s.call("/api/world/stage", { method: "POST", body: { enabled: "yes" } });
      assert.equal(bad.status, 400);
      const now = await s.call("/api/world/now");
      assert.equal(now.payload.enabled, false);
    } finally {
      await s.kill();
      await s.cleanup();
    }
  });

  test("⑧ 开机宽限：宽限期内练琴一律不安排（用户开程序要先听到待机），过了宽限恢复", async () => {
    // ★ 2026-10-20 用户原话：「启动程序后为什么要先播一段歌曲，不应该是先播待机音乐和视频吗」
    //   —— 实测：开机第一拍 tick 轮到她的世界，world_plays 当秒落 practice 记录，
    //   用户开程序听到的是练琴不是待机。宽限期（默认 5 分钟）内 practice 必须 null。
    const lib = await makeLibrary();
    const s = await boot({ library: lib, bootGraceMs: "2500" });
    try {
      await s.enable(true);
      const during = await s.call("/api/world/now");
      assert.equal(during.payload.practice, null, "宽限期内不许安排练琴（开机先待机）");
      // 宽限一过（这里把宽限调短到 2.5 秒来等），练琴恢复正常
      await new Promise((r) => setTimeout(r, 2600));
      const after = await s.call("/api/world/now");
      assert.ok(after.payload.practice, "宽限过后她应当能练琴（宽限不是关掉）");
      // 宽限后给的必须是曲库里真能播的那首（判据自证：不是"永远 null"的假实现）
      assert.ok(
        ["Solo_Alpha", "Solo_Bravo", "Solo_Charlie"].includes(after.payload.practice.dir),
        `练琴给的必须是曲库里的曲子，实际 ${after.payload.practice.dir}`,
      );
    } finally {
      await s.kill();
      await s.cleanup();
      await cleanupDir(lib);
    }
  });
});

// ---------------------------------------------------------------- 练琴预告（壁纸层，2026-10-20）
//
// ★ 用户原话：「练琴在触发前弹个提醒，但弹窗不要干扰到用户的工作，练琴不要人家正播着
//   音乐呢突然就开始练，要等正在播放的的歌曲播完了，然后才开始练琴」
//   ⇒ 三条判据：预告先于开练（角落小字 + 延迟定时器）、点歌即取消、练琴只在没曲子时被问。
//   ★ 先剥 HTML/JS 注释再判（老规矩：注释里出现这些词不算数）。
describe("练琴预告（壁纸层）", () => {
  const wp = readFileSync(join(ROOT, "app", "public", "wallpaper.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("① 触发前必须先预告：角落提示 + 延迟定时器（不模态、不抢焦点）", () => {
    assert.ok(wp.includes("她要去练琴了"), "开练前必须先弹预告文案");
    const ms = /PRACTICE_NOTICE_MS = (\d+)/u.exec(wp);
    assert.ok(ms, "预告时长必须有具名常量");
    assert.ok(Number(ms[1]) >= 3000, `预告至少 3 秒（给用户反应时间），实际 ${ms[1]}ms`);
    assert.ok(/practicePending = setTimeout\(/u.test(wp), "开练必须经延迟定时器（预告期）");
  });

  test("② 预告期间用户点歌 ⇒ 取消这次练琴（cancel 挂在 song 分支）", () => {
    assert.ok(/function cancelPendingPractice\(\)/u.test(wp), "取消函数必须存在");
    const tick = wp.slice(wp.indexOf("async function tick()"), wp.indexOf("async function start()"));
    const cancelAt = tick.indexOf("cancelPendingPractice();");
    const songAt = tick.indexOf("/api/stage/next");
    const practiceAt = tick.indexOf("/api/world/now");
    assert.ok(cancelAt > 0 && cancelAt < practiceAt, "song 分支里必须取消预告（在练琴分支之前）");
    assert.ok(songAt >= 0 && practiceAt > songAt, "tick 必须先问 stage/next 再问 world/now（用户点播优先于练琴）");
  });
});
