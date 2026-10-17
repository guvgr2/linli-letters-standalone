/**
 * `.soul` 容器解析的护栏（UserData 导入第二步）。
 *
 * 判据来源：DSH 侧 `parseSoulArchive`（`repo/source/local-service/server.js:2868-2926`）。
 * 这里每一条都**钉失败信息一字不改** —— 用户看到的提示两端要一致，改了字就是静默分叉。
 *
 * ★ 三个上限常量（`SOUL_MAGIC` / `MAX_SOUL_BYTES` / `MAX_SOUL_MANIFEST_BYTES`）本侧做法是
 *   **必传、缺了就抛**。这里钉住「缺了必须抛」，防止哪天有人"顺手给个默认值"。
 *
 * ★★ 2026-10-17 修正（这一版最要紧的改动）：**字段名与指纹算式原先都是错的。**
 *   真实 `.soul` 的每封信长这样（DSH `memoryExchange()`，`server.js:2364-2385`）：
 *     `letterId / date / time / incoming / reply / replyLabel / contentMd5 / summary / replyVideoUrl`
 *   —— **没有 `content`、没有 `replyText`**；指纹是
 *     `md5(incoming.trim() + "\n---\n" + reply.trim())`（`server.js:653-657`），**不是** `md5(incoming)`。
 *   旧测试的夹具写的全是 `content` ⇒ 解析器读不懂真文件、测试却全绿。这一版夹具一律改用真字段名，
 *   并新增一条「用真字段名造的归档必须能解析」的正向用例当守门员。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSoulArchive,
  parseSoulArchiveFile,
  exchangeMd5,
  SOUL_SCHEMA,
  MEMORY_SCHEMA,
  HEADER_BYTES,
  SOUL_LIMITS,
} from "../app/soul-archive.mjs";
import { contentFingerprint, exchangeFingerprint } from "../app/import-preview.mjs";

// 测试用的魔法头（8 字节，与 DSH 侧同长；真值见 ⑮）
const MAGIC = Buffer.from("OLIVIASL", "ascii");
const LIMITS = {
  magic: MAGIC,
  maxBytes: 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  maxVideoBytes: 4096,
};

/** 一段合法视频：≥12 字节且第 4..8 字节是 `ftyp`。 */
function videoBytes(n = 32) {
  const b = Buffer.alloc(n, 1);
  b.write("ftyp", 4, "ascii");
  return b;
}

function manifest(over = {}) {
  return {
    schema: SOUL_SCHEMA,
    // ★ version 必须透传：⑧ 要靠它造出「版本不受支持」的坏文件。
    //   早先这里写死成 2，over.version 被丢弃 ⇒ ⑧ 的 assert.throws 拿到的是合法文件，
    //   报 "Missing expected exception." —— 看起来像解析器漏校验，其实是夹具没生效。
    version: over.version ?? 2,
    memory: { schema: MEMORY_SCHEMA, version: 1, exchanges: over.exchanges ?? [] },
    videos: over.videos ?? [],
  };
}

function buildSoul(m, videoBufs = []) {
  const body = Buffer.from(JSON.stringify(m), "utf8");
  const head = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(head, 0);
  head.writeBigUInt64LE(BigInt(body.length), HEADER_BYTES - 8);
  return Buffer.concat([head, body, ...videoBufs]);
}

/** 一封**用真实字段名**写的往来（`incoming` / `reply`，不是 `content`）。 */
function letter(letterId, incoming, reply = "") {
  return { letterId, incoming, reply, contentMd5: exchangeMd5(incoming, reply) };
}

const L = (over) => ({ ...LIMITS, ...over });

test("① 正常解析：清单 + 视频偏移都对得上", () => {
  const v1 = videoBytes(32);
  const v2 = videoBytes(40);
  const ex = letter("a1", "你好");
  const ex2 = letter("a2", "第二封");
  // ⚠️ 信件数必须 ≥ 视频数（DSH `server.js:2893-2894` 也有这道），所以这里造两封。
  const m = manifest({
    videos: [{ size: v1.length, contentMd5: ex.contentMd5, letterId: "a1" }, { size: v2.length }],
    exchanges: [ex, ex2],
  });
  const buf = buildSoul(m, [v1, v2]);
  const got = parseSoulArchive(buf, LIMITS);

  assert.equal(got.manifestBytes, Buffer.byteLength(JSON.stringify(m)));
  assert.equal(got.payload.schema, SOUL_SCHEMA);
  // 视频紧跟清单之后，第二段的 offset 必须正好跳过第一段
  assert.deepEqual(got.videos.map((v) => v.offset), [HEADER_BYTES + got.manifestBytes, HEADER_BYTES + got.manifestBytes + 32]);
  assert.deepEqual(got.videos.map((v) => v.size), [32, 40]);
  // 认领信息要带出来，落库时靠它把视频挂回那封信
  assert.equal(got.videos[0].contentMd5, ex.contentMd5);
  assert.equal(got.videos[0].letterId, "a1");
});

