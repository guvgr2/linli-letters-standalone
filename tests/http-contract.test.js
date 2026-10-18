/**
 * HTTP 契约的护栏。
 *
 * 姊妹端（bside-olivia-community）的 `client/contracts/` 是它最硬的一条工程实践：
 * **每个跨界交互先落契约再写码**。我们很久以来是反过来的 —— 接口只活在 README 的口头描述里，
 * 于是吃过实打实的亏：`/api/library` 长期不回 `genre`，前端 2584 首全落到 undefined 档、
 * 四个页签全是"这一档还没有曲目"，静态读代码**看不出来**，跑起来才发现。
 *
 * 所以这里防的不是"契约文件写得好不好看"，是四件会真出事的事：
 *   ① 契约与代码不许脱钩 —— server.mjs 里每条 /api 路由都得在契约里有一条，反之亦然；
 *      新加一条路由忘了登记，等于这块地从此没人守。
 *   ② 方法不许漂 —— 契约说 GET 的，代码里就得真有 GET 分支。
 *   ③ 号不许凭空写 —— 契约里列的 error_codes 必须全部登记在 app/error-codes.mjs。
 *   ④ schema 本身要自洽 —— 契约实例的字段必须过 schema 的 required/additionalProperties。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ERR } from "../app/error-codes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const SERVER = read("app/server.mjs");
const SCHEMA = readJson("app/contracts/http_contract.schema.json");
const CONTRACT = readJson("app/contracts/http_contract.json");

const ROUTES = CONTRACT.routes;

/**
 * 从 server.mjs 里抠出真实存在的 /api 路由与它们的方法。
 *
 * 分发点的形状是固定的（本文件唯一的解析假设，改了写法这里会先红）：
 *   if (req.method === "GET" && path === "/api/xxx") { … }
 *   if (req.method === "POST" && path.startsWith("/api/letters/") && path.endsWith("/read")) { … }
 * 后一种是带参路由，契约里写成 `:id`。
 */
/**
 * 从 server.mjs 里抠出真实存在的 /api 路由与它们的方法。
 *
 * 认三种分发形状（本文件唯一的解析假设，改了写法这里会先红）：
 *   ① if (req.method === "GET"  && path === "/api/xxx") { … }
 *   ② if (req.method === "POST" && path.startsWith("/api/letters/") && path.endsWith("/read")) { … }
 *   ③ const P = "/api/folders/"; const id = path.startsWith(P) ? … : null;
 *      const isSelf = …; if (isSelf && req.method === "PATCH") { … }
 * ②③ 是带参路由，契约里写成 `:id`。
 *
 * ★ 不要绕开这里：写成 `path.match(/^\/api\/x\/([^/]+)$/)` 的分析器看不见，
 *   那条路由从此没人守。要加新的分发形状，先改这里再改代码。
 */
