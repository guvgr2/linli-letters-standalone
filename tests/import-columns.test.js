// 导入两列迁移的护栏。
//
// ★ 这一层改的是**用户正在用的那封信的库**，所以护栏要钉的不是"能不能加列"，
//   而是三条保命性质：① 幂等（第二次启动不动它）② 备份发生在改之前 ③ 改不动就喊，不静默。
// 全程只用临时目录里的 sqlite，不碰用户的真实库。

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPORT_COLUMNS,
  planColumnMigration,
  readLetterColumns,
  ensureImportColumns,
} from "../app/db-import-columns.mjs";

/** 老库的样子：DSH 给的两列都还没有。 */
const OLD_COLUMNS = [
  "id", "content", "reply_text", "origin", "status",
  "error", "created_at", "replied_at", "is_read", "trigger_kind",
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "linli-cols-"));
}

/** 造一个真实的旧库文件（不是内存库）—— 备份那条得有真文件可复制。 */
function makeOldDb() {
  const dir = tempDir();
  const file = join(dir, "letters.sqlite");
  const conn = new DatabaseSync(file);
  conn.exec(`
    CREATE TABLE letters(
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      reply_text TEXT,
      origin TEXT,
      status INTEGER NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      replied_at INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      trigger_kind TEXT
    );
  `);
  conn.exec(`INSERT INTO letters(id, content, status, created_at, is_read)
             VALUES('a1', '你好', 4, 1700000000, 1)`);
  return { dir, file, conn };
}

test("① 旧库缺两列 ⇒ 规划出两条 ALTER，顺序是 md5 先、归档时间后", () => {
  const plan = planColumnMigration(OLD_COLUMNS);
  assert.deepEqual(plan.missing, ["content_md5", "archived_at"]);
  assert.deepEqual(plan.statements, [
    "ALTER TABLE letters ADD COLUMN content_md5 TEXT",
    "ALTER TABLE letters ADD COLUMN archived_at INTEGER",
  ]);
  assert.deepEqual(IMPORT_COLUMNS.map((c) => c.name), ["content_md5", "archived_at"]);
});

test("② 新库两列都在 ⇒ 规划为空（第二次启动不再动它，这是幂等的根据）", () => {
  const plan = planColumnMigration([...OLD_COLUMNS, "content_md5", "archived_at"]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.statements, []);
});

test("③ 只缺一列 ⇒ 只补那一列（已有那列不会被重复加）", () => {
  const plan = planColumnMigration([...OLD_COLUMNS, "content_md5"]);
  assert.deepEqual(plan.missing, ["archived_at"]);
  assert.equal(plan.statements.length, 1);
  assert.match(plan.statements[0], /archived_at/);
});

test("④ 真跑一遍：两列都在了，而且能写能读（不是只改了个表结构）", () => {
  const { conn } = makeOldDb();
  const r = ensureImportColumns(conn, { backup: () => {} });
  assert.deepEqual(r.applied, ["content_md5", "archived_at"]);
  const cols = readLetterColumns(conn);
  assert.ok(cols.includes("content_md5"), "content_md5 没进表");
  assert.ok(cols.includes("archived_at"), "archived_at 没进表");
  conn.exec(`INSERT INTO letters(id, content, status, created_at, is_read, content_md5, archived_at)
             VALUES('b2', '', 5, 1700000100, 0, NULL, 1700000200)`);
  const row = conn.prepare("SELECT content_md5, archived_at FROM letters WHERE id = 'b2'").get();
  assert.equal(row.content_md5, null, "空正文的 md5 必须是 NULL，不是 md5('')");
  assert.equal(row.archived_at, 1700000200);
  conn.close();
});

test("⑤ 第二次调用 ⇒ 一列都不加，而且**不再备份**（备份文件不该每次启动刷一份）", () => {
  const { conn } = makeOldDb();
  let backups = 0;
  ensureImportColumns(conn, { backup: () => { backups += 1; } });
  const again = ensureImportColumns(conn, { backup: () => { backups += 1; } });
  assert.deepEqual(again.applied, []);
  assert.equal(again.backedUp, false);
  assert.equal(backups, 1, "备份只该发生在真的要改表那一次");
  conn.close();
});

test("⑥ 备份发生在 ALTER **之前**：副本里必须还没有这两列", () => {
  const { dir, file, conn } = makeOldDb();
  const bak = join(dir, "letters.bak");
  ensureImportColumns(conn, { backup: () => copyFileSync(file, bak) });
  assert.ok(existsSync(bak), "备份文件没落盘");
  const peek = new DatabaseSync(bak);
  const cols = readLetterColumns(peek);
  peek.close();
  assert.ok(!cols.includes("content_md5"), "副本里已经有 content_md5 ⇒ 备份是在改之后做的");
  assert.ok(!cols.includes("archived_at"), "副本里已经有 archived_at ⇒ 备份是在改之后做的");
  assert.ok(cols.includes("status"), "副本不是空的（没复制成功的话这条会先红）");
  conn.close();
});

test("⑦ ALTER 没生效 ⇒ 抛错，不许静默带着缺列继续跑", () => {
  // 假连接：exec 什么都不做（模拟 ALTER 被吃掉）。
  const stub = {
    prepare: () => ({ all: () => OLD_COLUMNS.map((name) => ({ name })) }),
    exec: () => {},
  };
  assert.throws(
    () => ensureImportColumns(stub, { backup: () => {} }),
    /没生效/,
    "改不动必须喊出来",
  );
});

test("⑧ 备份失败 ⇒ 停手，一条 ALTER 都不执行（fail-closed，不带备份改用户的库）", () => {
  const executed = [];
  const stub = {
    prepare: () => ({ all: () => OLD_COLUMNS.map((name) => ({ name })) }),
    exec: (sql) => executed.push(sql),
  };
  assert.throws(
    () => ensureImportColumns(stub, { backup: () => { throw new Error("磁盘只读"); } }),
    /磁盘只读/,
  );
  assert.deepEqual(executed, [], "备份失败了还在改表 ⇒ 那次改动没有任何退路");
});

test("⑨ 反向钉子：临时目录里确实造出了 sqlite 文件（防目录空了整组假绿）", () => {
  const { dir } = makeOldDb();
  const files = readdirSync(dir);
  assert.ok(files.includes("letters.sqlite"), `临时库没建出来：${files.join(",")}`);
});
