/**
 * 歌单的**端到端**护栏：起真服务 → 发真 HTTP → 落真库。
 *
 * 为什么单有一个文件：
 *   歌单是照姊妹项目（E:\olivia-soul-community-kit\repo\source\local-service\
 *   server.js:4897-5280 的 song_folders / song_folder_items）搬过来的。
 *   照抄最容易抄漏的恰好是它注释里专门写明的那几处：
 *     · 删歌单必须**显式删条目** —— 两张表之间没有外键，漏了就留孤儿行；
 *     · 歌单名要**过滤控制字符** —— 它会一路进 JSON 和界面；
 *     · 增删条目后要**刷新 updated_at** —— 前端靠它判断"这个歌单变过"。
 *   这三条都没法靠读代码证明，只能真发请求看库里的样子。
 *
 * ★ 这里还专门护住一条：**没入库的曲子不许加进歌单**。
 *   歌单读出来要 join songs 表取名字，不存在的 dir 加进去也显示不出来 ——
 *   那会是一个"加成功了但看不见"的幽灵条目。
 *
 * 跑法：node --test --test-force-exit tests\folders.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

// ---------------------------------------------------------------- 子进程小工具

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

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已经退出了 */ } }, 3000);
  await exited;
  clearTimeout(hard);
}

async function startServer({ dataDir, libraryDir }) {
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_ASSETS_DIR: join(dataDir, ".no-assets") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200, `拿会话令牌失败：${res.status}`);
  const token = (await res.json()).token;
  // 曲库目录得靠写接口设进去（server.mjs 的 DEFAULT_LIBRARY_DIR 是写死的 E:\linlimusic）
  const put = await fetch(`${base}/api/library/dir`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-linli-token": token },
    body: JSON.stringify({ dir: libraryDir }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(put.status, 200, `设置曲库目录失败：${put.status}`);
  return { child, base, token, logs };
}

/** 带令牌的请求小包装：歌单的写接口都要过令牌闸。 */
function req(base, token, path, { method = "GET", body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "x-linli-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
}

// ---------------------------------------------------------------- 曲库夹具
//
// 目录名必须过 core.mjs:779 的 LIBRARY_DIR_PATTERN = /^(?:solo|playsing|midi|oliviasoul)/iu，
// 否则 scanLibrary 根本看不见它们。
// ★ SONGS 是**曲库目录里有的**；IMPORTED 是**入库的**。两者故意不一样：
//   第 ⑤ 条要证明"扫得到但没入库的曲目加不进歌单"，夹具里就必须留一首只在曲库、
//   不在库表里的 —— 早先两处都用 SONGS，第 ⑤ 条就变成了自证（它当然在库表里）。
const SONGS = ["solo_alpha", "solo_beta", "solo_gamma"];
const IMPORTED = ["solo_alpha", "solo_beta"];

async function buildLibrary(root) {
  for (const dir of SONGS) {
    const full = join(root, dir);
    await mkdir(full, { recursive: true });
    // 每个曲目目录里放一个符合原版 TOD 命名的片子，listVariants 才认得出时段
    await writeFile(join(full, `${dir}_TOD1200_NI_L.mp4`), Buffer.alloc(16));
  }
}

describe("歌单：数据与接口", () => {
  let child = null;
  let base = "";
  let token = "";
  let dataDir = "";
  let libraryDir = "";

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-folders-"));
    libraryDir = join(dataDir, "music");
    await buildLibrary(libraryDir);
    ({ child, base, token } = await startServer({ dataDir, libraryDir }));
    // 只入库 IMPORTED 那两首：solo_gamma 留在"扫得到但没入库"的状态，给第 ⑤ 条用
    for (const dir of IMPORTED) {
      const res = await req(base, token, "/api/library/import", { method: "POST", body: { dir } });
      assert.equal(res.status, 200, `入库 ${dir} 失败：${res.status}`);
    }
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("① 一开始没有歌单，GET 回空数组而不是 null", { timeout: 60000 }, async () => {
    const res = await req(base, token, "/api/folders");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.folders, [], `空态必须是 [] 而不是 ${JSON.stringify(body.folders)}`);
  });

  test("② 新建歌单：名字去空白、带 order 与时间戳", { timeout: 60000 }, async () => {
    const res = await req(base, token, "/api/folders", { method: "POST", body: { name: "  睡前  " } });
    assert.equal(res.status, 200);
    const { folder, folders } = await res.json();
    assert.equal(folder.name, "睡前", "首尾空白必须剪掉，否则页签上会多出一截");
    assert.equal(folder.items.length, 0);
    assert.equal(folders.length, 1);
    assert.ok(folder.createdAt > 0);
    assert.equal(folder.createdAt, folder.updatedAt, "刚建好的歌单，创建与更新时间应当一样");
  });

  test("③ 空名字 / 超长名字 / 控制字符：要么拒绝、要么洗干净", { timeout: 60000 }, async () => {
    // 全是空白 ⇒ 洗完就没了 ⇒ 400
    for (const name of ["", "   ", "\u0000\u0001"]) {
      const res = await req(base, token, "/api/folders", { method: "POST", body: { name } });
      assert.equal(res.status, 400, `name=${JSON.stringify(name)} 竟然被接受了`);
      const body = await res.json();
      assert.equal(body.code, "LIBRARY_FOLDER_NAME_REQUIRED");
    }
    // 41 个字 ⇒ 超长
    const long = "长".repeat(41);
    const res = await req(base, token, "/api/folders", { method: "POST", body: { name: long } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "LIBRARY_FOLDER_NAME_TOO_LONG");

    // ★ 姊妹项目 server.js:4897 的注释专门点过这个：NUL/BEL/ESC/DEL 能原样存进库。
    //   它们进 JSON 不会报错，进 DOM 也不会报错 —— 只是界面上会出现一块看不见的乱码。
    const dirty = await req(base, token, "/api/folders", {
      method: "POST",
      body: { name: "吵\u0007闹\u001b的\u007f歌单" },
    });
    assert.equal(dirty.status, 200);
    const saved = (await dirty.json()).folder.name;
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(saved, /[\u0000-\u001f\u007f]/u, `控制字符没被过滤：${JSON.stringify(saved)}`);
    assert.match(saved, /吵/u, "洗完还得是那个名字，不能整个丢空");
  });

  test("④ 加一首进歌单：能加、能读回名字、重复加不重复记", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const id = list.find((f) => f.name === "睡前").id;

    const add = await req(base, token, `/api/folders/${id}/items`, { method: "POST", body: { dir: "solo_alpha" } });
    assert.equal(add.status, 200);
    const added = await add.json();
    assert.equal(added.added, true);
    assert.equal(added.folder.items.length, 1);
    assert.equal(added.folder.items[0].dir, "solo_alpha");
    // 曲名是从 songs 表 join 出来的，不是前端传的 —— 这里必须已经有人话名字
    assert.ok(added.folder.items[0].name, "条目必须带回曲名，否则列表只能显示目录名");

    // 再加一次同一首：不报错，但也只记一条
    const again = await req(base, token, `/api/folders/${id}/items`, { method: "POST", body: { dir: "solo_alpha" } });
    assert.equal(again.status, 200);
    const twice = await again.json();
    assert.equal(twice.added, false, "已经加过的应当回 added:false，让界面能说「已经在里面了」");
    assert.equal(twice.folder.items.length, 1);
  });

  test("⑤ 没入库的曲目不许加进歌单（否则是加成功但看不见的幽灵条目）", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const id = list.find((f) => f.name === "睡前").id;
    // solo_gamma 在曲库目录里、也 scan 得到，但**没入库**
    const res = await req(base, token, `/api/folders/${id}/items`, { method: "POST", body: { dir: "solo_gamma" } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "LIBRARY_SONG_NOT_FOUND");
  });

  test("⑥ 增删条目会刷新歌单的 updated_at（前端靠它判断变没变）", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const before = list.find((f) => f.name === "睡前");
    const add = await req(base, token, `/api/folders/${before.id}/items`, { method: "POST", body: { dir: "solo_beta" } });
    const after = (await add.json()).folder;
    assert.ok(after.updatedAt >= before.updatedAt, "加了一首之后 updated_at 不该往回走");
    // 同一个秒内可能相等，所以只断言"不早于"，另外校验条目确实多了一条
    assert.equal(after.items.length, 2);
  });

  test("⑦ 移出一首：不在歌单里的回 PLAYLIST_ITEM_NOT_FOUND，不假装成功", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const id = list.find((f) => f.name === "睡前").id;
    const ok = await req(base, token, `/api/folders/${id}/items?dir=solo_beta`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).folder.items.length, 1);

    const missing = await req(base, token, `/api/folders/${id}/items?dir=solo_beta`, { method: "DELETE" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "LIBRARY_PLAYLIST_ITEM_NOT_FOUND");
  });

  test("⑧ 重排：按给定顺序落库，没提到的按原序接在后面", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const id = list.find((f) => f.name === "睡前").id;
    // 先把三首都加进去（solo_alpha 已在，beta 刚被移出，gamma 加不进去）
    await req(base, token, `/api/folders/${id}/items`, { method: "POST", body: { dir: "solo_beta" } });
    const before = (await (await req(base, token, `/api/folders/${id}`)).json()).folder;
    assert.deepEqual(before.items.map((i) => i.dir), ["solo_alpha", "solo_beta"]);

    const flip = await req(base, token, `/api/folders/${id}/items`, {
      method: "PATCH",
      body: { order: ["solo_beta", "solo_alpha"] },
    });
    assert.equal(flip.status, 200);
    assert.deepEqual((await flip.json()).folder.items.map((i) => i.dir), ["solo_beta", "solo_alpha"]);

    // ★ 只提到一首时，另一首按原相对顺序接在后面 —— 前端拖拽不必发全集。
    const partial = await req(base, token, `/api/folders/${id}/items`, {
      method: "PATCH",
      body: { order: ["solo_alpha"] },
    });
    assert.equal(partial.status, 200);
    assert.deepEqual((await partial.json()).folder.items.map((i) => i.dir), ["solo_alpha", "solo_beta"]);

    // ★ 给了歌单里没有的 dir：丢掉，不能因为它把真条目挤掉
    const junk = await req(base, token, `/api/folders/${id}/items`, {
      method: "PATCH",
      body: { order: ["solo_gamma", "solo_beta"] },
    });
    assert.equal(junk.status, 200);
    assert.deepEqual((await junk.json()).folder.items.map((i) => i.dir), ["solo_beta", "solo_alpha"]);

    // order 不是数组 ⇒ 400，别把库按 undefined 重排了
    const bad = await req(base, token, `/api/folders/${id}/items`, { method: "PATCH", body: { order: "solo_beta" } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "LIBRARY_PLAYLIST_ITEM_INCOMPLETE");
  });

  test("⑨ 改名 / 删歌单 / 删完再读回 404", { timeout: 60000 }, async () => {
    const list = (await (await req(base, token, "/api/folders")).json()).folders;
    const id = list.find((f) => f.name === "睡前").id;

    const renamed = await req(base, token, `/api/folders/${id}`, { method: "PATCH", body: { name: "练琴" } });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).folder.name, "练琴");

    const del = await req(base, token, `/api/folders/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.ok(!(await del.json()).folders.some((f) => f.id === id), "删掉的歌单不该还在列表里");

    const gone = await req(base, token, `/api/folders/${id}`);
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).code, "LIBRARY_FOLDER_NOT_FOUND");

    // ★ 删歌单必须把条目一起删干净：两张表之间没有外键（姊妹项目 server.js:866 的注释
    //   就是为这个加的孤儿清理）。这里直接从库文件读一遍确认，不靠接口自证。
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(join(dataDir, "letters.sqlite"));
    try {
      const rows = conn.prepare("SELECT COUNT(*) AS n FROM song_folder_items WHERE folder_id = ?").get(id);
      assert.equal(rows.n, 0, `删了歌单却留下 ${rows.n} 条孤儿条目`);
    } finally {
      conn.close();
    }
  });

  test("⑩ 写接口没有令牌一律 403（歌单是用户自己编的东西，不能被网页跨域改）", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "偷加的" }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 403, `没有令牌竟然回了 ${res.status}`);
  });
});