test("①b 用真字段名（incoming/reply）造的归档必须能解析 —— 这是字段名写错时的守门员", () => {
  // 旧实现按 `content` 取正文 ⇒ 这里会被判成「空正文」，指纹比对随即失败。
  const ex = letter("real-1", "今天下班路上看到一只猫", "那它一定很自在。");
  const m = manifest({ exchanges: [ex] });
  const got = parseSoulArchive(buildSoul(m), LIMITS);
  assert.equal(got.payload.memory.exchanges[0].incoming, "今天下班路上看到一只猫");
  assert.equal(got.payload.memory.exchanges[0].reply, "那它一定很自在。");
});

test("①c 两侧的指纹算式必须是同一把尺子（我侧 == DSH 侧）", () => {
  // 来源：DSH `server.js:653-657`。改成只算正文，两个函数就会分叉 —— 这条会红。
  assert.equal(exchangeMd5("你好", "在的"), exchangeFingerprint("你好", "在的"));
  // 手工按他的式子复算一遍（trim + "\n---\n"），三个数必须一致
  const manual = contentFingerprint("你好\n---\n在的");
  assert.equal(exchangeMd5("你好", "在的"), manual);
  assert.equal(exchangeMd5("  你好  ", " 在的 "), manual, "两侧都 trim，空白不该改变指纹");
  // 只算正文的旧口径必须**不同** —— 否则这条测试是空的
  assert.notEqual(exchangeMd5("你好", "在的"), contentFingerprint("你好"));
});

test("② 体积超上限 ⇒ .soul 文件不能超过 10 GB", () => {
  const m = manifest();
  const buf = buildSoul(m);
  assert.throws(() => parseSoulArchive(buf, L({ maxBytes: buf.length - 1 })), /\.soul 文件不能超过 10 GB/u);
});

test("③ 不足 16 字节 ⇒ .soul 文件格式不正确", () => {
  assert.throws(() => parseSoulArchive(Buffer.alloc(15), LIMITS), /\.soul 文件格式不正确/u);
});

test("④ 魔法头不符 ⇒ .soul 文件格式不正确", () => {
  const buf = buildSoul(manifest());
  buf.write("XXXXXXXX", 0, "ascii");
  assert.throws(() => parseSoulArchive(buf, LIMITS), /\.soul 文件格式不正确/u);
});

test("⑤ 清单长度超上限 ⇒ .soul 信件清单过大", () => {
  const buf = buildSoul(manifest());
  assert.throws(() => parseSoulArchive(buf, L({ maxManifestBytes: 1 })), /\.soul 信件清单过大/u);
});

test("⑥ 文件被截短 ⇒ .soul 文件不完整", () => {
  // 清单里声明了一段 32 字节视频，但那些字节根本没跟在后面。
  // ⚠️ 信件数必须 ≥ 视频数，否则先撞上「视频清单格式不正确」那条 —— 测的就不是截短了。
  const m = manifest({ exchanges: [letter("a1", "你好")], videos: [{ size: 32 }] });
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 文件不完整/u);
});

test("⑦ 清单 JSON 坏 ⇒ .soul 信件清单格式不正确", () => {
  const head = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(head, 0);
  const body = Buffer.from("{ 这不是 json", "utf8");
  head.writeBigUInt64LE(BigInt(body.length), 8);
  assert.throws(() => parseSoulArchive(Buffer.concat([head, body]), LIMITS), /\.soul 信件清单格式不正确/u);
});

test("⑧ 版本不受支持 ⇒ 不支持的 .soul 文件版本", () => {
  assert.throws(() => parseSoulArchive(buildSoul(manifest({ version: 99 })), LIMITS), /不支持的 \.soul 文件版本/u);
});

test("⑨ 信件缺 letterId ⇒ .soul 信件信息校验失败", () => {
  const m = manifest({ exchanges: [{ incoming: "x" }] });
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 信件信息校验失败/u);
});

test("⑩ contentMd5 与正文不符 ⇒ .soul 信件信息校验失败", () => {
  // 真字段名 + 真算式，但故意把回信换掉 ⇒ 复算出来必然不等
  const ex = letter("a1", "你好", "在的");
  ex.contentMd5 = exchangeMd5("你好", "换了一句回信");
  const m = manifest({ exchanges: [ex] });
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 信件信息校验失败/u);
});

test("⑩b 指纹形状不对（不是 32 位小写十六进制）⇒ 同样拒", () => {
  const m = manifest({ exchanges: [{ letterId: "a1", incoming: "你好", contentMd5: "ABC" }] });
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 信件信息校验失败/u);
});

