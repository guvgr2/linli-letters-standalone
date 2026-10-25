/**
 * `/api/library` 的**端到端**护栏：起真服务 → 扫真目录 → 看真响应。
 *
 * 为什么单有一个文件：
 *   2026-10-18 之前，`officialSong()` / `songDisplayName()` / `songMode()` 三个函数
 *   早在 core.mjs 就写好了（129 条官方曲名与作曲家逐字钉死），而 `scanLibrary()`
 *   只吐 `{name, dir}` —— **函数摆着没人调**。界面于是只显示裸目录名
 *   （`PlaySing The Road Not Taken`），用户截图里"曲库不像原版"有一半出在这里。
 *
 *   这件事**静态读代码看不出来**：core.mjs 的官方表是完整的、scanLibrary 也不报错，
 *   只有真发一次 `GET /api/library` 才知道响应里有没有 composer / mode / slots。
 *   所以这里守的是**接线**，不是那三个纯函数本身（它们的规则另有 core.test.js 守）。
 *
 * 为什么用真目录而不是 mock：
 *   slots 是从**文件名**里读出来的（`_TOD1200/1730/2000_`），`parseVariant` 认不认得
 *   全看命名。拿假对象喂进去等于自证。这里造 5 个真目录，其中一个故意缺两段、
 *   一个故意混进非 mp4 与非 TOD 命名的文件，看它会不会虚报。
 *
 * 跑法：node --test --test-force-exit tests\library-scan.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

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
  // 曲库目录得靠写接口设进去（默认曲库是空串 = 还没选过，见 server.mjs 的 libraryDirSetting）
  const put = await fetch(`${base}/api/library/dir`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-linli-token": token },
    body: JSON.stringify({ dir: libraryDir }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(put.status, 200, `设置曲库目录失败：${put.status}`);
  return { child, base, token, logs };
}

// ---------------------------------------------------------------- 曲库夹具
//
// 目录名必须过 core.mjs 的 LIBRARY_DIR_PATTERN = /^(?:solo|playsing|midi|oliviasoul)/iu，
// 否则 scanLibrary 根本看不见它们。
//
// ★ 表外目录**不能拿真曲名当靶子**：`The_Road_Not_Taken` 这类真曲子全在 129 条官方表里
//   （core.mjs:983），我第一版就是拿它当"表外"样本，测试 ③ 直接红 —— 挑错了靶子。
//   表外必须用曲库真实布局里不可能出现的名字 ⇒ `Solo_No_Such_Tune`。
//   composer 必须是 null（不是空字符串、不是漏字段）。这一条专治"表外也硬凑作曲家"。
const OFFICIAL = {
  // 古典：一条时段齐全、一条只拍到一段
  "Solo_Air_On_The_G_String_From_Orchestral_Suite_No3_In_D_Major_BWV_1068": {
    title: "Air on the G String, BWV 1068",
    composer: "Bach",
    genre: "古典",
    mode: "独奏",
    files: ["TOD1200", "TOD1730", "TOD2000"],
  },
  "PlaySing_Liang_Zhi_Lao_Hu_Ziyun_original": {
    title: "两只老虎",
    composer: "童谣",
    genre: "轻音乐",
    mode: "弹唱",
    files: ["TOD2000"],
  },
};

// 表外：不在官方 129 条里
const OUTSIDE = "Solo_No_Such_Tune";

/**
 * ★ 混进来的"脏东西"，必须一个都看不见：
 *   · `notes.txt` —— 不是 mp4
 *   · `Solo_No_Such_Tune_...` 的**截断名** `TOD1300` —— 时段不在原版三档里
 *   · 一个**子目录** `Stems` —— 不能当文件读
 *   · 一个**大写扩展名** `_TOD1730_NI_L.MP4` —— 大小写不敏感地认，算 TOD1730
 */
const NOISE = {
  plain: ["notes.txt", "TOD1300_NI_L.mp4"],
  upper: "Solo_No_Such_Tune_TOD1730_NI_L.MP4",
};

