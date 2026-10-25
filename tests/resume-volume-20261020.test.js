// ★ 2026-10-20 第七轮（用户两条新口径）的护栏：
//   ① 「咱们的程序的音乐声音是不是太小了……这个歌曲音量你和原版游戏学学吧」
//      ⇒ DEFAULT_SONG_VOLUME 55 → 100（原版全量放，同一批 mp4，响度全靠这条）。
//   ② 「咱们程序没有暂停后再点播放续播的功能，咱们的姊妹项目有，直接抄过来」
//      ⇒ 语义 = 暂停（画面回待机 + 服务端记断点 {dir,t}）；再点播放 = 从断点续播。
//      服务端：POST/GET /api/stage/pause + /api/stage/play 多收一个 resumeT 参数
//      （15 秒下发窗口，壁纸层只在"起播那一刻"消费，同曲轮询不会拽回断点）。
//
// 纪律同 batch-a-20261020：断言前剥注释；行为测试起真服务（临时数据目录 + 真变体文件），
// 不是只看源码里有那个词。跑法：node --test --test-force-exit tests\resume-volume-20261020.test.js

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SERVER = join(ROOT, "app", "server.mjs");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripHtml = (src) => src.replace(/<!--[\s\S]*?-->/g, "");

// ---------------------------------------------------------------- ① 音量默认值

test("[VOL] 歌曲默认音量必须是 100（对齐原版不衰减），且字面量钉死", async () => {
  const { DEFAULT_SONG_VOLUME } = await import(pathToFileURL(join(ROOT, "app", "assets.mjs")));
  assert.strictEqual(DEFAULT_SONG_VOLUME, 100, "默认音量=100（用户：太小了，和原版学）");
  // 读侧口径：库里存过值就尊重库里的（volumeSetting 的宽容读法不因默认值改动而变）
  const assets = stripJs(read("app/assets.mjs"));
  assert.ok(/Math\.min\(100, Math\.max\(0, Number\(raw\)\)\)/.test(assets),
    "volumeSetting 的 0–100 夹取必须还在（默认值改了不代表读侧校验能撤）");
});

// ---------------------------------------------------------------- ② 服务端暂停/续播（静态）

test("[RESUME] 服务端必须持有暂停断点与续播窗口两块内存态", () => {
  const js = stripJs(read("app/server.mjs"));
  assert.ok(/let stagePaused = null;/.test(js), "stagePaused（断点 {dir,t}）必须存在");
  assert.ok(/let stageResume = null;/.test(js), "stageResume（续播下发窗口）必须存在");
  // 15 秒 TTL：窗口一过同曲轮询就拿不到 resumeT（否则每 30 秒被拽回断点）
  assert.ok(/Date\.now\(\) \+ 15000/.test(js), "续播窗口必须带 15 秒 TTL");
  assert.ok(/stageResume && Date\.now\(\) < stageResume\.until \? \{ resumeT: stageResume\.t \}/.test(js),
    "stageNext 必须只在窗口内随响应下发 resumeT");
});