function routesFromSource(src) {
  const found = new Map(); // path -> Set(methods)
  const METHODS = "(GET|POST|PATCH|DELETE)";

  const add = (p, m) => {
    if (!found.has(p)) found.set(p, new Set());
    found.get(p).add(m);
  };

  // ① 精确匹配：path === "/api/..."
  const exact = new RegExp(`req\\.method\\s*===\\s*"${METHODS}"\\s*&&\\s*path\\s*===\\s*"(\\/api\\/[^"]*)"`, "gu");
  for (const m of src.matchAll(exact)) add(m[2], m[1]);

  // ② 带参：path.startsWith("/api/letters/") && path.endsWith("/read")
  //    ⇒ 契约里记成 /api/letters/:id/read
  const param = new RegExp(
    `req\\.method\\s*===\\s*"${METHODS}"\\s*&&\\s*path\\.startsWith\\("(\\/api\\/[^"]*)"\\)\\s*&&\\s*path\\.endsWith\\("([^"]*)"\\)`,
    "gu"
  );
  for (const m of src.matchAll(param)) add(`${m[2]}:id${m[3]}`, m[1]);

  // ③ 两段式（歌单那批）：先算一个 "id"，再按 `isXxx && req.method === "PATCH"` 分派
  //      const FOLDER_PREFIX = "/api/folders/";
  //      const folderId = path.startsWith(FOLDER_PREFIX) && … ? … : null;
  //      const isFolderSelf = folderId !== null && !folderId.includes("/");
  //      const isFolderItems = folderId !== null && folderId.endsWith("/items");
  //      if (isFolderSelf && req.method === "PATCH") { … }
  //    ⇒ 契约里记成 /api/folders/:id 与 /api/folders/:id/items。
  //    ★ 这是一种新形状，加它是因为歌单既要在 /:id 上改删、又要在 /:id/items 上增删重排，
  //      单靠前两种写不出「同一段 path 上三种方法各走一条」。
  // ---------------------------------------------------------------- ③ 两段式（歌单那批）
  // 代码里的形状（server.mjs 的 /api/folders 段）：
  //   const FOLDER_PREFIX = "/api/folders/";
  //   const folderId     = path.startsWith(FOLDER_PREFIX) && … ? … : null;
  //   const isFolderSelf  = folderId !== null && !folderId.includes("/");
  //   const isFolderItems = folderId !== null && folderId.endsWith("/items");
  //   if (isFolderSelf && req.method === "PATCH") { … }
  // ⇒ 契约里记成 /api/folders/:id 与 /api/folders/:id/items。
  //
  // 加这种形状是因为歌单要在**同一段 path 上**按方法分派三条（改/删/读），
  // 前面两种形状（整条 path 相等、或 startsWith+endsWith 在同一行）都写不出来。
  //
  // ★ 只在**恰好一个** `/api/…/` 前缀常量时启用：多个前缀时无法确定某个 isXxx
  //   属于哪个前缀，宁可漏登记（会红）也不要记错（会绿）。
  const prefixes = [...src.matchAll(/const\s+\w+\s*=\s*"(\/api\/[^"]*\/)"/gu)].map((m) => m[1]);
  if (prefixes.length === 1) {
    // isXxx 的后缀取自它自己那一行：`const isFolderItems = … .endsWith("/items")` ⇒ "/items"；
    // 没有 endsWith 的（`!folderId.includes("/")` 那种）就是 /:id 本身，后缀为空串。
    // ★ 按行切（不用 [^;]*?）—— 这几个 const 之间可能隔注释与换行，跨行匹配很脆。
    const suffixOf = new Map();
    for (const line of src.split("\n")) {
      const decl = line.match(/const\s+(is\w+)\s*=\s*(.*)$/u);
      if (!decl) continue;
      const tail = decl[2].match(/\.endsWith\("([^"]*)"\)/u);
      suffixOf.set(decl[1], tail ? tail[1] : "");
    }
    const guard = new RegExp(`if\\s*\\((is\\w+)\\s*&&\\s*req\\.method\\s*===\\s*"${METHODS}"\\)`, "gu");
    for (const m of src.matchAll(guard)) {
      const [, flag, method] = m;
      if (!suffixOf.has(flag)) continue;
      add(`${prefixes[0]}:id${suffixOf.get(flag)}`, method);
    }
  }

  return found;
}

const FROM_SOURCE = routesFromSource(SERVER);

// ---------------------------------------------------------------- ① 双向对齐

test("契约：server.mjs 里的每条 /api 路由都在契约里", () => {
  const missing = [];
  for (const [path, methods] of FROM_SOURCE) {
    const entry = ROUTES[path];
    if (!entry) { missing.push(`${path}（${[...methods].join("/")}）`); continue; }
    for (const m of methods) {
      if (!entry.methods.includes(m)) missing.push(`${path} ${m}`);
    }
  }
  assert.deepEqual(missing, [],
    `这些路由在代码里有、契约里没有（新路由请登记进 app/contracts/http_contract.json）：\n  ${missing.join("\n  ")}`);
});

