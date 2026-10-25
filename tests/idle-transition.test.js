/**
 * `/api/idle/transition` 的护栏（2026-10-19 五轮：真机探针把它从"零测试"里捞出来的）。
 *
 * 它此前一条用例都没有，而真机一跑就露出两件事：
 *   ① 参数的写法是**两套混着的** —— `/api/idle/next` 回的 `slot` 是 `"1200"/"1730"/"2000"`（前端原样回传），
 *      而别处的 `tod` 是 `"TOD12"/"TOD1730"/"TOD20"`。以前只认前者，传后者会得到「不是相邻时段」——
 *      把"名字写错"报成"这两档不相邻"，两种问题同一句话，排查会被带偏。现在两套都收。
 *   ② `reason` 分三档：`认不出这两个时段` / `不是相邻时段` / `过场片缺失`。
 *
 * 断言口径：这条属于"故意不进错误体系"的二进制族 ⇒ 任何情况都回 **200**，
 * 用 `url: null` + `reason` 表达失败。所以这里不许出现 4xx/5xx（出现就是破坏了家族约定）。
 *
 * 素材自己造（空文件即可，服务端只判文件名与存在性），不依赖本机装没装原版游戏。
 *
 * 跑法：node --test --test-force-exit tests\idle-transition.test.js
 */

import { test, describe, before, after } from "node:test";
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

/** 造一套最小素材：每套场景一个正片 + 三条相邻过场片（1200→1730 / 1730→2000 / 2000→1200）。 */
async function makeAssets(dataDir) {
  const presence = join(dataDir, "assets", "Wallpaper_Presence");
  await mkdir(presence, { recursive: true });
  for (const scene of ["A", "B", "C"]) {
    for (const slot of ["1200", "1730", "2000"]) {
      await writeFile(join(presence, `${scene}_R1_${slot}.mp4`), Buffer.alloc(8));
    }
    for (const [from, to] of [["1200", "1730"], ["1730", "2000"], ["2000", "1200"]]) {
      await writeFile(join(presence, `${scene}_Transition_${from}_${to}.mp4`), Buffer.alloc(8));
    }
  }
  // 环境音给一条，免得别的路由在日志里刷"缺素材"
  const ambience = join(dataDir, "assets", "Wallpaper_Ambience");
  await mkdir(ambience, { recursive: true });
  await writeFile(join(ambience, "ambient_loop_1.mp3"), Buffer.alloc(8));
  return join(dataDir, "assets");
}

