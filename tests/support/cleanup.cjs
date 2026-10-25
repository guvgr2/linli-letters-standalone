/**
 * 测试里删目录的统一入口（2026-10-20 新增）。
 *
 * ★ 为什么要有它（不是"整理代码"，是**修一个会长期制造假红的缺陷**）：
 *   60 分钟压测里 42 次车道运行红了 7 次，其中一次的真实报错是
 *     `ENOTEMPTY: directory not empty, rmdir '…\Temp\linli-soul-MU5UVL'`
 *   原因：Windows 上刚写完/刚改名的文件会短暂处于 pending-delete，
 *   这时 `fs.rm(dir, { recursive: true })` 会抛 ENOTEMPTY / EBUSY / EPERM；
 *   本机安全软件的 safe-delete 垫片还会抛 ETIMEDOUT（**不在 Node 的内建重试表里**）。
 *   而当时全仓 23 个测试文件**各写各的 rm**，一处修别处照红。
 *
 * ★ 这里的重试是有界的：只对上面那五种错误码重试（别的错照原样抛，别把真缺陷吞掉），
 *   每次退避 100/200/300…ms，最多 6 次。删目录本来就是幂等的，重试不会掩盖问题。
 *
 * 用法：
 *   ESM 用例： import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";
 *   CJS 用例： const { cleanupDir } = require("./support/cleanup.cjs");
 */

const { rm } = require("node:fs/promises");
const { rmSync } = require("node:fs");

/** 只重试这些：都是"文件系统的临时状态"，不是"真删不掉"。 */
const RETRYABLE = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES", "ETIMEDOUT"]);
const ATTEMPTS = 6;
const BASE_DELAY_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 同步版用的睡法（Atomics.wait 不占事件循环）。 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 删一个目录（递归）。
 * @param {string} dir
 * @param {{attempts?: number, rmImpl?: Function}} [options] rmImpl 供测试注入假实现。
 */
async function cleanupDir(dir, options = {}) {
  const attempts = options.attempts ?? ATTEMPTS;
  const rmImpl = options.rmImpl ?? rm;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // ★ maxRetries/retryDelay 是 Node 内建的退避（只认 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM）；
      //   外面这一层专门补 ETIMEDOUT（安全软件垫片）与"内建退避也用光了"的情况。
      await rmImpl(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return true;
    } catch (error) {
      last = error;
      if (!RETRYABLE.has(error && error.code)) throw error;
      await sleep(BASE_DELAY_MS * (i + 1));
    }
  }
  throw last;
}

/** 同步版（`finally { fs.rmSync(...) }` 这类地方用）。 */
function cleanupDirSync(dir, options = {}) {
  const attempts = options.attempts ?? ATTEMPTS;
  const rmImpl = options.rmSyncImpl ?? rmSync;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmImpl(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return true;
    } catch (error) {
      last = error;
      if (!RETRYABLE.has(error && error.code)) throw error;
      sleepSync(BASE_DELAY_MS * (i + 1));
    }
  }
  throw last;
}

module.exports = { cleanupDir, cleanupDirSync, RETRYABLE, ATTEMPTS };
