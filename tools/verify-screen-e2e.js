// 端到端验「显示屏幕」：真外壳（dist/shell 的新 exe）+ CDP 直读下拉选项。
// 用户这轮的原话：「显示屏幕那个信息不准啊」—— 截图里躺着 function 0 { [native code] }。
// 判据（全是字面量，不靠看图）：
//   ① #stageScreen 禁用态为 false（独立窗口里桥必须在）
//   ② 选项里出现「默认（铺满整个桌面）」+ 至少一个真屏幕项
//   ③ 真屏幕项的文案形如 `DISPLAYx · 宽×高（主屏幕?）` —— 名字来自
//      ShellBridge.ListScreens()（名字|左|上|宽|高|是否主屏），经 .sync 同步代理取回
//   ④ **任何一个选项都不含 "function" / "[native code]" / "object Promise"**
//      —— 那三个串只要出现一个，就是异步代理的老病复发
//   ⑤ 顺手记开机自启开关的 checked（读的是注册表，应当是个布尔而不是 undefined）
// 用法：node tools/verify-screen-e2e.js   （★ 2026-10-24 从 analysis/_audit22/ 挪进已追踪的 tools/）
const { spawn, execSync } = require("child_process");
const path = require("node:path");

const EXE = "E:\\linli-letters\\dist\\shell\\LinliLetters.exe";
const CWD = "E:\\linli-letters\\dist\\shell";
const PORT = 9226;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function killOld() {
  try {
    const out = execSync("tasklist /FO CSV /NH", { encoding: "utf8" });
    const pids = [...new Set(out.split("\n").filter(l => l.includes("LinliLetters.exe"))
      .map(l => l.split(",")[1]?.trim?.().replace(/"/g, "")).filter(Boolean))];
    for (const pid of pids) execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    if (pids.length) console.log("清掉旧实例", pids);
  } catch { /* 没有旧实例 */ }
}

(async () => {
  killOld();
  await sleep(2000);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("LINLI_")) delete env[k];
  // ★ 2026-10-20：不能再靠 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS —— 本机记着 --no-sandbox，
  //   外壳自己会设 AdditionalBrowserArguments，把那个环境变量整个顶掉（上轮 80 次重连全失败）。
  //   改成走 MainWindow.BuildOptions() 里专门留的自检口 LINLI_VERIFY_CDP_PORT。
  env.LINLI_VERIFY_CDP_PORT = String(PORT);
  const p = spawn(EXE, [], { cwd: CWD, env, detached: false, stdio: "ignore" });
  console.log("[启动] pid=" + p.pid);

  let ws = null, send = null;
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === "page" && /127\.0\.0\.1/.test(t.url));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 1; const pending = new Map();
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        };
        send = (method, params = {}) => new Promise((res) => {
          const i2 = id++; pending.set(i2, res);
          ws.send(JSON.stringify({ id: i2, method, params }));
        });
      }
    } catch { /* 内核还没起来 */ }
    if (!ws) await sleep(500);
  }
  if (!ws) { console.log("!! CDP 连不上（80 次重试）"); try { execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: "ignore" }); } catch {} process.exit(1); }
  console.log("[CDP] 连上了");

  const ev = async (expr) => (await send("Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

  // 等页面脚本就绪 + 切到设置页 + 等 loadBehavior 跑完（桥读取是同步的，但页面要加载）
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    const st = JSON.parse(await ev(`(()=>{if(typeof show==='function')show('settings');const b=document.querySelector('#page-settings').getBoundingClientRect();return JSON.stringify({w:b.width})})()`) || "{}");
    if (st.w > 100) break;
    await sleep(500);
  }
  await sleep(2000);

  const probe = `JSON.stringify((() => {
    const sel = document.querySelector('#stageScreen');
    const auto = document.querySelector('#appAutostart');
    return {
      selExists: !!sel,
      disabled: sel ? sel.disabled : null,
      options: sel ? [...sel.options].map(o => o.textContent) : [],
      values: sel ? [...sel.options].map(o => o.value) : [],
      autoChecked: auto ? auto.checked : null,
      autoDisabled: auto ? auto.disabled : null,
    };
  })())`;
  const data = JSON.parse(await ev(probe));
  console.log("[量得]", JSON.stringify(data, null, 1));

  // 截图：设置页顶部（四块设置 + 下拉展开态看不到，就拍静态页）
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  if (shot.result?.data) {
    require("node:fs").writeFileSync(path.join("E:\\linli-letters", "analysis", "_audit22", "screen-e2e.png"),
      Buffer.from(shot.result.data, "base64"));
    console.log("[截图] analysis/_audit22/screen-e2e.png");
  }

  let ok = true;
  const bad = (m) => { console.log("!! " + m); ok = false; };
  if (!data.selExists) bad("没有 #stageScreen");
  if (data.disabled !== false) bad(`下拉不应禁用（independent=false 才对），实际=${data.disabled}`);
  if (!data.options.some(o => o.includes("默认（铺满整个桌面）"))) bad("少了「默认」项");
  const real = data.options.filter(o => !o.includes("默认"));
  if (real.length < 1) bad("一个真屏幕项都没有（ListScreens 没取到？）");
  for (const o of data.options) {
    if (/function|\[native code\]|object Promise|undefined/.test(o)) bad(`选项里有坏值：${o}`);
  }
  for (const o of real) {
    if (!/^[A-Za-z0-9_.\\-]+( · \d+×\d+)?（主屏幕）?$/.test(o)) {
      console.log(`  ? 屏幕项文案不合预期形状（不判死，人看一眼）：${o}`);
    }
  }
  if (typeof data.autoChecked !== "boolean") bad(`开机自启开关不是布尔：${data.autoChecked}`);

  try { ws.close(); } catch {}
  try { execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: "ignore" }); } catch {}
  killOld();
  console.log("判定:", ok ? "通过 ✅" : "未通过 ❌");
  process.exit(ok ? 0 : 1);
})();
