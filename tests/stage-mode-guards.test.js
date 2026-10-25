/**
 * §13「四种播放顺序 + 自动走下一首」这块新功能的**补充护栏**。
 *
 * 为什么要另开一个文件（而不是往 `tests\stage-mode.test.js` 里塞）：
 *   那边问的是「四种模式的步进规则本身对不对」—— order/repeat/single/shuffle 各怎么走；
 *   这一份问的是另一批问题：**坏了以后还有没有人拦得住**。
 *
 * 下面每一条都对应一个"改坏了不会有任何现有用例变红"的地方：
 *
 *   ① 令牌闸。他们自己在 §13.3 记过一次事故：壁纸页原来只有 GET（GET 不要令牌），
 *      曲子放完那一下 POST /api/stage/advance 拿到 403 ⇒ **桌面停在最后一帧不动**，
 *      而且只有等了整首曲子才看得见。服务端这边的闸门是好的（实测无令牌 403、state 不变），
 *      但**没有任何常驻用例守着它** —— 有人把这两个分支挪到令牌闸之前，谁也不会知道。
 *   ② GET 可以公开、写操作不能。明确"公开的是这一个"，防止"顺手把写也开放了"。
 *   ③ 模式跨重启。他们 ① 号用例只在**同一个进程**里读回来；落库键 `play_mode`
 *      要是哪天改成只存内存，那条用例照样绿，用户却是"每次开机都变回顺序播放"。
 *   ④ 口径一致。文档反复强调"窗口里看到下一首"与"桌面真放出来"必须是同一首。
 *   ⑤⑥ 反向（delta=-1）两个分支。**代码里有、没有一个用例走过**。
 *   ⑦⑧ 结构。 التقنية 层可以绕过一切 HTTP 断言：把 `api()` 里那句令牌注入删掉、
 *      或给曲子的 crossFade 加回 loop，八个 HTTP 用例全绿，桌面表现却是
 *      "403 卡死" / "自动续播永远不触发"。这两条只靠静态结构钉住。
 *
 * 跑法：node --test --test-force-exit tests\stage-mode-guards.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const WALLPAPER = join(ROOT, "app", "public", "wallpaper.html");
const INDEX_HTML = join(ROOT, "app", "public", "index.html");
const APP_JS = join(ROOT, "app", "public", "app.js");

// 目录名要过 LIBRARY_DIR_PATTERN，否则扫不到。
const SONGS = ["Solo_Alpha", "Solo_Bravo", "Solo_Charlie"];

/**
 * 把注释换成**等长空格**再去找代码（保留原下标，报错时能指着原文说清在哪）。
 * ★ 必须剥：wallpaper.html 那段注释里写着「以前这里没有取令牌的逻辑」——
 *   "取令牌"三个字就在注释里，不剥的话 indexOf 会先命中注释，这类判据立刻变假绿。
 */