test("⑪ 视频清单不是数组 ⇒ .soul 视频清单格式不正确", () => {
  const m = manifest();
  m.videos = { size: 32 };
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 视频清单格式不正确/u);
});

test("⑪b 视频数比信件数还多 ⇒ .soul 视频清单格式不正确", () => {
  // 每段视频都挂在某封信上；比信还多说明清单是拼出来的（DSH server.js:2893-2894）
  const v = videoBytes(32);
  const m = manifest({ exchanges: [letter("a1", "你好")], videos: [{ size: 32 }, { size: 32 }] });
  assert.throws(() => parseSoulArchive(buildSoul(m, [v, v]), LIMITS), /\.soul 视频清单格式不正确/u);
});

test("⑫ 视频段缺 ftyp ⇒ .soul 包含无效 MP4", () => {
  const v = Buffer.alloc(32, 1); // 第 4..8 字节不是 ftyp
  const m = manifest({ exchanges: [letter("a1", "你好")], videos: [{ size: v.length }] });
  assert.throws(() => parseSoulArchive(buildSoul(m, [v]), LIMITS), /\.soul 包含无效 MP4/u);
});

test("⑫b 视频认领不到信（contentMd5 不在信件清单里）⇒ .soul 视频关联信息不正确", () => {
  const v = videoBytes(32);
  const m = manifest({
    exchanges: [letter("a1", "你好")],
    videos: [{ size: 32, contentMd5: contentFingerprint("谁也不是"), letterId: "a1" }],
  });
  assert.throws(() => parseSoulArchive(buildSoul(m, [v]), LIMITS), /\.soul 视频关联信息不正确/u);
});

test("⑫c 两段视频认领同一封（contentMd5 重复）⇒ .soul 视频关联信息不正确", () => {
  const v = videoBytes(32);
  const ex = letter("a1", "你好");
  const ex2 = letter("a2", "第二封");
  const m = manifest({
    exchanges: [ex, ex2],
    videos: [{ size: 32, contentMd5: ex.contentMd5 }, { size: 32, contentMd5: ex.contentMd5 }],
  });
  assert.throws(() => parseSoulArchive(buildSoul(m, [v, v]), LIMITS), /\.soul 视频关联信息不正确/u);
});

test("⑫d version 2 的 letterId 必须真的存在 ⇒ .soul 视频信件 ID 不正确", () => {
  const v = videoBytes(32);
  const ex = letter("a1", "你好");
  const m = manifest({
    exchanges: [ex],
    videos: [{ size: 32, contentMd5: ex.contentMd5, letterId: "查无此信" }],
  });
  assert.throws(() => parseSoulArchive(buildSoul(m, [v]), LIMITS), /\.soul 视频信件 ID 不正确/u);
});

test("⑫e 单段视频超 512 MB 上限 ⇒ .soul 视频大小不正确", () => {
  // 用一份**声明的**大 size 就能触发判据，不必真造 512 MB 数据：
  // 上限由调用方传（测试里传 4096），所以这里声明 4097 即可。
  const m = manifest({ exchanges: [letter("a1", "你好")], videos: [{ size: LIMITS.maxVideoBytes + 1 }] });
  assert.throws(() => parseSoulArchive(buildSoul(m), LIMITS), /\.soul 视频大小不正确/u);
});

test("⑬ 容器尾部有多余字节 ⇒ .soul 文件不完整", () => {
  const v = videoBytes(32);
  const m = manifest({ exchanges: [letter("a1", "你好")], videos: [{ size: v.length }] });
  const buf = Buffer.concat([buildSoul(m, [v]), Buffer.from("多余", "utf8")]);
  assert.throws(() => parseSoulArchive(buf, LIMITS), /\.soul 文件不完整/u);
});

// ---------------------------------------------------------------- DSH 给的真常量
test("⑮ 用 DSH 给的真常量能解析真格式 .soul（MAGIC 8 字节正好嵌进 16 字节头）", () => {
  // 他给的是 "SOUL0001"（8 字节 ascii）；头是 16 字节，魔法头占前 8，后 8 是清单长度。
  assert.equal(SOUL_LIMITS.magic.length, 8);
  assert.equal(SOUL_LIMITS.magic.toString("ascii"), "SOUL0001");
  assert.equal(SOUL_LIMITS.maxBytes, 10 * 1024 * 1024 * 1024);
  assert.equal(SOUL_LIMITS.maxManifestBytes, 16 * 1024 * 1024);
  assert.equal(SOUL_LIMITS.maxVideoBytes, 512 * 1024 * 1024, "单段视频上限出处：server.js:132");

  const m = manifest({ exchanges: [letter("a1", "你好")] });
  const body = Buffer.from(JSON.stringify(m), "utf8");
  const head = Buffer.alloc(HEADER_BYTES);
  SOUL_LIMITS.magic.copy(head, 0);
  head.writeBigUInt64LE(BigInt(body.length), 8);

  // 换成真魔法头后，原来拿测试魔法头造的文件必须**过不了** —— 两端不能各认一套
  assert.throws(() => parseSoulArchive(buildSoul(m), SOUL_LIMITS), /\.soul 文件格式不正确/u);

  const got = parseSoulArchive(Buffer.concat([head, body]), SOUL_LIMITS);
  assert.equal(got.manifestBytes, body.length);
  assert.equal(got.payload.schema, SOUL_SCHEMA);
});

