/**
 * 「WebView2 起不来」这三档兜底的护栏（第十六轮审查 §5 的唯一无证据项）。
 *
 * 为什么需要它：正常机器上 WebView2 永远起得来，于是
 *   ① 退回系统浏览器 ② 再重建一次 ③ 次数用尽给一句人话
 * 这三档在真机上根本不会触发，测试也进不去 —— 我最初只写了 `dotnet build` 就说"修好了"，
 * 审查方指出这是四条 P1 里唯一没有任何验证的一项。
 *
 * 现在分两层给它证据（都跑**真正发布出去的那个 exe**，不是源码）：
 *   ① `--check-recovery <文件>`：把重建次数 0/1/2/3/4 与一个负数逐个算一遍，写 JSON。
 *      这是纯函数 `WebRecovery.Decide()` 的决策表，边界（0 次 = 退浏览器、用尽 = 死路）都在里面。
 *   ② `LINLI_FORCE_WEBVIEW_FAIL=1` 真跑一遍：在建内核之前强制抛异常，让三档按顺序
 *      真的走一遍（fallback-browser → rebuild → rebuild → dead-end），每一步落 shell.log。
 *      自检模式会跳过浏览器外链与弹窗，走完自己退出。
 *
 * 跑法：node --test --test-force-exit tests\shell-recovery.test.js
 * 需要 dist\shell\LinliLetters.exe（build.ps1 的产物）；没有就跳过并说明原因，
 * 不假装通过 —— 这条用例的价值全在"跑的是真 exe"。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXE = join(ROOT, "dist", "shell", "LinliLetters.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 外壳的出事日志默认落在 %APPDATA%\LinliLetters\shell.log（不认 LINLI_DATA_DIR）。
 *  ★ 2026-10-20：但可以用 LINLI_SHELL_LOG 把它指到别处 —— 本用例就指到自己的临时目录。
 *    为什么必须这样：两路全量并行时，两边都往**同一个** %APPDATA% 里的 shell.log 写，
 *    读的时候又都是 `slice(之前的长度)` ⇒ 一路可能把另一路的日志当成自己的证据（假绿），
 *    先后顺序也不定（假红）。60 分钟压测里实测到 2/42 次红（`fails/r1b-…`）。 */
const DEFAULT_SHELL_LOG = join(process.env.APPDATA ?? "", "LinliLetters", "shell.log");