test("契约：契约里的每条路由在 server.mjs 里都真有实现（不许留僵尸条目）", () => {
  const ghosts = [];
  for (const [path, entry] of Object.entries(ROUTES)) {
    if (!FROM_SOURCE.has(path)) { ghosts.push(path); continue; }
    for (const m of entry.methods) {
      if (!FROM_SOURCE.get(path).has(m)) ghosts.push(`${path} ${m}（契约说有，代码里没有）`);
    }
  }
  assert.deepEqual(ghosts, [],
    `契约里登记了但代码里找不到（删路由时请同步删契约）：\n  ${ghosts.join("\n  ")}`);
});

// ---------------------------------------------------------------- ② 方法不许漂

// ★ PATCH/DELETE 是给资源本身用的（歌单改名 / 删歌单 / 重排条目）。写进白名单前核过：
//   两条方法在本机回环上、带 X-Linli-Token、只回 JSON，安全面与 POST 一致；
//   server.mjs 的兜底是 `if (GET || HEAD) return serveStatic(...)`，其余落到 405，
//   所以 PATCH/DELETE 不会被静态服务误吃。
test("契约：methods 只许是 GET/POST/PATCH/DELETE 且不重复", () => {
  for (const [path, entry] of Object.entries(ROUTES)) {
    assert.ok(Array.isArray(entry.methods) && entry.methods.length > 0, `${path} 的 methods 必须是非空数组`);
    const set = new Set(entry.methods);
    assert.equal(set.size, entry.methods.length, `${path} 的 methods 有重复`);
    for (const m of set) {
      assert.ok(["GET", "POST", "PATCH", "DELETE"].includes(m), `${path} 的 method "${m}" 不在允许集合里`);
    }
  }
});

test("契约：只读的 GET 路由不许被标成 read_only=false", () => {
  for (const [path, entry] of Object.entries(ROUTES)) {
    if (entry.methods.length === 1 && entry.methods[0] === "GET") {
      assert.equal(entry.read_only, true, `${path} 只有 GET，必须标 read_only: true`);
    }
  }
});

// ---------------------------------------------------------------- ③ 号不许凭空写

test("契约：error_codes 里的每个号都登记在 app/error-codes.mjs", () => {
  const unknown = [];
  for (const [path, entry] of Object.entries(ROUTES)) {
    for (const code of entry.error_codes) {
      if (!ERR[code]) unknown.push(`${path} → ${code}`);
    }
  }
  assert.deepEqual(unknown, [],
    `契约引用了不存在的错误号（先在 app/error-codes.mjs 登记）：\n  ${unknown.join("\n  ")}`);
});

test("契约：代码里 fail() 真发出的号，必须写进某条路由的 error_codes", () => {
  // ★ 哪些号是**横切**的 —— 它们在分发**之前/之后**统一发出，不属于任何一条路由：
  //   COMMON_TOKEN_MISSING 是令牌闸（在 /api/session 之后就拦了），
  //   COMMON_ORIGIN_BLOCKED 是来源校验，COMMON_ROUTE_NOT_FOUND 是 405 兜底，
  //   COMMON_INTERNAL 是 catch 兜底，其余 COMMON_BODY_* 由 readJsonBody 各处共用。
  //   把它们列在这里是**显式的**：将来谁想往这张表里加号，得先解释它凭什么横切。
  const CROSS_CUTTING = new Set([
    "COMMON_TOKEN_MISSING", "COMMON_ORIGIN_BLOCKED", "COMMON_ROUTE_NOT_FOUND",
    "COMMON_INTERNAL", "COMMON_BODY_NOT_JSON", "COMMON_BODY_NOT_OBJECT", "COMMON_BODY_TOO_LARGE",
  ]);

  const declared = new Set();
  for (const entry of Object.values(ROUTES)) for (const c of entry.error_codes) declared.add(c);

  // 进队列之后才发出的号（回信链路），它们的出口在后台任务里、不在路由分发里。
  const BACKGROUND = new Set([
    "REPLY_PRECHECK_BLOCKED", "REPLY_PRECHECK_UNREADABLE", "REPLY_SELFCHECK_FAILED",
    "MODEL_KEY_MISSING", "MODEL_HTTP_FAILED", "MODEL_EMPTY_CONTENT", "MODEL_UNREACHABLE",
  ]);

  const inRoutes = new Set();
  for (const m of SERVER.matchAll(/ERR\.([A-Z][A-Z0-9_]+)/gu)) inRoutes.add(m[1]);

  const undeclared = [...inRoutes]
    .filter((c) => ERR[c] && !CROSS_CUTTING.has(c) && !BACKGROUND.has(c) && !declared.has(c));
  assert.deepEqual(undeclared, [],
    `这些号被发出去，但既没写进任何一条路由的 error_codes、也不在横切/后台清单里：\n  ${undeclared.join("\n  ")}`);
});

