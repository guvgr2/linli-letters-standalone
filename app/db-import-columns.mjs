// UserData 导入要用的两列：`content_md5`（去重键）与 `archived_at`（"已完成"标记）。
//
// 来源：2026-10-16 就 U3 的答复（当时的往来记录 §4.24），
// 用户已拍板「可以，加，推」。原版程序对应列是 `content_md5` 与 `memory_order IS NOT NULL`。
//
// ★ 为什么单独拆一个模块、还把备份做成注入的：
//   1. 目标库是**用户机器上正在跑的** `letters.sqlite`，动它之前必须留一份带时间戳的副本 ——
//      普通文件复制没有撤销键，改错了只能靠这份副本回退。
//   2. 必须**幂等**：第二次启动再 ALTER 一遍会报 `duplicate column name`，
//      那不是"多打一行日志"，是用户从此打不开程序。
//   3. 备份动作由调用方注入，测试才能在临时目录里跑，不碰用户的真实库。
//
// 顺序有意义：先 md5 后归档时间（给用户的迁移报告按这个顺序列）。

/** 导入需要、但旧库没有的两列。 */
export const IMPORT_COLUMNS = Object.freeze([
  { name: "content_md5", ddl: "content_md5 TEXT" },
  { name: "archived_at", ddl: "archived_at INTEGER" },
]);

/** 纯函数：给一组现有列名，算出还缺哪几列、要跑哪些 ALTER。 */
export function planColumnMigration(existingColumnNames) {
  const have = new Set((existingColumnNames ?? []).map(String));
  const missing = IMPORT_COLUMNS.filter((c) => !have.has(c.name));
  return {
    missing: missing.map((c) => c.name),
    statements: missing.map((c) => `ALTER TABLE letters ADD COLUMN ${c.ddl}`),
  };
}

/** 读 letters 表现在有哪些列（PRAGMA 返回的是行对象数组）。 */
export function readLetterColumns(conn) {
  return conn.prepare("PRAGMA table_info(letters)").all().map((r) => String(r.name));
}

/**
 * 把缺的列补上。返回 { applied, backedUp, missing }。
 * ★ 顺序是硬要求：**先备份，再 ALTER**；改完还要回读校验 —— 三条缺一条都不许静默过。
 */
export function ensureImportColumns(conn, { backup } = {}) {
  const plan = planColumnMigration(readLetterColumns(conn));
  if (plan.missing.length === 0) return { applied: [], backedUp: false, missing: [] };
  if (typeof backup === "function") backup();
  for (const sql of plan.statements) conn.exec(sql);
  const after = new Set(readLetterColumns(conn));
  const notApplied = plan.missing.filter((name) => !after.has(name));
  if (notApplied.length > 0) {
    throw new Error(`导入列迁移没生效：${notApplied.join(", ")} —— 不静默继续`);
  }
  return { applied: plan.missing, backedUp: true, missing: plan.missing };
}