function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/gu, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/(?<![:"'`])\/\/[^\n]*/gu, blank);
}

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

/**
 * 起一个真服务。**dataDir 可以传已有的** —— 第 ③ 条要靠"同一个数据目录再启一次"
 * 来验证模式是不是真落库了（同进程读回来证明不了任何事）。
 *
 * ★ persistDir=true：kill 时**不删目录**。跨重启那条要先关掉旧进程、再用同一目录重开，
 *   目录被删就等于对着一个全新空库读 —— "还是 shuffle"会变成"刚好默认就是 shuffle"的假绿。
 */
async function boot(dataDir, { persistDir = false } = {}) {
  const own = !dataDir;
  if (own) dataDir = await mkdtemp(join(tmpdir(), "linli-guard-"));
  const libraryDir = join(dataDir, "music");
  if (own) {
    for (const d of SONGS) {
      await mkdir(join(libraryDir, d), { recursive: true });
      await writeFile(join(libraryDir, d, `${d}_TOD2000_NI_L.mp4`), Buffer.alloc(32));
    }
  }
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LINLI_DATA_DIR: dataDir, LINLI_PORT: "0", LINLI_ASSETS_DIR: join(dataDir, "no-assets"), LINLI_NO_GAME_ASSETS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;

  // withToken 默认 true。第 ① 条要故意不给令牌，所以留个开关。
  const call = async (method, path, body, { withToken = true, origin = true } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(withToken ? { "x-linli-token": token } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  if (own) {
    await call("POST", "/api/library/dir", { dir: libraryDir });
    for (const d of SONGS) await call("POST", "/api/library/import", { dir: d });
  }
  // ★ 队列顺序**必须问服务端**，不能写死 SONGS 的顺序。
  //   桌面曲库是 `ORDER BY added_at DESC, dir`：三次导入一旦跨过一秒边界，顺序就变
  //   （实测负载下变成 [Solo_Charlie, Solo_Alpha, Solo_Bravo]），
  //   用例里写死 "SONGS[0] 是队首" 就会**假红**（60 分钟压测里这个文件红了 3 次）。
  //   队列的来源也一样：桌面曲库非空时队列＝桌面曲库，空了才退回扫曲库（顺序是文件系统顺序，更不稳）。
  const desk = (await call("GET", "/api/library/songs")).body?.songs ?? [];
  return {
    dataDir,
    desk,
    get: (p, opt) => call("GET", p, undefined, opt),
    post: (p, b, opt) => call("POST", p, b, opt),
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited.catch(() => {});
      }
      if (own && !persistDir) await cleanupDir(dataDir).catch(() => {});
    },
  };
}

describe("播放顺序：令牌闸与状态不被越权改动", () => {
  let srv;
  before(async () => { srv = await boot(); });
  after(async () => { await srv?.kill(); });

  test("① 三个写路由不带令牌一律 403 COMMON_TOKEN_MISSING，且 state 一根汗毛都没动", async () => {
    // ★ 这条就是 §13.3 那次事故的正面护栏。
    //   桌面层（wallpaper.html）是"曲子放完才调一次"的路径 ——
    //   服务端把闸门一松，表现就是"放完整首曲子后停在最后一帧"，别的所有用例一条都不会红。
    await srv.post("/api/stage/play", { dir: SONGS[0] });
    const before = await srv.get("/api/stage/next");

    const writes = [
      ["POST /api/stage/mode", "/api/stage/mode", { mode: "repeat" }],
      ["POST /api/stage/advance", "/api/stage/advance", { delta: 1 }],
      ["POST /api/stage/play", "/api/stage/play", { dir: SONGS[1] }],
    ];
    for (const [label, path, body] of writes) {
      const r = await srv.post(path, body, { withToken: false });
      assert.equal(r.status, 403, `${label} 不带令牌应当被拒，实际 ${r.status}`);
      assert.equal(r.body?.code, "COMMON_TOKEN_MISSING", `${label} 的错误号应是 COMMON_TOKEN_MISSING，实际 ${r.body?.code}`);
    }

    const after = await srv.get("/api/stage/next");
    assert.deepEqual(
      { dir: after.body?.dir, url: after.body?.url },
      { dir: before.body?.dir, url: before.body?.url },
      "三次无令牌写入之后，桌面正在放的那一首不该有任何变化",
    );
    // 播放模式也不该被无令牌请求改掉（GET 是公开的，正好能读回来验）
    assert.equal((await srv.get("/api/stage/mode")).body.mode, "order", "播放顺序不该被无令牌请求改掉");
  });

  test("② 只有 GET /api/stage/mode 是公开的；读得到不等于写得动", async () => {
    const r = await srv.get("/api/stage/mode", { withToken: false });
    assert.equal(r.status, 200, "只读查询不需要令牌（跟 /api/idle/settings 一个口径）");
    assert.equal(typeof r.body?.mode, "string");
  });
});

describe("播放顺序：跨重启与反向走到头", () => {
  let srv;
  before(async () => { srv = await boot(); });
  after(async () => { await srv?.kill(); });

  test("③ 播放模式要真的落库：同一个数据目录重开一次服务，还是上次选的那个", async () => {
    // ★ 他们 tests\stage-mode.test.js 的 ① 号是「同进程里设完再读回来」——
    //   那条证不出"持久化"：把 setSetting 换成内存变量它也照样绿。
    //   而用户感知到的恰恰是"开机回来是不是我上次选的那个"（文档：否则界面写顺序、桌面按单曲走）。
    //
    // ★ 这条必须自己管目录：不能拿外层 before 起的那个服务 ——
    //   它的 dataDir 在 kill() 时会被连带删掉（默认 own 目录随进程清理），
    //   拿一个刚被删空的目录去"重开"，读到的是全新默认值。
    const dataDir = await mkdtemp(join(tmpdir(), "linli-guard-"));
    const first = await boot(dataDir, { persistDir: true });
    try {
      const set = await first.post("/api/stage/mode", { mode: "shuffle" });
      assert.equal(set.status, 200, `设 shuffle 失败：${JSON.stringify(set.body)}`);
      assert.equal((await first.get("/api/stage/mode")).body?.mode, "shuffle", "同进程里先读回来 shuffle（先确认写入成功）");
    } finally { await first.kill(); }
    await new Promise((r) => setTimeout(r, 600));

    const again = await boot(dataDir, { persistDir: true });
    try {
      const back = await again.get("/api/stage/mode");
      assert.equal(back.body?.mode, "shuffle", `重开之后应仍是 shuffle，实际 ${back.body?.mode}`);
    } finally {
      await again.kill();
      await cleanupDir(dataDir).catch(() => {});
    }
  });

  test("④ advance 之后 /api/stage/next 必须跟着变（窗口看到的下一首 = 桌面真放的）", async () => {
    // 文档原话：「不一致的话，窗口里看到"下一首"和桌面上真放出来的会是两首」。
    const s = await boot();
    try {
      // ★ 起点必须问服务端，而且必须是"后面还有下一首"的那首。
      //   顺序模式下越过队尾会按**设计**回待机（dir=null / url=null / ended:true），
      //   那时断言红的不是"两个出口没同步"，而是"我挑了个没有后继的起点" —— 判据被自己绕过去了。
      //   ★ 写死 SONGS[0] 为什么不行（2026-10-24 压测定位）：`importedSongs()` 是
      //     `ORDER BY added_at DESC, dir`。三次导入在同一秒内 ⇒ added_at 相同 ⇒ 按 dir 升序，
      //     SONGS[0] 恰好在队首，能过；一旦跨过一秒边界 ⇒ 按时间倒序 ⇒ 最早导入的
      //     SONGS[0] 被挤到**队尾** ⇒ advance 直接回待机 ⇒ 用例红。
      //     60 分钟压测里这条红了 2/33 轮，本机跨秒对照 4/4 必现、不跨秒 12/12 全过。
      assert.ok(s.desk.length >= 2, `测试前提：队里至少要有两首，实际 ${s.desk.length}`);
      const startDir = s.desk[s.desk.length - 2].dir;
      await s.post("/api/stage/mode", { mode: "order" });
      await s.post("/api/stage/play", { dir: startDir });
      const before = await s.get("/api/stage/next");
      assert.equal(before.body?.dir, startDir, `点播之后 stage/next 应当就是刚点的 ${startDir}`);

      const adv = await s.post("/api/stage/advance", { delta: 1 });
      assert.equal(adv.status, 200);
      const nxt = await s.get("/api/stage/next");

      // ★ 两段都要：只比"两个出口一致"是不够的 ——
      //   把 `stageForced = next` 那一行删掉（队列压根没往前走），advance 与 next
      //   照样报同一首（旧的那首），"一致"却"没动"。所以必须再钉一句"真的换了首"。
      assert.equal(nxt.body?.dir, adv.body?.dir, `advance 给了 ${adv.body?.dir}，但 stage/next 说的是 ${nxt.body?.dir}`);
      assert.notEqual(adv.body?.dir, before.body?.dir, `advance 之后应真的换到下一首，实际还是 ${adv.body?.dir}`);
      assert.ok(nxt.body?.url, "同步之后还要真能取到流");
    } finally { await s.kill(); }
  });

  test("⑤ 顺序模式往回（delta=-1）走到队列头 ⇒ 回待机，不许绕到最后一首", async () => {
    const s = await boot();
    try {
      // ★ 队首要**问服务端**（见 boot() 里的说明）：写死 SONGS[0] 会在导入跨秒时假红。
      assert.equal(s.desk.length, SONGS.length,
        `桌面曲库应当有 ${SONGS.length} 首，实际 ${s.desk.length}（${JSON.stringify(s.desk.map((x) => x.dir))}）`);
      const head = s.desk[0].dir;
      await s.post("/api/stage/mode", { mode: "order" });
      await s.post("/api/stage/play", { dir: head });
      const r = await s.post("/api/stage/advance", { delta: -1 });
      assert.equal(r.status, 200);
      assert.equal(r.body?.dir, null, `顺序播放从队首（${head}）往回，应当是回待机而不是绕圈`);
      assert.equal(r.body?.reason, "idle");
      assert.equal(r.body?.ended, true, "这条 ended 要给出 true，桌面层据此去重跑 tick");
      assert.equal((await s.get("/api/stage/next")).body?.url, null, "之后 stage/next 也该说没有曲子");
    } finally { await s.kill(); }
  });

  test("⑥ 列表循环往回（delta=-1）绕到最后一首；单曲模式停留在自己", async () => {
    const s = await boot();
    try {
      // ★ 同样是问服务端拿队首与队尾（顺序不由本用例假定）。
      const head = s.desk[0].dir;
      const tail = s.desk[s.desk.length - 1].dir;
      await s.post("/api/stage/mode", { mode: "repeat" });
      await s.post("/api/stage/play", { dir: head });
      const back = await s.post("/api/stage/advance", { delta: -1 });
      assert.equal(back.body?.dir, tail, `列表循环从头往回应绕到最后一首（头 ${head} ⇒ 尾 ${tail}）`);
      assert.ok(back.body?.url, "绕回去也要给得出 url");

      const second = s.desk[1]?.dir ?? head;
      await s.post("/api/stage/mode", { mode: "single" });
      await s.post("/api/stage/play", { dir: second });
      const stay = await s.post("/api/stage/advance", { delta: -1 });
      assert.equal(stay.body?.dir, second, "单曲模式往回也该停在自己这首");
    } finally { await s.kill(); }
  });
});

describe("曲库页入口（S36 回归）：只查字符串是不够的", () => {
  /**
   * 从 startMarker 起按 `<div>` / `</div>` 的**深度**找出这个元素的完整片段。
   *
   * ★ 为什么不能用 `/<div class="player-page"...[\s\S]*?<\/div>\s*<\/div>/`：
   *   非贪婪只吃**两**层闭合，而 #playerPage 里面先是 player-container、再是 video-wrapper，
   *   两层的 `</div></div>` 在 player-container 结束就出现了 —— 片段到此为止，
   *   后面的 `<div class="player-bar">` **压根不在里面**。
   *   ⇒ 用那条正则做"不许把它放进播放页"的反向断言，把按钮搬进播放条也照样绿。
   *   （实测：对方 §14.3 的那条反向断言就是这么失效的，变异 T1b 仍绿。）
   */
  function sliceDiv(html, startMarker) {
    const at = html.indexOf(startMarker);
    assert.ok(at >= 0, `index.html 里找不到 ${startMarker}`);
    const re = /<div\b|<\/div>/gu;
    re.lastIndex = at;
    let depth = 0;
    let m;
    while ((m = re.exec(html))) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) return html.slice(at, m.index + m[0].length);
    }
    return "";
  }

  test("⑪ 唯一的播放入口是 #pbMode；#deskMode 已按用户口径整块下掉（2026-10-20 反转）", async () => {
    // ★ 先剥 HTML 注释再判：改动说明里会提到 "player-bar" 这些类名（2026-10-20 实测
    //   搬迁注释里的字样就把"不许出现"的反向断言打红了），注释不是结构。
    const html = (await readFile(INDEX_HTML, "utf8")).replace(/<!--[\s\S]*?-->/gu, "");
    const head = sliceDiv(html, '<div class="desk-head">');
    // ★ 口径反转（用户原话）：「在音乐桌面的单曲循环按钮就删了吧，底下的播放条有一个了，
    //   要不就重复了」。S36 的老病是"**一个入口都没有**"，现在的形态是"只有一个入口"，
    //   所以这条守的是：工具行里不许再有它 + 真入口必须还在。
    assert.ok(!head.includes('id="deskMode"'),
      "「音乐桌面」工具行里不许再有 #deskMode（用户：跟播放条重复了）");
    assert.equal((html.match(/id="pbMode"/gu) ?? []).length, 1,
      "#pbMode 必须存在且只有一份（那是唯一的四态入口）");

    // ★ 反向：整段 #playerPage 都不许出现任何播放入口
    const player = sliceDiv(html, '<div class="player-page" id="playerPage"');
    // ★ 2026-10-20：播放条整条搬进了曲库页底部（用户圈原版截图指定）。
    //   #playerPage 里**不再有** player-bar —— 旧拷贝必须删干净（同一批 pb* id 只许一份，
    //   不然 app.js 的接线会打到 hidden 副本上）。这行的方向从"必须含"反转成"必须不含"。
    assert.ok(!player.includes("player-bar"), "旧播放条必须从 #playerPage 删掉（已搬到曲库页底部）");
    assert.ok(!player.includes('id="pbMode"'), "#pbMode 不许出现在 hidden 的播放页里 —— 那正是 S36 的形态");
  });

  test("⑫ 点下去必须真落库、真轮转（剥掉注释再判）", async () => {
    // ★ 三条都必须**先剥注释**：`// void savePlayMode(...)` 里那几个字符照样能被
    //   indexOf / 正则命中，于是"把落库那行注释掉"这种真事故会全绿（变异 T2 实测如此）。
    const src = stripComments(await readFile(APP_JS, "utf8"));

    const at = src.indexOf("function cyclePlayMode()");
    assert.ok(at > 0, "找不到 cyclePlayMode()");
    const body = src.slice(at, at + 600);
    assert.ok(body.includes("void savePlayMode(mode.key)"), "切了必须 POST 落库，否则界面转了、桌面还按旧顺序走");
    assert.match(body, /playMode\s*=\s*\(playMode\s*\+\s*1\)\s*%\s*PLAY_MODES\.length/u, "四态轮转要真的取模，不能漏档");

    // 真入口必须指向同一个轮转函数：空壳回调 `() => {}` 会让按钮变成死的，
    // 而"只查 addEventListener("click"" 这种半截断言抓不到（变异 T3 实测如此）。
    const re = new RegExp(`\\$\\("pbMode"\\)\\?\\.addEventListener\\("click",\\s*\\(\\)\\s*=>\\s*cyclePlayMode\\(\\)\\)`, "u");
    assert.match(src, re, `#pbMode 的 click 必须直接调 cyclePlayMode()`);
    assert.ok(!src.includes('$("deskMode")'), "#deskMode 的接线必须删干净（按钮没了就是死代码）");
  });
});

