/**
 * 「进程出事分诊 + 重建预算」护栏（2026-10-19 第十九轮黑窗事故的修复钉子）。
 *
 * 事故回顾：三层界面原来把 ProcessFailed 处理成「渲染进程就 Reload，其余一律换控件重建」，
 * 而 WebView2 会自己重启 GPU / Utility 进程 —— 宿主在崩溃回调里同步销毁重建必然失败
 * （实测 0x80070578 无效的窗口句柄），于是一次 GPU 抖动就在 4 秒内烧光额度、
 * 主窗口定格在一块纯黑上（用户亲眼截图证实）。
 *
 * 修复（全部钉死在这份测试里，改回去立刻红）：
 *   ① 真 exe 的自检输出里有分诊表：GPU/Utility ⇒ ignore、Render ⇒ reload、Browser ⇒ rebuild
 *   ② 三层的 OnProcessFailed 都必须走 WebTriage.Decide，不许自己拍脑袋
 *   ③ 重建必须有预算（滑动窗口 + 冷却），页面导航成功必须清零 —— 不许回到"终身累计"
 *   ④ 死路必须有「重试」按钮，不许只留一句话让用户自己悟
 *   ⑤ 真机行为：干净启动 45 秒，不许出现「进入死路界面」
 *
 * 跑法：node --test --test-force-exit tests/web-triage.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXE = join(ROOT, "dist", "shell", "LinliLetters.exe");
const SRC = {
  triage: join(ROOT, "src", "LinliShell", "WebTriage.cs"),
  main: join(ROOT, "src", "LinliShell", "MainWindow.cs"),
  wallpaper: join(ROOT, "src", "LinliShell", "WallpaperHost.cs"),
  // ★ 2026-10-20：dock 已移出 —— 圆钮改成纯 GDI+ 自绘，不再是 WebView2 宿主。
};
// ★ 2026-10-20：全局那份出事日志（%APPDATA%\LinliLetters\shell.log）**不再**被用例读 ——
//   并行时另一条用例会往同一份里写，读全局日志就等于读别人的证据（假绿/假红）。
//   现在每条用例都用自己的 LINLI_SHELL_LOG 文件（见下面 ②）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("内核进程出事的分诊与重建预算", () => {
  test("① 真 exe 自检输出：分诊表三档各就各位", (t) => {
    if (!existsSync(EXE)) {
      t.skip(`没有 ${EXE}（先跑 build.ps1）—— 这条用例的价值就是"验真 exe"`);
      return;
    }
    const out = join(ROOT, "analysis", "_audit19", `triage-${Date.now()}.json`);
    const run = spawnSync(EXE, ["--check-recovery", out], { timeout: 60000, windowsHide: true });
    assert.equal(run.status, 0, `自检退出码应为 0，实际 ${run.status}`);
    const data = JSON.parse(readFileSync(out, "utf8"));
    const by = new Map(data.triage.map((r) => [r.kind, r.action]));
    assert.equal(by.get("BrowserProcessExited"), "rebuild", "只有浏览器进程整个没了才允许换控件");
    assert.equal(by.get("RenderProcessExited"), "reload");
    assert.equal(by.get("RenderProcessUnresponsive"), "reload");
    assert.equal(by.get("UtilityProcessExited"), "ignore", "Utility 进程内核自己会重启，宿主插手就是黑窗事故本身");
    assert.equal(by.get("GpuProcessExited"), "ignore", "GPU 进程内核自己会重启，宿主插手就是黑窗事故本身");
  });

  test("② 分诊表不许给可自愈进程开 Rebuild 的口子（变异会红）", () => {
    const src = readFileSync(SRC.triage, "utf8");
    assert.match(src, /default:\s*return ProcessFailedAction\.Ignore/u,
      "default 必须落在 Ignore —— 新增的辅助进程种类默认都该是『放着不管』");
    assert.doesNotMatch(src, /case CoreWebView2ProcessFailedKind\.(?:GpuProcessExited|UtilityProcessExited2?)\s*:[^}]*Rebuild/u,
      "GPU/Utility 不许显式 case 成 Rebuild —— 2026-10-19 黑窗事故的根因");
  });

  for (const [name, file] of [["主窗口", SRC.main], ["壁纸层", SRC.wallpaper]]) {
    test(`② ${name} 的 OnProcessFailed 必须走 WebTriage.Decide`, () => {
      const src = readFileSync(file, "utf8");
      assert.match(src, /WebTriage\.Decide\(/u, "三层必须共用同一张分诊表");
      assert.match(src, /RebuildBudget/u, "重建必须有滑动窗口预算");
      // ★ 健康清零必须真的挂在导航完成回调里 —— NoteHealthy 在别处出现（比如重试按钮）
      //   抵消不了"终身累计"回归，所以判据要求两者相邻。
      assert.match(src, /NavigationCompleted[\s\S]{0,500}?NoteHealthy\(\)/u,
        "必须有『导航成功就清零』——不许回到终身累计");
      assert.match(src, /Task\.Delay\(/u, "重建必须延后 —— 崩溃回调里同步重建是 0x80070578 的直接来源");
      assert.match(src, /ReferenceEquals\(sender,\s*SafeCore\(\)\)/u,
        "必须过滤旧控件的遗言事件（control is disposed 的来源）");
      // ★ 崩溃风暴兜底：内核在这台机器上根本起不来时（60 秒内可自愈崩溃连发），
      //   必须有一个「退系统浏览器/撤掉本层」的出口，不许让用户守着黑窗口。
      assert.match(src, /NoteSelfHealing\(\)/u, "必须给可自愈崩溃记账（风暴检测的输入）");
      assert.match(src, /_selfHealHits\.RemoveAll/u, "风暴计数必须是滑动窗口，不是终身累计");
    });
  }

  test("③ 主窗口死路必须有「重试」按钮，且点它要清零预算", () => {
    const src = readFileSync(SRC.main, "utf8");
    // ★ 锚点用按钮本体的 Text，别用「重试」两个字 —— 那句话在死路文案里也出现，
    //   indexOf 会先撞上文案、离 NoteHealthy 超过阈值，判据就自己错了（第一版就这样红的）。
    const btnAt = src.indexOf('Text = "重试"');
    assert.ok(btnAt > 0, "死路画面上必须有一个能点的「重试」按钮");
    const noteAt = src.indexOf("NoteHealthy()", btnAt);
    assert.ok(noteAt > 0 && noteAt - btnAt < 2000, "点重试必须把预算清零，否则点了也白点");
  });

  test("④ 真机行为：干净启动 45 秒不许出现「进入死路界面」", async (t) => {
    if (!existsSync(EXE)) {
      t.skip(`没有 ${EXE}（先跑 build.ps1）`);
      return;
    }
    // 已经开着一只就跳过：那只实例握着互斥量，测出来的是"单实例"而不是启动行为
    // ★ tasklist 的 CSV 里进程名是 ASCII，latin1 解出来判就够（Node 的 Buffer 不认 gb18030）。
    const running = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true });
    if ((running.stdout ?? Buffer.alloc(0)).toString("latin1").includes('"LinliLetters.exe"')) {
      t.skip("已有一只 LinliLetters 在跑 —— 这条测的是用户双击的干净启动，不抢互斥量");
      return;
    }
    // ★ 2026-10-20：出事日志指到**这一轮自己的**临时文件（LINLI_SHELL_LOG）。
    //   以前读的是全局 %APPDATA%\LinliLetters\shell.log —— 并行时另一条用例
    //   （shell-recovery 的自检链）会把「进入死路界面」写进同一份日志，
    //   本用例那句 `!added.includes("进入死路界面")` 就会**被别人写的东西**打红。
    const ownLog = join(await mkdtemp(join(tmpdir(), "linli-triage-")), "shell.log");
    const ownDir = dirname(ownLog);
    const child = spawn(EXE, [], {
      env: { ...process.env, LINLI_SHELL_LOG: ownLog },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      windowsHide: true,
    });
    try {
      await sleep(45000);
    } finally {
      try { process.kill(-child.pid); } catch { /* 已经退了 */ }
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
    const added = existsSync(ownLog) ? readFileSync(ownLog, "utf8") : "";
    await cleanupDir(ownDir).catch(() => {});
    assert.ok(!added.includes("进入死路界面"),
      "干净启动不许走到死路 —— 崩溃可以发生（环境问题），但自愈必须兜得住");
    assert.ok(!added.includes("重建额度用完"),
      "45 秒内不该把重建额度烧光 —— 烧光说明还在把可自愈崩溃当致命伤");
  });
});