async function boot({ withAssets = true, withBuiltin = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "linli-trans-"));
  const assetsDir = withAssets ? await makeAssets(dataDir) : join(dataDir, "no-assets-here");
  // ★ 2026-10-21：`withBuiltin:false` 把随包自制片的目录也指到空目录 —— 这样才造得出
  //   "原版没有、自带也没有"这个真缺片的状态（此前靠"B 场景没做片子"顺带覆盖，
  //   B/C 的片子做完后那条路子就断了）。
  const builtinDir = withBuiltin ? join(ROOT, "app", "transitions") : join(dataDir, "no-builtin-here");
  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    // LINLI_NO_GAME_ASSETS=1：这台机器装着原版游戏，不关掉自动发现的话 "没有素材" 那个场景永远造不出来
    env: {
      ...process.env,
      LINLI_DATA_DIR: dataDir,
      LINLI_PORT: "0",
      LINLI_ASSETS_DIR: assetsDir,
      LINLI_TRANSITIONS_DIR: builtinDir,
      LINLI_NO_GAME_ASSETS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;
  const get = async (q) => {
    const res = await fetch(`${base}/api/idle/transition?${q}`, {
      headers: { "x-linli-token": token },
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const fetchRaw = async (path) => {
    const res = await fetch(`${base}${path}`, {
      headers: { "x-linli-token": token },
      signal: AbortSignal.timeout(20000),
    });
    const buf = await res.arrayBuffer().catch(() => null);
    return { status: res.status, type: res.headers.get("content-type") ?? "", bytes: buf ? buf.byteLength : 0 };
  };
  return {
    get,
    fetchRaw,
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

describe("/api/idle/transition", () => {
  let srv;
  before(async () => { srv = await boot(); });
  after(async () => { await srv?.kill(); });

  test("① 相邻时段（原始写法 1200→1730）：给出该场景的过场片 URL", async () => {
    const { status, body } = await srv.get("from=1200&to=1730&scene=B");
    assert.equal(status, 200);
    assert.equal(body.url, "/api/idle/video?file=B_Transition_1200_1730.mp4");
    assert.equal(body.scene, "B");
  });

  test("② TOD 写法同样收（TOD12→TOD1730 等价于 1200→1730）", async () => {
    const { body } = await srv.get("from=TOD12&to=TOD1730&scene=A");
    assert.equal(body.url, "/api/idle/video?file=A_Transition_1200_1730.mp4");
    // 两套写法混着传也要能对上（前端历史上两种都用过）
    const mixed = await srv.get("from=1730&to=TOD20&scene=C");
    assert.equal(mixed.body.url, "/api/idle/video?file=C_Transition_1730_2000.mp4");
  });

  test("③ 跨零点（2000→1200）算相邻 —— 方向由服务端按环形判", async () => {
    const { body } = await srv.get("from=2000&to=1200&scene=A");
    assert.equal(body.url, "/api/idle/video?file=A_Transition_2000_1200.mp4");
  });

  test("④ 不相邻的时段：url 为 null，reason 说清是「不相邻」", async () => {
    const { status, body } = await srv.get("from=1200&to=2000&scene=B");
    assert.equal(status, 200, "二进制族不许用 4xx 表达失败");
    assert.equal(body.url, null);
    assert.equal(body.reason, "不是相邻时段");
  });

  test("⑤ 名字认不出（含穿越串）：url 为 null，reason 是「认不出」而不是「不相邻」", async () => {
    for (const q of [
      "from=..%2F..%2Fetc&to=ALSOBAD&scene=A",
      "from=9999&to=8888&scene=A",
      "from=&to=&scene=A",
    ]) {
      const { status, body } = await srv.get(q);
      assert.equal(status, 200, `不许用 4xx 表达失败：${q}`);
      assert.equal(body.url, null, `不该给 URL：${q}`);
      assert.equal(body.reason, "认不出这两个时段", `reason 要区分「写错名字」与「不相邻」：${q}`);
    }
  });

  test("⑥ scene 非法时退回一个合法场景，而不是报错", async () => {
    const { status, body } = await srv.get("from=1200&to=1730&scene=Z");
    assert.equal(status, 200);
    assert.match(body.scene, /^[ABC]$/u, `scene 应当是 A/B/C 之一，实际 ${body.scene}`);
    assert.equal(body.url, `/api/idle/video?file=${body.scene}_Transition_1200_1730.mp4`);
  });
});

describe("/api/idle/transition（没有素材时）", () => {
  let srv;
  before(async () => {
    // 指向一个不存在的素材根。★ 2026-10-21 起行为变了：原版素材不在时**回退到随包的自制
    //   过渡片**（app/transitions/，场景 A 的三个方向）—— 不再硬切。所以：
    //   · 场景 A = 「原版缺、自带补」⇒ 应给出自制片（source="built-in"）；
    //   · 场景 B = 「原版缺、自带也没有」（咱们只随包了 A）⇒ 这才是真的「过场片缺失」。
    srv = await boot({ withAssets: false });
  });
  after(async () => { await srv?.kill(); });

  test("⑦ 原版缺、自带补：场景 A 相邻过渡回退到随包自制片（source=built-in），不再硬切", async () => {
    const { status, body } = await srv.get("from=1200&to=1730&scene=A");
    assert.equal(status, 200);
    assert.equal(body.url, "/api/idle/video?file=A_Transition_1200_1730.mp4");
    assert.equal(body.source, "built-in", "缺原版时应当标注用的是随包自制片");
    // ★ 别只看 url 形状 —— 真去取一次，确认 idleFilePath 的回退真的通了。
    const v = await srv.fetchRaw("/api/idle/video?file=A_Transition_1200_1730.mp4");
    assert.equal(v.status, 200, `自制片应当取得到，实际 ${v.status}`);
    assert.match(v.type, /video\/mp4/u, `Content-Type 应当是 video/mp4，实际 ${v.type}`);
    // ★ 判据是「大于 100KB」而不是写死字节数：第四版（2026-10-21）起片长按音频实长逐片算
    //   （整点 16 音威斯敏斯特钟声 + 出发时刻报时 12/5/8 下 ⇒ 21.65 / 17.80 / 19.45 秒；
    //    第五版把片尾报时音色按真录音重做为 148.71Hz 大钟 + 4.5s 长尾，片长随之再涨），
    //   体积会随片长变，写死就成了定时炸弹。
    assert.ok(v.bytes > 100_000, `自制片是 2K 真片子（2560×1440，约 7–12MB），实际 ${v.bytes} 字节 —— 太小说明取错了文件`);
  });

  test("⑧ 原版缺、自带也在（场景 B/C 已补齐）：照样回退到随包自制片", async () => {
    // ★ 2026-10-21 起 B/C 九个方向都有片子了，B 不再是"真缺片"的例子。
    //   这条改成钉住"补齐之后 B/C 也走得到自制片"，别让 B/C 又悄悄退回硬切。
    for (const scene of ["B", "C"]) {
      const { status, body } = await srv.get(`from=1200&to=1730&scene=${scene}`);
      assert.equal(status, 200);
      assert.equal(body.url, `/api/idle/video?file=${scene}_Transition_1200_1730.mp4`);
      assert.equal(body.source, "built-in", `${scene} 场景应当标注用的是随包自制片`);
      const v = await srv.fetchRaw(body.url);
      assert.equal(v.status, 200, `${scene} 场景的自制片应当取得到，实际 ${v.status}`);
    }
  });
});

describe("/api/idle/transition（原版与自带片都没有时：真缺片）", () => {
  let srv;
  before(async () => {
    // ★ 两边都空：这一层才是"安装包残缺/被删"时用户真会撞上的状态。
    srv = await boot({ withAssets: false, withBuiltin: false });
  });
  after(async () => { await srv?.kill(); });

  test("⑧-bis A/B/C 三个场景都必须给 url:null + 「过场片缺失」，绝不编一个取不到的地址", async () => {
    for (const scene of ["A", "B", "C"]) {
      const { status, body } = await srv.get(`from=1200&to=1730&scene=${scene}`);
      assert.equal(status, 200, "这一族任何情况都回 200，不许 4xx/5xx");
      assert.equal(body.url, null, `${scene} 场景：真缺片时必须 url:null，实际 ${body.url}`);
      assert.equal(body.reason, "过场片缺失", `${scene} 场景 reason 实际=${body.reason}`);
    }
  });
});

describe("原版优先：素材根里有时不用自制片", () => {
  let srv;
  before(async () => { srv = await boot(); }); // withAssets: true ⇒ 素材根里有假过场片
  after(async () => { await srv?.kill(); });

  test("⑨ 素材根里有过场片 ⇒ 走原版（响应不带 source=built-in）", async () => {
    const { status, body } = await srv.get("from=1200&to=1730&scene=A");
    assert.equal(status, 200);
    assert.equal(body.url, "/api/idle/video?file=A_Transition_1200_1730.mp4");
    assert.equal(body.source, undefined, "原版路径不该带 built-in 标记 —— 出现了说明「原版优先」被破坏");
  });
});
