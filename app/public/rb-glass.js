// 左栏圆钮真折射（C 组参数，用户 2026-10-17 拍板 "c"）。
//
// 为什么需要这一层：桌面壁纸视频（#stageVideo）被 .win 盖在底下，纯 CSS 对 .rb 施加
// filter 只能折射 .win 的压暗底、折不到视频。所以这里直接把视频帧按每个圆钮的屏幕位置
// 取样，再施加 feDisplacementMap 折射，画进浮在按钮正上方的 <canvas>。
//
// 几何与 2026-10-17 探针完全一致：视频 2560×1440，object-fit:contain 进窗口（本机
// 1280×800 ⇒ scale=min(1280/2560,800/1440)=0.5，垂直居中、上下各留 40px 黑边）。
// 位移图由几何算（glass-lens.mjs 的纯函数），不用噪声。

import { lensMapBytes } from "./glass-lens.mjs";

const RB = 46;            // .rb 的 CSS 宽高（styles.css 写死 46px）
const BEVEL = 6;          // 折光带宽度：46 直径的 13%（C 组）
const STRENGTH = 0.6;     // 位移图强度（配合下方 DISP_SCALE）
const DISP_SCALE = 26;     // feDisplacementMap scale（C 组）
const SS = 3;             // 画布放大倍数：46×3 = 138，边缘更脆
const PAD = 30;           // 取样外扩，防边缘被裁
const TINT = "rgba(18,18,20,0.38)";      // C 组暗色 tint（文字层优先于玻璃感）
const ON_TINT = "rgba(216,207,196,0.10)"; // 选中态叠一点暖色呼应 --p2
const VW = 2560, VH = 1440;               // Wallpaper_Presence 视频原生分辨率

// 生成位移图 dataURL（R/G 编码 xy 位移，NEUTRAL=128 不动，B 恒 128）。
function lensDataURL() {
  const { data, width, height } = lensMapBytes(RB, RB, RB / 2, BEVEL, STRENGTH, SS);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return c.toDataURL();
}

// 注入隐藏 SVG filter：feImage 载位移图 + feDisplacementMap 把 SourceGraphic 往里拉。
//
// ★ color-interpolation-filters="sRGB" 是**必须**的，不是可选项（2026-10-18 实测）：
//   SVG 滤镜默认在 linearRGB 里算，而我们喂的位移图是 sRGB 的 PNG（NEUTRAL=128）。
//   进了线性空间，128 不再是「零位移」，整张图会被均匀推偏 —— 实测中心区的平均差
//   从 0.07/255 跳到 11.23/255、61% 的像素超过 8/255 阈值，等于把一个圆钮变成
//   「糊了一圈的重影」。加上这一条之后中心区回到 0.07，位移只留在折光带里。
const FILTER_ATTRS =
  'filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" ' +
  'color-interpolation-filters="sRGB" ';

function injectFilter(href) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;left:-9999px;top:0";
  const d = RB * SS;
  svg.innerHTML =
    '<defs>' +
    '<filter id="rbGlass" ' + FILTER_ATTRS +
    'x="0" y="0" width="' + d + '" height="' + d + '">' +
    '<feImage href="' + href + '" x="0" y="0" width="' + d + '" height="' + d + '" result="map"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + DISP_SCALE + '" ' +
    'xChannelSelector="R" yChannelSelector="G"/>' +
    '</filter>' +
    '</defs>';
  document.body.appendChild(svg);
}

// ★ 舞台是**两枚 video 交叉淡入**（#stageVideo / #stageVideoB，见 app.js:stageCrossFade）：
//   首轮播的是 B，此后每换一段就在 A/B 之间轮流。只认 #stageVideo 会让玻璃层
//   每隔一段闪一次"没画面"，甚至在开场就完全不出现。所以每帧都挑**当前露在上面
//   的那一枚**（没有 .under 的那个），两枚都没有就退回原生按钮。
function frontVideo() {
  const a = document.getElementById("stageVideo");
  const b = document.getElementById("stageVideoB");
  const cands = [a, b].filter((v) => v && v.readyState >= 2 && v.videoWidth > 0);
  if (!cands.length) return null;
  // 优先选没被压到下面的；两枚都在过渡中就选视频时间更靠前的（后进来的那个）。
  return cands.find((v) => !v.classList.contains("under")) || cands[cands.length - 1];
}