describe("WebView2 起不来时的三档处置", () => {
  test("① --check-recovery：决策表在打包 exe 上算得对（0 次退浏览器 / 用尽进死路）", async (t) => {
    if (!existsSync(EXE)) {
      t.skip(`没有 ${EXE}（先跑 build.ps1）—— 这条用例的价值就是"验真 exe"，不拿源码顶替`);
      return;
    }
    const out = join(await mkdtemp(join(tmpdir(), "linli-rec-")), "recovery.json");
    const run = spawnSync(EXE, ["--check-recovery", out], { timeout: 60000, windowsHide: true });
    assert.equal(run.status, 0, `自检退出码应为 0（sane=true），实际 ${run.status}`);

    const data = JSON.parse(await readFile(out, "utf8"));
    assert.equal(data.sane, true, "exe 自己都说决策表不自洽");
    assert.equal(data.maxRebuilds, 3);
    // ★ 2026-10-19 事故回归：`[STAThread]` 被插进来的方法挤到别的方法上 ⇒ Main 变 MTA ⇒
    //   WinForms + WebView2 全部起不来（RPC_E_CHANGED_MODE 0x80010106），而编译、运行、
    //   其它测试全都正常。这一项直接量 Main 线程的套间，是那次事故唯一不会骗人的证据。
    assert.equal(data.apartment, "STA", "Main 线程必须是 STA —— 否则 WebView2 根本起不来");

    const by = new Map(data.decisions.map((d) => [d.rebuilds, d.action]));
    assert.equal(by.get(0), "fallback-browser", "第一次失败必须退回系统浏览器（不能让用户盯黑屏）");
    assert.equal(by.get(1), "rebuild", "还有余量就重建");
    assert.equal(by.get(2), "rebuild", "余量没到上限都算重建");
    assert.equal(by.get(3), "dead-end", "用尽必须给一句人话 + 一条出路");
    assert.equal(by.get(4), "dead-end", "超上限也只能是死路，不许继续重试");
    assert.equal(by.get(-1), "fallback-browser", "坏入参（负数）按「还没重建过」处理");
    await cleanupDir(dirname(out)).catch(() => {});
  });

  test("② LINLI_FORCE_WEBVIEW_FAIL=1：三档在真 exe 里按顺序各走一次，且走到死路", async (t) => {
    if (!existsSync(EXE)) {
      t.skip(`没有 ${EXE}（先跑 build.ps1）`);
      return;
    }
    const dataDir = await mkdtemp(join(tmpdir(), "linli-force-"));
    // ★ 2026-10-20：日志指到**这一轮自己的**文件上（LINLI_SHELL_LOG）——
    //   以前读的是全局 %APPDATA%\LinliLetters\shell.log，两路并行时互相串证据（假绿/假红）。
    const shellLog = join(dataDir, "shell.log");

    const child = spawn(EXE, [], {
      env: {
        ...process.env,
        LINLI_FORCE_WEBVIEW_FAIL: "1",
        // ★ 两个开关是分开的：FORCE 只负责"假装内核起不来"，CHAIN 才负责"把三档推下去"。
        //   只设 FORCE 得到的就是真用户走第一档的状态（对照组，见 §17.7 的 RPC_E_CHANGED_MODE 判别）。
        LINLI_SELF_CHECK_CHAIN: "1",
        // ★ 互斥量必须**每次跑都不一样**：这是 2026-10-19 那 25% 间歇红的根因。
        //   上一轮如果留下一个没退干净的 LinliLetters（自检超时、或我手动双击过），
        //   它握着同名互斥量，下一轮 spawn 出来的进程会「单实例」直接退出 ⇒ 日志里
        //   没有三档记录 ⇒ 这条用例红，而且只在连跑时出现、单跑永远绿。
        LINLI_MUTEX: `LinliRecoverySelfCheck-${process.pid}-${Date.now()}`,
        LINLI_DATA_DIR: dataDir,
        LINLI_SHELL_LOG: shellLog,
        LINLI_DEBUG_MSG: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });

    // ★ 2026-10-20：不再死等 60 秒。
    //   以前是 `Promise.race([进程退出, sleep(60000)])` —— 机器繁忙时三档走不完 60 秒就判红
    //   （实测 duration 60066ms，60 分钟压测里 2/42 次红）。
    //   现在改成**轮询日志里的收尾标记**「[自检] 三档全部走完」：见到就说明三档走完了。
    //   总上限 180 秒。
    //   ★★ 而且**进程退出之后还要继续等**：实测外壳退出后，日志文件还要过约 1.2 秒才补齐
    //   （第一次读到只有 165 字节，进程退出时是 1503 字节）——
    //   所以"看到 exit 就去读日志"会读到半截，判据就成了"卡在某一档"。
    const CHAIN_DONE = "[自检] 三档全部走完";
    const HARD_LIMIT_MS = 180000;
    const started = Date.now();
    let exited = false;
    let chainDone = false;
    child.once("exit", () => { exited = true; });
    const readLog = async () => (existsSync(shellLog) ? await readFile(shellLog, "utf8") : "");
    while (Date.now() - started < HARD_LIMIT_MS && !exited) {
      if ((await readLog()).includes(CHAIN_DONE)) { chainDone = true; break; }
      await sleep(300);
    }
    if (!chainDone) {
      // 进程已经退出（或到上限）⇒ 再给文件 20 秒补齐，别在半截日志上判刑。
      const giveUp = Date.now() + 20000;
      while (Date.now() < giveUp) {
        if ((await readLog()).includes(CHAIN_DONE)) { chainDone = true; break; }
        if (exited && Date.now() > giveUp - 18000) await sleep(500);
        else await sleep(300);
      }
    }
    if (chainDone && !exited) {
      const giveUp = Date.now() + 20000;
      while (!exited && Date.now() < giveUp) await sleep(200);
    }
    // ★ 无论走没走完都要确认进程已经没了：留一个活着的实例会**锁住 dist\shell\LinliLetters.exe**，
    //   下一次 build.ps1 删不掉发布目录、旧 exe 被原样打进安装包（2026-10-19 真实事故）。
    if (!exited) {
      try { child.kill(); } catch { /* 已经退了 */ }
    }
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      const timer = setTimeout(r, 3000);
      child.once("exit", () => { clearTimeout(timer); r(); });
    });
    const added = existsSync(shellLog) ? await readFile(shellLog, "utf8") : "";
    await cleanupDir(dataDir).catch(() => {});

    // 日志必须包含三档各自的决策字样，且顺序正确。
    const fallbackAt = added.indexOf("⇒ fallback-browser");
    const rebuildAt = added.indexOf("⇒ rebuild");
    const deadEndAt = added.indexOf("⇒ dead-end");
    assert.ok(fallbackAt >= 0, `没有走到第一档（退回浏览器）。日志：\n${added}`);
    assert.ok(rebuildAt > fallbackAt, "第二档（重建）没有在第一档之后出现");
    assert.ok(deadEndAt > rebuildAt, "第三档（死路）没有在重建之后出现");
    assert.ok(added.includes("进入死路界面"), "走到死路却没写那句给人看的话");
    assert.ok(chainDone, `自检链没有收尾（可能卡在某一档）。日志：\n${added}`);
    assert.ok(exited, "自检应该自己退出，实际还活着（会留一个挂在托盘的进程）");
  });

  test("③ 外壳支持把出事日志指到别处（LINLI_SHELL_LOG），默认路径不变", async (t) => {
    // 这是上面 ② 能隔离的前提：**产品**得支持这个开关，不能只在测试里造假。
    const src = await readFile(join(ROOT, "src", "LinliShell", "Dbg.cs"), "utf8");
    assert.match(src, /LINLI_SHELL_LOG/u, "Dbg.cs 里没有 LINLI_SHELL_LOG 这个开关");
    // ★ 只查"出现过这个字样"是**不够**的 —— 把接线改成 `if (false) return custom;`
    //   那个字样照样在，断言照样绿（实测：这样改一下，判据纹丝不动）。
    //   所以这里要查**接线本身**：环境变量非空时必须真的用它。
    assert.match(src, /if \(!string\.IsNullOrWhiteSpace\(custom\)\) return custom;/u,
      "LINLI_SHELL_LOG 读出来了却没被用（接线被改成永远不走这条路）");
    assert.match(src, /Path\.Combine\(App\.DataDir, "shell\.log"\)/u,
      "默认路径必须仍然是数据目录里的 shell.log（用户现场那一份不能被改掉）");
    // 默认路径仍然是「用户的 %APPDATA%\LinliLetters\shell.log」，不是别的地方。
    assert.equal(DEFAULT_SHELL_LOG, join(process.env.APPDATA ?? "", "LinliLetters", "shell.log"),
      "默认出事日志路径变了 —— 用户现场那份日志会跑到别处去");

    // ★★ 还要**真机验一次**：把日志指到临时文件，跑一次真 exe，那个文件里必须有内容。
    //   静态断言证明不了"exe 里也有这个功能" —— 源码改了但没重新 publish，exe 还是旧的。
    if (!existsSync(EXE)) {
      t.skip(`没有 ${EXE}（先跑 build.ps1）`);
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "linli-logredir-"));
    const target = join(dir, "own-shell.log");
    const child = spawn(EXE, [], {
      env: {
        ...process.env,
        LINLI_FORCE_WEBVIEW_FAIL: "1",
        LINLI_SELF_CHECK_CHAIN: "1",
        LINLI_MUTEX: `LinliLogRedirect-${process.pid}-${Date.now()}`,
        LINLI_DATA_DIR: join(dir, "data"),
        LINLI_SHELL_LOG: target,
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const deadline = Date.now() + 60000;
    let text = "";
    while (Date.now() < deadline) {
      if (existsSync(target)) {
        text = await readFile(target, "utf8");
        if (text.includes("[自检] 三档全部走完")) break;
      }
      if (child.exitCode !== null) break;
      await sleep(300);
    }
    try { child.kill(); } catch { /* 已经退了 */ }
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      const timer = setTimeout(r, 3000);
      child.once("exit", () => { clearTimeout(timer); r(); });
    });
    await cleanupDir(dir).catch(() => {});
    assert.ok(text.includes("[自检] 三档全部走完"),
      `真 exe 没有把出事日志写到 LINLI_SHELL_LOG 指的地方（说明 exe 还是旧的，或开关没生效）：\n${text}`);
  });
});
