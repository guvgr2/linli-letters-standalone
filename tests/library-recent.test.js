/**
 * 「最近演出」与「已入库曲目」这两个读接口的护栏。
 *
 * 为什么单开一个文件：
 *   2026-10-19 做覆盖度盘点时（analysis/_stress-2026-10-19/r4-coverage-scan.mjs）把
 *   server.mjs 里 48 条路由逐个去 25 个测试文件里对名字，查出 10 条**一次都没被提到**；
 *   其中 `/api/library/songs`、`/api/library/recent`、`/api/library/played` 三条
 *   恰好是 2026-10-18 才补的功能（server.mjs 里带日期注释：「原版曲库页有『最近演出』」）。
 *   ⇒ 新功能做完了、界面上也在用，但**没有任何一条用例会因为它的破坏而变红**。
 *   这份就是把这一块补上。
 *
 * ★★ 这里用了**多套独立夹具**，不是为了讲究，是被逼出来的：
 *     第 ③ 条要验证 limit 的上界夹到 50 ⇒ 播过的曲子必须 ≥ 51 首
 *       （否则 limit=200 和 limit=50 返回一样多，夹不夹看不出差别）；
 *     第 ⑥ 条要验证「只数播过的」那条 SQL 条件 ⇒ recent 取回的结果里必须**容得下那首没播过的**
 *       （它 lastPlayedAt=0，DESC 排序永远排最后，rows 超过 50 就被窗口切掉）
 *       ⇒ 这一套要求"已播数量少"。
 *     一个要 ≥51 已播、一个要已播很少 —— 同一份数据装不下，只能各起一套。
 *
 * ★ 本文件第 ④ 条是**已知缺陷的护栏**，当前会是红的（详见审查报告 R4-1）：
 *     GET /api/library/recent?limit=1.9 ⇒ 500 COMMON_INTERNAL（SQLite: datatype mismatch）。
 *   根因：server.mjs 那段夹取只夹了**范围**、没夹**整数** ——
 *        Math.min(50, Math.max(1, Number(x) || 12))
 *   `1.9` 落在 [1,50] 内所以被原样喂进 SQL 的 `LIMIT ?`。
 *   （`0.5` 被 Math.max 救成 1、`50.0` 被 Math.min 救成 50，只有落在开区间 (1,50) 的非整数会漏下去。）
 *   它不是"天天红"：每次都稳定复现，跟环境无关。修好之后这条会自然转绿。
 *
 * 跑法：node --test --test-force-exit tests\library-recent.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

// ★ nowSeconds() 精度到秒。**跨秒是排序能否被验证的前提**：
//   同一秒播完的几首，last_played_at 完全相同 ⇒ ORDER BY DESC 在并列时由 SQLite 自行定序，
//   打印出来的顺序说明不了任何事（第一轮探路就被这个假象骗过，差点误报成"排序反了"）。
const NEXT_SECOND = 1150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 目录名必须过 core.mjs 的 LIBRARY_DIR_PATTERN = /^(?:solo|playsing|midi|oliviasoul)/iu，否则扫不到。
const dirName = (i) => `solo_n${String(i).padStart(2, "0")}`;

function waitForPort(child, logs, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`服务在 ${timeoutMs}ms 内没报出 LINLI_PORT。输出：\n${logs.join("")}`)),
      timeoutMs,
    );
    const onChunk = (chunk) => {
      logs.push(chunk.toString("utf8"));
      const hit = /LINLI_PORT=(\d+)/u.exec(logs.join(""));
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code=${code}）。输出：\n${logs.join("")}`));
    });
  });
}

/**
 * 起一套干净的夹具：临时数据目录 + 临时曲库 + 真服务 + 真入库 + 按 played 指定的首数播过。
 * 每个 describe 各自一套，彼此不串味（共享服务的话，前一个 describe 播过的歌会污染后一个的判据）。
 *
 * @param {object} opt
 * @param {number} opt.total     曲库里放几首（含不入库的那首）
 * @param {number} opt.imported  入库几首（取前 N 首）
 * @param {number} opt.played    把前几首标记为播过（其余入库的留在"入库但没播"状态）
 */
async function bootFixture({ total, imported, played }) {
  const dataDir = await mkdtemp(join(tmpdir(), "linli-recent-"));
  const libraryDir = join(dataDir, "music");
  for (let i = 0; i < total; i++) {
    const full = join(libraryDir, dirName(i));
    await mkdir(full, { recursive: true });
    await writeFile(join(full, `${dirName(i)}_TOD1200_NI_L.mp4`), Buffer.alloc(16));
  }

  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_ASSETS_DIR: join(dataDir, ".no-assets") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;

  const req = (path, { method = "GET", body } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "x-linli-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
  const post = (p, body) => req(p, { method: "POST", body });
  const jget = async (p) => {
    const res = await req(p);
    return { res, body: await res.json().catch(() => null) };
  };

  const put = await post("/api/library/dir", { dir: libraryDir });
  assert.equal(put.status, 200, "设置曲库目录失败");
  for (let i = 0; i < imported; i++) await post("/api/library/import", { dir: dirName(i) });
  for (let i = 0; i < played; i++) await post("/api/library/played", { title: dirName(i), dir: dirName(i) });

  return {
    jget,
    post,
    req,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited.catch(() => {});
      }
      await cleanupDir(dataDir).catch(() => {});
    },
  };
}