test("[RESUME] 暂停/续播的路由形态必须完整（幂等暂停、play 收 resumeT、清态）", () => {
  const js = stripJs(read("app/server.mjs"));
  assert.ok(/GET" && path === "\/api\/stage\/pause"/.test(js), "GET /api/stage/pause 必须存在（前端要先问有没有断点）");
  assert.ok(/POST" && path === "\/api\/stage\/pause"/.test(js), "POST /api/stage/pause 必须存在（记断点）");
  // 没在放时暂停要幂等应答，不能报错
  assert.ok(/if \(!stageForced\) return json\(res, 200, \{ ok: true, paused: false \}\);/.test(js),
    "没在放时 POST pause 必须幂等（ok+paused:false），不能 4xx");
  // POST pause = 记断点 + 清 stageForced（桌面层 30 秒轮询自己回待机）
  assert.ok(/stagePaused = \{ dir: stageForced, t: Number\.isFinite\(t\) && t > 0 \? t : 0 \};/.test(js)
    && /stageForced = "";/.test(js), "POST pause 必须记 {dir,t} 并清 stageForced");
  // 续播 = 普通点播多带 resumeT；新点播要作废旧断点
  assert.ok(/const resumeT = Number\(body\.resumeT\);/.test(js), "/api/stage/play 必须接收 resumeT 参数");
  assert.ok(/stagePaused = null;\s*\n\s*stageResume = Number\.isFinite\(resumeT\)/.test(js),
    "点播必须清掉旧断点，再按 resumeT 决定是否开续播窗口");
  // 回待机（idle:true）= 不看了，断点一并作废
  assert.ok(/stageForced = "";\s*\n\s*stagePaused = null;\s*\n\s*stageResume = null;/.test(js),
    "idle:true 必须把断点和续播窗口一起清掉");
  // 曲子往前走（换首/到头）就没有"续播"这回事了。
  // ★ 切片到下一个函数再判，不能拿注释行当锚点 —— stripJs 会把注释剥掉（2026-10-20 实测）。
  const adv = js.slice(js.indexOf("async function stageAdvance"), js.indexOf("function worldEnabled()"));
  assert.ok(adv.includes("stageResume = null;"), "stageAdvance 换首前必须作废续播窗口");
});

// ---------------------------------------------------------------- ③ 壁纸层断点起播（静态）

test("[RESUME] 壁纸层 crossFade 必须支持 startAt（loadedmetadata 后设 currentTime）", () => {
  const js = stripJs(stripHtml(read("app/public/wallpaper.html")));
  assert.ok(/typeof opts\.startAt === "number" && Number\.isFinite\(opts\.startAt\) && opts\.startAt > 0/.test(js),
    "crossFade 必须识别合法的 startAt（>0 的有限数）");
  assert.ok(/addEventListener\("loadedmetadata", \(\) => \{\s*try \{ incoming\.currentTime = startAt;/.test(js),
    "currentTime 必须等 loadedmetadata 再设（过早会抛 InvalidStateError）");
  // 起播那一刻消费服务端的 resumeT
  assert.ok(/crossFade\(info\.url, \{ audio: true, loop: false, startAt: info\.resumeT,/.test(js),
    "startSong 必须把 info.resumeT 交给 crossFade 的 startAt");
});

// ---------------------------------------------------------------- ④ 前端三态（静态）

test("[RESUME] 播放条三态：暂停记断点 / 续播走普通点播带 resumeT / 断点要恢复进度显示", () => {
  const js = stripJs(read("app/public/app.js"));
  // 暂停：POST /api/stage/pause {t}
  assert.ok(/await api\("\/api\/stage\/pause", \{ method: "POST", body: \{ t: pauseAt \} \}\);/.test(js),
    "playIdle(pauseAt) 必须把断点 POST 给服务端");
  // 续播：先 GET 断点，再走普通点播（dir + resumeT 同一条路，入库/最近演出全复用）
  assert.ok(/const st = await api\("\/api\/stage\/pause"\);/.test(js)
    && /if \(!st \|\| !st\.paused\) return false;/.test(js),
    "resumePaused 必须先问服务端有没有断点，没有就把播放键让给「播第一首」");
  assert.ok(/body: \{ dir: st\.dir, resumeT: st\.t \}/.test(js),
    "续播必须是 POST /api/stage/play {dir, resumeT}（与点播同一条路）");
  assert.ok(/pbState = \{ t: st\.t \?\? 0, d: 0, playing: true, has: true \};/.test(js),
    "续播要立刻把进度画到断点秒数（总时长等下一秒的报表补上）");
});

// ---------------------------------------------------------------- ⑤ 真服务行为测试

const SONGS = ["Solo_Alpha", "Solo_Bravo"];

function waitForPort(child, logs, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务没起来：\n${logs.join("")}`)), timeoutMs);
    const onChunk = (chunk) => {
      logs.push(chunk.toString("utf8"));
      const hit = /LINLI_PORT=(\d+)/u.exec(logs.join(""));
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 code=${code}\n${logs.join("")}`)); });
  });
}

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "linli-resume-"));
  const libraryDir = join(dataDir, "music");
  for (const dir of SONGS) {
    const full = join(libraryDir, dir);
    await mkdir(full, { recursive: true });
    await writeFile(join(full, `${dir}_TOD2000_NI_L.mp4`), Buffer.alloc(32));
  }
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LINLI_DATA_DIR: dataDir,
      LINLI_PORT: "0",
      LINLI_ASSETS_DIR: join(dataDir, "no-assets"),
      LINLI_NO_GAME_ASSETS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "x-linli-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = (p) => call("GET", p);
  const post = (p, b) => call("POST", p, b);
  await post("/api/library/dir", { dir: libraryDir });
  for (const dir of SONGS) await post("/api/library/import", { dir });
  return {
    get, post,
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

describe("暂停/续播（真服务）", () => {
  let srv;
  before(async () => { srv = await boot(); });
  after(async () => { await srv?.kill(); });

  test("⑥ 没在放时暂停是幂等的（不报错、不记断点）", async () => {
    const r = await srv.post("/api/stage/pause", { t: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, false, "没在放就无从暂停");
    const q = await srv.get("/api/stage/pause");
    assert.equal(q.body.paused, false);
    // 阴性对照：此刻 stage/next 也不该带 resumeT（判据要能区分"有窗口/没窗口"）
    const n = await srv.get("/api/stage/next");
    assert.equal(n.body.resumeT, undefined, "没有续播窗口时不得下发 resumeT");
  });

  test("⑦ 暂停 = 记断点 + 桌面回待机（stage/next 回 idle）", async () => {
    const p = await srv.post("/api/stage/play", { dir: SONGS[0] });
    assert.equal(p.status, 200);
    assert.ok(p.body.url, "点播后应有可播 url");
    const r = await srv.post("/api/stage/pause", { t: 42.5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, true);
    assert.equal(r.body.dir, SONGS[0]);
    assert.equal(r.body.t, 42.5);
    // stageForced 清了 ⇒ 桌面层轮询拿到 idle，自己回待机
    const n = await srv.get("/api/stage/next");
    assert.equal(n.body.url, null, "暂停后桌面必须回待机（stage/next 无曲子）");
    // 断点查得到（给下次"再点播放"用）
    const q = await srv.get("/api/stage/pause");
    assert.equal(q.body.paused, true);
    assert.equal(q.body.dir, SONGS[0]);
    assert.equal(q.body.t, 42.5);
  });

  test("⑧ 续播 = 普通点播带 resumeT：应答带断点、断点清掉、窗口期内 next 仍带", async () => {
    const r = await srv.post("/api/stage/play", { dir: SONGS[0], resumeT: 42.5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.resumeT, 42.5, "续播应答必须带断点秒数（壁纸层据此从 42.5s 起播）");
    const q = await srv.get("/api/stage/pause");
    assert.equal(q.body.paused, false, "续播即消费断点，不能留着再续一次");
    const n = await srv.get("/api/stage/next");
    assert.equal(n.body.resumeT, 42.5, "15 秒窗口内壁纸层的轮询也拿得到（防止起播请求错过）");
  });

  test("⑨ 不带 resumeT 的新点播：应答与 next 都不得带 resumeT（阴性对照）", async () => {
    const r = await srv.post("/api/stage/play", { dir: SONGS[1] });
    assert.equal(r.status, 200);
    assert.equal(r.body.resumeT, undefined, "普通点播不得继承上一个断点的窗口");
    const n = await srv.get("/api/stage/next");
    assert.equal(n.body.resumeT, undefined);
    // 换曲也把旧断点作废
    const q = await srv.get("/api/stage/pause");
    assert.equal(q.body.paused, false);
  });

  test("⑩ 回待机（idle:true）把断点一并作废", async () => {
    await srv.post("/api/stage/play", { dir: SONGS[0] });
    const p = await srv.post("/api/stage/pause", { t: 7 });
    assert.equal(p.body.paused, true);
    const r = await srv.post("/api/stage/play", { idle: true });
    assert.equal(r.status, 200);
    const q = await srv.get("/api/stage/pause");
    assert.equal(q.body.paused, false, "回待机=不看了，断点不该留下来");
    const n = await srv.get("/api/stage/next");
    assert.equal(n.body.resumeT, undefined);
  });
});