function setup() {
  const rbs = Array.from(document.querySelectorAll(".rb"));
  if (!rbs.length) return;
  if (!document.getElementById("stageVideo")) return;

  injectFilter(lensDataURL());

  // 离屏缓冲：先在它上面施加折射，再合成到可见 canvas。
  const buf = document.createElement("canvas");
  buf.width = buf.height = RB * SS;
  const bctx = buf.getContext("2d");

  const layers = rbs.map((rb) => {
    const cv = document.createElement("canvas");
    cv.className = "rb-glass";
    // ★ 画布的内部分辨率是 RB*SS（46×3=138），但**显示尺寸必须等于按钮的 46px**。
    //   只设 cv.width/height 时元素按 138×138 的固有尺寸布局 —— 一颗 46px 的圆钮上
    //   会压出一个直径 3 倍的玻璃圆盘，圆心还偏到 (left+PAD/2, top+PAD/2)，
    //   实测就是"几个大圆错位叠在列表上"。所以这里必须把 CSS 尺寸单独钉死。
    cv.style.width = RB + "px";
    cv.style.height = RB + "px";
    cv.width = cv.height = RB * SS;
    document.body.appendChild(cv);
    return { rb, cv, ctx: cv.getContext("2d"), glyph: rb.textContent.trim() };
  });

  const rail = document.querySelector(".rail");
  let last = 0;

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.visibilityState === "hidden") return;
    if (t - last < 80) return; // ~12fps，圆钮这点面积不值得满帧
    last = t;

    // 没视频帧（没素材 / 还没播）就退回原生按钮，不画 canvas。
    const video = frontVideo();
    if (!video) {
      if (rail) rail.classList.remove("glass-on");
      // ★ 必须擦干净：canvas 是 position:fixed 常驻的，早先画过的圆会**停在屏幕上**
      //   盖住退回原位的那颗原生按钮（按钮自己变回实心了，上面的旧玻璃却还在）。
      for (const L of layers) L.ctx.clearRect(0, 0, L.cv.width, L.cv.height);
      return;
    }
    if (rail) rail.classList.add("glass-on");

    const vr = video.getBoundingClientRect();
    const scale = Math.min(vr.width / VW, vr.height / VH);
    const offX = (vr.width - VW * scale) / 2;
    const offY = (vr.height - VH * scale) / 2;
    // 取样区边长（CSS px）：按钮直径 + 两侧外扩。折射带的位移会从圆内往外取样，外扩是必需的。
    const sampleCss = RB + PAD * 2;

    for (const L of layers) {
      const br = L.rb.getBoundingClientRect();
      const cx = br.left + br.width / 2;
      const cy = br.top + br.height / 2;
      // 屏幕取样区 → 视频原生坐标（drawImage 的源矩形用自然像素）。
      // 取样区左上角 = 按钮中心各退半个 sampleCss。
      const hx = cx - sampleCss / 2;
      const hy = cy - sampleCss / 2;
      const sx = (hx - vr.left - offX) / scale;
      const sy = (hy - vr.top - offY) / scale;
      const sw = sampleCss / scale;
      const sh = sampleCss / scale;

      // ★ 画布显示尺寸 = 46px（= 按钮尺寸），画的是"按钮正下方那 106px 见方的取样区"
      //   经折射后落在按钮圆内的那一块 ⇒ 画布**左上角必须对齐按钮左上角**，
      //   不能再像 138px 那版一样外扩 PAD（那样会整体向右下错 30px）。
      L.cv.style.left = br.left + "px";
      L.cv.style.top = br.top + "px";

      bctx.clearRect(0, 0, buf.width, buf.height);
      bctx.filter = "url(#rbGlass)";
      try { bctx.drawImage(video, sx, sy, sw, sh, 0, 0, buf.width, buf.height); } catch (e) {}
      bctx.filter = "none";

      const g = L.ctx;
      const W = L.cv.width;                        // 内部分辨率 = RB*SS = 138
      const H = L.cv.height;
      g.clearRect(0, 0, W, H);
      // ★ buffer 里装的是「整块 106px 取样区」（buf 分辨率 = sampleCss × SS），
      //   而画布只显示按钮那 46px —— 所以要把 buffer **缩放**着画，并且只取按钮那一块。
      //   按钮在取样区里的位置：左上角各退 PAD。
      const padPx = PAD * SS;                      // PAD 在 buffer 里的像素数
      const rbPx = RB * SS;                        // 按钮在 buffer 里的像素数
      g.drawImage(buf, padPx, padPx, rbPx, rbPx, 0, 0, W, H);

      // ★ 2026-10-18 修：圆心必须用**内部分辨率**算（W/2 = 69），不能混用 CSS 尺寸。
      //   画布内部是 138×138、显示只有 46×46，浏览器整体缩放 1/3 呈现。
      //   之前在 arc() 里也写 L.cv.width/2（正确），但 clip 与 tint 的半径写的
      //   是 (RB/2)*SS = 69 —— 那其实也对；真正错的是**没有统一成变量**，
      //   改一处漏一处，实测就出现过圆盘直径 3 倍、圆心偏出按钮的情况。
      //   现在 W/H/R 三个量只在下面算一次，画什么都用它们。
      const cx = W / 2;
      const cy = H / 2;
      const R = W / 2;                             // 满圆半径（内部分辨率下 = 69）

      // 圆内：暗色 tint（保住文字可读性，玻璃感让位给正文层）。
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = TINT;
      g.fillRect(0, 0, W, H);
      if (L.rb.classList.contains("on")) {
        g.fillStyle = ON_TINT;
        g.fillRect(0, 0, W, H);
      }
      g.restore();

      // 高光环 + 外描边（C 组：rim rgba(255,255,255,.22) lw2 / 外边框 .30 lw1.5）。
      g.beginPath();
      g.arc(cx, cy, R - 1 * SS, 0, Math.PI * 2);
      g.lineWidth = 2 * SS;
      g.strokeStyle = "rgba(255,255,255,0.22)";
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, R - 1.5 * SS, 0, Math.PI * 2);
      g.lineWidth = 1.5 * SS;
      g.strokeStyle = "rgba(255,255,255,0.30)";
      g.stroke();

      // 图标（canvas 不解析 CSS 变量，写死字体栈）。
      g.fillStyle = "#e8e9eb";
      g.font = '700 ' + (13 * SS) + 'px "Segoe UI", system-ui, -apple-system, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(L.glyph, cx, cy + SS);
    }
  }
  requestAnimationFrame(frame);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setup);
} else {
  setup();
}
