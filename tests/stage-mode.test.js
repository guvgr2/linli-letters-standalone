/**
 * 播放顺序（顺序 / 列表循环 / 单曲循环 / 随机）与"自动走下一首"。
 *
 * ★ 为什么这块规则在**服务端**：窗口里的 video 播放链删掉之后（片子只在桌面那层放），
 *   窗口关着也得继续往下放 —— 桌面页只知道 URL，不知道队列。所以
 *   `POST /api/stage/advance` 负责按模式算下一首，桌面页在 `ended` 时问它。
 *   这条用例钉的就是那套规则本身（含"顺序播放到头回待机"这个唯一能区分
 *   「顺序」和「列表循环」的行为）。
 *
 * 跑法：node --test --test-force-exit tests\stage-mode.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "app", "server.mjs");

// 目录名必须过 LIBRARY_DIR_PATTERN（app\core.mjs:779 `/^(?:solo|playsing|midi|oliviasoul)/iu`），
// 否则 scanLibrary 直接跳过、/api/library/import 会说"曲库里没有这一首"。
const SONGS = ["Solo_Alpha", "Solo_Bravo", "Solo_Charlie"];

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
  const dataDir = await mkdtemp(join(tmpdir(), "linli-mode-"));
  const libraryDir = join(dataDir, "music");
  // 三首曲子，每首一个能播的变体 —— 队列要"真有片子"才收。
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

  // 曲库目录指过去，三首都入库（音乐桌面 = 队列）
  await post("/api/library/dir", { dir: libraryDir });
  for (const dir of SONGS) await post("/api/library/import", { dir });

  return {
    get, post,
    songs: async () => (await get("/api/library/songs")).body.songs.map((s) => s.dir),
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

describe("播放顺序与自动走下一首", () => {
  let srv;
  let queue;
  before(async () => {
    srv = await boot();
    queue = await srv.songs();
    assert.equal(queue.length, SONGS.length, `队列应有 ${SONGS.length} 首，实际 ${queue.join(",")}`);
  });
  after(async () => { await srv?.kill(); });

  const setMode = async (mode) => {
    const r = await srv.post("/api/stage/mode", { mode });
    assert.equal(r.status, 200, `切到 ${mode} 失败：${JSON.stringify(r.body)}`);
    assert.equal(r.body.mode, mode);
  };
  const play = async (dir) => {
    const r = await srv.post("/api/stage/play", { dir });
    assert.equal(r.status, 200, `播放 ${dir} 失败：${JSON.stringify(r.body)}`);
    assert.equal(r.body.dir, dir);
  };

  test("① 默认是顺序播放，且模式能落库读到", async () => {
    const r = await srv.get("/api/stage/mode");
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "order");
    await setMode("repeat");
    assert.equal((await srv.get("/api/stage/mode")).body.mode, "repeat");
    await setMode("order");
  });

  test("② 模式只认四种写法，别的要 400 LIBRARY_PLAY_MODE_INVALID（不是曲目不存在）", async () => {
    for (const bad of ["", "ORDER", "single-loop", ".."]) {
      const r = await srv.post("/api/stage/mode", { mode: bad });
      assert.equal(r.status, 400, `不该接受 ${JSON.stringify(bad)}`);
      // fail() 把号拼在中文后面（`codeMessage`），单独那个 `code` 字段是号本身
      assert.equal(r.body.code, "LIBRARY_PLAY_MODE_INVALID");
      assert.match(r.body.error, /LIBRARY_PLAY_MODE_INVALID/u);
    }
  });

  test("③ 顺序播放：走下一首按队列顺序", async () => {
    await setMode("order");
    await play(queue[0]);
    const r = await srv.post("/api/stage/advance", { delta: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.dir, queue[1]);
    assert.ok(r.body.url, "下一首要有可播的 url");
  });

  test("④ 顺序播放：放到最后一首就**回待机**（这就是「顺序」与「列表循环」的唯一区别）", async () => {
    await setMode("order");
    await play(queue[queue.length - 1]);
    const r = await srv.post("/api/stage/advance", { delta: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.dir, null, "顺序播放到头不该绕回第一首");
    assert.equal(r.body.url, null);
    assert.equal(r.body.reason, "idle");
    assert.equal(r.body.ended, true);
    // 回待机之后 /api/stage/next 也得说没有曲子（外壳据此把窗口撤掉/待机）
    assert.equal((await srv.get("/api/stage/next")).body.url, null);
  });

  test("⑤ 列表循环：最后一首的下一首是第一首", async () => {
    await setMode("repeat");
    await play(queue[queue.length - 1]);
    const r = await srv.post("/api/stage/advance", { delta: 1 });
    assert.equal(r.body.dir, queue[0]);
  });

  test("⑥ 单曲循环：还是这一首", async () => {
    await setMode("single");
    await play(queue[1]);
    const r = await srv.post("/api/stage/advance", { delta: 1 });
    assert.equal(r.body.dir, queue[1]);
    assert.ok(r.body.url);
  });

  test("⑦ 随机：不会给自己（队列两首以上时）", async () => {
    await setMode("shuffle");
    await play(queue[0]);
    for (let i = 0; i < 8; i += 1) {
      const r = await srv.post("/api/stage/advance", { delta: 1 });
      assert.notEqual(r.body.dir, null);
      assert.notEqual(r.body.dir, queue[0], "随机播放不该原地打转");
      await play(queue[0]);
    }
  });

  test("⑧ 没有在放的曲子时 advance 回 idle（不报错、不瞎挑一首）", async () => {
    await srv.post("/api/stage/play", { idle: true });
    const r = await srv.post("/api/stage/advance", { delta: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.dir, null);
    assert.equal(r.body.reason, "idle");
  });
});

// ★ 2026-10-19 审查 S36（P0）后的护栏：这条路以前是「后端四种模式全做完了，
//   但界面上一个入口都没有」——#pbMode 在一直 hidden 的 #playerPage 里，
//   打开它的 openPlayer() 全仓库零调用。所以这里不测"有没有模式这套逻辑"，
//   专测**用户点得到点不到**：控件必须在曲库页（不是折叠/隐藏容器里），
//   并且 app.js 真的给它挂了监听。删掉那个按钮、或只把监听接回播放条 ⇒ 两条都红。
//
// ★★ 2026-10-19 七轮审查 F5：这三条第一版是"绿得虚"的 —— 三种"把功能真弄坏"的变异
//   都骗过去了（T1b 工具行留着、另抄一份进播放条；T2 把落库那行注释掉；T3 监听改成空壳），
//    根因是三处判据比被测对象弱：
//      ① 反向断言用非贪婪正则截播放页，`…<\/div>\s*<\/div>` 只吃到 player-container 两层闭合，
//         而播放条在它后面 ⇒ 片段根本不含播放条，"播放页里有没有"是对着空气问的；
//      ② 直接在含注释的源码里查 `void savePlayMode(`，注释里那句照样命中；
//      ③ 只断言到 `addEventListener("click"` 就收尾，回调里是什么完全不管。
//    现在改成：按 div 深度配对切片（带"切片里必须含 player-bar"的自检）、
//    先剥注释再匹配、断言**完整**的回调形态。
describe("⑨ 播放顺序在界面上真的有入口（S36 回归）", () => {
  const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  // ★ 先剥 HTML 注释再判（2026-10-20 实测）：搬迁说明的注释里写着 "player-bar"
  //   这些类名，原样命中会把"不许出现"的反向断言打红。注释不是结构。
  const html = readFileSync(join(ROOT, "app", "public", "index.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/gu, "");
  const js = readFileSync(join(ROOT, "app", "public", "app.js"), "utf8");

  /** 从 startIndex 处的 `<div …>` 开始，按 `<div>` / `</div>` 的**深度**配对，返回整段 HTML。
   *  ★ 不能用 `[\s\S]*?</div></div>` 这种非贪婪截法：它只按"两层的闭合"收尾，
   *    而播放页里的结构远不止两层 —— 截出来的片段会缺掉后半段（这正是 F5-T1b 骗过旧判据的原因）。 */
  function sliceDiv(source, startIndex) {
    const tag = /<div\b|<\/div>/gu;
    tag.lastIndex = startIndex;
    let depth = 0;
    let match;
    while ((match = tag.exec(source)) !== null) {
      depth += match[0] === "</div>" ? -1 : 1;
      if (depth === 0) return source.slice(startIndex, match.index + match[0].length);
    }
    return source.slice(startIndex);
  }

  /** 剥掉 JS 注释（排除 `https://` 这类 —— `//` 前面是 `:` 的不算注释开头）。 */
  function stripJsComments(code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  }

  const jsCode = stripJsComments(js);

  test("播放顺序只有**一个**入口：#pbMode（曲库页底部那条播放条）；#deskMode 已按用户口径整块下掉", () => {
    // ★ 2026-10-20 口径反转（用户原话）：「在音乐桌面的单曲循环按钮就删了吧，
    //   底下的播放条有一个了，要不就重复了」。上一版这条断言的是"工具行里必须有 #deskMode"，
    //   现在反过来了 —— **两个并排会让人以为是两个不同的东西**。
    //   所以这里守两件事：① 工具行不许再有它；② 真入口 #pbMode 必须还在且可点。
    const deskHead = html.match(/<div class="desk-head">([\s\S]*?)<\/div>/u);
    assert.ok(deskHead, "曲库页要有 .desk-head 这一行工具区");
    assert.ok(!deskHead[1].includes('id="deskMode"'),
      "「音乐桌面」工具行里不许再有 #deskMode（用户：跟播放条重复了）");

    // 真入口：播放条那颗，全文只许一份（同一批 pb* id 复制两份 ⇒ 接线打到 hidden 副本上）
    const pb = html.match(/id="pbMode"/gu) ?? [];
    assert.equal(pb.length, 1, `#pbMode 只该有一个，实际 ${pb.length} 个`);

    // 反向守卫：hidden 的播放页里不许再抄一份播放入口
    const openIdx = html.search(/<div class="player-page" id="playerPage"/u);
    assert.ok(openIdx > 0, "找不到 #playerPage —— 页面结构变了，请先更新这条用例");
    const playerSlice = sliceDiv(html, openIdx);
    assert.ok(!playerSlice.includes("player-bar"),
      "旧播放条必须从 #playerPage 删干净（已搬到曲库页底部，同批 id 只许一份）");
    assert.ok(!playerSlice.includes('id="pbMode"'), "#pbMode 不许放进 hidden 的播放页（那等于没有入口）");
  });

  test("app.js 给 #pbMode 挂了监听，并且模式真的会落库", () => {
    // ★ 断言完整形态而不是"出现过 addEventListener"：把回调换成空壳 `() => {}` 必须变红（F5-T3）。
    assert.match(
      jsCode,
      /\$\("pbMode"\)\?\.addEventListener\("click", \(\) => cyclePlayMode\(\)\)/u,
      "没挂完整监听（必须是 click → cyclePlayMode()），按钮就是死的",
    );
    assert.ok(!jsCode.includes('$("deskMode")'),
      "app.js 里不许再有 $(\"deskMode\") 的接线（按钮没了，接线就是死代码）");
    assert.match(jsCode, /function cyclePlayMode\(/u, "四态轮转抽成一个函数，入口都走它");
    // ★ 先剥注释再查：注释里写着 `void savePlayMode(mode.key)` 那句时，旧判据是"永远绿"的（F5-T2）。
    assert.match(
      jsCode,
      /void savePlayMode\(mode\.key\)/u,
      "切了要 POST /api/stage/mode（这行被注释掉就等于没落库，桌面还按旧顺序走）",
    );
  });

  test("两个入口共用同一份状态（不许各存一个 playMode）", () => {
    const decl = jsCode.match(/let playMode = \d;/gu) ?? [];
    assert.equal(decl.length, 1, `playMode 只该有一份，实际 ${decl.length} 份`);
  });
});