async function buildLibrary(root) {
  for (const [dir, spec] of Object.entries(OFFICIAL)) {
    const full = join(root, dir);
    await mkdir(full, { recursive: true });
    for (const tod of spec.files) {
      // 两个视角都放：slots 只该按时段去重（NI/WI 是同一段的两个机位，不是两段）
      await writeFile(join(full, `${dir}_${tod}_NI_L.mp4`), Buffer.alloc(16));
      await writeFile(join(full, `${dir}_${tod}_WI_L.mp4`), Buffer.alloc(16));
    }
  }
  const outside = join(root, OUTSIDE);
  await mkdir(join(outside, "Stems"), { recursive: true });
  for (const name of NOISE.plain) await writeFile(join(outside, name), Buffer.alloc(16));
  await writeFile(join(outside, NOISE.upper), Buffer.alloc(16));
  // 再来一首表外、且**一个片子都没有**的目录：slots 必须是 []，不能假装有
  await mkdir(join(root, "Solo_Empty_One"), { recursive: true });
}

// ---------------------------------------------------------------- 断言

describe("/api/library：官方曲名 / 作曲家 / 模式 / 时段", () => {
  let child = null;
  let base = "";
  let dataDir = "";
  let songs = [];

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-scan-"));
    const libraryDir = join(dataDir, "music");
    await buildLibrary(libraryDir);
    ({ child, base } = await startServer({ dataDir, libraryDir }));
    const res = await fetch(`${base}/api/library`, { signal: AbortSignal.timeout(20000) });
    assert.equal(res.status, 200, "GET /api/library 必须 200");
    songs = (await res.json()).songs ?? [];
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await cleanupDir(dataDir);
  });

  test("① 扫得到 4 首（两个官方 + 两个表外），脏文件一个都没算进来", { timeout: 60000 }, () => {
    const dirs = songs.map((s) => s.dir).sort();
    assert.deepEqual(
      dirs,
      [OUTSIDE, "Solo_Empty_One", ...Object.keys(OFFICIAL)].sort(),
      `扫出来的目录不对：${JSON.stringify(dirs)}`,
    );
  });

  test("② 官方曲作用原版曲名与作曲家，不是裸目录名", { timeout: 60000 }, () => {
    for (const [dir, spec] of Object.entries(OFFICIAL)) {
      const got = songs.find((s) => s.dir === dir);
      assert.ok(got, `没扫到 ${dir}`);
      assert.equal(got.name, spec.title, `${dir} 的曲名应是官方表里的「${spec.title}」`);
      assert.equal(got.composer, spec.composer, `${dir} 的作曲家`);
      assert.equal(got.genre, spec.genre, `${dir} 的分档`);
    }
  });

  test("③ 表外曲目 composer 是 null（不是空串、不是漏字段）", { timeout: 60000 }, () => {
    for (const dir of [OUTSIDE, "Solo_Empty_One"]) {
      const got = songs.find((s) => s.dir === dir);
      assert.ok(got, `没扫到 ${dir}`);
      assert.ok("composer" in got, `${dir} 的响应里必须**有** composer 字段（值可以是 null）`);
      assert.equal(got.composer, null, `${dir} 不在官方表里，作曲家必须是 null，实际 ${JSON.stringify(got.composer)}`);
    }
  });

  test("④ 「模式」列：PlaySing 弹唱、Solo 独奏", { timeout: 60000 }, () => {
    assert.equal(songs.find((s) => s.dir === "PlaySing_Liang_Zhi_Lao_Hu_Ziyun_original").mode, "弹唱");
    assert.equal(songs.find((s) => s.dir === OUTSIDE).mode, "独奏");
  });

  test("⑤ 时段按原版顺序排、NI/WI 同段去重、不虚报", { timeout: 60000 }, () => {
    const full = songs.find((s) => s.dir === "Solo_Air_On_The_G_String_From_Orchestral_Suite_No3_In_D_Major_BWV_1068");
    // 目录里放着 3 段 × 2 视角 = 6 个 mp4，slots 只能是 3 个时段
    assert.deepEqual(full.slots, ["TOD12", "TOD1730", "TOD20"], `时段必须是"白天→傍晚→夜晚"三档且去重，实际 ${JSON.stringify(full.slots)}`);

    const one = songs.find((s) => s.dir === "PlaySing_Liang_Zhi_Lao_Hu_Ziyun_original");
    assert.deepEqual(one.slots, ["TOD20"], "只拍了夜晚的就只该报夜晚");

    const empty = songs.find((s) => s.dir === "Solo_Empty_One");
    assert.deepEqual(empty.slots, [], "一个片子都没有的目录必须报空数组，不能假装有");

    // 大写扩展名 .MP4 要算 TOD1730；TOD1300 不是原版三档之一，不算
    assert.deepEqual(songs.find((s) => s.dir === OUTSIDE).slots, ["TOD1730"], `TOD1300 不该被认，大写 .MP4 该被认，实际 ${JSON.stringify(songs.find((s) => s.dir === OUTSIDE).slots)}`);
  });
});

