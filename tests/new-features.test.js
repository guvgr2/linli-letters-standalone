/**
 * 2026-10-19 第三轮新增功能的护栏 —— 真起服务 / 真读真写，配得上的才算数。
 *
 * 为什么另开一个文件（而不是塞进 maintenance.test.js）：
 *   maintenance.test.js 那一组问的是「搬家与诊断本身对不对」；这一组问的是另一件事：
 *   **用户在界面上摸得到的那几个新东西，有没有 autosave 式的回归护栏。**
 *   三轮复审（审查工作日志 S20 / S24）逐项验过它们能跑，但当时是手工验的 ——
 *   手工验过一次不代表下次改坏还会红。这一份就是把那次手验固化下来。
 *
 * 跑法：node --test --test-force-exit tests\new-features.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p) => readFile(join(ROOT, p), "utf8");

/**
 * 把注释换成**等长空格**再去看代码顺序。
 * ★ 为什么必须剥：wallpaper.html 那段注释里写着「以前这里只喊一声 tick()，而 tick 要先 await
 *   一次才轮到 stopAmbience()」—— 这两个名字在注释里**就是反着的顺序**。不剥注释的话，
 *   indexOf("tick()") 会先命中注释，判据随即假红；更糟的是有人把真调用挪到注释后面也会假绿。
 *   换成等长空格是为了保留下标，报错时还能指着原文说清在哪一行。
 */
