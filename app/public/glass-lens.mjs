// 液态玻璃 · 透镜位移图的数学部分（纯函数，不碰 DOM）
//
// 来源：独立审查《液态玻璃方案-给WorkBuddy-2026-10-16.md》§3.3 的 30 行技法。
// 为什么先把数学单独抽出来：那份代码里 `makeLensMap()` 直接依赖 `document.createElement('canvas')`，
// ⇒ 在 Node 里一行都测不了，只能靠"截图看着还行"来验收。而这个项目踩过太多次
//   「截图看着还行 / 判据其实没生效」，所以：**几何先变成纯函数，先钉住它是对的，
//   再谈画到屏幕上**。
//
// ★ 关键认知（原文档的 §2.2，我核过，成立）：
//   玻璃的位移**必须是有方向的**（沿边缘法线、往里收），所以只能由几何算出来。
//   用 `feTurbulence` 那种随机噪声做位移，得到的是**水波纹**，不是玻璃。
//
// ⚠️ 这里只生成「位移图的像素数据」。把它变成 `feImage` 的 href（canvas → dataURL）
//    是前端的事，不在这个文件里 —— 那条路径依赖 DOM，本文件保持可在 Node 下测试。

/** 位移图里「无位移」的基准值：R/G 通道 128 = 不偏移。 */
export const NEUTRAL = 128;

/**
 * 圆角矩形的有符号距离场（SDF）：内部为负、边界为 0、外部为正。
 *
 * @param {number} px 相对中心的 x
 * @param {number} py 相对中心的 y
 * @param {number} hw 半宽
 * @param {number} hh 半高
 * @param {number} r  圆角半径
 */
export function sdf(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 生成透镜位移图（RGBA 数据）。
 *
 * 只在**边缘 bevel 宽度的环带里**产生位移，方向沿法线向内，幅度按圆弧剖面衰减
 * —— 模拟一块凸起的玻璃把背景往中心拉。环带之外一律 NEUTRAL（不动）。
 *
 * @param {number} W 玻璃元素宽（CSS 像素）
 * @param {number} H 高
 * @param {number} radius 圆角半径
 * @param {number} bevel 折光带宽度（越大越"厚"）
 * @param {number} strength 位移强度 0~1
 * @param {number} [supersample] 超采样倍数（默认 2，防锯齿）
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function lensMapBytes(W, H, radius, bevel, strength, supersample = 2) {
  const SS = supersample;
  const w = Math.round(W * SS);
  const h = Math.round(H * SS);
  const data = new Uint8ClampedArray(w * h * 4);
  const hw = w / 2;
  const hh = h / 2;
  const r = radius * SS;
  const bv = bevel * SS;
  // 数值梯度用的探针步长（1 个超采样像素）
  const e = 1.0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - hw + 0.5;
      const py = y - hh + 0.5;
      const d = sdf(px, py, hw, hh, r);
      const inside = Math.max(0, -d); // 距边缘往里多远
      let dx = 0;
      let dy = 0;

      if (inside < bv) {
        const t = 1 - inside / bv; // 1 = 贴边，0 = 环带内沿
        // 圆弧剖面：贴边处最满，往里平滑衰减到 0
        const curve = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
        const gx = sdf(px + e, py, hw, hh, r) - sdf(px - e, py, hw, hh, r);
        const gy = sdf(px, py + e, hw, hh, r) - sdf(px, py - e, hw, hh, r);
        const gl = Math.hypot(gx, gy) || 1;
        // 负号 = 向**内**（凸透镜把背景往中心拉）
        dx = -(gx / gl) * curve * strength;
        dy = -(gy / gl) * curve * strength;
      }

      const i = (y * w + x) * 4;
      data[i] = NEUTRAL + dx * 127;
      data[i + 1] = NEUTRAL + dy * 127;
      data[i + 2] = NEUTRAL; // B 通道不参与（xChannelSelector=R、yChannelSelector=G）
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
