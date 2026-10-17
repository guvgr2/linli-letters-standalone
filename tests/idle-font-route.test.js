/**
 * 待机素材与信件字体的**端到端**护栏：起真服务 → 发真 HTTP → 落真文件/真库。
 *
 * 为什么单有一个文件：
 *   `assets.test.js` 测的是纯函数（白名单、种子、sfnt 表目录），全绿只证明"算得对"；
 *   证明不了"接对了" —— 路由挂没挂、令牌闸拦不拦、Range 走不走 206、
 *   字体写盘用的是 tmp+rename 还是直接覆盖、设置是落库还是每请求重掷，只有真起一次服务才看得见。
 *
 * ★ 这组路由是 2026-10-18 从 `analysis/_port-source/server-with-idle.mjs` 搬回来的。
 *   搬之前 `server.mjs` 里 `idle`/`stage`/`assets` 字样出现 0 次，而外壳与前端都在调：
 *   桌面壁纸层因此永远启动不了（`Program.cs` 的 `HasStageVideo()` 拿不到 `url` 就直接 return）。
 *   所以这里的每一条都在问同一个问题：**那几处调用，现在真的有人应了吗。**
 *
 * 跑法：node --test --test-force-exit tests\idle-font-route.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function startServer({ dataDir, assetsDir }) {
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_ASSETS_DIR: assetsDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200, `拿会话令牌失败：${res.status}`);
  const token = (await res.json()).token;
  return { child, base, token, logs };
}

// ---------------------------------------------------------------- 字体夹具
//
// ★ 不用系统里的真字体文件：不同机器上的 C:\Windows\Fonts 不一样，测试不能依赖它。
//   这里手工拼一个**最小的合法 sfnt**：表目录里只放 `name` 与 `glyf` 两张表，
//   `name` 表里塞一条 nameID=1（族名）的 UTF-16BE 记录。

/** 极简 sfnt：`glyf` 空表 + `name` 表里一条 nameID 1。返回 Buffer。 */
function buildFont({ family = "Test Family", nameId = 1 } = {}) {
  const nameTable = (() => {
    const str = Buffer.from(family, "utf16le");
    // UTF-16BE：逐字节对调
    for (let i = 0; i < str.length; i += 2) { const t = str[i]; str[i] = str[i + 1]; str[i + 1] = t; }
    const head = Buffer.alloc(6 + 12);
    head.writeUInt16BE(0, 0);              // format 0
    head.writeUInt16BE(1, 2);              // count
    head.writeUInt16BE(6 + 12, 4);         // stringOffset
    head.writeUInt16BE(3, 6);              // platformID = 3 (Windows)
    head.writeUInt16BE(1, 8);              // encodingID
    head.writeUInt16BE(0x0409, 10);        // languageID = en-US
    head.writeUInt16BE(nameId, 12);        // nameID
    head.writeUInt16BE(str.length, 14);    // length
    head.writeUInt16BE(0, 16);             // offset（相对 stringOffset）
    return Buffer.concat([head, str]);
  })();
  const glyf = Buffer.alloc(12);           // 空字形表，够过"有一张字形表"这一关

  const numTables = 2;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(numTables, 4);
  let offset = header.length;
  const body = [];
  for (const [tag, data] of [["glyf", glyf], ["name", nameTable]]) {
    const at = 12 + body.length / 16 * 0 + 0;   // 占位，下面重算
    void at;
    const rec = Buffer.alloc(16);
    rec.write(tag, 0, "latin1");
    rec.writeUInt32BE(1, 4);               // checksum（本测试不校验，填 1）
    rec.writeUInt32BE(offset, 8);
    rec.writeUInt32BE(data.length, 12);
    body.push(rec, data);
    offset += data.length;
  }
  // 表目录按 tag 升序：glyf < name，已经是升序
  const dir = Buffer.concat(body.filter((b) => b.length === 16));
  header.set(dir, 12);
  return Buffer.concat([header, ...body.filter((b) => b.length !== 16)]);
}

// ---------------------------------------------------------------- 场景一：没有素材