describe("桌面层（wallpaper.html）：HTTP 断言够不到的地方", () => {
  test("⑦ 写请求必须自带令牌 —— api() 里那句注入不能被删掉", async () => {
    // ★ 这条护的是 §13.3 的**前端**那一半：就算服务端闸门好好的，
    //   桌面层自己不发令牌也一样 403，而且只有放完整首曲子才看得见。
    const raw = await readFile(WALLPAPER, "utf8");
    const src = stripComments(raw);

    assert.ok(/async function ensureToken\s*\(/u.test(src), "wallpaper.html 里找不到 ensureToken()");
    const at = src.indexOf("async function api(");
    assert.ok(at > 0, "找不到 api() 定义");
    const body = src.slice(at, at + 900);
    assert.ok(body.includes("x-linli-token"), "api() 里不再注入 x-linli-token 了 —— 桌面层的所有写请求都会被拒");
    assert.ok(body.includes("ensureToken"), "api() 不再调 ensureToken() 了");
    assert.ok(/GET/.test(body) && /HEAD/.test(body), "api() 应当只对非 GET/HEAD 加令牌（全加会破坏公开读路由的语义）");
  });

  test("⑧ 曲子与过场必须 loop:false，待机仍然 loop —— 否则自动续播永远不触发", async () => {
    // ★ 自动走到下一首靠的是「曲子放完 ⇒ ended ⇒ POST advance」。
    //   谁要是给曲子那枚 video 加回 loop，`ended` 一次都不会来，
    //   桌面就永远停在第一首反复重播，而八个 HTTP 用例一条都不会红。
    const raw = await readFile(WALLPAPER, "utf8");
    const src = stripComments(raw);

    // ⑧-a 两枚 video 标签身上不能再有 loop 属性（环境音 <audio> 保留 loop 是对的）
    for (const tag of ["vA", "vB"]) {
      const t = new RegExp(`<video[^>]*id="${tag}"[^>]*>`, "u").exec(raw);
      assert.ok(t, `找不到 <video id="${tag}">`);
      assert.ok(!/\sloop(\s|>|=)/u.test(t[0]), `<video id="${tag}"> 身上又出现 loop 属性了 —— 曲子播完就不会触发 advance`);
    }

    // ⑧-b crossFade 的实现必须是「没说 loop:false 就默认 loop」，待机那两个调用点才能一直循环
    assert.ok(/incoming\.loop\s*=\s*opts\.loop\s*!==\s*false/u.test(src), "crossFade 的默认环回语义被改了");

    // ⑧-c 曲子的两个调用点必须显式 loop:false（tick 起播 + advance 续播）
    const starts = [...src.matchAll(/crossFade\([^;]*?loop:\s*false/gu)];
    // 过场 1 处 + 曲子 2 处 = 至少 3 处（将来再多加也不算错，这里只防"一处都不剩"）
    assert.ok(starts.length >= 3, `loop:false 的 crossFade 调用点只剩 ${starts.length} 处（应 ≥3：过场 + tick 起播 + advance 续播）`);

    // ⑧-d 待机正片那几个调用点必须**不带** loop:false（否则待机会播一遍就停）
    // ★ 不能只数 `crossFade(n.video)` 出现几次 —— 源码里本来就有 3 处，
    //   被人改掉 1 处还剩 2 处，"≥2"照样绿（变异 M11 就是这么蒙过去的）。
    //   逐个调用点看它自己身上有没有带 loop:false。
    const idleCalls = [...src.matchAll(/crossFade\(n\.video\s*(?:,\s*\{[^}]*\})?\)/gu)].map((m) => m[0]);
    assert.ok(idleCalls.length >= 2, `待机正片的 crossFade(n.video) 应至少 2 处，实际 ${idleCalls.length}`);
    for (const call of idleCalls) {
      assert.ok(!/loop:\s*false/u.test(call), `待机正片的调用点被加了 loop:false ⇒ 待机播一遍就停：${call}`);
    }
  });

  test("⑨ advanceSong 走的是 POST /api/stage/advance，并且有防重入的互斥", async () => {
    const raw = await readFile(WALLPAPER, "utf8");
    const src = stripComments(raw);
    const at = src.indexOf("async function advanceSong");
    assert.ok(at > 0, "找不到 advanceSong()");
    const body = src.slice(at, at + 900);
    assert.ok(body.includes("/api/stage/advance"), "advanceSong 不再调 /api/stage/advance");
    assert.ok(/method:\s*"POST"/u.test(body), "advanceSong 必须是 POST（写操作，顺带才能带上令牌）");
    assert.ok(/advancing\s*=\s*true/u.test(body), "没有 advancing 互斥 ⇒ 连着 ended 会一次跳好几首");
  });

  test("⑩ /api/stage/advance 失败时不能停在最后一帧 —— catch 里要把 mode 放开让 tick 重试", async () => {
    // §13.3 那次事故的兜底写法：catch 里只置 mode=null，靠 30 秒一次的 tick 兜回来。
    // 如果哪天有人在 catch 里写成了 `throw` 或直接 return 且不让 tick 重跑，表现就是死画面。
    const raw = await readFile(WALLPAPER, "utf8");
    const src = stripComments(raw);
    const at = src.indexOf("async function advanceSong");
    const body = src.slice(at, at + 1400);
    assert.ok(/catch/u.test(body), "advanceSong 没有 catch —— 服务端一时没答上来就再也回不到画面了");

    // tick 必须是**定时**的，否则 catch 里置了 mode=null 也没人再来拉一把。
    // ★ 不能写成 setInterval\([^)]*tick\(\) 去抠这一条 —— 回调是 "() => { tick()… }"，
    //   第一个 ')' 在第 2 个字符就出现了，正则永远匹配不到（这条判据会变成"恒假"的假红）。
    const timers = [...src.matchAll(/setInterval\(/gu)].map((m) => src.slice(m.index, m.index + 240));
    const tickTimer = timers.find((w) => /tick\s*\(/u.test(w));
    assert.ok(tickTimer, "找不到定时调用 tick() 的定时器 —— advance 失败后没有任何兜底重试");

    // 顺带把节奏钉住：太密会把服务端打死，太疏用户盯着黑屏干等。
    const ms = Number((/,(\s*)(\d+)\s*\)/u.exec(tickTimer ?? "") ?? [])[2]);
    assert.ok(Number.isFinite(ms) && ms >= 1000 && ms <= 120000, `tick 的轮询间隔应在 1s~120s，实际 ${ms}ms`);
  });
});
