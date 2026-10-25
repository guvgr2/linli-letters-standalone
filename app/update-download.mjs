// 更新包下载器：**断点续传**（用户 2026-10-20 口径「好像还有更新断点续传，你仔细借鉴一下吧」）。
//
// 整套逻辑抄原版程序 `update-download.js`（那边被压测和真机验证过），改动只有三处：
//   ① 安装包名判定换成**本仓**的 `OliviaSoul-…-安装程序.exe`（姊妹是 `-Setup.exe`）；
//   ② 落盘根目录由调用方传（本仓是 `<数据目录>\updates`）；
//   ③ 下载地址再校验一次 https + github.com（那里的 identity() 已经校验过，这里是纵深防御）。
//
// 断点续传到底靠什么成立，四件事缺一不可：
//   1. `.part` 文件 + `partial.json` 记 `{identity, etag}`：`identity` 是 tag/名字/大小/摘要的哈希，
//      只要发布页上的包变了，旧进度立刻作废（不会把两个版本的字节拼在一起）；
//   2. 续传请求发 `Range: bytes=<offset>-` + `If-Range: <etag>`：服务器换了文件会回 200 全量，
//      我们照 206 的 `Content-Range` 逐项核对（起点、终点、总长、etag），对不上就当场报错而不是写坏；
//   3. 暂停 = 中止传输但**保留 .part**，状态写 `paused` 落盘；下次进程启动还能接着下；
//   4. 全部下完先核对大小再核 SHA-256，通过才 rename 成正式文件名。
//      摘要对不上就把 `.part` 改名成 `.invalid-<uuid>`（留着给人查，不参与下次续传）。
//
// ★ 一个刻意的口径：`completed` 状态**不授权安装**。安装前 `prepareInstall()` 会重新算一遍
//   SHA-256 —— 状态文件是可以被改的，只有字节对得上才算数。

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isInstallerAssetName } from "./updater.mjs";

const MAX_BYTES = 1024 ** 3;               // 1 GB 上限：比这大的"安装包"一定是配置错了
const IDLE_TIMEOUT_MS = 120_000;           // 连续两分钟收不到数据就停手，进度留着
export const STALE_ASSET = "UPDATE_STALE_ASSET";

const staleAsset = (message) => Object.assign(new Error(message), { code: STALE_ASSET });

/** 校验一条 Release 能不能用来下载；不合格直接抛（调用方按"配置/发布页有问题"处理）。 */
function identity(release) {
  const { latestTag: tag, asset = {} } = release ?? {};
  if (!/^[\w.-]+$/u.test(tag ?? "") || tag === "." || tag === ".."
    || !isInstallerAssetName(asset.name)
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES
    // ★ 必须带 sha256 摘要：没有摘要就无从校验，宁可不下载（发布页手动下）。
    || !/^sha256:[a-f0-9]{64}$/u.test(String(asset.digest ?? "").toLowerCase())
    || !(() => { try { const u = new URL(String(asset.url ?? "")); return u.protocol === "https:" && u.hostname === "github.com"; } catch { return false; } })()) {
    throw new Error("安装包版本、大小或 SHA-256 信息无效");
  }
  return {
    tag, id: String(asset.id ?? ""), name: String(asset.name), url: String(asset.url),
    size: asset.size, digest: String(asset.digest).toLowerCase(),
  };
}

const keyOf = (info) => createHash("sha256").update(JSON.stringify(info)).digest("hex");

