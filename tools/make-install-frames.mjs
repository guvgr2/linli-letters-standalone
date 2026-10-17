/**
 * make-install-frames.mjs —— 把 design-preview.html 第 ① 节的纸质安装动画
 * 渲成 Inno 向导动画用的逐帧 PNG。
 *
 * 用法：
 *   node tools/make-install-frames.mjs                 渲全部 48 帧
 *   node tools/make-install-frames.mjs --only=0,20,40  只渲这几帧（调试用）
 *   node tools/make-install-frames.mjs --out=dir       改输出目录
 *
 * 为什么这么写（三条硬的）：
 *   1. 帧尺寸 = 656×1256。install.iss 的 WizardImageFile 规格是严格 164:314（4 倍 = 656×1256），
 *      WizardImageBackColor=#16141A ⇒ 舞台外面那圈底色也必须写成 #16141A，否则画框四周露别的颜色。
 *   2. p 不按进度均匀采样，按**时间**均匀采样。动画内部 KF = [[0,0],[56,3400],[64,4900],[100,7500]]：
 *      拆信 0..56 走 3400ms、折飞机 56..64 走 1500ms、放飞 64..100 走 2600ms。
 *      按进度均匀采样会让拆信那一段被压扁，肉眼看的速度跟 GIF 对不上。
 *   3. 每帧调 atProgress(p) 之后要**等一个帧间隔**再截图 —— 信纸上的墨是 CSS transition
 *      写出来的（.sheet .line 的 .52s），等 0ms 截图的话墨永远停在 0%，等太久又变成"啪"地整行出现。
 *      等一个真实帧间隔，transition 才走到它在真实播放里该在的位置。
 *
 * 独立性：本机 27161（验收服务）与 9333（另一份 CDP）都不碰；
 *   这份脚本只用自己的 9411 和自己的 user-data-dir，也不 kill 任何进程。
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = 'C:\\Users\\guvgr\\AppData\\Local\\Temp\\linli-frame-profile';
const PORT = 9411;
const PAGE_URL = 'file:///E:/linli-letters/design-preview.html';

// 帧画幅：164:314 的 4 倍
const W = 656;
const H = 1256;
// 动画舞台的基准尺寸（design-preview.html 里 .envStage = 200×300）
const SW = 200;
const SH = 300;

// 动画的 KF 常量（design-preview.html 第 903 行），总长 7500ms
const KF = [[0, 0], [56, 3400], [64, 4900], [100, 7500]];
const TOTAL_MS = KF[KF.length - 1][1];
const FRAMES = 48;

const OUT_DIR = resolve(getArg('out', 'E:/linli-letters/installer/frames'));
const only = args.includes('--only')
  ? getArg('only', '')
  : null;
const indices = only
  ? only.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
  : Array.from({ length: FRAMES }, (_, i) => i);

// 时间 → 总进度 p（与 design-preview.html 里 runInstall 的 step() 同一套插值）
function pAtTime(t) {
  for (let i = 0; i < KF.length - 1; i++) {
    const [p0, t0] = KF[i];
    const [p1, t1] = KF[i + 1];
    if (t <= t1) return p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
  }
  return 100;
}
// 第 i 帧的时刻：0..7500ms 均匀切 48 份（首帧 t=0，末帧 t=7500 ⇒ p 正好 0..100）
const tOfFrame = (i) => (TOTAL_MS * i) / (FRAMES - 1);
const DT = TOTAL_MS / (FRAMES - 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 体积控制：Pillow 调色板量化 ----------------
// 本机 Pillow 只在这个解释器里（别的 python 没装）。
// 256 色 + 不抖动：实测单帧 ~46KB（原图 ~130KB），48 帧总共 ~2.2MB，卡在 4MB 以内；
// 再抖动只会更大，再减色会开始在信封的渐变上出色带。
const PY = 'C:\\Users\\guvgr\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const QUANT_COLORS = 256;

function quantizeFrames() {
  const script = `
import glob, os, sys
from PIL import Image
total = 0
files = sorted(glob.glob(os.path.join(sys.argv[1], "frame-*.png")))
for p in files:
    im = Image.open(p).convert("RGB")
    q = im.quantize(colors=${QUANT_COLORS}, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    q.save(p, optimize=True)
    total += os.path.getsize(p)
print(f"{len(files)} frames, {total} bytes total, {total/1024/1024:.2f} MB")
`;
  const r = spawnSync(PY, ['-c', script, OUT_DIR], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Pillow 量化失败：' + (r.stderr || r.stdout));
  process.stdout.write('[frames] 量化后：' + (r.stdout || '').trim() + '\n');
}

// ---------------- 极简 CDP 客户端（Node 22 自带全局 WebSocket，不装任何依赖）----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.method || msg.id}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

function waitForPort() {
  const deadline = Date.now() + 30000;
  return (async function poll() {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (res.ok) return await res.json();
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) throw new Error('Edge 的 CDP 端口 9411 一直没起来');
      await sleep(300);
    }
  })();
}

// ---------------- 舞台装配：只留动画，舞台外一律不进画 ----------------
function stageSetupScript() {
  const S = W / SW;                       // 3.28
  const contentOffset = 4 * S;            // 舞台内容占 y=8..300，重心比盒子中心低 4px ⇒ 整体上提
  const top = Math.round((H - SH * S) / 2 - contentOffset);
  return `(function(){
    var S = ${S}, top = ${top};
    var scaleNode = document.querySelector('.stageScale');
    if (!scaleNode) throw new Error('找不到 .stageScale');
    var root = document.createElement('div');
    root.id = 'frameroot';
    root.style.cssText = 'position:fixed;left:0;top:0;width:${W}px;height:${H}px;' +
      'background:#16141A;overflow:hidden;z-index:2147483647';
    document.body.appendChild(root);
    root.appendChild(scaleNode);
    scaleNode.style.cssText = 'position:absolute!important;left:0;top:' + top + 'px;width:0;height:0;margin:0;padding:0';
    var st = document.createElement('style');
    st.textContent = '.envStage{transform:scale(' + S + ')!important;transform-origin:top left!important}' +
      'html,body{margin:0!important;padding:0!important;background:#16141A!important;overflow:hidden!important}';
    document.head.appendChild(st);
    Array.prototype.forEach.call(document.body.children, function(el){
      if (el !== root) el.style.setProperty('display', 'none', 'important');
    });
    // 关掉页面自带的播放循环：后面每一帧由本脚本亲自调 atProgress
    try { cancelAnimationFrame(raf); } catch (e) {}
    return { scale: S, top: top, hasAtProgress: typeof atProgress === 'function' };
  })()`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // --quantize-only：只对已渲好的帧做体积压缩，不重渲（渲一遍要好几十秒）
  if (args.includes('--quantize-only')) {
    quantizeFrames();
    return;
  }

  console.log(`[frames] 启动无头 Edge（端口 ${PORT}，独立 profile）…`);
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    '--disable-extensions',
    '--mute-audio',
    PAGE_URL,
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForPort();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) throw new Error('没拿到 page 目标的 ws 地址');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    cdp = new CDP(ws);
    console.log('[frames] CDP 已连上');

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: PAGE_URL });

    // 等页面真正就绪（脚本跑完、atProgress 可用）
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await sleep(200);
      ready = await cdp.eval(
        "document.readyState === 'complete' && typeof atProgress === 'function'"
      ).catch(() => false);
    }
    if (!ready) throw new Error('页面一直没就绪');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    const setup = await cdp.eval(stageSetupScript());
    console.log(`[frames] 舞台就位：scale=${setup.scale} top=${setup.top}px（画幅 ${W}×${H}）`);

    let lastCaptureMs = 0;
    let done = 0;
    for (const i of indices) {
      const t = tOfFrame(i);
      const p = pAtTime(t);
      await cdp.eval(`atProgress(${p.toFixed(4)})`);
      // 首帧多给一点时间，让页面自己播到一半时被我们拽回 p=0 的那些 transition 收干净
      const wait = i === 0 ? 900 : Math.max(20, Math.round(DT - lastCaptureMs));
      await sleep(wait);

      const t0 = Date.now();
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
        captureBeyondViewport: false,
      }, 60000);
      lastCaptureMs = Date.now() - t0;

      const name = `frame-${String(i).padStart(2, '0')}.png`;
      writeFileSync(join(OUT_DIR, name), Buffer.from(shot.data, 'base64'));
      done++;
      process.stdout.write(`\r[frames] ${done}/${indices.length}  最新：${name}  t=${t.toFixed(0)}ms p=${p.toFixed(2)}`);
    }
    console.log(`\n[frames] 完成，输出目录 ${OUT_DIR}`);
    quantizeFrames();
    reportTotal();
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {});
    // 只收我们自己起的那个进程；超时才兜底 kill，绝不碰别的 msedge/node
    const exited = await new Promise((r) => {
      const timer = setTimeout(() => r(false), 6000);
      edge.once('exit', () => { clearTimeout(timer); r(true); });
    });
    if (!exited) edge.kill();
  }
}

function reportTotal() {
  const files = readdirSync(OUT_DIR).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
  let total = 0;
  let dims = '';
  for (const f of files) {
    total += statSync(join(OUT_DIR, f)).size;
    if (!dims) dims = pngSize(join(OUT_DIR, f));
  }
  console.log(`[frames] 汇总：${files.length} 帧，尺寸 ${dims}，总 ${total} 字节（${(total / 1024 / 1024).toFixed(2)} MB）`);
}
// 读 PNG 宽高（IHDR 在固定偏移，不用引依赖）
function pngSize(p) {
  const buf = Buffer.alloc(24);
  const fd = openSync(p, 'r');
  readSync(fd, buf, 0, 24, 0);
  closeSync(fd);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

main().catch((e) => {
  console.error('[frames] 失败：', e);
  process.exit(1);
});
