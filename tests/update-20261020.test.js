/**
 * 检查更新 + 更新包断点续传的护栏（2026-10-20 用户口径）。
 *
 * 用户原话：「咱们程序里有检查更新界面吗，接收 github 仓库 release，不会的话姊妹项目逻辑就挺好的，
 * 版本号管理，更新检查，beta 版……好像还有更新断点续传，你仔细借鉴一下吧」。
 *
 * 这个文件盯六件事：
 *   ① 版本比较 —— `v` 前缀、位数不等、预发布先后（`1.1.0-beta.1 < 1.1.0`）、解析不出来时的兜底；
 *   ② 安装包名判定 —— 本仓叫 `…-安装程序.exe`（不是姊妹的 `-Setup.exe`），且带路径的必须死掉；
 *   ③ Release 解析 —— 下载地址只认 https + github.com；beta 里没安装包的条目要跳过而不是报错；
 *   ④ 查询器 —— 并发合并成一次、成功 20 秒去重、失败按原因退避、reject 后必须把 inflight 摘掉；
 *   ⑤ 降级应答 —— 查不到时 `latestTag` 必须为空、`updateAvailable` 必须 false（**绝不能说「已是最新」**）；
 *   ⑥ **断点续传是真的** —— 起一个支持 Range 的本地服务，下载到一半暂停、重新建下载器（模拟关程序再开）、
 *      续传时断言发出去的是 `Range: bytes=<已下字节>-`，最后字节逐个对得上、SHA-256 通过、能装。
 *
 * ⑥ 是重点：静态读代码证明不了续传 —— `Range` 头写错、offset 记错、`.part` 打开方式写错，
 * 静态地看全都"像是对的"。只有真跑一遍、真比字节才算数。
 *
 * 跑法：node --test --test-force-exit tests\update-20261020.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_UPDATE_CHANNEL,
  UPDATE_CHANNELS,
  buildUpdateFailurePayload,
  buildUpdatePayload,
  compareReleaseVersions,
  createUpdateFeed,
  failureTtl,
  isInstallerAssetName,
  isNewerRelease,
  normalizeUpdateChannel,
  parseReleaseTag,
  releasePayloadFromRelease,
  stripTagPrefix,
} from "../app/updater.mjs";
import { createUpdateDownloader } from "../app/update-download.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const INSTALLER = "OliviaSoul-community独立版-1.0.1-安装程序.exe";
const DIGEST = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// ---------------------------------------------------------------- ① 版本比较

describe("版本比较", () => {
  test("v 前缀不影响判断：v1.0.0 与 1.0.0 是同一个版本", () => {
    assert.equal(stripTagPrefix("v1.0.0"), "1.0.0");
    assert.equal(stripTagPrefix("V2.3.4"), "2.3.4");
    // `verify-…` 这种正文开头的 v 不是前缀，不许被吃掉
    assert.equal(stripTagPrefix("version-1"), "version-1");
    assert.equal(isNewerRelease("1.0.0", "v1.0.0"), false);
    assert.equal(isNewerRelease("v1.0.0", "1.0.0"), false);
  });

  test("位数不同的段按数字比，不按字符串比", () => {
    // 字符串比会得出 "1.10.0" < "1.9.0"（'1' < '9'），这是最经典的假更新
    assert.equal(isNewerRelease("1.9.0", "1.10.0"), true);
    assert.equal(isNewerRelease("1.10.0", "1.9.0"), false);
    assert.equal(isNewerRelease("1.0.9", "1.0.10"), true);
    // 段数不足按 0 补齐：1.0 == 1.0.0
    assert.equal(isNewerRelease("1.0", "1.0.0"), false);
    assert.equal(isNewerRelease("1.0.0", "1.0.1"), true);
    assert.equal(isNewerRelease("2.0.0", "1.99.99"), false);
  });

  test("预发布：1.1.0-beta.1 < 1.1.0；beta.2 < beta.10", () => {
    assert.equal(isNewerRelease("1.0.0", "1.1.0-beta.1"), true, "正式版用户应该收到测试版通道里的 beta");
    assert.equal(isNewerRelease("1.1.0-beta.1", "1.1.0"), true, "beta 用户装上正式版后不该再提示 beta");
    assert.equal(isNewerRelease("1.1.0-beta.1", "1.1.0-beta.2"), true);
    assert.equal(isNewerRelease("1.1.0-beta.2", "1.1.0-beta.10"), true);
    assert.equal(isNewerRelease("1.1.0-beta", "1.1.0-beta.1"), true, "前缀短的小");
    assert.equal(isNewerRelease("1.1.0-alpha", "1.1.0-beta"), true);
    // 数字段 < 字母段（语义化版本 11.4.3）
    assert.equal(isNewerRelease("1.0.0-2", "1.0.0-alpha"), true);
  });

  test("解析不出来就走字符串兜底，但空 latest 一律「不是新版本」", () => {
    assert.equal(parseReleaseTag("nightly-2026"), null);
    assert.equal(parseReleaseTag(""), null);
    assert.equal(parseReleaseTag("1.0.0+build.9").nums[2], 0, "构建元数据不参与比较");
    // 降级应答里的 latestTag 是空串 —— 它绝不能被判成「有新版本」
    assert.equal(isNewerRelease("1.0.0", ""), false);
    assert.equal(isNewerRelease("1.0.0", null), false);
    assert.equal(isNewerRelease("1.0.0", "v1.0.0"), false);
    // 两边都解析不出来：只有真的不一样才算（仍然先剥 v 前缀）
    assert.equal(isNewerRelease("nightly-a", "nightly-b"), true);
    assert.equal(isNewerRelease("nightly-a", "vnightly-a"), false);
  });

  test("compareReleaseVersions 的三向结果", () => {
    assert.equal(compareReleaseVersions(parseReleaseTag("1.0.0"), parseReleaseTag("1.0.0")), 0);
    assert.equal(compareReleaseVersions(parseReleaseTag("1.0.0"), parseReleaseTag("1.0.1")), -1);
    assert.equal(compareReleaseVersions(parseReleaseTag("1.0.1"), parseReleaseTag("1.0.0")), 1);
  });
});

// ---------------------------------------------------------------- ② 安装包名

describe("安装包名判定", () => {
  test("本仓的安装包名要过", () => {
    assert.equal(isInstallerAssetName(INSTALLER), true);
    assert.equal(isInstallerAssetName("OliviaSoul-community独立版-2.0.0-安装程序.exe"), true);
    // 大小写不敏感：名字是 Inno 生成的，别因为改名弄丢更新
    assert.equal(isInstallerAssetName(INSTALLER.toUpperCase().replace(".EXE", ".exe")), true);
  });

  test("别的 exe / 没有安装程序字样的一律不过（同目录还有卸载器等文件）", () => {
    assert.equal(isInstallerAssetName("unins000.exe"), false);
    assert.equal(isInstallerAssetName("OliviaSoul-community独立版-1.0.1.zip"), false);
    assert.equal(isInstallerAssetName("OliviaSoul-community独立版-1.0.1-安装程序.exe.sha256"), false);
    assert.equal(isInstallerAssetName(""), false);
    assert.equal(isInstallerAssetName(null), false);
  });

  test("带路径字符或纯点号的名字必须死掉（这个名字要拼进落盘路径）", () => {
    // ★ 这三条是**只靠路径字符检查**才拦得住的：它们都以 OliviaSoul 开头、都以
    //   `安装程序.exe` 结尾，光靠 `^OliviaSoul.*安装程序\.exe$` 那条正则会放行。
    //   （编写时发现：没有这三条，把路径字符那行删掉测试照样全绿 —— 变异立刻抓出来了。）
    assert.equal(isInstallerAssetName(`OliviaSoul-x/../../evil-安装程序.exe`), false);
    assert.equal(isInstallerAssetName(`OliviaSoul-x\\..\\evil-安装程序.exe`), false);
    assert.equal(isInstallerAssetName("OliviaSoul-x\u0000y-安装程序.exe"), false);
    assert.equal(isInstallerAssetName("..\\..\\evil-安装程序.exe"), false);
    assert.equal(isInstallerAssetName("sub/evil-安装程序.exe"), false);
    assert.equal(isInstallerAssetName("C:evil-安装程序.exe"), false);
    assert.equal(isInstallerAssetName(".."), false);
  });
});

// ---------------------------------------------------------------- ③ Release 解析

describe("Release 解析", () => {
  const base = {
    tag_name: "v1.0.1",
    html_url: "https://github.com/o/r/releases/tag/v1.0.1",
    published_at: "2026-10-20T00:00:00Z",
    name: "1.0.1",
    body: "  · 修好了更新  ",
    assets: [{
      id: 9,
      name: INSTALLER,
      browser_download_url: `https://github.com/o/r/releases/download/v1.0.1/${encodeURIComponent(INSTALLER)}`,
      size: 1234,
      digest: "SHA256:" + "A".repeat(64),
    }],
  };

  test("正常条目转成界面要的形状（摘要转小写、notes 去首尾空白）", () => {
    const payload = releasePayloadFromRelease(base, { repository: "o/r" });
    assert.equal(payload.latestTag, "v1.0.1");
    assert.equal(payload.notes, "· 修好了更新");
    assert.equal(payload.asset.name, INSTALLER);
    assert.equal(payload.asset.size, 1234);
    assert.equal(payload.asset.digest, "sha256:" + "a".repeat(64));
    assert.equal(payload.releaseUrl, base.html_url);
  });

  test("下载地址不是 https://github.com 的一律拒绝（这个地址会被交给下载器）", () => {
    const evil = JSON.parse(JSON.stringify(base));
    evil.assets[0].browser_download_url = "https://evil.example.com/x.exe";
    assert.throws(() => releasePayloadFromRelease(evil, { repository: "o/r" }), /下载地址无效/u);
    const http = JSON.parse(JSON.stringify(base));
    http.assets[0].browser_download_url = "http://github.com/o/r/x.exe";
    assert.throws(() => releasePayloadFromRelease(http, { repository: "o/r" }), /下载地址无效/u);
    // beta 通道逐条挑时，这一类直接跳过（返回 null），不能让整条通道查不到更新
    assert.equal(releasePayloadFromRelease(evil, { optional: true, repository: "o/r" }), null);
  });

  test("没有安装包的条目：stable 报错、beta 跳过", () => {
    const noAsset = { ...base, assets: [{ name: "readme.txt", browser_download_url: "https://github.com/x" }] };
    assert.throws(() => releasePayloadFromRelease(noAsset, { repository: "o/r" }), /没有安装包/u);
    assert.equal(releasePayloadFromRelease(noAsset, { optional: true, repository: "o/r" }), null);
  });

  test("notes 截到 8000 字（Release 正文是用户可控文本，别把设置页撑爆）", () => {
    const long = { ...base, body: "啊".repeat(9000) };
    assert.equal(releasePayloadFromRelease(long, { repository: "o/r" }).notes.length, 8000);
  });
});

// ---------------------------------------------------------------- ④ 查询器

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const RELEASE_BODY = {
  tag_name: "v1.0.1",
  html_url: "https://github.com/o/r/releases/tag/v1.0.1",
  body: "说明",
  assets: [{
    id: 1, name: INSTALLER, size: 10, digest: "sha256:" + "b".repeat(64),
    browser_download_url: `https://github.com/o/r/releases/download/v1.0.1/${encodeURIComponent(INSTALLER)}`,
  }],
};

describe("查询器：去重、合并、退避", () => {
  test("三个并发只打一次外网；等待者拿到同一个结果", async () => {
    let calls = 0;
    const feed = createUpdateFeed({
      currentTag: "1.0.0",
      repository: "o/r",
      request: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return jsonResponse(RELEASE_BODY);
      },
    });
    const results = await Promise.all([feed.check(null, "stable"), feed.check(null, "stable"), feed.check(null, "stable")]);
    assert.equal(calls, 1, "同一通道的并发查询必须合并成一次（未登录配额只有 60 次/小时）");
    assert.deepEqual(results.map((r) => r.latestTag), ["v1.0.1", "v1.0.1", "v1.0.1"]);
    assert.equal(feed.stats().requests, 1);
  });

  test("失败也合并；★ reject 之后必须把 inflight 摘掉，否则这条通道被永久钉死", async () => {
    let calls = 0;
    const feed = createUpdateFeed({
      currentTag: "1.0.0",
      repository: "o/r",
      request: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("fetch failed");
      },
    });
    const settled = await Promise.allSettled([feed.check(null, "stable"), feed.check(null, "stable")]);
    assert.equal(calls, 1);
    assert.deepEqual(settled.map((s) => s.status), ["rejected", "rejected"]);
    // 立刻再查一次：失败缓存 60 秒内命中缓存（不打网络），但**不是**那个 rejected Promise：
    // 换个通道就该真打一次 —— 说明 inflight 已经被摘掉了。
    await assert.rejects(() => feed.check(null, "beta"), /fetch failed/u);
    assert.equal(calls, 2, "换了通道就该重新查一次；如果还钉在旧 Promise 上，这里会是 1");
  });

  test("成功结果 20 秒内去重，过了就重查", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const feed = createUpdateFeed({
      currentTag: "1.0.0",
      repository: "o/r",
      now: () => clock,
      request: async () => { calls += 1; return jsonResponse(RELEASE_BODY); },
    });
    await feed.check(null, "stable");
    await feed.check(null, "stable");
    assert.equal(calls, 1, "20 秒内的重复点击不该再打外网");
    clock += 20_001;
    await feed.check(null, "stable");
    assert.equal(calls, 2, "过了去重窗口要重查");
  });

  test("失败按原因分档退避：限流 5 分钟、普通故障 60 秒", async () => {
    let calls = 0;
    let clock = 0;
    let status = 403;
    const feed = createUpdateFeed({
      currentTag: "1.0.0",
      repository: "o/r",
      now: () => clock,
      request: async () => {
        calls += 1;
        return new Response("{}", { status, headers: { "x-ratelimit-remaining": "0" } });
      },
    });
    await assert.rejects(() => feed.check(null, "stable"), (error) => error.code === "UPDATE_RATE_LIMITED");
    assert.equal(failureTtl(Object.assign(new Error("x"), { code: "UPDATE_RATE_LIMITED" })), 5 * 60_000);
    assert.equal(failureTtl(new Error("x")), 60_000);
    await assert.rejects(() => feed.check(null, "stable"), /限流/u);
    assert.equal(calls, 1, "退避期内连本机缓存都不打外网");
    clock += 5 * 60_000 + 1;
    status = 500;
    await assert.rejects(() => feed.check(null, "stable"), /GitHub HTTP 500/u);
    assert.equal(calls, 2, "退避到期后要真查一次");
  });

  test("404（仓库还没有 Release）说人话，不是「HTTP 404」", async () => {
    const feed = createUpdateFeed({
      currentTag: "1.0.0", repository: "o/r",
      request: async () => new Response("{}", { status: 404 }),
    });
    await assert.rejects(() => feed.check(null, "stable"), /还没有发布任何版本/u);
  });

  test("beta 通道：逐个挑「有安装包的下一条」，全都没有才报错", async () => {
    const list = [
      { tag_name: "v1.2.0", draft: false, assets: [] },                       // 先建 Release 后传包
      { tag_name: "v1.1.0", draft: true, assets: RELEASE_BODY.assets },        // 草稿必须排除
      { tag_name: "v1.0.9", draft: false, assets: RELEASE_BODY.assets },
    ];
    const feed = createUpdateFeed({
      currentTag: "1.0.0", repository: "o/r",
      request: async (url) => {
        assert.match(String(url), /\/releases\?per_page=30$/u, "beta 走列表端点");
        return jsonResponse(list);
      },
    });
    const release = await feed.check(null, "beta");
    assert.equal(release.latestTag, "v1.0.9", "没有安装包的与草稿都要跳过");
  });

  test("仓库配置必须写成 owner/repo（拼 URL 前钉死形状）", () => {
    assert.throws(() => createUpdateFeed({ currentTag: "1.0.0", repository: "o" }), /仓库配置无效/u);
    assert.throws(() => createUpdateFeed({ currentTag: "1.0.0", repository: "" }), /仓库配置无效/u);
  });

  test("通道只认 stable / beta，别的值一律回到默认", () => {
    assert.deepEqual([...UPDATE_CHANNELS], ["stable", "beta"]);
    assert.equal(normalizeUpdateChannel("BETA"), "beta");
    assert.equal(normalizeUpdateChannel("nightly"), DEFAULT_UPDATE_CHANNEL);
    assert.equal(normalizeUpdateChannel(null), DEFAULT_UPDATE_CHANNEL);
  });
});

// ---------------------------------------------------------------- ⑤ 降级与成功应答

describe("应答形状", () => {
  test("降级：updateAvailable=false、latestTag 为空、自带发布页、绝不说「已是最新」", () => {
    const payload = buildUpdateFailurePayload({
      error: new Error("fetch failed"), channel: "stable", currentTag: "1.0.0", repository: "o/r",
    });
    assert.equal(payload.degraded, true);
    assert.equal(payload.updateAvailable, false);
    assert.equal(payload.latestTag, "");
    assert.equal(payload.releaseUrl, "https://github.com/o/r/releases");
    assert.match(payload.message, /无法连接更新服务/u);
    assert.doesNotMatch(payload.message, /已是最新/u);
  });

  test("限流单独一句（别把用户指去看网络）", () => {
    const error = Object.assign(new Error("GitHub 接口限流"), { code: "UPDATE_RATE_LIMITED" });
    const payload = buildUpdateFailurePayload({ error, channel: "beta", currentTag: "1.0.0", repository: "o/r" });
    assert.equal(payload.rateLimited, true);
    assert.match(payload.message, /限流/u);
    assert.equal(payload.channel, "beta");
  });

  test("成功：新版本 / 已是最新 / 本机更高，三种都由后端算", () => {
    const release = releasePayloadFromRelease(RELEASE_BODY, { repository: "o/r" });
    const newer = buildUpdatePayload({ release, channel: "stable", currentTag: "1.0.0", repository: "o/r" });
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.currentIsNewer, false);
    assert.equal(newer.degraded, false);

    const same = buildUpdatePayload({ release, channel: "stable", currentTag: "v1.0.1", repository: "o/r" });
    assert.equal(same.updateAvailable, false, "v 前缀不能被当成新版本");
    assert.equal(same.currentIsNewer, false);

    const ahead = buildUpdatePayload({ release, channel: "stable", currentTag: "1.9.0", repository: "o/r" });
    assert.equal(ahead.updateAvailable, false);
    assert.equal(ahead.currentIsNewer, true);
  });
});

// ---------------------------------------------------------------- ⑥ 断点续传（真跑）

/** 1204 端口已被 whatwg 列为禁用（fetch 直接抛 bad port）⇒ 抽到就换一个。 */
const FORBIDDEN_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);

