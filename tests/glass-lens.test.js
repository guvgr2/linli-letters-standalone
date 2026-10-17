/**
 * 透镜位移图的几何护栏（独立审查《液态玻璃方案》§3.3 的 30 行技法）。
 *
 * 为什么先钉几何：那份实现的 `makeLensMap()` 直接依赖 `canvas` ⇒ 在 Node 里一行都跑不了，
 * 只能靠「截图看着还行」验收。而"看着还行"在这个项目里骗过我们不止一次。
 * ⇒ 几何抽成纯函数后，「玻璃到底是不是向内折光」这种事就能用数字回答。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sdf, lensMapBytes } from "../app/public/glass-lens.mjs";

/**
 * ★ 128 是 SVG `feDisplacementMap` 的**协议约定**（R/G 通道 128 = 无位移），
 *   不是本侧的普通常量 ⇒ 断言**必须用字面量 128**，不能 `import { NEUTRAL }` 来比：
 *   拿常量跟常量比是同义反复 —— 把 NEUTRAL 的值改成 127 时，期望值与实际值一起变，
 *   测试永远绿（变异 M4 就真的绿了一次）。契约值一律用字面量钉住。
 */
const NEUTRAL_CHANNEL = 128;

const W = 1100;
const H = 640;
const RADIUS = 26;
const BEVEL = 34;
const SS = 2;

const map = lensMapBytes(W, H, RADIUS, BEVEL, 1.0, SS);

/** 取某个超采样像素的 R/G/B/A。 */
function px(x, y) {
  const i = (y * map.width + x) * 4;
  return { r: map.data[i], g: map.data[i + 1], b: map.data[i + 2], a: map.data[i + 3] };
}

test("① SDF 的符号：内部为负、边界为 0、外部为正", () => {
  const hw = 200;
  const hh = 100;
  const r = 20;
  assert.ok(sdf(0, 0, hw, hh, r) < 0, "正中心必须在内部（负）");
  assert.ok(Math.abs(sdf(hw, 0, hw, hh, r)) < 1e-9, "右边中点必须正好在边界（0）");
  assert.ok(sdf(hw + 50, 0, hw, hh, r) > 0, "跑到外面必须为正");
  // 内部越深越负
  assert.ok(sdf(0, 0, hw, hh, r) < sdf(hw - 1, 0, hw, hh, r));
});

test("② 尺寸按超采样倍数放大（2× 防锯齿）", () => {
  assert.equal(map.width, W * SS);
  assert.equal(map.height, H * SS);
  assert.equal(map.data.length, W * SS * H * SS * 4);
});

test("③ ★ 环带之外一律不动：正中心必须是中性灰 128", () => {
  const c = px(Math.floor(map.width / 2), Math.floor(map.height / 2));
  assert.equal(c.r, NEUTRAL_CHANNEL, "正中心在折光带之外，不该有水平位移");
  assert.equal(c.g, NEUTRAL_CHANNEL, "正中心在折光带之外，不该有垂直位移");
  assert.equal(c.a, 255, "alpha 必须满，否则整张图会被当成透明");
});

test("④ ★ 位移方向必须**向内**（凸透镜把背景往中心拉）", () => {
  // 上边中点：中心在它下方 ⇒ 垂直位移应为**正**（G > 128）
  const top = px(Math.floor(map.width / 2), 0);
  assert.ok(top.g > NEUTRAL_CHANNEL, `上边中点的 G=${top.g}，应 > ${NEUTRAL_CHANNEL}（向中心＝向下）`);
  assert.equal(top.r, NEUTRAL_CHANNEL, "上边中点在水平方向上不该有位移");

  // 右边中点：中心在它左方 ⇒ 水平位移应为**负**（R < 128）
  const right = px(map.width - 1, Math.floor(map.height / 2));
  assert.ok(right.r < NEUTRAL_CHANNEL, `右边中点的 R=${right.r}，应 < ${NEUTRAL_CHANNEL}（向中心＝向左）`);
  assert.equal(right.g, NEUTRAL_CHANNEL, "右边中点在垂直方向上不该有位移");
});

test("⑤ 折光带宽度：bevel 越大，发生位移的像素越多", () => {
  const countMoved = (bevel) => {
    const m = lensMapBytes(400, 300, 12, bevel, 1.0, 1);
    let n = 0;
    for (let i = 0; i < m.data.length; i += 4) {
      if (m.data[i] !== NEUTRAL_CHANNEL || m.data[i + 1] !== NEUTRAL_CHANNEL) n += 1;
    }
    return n;
  };
  const thin = countMoved(8);
  const thick = countMoved(40);
  assert.ok(thick > thin, `bevel 40（${thick} px）应比 bevel 8（${thin} px）覆盖更多像素`);
  assert.ok(thin > 0, "bevel 8 也该有位移，否则折光带根本没生成");
});

test("⑥ B 通道恒为中性 —— xChannelSelector=R / yChannelSelector=G，B 不参与", () => {
  const m = lensMapBytes(200, 120, 10, 20, 1.0, 1);
  for (let i = 0; i < m.data.length; i += 4) {
    if (m.data[i + 2] !== NEUTRAL_CHANNEL) assert.fail(`第 ${i / 4} 个像素的 B 不是 ${NEUTRAL_CHANNEL}`);
  }
});

test("⑦ 强度 strength 只改幅度、不改方向（0 ⇒ 完全不动）", () => {
  const zero = lensMapBytes(400, 300, 12, 20, 0, 1);
  let moved = 0;
  for (let i = 0; i < zero.data.length; i += 4) {
    if (zero.data[i] !== NEUTRAL_CHANNEL || zero.data[i + 1] !== NEUTRAL_CHANNEL) moved += 1;
  }
  assert.equal(moved, 0, "strength=0 时整张图必须全是中性灰");

  const weak = lensMapBytes(400, 300, 12, 20, 0.3, 1);
  const strong = lensMapBytes(400, 300, 12, 20, 1.0, 1);
  // 取同一个位置（上边中点）比较幅度
  const at = (m) => m.data[(0 * m.width + Math.floor(m.width / 2)) * 4 + 1];
  assert.ok(at(strong) > at(weak), "强度大的位移幅度必须更大");
});