/**
 * ★ 2026-10-19 审查 P1 的第二道判据（链接）。
 *
 * 只挡字面 `../` 是不够的：`existsSync` / `statSync` 会**跟随** junction 与
 * symbolic link。曲库里放一个 `Solo_Link_Escape → 曲库外的目录`，字面上它是
 * 「一级目录名」，stat 也存在，旧判据照样放行，`listVariants` 就去根外面读 `.mp4`。
 *
 * 这个用例就在曲库里造一个指向**根外**的 junction，同时放一首正常曲子做对照：
 *   · 正常曲子：选曲 200、取流 200（别为了安全把功能改坏）
 *   · 那个 junction：选曲 404、取流 404
 *
 * junction 建不起来（非 Windows / 无权限）就跳过 —— 不写一条换台机器就红的断言，
 * 但要**显式打印**跳过原因。
 */
describe("/api/library：曲库里的目录链接不能成为越界通道（审查 P1）", () => {
  let child = null;
  let dataDir = "";
  let base = "";
  let linked = false;
  const REAL = "Solo_Real_One";
  const LINK = "Solo_Link_Escape";
  const FILE = "_TOD2000_NI_L.mp4";

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-link-"));
    const libraryDir = join(dataDir, "music");
    const outside = join(dataDir, "outside");
    await mkdir(join(libraryDir, REAL), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(libraryDir, REAL, REAL + FILE), Buffer.alloc(16));
    await writeFile(join(outside, LINK + FILE), Buffer.alloc(16));
    try {
      await symlink(outside, join(libraryDir, LINK), "junction");
      linked = true;
    } catch (error) {
      console.log(`[跳过] 建不了 junction（${error.code ?? error.message}）：本用例只验证链接场景`);
    }
    ({ child, base } = await startServer({ dataDir, libraryDir }));
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await cleanupDir(dataDir);
  });

  test("⑥ 正常曲子仍然可选、可取流", { timeout: 60000 }, async () => {
    const play = await fetch(`${base}/api/library/play?dir=${REAL}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(play.status, 200, "曲库里的正常曲子不该被新判据挡住");
    const media = await fetch(`${base}/api/media?dir=${REAL}&file=${REAL}${FILE}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(media.status, 200, "正常曲子的取流也必须还能用");
  });

  test("⑦ 指向曲库外的 junction：选曲与取流都必须 404", { timeout: 60000 }, async (t) => {
    if (!linked) return t.skip("junction 不可用，跳过链接越界断言");
    const play = await fetch(`${base}/api/library/play?dir=${LINK}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(play.status, 404, `junction 指向曲库外，选曲必须 404（实际 ${play.status}）`);
    const media = await fetch(`${base}/api/media?dir=${LINK}&file=${LINK}${FILE}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(media.status, 404, `junction 指向曲库外，取流必须 404（实际 ${media.status}）`);
  });
});