async function sizeOf(path) {
  try { return (await stat(path)).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

async function hashOf(path, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/** 每个可写子路径都必须是 updates 目录里的普通路径：拒绝 reparse point / 符号链接逃逸。 */
async function safePath(root, path) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("更新保存路径无效");
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("更新目录不能使用链接路径"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function createUpdateDownloader({
  root, fetchRelease, request = fetch, canInstall = () => true,
  idleTimeoutMs = IDLE_TIMEOUT_MS, renewRelease = null, now = () => performance.now(),
}) {
  root = resolve(root);
  const stateFile = join(root, "download-state.json");
  const empty = () => ({
    state: "idle", jobId: null, bytes: 0, totalBytes: 0, percent: 0,
    bytesPerSecond: 0, remainingSeconds: null, error: null,
  });
  let state = empty();
  let pending = null, aborter = null, closed = false, saved = null;
  let cancelling = null, cancellable = null, pausing = null;
  let createdTarget = false;
  let samples = [], transferStarted = 0;

  function speedSnapshot() {
    const time = now();
    samples = samples.filter((sample) => time - sample.time < 5000);
    if (time - transferStarted < 1000) return { bytesPerSecond: 0, remainingSeconds: null };
    const bytesPerSecond = Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0)
      / Math.max(0.001, Math.min(5000, time - transferStarted) / 1000));
    return {
      bytesPerSecond,
      remainingSeconds: bytesPerSecond ? Math.ceil((state.totalBytes - state.bytes) / bytesPerSecond) : null,
    };
  }

  const atomicJson = async (path, value) => {
    await safePath(root, path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    // flag "wx"：临时名撞车就报错，不覆盖别人正在写的文件。
    await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
    await rename(temporary, path);
  };

  const paths = (info) => {
    const dir = join(root, info.tag, keyOf(info));
    return {
      dir,
      target: join(dir, info.name),
      part: join(dir, `${info.name}.part`),
      metadata: join(dir, "partial.json"),
    };
  };

  const persist = async () => {
    await safePath(root, stateFile);
    await mkdir(root, { recursive: true });
    await atomicJson(stateFile, { info: saved, state: state.state });
  };

  // —— 启动时恢复上次的任务 ——
  await safePath(root, stateFile);
  try {
    const record = JSON.parse(await readFile(stateFile, "utf8"));
    if (record.state === "paused") state.state = "paused";
    if (record.info) {
      const info = identity({ latestTag: record.info.tag, asset: { ...record.info, size: record.info.size } });
      const p = paths(info);
      await safePath(root, p.part);
      await safePath(root, p.target);
      const bytes = Math.min(info.size, (await sizeOf(p.target)) || (await sizeOf(p.part)));
      // ★ 持久化里的 "completed" 不许直接授权安装 —— 安装前 prepareInstall() 会重新校验。
      state = {
        ...state,
        state: record.state === "paused" ? "paused" : "idle",
        tag: info.tag, bytes, totalBytes: info.size, percent: 100 * bytes / info.size,
      };
      saved = info;
      cancellable = record.state === "completed" ? null : info;
    }
  } catch (error) {
    if (error.code !== "ENOENT") state.error = "未能恢复上次下载状态，可重新下载";
  }

  async function run(signal) {
    signal.throwIfAborted();
    let info = identity(await fetchRelease(signal));
    signal.throwIfAborted();
    for (let attempt = 0; ; attempt += 1) {
      try { await transferOnce(info, signal); return; }
      catch (error) {
        // 只在「拿到的内容和记录不符」时重查一次发布页：正常路径一次网络都不多打，
        // 所以不会重新引入「检查成功、点下载却正好撞在限流上」。
        if (attempt > 0 || !renewRelease || error?.code !== STALE_ASSET) throw error;
        signal.throwIfAborted();
        const renewed = identity(await renewRelease(signal));
        if (keyOf(renewed) === keyOf(info)) {
          throw new Error(`${error.message}；发布页上的安装包记录没有变化，请稍后重试或到发布页手动下载`);
        }
        const previous = paths(info);
        info = renewed;
        // 旧地址的部分下载已经没用了（新地址落在新目录），顺手清掉，别在数据目录里留几百 MB。
        try { await safePath(root, previous.dir); await rm(previous.dir, { recursive: true, force: true }); }
        catch { /* 清不掉旧目录不影响新任务 */ }
      }
    }
  }

  async function transferOnce(info, signal) {
    const p = paths(info);
    saved = info;
    cancellable = info;
    state = { ...state, tag: info.tag, bytes: 0, totalBytes: info.size, percent: 0 };
    for (const path of Object.values(p)) await safePath(root, path);
    await mkdir(p.dir, { recursive: true });
    await persist();

    // 已经下完过（正式文件名已在）：只重算摘要，不做网络往返。
    if (await sizeOf(p.target)) {
      state.state = "verifying";
      state.bytes = info.size;
      state.percent = 100;
      if (await sizeOf(p.target) === info.size && await hashOf(p.target, signal) === info.digest) {
        state = { ...state, state: "completed", path: p.target, sha256: info.digest.slice(7), remainingSeconds: 0 };
        return;
      }
      await rename(p.target, `${p.target}.invalid-${randomUUID()}`);
    }

    let metadata;
    try { metadata = JSON.parse(await readFile(p.metadata, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }

    let offset = await sizeOf(p.part);
    // ★ 进度作废的两个条件：记录对不上（发布页换了包）或已超过声明大小。
    if (offset && (metadata?.identity !== keyOf(info) || offset > info.size)) {
      await rename(p.part, `${p.part}.invalid-${randomUUID()}`);
      offset = 0;
    }
    state.bytes = offset;
    state.percent = offset * 100 / info.size;

    if (offset < info.size) {
      const transfer = new AbortController();
      const transferSignal = AbortSignal.any([signal, transfer.signal]);
      let timer;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => transfer.abort(new Error("连续两分钟未收到数据，已保留进度，可重试下载")), idleTimeoutMs);
      };
      touch();
      try {
        const headers = { "User-Agent": "LinliLetters-Updater" };
        if (offset) {
          headers.Range = `bytes=${offset}-`;
          if (metadata.etag) headers["If-Range"] = metadata.etag;
        }
        const response = await request(info.url, { headers, signal: transferSignal });
        let accepted = false;
        try {
          // 404：地址已经不在发布页上了（Release 撤下 / 安装包重传后换了地址）。
          if (response.status === 404) throw staleAsset("下载 HTTP 404（安装包已不在发布页上）");
          if (!response.ok || !response.body) throw new Error(`下载 HTTP ${response.status}`);
          const etag = response.headers.get("etag");
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
            if (!range || Number(range[1]) !== offset || Number(range[2]) !== info.size - 1
              || Number(range[3]) !== info.size || (offset && metadata?.etag && etag && metadata.etag !== etag)) {
              throw new Error("服务器返回的续传位置或文件标识不一致，已保留原进度");
            }
          } else if (response.status === 200) offset = 0;   // 服务器不认 Range：从头来
          else throw new Error(`不支持的下载响应 HTTP ${response.status}`);
          const contentLength = response.headers.get("content-length");
          if (contentLength !== null && Number(contentLength) !== info.size - offset) {
            throw staleAsset("服务器返回的安装包长度不一致");
          }
          await atomicJson(p.metadata, { identity: keyOf(info), etag: etag && !etag.startsWith("W/") ? etag : null });
          state.state = "downloading";
          state.bytes = offset;
          state.percent = offset * 100 / info.size;
          transferStarted = now();
          samples = [];
          let received = 0;
          const output = await open(p.part, offset ? "a" : "w");
          try {
            const writer = new Writable({
              write(chunk, _encoding, callback) {
                touch();
                if (offset + received + chunk.length > info.size) return callback(new Error("安装包超过声明大小"));
                output.writeFile(chunk).then(() => {
                  received += chunk.length;
                  state.bytes = offset + received;
                  state.percent = state.bytes * 100 / info.size;
                  const time = now();
                  const lastSample = samples.at(-1);
                  if (lastSample && time - lastSample.time < 250) lastSample.bytes += chunk.length;
                  else samples.push({ time, bytes: chunk.length });
                  Object.assign(state, speedSnapshot());
                  callback();
                }, callback);
              },
            });
            accepted = true;
            await pipeline(Readable.fromWeb(response.body), writer, { signal: transferSignal });
          } finally { await output.close(); }
        } finally {
          if (!accepted) await response.body?.cancel().catch(() => {});
        }
      } catch (error) {
        if (transfer.signal.aborted) throw transfer.signal.reason;
        throw error;
      } finally { clearTimeout(timer); }
    }

    state.state = "verifying";
    state.bytesPerSecond = 0;
    state.remainingSeconds = null;
    if (await sizeOf(p.part) !== info.size) throw new Error("安装包尚未下载完整，已保留进度");
    if (await hashOf(p.part, signal) !== info.digest) {
      await rename(p.part, `${p.part}.invalid-${randomUUID()}`);
      state.bytes = 0;
      state.percent = 0;
      throw staleAsset("安装包 SHA-256 校验失败，重试将重新下载");
    }
    signal.throwIfAborted();
    await rename(p.part, p.target);
    createdTarget = true;
    state = {
      ...state, state: "completed", bytes: info.size, percent: 100, path: p.target,
      sha256: info.digest.slice(7), remainingSeconds: 0,
    };
  }

  return {
    /** 安装前唯一的门票：路径必须等于本次任务的 target，且（重新算过的）摘要仍然对得上。 */
    async prepareInstall(path) {
      const ready = state;
      const info = saved;
      // ★ 2026-10-20 修（60 分钟压测里 update-20261020 红过一次的真实报错）：
      //   `pending` 是在 finally 里清的，而且排在 `await persist()` **之后** ⇒
      //   下载已完成（状态已是 completed）、但状态文件还没落盘的那一小段窗口里，
      //   `pending` 仍然非空 ⇒ 点「安装」被拒，提示"安装包未就绪或版本不高于当前版本" ——
      //   而界面上明明是 100%。机器越忙（磁盘慢、安全软件在扫）这个窗口越长。
      //   所以：**状态已经是 completed 就不拿 pending 挡**。
      //   新一轮下载会把 `state` 换成 connecting/downloading，那条 `state === ready && ready.state === "completed"`
      //   仍然挡得住 —— 真正要防的是"下载进行中"，不是"刚落盘"。
      const busy = Boolean(pending) && ready.state !== "completed";
      const allowed = () => !closed && !busy && !cancelling && !pausing && state === ready
        && ready.state === "completed" && info && canInstall(info.tag);
      if (!allowed()) throw new Error("安装包未就绪或版本不高于当前版本，请重新检查更新");
      const target = paths(info).target;
      if (resolve(String(path ?? "")) !== target) throw new Error("安装路径与当前校验通过的任务不匹配");
      await safePath(root, target);
      if (await sizeOf(target) !== info.size || await hashOf(target) !== info.digest || !allowed()) {
        throw new Error("安装包校验失败或任务已变化，请重新检查更新");
      }
      return { path: target };
    },
    status() {
      return {
        ...state,
        ...(cancelling ? { state: "cancelling" } : pausing ? { state: "pausing" } : {}),
        ...(state.state === "downloading" ? speedSnapshot() : {}),
        running: Boolean(pending || cancelling || pausing),
      };
    },
    start() {
      if (closed) throw new Error("更新服务正在关闭");
      if (pending || cancelling || pausing || ["connecting", "downloading", "verifying"].includes(state.state)) {
        return this.status();
      }
      createdTarget = false;
      cancellable = state.state === "completed" ? null : saved;
      state = {
        state: "connecting", jobId: randomUUID(), bytes: state.bytes, totalBytes: state.totalBytes,
        percent: state.percent, bytesPerSecond: 0, remainingSeconds: null, error: null,
      };
      aborter = new AbortController();
      pending = Promise.resolve().then(() => run(aborter.signal)).catch(async (error) => {
        state.state = "failed";
        state.bytesPerSecond = 0;
        state.remainingSeconds = null;
        state.error = closed ? "程序已退出，下载进度已保留" : String(error?.message || error);
        delete state.path;
        if (saved) {
          const p = paths(saved);
          state.bytes = await sizeOf(p.part).catch(() => 0);
          state.percent = state.totalBytes ? state.bytes * 100 / state.totalBytes : 0;
        }
      }).finally(async () => {
        try { if (saved) await persist(); }
        catch { state.error = `${state.error || ""} 下载状态保存失败`.trim(); }
        pending = null;
      });
      return this.status();
    },
    pause(jobId) {
      if (jobId !== state.jobId) return Promise.reject(new Error("下载任务已变化，请刷新后重试"));
      if (cancelling) return cancelling;
      if (pausing) return pausing;
      if (!pending) return Promise.resolve(this.status());
      aborter?.abort(new Error("用户暂停下载"));
      pausing = (async () => {
        await pending;
        try {
          if (state.state !== "completed") {
            state.state = "paused";
            state.bytesPerSecond = 0;
            state.remainingSeconds = null;
            state.error = null;
            delete state.path;
            await persist();
          }
        } catch (error) {
          state.state = "failed";
          state.error = `下载已停止，但暂停状态保存失败：${error.message}`;
          throw new Error(state.error);
        } finally { pausing = null; }
        return this.status();
      })();
      return pausing;
    },
    cancel(jobId) {
      if (jobId !== state.jobId) return Promise.reject(new Error("下载任务已变化，请刷新后重试"));
      if (cancelling) return cancelling;
      if (state.state === "cancelled") return Promise.resolve(this.status());
      // 已完成的包不许被一个迟到的「取消」删掉；但传输中被接受的取消仍然拥有清理权。
      if (!pending && state.state === "completed") return Promise.reject(new Error("下载任务已完成，不能取消"));
      aborter?.abort(new Error("用户取消下载"));
      cancelling = (async () => {
        if (pausing) await pausing.catch(() => {});
        await pending;
        try {
          if (cancellable) {
            const p = paths(cancellable);
            const files = [p.part, p.metadata, ...(createdTarget ? [p.target] : [])];
            for (const file of files) await safePath(root, file);
            for (const file of files) await rm(file, { force: true });
          }
          saved = null;
          cancellable = null;
          state = { ...empty(), state: "cancelled", jobId };
          await persist();
        } catch (error) {
          state.state = "failed";
          state.error = `下载已停止，但清理失败：${error.message}`;
          delete state.path;
          throw new Error(state.error);
        } finally { cancelling = null; }
        return this.status();
      })();
      return cancelling;
    },
    async close() {
      closed = true;
      aborter?.abort();
      await pending;
      await pausing;
      await cancelling;
    },
    /** 测试用：当前落盘根目录。 */
    root: () => root,
  };
}