// ---------------------------------------------------------------- 文件版（按需读）
test("⑯ 文件版与内存版结果逐字相同 —— 判据只有一份，不允许分叉", async () => {
  const v1 = videoBytes(32);
  const ex = letter("a1", "你好");
  const ex2 = letter("a2", "第二封");
  const m = manifest({
    exchanges: [ex, ex2],
    videos: [{ size: v1.length, contentMd5: ex.contentMd5, letterId: "a1" }],
  });
  const buf = buildSoul(m, [v1]);
  const dir = await mkdtemp(join(tmpdir(), "linli-soul-"));
  try {
    const file = join(dir, "a.soul");
    await writeFile(file, buf);
    const mem = parseSoulArchive(buf, LIMITS);
    const disk = await parseSoulArchiveFile(file, LIMITS);
    assert.deepEqual(disk.payload, mem.payload);
    assert.deepEqual(disk.videos, mem.videos);
    assert.equal(disk.manifestBytes, mem.manifestBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("⑯b 文件版不许把整份归档读进内存 —— 大视频只读它需要的字节", async () => {
  // ★ 这条是给「10 GB 上限」兜底的：一份声明了 1 MB 视频的归档，
  //   解析只该读「16 字节头 + 清单 + 视频头」，绝不该把 1 MB 全读进来。
  //   （DSH 侧也是文件句柄 + 偏移读，`server.js:2870-2874`。）
  const big = videoBytes(1024 * 1024);
  const ex = letter("a1", "你好");
  const m = manifest({ exchanges: [ex], videos: [{ size: big.length, contentMd5: ex.contentMd5, letterId: "a1" }] });
  const buf = buildSoul(m, [big]);
  const dir = await mkdtemp(join(tmpdir(), "linli-soul-"));
  try {
    const file = join(dir, "big.soul");
    await writeFile(file, buf);
    // 单段上限要放开到装得下这一段，否则先撞「视频大小不正确」——测的就不是读多少了
    const got = await parseSoulArchiveFile(file, L({ maxVideoBytes: big.length, maxBytes: buf.length + 1 }));
    assert.equal(got.videos[0].size, big.length);
    assert.ok(
      got.bytesRead < buf.length / 10,
      `只该读头与清单附近，实际读了 ${got.bytesRead} / ${buf.length} 字节`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("⑯c 文件版的失败信息与内存版一字不差（用户看到的提示两端要一致）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linli-soul-"));
  try {
    // 挑一条要读过清单才判得出来的（不是读头就拒的那种）
    const bad = buildSoul(manifest({ version: 99 }));
    const file = join(dir, "bad.soul");
    await writeFile(file, bad);
    await assert.rejects(
      () => parseSoulArchiveFile(file, LIMITS),
      (error) => {
        assert.throws(() => parseSoulArchive(bad, LIMITS), /不支持的 \.soul 文件版本/u);
        return /不支持的 \.soul 文件版本/u.test(error.message);
      },
    );
    // 文件真的短了（连头都不够）：内存版与文件版都要报格式不正确
    const tiny = join(dir, "tiny.soul");
    await writeFile(tiny, Buffer.alloc(8, 0));
    await assert.rejects(() => parseSoulArchiveFile(tiny, LIMITS), /\.soul 文件格式不正确/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 上限必须显式给
test("⑭ 四个上限缺任何一个都抛 —— 不许有人顺手补默认值", () => {
  const buf = buildSoul(manifest());
  assert.throws(() => parseSoulArchive(buf, { maxBytes: 1e6, maxManifestBytes: 1024, maxVideoBytes: 1024 }), /SOUL_MAGIC 未给定/u);
  assert.throws(() => parseSoulArchive(buf, { magic: MAGIC, maxManifestBytes: 1024, maxVideoBytes: 1024 }), /MAX_SOUL_BYTES 未给定/u);
  assert.throws(() => parseSoulArchive(buf, { magic: MAGIC, maxBytes: 1e6, maxVideoBytes: 1024 }), /MAX_SOUL_MANIFEST_BYTES 未给定/u);
  assert.throws(() => parseSoulArchive(buf, { magic: MAGIC, maxBytes: 1e6, maxManifestBytes: 1024 }), /MAX_VIDEO_BYTES 未给定/u);
});