// ========================================================== 夹具 A：多数播过
// 55 首入库、前 54 首播过 ⇒ 查询窗口里有足够多的已播曲目，用来验夹取与排序。
const A = { total: 60, imported: 55, played: 54 };
// 入库了但没播过（第 ⑥ 条用的样本；在夹具 B 里它才进得了查询窗口）
const NEVER_PLAYED_A = dirName(A.played);
// 扫得到但没入库（第 ⑦ 条用的样本）
const UNIMPORTED_A = dirName(A.total - 1);

describe("已入库曲目：/api/library/songs", () => {
  test("① 只返回入库的；扫得到但没入库的那一首不许出现", async () => {
    const fx = await bootFixture(A);
    try {
      const { body } = await fx.jget("/api/library/songs");
      assert.ok(Array.isArray(body?.songs), "该返回 songs 数组");
      assert.equal(body.songs.length, A.imported, `入库 ${A.imported} 首，就该返回 ${A.imported} 首`);
      assert.ok(
        !body.songs.some((s) => s.dir === UNIMPORTED_A),
        `${UNIMPORTED_A} 没入库，不该出现在曲目清单里 —— 出现了就是"导入"这层漏了`,
      );
    } finally { await fx.kill(); }
  });
});

describe("最近演出：条数与 limit 夹取", () => {
  let fx;
  test("② 不带 limit 时默认 12 条（前端就是写死 limit=12 调的）", async () => {
    fx = await bootFixture(A);
    const { res, body } = await fx.jget("/api/library/recent");
    assert.equal(res.status, 200);
    assert.equal(body.songs.length, 12, `播了 ${A.played} 首但不带 limit 应当回 12 条`);
  });

  test("③ limit 上下界都要夹住：输入框里打什么都得落在 1..50", async () => {
    // 200/51/50 ⇒ 夹到上界 50；0 / 空 / 非数字 ⇒ 回落默认 12；-5 ⇒ 顶到下界 1。
    // ★ 上界这条只有在「已播数量 > 50」时才可能有说服力：库里总共才 15 首的时候，
    //   把 Math.min(50,…) 删掉 limit=200 也照样返回 15 ⇒ 断言形同虚设（第一版就犯了这个）。
    const cases = [["200", 50], ["51", 50], ["50", 50], ["0", 12], ["abc", 12], ["", 12], ["NaN", 12], ["%20", 12], ["-5", 1], ["1", 1]];
    for (const [q, expect] of cases) {
      const { res, body } = await fx.jget(`/api/library/recent${q === "" ? "" : `?limit=${q}`}`);
      assert.equal(res.status, 200, `limit=${q || "(空)"} 应当 200，实际 ${res.status}`);
      const n = body?.songs?.length;
      assert.equal(n, expect, `limit=${q || "(空)"} 应当回 ${expect} 条，实际 ${n}`);
    }
  });

  test("④ limit 是非整数时必须给个好归宿，绝不能 500（当前实现有缺陷 R4-1）", async () => {
    // ★ 这一条现在是**红的**，红得有道理：见文件头注释。
    //   建议的修法（本轮我只审计、不改代码，方向给在这里）：
    //       const raw = Number(sp.get("limit"));
    //       const limit = Number.isInteger(raw) ? Math.min(50, Math.max(1, raw)) : 12;
    //   即：把"取不到"的定义从 `|| 12`（只挡 falsy 与 NaN）扩成"非整数也算取不到"。
    for (const q of ["1.9", "2.0000000001", "49.5", "1.000001"]) {
      const res = await fx.req(`/api/library/recent?limit=${encodeURIComponent(q)}`);
      const body = await res.json().catch(() => null);
      assert.notEqual(
        res.status,
        500,
        `limit=${q} 打出了 500（code=${body?.code}）—— SQLite 报 datatype mismatch：夹取只夹了范围没夹整数`,
      );
      assert.ok(res.status >= 200 && res.status < 400, `limit=${q} 应当给个可用结果或 4xx，实际 ${res.status}`);
    }
  });

  test("⑤ 最新播过的排第一（跨秒重播一次，它必须顶上来）", async () => {
    try {
      // ★★ 次序关键：**先跨过一秒，再播**，而不是播完再等。
      //   lastPlayedAt 取的是「播放那一刻」的秒数 —— 播完再 sleep 只把**读取**推后，
      //   时间戳纹丝不动 ⇒ 这一首会和前面那批落在同一秒 ⇒
      //   ORDER BY 在并列时由 SQLite 自行定序，DESC 和 ASC 都可能把它排在首位
      //   ⇒ 排序 ASC 的变异只有 2/5 次能把它撞红（实测），这条护栏等于半瞎。
      await sleep(NEXT_SECOND);
      const oldest = dirName(0);
      await fx.post("/api/library/played", { title: oldest, dir: oldest });
      await sleep(NEXT_SECOND); // 再跨一秒，确保它独占最新那个秒值，不必再和其它歌并列
      const { body } = await fx.jget("/api/library/recent?limit=20");
      assert.equal(body.songs[0].dir, oldest, `刚重播的 ${oldest} 应排第一，实际首位是 ${body.songs[0].dir}`);
      const stamps = body.songs.map((s) => s.lastPlayedAt);
      // ★ 必须**严格递减**而不是 <=：允许相等就等于允许并列，而并列时 SQLite 怎么排都不算错，
      //   排序的约定一旦被允许并列就再也验不出来了。
      assert.ok(stamps[0] > stamps[1], `首条（${stamps[0]}）必须严格新于第二条（${stamps[1]}），相等说明时间戳并列了`);
      for (let i = 1; i < stamps.length; i++) {
        assert.ok(stamps[i - 1] >= stamps[i], `第 ${i} 条的 lastPlayedAt 比上一条还新，排序反了：${stamps}`);
      }
    } finally { await fx.kill(); }
  });
});

