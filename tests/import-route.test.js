/**
 * `.soul` 导入的**端到端**护栏：起真服务 → 发真 HTTP → 落真 sqlite → 直读库对账。
 *
 * 为什么单有一个文件（而不是继续加在 import-preview.test.js 里）：
 *   那一族测的是**纯函数**（分类、映射、指纹），它们全绿只证明「算得对」，
 *   证明不了「接对了」—— 路由有没有挂上、令牌闸拦不拦、流式收件对不对、
 *   事务与备份在不在、写进库的列序有没有错位，这些都只有真的起一次服务才看得见。
 *
 * ★ 判据的独立性：本文件的指纹、时间戳、期望值全部**自己算一遍**（不 import `app/` 的换算函数）。
 *   拿被测者的函数当期望值，等于让两边一起错 —— 那正是 `.soul` 字段名错成 `content`
 *   却全绿的旧教训（见 `soul-archive.test.js` 文件头）。
 *
 * 跑法：node --test --test-force-exit tests\import-route.test.js
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

// ---------------------------------------------------------------- 夹具（照 DSH 的真格式）

const MAGIC = Buffer.from("SOUL0001", "ascii");
const HEADER_BYTES = 16;

const md5 = (text) => createHash("md5").update(text, "utf8").digest("hex");
/** DSH `exchangeContentMd5()`：来信与回信一起算，中间夹 `\n---\n`（两侧都 trim）。 */
const exchangeMd5 = (incoming, reply) =>
  md5(`${String(incoming ?? "").trim()}\n---\n${String(reply ?? "").trim()}`);

/** 一段合法视频：≥12 字节且第 4..8 字节是 `ftyp`。 */
function videoBytes(n = 32) {
  const b = Buffer.alloc(n, 1);
  b.write("ftyp", 4, "ascii");
  return b;
}

function buildSoul(manifest, videoBufs = []) {
  const body = Buffer.from(JSON.stringify(manifest), "utf8");
  const head = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(head, 0);
  head.writeBigUInt64LE(BigInt(body.length), HEADER_BYTES - 8);
  return Buffer.concat([head, body, ...videoBufs]);
}

/** 本地时区把 `date` + `time` 折成秒 —— 与 `.soul` 里那两个字符串的口径一致。 */
const localSeconds = (date, time) => Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000);

const VIDEO = videoBytes(32);

/**
 * 三封信，覆盖导入要分清的三种形态：
 *   imp-1 有来有回（有日期）、imp-2 她先写（incoming 空 ⇒ proactive）、imp-3 缺日期且没回信。
 * 顺序照 `.soul` 的 **newest-first**：03-06 → 03-05 → （无日期）。
 */
const LETTERS = [
  { letterId: "imp-2", date: "2026-03-06", time: "09:05", incoming: "", reply: "她主动写来的一封", replyLabel: "主动" },
  { letterId: "imp-1", date: "2026-03-05", time: "14:30", incoming: "第一封来信", reply: "第一封回信", replyLabel: "回信" },
  { letterId: "imp-3", date: "", time: "", incoming: "第三封来信", reply: "", replyLabel: "" },
].map((x) => ({ ...x, contentMd5: exchangeMd5(x.incoming, x.reply) }));

/** 期望值：全部由本文件自己算，不 import `app/` 的换算函数。 */
const EXPECT = {
  "imp-1": { content: "第一封来信", replyText: "第一封回信", origin: null, status: 4, createdAt: localSeconds("2026-03-05", "14:30") },
  "imp-2": { content: "", replyText: "她主动写来的一封", origin: "proactive", status: 4, createdAt: localSeconds("2026-03-06", "09:05") },
  // 缺日期 ⇒ created_at 由落库侧顺着倒数兜底，这里只能给区间，不能钉死具体秒。
  "imp-3": { content: "第三封来信", replyText: null, origin: null, status: 5, createdAt: null },
};

const CONTENT_MD5 = new Map(LETTERS.map((x) => [x.letterId, x.contentMd5]));

function soulFixture() {
  return buildSoul(
    {
      schema: "olivia-soul.bundle",
      version: 2,
      memory: { schema: "olivia-soul.memory", version: 1, exchanges: LETTERS },
      // 一段视频挂在 imp-1 上（认领要靠 contentMd5 / letterId 在信件清单里真的存在）。
      videos: [{ size: VIDEO.length, contentMd5: exchangeMd5("第一封来信", "第一封回信"), letterId: "imp-1" }],
    },
    [VIDEO],
  );
}

