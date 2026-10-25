// 往年今日的护栏：后端路由 / 契约 / 前端容器 / 前端调用 / 启动加载 / 样式，六环缺一不可。
// 任一环被删或被注释掉，用户"打开时看不到去年的今天"——用测试挡住。
// 每条断言都要能被变异打红（删掉对应代码 ⇒ 该条 red）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
// CSS 断言先剥注释，否则"被注释掉的规则"也能命中，判不出"没生效"。
const readCss = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//gu, "");

const SERVER = "app/server.mjs";
const CONTRACT = "app/contracts/http_contract.json";
const INDEX = "app/public/index.html";
const APPJS = "app/public/app.js";
const CSS = "app/public/styles-original.css";

/** 递归找对象里是否含某个键（不依赖父级键名，契约结构调整时不会假红）。 */
function hasKey(obj, key) {
  if (!obj || typeof obj !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj).some((v) => hasKey(v, key));
}

test("后端：/api/onthisday 路由存在，且同时查 letters 与 diary", () => {
  const s = read(SERVER);
  assert.match(s, /path === "\/api\/onthisday"/u, "server.mjs 里没有 /api/onthisday 路由");
  // 该路由段内要有两张表的查询（防止只剩个空壳路由、返回空数据）
  // ★ 2026-10-21 修锚点：原来按 `indexOf("/api/onthisday")` 定位 —— 那是**纯字符串**，
  //   只要别的注释里提到这个路径就会先命中（这轮加时间轴时就撞了：切到了
  //   timelineWindow 的注释上，报"没查 letters"，而路由其实好好的）。
  //   改成锚在**路由那一行**，只有真的 `path === "/api/onthisday"` 才算数。
  const at = s.indexOf('path === "/api/onthisday"');
  assert.ok(at > 0, "找不到 /api/onthisday 的路由行");
  const seg = s.slice(at, at + 1500);
  assert.match(seg, /FROM letters/u, "/api/onthisday 没查 letters");
  assert.match(seg, /FROM diary/u, "/api/onthisday 没查 diary");
});

test("契约：http_contract.json 登记了 /api/onthisday", () => {
  const c = JSON.parse(read(CONTRACT));
  assert.ok(hasKey(c, "/api/onthisday"), "契约里没有 /api/onthisday");
});

test("前端：有 onThisDay 容器 + loadOnThisDay 函数 + 调用 /api/onthisday", () => {
  assert.match(read(INDEX), /id="onThisDay"/u, "index.html 缺 onThisDay 容器");
  const js = read(APPJS);
  assert.match(js, /async function loadOnThisDay/u, "app.js 缺 loadOnThisDay 函数");
  assert.match(js, /\/api\/onthisday/u, "app.js 没调用 /api/onthisday");
});

test("启动：必须真的调用 loadOnThisDay()（不是定义了不用）", () => {
  const js = read(APPJS);
  assert.match(js, /void loadOnThisDay\(\)/u, "启动区没调用 loadOnThisDay()");
});

test("样式：.onthisday 规则生效（非注释）且默认隐藏", () => {
  const css = readCss(CSS);
  assert.match(css, /\.onthisday\s*\{/u, "缺 .onthisday 样式规则");
  assert.match(css, /\.onthisday\[hidden\]\s*\{\s*display:\s*none/u, "缺 .onthisday[hidden]{display:none}");
});
