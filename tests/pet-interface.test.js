// 桌宠接入接口（预留）的护栏：路由 / 契约 / 契约文档 三环缺一不可。
// 桌宠本体是独立项目，本仓只留这一帧只读状态接口；任何一环被删掉，
// 独立项目就"接不进来"——用测试挡住。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SERVER = "app/server.mjs";
const CONTRACT = "app/contracts/http_contract.json";
// ★ 2026-10-24：这份文档原本住在 analysis/，而 analysis/ 被 .gitignore 忽略、从未入库
//   ⇒ 目录被清一次，这条护栏就"缺少桌宠接入契约文档"红一次（实测发生过）。
//   已挪进已追踪的 app/contracts/，与 http_contract.json 同处。
const DOC = "app/contracts/桌宠接入契约（预留）-2026-10-21.md";

function findKey(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

test("后端：/api/pet/state 路由存在且只读，返回 version/tod/slot/scene/unread", () => {
  const s = read(SERVER);
  assert.match(s, /path === "\/api\/pet\/state"/u, "server.mjs 里没有 /api/pet/state 路由");
  const at = s.indexOf('/api/pet/state');
  const seg = s.slice(at, at + 1200);
  // 字段可能是 `x: 值` 也可能是简写 `x,`（如 unread），两种都算数。
  for (const field of ["version", "tod", "slot", "scene", "unread"]) {
    assert.match(seg, new RegExp(`\\b${field}\\s*[:,]`, "u"), `/api/pet/state 缺返回字段 ${field}`);
  }
});

test("契约：http_contract.json 登记 /api/pet/state，且是只读 GET", () => {
  const c = JSON.parse(read(CONTRACT));
  const e = findKey(c, "/api/pet/state");
  assert.ok(e, "契约里没有 /api/pet/state");
  assert.deepEqual(e.methods, ["GET"], "/api/pet/state 应只有 GET");
  assert.equal(e.read_only, true, "/api/pet/state 应标 read_only:true");
  assert.equal(e.capability, "pet.state", "/api/pet/state 的 capability 应为 pet.state");
});

test("契约文档存在，且写明了 /api/pet/state 与红线", () => {
  assert.ok(existsSync(join(ROOT, DOC)), "缺少桌宠接入契约文档");
  const doc = read(DOC);
  assert.match(doc, /\/api\/pet\/state/u, "文档没写 /api/pet/state");
  assert.match(doc, /127\.0\.0\.1/u, "文档没写只连本机回环");
  assert.match(doc, /不上传|不得上传/u, "文档没写清不上传红线");
});
