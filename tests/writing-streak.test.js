// 连续写信的护栏：
//   A. 纯函数 computeStreak 的算法确定性（含跨月/跨年、今天没写不算断、真断归零）；
//   B. 后端路由 / 契约 / 前端容器 / 前端调用 / 启动加载 / 样式 / 回信软提示 各环都在。
// 任何一环被删/被注释，用户就"看不到连续天数"或"她不会提一句"——用测试挡住。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeStreak } from "../app/writing-stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const readCss = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//gu, "");

function findKey(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

// ---------- A. computeStreak 算法（用固定 today，排除时间依赖） ----------
const TODAY = new Date(2026, 9, 21);              // 2026-10-21（月份 0-based）
const S = (...days) => new Set(days);

test("computeStreak：空集合 → 0", () => {
  assert.equal(computeStreak(S(), TODAY), 0);
});
test("computeStreak：只有今天 → 1", () => {
  assert.equal(computeStreak(S("2026-10-21"), TODAY), 1);
});
test("computeStreak：今天没写、昨天写了 → 1（今天不算断，一天没过完）", () => {
  assert.equal(computeStreak(S("2026-10-20"), TODAY), 1);
});
test("computeStreak：今天+昨天+前天 → 3", () => {
  assert.equal(computeStreak(S("2026-10-21", "2026-10-20", "2026-10-19"), TODAY), 3);
});
test("computeStreak：中间断一天 → 只算从今天起的连续段", () => {
  // 有 21、20、18（缺 19）⇒ 2
  assert.equal(computeStreak(S("2026-10-21", "2026-10-20", "2026-10-18"), TODAY), 2);
});
test("computeStreak：今天和昨天都没写 → 0（真断，安静归零）", () => {
  assert.equal(computeStreak(S("2026-10-18"), TODAY), 0);
});
test("computeStreak：跨月/跨年连续", () => {
  // today 2026-01-01；含 2025-12-31、2025-12-30 ⇒ 3
  assert.equal(
    computeStreak(S("2026-01-01", "2025-12-31", "2025-12-30"), new Date(2026, 0, 1)),
    3,
  );
});
test("computeStreak：也接受数组输入", () => {
  assert.equal(computeStreak(["2026-10-21", "2026-10-20"], TODAY), 2);
});

// ---------- B. 各环都在（静态护栏） ----------
test("后端：/api/writing-stats 路由 + writingStats 用 computeStreak", () => {
  const s = read("app/server.mjs");
  assert.match(s, /path === "\/api\/writing-stats"/u, "server.mjs 缺 /api/writing-stats 路由");
  assert.match(s, /function writingStats/u, "server.mjs 缺 writingStats()");
  assert.match(s, /computeStreak\(/u, "writingStats 没调用 computeStreak");
});

test("契约：http_contract.json 登记 /api/writing-stats", () => {
  const c = JSON.parse(read("app/contracts/http_contract.json"));
  assert.ok(findKey(c, "/api/writing-stats"), "契约里没有 /api/writing-stats");
});

test("前端：容器 + loadWritingStreak + 启动调用", () => {
  assert.match(read("app/public/index.html"), /id="writingStreak"/u, "index.html 缺 writingStreak 容器");
  const js = read("app/public/app.js");
  assert.match(js, /async function loadWritingStreak/u, "app.js 缺 loadWritingStreak");
  assert.match(js, /\/api\/writing-stats/u, "app.js 没调用 /api/writing-stats");
  assert.match(js, /void loadWritingStreak\(\)/u, "app.js 没调用 loadWritingStreak()");
  // ★ 必须真的在**启动区**调用（紧挨 loadOnThisDay 那句），不是别处（如发送后刷新）有一次就算——
  //   否则"启动时不加载连续天数"这种回归会被漏掉（变异测试抓出来的盲点）。
  assert.match(js, /void loadOnThisDay\(\);[^\n]*\n\s*void loadWritingStreak\(\);/u, "启动区没调用 loadWritingStreak()");
});

test("样式：.writing-streak 生效（非注释）且默认隐藏", () => {
  const css = readCss("app/public/styles-original.css");
  assert.match(css, /\.writing-streak\s*\{/u, "缺 .writing-streak 样式");
  assert.match(css, /\.writing-streak\[hidden\]\s*\{\s*display:\s*none/u, "缺 .writing-streak[hidden]");
});

test("回信：连续 >=3 天时把软提示注入 prompt（她自然提一嘴，不是系统奖励）", () => {
  const s = read("app/server.mjs");
  assert.match(s, /streakHint/u, "generateReply 缺 streakHint");
  assert.match(s, /streak >= 3/u, "缺 streak >= 3 的注入条件");
  assert.match(s, /都在给你写信/u, "缺注入文案（应让模型自然提一句）");
});
