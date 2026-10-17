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
function injectFilter(href) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;left:-9999px;top:0";
  const d = RB * SS;
  svg.innerHTML =
    '<defs>' +
    '<filter id="rbGlass" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" ' +
    'x="0" y="0" width="' + d + '" height="' + d + '">' +
    '<feImage href="' + href + '" x="0" y="0" width="' + d + '" height="' + d + '" result="map"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + DISP_SCALE + '" ' +
    'xChannelSelector="R" yChannelSelector="G"/>' +
    '</filter>' +
    '</defs>';
  document.body.appendChild(svg);
}

function setup() {
  const rbs = Array.from(document.querySelectorAll(".rb"));
  if (!rbs.length) return;
  const video = document.getElementById("stageVideo");
  if (!video) return;

  injectFilter(lensDataURL());

  // 离屏缓冲：先在它上面施加折射，再合成到可见 canvas。
  const buf = document.createElement("canvas");
  buf.width = buf.height = RB * SS;
  const bctx = buf.getContext("2d");

  const layers = rbs.map((rb) => {
    const cv = document.createElement("canvas");
    cv.className = "rb-glass";
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
    if (video.readyState < 2) {
      if (rail) rail.classList.remove("glass-on");
      return;
    }
    if (rail) rail.classList.add("glass-on");

    const vr = video.getBoundingClientRect();
    const scale = Math.min(vr.width / VW, vr.height / VH);
    const offX = (vr.width - VW * scale) / 2;
    const offY = (vr.height - VH * scale) / 2;
    const halfCss = RB / 2 + PAD;

    for (const L of layers) {
      const br = L.rb.getBoundingClientRect();
      const cx = br.left + br.width / 2;
      const cy = br.top + br.height / 2;
      // 屏幕取样区 → 视频原生坐标（drawImage 的源矩形用自然像素）。
      const sx = (cx - halfCss - vr.left - offX) / scale;
      const sy = (cy - halfCss - vr.top - offY) / scale;
      const sw = (halfCss * 2) / scale;
      const sh = (halfCss * 2) / scale;

      L.cv.style.left = (br.left - PAD) + "px";
      L.cv.style.top = (br.top - PAD) + "px";

      bctx.clearRect(0, 0, buf.width, buf.height);
      bctx.filter = "url(#rbGlass)";
      try { bctx.drawImage(video, sx, sy, sw, sh, 0, 0, buf.width, buf.height); } catch (e) {}
      bctx.filter = "none";

      const g = L.ctx;
      g.clearRect(0, 0, L.cv.width, L.cv.height);
      g.drawImage(buf, 0, 0);

      // 圆内：暗色 tint（保住文字可读性，玻璃感让位给正文层）。
      g.save();
      g.beginPath();
      g.arc(buf.width / 2, buf.height / 2, (RB / 2) * SS, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = TINT;
      g.fillRect(0, 0, L.cv.width, L.cv.height);
      if (L.rb.classList.contains("on")) {
        g.fillStyle = ON_TINT;
        g.fillRect(0, 0, L.cv.width, L.cv.height);
      }
      g.restore();

      // 高光环 + 外描边（C 组：rim rgba(255,255,255,.22) lw2 / 外边框 .30 lw1.5）。
      g.beginPath();
      g.arc(buf.width / 2, buf.height / 2, (RB / 2) * SS - 1 * SS, 0, Math.PI * 2);
      g.lineWidth = 2 * SS;
      g.strokeStyle = "rgba(255,255,255,0.22)";
      g.stroke();
      g.beginPath();
      g.arc(buf.width / 2, buf.height / 2, (RB / 2) * SS - 1.5 * SS, 0, Math.PI * 2);
      g.lineWidth = 1.5 * SS;
      g.strokeStyle = "rgba(255,255,255,0.30)";
      g.stroke();

      // 图标（canvas 不解析 CSS 变量，写死字体栈）。
      g.fillStyle = "#e8e9eb";
      g.font = '700 ' + (13 * SS) + 'px "Segoe UI", system-ui, -apple-system, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(L.glyph, buf.width / 2, buf.height / 2 + SS);
    }
  }
  requestAnimationFrame(frame);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setup);
} else {
  setup();
}
