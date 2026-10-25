/**
 * 「音乐桌面能移出曲目」的端到端护栏（2026-10-20）。
 *
 * 用户原话：「还有音乐桌面的删除按钮呢，我添加进音乐结果删不掉了」。
 * 说完之后界面上加了「移出」，但**真正承重的是服务端那条 DELETE**：
 *   界面上点了没反应、或者删了桌面清单却留着歌单条目，都属于"看着修好了"。
 *
 * 所以这里起真服务、发真 HTTP、直读 sqlite 对账（不是只看 JS 里有没有那个字符串）：
 *   ① 不带 dir ⇒ 400 + LIBRARY_SONG_REQUIRED（不能变成"删了点什么"）
 *   ② 不在桌面上的 dir ⇒ 404 + LIBRARY_SONG_NOT_FOUND（用户看到的是"这首已经不在了"）
 *   ③ 在桌面上 ⇒ 200，`songs` 里那行没了、`song_folder_items` 里它的条目也没了
 *   ④ 再删一次 ⇒ 404（幂等但**不假装成功**）
 *   ⑤ 同一批里别的曲目原样不动（别把整个桌面清空）
 *
 * 跑法：node --test --test-force-exit tests\library-remove-20261020.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { cleanupDir, cleanupDirSync } = require("./support/cleanup.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "app", "server.mjs");

function waitForPort(child, logs, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没报出 LINLI_PORT。输出：\n${logs.join("")}`)), timeoutMs);
    const onChunk = (chunk) => {
      logs.push(chunk.toString("utf8"));
      const hit = /LINLI_PORT=(\d+)/u.exec(logs.join(""));
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 code=${code}：\n${logs.join("")}`)); });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 3000);
  await exited;
  clearTimeout(hard);
}

const KEEP = "Solo_Keep_Alpha";
const DROP = "Solo_Drop_Bravo";

test("DELETE /api/library/songs：移出桌面（真服务 + 真库对账）", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linli-remove-"));
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(ROOT, "app"),
    env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_WORLD_BOOT_GRACE_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let base = "";
  try {
    const port = await waitForPort(child, logs);
    base = `http://127.0.0.1:${port}`;
    const { token } = await (await fetch(`${base}/api/session`)).json();
    assert.ok(token, "拿不到会话令牌");

    // ---- 夹具：桌面上两首 + 它们各自在歌单里的条目 -------------------------
    const dbPath = path.join(dataDir, "letters.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    const now = Math.floor(Date.now() / 1000);
    const insSong = db.prepare("INSERT OR REPLACE INTO songs(dir, name, added_at, last_played_at) VALUES(?,?,?,?)");
    for (const dir of [KEEP, DROP]) insSong.run(dir, `曲子 · ${dir}`, now, 0);
    const folders = db.prepare("SELECT id FROM song_folders LIMIT 1").get();
    let folderId = folders?.id ?? null;
    if (!folderId) {
      folderId = "fixture-folder";
      db.prepare("INSERT OR REPLACE INTO song_folders(id, name, sort_order, created_at, updated_at) VALUES(?,?,?,?,?)")
        .run(folderId, "夹具歌单", 0, now, now);
    }
    const insItem = db.prepare("INSERT OR REPLACE INTO song_folder_items(folder_id, dir, sort_order, added_at) VALUES(?,?,?,?)");
    for (const dir of [KEEP, DROP]) insItem.run(folderId, dir, 0, now);
    db.close();

    const rows = () => {
      const conn = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return {
          songs: conn.prepare("SELECT dir FROM songs ORDER BY dir").all().map((r) => r.dir),
          items: conn.prepare("SELECT dir FROM song_folder_items ORDER BY dir").all().map((r) => r.dir),
        };
      } finally { conn.close(); }
    };

    const del = async (query) => {
      const res = await fetch(`${base}/api/library/songs${query}`, {
        method: "DELETE",
        headers: { "x-linli-token": token },
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    await t.test("① 不带 dir ⇒ 400，而不是「删了点什么」", async () => {
      const r = await del("");
      assert.equal(r.status, 400, `实际 ${r.status}：${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "LIBRARY_SONG_REQUIRED");
      assert.deepEqual(rows().songs, [DROP, KEEP], "400 的那一次居然动了库");
    });

    await t.test("② 不在桌面上的 dir ⇒ 404 LIBRARY_SONG_NOT_FOUND", async () => {
      const r = await del("?dir=Solo_Not_There");
      assert.equal(r.status, 404, `实际 ${r.status}：${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "LIBRARY_SONG_NOT_FOUND");
      assert.deepEqual(rows().songs, [DROP, KEEP], "404 的那一次动了库");
    });

    await t.test("③ 真移出：songs 与歌单条目一起清，返回的清单里也没有它了", async () => {
      const r = await del(`?dir=${encodeURIComponent(DROP)}`);
      assert.equal(r.status, 200, `实际 ${r.status}：${JSON.stringify(r.body)}`);
      assert.equal(r.body.removed, DROP);
      assert.ok(Array.isArray(r.body.songs), "返回里没有最新清单（界面要靠它重画）");
      assert.ok(!r.body.songs.some((s) => s.dir === DROP), "返回的清单里还留着这首");
      const after = rows();
      assert.deepEqual(after.songs, [KEEP], `songs 里还剩：${after.songs.join(",")}`);
      // ★ 歌单条目必须一起清：留下孤儿行的话，歌单页会显示一首已经不在桌上的曲子
      assert.ok(!after.items.includes(DROP), `song_folder_items 里还留着 ${DROP} —— 歌单会多出一首幽灵`);
      assert.ok(after.items.includes(KEEP), "同一歌单里别的曲目被连坐了");
    });

    await t.test("④ 再删一次 ⇒ 404（幂等，但不假装成功）", async () => {
      const r = await del(`?dir=${encodeURIComponent(DROP)}`);
      assert.equal(r.status, 404, `第二次删除回了 ${r.status}`);
      assert.equal(r.body.code, "LIBRARY_SONG_NOT_FOUND");
    });

    await t.test("⑤ 桌面清单接口里已经没有它", async () => {
      const list = await (await fetch(`${base}/api/library/songs`)).json();
      const dirs = (list.songs ?? []).map((s) => s.dir);
      assert.ok(!dirs.includes(DROP), `/api/library/songs 还返回 ${DROP}`);
      assert.ok(dirs.includes(KEEP), "把不该删的那首也弄没了");
    });
  } finally {
    await stopServer(child);
    cleanupDirSync(dataDir);
  }
});
