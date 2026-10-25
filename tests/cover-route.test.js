/**
 * `/api/cover` 的护栏（2026-10-19 四轮审查 S27 点名的"有路由、零测试"之一）。
 *
 * 为什么值得单开一份：
 *   封面是这一轮新加的二进制路由，`dir` 直接从查询串进来，再经 `coverFileOf()` 变成磁盘路径 ——
 *   这类"参数 → 文件"的路由正是越界读取最容易出事的地方（P1 已经为 `/api/stage/play` 踩过一次）。
 *   它现在**一条用例都没有**：删掉 `encodeURIComponent`、把 `coverFileOf` 换成 `join(BUNDLED_DIR, dir)`、
 *   或者把 404 改成 200 空响应，全套测试都会照样绿。
 *
 * 断言的边界：
 *   ① 有封面的曲子 → 200 + `image/*` + 长度与 `Content-Length` 对得上 + 真能当图片读（前两字节像 JPEG/PNG/WebP）；
 *   ② 没有封面的曲子 → 404 `LIBRARY_SONG_NOT_FOUND`（不许回 200 空图，界面会画出破图）；
 *   ③ 目录穿越（`..\..`、`/etc`、盘符、NUL）→ 一律 404，**不许 200**；
 *   ④ 缓存头是 `private`（不许被中间层共享缓存，封面是别人的版权物，别在代理里留副本）。
 *
 * 跑法：node --test --test-force-exit tests\cover-route.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const BUNDLED = join(ROOT, "app", "covers");

/** 随包封面里必须至少有一张 —— 一张都没有的话，这份测试就失败了，
 *  因为那意味着"封面随包"这件事本身破了（比某个断言红更该被看见）。 */
function oneBundledCover() {
  let names = [];
  try { names = readdirSync(BUNDLED); } catch { return null; }
  return names.find((n) => /^[a-f0-9]{16}\.jpg$/u.test(n)) ?? null;
}

/** manifest.json 形如 `{ "<曲目目录名>": { cover: "<16位哈希>.jpg", composer, duration } }`。
 *  曲目名只有这里有 —— 封面文件名是哈希，没法反推。 */
function readManifest() {
  try {
    return JSON.parse(readFileSync(join(BUNDLED, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

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

/** 一张图的前两字节够不够判型：JPEG FF D8 / PNG 89 50 4E 47 / WebP RIFF。 */
function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  return jpeg || png || webp;
}

describe("/api/cover", () => {
  let child;
  let base;
  let token;
  let dataDir;
  const logs = [];

  // 有封面的曲目名：从 manifest.json 里取第一条的 key（它就是曲库目录名）。
  const manifest = readManifest();
  const withCover = manifest ? Object.keys(manifest)[0] : null;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-cover-"));
    const libraryDir = join(dataDir, "music");
    await mkdir(join(libraryDir, "solo_zz_no_cover"), { recursive: true });
    await writeFile(join(libraryDir, "solo_zz_no_cover", "solo_zz_no_cover_TOD1200_NI_L.mp4"), Buffer.alloc(16));
    if (withCover) {
      await mkdir(join(libraryDir, withCover), { recursive: true });
      await writeFile(join(libraryDir, withCover, `${withCover}_TOD1200_NI_L.mp4`), Buffer.alloc(16));
    }

    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_ASSETS_DIR: join(dataDir, ".no-assets") },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const port = await waitForPort(child, logs);
    base = `http://127.0.0.1:${port}`;
    token = (await (await fetch(`${base}/api/session`)).json()).token;
    const res = await fetch(`${base}/api/library/dir`, {
      method: "POST",
      headers: { "x-linli-token": token, "content-type": "application/json" },
      body: JSON.stringify({ dir: libraryDir }),
    });
    assert.equal(res.status, 200, "设置曲库目录失败");
  });

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited.catch(() => {});
    }
    await cleanupDir(dataDir).catch(() => {});
  });

  const get = (p) => fetch(`${base}${p}`, { headers: { "x-linli-token": token }, signal: AbortSignal.timeout(20000) });

  test("① 有封面的曲子：200 + image/* + 长度对得上 + 真能当图读", async (t) => {
    if (!withCover) {
      // 随包封面缺失属于打包问题，单独说清楚，别混进断言失败里。
      t.diagnostic("app/covers/ 里没有封面或没有 manifest.json —— 说明'封面随包'这件事破了");
      assert.fail("随包封面不存在");
    }
    assert.ok(oneBundledCover(), "app/covers/ 里应当至少有一张 16 位哈希命名的 jpg");
    const res = await get(`/api/cover?dir=${encodeURIComponent(withCover)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^image\//u);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, "封面不许是空文件");
    assert.equal(Number(res.headers.get("content-length")), buf.length, "Content-Length 必须与实际字节数一致");
    assert.ok(looksLikeImage(buf), "前几个字节应当像 JPEG/PNG/WebP");
  });

  test("② 没有封面的曲子：404 LIBRARY_SONG_NOT_FOUND（不许回 200 空图）", async () => {
    const res = await get("/api/cover?dir=solo_zz_no_cover");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "LIBRARY_SONG_NOT_FOUND");
  });

  test("③ 目录穿越一律 404，不许 200", async () => {
    const attacks = [
      encodeURIComponent("..\\..\\..\\Windows"),
      encodeURIComponent("../../etc"),
      encodeURIComponent("C:\\Windows"),
      encodeURIComponent("solo_zz_no_cover\\..\\..\\Windows"),
      encodeURIComponent("solo_zz_no_cover\0.jpg"),
    ];
    for (const dir of attacks) {
      const res = await get(`/api/cover?dir=${dir}`);
      assert.equal(res.status, 404, `穿透过来了：${decodeURIComponent(dir)}`);
      await res.arrayBuffer().catch(() => {});
    }
    // 完全不传 dir
    const bare = await get("/api/cover");
    assert.equal(bare.status, 404);
    await bare.arrayBuffer().catch(() => {});
  });

  test("④ 缓存头必须是 private（别人的版权物不该留在共享缓存里）", async (t) => {
    if (!withCover) return t.skip("没有随包封面，跳过");
    const res = await get(`/api/cover?dir=${encodeURIComponent(withCover)}`);
    assert.equal(res.status, 200);
    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /private/u, `Cache-Control 应当是 private，实际：${cc}`);
  });
});