// ---------------------------------------------------------------- 子进程小工具

/** 等服务把 `LINLI_PORT=<n>` 打出来（`server.mjs` 在 listen 回调里打）。 */
function waitForPort(child, logs, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`服务在 ${timeoutMs}ms 内没报出 LINLI_PORT。输出：\n${logs.join("")}`)),
      timeoutMs,
    );
    const onChunk = (chunk) => {
      logs.push(chunk.toString("utf8"));
      const hit = /LINLI_PORT=(\d+)/u.exec(logs.join(""));
      if (hit) { clearTimeout(timer); resolve(Number(hit[1])); }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（code=${code}）。输出：\n${logs.join("")}`));
    });
  });
}

/** 收工必须把子进程真的收掉：漏一个就会占着端口活到下一次跑测试。 */
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已经退出了 */ } }, 3000);
  await exited;
  clearTimeout(hard);
}

// ---------------------------------------------------------------- 场景

describe(".soul 导入端到端（预览 → 落库 → 回读对账）", () => {
  let child = null;
  let dataDir = "";
  let base = "";
  let token = "";
  const logs = [];

  let previewId = "";
  let restaleId = "";
  let t0 = 0;
  let t1 = 0;

  const dbFile = () => join(dataDir, "letters.sqlite");
  const bakFiles = async () => (await readdir(dataDir)).filter((f) => f.endsWith(".sqlite.bak"));

  /** 只读打开临时库直查 —— 走 HTTP 看不到 `content_md5` / `archived_at`。 */
  function openDb() {
    return new DatabaseSync(dbFile(), { readOnly: true });
  }

  async function postSoul(buf) {
    const res = await fetch(`${base}/api/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Linli-Token": token },
      body: buf,
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json() };
  }

  async function postJson(path, payload) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Linli-Token": token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: await res.json() };
  }

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "linli-import-"));
    // 素材目录指到一个空目录：这套测试与待机素材无关，别去扫真的曲库/素材盘。
    const assetsDir = join(dataDir, ".no-assets");
    await mkdir(assetsDir, { recursive: true });
    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        LINLI_DATA_DIR: dataDir,
        LINLI_PORT: "0",
        LINLI_ASSETS_DIR: assetsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const port = await waitForPort(child, logs);
    base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200, `拿会话令牌失败：${res.status}`);
    token = (await res.json()).token;
    assert.match(token, /^[0-9a-f]{48}$/u, "令牌形状不对 —— 是不是哪一步没走对？");
  });

  after(async () => {
    await stopServer(child);
    if (dataDir) await cleanupDir(dataDir);
  });

  test("① 预览：三个数与一句话都对得上，且**一行都不写库**", { timeout: 60000 }, async () => {
    const baksBefore = await bakFiles();
    t0 = Math.floor(Date.now() / 1000);

    const { status, body } = await postSoul(soulFixture());
    assert.equal(status, 200, `预览该回 200，实际 ${status}：${JSON.stringify(body)}`);

    previewId = body.previewId;
    assert.match(previewId, /^[0-9a-f-]{36}$/u, "previewId 该是个 uuid");

    assert.deepEqual(body.counts, { added: 3, skipped: 0, conflicts: 0 });
    assert.equal(body.total, 3);
    // imp-3 没有 date ⇒ 要被算进「按基准倒数」的那一档，不能静默当 0。
    assert.equal(body.noDateCount, 1, "缺日期的信必须被数出来（noDateCount）");
    assert.equal(body.videos, 1);
    assert.equal(body.note, "本次导入未搬运 1 个回信视频。");
    assert.ok(Number(body.ttlMs) > 0, "预览该带有效期");

    // ★ 预览的全部意义就是「没有任何破坏性」——这里用库里的行数与备份数双重钉住。
    const db = openDb();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM letters").get().n, 0, "预览阶段写库了");
    } finally { db.close(); }
    assert.deepEqual(await bakFiles(), baksBefore, "预览阶段动了备份文件");
  });

  test("② 确认落库：written / 对账 / 备份三样都要有", { timeout: 60000 }, async () => {
    const baksBefore = await bakFiles();
    const { status, body } = await postJson("/api/import/confirm", { previewId });
    t1 = Math.floor(Date.now() / 1000);
    assert.equal(status, 200, `确认该回 200，实际 ${status}：${JSON.stringify(body)}`);

    assert.equal(body.written, 3);
    assert.equal(body.staleSkipped, 0);
    assert.deepEqual(body.counts, { added: 3, skipped: 0, conflicts: 0 });
    assert.equal(body.total, 3);
    assert.equal(body.verify.checked, 3, "对账的分母必须是真写进去的那批");
    assert.equal(body.verify.mismatched, 0, "落库后回读复算指纹必须逐位相等");

    // 备份是「动库前先留退路」的铁证：返回体里给的是文件名，磁盘上要真有那份文件。
    assert.ok(typeof body.backup === "string" && body.backup.length > 0, "有信要写就必须先备份");
    assert.ok(body.backup.endsWith(".sqlite.bak"), `备份名形状不对：${body.backup}`);
    const baksAfter = await bakFiles();
    assert.equal(baksAfter.length, baksBefore.length + 1, "备份文件没有真的落盘");
    assert.ok(baksAfter.includes(body.backup), `${body.backup} 不在数据目录里：${baksAfter.join("、")}`);
  });

  test("③ 回读 /api/letters：is_read / origin / reply_text 全对", { timeout: 30000 }, async () => {
    const res = await fetch(`${base}/api/letters`, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200);
    const rows = (await res.json()).letters;
    assert.equal(rows.length, 3);

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [id, want] of Object.entries(EXPECT)) {
      const row = byId.get(id);
      assert.ok(row, `库里没有 ${id}`);
      assert.equal(row.content, want.content, `${id} 正文`);
      assert.equal(row.reply_text, want.replyText, `${id} 回信`);
      assert.equal(row.origin, want.origin, `${id} 来源`);
      assert.equal(row.status, want.status, `${id} 状态`);
      // 导入进来的信一律已读 —— 它们是历史，不是"刚寄到待你拆"。
      assert.equal(row.is_read, 1, `${id} 该是已读`);
    }
  });

  test("④ 直读 sqlite：content_md5 / archived_at / created_at 逐条复算", { timeout: 30000 }, async () => {
    const db = openDb();
    try {
      const read = db.prepare("SELECT content, reply_text, content_md5, archived_at, created_at, replied_at FROM letters WHERE id = ?");
      for (const [id, want] of Object.entries(EXPECT)) {
        const row = read.get(id);
        assert.ok(row, `库里没有 ${id}`);

        // ★ 指纹用本文件自己算的值当期望（不 import app/ 的换算函数）。
        assert.equal(row.content_md5, CONTENT_MD5.get(id), `${id} content_md5 与计划不一致`);
        assert.match(row.content_md5, /^[0-9a-f]{32}$/u);

        // archived_at = 导入那一刻（预览时取的 now），不是信里写的时间。
        assert.equal(typeof row.archived_at, "number", `${id} archived_at 没写上`);
        assert.ok(
          row.archived_at >= t0 - 2 && row.archived_at <= t1 + 2,
          `${id} archived_at=${row.archived_at} 不在本次导入的 [${t0 - 2}, ${t1 + 2}] 区间内`,
        );

        if (want.createdAt !== null) {
          assert.equal(row.created_at, want.createdAt, `${id} created_at 与 date/time 折出的秒不符`);
          // DSH 口径：created_at = replied_at = 信件时间；没回信的保持 NULL。
          assert.equal(row.replied_at, want.status === 4 ? want.createdAt : null, `${id} replied_at`);
        } else {
          // 缺日期 ⇒ 顺着倒数排（不写 1970、也不写现在），所以只能钉区间与顺序。
          assert.ok(
            row.created_at >= t0 - 10 && row.created_at <= t1 + 10,
            `${id} 缺日期时 created_at 该在本次导入前后，实际 ${row.created_at}`,
          );
          assert.equal(row.replied_at, null, `${id} 没回信就不该有 replied_at`);
        }
      }
      // 顺序：newest-first 的清单倒过来落库 ⇒ 03-05 那封必须早于 03-06 那封。
      const older = read.get("imp-1").created_at;
      const newer = read.get("imp-2").created_at;
      assert.ok(older < newer, `落库顺序反了：imp-1=${older} 应早于 imp-2=${newer}`);
    } finally { db.close(); }
  });

  test("⑤ 同一份文件再预览：全部落 skipped，added=0", { timeout: 60000 }, async () => {
    const { status, body } = await postSoul(soulFixture());
    assert.equal(status, 200);
    restaleId = body.previewId;
    assert.notEqual(restaleId, previewId, "每次预览该是新的 id");
    assert.deepEqual(body.counts, { added: 0, skipped: 3, conflicts: 0 });
    assert.equal(body.total, 3);
    assert.equal(body.noDateCount, 1);
  });

  test("⑥ 同一个 previewId 再确认 ⇒ 410 + IMPORT_PREVIEW_STALE", { timeout: 30000 }, async () => {
    const { status, body } = await postJson("/api/import/confirm", { previewId });
    assert.equal(status, 410, `第二次确认该回 410，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal(body.code, "IMPORT_PREVIEW_STALE");
    // 两条腿：给用户看的那句话里必须带号（中文 + 全角括号里的号）。
    assert.ok(body.error.includes("（IMPORT_PREVIEW_STALE）"), `用户看到的话里没带号：${body.error}`);
    // 库里还是 3 封 —— 失效的预览不能悄悄再写一遍。
    const db = openDb();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM letters").get().n, 3); } finally { db.close(); }
  });

  test("⑦ 预览全 skipped 时确认 ⇒ written=0，且**不产生备份**", { timeout: 30000 }, async () => {
    const before = await bakFiles();
    const { status, body } = await postJson("/api/import/confirm", { previewId: restaleId });
    assert.equal(status, 200, `该回 200，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal(body.written, 0);
    assert.equal(body.staleSkipped, 0);
    assert.equal(body.backup ?? null, null, "一封都不写就不该碰备份（备份本身也动用户库文件）");
    assert.deepEqual(await bakFiles(), before, "没写库却多了备份文件");
    const db = openDb();
    try { assert.equal(db.prepare("SELECT COUNT(*) n FROM letters").get().n, 3); } finally { db.close(); }
  });

  test("⑧ magic 不对的文件 ⇒ 400 + IMPORT_SOUL_UNREADABLE", { timeout: 30000 }, async () => {
    const bad = soulFixture();
    bad.write("XXXXXXXX", 0, "ascii");
    const { status, body } = await postSoul(bad);
    assert.equal(status, 400, `该回 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal(body.code, "IMPORT_SOUL_UNREADABLE");
    assert.ok(body.error.includes("（IMPORT_SOUL_UNREADABLE）"), `用户看到的话里没带号：${body.error}`);
  });

  test("⑨ 文件被截短 ⇒ 400 + IMPORT_SOUL_UNREADABLE，且 message 是解析器原话", { timeout: 30000 }, async () => {
    const good = soulFixture();
    const { status, body } = await postSoul(good.subarray(0, good.length - 8));
    assert.equal(status, 400, `该回 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal(body.code, "IMPORT_SOUL_UNREADABLE");
    // 解析器的九道判据全是给用户看的中文，路由层必须原样上屏，不许换成笼统话。
    assert.ok(body.error.includes(".soul 文件不完整"), `解析器原话没上屏：${body.error}`);
  });

  test("⑩ 一个字节都没发 ⇒ 400 + IMPORT_FILE_REQUIRED", { timeout: 30000 }, async () => {
    const { status, body } = await postSoul(Buffer.alloc(0));
    assert.equal(status, 400, `该回 400，实际 ${status}：${JSON.stringify(body)}`);
    assert.equal(body.code, "IMPORT_FILE_REQUIRED");
    assert.ok(body.error.includes("（IMPORT_FILE_REQUIRED）"), `用户看到的话里没带号：${body.error}`);
  });

  test("⑪ confirm 不带 previewId ⇒ 400 + IMPORT_PREVIEW_REQUIRED", { timeout: 30000 }, async () => {
    const { status, body } = await postJson("/api/import/confirm", {});
    assert.equal(status, 400, `该回 400，实际 ${status}：${JSON.stringify(body)}`);
    // ★ 「没收到文件」与「没给预览 id」是**两个号**：前者要用户重选文件，后者要用户重走预览，
    //   按号排查的人看到的下一步动作完全不同 —— 一码两义会把人指到错的方向去。
    assert.equal(body.code, "IMPORT_PREVIEW_REQUIRED");
    assert.notEqual(body.code, "IMPORT_FILE_REQUIRED", "两个动作不能共用一个号");
    assert.ok(body.error.includes("（IMPORT_PREVIEW_REQUIRED）"), `用户看到的话里没带号：${body.error}`);
  });

  test("⑫ 没有令牌的写请求 ⇒ 403（路由确实挂在令牌闸后面）", { timeout: 30000 }, async () => {
    const res = await fetch(`${base}/api/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: soulFixture(),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 403, `不带令牌的导入该被拒，实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, "COMMON_TOKEN_MISSING");
  });
});