/** 支持 `Range: bytes=N-` 的慢速下载源：慢到足以在传输中途按「暂停」。 */
async function startRangeServer(payload, { chunk = 64 * 1024, delay = 12 } = {}) {
  const seen = [];
  const etag = `"${createHash("sha1").update(payload).digest("hex")}"`;
  const server = createServer((req, res) => {
    const range = req.headers.range ?? null;
    seen.push({ range, ifRange: req.headers["if-range"] ?? null });
    const match = range ? /^bytes=(\d+)-$/u.exec(range) : null;
    let start = 0;
    if (range && !match) { res.writeHead(416); res.end(); return; }
    if (match) start = Number(match[1]);
    if (start >= payload.length) {
      res.writeHead(416, { "Content-Range": `bytes */${payload.length}` });
      res.end();
      return;
    }
    const body = payload.subarray(start);
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      ETag: etag,
      "Accept-Ranges": "bytes",
    };
    if (start > 0) headers["Content-Range"] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
    res.writeHead(start > 0 ? 206 : 200, headers);
    let offset = 0;
    let stopped = false;
    res.on("close", () => { stopped = true; });
    res.on("error", () => { stopped = true; });
    const pump = async () => {
      while (offset < body.length && !stopped) {
        const piece = body.subarray(offset, offset + chunk);
        offset += piece.length;
        if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (!stopped) res.end();
    };
    void pump();
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    if (!FORBIDDEN_PORTS.has(port)) {
      return { server, base: `http://127.0.0.1:${port}`, seen, etag };
    }
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("连续抽到禁用端口，放弃");
}

/**
 * 收尾。
 * ★ 必须**先 await downloader.close() 再删临时目录**：下载器完成时还有一次
 *   `persist()` 在 finally 里跑，状态文件正被写着；Windows 上这时 rmdir 会报
 *   ENOTEMPTY（实测 5 次里红 1 次）。这不是"偶发"，是收尾顺序错了。
 * ★ 删目录本身带重试：杀软/索引器偶尔还捏着句柄，一次失败不代表文件删不掉。
 */
async function teardown({ downloaders = [], server, root }) {
  for (const downloader of downloaders) await downloader?.close?.().catch(() => {});
  // 中止时最后一块 chunk 的写盘可能还在飞（pipeline 拒了，FileHandle 的写是异步的）。
  // close() 之后给一拍，比"删不掉再重试"更干净。
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await cleanupDir(root); return; } catch { /* 再试一次 */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** 把「假的 github 地址」映射到本地测试源的 request 层（生产校验仍然只认 https+github.com）。 */
const shimFor = (base) => (url, init) => fetch(String(url).replace("https://github.com", base), init);

async function waitFor(predicate, { timeout = 8000, step = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error("等超时了");
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

function releaseFor(payload) {
  return {
    latestTag: "1.0.1",
    releaseUrl: "https://github.com/o/r/releases/tag/v1.0.1",
    publishedAt: "2026-10-20T00:00:00Z",
    notes: "说明",
    releaseName: "1.0.1",
    asset: {
      id: 7,
      name: INSTALLER,
      url: `https://github.com/o/r/releases/download/v1.0.1/${encodeURIComponent(INSTALLER)}`,
      size: payload.length,
      digest: DIGEST(payload),
    },
  };
}

describe("断点续传（真服务 + 真字节）", () => {
  test("下载到一半暂停 → 关掉程序再开 → 续传只补剩下的字节 → SHA-256 通过 → 能装", async () => {
    const payload = randomBytes(2 * 1024 * 1024);
    const release = releaseFor(payload);
    const { server, base, seen } = await startRangeServer(payload);
    const root = await mkdtemp(join(tmpdir(), "linli-update-"));
    // ★ 下载器要留到 finally 里 close()：它完成时还有一次 persist() 在写状态文件，
    //   这时直接删临时目录会 ENOTEMPTY（实测算出来的偶发红）。
    //   `const` 在 try 块里声明的话 finally 看不见，所以用外面的数组收着。
    const handles = [];
    try {
      const request = shimFor(base);
      const first = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
      handles.push(first);
      const started = first.start();
      assert.equal(started.state, "connecting");
      // 等真的写进去一些（不是 0，也不是全部）
      await waitFor(async () => first.status().bytes > 0);
      const paused = await first.pause(first.status().jobId);
      assert.equal(paused.state, "paused");
      assert.ok(paused.bytes > 0 && paused.bytes < payload.length, `暂停时的字节数异常：${paused.bytes}`);
      const resumeFrom = paused.bytes;

      // ★ 关键一步：**新建一个下载器**（等价于用户关掉程序再打开）—— 进度是从磁盘恢复的。
      const second = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
      handles.push(second);
      const restored = second.status();
      assert.equal(restored.state, "paused", "重启后要能认出「上次是暂停的」");
      assert.equal(restored.bytes, resumeFrom, "重启后进度必须还是那个字节数");

      second.start();
      await waitFor(async () => second.status().state === "completed", { timeout: 15_000 });
      const done = second.status();
      assert.equal(done.bytes, payload.length);
      assert.equal(done.percent, 100);

      // ★ 续传那次请求必须带 `Range: bytes=<暂停时字节数>-`
      const ranged = seen.filter((entry) => entry.range);
      assert.equal(ranged.length, 1, `应当只有一次续传请求，实际 ${ranged.length}`);
      assert.equal(ranged[0].range, `bytes=${resumeFrom}-`);
      assert.equal(ranged[0].ifRange, seen[0].ifRange ?? ranged[0].ifRange);

      // ★ 落盘字节必须与源**逐个对得上**（断点续传最容易在这里错位）
      const written = await readFile(done.path);
      assert.equal(written.length, payload.length);
      assert.equal(createHash("sha256").update(written).digest("hex"), release.asset.digest.slice(7));
      assert.equal(done.sha256, release.asset.digest.slice(7));

      // 安装前再校验一次；路径不对必须拒
      await assert.rejects(() => second.prepareInstall(join(root, "别的地方.exe")), /不匹配/u);
      const ready = await second.prepareInstall(done.path);
      assert.equal(ready.path, done.path);
    } finally {
      await teardown({ downloaders: handles, server, root });
    }
  });

  test("进度记录的包变了（发布页重传）⇒ 旧进度作废，从头下（不许把两个版本拼一起）", async () => {
    const payload = randomBytes(512 * 1024);
    const release = releaseFor(payload);
    const { server, base, seen } = await startRangeServer(payload, { chunk: 32 * 1024, delay: 12 });
    const root = await mkdtemp(join(tmpdir(), "linli-update-stale-"));
    const handles = [];
    try {
      const request = shimFor(base);
      const first = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
      handles.push(first);
      first.start();
      await waitFor(async () => first.status().bytes > 0);
      await first.pause(first.status().jobId);

      // 模拟「同一个 .part 文件已经不是这个版本的了」（发布页重传过安装包）
      const absolute = (await readdirAll(root)).find((file) => file.endsWith("partial.json"));
      assert.ok(absolute, "应当有 partial.json 记录续传标识");
      await writeFile(absolute, JSON.stringify({ identity: "deadbeef", etag: null }));

      const second = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
      handles.push(second);
      second.start();
      await waitFor(async () => second.status().state === "completed", { timeout: 15_000 });
      assert.equal(second.status().bytes, payload.length);
      // 作废之后第一次请求不能带 Range（否则就是接着旧字节往后写）
      const after = seen.slice(seen.filter((entry) => entry.range).length);
      assert.equal(after[0].range, null, "进度作废后必须从 0 开始，不许带 Range");
    } finally {
      await teardown({ downloaders: handles, server, root });
    }
  });

  test("取消：传输中停手并把本次下载文件清掉（不留半截包占几百 MB）", async () => {
    const payload = randomBytes(1024 * 1024);
    const release = releaseFor(payload);
    const { server, base } = await startRangeServer(payload, { chunk: 32 * 1024, delay: 12 });
    const root = await mkdtemp(join(tmpdir(), "linli-update-cancel-"));
    const handles = [];
    try {
      const downloader = await createUpdateDownloader({
        root, fetchRelease: async () => release, request: shimFor(base), canInstall: () => true,
      });
      handles.push(downloader);
      downloader.start();
      await waitFor(async () => downloader.status().bytes > 0);
      const cancelled = await downloader.cancel(downloader.status().jobId);
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.bytes, 0);
      const leftovers = (await readdirAll(root)).filter((file) => file.endsWith(".part"));
      assert.deepEqual(leftovers, [], "取消之后不许留 .part");
    } finally {
      await teardown({ downloaders: handles, server, root });
    }
  });

  test("★ canInstall 说「不新」时，装不了（拦在本机，不靠界面）", async () => {
    const payload = randomBytes(64 * 1024);
    const release = releaseFor(payload);
    const { server, base } = await startRangeServer(payload, { chunk: 16 * 1024, delay: 4 });
    const root = await mkdtemp(join(tmpdir(), "linli-update-caninstall-"));
    const handles = [];
    try {
      const downloader = await createUpdateDownloader({
        root, fetchRelease: async () => release, request: shimFor(base),
        // 模拟「用户装的就是这一版」：canInstall 直接否
        canInstall: () => false,
      });
      handles.push(downloader);
      downloader.start();
      await waitFor(async () => downloader.status().state === "completed", { timeout: 10_000 });
      await assert.rejects(() => downloader.prepareInstall(downloader.status().path), /未就绪|不高于/u);
    } finally {
      await teardown({ downloaders: handles, server, root });
    }
  });
});

/** 递归列出文件（用于在 updates/<tag>/<hash>/ 里找 .part 与 partial.json）。 */
async function readdirAll(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await readdirAll(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 2026-10-20 追加
//
// 真实事故（60 分钟压测 1/42 次红，重跑即绿）：断点续传那条用例在"状态已是 completed"之后
// 立刻调 prepareInstall，被拒了，报的是
//   「安装包未就绪或版本不高于当前版本，请重新检查更新」
// 而它期望的是"路径不对"那条 /不匹配/。
// 根因在产品：`pending` 是在 finally 里清的，且排在 `await persist()` **之后** ⇒
// 下载已完成、状态文件还没落盘的那个窗口里，"下载进行中"这个标志仍然挂着。
// ⇒ 界面显示 100%，用户点安装却被说"未就绪"；机器越忙窗口越长。
//
// ★ 这条用例守的是"完成即可装"：状态一变成 completed，**不许有任何等待**就得能拿到门票。

test("下载一完成就能装：状态变 completed 之后立刻 prepareInstall 必须成功", async () => {
  const payload = randomBytes(256 * 1024);
  const release = releaseFor(payload);
  const { server, base } = await startRangeServer(payload, { chunk: 32 * 1024, delay: 4 });
  const root = await mkdtemp(join(tmpdir(), "linli-update-ready-"));
  const handles = [];
  try {
    const request = shimFor(base);
    const dl = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
    handles.push(dl);
    dl.start();
    // ★ 关键：**贴着**状态翻转的那一刻去问，不能用 20ms 的轮询 ——
    //   20ms 的轮询会把"已完成但 pending 还没清"那个窗口整个错过，判据就成了摆设。
    //   status() 是纯本地读（不耗 I/O），所以用 setImmediate 每个事件循环轮转一次；
    //   而 persist() 是文件写（要等 I/O 回调），此刻一定还没落盘 ⇒ pending 仍挂着。
    const deadline = Date.now() + 15000;
    let done = null;
    while (Date.now() < deadline) {
      const s = dl.status();
      if (s.state === "completed") { done = s; break; }
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(done, "下载应当完成");

    // ★ 中间不许有 await：这一下就踩在"已完成但 pending 还没清"的窗口上。
    const ready = await dl.prepareInstall(done.path);
    assert.equal(ready.path, done.path, "下载完成就该能装");
    // 路径不对仍然必须拒（这一条不许被上面的放宽带坏）
    await assert.rejects(() => dl.prepareInstall(join(root, "别的地方.exe")), /不匹配/u);
  } finally {
    await teardown({ downloaders: handles, server, root });
  }
});

test("下载**进行中**不许拿到安装门票（别把上面的放宽变成漏洞）", async () => {
  const payload = randomBytes(4 * 1024 * 1024);
  const release = releaseFor(payload);
  const { server, base } = await startRangeServer(payload, { chunk: 8 * 1024, delay: 40 });
  const root = await mkdtemp(join(tmpdir(), "linli-update-busy-"));
  const handles = [];
  try {
    const request = shimFor(base);
    const dl = await createUpdateDownloader({ root, fetchRelease: async () => release, request, canInstall: () => true });
    handles.push(dl);
    dl.start();
    await waitFor(async () => dl.status().bytes > 0);
    assert.ok(dl.status().running, "此刻应当还在下载中");
    // 下载中 ⇒ 必须拿不到门票（哪怕路径猜对了）
    await assert.rejects(() => dl.prepareInstall(join(root, "x.exe")), /未就绪/u);
  } finally {
    await teardown({ downloaders: handles, server, root });
  }
});