// ---------------------------------------------------------------- ④ schema 自洽

test("契约：实例字段必须过 schema 的 required 与 additionalProperties", () => {
  for (const key of SCHEMA.required) {
    assert.ok(key in CONTRACT, `契约实例缺少 schema 要求的顶层字段 "${key}"`);
  }
  for (const key of Object.keys(CONTRACT)) {
    assert.ok(key in SCHEMA.properties, `契约实例有 schema 未声明的顶层字段 "${key}"`);
  }

  const routeSchema = SCHEMA.$defs.route;
  for (const [path, entry] of Object.entries(ROUTES)) {
    for (const key of routeSchema.required) assert.ok(key in entry, `${path} 缺少字段 "${key}"`);
    for (const key of Object.keys(entry)) {
      assert.ok(key in routeSchema.properties, `${path} 有未声明的字段 "${key}"`);
    }
    assert.match(entry.capability, new RegExp(routeSchema.properties.capability.pattern, "u"),
      `${path} 的 capability "${entry.capability}" 不符合 能力.维度 的形状`);
    assert.ok(routeSchema.properties.state.enum.includes(entry.state),
      `${path} 的 state "${entry.state}" 不在 ${routeSchema.properties.state.enum.join("/")} 里`);
  }
});

test("契约：schema_version 与 contract_version 必须存在且形状正确", () => {
  assert.equal(CONTRACT.schema_version, SCHEMA.properties.schema_version.const);
  assert.match(CONTRACT.contract_version, new RegExp(SCHEMA.properties.contract_version.pattern, "u"));
});

// ---------------------------------------------------------------- ⑤ 隐私承诺不许悄悄扩大

test("契约：会离开本机的接口必须是一份显式短名单", () => {
  const list = CONTRACT.privacy.leaves_machine;
  assert.ok(Array.isArray(list), "privacy.leaves_machine 必须是数组");
  for (const p of list) {
    assert.ok(ROUTES[p], `privacy.leaves_machine 里的 "${p}" 不是一条已登记的路由`);
  }
  // 这三条是新版口径（写密钥、测连通、请模型判断要不要主动来信）。
  // 将来真加了会外发的接口，必须在这里补一条并说明理由，而不是让它悄悄多出来。
  assert.deepEqual([...list].sort(), ["/api/model", "/api/model/test", "/api/proactive/check"],
    "会离开本机的接口清单变了：新增外发接口前先想清楚它对「不上传」这句承诺意味着什么");
});

// ---------------------------------------------------------------- ⑥ 豁免清单不许乱扩

test("契约：免令牌的路径只许是带不了自定义头的二进制/静态资源", () => {
  const exempt = CONTRACT.base.auth.exempt;
  const allowed = new Set(["/", "/favicon.ico", "/api/session",
    "/api/media", "/api/idle/video", "/api/idle/ambience", "/api/font/file"]);
  for (const p of exempt) {
    assert.ok(allowed.has(p), `"${p}" 被加进了免令牌清单 —— <video>/<img> 用不到的接口不该免令牌`);
  }
});
