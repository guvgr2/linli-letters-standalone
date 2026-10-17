// 近况层档位的「信件数」计数口径。
// 真源 `行为参数.json` 的 `tierDataSource` 要求：只算「用户自己写的、且已经回过信」的信
// —— 排除主动信（她写来的）、排除在途/失败信。
//
// 这个文件守三件事：
//   ① TIER_COUNT_SQL 在**真 sqlite** 上的行为与口径描述一致（不是靠读注释想当然）；
//   ② SQL 与纯函数 isTierCounted() 对同一批行必须同结果（两处表达不许漂移）；
//   ③ server.mjs 里两处取信件数的地方**都不许**再用裸全表 COUNT（回归护栏）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TIER_COUNT_SQL, TIER_COUNTED_STATUS, isTierCounted } from "../app/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "app", "server.mjs");

/** 建一张与 app/server.mjs 同构的 letters 表（只留计数用得上的列）。 */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE letters(
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      reply_text TEXT,
      origin TEXT,
      status INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

const ROWS = [
  // 用户来信 + 已回信 ⇒ 计入
  { id: "u1", origin: null, status: 4 },
  { id: "u2", origin: null, status: 4 },
  // 用户来信 + 在途（PENDING=1 / LLM_PROCESSING=3）⇒ 不计入
  { id: "u3", origin: null, status: 1 },
  { id: "u4", origin: null, status: 3 },
  // 用户来信 + 失败 ⇒ 不计入
  { id: "u5", origin: null, status: 5 },
  // 主动信（她写来的）已回信 ⇒ 不计入（她自己写来的不该推高「往来多久」）
  { id: "p1", origin: "proactive", status: 4 },
  { id: "p2", origin: "proactive", status: 4 },
  // 主动信在途 ⇒ 当然也不计入
  { id: "p3", origin: "proactive", status: 1 },
];

function seed(db) {
  const ins = db.prepare("INSERT INTO letters(id, content, reply_text, origin, status, created_at) VALUES(?,?,?,?,?,?)");
  for (const r of ROWS) ins.run(r.id, "x", r.status === 4 ? "回信" : null, r.origin, r.status, 1700000000);
}

test("① TIER_COUNT_SQL 只数「用户来信且已回信」—— 8 行里得 2", () => {
  const db = freshDb();
  seed(db);
  assert.equal(db.prepare(TIER_COUNT_SQL).get().value, 2);
  db.close();
});

test("② SQL 与纯函数 isTierCounted 对同一批行结果必须一致（两处表达不许漂移）", () => {
  const db = freshDb();
  seed(db);
  const bySql = db.prepare(TIER_COUNT_SQL).get().value;
  const byFn = ROWS.filter(isTierCounted).length;
  assert.equal(bySql, byFn, `SQL=${bySql} 纯函数=${byFn}`);
  db.close();
});

test("③ ★ origin IS NULL 的行必须被算进来 —— 只写 <> 'proactive' 会把用户来信全漏掉", () => {
  // 这条是 SQLite 的三值逻辑陷阱：NULL <> 'proactive' ⇒ NULL ⇒ 不入选。
  const db = freshDb();
  db.prepare("INSERT INTO letters(id, content, reply_text, origin, status, created_at) VALUES(?,?,?,?,?,?)")
    .run("only-null-origin", "x", "回信", null, 4, 1700000000);
  assert.equal(db.prepare(TIER_COUNT_SQL).get().value, 1);

  // 反向证明：去掉 `origin IS NULL OR` 之后确实会漏 ⇒ 陷阱是真的，不是我臆想
  const broken = "SELECT COUNT(*) value FROM letters WHERE origin <> 'proactive' AND status = 4";
  assert.equal(db.prepare(broken).get().value, 0, "这条若不为 0，说明我对三值逻辑的理解错了");
  db.close();
});

test("④ 纯函数边界：主动信一律不计入，不管 status 是什么", () => {
  for (const status of [1, 3, 4, 5]) {
    assert.equal(isTierCounted({ origin: "proactive", status }), false, `status=${status}`);
  }
});

test("⑤ 纯函数边界：用户来信只有 status=4 才计入", () => {
  assert.equal(isTierCounted({ origin: null, status: 4 }), true);
  assert.equal(isTierCounted({ origin: undefined, status: 4 }), true);
  for (const status of [1, 3, 5]) {
    assert.equal(isTierCounted({ origin: null, status }), false, `status=${status}`);
  }
});

test("⑥ TIER_COUNTED_STATUS 必须等于 server.mjs 的 STATUS.REPLIED", () => {
  const src = readFileSync(SERVER, "utf8");
  const m = src.match(/const STATUS\s*=\s*Object\.freeze\(\{[^}]*REPLIED:\s*(\d+)/);
  assert.ok(m, "没在 server.mjs 找到 STATUS.REPLIED 的字面值");
  assert.equal(Number(m[1]), TIER_COUNTED_STATUS);
});

test("⑦ 回归护栏：server.mjs 取信件数的地方不许再用裸全表 COUNT(*) FROM letters", () => {
  const src = readFileSync(SERVER, "utf8");
  const bad = [...src.matchAll(/SELECT COUNT\(\*\) value FROM letters(?!\s+WHERE)/g)];
  assert.equal(
    bad.length,
    0,
    `还有 ${bad.length} 处裸全表计数（会把主动信/在途信算进「往来多久」），必须改走 TIER_COUNT_SQL`,
  );
  // 而且 TIER_COUNT_SQL 必须真的被用上 —— 否则上面那条是空转
  assert.ok(src.includes("TIER_COUNT_SQL"), "server.mjs 没有引用 TIER_COUNT_SQL");
  const used = [...src.matchAll(/db\.prepare\(TIER_COUNT_SQL\)/g)];
  assert.ok(used.length >= 2, `TIER_COUNT_SQL 只用了 ${used.length} 处，currentDriftTier 与 nearTermStatus 都该用`);
});

test("⑨ ★ 「提前 1 封」在我侧**不成立** —— 正在回的那封（LLM_PROCESSING）不计入", () => {
  // DSH `[#9]` §4：他侧的偏差是「回信路径在**生成回信时**算档，而被回的那封**已经在表里**」
  //   ⇒ 比「已回信数」提前 1 封；他问我侧是不是同型。
  //   ⇒ 我侧**不同型**，原因是取数点虽然也在生成时（server.mjs 的 generateReply 内），
  //     但那一刻被回的那封 status 还是 **LLM_PROCESSING**（回信落库后才变 REPLIED），
  //     而 TIER_COUNT_SQL 只数 status=4 ⇒ 它不在分母里 ⇒ 我侧口径 = 严格的「已完成回信数」。
  const src = readFileSync(SERVER, "utf8");
  const m = src.match(/const STATUS\s*=\s*Object\.freeze\(\{[^}]*LLM_PROCESSING:\s*(\d+)/u);
  assert.ok(m, "没在 server.mjs 找到 STATUS.LLM_PROCESSING 的字面值");
  const processing = Number(m[1]);
  assert.notEqual(processing, TIER_COUNTED_STATUS, "若 LLM_PROCESSING 与 REPLIED 同值，这条测试就失去意义了");

  const db = freshDb();
  const ins = db.prepare("INSERT INTO letters(id, content, reply_text, origin, status, created_at) VALUES(?,?,?,?,?,?)");
  for (const i of [1, 2]) ins.run(`done${i}`, "x", "回信", null, TIER_COUNTED_STATUS, 1700000000);
  ins.run("inflight", "x", null, null, processing, 1700000001);
  assert.equal(db.prepare(TIER_COUNT_SQL).get().value, 2, "在途那封不该进分母 ⇒ 我侧不「提前 1 封」");

  // 反向证明：差的正是这一封 —— 把它改成已回信，计数立刻 +1。
  // ⇒ 两端在同一时刻会整整差 1 封（他是「已回信 + 正在回的这封」），跨档边界时档位不同。
  db.prepare("UPDATE letters SET status = ? WHERE id = 'inflight'").run(TIER_COUNTED_STATUS);
  assert.equal(db.prepare(TIER_COUNT_SQL).get().value, 3, "证明两端的差就是「正在回的这封」算不算");
  db.close();
});

test("⑧ 全表 COUNT 与新口径的差 —— 证明这个 bug 会真的把档位推高", () => {
  const db = freshDb();
  seed(db);
  const all = db.prepare("SELECT COUNT(*) value FROM letters").get().value;
  const tier = db.prepare(TIER_COUNT_SQL).get().value;
  assert.equal(all, 8);
  assert.equal(tier, 2);
  // 8 vs 2：在真源档位表（0–3/4–20/21–60/61+）里这足以跨档 ⇒ 不是「差一点」的精度问题
  assert.ok(all - tier === 6, "样本固定为 8 行，差额应是 6");
  db.close();
});