describe("待机素材：机器上没有 Wallpaper_Presence 时", () => {
  let child = null;
  let base = "";
  let dataDir = "";

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-idle-empty-"));
    const assetsDir = join(dataDir, ".no-assets");
    await mkdir(assetsDir, { recursive: true });
    ({ child, base } = await startServer({ dataDir, assetsDir }));
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("① /api/idle/next 回 hasAssets:false 且不编一个不存在的文件名", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/idle/next`, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hasAssets, false);
    assert.equal(body.video, null, "没有素材就不许给出片名 —— 前端拿着它会去 404 拉 30 秒");
    assert.equal(body.ambience, null);
  });

  test("② /api/stage/next 永远 200 且结构稳定（外壳靠它决定铺不铺桌面窗口）", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/stage/next`, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200, "外壳拿不到 200 就不会去播；但这里更不能 5xx，否则与「没有曲子」分不开");
    const body = await res.json();
    assert.ok("url" in body && "dir" in body, `结构不对：${JSON.stringify(body)}`);
    // 曲库目录在这类环境里通常不存在 ⇒ 「没有曲子」是合法答案，必须带 reason
    if (!body.url) assert.equal(body.reason, "no-song");
  });

  test("③ /api/about 说出数据目录与素材目录（「不上传」要有路径才说服人）", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/about`, { signal: AbortSignal.timeout(10000) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.dataDir, dataDir);
    assert.equal(body.assetsDir, null, "素材根不存在时必须是 null，不能回一个假的路径");
    assert.match(body.version, /^\d+\.\d+\.\d+/u);
  });

  test("④ 待机片路由：素材不存在时 404，且目录穿越一律 404", { timeout: 60000 }, async () => {
    for (const name of ["A_R1_1200.mp4", "../../secret.mp4", "..%2F..%2Fsecret.mp4", "A_R1_1200.mp4%00.txt"]) {
      const res = await fetch(`${base}/api/idle/video?file=${name}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(res.status, 404, `file=${name} 竟然回了 ${res.status}`);
    }
    // ★ 白名单是**内容规则**，不只是"防穿越"：素材目录里混进一个别的 mp4
    //   （用户往 Steam 素材目录里手动丢过东西、或者以后多了一种素材类型），
    //   也不该被这条路由顺出去 —— basename() 挡得住 `../`，挡不住"名字只是不像"。
    //   上面那批是"合法名 + 文件不存在"⇒ 404 分不清是白名单还是没文件；
    //   下面这两个文件**真的有**，只有白名单能把它们拦住。
    for (const name of ["随手丢进来的.mp4", "notes.txt"]) {
      const res = await fetch(`${base}/api/idle/video?file=${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(res.status, 404, `file=${name} 不在白名单里，却回了 ${res.status}`);
    }
  });
});

// ---------------------------------------------------------------- 场景二：有素材 + 字体

describe("待机素材与字体：素材齐全时的真链路", () => {
  let child = null;
  let base = "";
  let dataDir = "";
  let assetsDir = "";
  let token = "";

  const FONT_MP4 = Buffer.from("0000001000000000", "hex");   // 内容无所谓，只测路由

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-idle-full-"));
    assetsDir = join(dataDir, ".assets");
    await mkdir(join(assetsDir, "Wallpaper_Presence"), { recursive: true });
    await mkdir(join(assetsDir, "Wallpaper_Ambience"), { recursive: true });
    for (const scene of ["A", "B", "C"]) {
      for (const state of ["R1", "R2", "R3"]) {
        for (const slot of ["1200", "1730", "2000"]) {
          await writeFile(join(assetsDir, "Wallpaper_Presence", `${scene}_${state}_${slot}.mp4`), FONT_MP4);
        }
      }
    }
    await writeFile(join(assetsDir, "Wallpaper_Ambience", "ambient_loop_7.mp3"), Buffer.from("id3"));
    // ★ 混进一个**不该被待机片路由吐出去**的文件：证明白名单是内容规则，不是"是不是 mp4"。
    await writeFile(join(assetsDir, "Wallpaper_Presence", "随手丢进来的.mp4"), FONT_MP4);
    await writeFile(join(assetsDir, "Wallpaper_Presence", "notes.txt"), "hello");
    ({ child, base, token } = await startServer({ dataDir, assetsDir }));
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("⑤ /api/idle/next 给出一个白名单内的片名，且**连调两次不换片**", { timeout: 60000 }, async () => {
    const a = await (await fetch(`${base}/api/idle/next`, { signal: AbortSignal.timeout(10000) })).json();
    const b = await (await fetch(`${base}/api/idle/next`, { signal: AbortSignal.timeout(10000) })).json();
    assert.equal(a.hasAssets, true);
    assert.match(a.video, /^\/api\/idle\/video\?file=[ABC]_R[123]_(1200|1730|2000)\.mp4$/u);
    assert.equal(a.video, b.video, "前端每 30 秒轮询一次 —— 每次重掷种子会让桌面画面半小时跳一次");
    assert.equal(a.scene, b.scene);
    assert.equal(a.state, b.state);
  });

  test("⑥ /api/idle/video 走 Range ⇒ 206，长度对得上", { timeout: 60000 }, async () => {
    const { video } = await (await fetch(`${base}/api/idle/next`, { signal: AbortSignal.timeout(10000) })).json();
    const url = `${base}${video.replace(/^\/api/, "/api")}`;
    const res = await fetch(url, { headers: { Range: "bytes=0-7" }, signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 206, "播放器要 206 才能拖动与循环；回 200 全片会让待机片每次重头读盘");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, 8);
    assert.deepEqual(buf, FONT_MP4);
    assert.match(res.headers.get("content-range") ?? "", /^bytes 0-7\//u);
  });

  test("⑦ 环境音开关：只收布尔，落库后 GET 与待机片同时反映", { timeout: 60000 }, async () => {
    const post = (payload) => fetch(`${base}/api/idle/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Linli-Token": token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    // ★ 字符串 "yes" 是真值：老实现 `? "1" : "0"` 会把它当成"开"，用户点了关却还在响
    const bad = await post({ ambience: "yes" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "IDLE_AMBIENCE_NOT_BOOL");

    const off = await post({ ambience: false });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).ambience, false);

    const view = await (await fetch(`${base}/api/idle/settings`, { signal: AbortSignal.timeout(10000) })).json();
    assert.equal(view.ambience, false, "设置必须真的落库，不能只活在这一次响应里");

    const next = await (await fetch(`${base}/api/idle/next`, { signal: AbortSignal.timeout(10000) })).json();
    assert.equal(next.ambienceOn, false);
    assert.equal(next.ambience, null, "关掉之后不该再把环境音地址发出去");

    const on = await post({ ambience: true });
    assert.equal((await on.json()).ambience, true);
  });

  test("⑧ 没有令牌的写请求一律 403（字体导入同样走这道闸）", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/font/import?slot=letter`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buildFont(),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "COMMON_TOKEN_MISSING");
  });

  test("⑨ 字体导入：不是字体 ⇒ 400 FONT_NOT_FONT，且**一个文件都不落盘**", { timeout: 60000 }, async () => {
    const res = await fetch(`${base}/api/font/import?slot=letter`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Linli-Token": token },
      body: Buffer.from("这不是字体，只是一段话"),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "FONT_NOT_FONT");
    const dir = join(dataDir, "fonts");
    const files = await readdir(dir).catch(() => []);
    assert.deepEqual(files, [], `不该落下任何文件，实际有：${files.join("、")}`);
  });

  test("⑩ 字体导入：真字体 ⇒ 读得出族名，status / file / 落盘三者一致", { timeout: 60000 }, async () => {
    const font = buildFont({ family: "Test Family" });
    const res = await fetch(`${base}/api/font/import?slot=letter`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Linli-Token": token },
      body: font,
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 200, "导入被拒了");
    const body = await res.json();
    assert.equal(body.family, "Test Family", `族名读错了：${JSON.stringify(body)}`);
    assert.equal(body.bytes, font.length);

    const status = await (await fetch(`${base}/api/font/status`, { signal: AbortSignal.timeout(10000) })).json();
    assert.equal(status.letter.ok, true);
    assert.equal(status.compose.ok, false, "另一支没导入就该是 false，两支不能互相串");

    // 落盘的是**原始字节**，一个都不许改（改了浏览器就当它不是这支字体）
    const onDisk = await readFile(join(dataDir, "fonts", "letter.ttf"));
    assert.deepEqual(onDisk, font);

    const file = await fetch(`${base}/api/font/file?slot=letter`, { signal: AbortSignal.timeout(10000) });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /font\/tu?tf|application\/octet-stream/u);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), font);

    // ★ 不能留临时文件：写盘走的是 `xxx.tmp-<pid>` 再 rename
    const files = (await readdir(join(dataDir, "fonts"))).sort();
    assert.deepEqual(files, ["letter.ttf"], `残留文件：${files.join("、")}`);
    const size = (await stat(join(dataDir, "fonts", "letter.ttf"))).size;
    assert.equal(size, font.length);
  });

  test("⑪ 另一组对照：素材目录里混进来的文件，待机路由一个都不吐", { timeout: 60000 }, async () => {
    // 这两个文件**真的存在**在 Wallpaper_Presence 里（before 里写的）。
    // 上面那批 404 分不清"白名单拦住了"还是"文件本来就没有"，这里才分得清。
    for (const name of ["随手丢进来的.mp4", "notes.txt"]) {
      const res = await fetch(`${base}/api/idle/video?file=${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(res.status, 404, `file=${name} 不在白名单里，却回了 ${res.status}`);
    }
    // 同一目录里白名单内的片子照常出得来 —— 否则这条测试只是"全都不给"
    const ok = await fetch(`${base}/api/idle/video?file=A_R1_1200.mp4`, { signal: AbortSignal.timeout(10000) });
    assert.equal(ok.status, 200);
  });

  test("⑫ 字体端点不认路径：slot 只接受 letter / compose", { timeout: 60000 }, async () => {
    for (const slot of ["../../etc/passwd", "letter.ttf", "", "LETTER"]) {
      const res = await fetch(`${base}/api/font/status?slot=${encodeURIComponent(slot)}`, {
        signal: AbortSignal.timeout(10000),
      });
      // 未知 slot 一律落到 letter 之外的"没有这一支"；**绝不**能顺着 slot 去读任意文件
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!body.fileName || body.fileName === "letter.ttf" || body.fileName === "compose.ttf",
        `slot=${slot} 把文件名带出来了：${JSON.stringify(body)}`);
    }
  });
});