function stripComments(src) {
  const blank = (s) => s.replace(/[^\n]/gu, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/(?<![:"'`])\/\/[^\n]*/gu, blank);
}

// ---------------------------------------------------------------- 起一个真服务

let child = null;
let base = "";
let dataDir = "";
let token = "";

function waitForPort(logs, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`服务在 ${timeoutMs}ms 内没报出 LINLI_PORT。输出：\n${logs.join("")}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      logs.push(chunk.toString("utf8"));
      const hit = /LINLI_PORT=(\d+)/u.exec(logs.join(""));
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    });
  });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "linli-newfeat-"));
  const logs = [];
  child = spawn(process.execPath, [join(ROOT, "app", "server.mjs")], {
    env: { ...process.env, LINLI_PORT: "0", LINLI_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(logs);
  base = `http://127.0.0.1:${port}`;
  token = (await (await fetch(`${base}/api/session`, { headers: { Origin: base } })).json()).token;
});

after(async () => {
  try { child?.kill(); } catch { /* 已经退了 */ }
  try { await cleanupDir(dataDir); } catch { /* 删不掉不影响本次结果 */ }
});

const postSettings = async (payload) =>
  fetch(`${base}/api/idle/settings`, {
    method: "POST",
    headers: { Origin: base, "x-linli-token": token, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
const getSettings = async () => (await (await fetch(`${base}/api/idle/settings`, { headers: { Origin: base } })).json());

// ---------------------------------------------------------------- ① 两条音量条

describe("两条音量条（用户：环境音要能调，演奏也要能调）", () => {
  test("① 两条都能落库，并且 GET 读得回来", async () => {
    const res = await postSettings({ ambienceVolume: 37, songVolume: 82 });
    assert.equal(res.status, 200, "写设置应当成功");
    const view = await getSettings();
    assert.equal(view.ambienceVolume, 37, "环境音音量要跟写进去的一样");
    assert.equal(view.songVolume, 82, "演奏音量要跟写进去的一样");
  });

  test("② 越界值不静默夹，一律 400 + IDLE_VOLUME_INVALID", async () => {
    // 逐个字段逐个坏值试：夹成 100 会让用户以为"拖到头了没效果"，宁可报错。
    for (const field of ["ambienceVolume", "songVolume"]) {
      for (const bad of [-1, 101, 50.5, "80", true, null, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const res = await postSettings({ [field]: bad });
        const body = await res.json().catch(() => ({}));
        assert.equal(res.status, 400, `${field}=${String(bad)} 应当被拒`);
        assert.equal(body.code, "IDLE_VOLUME_INVALID", `${field}=${String(bad)} 的错误号应当是 IDLE_VOLUME_INVALID`);
      }
    }
  });

  test("③ 只改一条，另一条不能跟着动", async () => {
    await postSettings({ ambienceVolume: 20, songVolume: 90 });
    await postSettings({ ambienceVolume: 21 });
    const view = await getSettings();
    assert.equal(view.ambienceVolume, 21, "改的那条要变");
    assert.equal(view.songVolume, 90, "没提的那条必须原样留着");
  });

  test("④ 0 和 100 这两个端点要能用（不是半开半闭）", async () => {
    for (const [amb, song] of [[0, 100], [100, 0]]) {
      const res = await postSettings({ ambienceVolume: amb, songVolume: song });
      assert.equal(res.status, 200, `${amb}/${song} 应当合法`);
      const view = await getSettings();
      assert.equal(view.ambienceVolume, amb);
      assert.equal(view.songVolume, song);
    }
  });

  test("⑤ 不传这两个字段时不校验（别把别的表单一并挡了）", async () => {
    const res = await postSettings({ ambience: true });
    assert.equal(res.status, 200, "只改开关不该被音量校验拦住");
  });
});

// ---------------------------------------------- ⑥ 桌面层：点了播放，环境音要"马上"停

describe("桌面层『点了播放环境音立即停』（用户：我要马上消失）", () => {
  test("⑥ stage:changed 分支里 stopAmbience() 必须排在取素材之前，中间不许有 await", async () => {
    const wallpaper = stripComments(await read("app/public/wallpaper.html"));
    const branchAt = wallpaper.indexOf('d.stage === "changed"');
    assert.ok(branchAt > 0, "wallpaper.html 里找不到外壳换片消息的处理分支");

    // 取到这个分支结束（下一个 } 之前足够长的一段）
    const window = wallpaper.slice(branchAt, branchAt + 1200);
    const stopAt = window.indexOf("stopAmbience()");
    const tickAt = window.indexOf("tick()");
    assert.ok(stopAt > 0, "这个分支里没有 stopAmbience() —— 点播放后两种声音会叠着响");
    assert.ok(tickAt > 0, "这个分支里没有 tick() —— 那就永远取不到新素材");
    assert.ok(stopAt < tickAt, `必须先掐环境音再取素材：stopAmbience 在 ${stopAt}，tick 在 ${tickAt}`);

    // ★ 关键：两者之间一旦出现 await，前端浏览器 Computing... 
    //   掐音就会被排到网络回来之后，用户听到的仍是"两种声音叠着"。
    const between = window.slice(stopAt, tickAt);
    assert.doesNotMatch(between, /\bawait\b/u, "掐音与取素材之间不能有 await —— 有了就不是『立即』停");
  });

  test("⑦ stopAmbience 本体要既 pause 又把 src 摘掉（只 pause 会留着最后一个音的时间戳）", async () => {
    const wallpaper = await read("app/public/wallpaper.html");
    const at = wallpaper.indexOf("function stopAmbience()");
    assert.ok(at > 0, "找不到 stopAmbience 的定义");
    const body = wallpaper.slice(at, at + 400);
    assert.match(body, /\.pause\(\)/u, "要先暂停");
    assert.match(body, /removeAttribute\(\s*"src"\s*\)/u, "要把 src 摘掉 —— 光 pause 不算停");
  });
});

// ---------------------------------------------- ⑧ 搬家：错误号与 HTTP 状态要钉住

describe("搬家的错误出口", () => {
  test("⑧ 五处 return 的状态码与代号逐一对得上（改了状态会红，不会悄悄漂）", async () => {
    const src = await read("app/maintenance.mjs");
    // ★ 六个出口都要在表里 —— 少写一个就会因为"多了不相干的出口"而红，
    //   逼着改的人当场想清楚这个状态码该是多少，而不是随手加一行。
    const want = {
      COMMON_MIGRATE_SOURCE_REQUIRED: 400,
      COMMON_MIGRATE_SOURCE_NOT_DETECTED: 400,
      COMMON_MIGRATE_SOURCE_IS_CURRENT: 400,
      COMMON_MIGRATE_NOTHING_TO_COPY: 400,
      COMMON_MIGRATE_SOURCE_LOCKED: 409,
      // 这一个是"安排替换"那步本身炸了（写 pending-restore.json 失败之类），
      // 属于搬家流程的兜底出口，所以也算在这一组里。
      COMMON_INTERNAL: 500,
    };
    const got = {};
    for (const m of src.matchAll(/status:\s*(\d{3}),\s*code:\s*ERR\.([A-Z0-9_]+)/gu)) got[m[2]] = Number(m[1]);
    assert.deepEqual(got, want, "挪用状态的分支与期望不符 —— 错一位用户看到的错误号就变了");
  });

  test("⑨ 扫描只认含库文件的目录 ⇒ 直接决定了 NOTHING_TO_COPY 只能发生在竞态里", async () => {
    const { detectCandidates } = await import("../app/maintenance.mjs");
    const fakeRoot = await mkdtemp(join(tmpdir(), "linli-scan-"));
    const withDb = join(fakeRoot, "有库的那个");
    const emptyDir = join(fakeRoot, "空壳目录");
    await mkdir(withDb, { recursive: true });
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(withDb, "letters.sqlite"), Buffer.alloc(16, 1));
    // 空壳目录里放个别的文件，确保它不是因为"目录为空"被跳过的
    await writeFile(join(emptyDir, "readme.txt"), "nothing here");

    const { items } = await detectCandidates({ dataDir: join(fakeRoot, "current"), roots: [fakeRoot], roamingRoots: [] });
    const listed = items.map((i) => i.path);
    await cleanupDir(fakeRoot);

    assert.ok(listed.some((p) => resolve(p) === resolve(withDb)), "含库文件的目录必须被扫出来");
    assert.ok(!listed.some((p) => resolve(p) === resolve(emptyDir)), "没有库文件的目录不该进候选列表");
    assert.ok(items.every((i) => i.exists), "一旦进入候选就该带 exists —— 否则搬家那步会回 NOTHING_TO_COPY");
  });
});

// ---------------------------------------------- ⑩ 发布包：别把改动漏在包外

describe("发布包完整性（只在发包前当闸门跑）", () => {
  /**
   * ★ 为什么这条默认跳过：判据是「dist 里的副本与源码逐字节一致」。
   *   它在**发包那一刻**极其有用（改完忘了重新打包会立刻被抓出来），
   *   但日常改一行源码到重新打包之间必然是"不一致"的 —— 挂在每次 `node --test` 上，
   *   等于让基线在开发的每个下午都是红的，那种"天天红"的护栏很快就会被人注释掉。
   *   所以：日常跳过，发包时显式开 `LINLI_CHECK_DIST=1`。build.ps1 / 发版清单里应当这一句：
   *     $env:LINLI_CHECK_DIST=1; node --test --test-force-exit tests\*.test.js
   */
  test("⑩ dist/package/app 里的每个文件都要与源码一致（换行归一后比）", async (t) => {
    if (!process.env.LINLI_CHECK_DIST) {
      return t.skip("没设 LINLI_CHECK_DIST —— 日常跳过，发包前再设 1 跑一遍");
    }
    const distApp = join(ROOT, "dist", "package", "app");
    if (!await stat(distApp).then(() => true, () => false)) {
      return t.skip("没有 dist\\package\\app （干净仓库没打过包），无从比对");
    }

    const norm = (buf) => buf.toString("utf8").replace(/\r\n/gu, "\n");
    const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

    // ★ 2026-10-21 起有一条**故意**的不一致：app/harness/harness-manifest.json 不进包
    //   （build.ps1 组装完当场删掉它 —— 它是两端同步/审查留痕，带着姊妹项目名与审查
    //   编号，用户点名要剥的就是这类外溢）。所以它出现在 missing 里是预期行为；
    //   但反向也钉死：它**不许**出现在包里（出现了 = build.ps1 的排除被绕过）。
    const NOT_SHIPPED = ["harness/harness-manifest.json"];

    const walk = async (dir) => {
      const out = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(abs)));
        else out.push(abs);
      }
      return out;
    };
    const srcAll = await walk(join(ROOT, "app"));
    const dstAll = await walk(distApp);
    const relOf = (p, root_) => relative(root_, p).split(sep).join("/");

    const dstSet = new Set(dstAll.map((p) => relOf(p, distApp)));
    const missing = srcAll.map((p) => relOf(p, join(ROOT, "app")))
      .filter((r) => !dstSet.has(r) && !NOT_SHIPPED.includes(r));
    assert.deepEqual(missing, [], `这些源码文件没被打包进去：${missing.slice(0, 8).join("、")}`);
    for (const rel of NOT_SHIPPED) {
      assert.ok(!dstSet.has(rel), `${rel} 不该随包（build.ps1 应当已删掉它）—— 出现在包里说明排除被绕过了`);
    }
    const srcSet = new Set(srcAll.map((p) => relOf(p, join(ROOT, "app"))));
    const extra = dstAll.map((p) => relOf(p, distApp)).filter((r) => !srcSet.has(r));
    assert.deepEqual(extra, [], `包里多出这些源码里没有的文件：${extra.slice(0, 8).join("、")}`);

    const byRel = new Map(dstAll.map((p) => [relOf(p, distApp), p]));
    const mismatched = [];
    for (const srcPath of srcAll) {
      const rel = relOf(srcPath, join(ROOT, "app"));
      const dstPath = byRel.get(rel);
      if (!dstPath) continue;
      if (sha(norm(await readFile(srcPath))) !== sha(norm(await readFile(dstPath)))) mismatched.push(rel);
    }
    assert.deepEqual(mismatched, [], `包里这几份与源码已经不是一回事（八成是改完忘了重新打包）：${mismatched.slice(0, 8).join("、")}`);
  });
});

// ---------------------------------------------- ⑪ 维护接口的令牌闸必须还在最前面

test("⑪ /api/maintenance/ 一进门就是令牌检查（挪到后面就等于把库交出去）", async () => {
  const server = await read("app/server.mjs");
  const at = server.indexOf('path.startsWith("/api/maintenance/")');
  assert.ok(at > 0, "server.mjs 里找不到维护接口的路由入口");
  const after_ = server.slice(at, at + 400);
  const tokenCheck = after_.indexOf("tokenOk(req)");
  const branches = [
    after_.indexOf('path === "/api/maintenance/migrate"'),
    after_.indexOf('path === "/api/maintenance/diagnostic"'),
    after_.indexOf('path === "/api/maintenance/feedback"'),
  ].filter((i) => i > 0);
  assert.ok(tokenCheck > 0, "维护接口那段没有令牌检查");
  for (const i of branches) {
    assert.ok(tokenCheck < i, `令牌检查必须在所有具体分支之前（某个分支在 ${i}，令牌在 ${tokenCheck}）`);
  }
});

// ---------------------------------------------- ⑫ 打包脚本删包内文件不许用 Remove-Item

test("⑫ build.ps1 里不许有 Remove-Item（外层删除护栏在后台任务里 fail-closed，会炸构建）", async () => {
  // ★ 2026-10-21 实测事故：排除 harness-manifest.json 那行用了 Remove-Item ⇒ 外层删除
  //   护栏去调 genie-trash（回收站程序），后台 PowerShell 任务里它不可达 ⇒
  //   SAFE_DELETE_FAIL_CLOSED 直接把构建炸在组装 package 那一步。脚本自己 line 64
  //   早就写明「用 .NET 直接删，不用 Remove-Item」，只是漏了后面新增的那处同类位置。
  // ★ 必须剥 `#` 行注释：build.ps1 的注释里**就写着 Remove-Item 这四个字**（记录的就是
  //   这条规矩本身），不剥的话护栏会被自己的说明文字假红 —— 跟 stripComments 的同一个坑。
  const raw = await read("build.ps1");
  const code = raw.replace(/^\s*#[^\n]*/gmu, " ");
  const rmLines = code.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => l.includes("Remove-Item"));
  assert.deepEqual(rmLines.map(([n]) => n), [], `build.ps1 里还有 Remove-Item 命令（删包内/临时文件一律用 [System.IO.File]::Delete / [System.IO.Directory]::Delete）：\n  ${rmLines.map(([n, l]) => `${n}: ${l.trim()}`).join("\n  ")}`);
  assert.ok(code.includes("[System.IO.File]::Delete($manifestInPkg)"),
    "排除 harness-manifest.json 必须走 [System.IO.File]::Delete($manifestInPkg) —— 换回 Remove-Item 就是在后台构建里埋雷");
});

test("⑬ build.ps1 读 json 必须显式 -Encoding UTF8（5.1 默认 ANSI 会把无 BOM 的 UTF-8 读成乱码）", async () => {
  // ★ 2026-10-21 实测事故：封面护栏挂在 `Get-Content … -Raw | ConvertFrom-Json` 上，
  //   ArgumentException + 输出一堆乱码。根因：build.ps1 头部文档的用法就是
  //   `powershell -File build.ps1` = **Windows PowerShell 5.1**，而 5.1 的 Get-Content
  //   不指定 -Encoding 时按 ANSI（本机 GB18030）读；两份 json 都是无 BOM 的 UTF-8
  //   （covers-meta.json 中文曲名；自检 json 见 Program.cs:134 `new UTF8Encoding(false)`）
  //   ⇒ 中文全变乱码，ConvertFrom-Json 直接炸。（PowerShell 7 宿主里默认就是 UTF-8，
  //   所以在 7 里手动跑构建一直是好的 —— 病只藏在脚本自己文档的那条用法上。）
  //   自检 json 那处（line 54）同病同治：它只拿正则匹配 ASCII 子串所以没炸，属于侥幸。
  const raw = await read("build.ps1");
  const code = raw.replace(/^\s*#[^\n]*/gmu, " ");
  const badReads = code.split(/\r?\n/).map((l, i) => [i + 1, l])
    .filter(([, l]) => /Get-Content\b[^\n|]*-Raw/u.test(l) && !/-Encoding\s/u.test(l));
  assert.deepEqual(badReads.map(([n]) => n), [],
    `这些 Get-Content -Raw 没带 -Encoding（5.1 下会按 ANSI 读出乱码）：\n  ${badReads.map(([n, l]) => `${n}: ${l.trim()}`).join("\n  ")}`);

  // 动态半边：把 build.ps1 里读 covers-meta.json 的那一行**原样**抠出来，丢给 5.1
  // 引擎（powershell.exe）真跑 —— 静态钉住"写了 -Encoding"，动态证明"写对了"。
  // 变异反证：把那行的 -Encoding UTF8 删掉 ⇒ 5.1 下 ConvertFrom-Json 炸 ⇒ 本测试红。
  const readLine = code.split(/\r?\n/).find((l) => l.startsWith("$coverMetaObj = Get-Content"));
  assert.ok(readLine, "build.ps1 里找不到 $coverMetaObj = Get-Content 那行（护栏的被测对象没了）");
  const metaPath = join(ROOT, "app", "covers-meta.json").replace(/\\/gu, "\\\\");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$coverMetaSrc = '${metaPath}'`,
    readLine.trim(),
    "@($coverMetaObj.PSObject.Properties.Name).Count",
  ].join("\n");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script],
    { encoding: "utf8", timeout: 60_000 });
  const metaCount = Number(out.trim());
  const jpgs = (await readdir(join(ROOT, "app", "covers"))).filter((f) => f.endsWith(".jpg"));
  assert.ok(Number.isInteger(metaCount) && metaCount > 0,
    `5.1 引擎没能解出 covers-meta.json 的条目数（输出：${JSON.stringify(out)}）—— -Encoding 写错了？`);
  assert.equal(metaCount, jpgs.length,
    `covers-meta.json 条目数 ${metaCount} 与 app/covers 下 jpg 数 ${jpgs.length} 不一致`);
});