describe("最近演出：只能数播过的（独立夹具，理由见文件头）", () => {
  test("⑥ 入库了但没播过的曲子，不许混进最近演出", async () => {
    // ★ 为什么必须另起一套（played 只有 3 首）：
    //   没播过的那首在 songs 表里、时间戳为 0 ⇒ ORDER BY DESC 时永远排在最后。
    //   若同时有 54 首播过的，它就落在第 55 位，而 limit 最大只夹到 50 ⇒
    //   它**无论如何**都在窗口外，把 `WHERE last_played_at > 0` 删掉也照样看不见
    //   ⇒ 这条断言会变成自证好成绩的假护栏（第一版就是这样，变异测试 M5 当场判它"仍绿"）。
    const B = { total: 60, imported: 55, played: 3 };
    const neverPlayed = dirName(B.played);
    const fx = await bootFixture(B);
    try {
      // 前提自证：它确实在曲目表里（否则这条断言是空的）
      const listed = await fx.jget("/api/library/songs");
      assert.ok(
        listed.body.songs.some((s) => s.dir === neverPlayed),
        `前提不成立：${neverPlayed} 不在曲目表里，这条判据等于没设`,
      );

      const { body } = await fx.jget("/api/library/recent?limit=50");
      assert.equal(body.songs.length, B.played, `只播过 ${B.played} 首，limit=50 也只该回 ${B.played} 条`);
      assert.ok(
        !body.songs.some((s) => s.dir === neverPlayed),
        `${neverPlayed} 在库里但从没播过 —— 出现在最近演出里，说明「只数播过的」那条 SQL 条件没了`,
      );
    } finally { await fx.kill(); }
  });
});

describe("播放记录：/api/library/played", () => {
  test("⑦ 播放不是导入：没入库的曲子播一次，不许把自己塞进曲目清单", async () => {
    // server.mjs 注释原话：「没入库的曲子不因为播过一次就冒出到『已导入』里 ——
    //   那是另一个动作（/api/library/import）才该干的事。」
    // 这条要是破了，用户每放一次歌，左栏就自己长出一张新专辑 ⇒ 列表会被听歌行为污染。
    const fx = await bootFixture({ total: 60, imported: 55, played: 0 });
    try {
      const before = await fx.jget("/api/library/songs");
      const n0 = before.body.songs.length;
      const res = await fx.post("/api/library/played", { title: "不该出现的一首", dir: UNIMPORTED_A });
      assert.equal(res.status, 200, "播放记录本身是成功的动作");

      const after = await fx.jget("/api/library/songs");
      assert.equal(after.body.songs.length, n0, `播 ${UNIMPORTED_A} 一次就让曲目清单从 ${n0} 变成了 ${after.body.songs.length}`);
      assert.ok(!after.body.songs.some((s) => s.dir === UNIMPORTED_A), `${UNIMPORTED_A} 被一次播放偷偷入库了`);
      const recent = await fx.jget("/api/library/recent?limit=50");
      assert.equal(recent.body.songs.length, 0, "没入库的曲子也不该进最近演出");
    } finally { await fx.kill(); }
  });

  test("⑧ 缺曲名要拒绝：LIBRARY_TITLE_REQUIRED", async () => {
    const fx = await bootFixture({ total: 5, imported: 0, played: 0 });
    try {
      for (const bad of [{}, { title: "   " }, { title: null }]) {
        const res = await fx.post("/api/library/played", bad);
        const body = await res.json().catch(() => null);
        assert.equal(res.status, 400, `${JSON.stringify(bad)} 应当 400`);
        assert.equal(body?.code, "LIBRARY_TITLE_REQUIRED", "错误号要能对得上错误号一览");
      }
    } finally { await fx.kill(); }
  });
});
