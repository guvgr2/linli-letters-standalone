/**
 * 统一清理封装的护栏（2026-10-20）。
 *
 * 背景：60 分钟压测里 42 次车道运行红了 7 次，其中 `soul-archive` ⑯c 的真实报错是
 *   `ENOTEMPTY: directory not empty, rmdir '…\Temp\linli-soul-MU5UVL'`
 * 根因是 Windows 的 pending-delete 让 `fs.rm(recursive)` 抛错，而当时**全仓 23 个测试文件
 * 各写各的 rm** —— 修一个点，换个文件照红。
 *
 * 这条用例守两件事：
 *   ① **形态**：tests/ 下不允许再出现裸的 `rm(..., { recursive: true })` / `rmSync(...)`
 *      （唯一例外是封装自己与本文件 —— 本文件的正则里必然出现这些字样）；
 *   ② **行为**：封装真的要重试，而且只对"临时状态"那几种错误码重试。
 *
 * ★ 为什么行为要用「注入假实现」来测：真去制造 ENOTEMPTY 在 Windows 上不可靠
 *   （要靠别的进程占着文件）。注入假实现能把"重试几次""错码不重试"钉死。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync, RETRYABLE } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS = HERE;

describe("清理统一走封装：形态 + 行为", () => {
  test("① tests/ 下没有裸的 rm(recursive) / rmSync(recursive) 了", () => {
    const offenders = [];
    for (const name of readdirSync(TESTS)) {
      if (!name.endsWith(".test.js")) continue;
      if (name === "cleanup-unify-20261020.test.js") continue;   // 本文件自己的正则里必然有这些字样
      const src = readFileSync(join(TESTS, name), "utf8");
      // 逐行看：**行内**出现 rm( 且同一个 rm( 调用里带 recursive: true
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const calls = line.match(/(?:^|[^\w.])(?:fs\.)?rm(?:Sync)?\([^;]*recursive:\s*true[^;]*\)/gu);
        if (calls) offenders.push(`${name}:${i + 1}  ${calls[0].slice(0, 80)}`);
      });
    }
    assert.deepEqual(offenders, [],
      `这些文件又自己写 rm(recursive) 了 —— 会重演 pending-delete 假红：\n${offenders.join("\n")}`);
  });

  test("② 封装真的重试：前两次 ENOTEMPTY，第三次成功", async () => {
    let calls = 0;
    const rmImpl = async () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error("ENOTEMPTY: directory not empty");
        e.code = "ENOTEMPTY";
        throw e;
      }
    };
    const ok = await cleanupDir("C:/不存在的目录", { rmImpl });
    assert.equal(ok, true);
    assert.equal(calls, 3, `应当重试到第 3 次才成功，实际调了 ${calls} 次`);
  });

  test("② 不是临时状态的错误**不重试**、原样抛出（别把真缺陷吞掉）", async () => {
    let calls = 0;
    const rmImpl = async () => {
      calls += 1;
      const e = new Error("EPERM: operation not permitted, chmod");
      e.code = "EPERM";
      throw e;
    };
    await assert.rejects(() => cleanupDir("C:/x", { rmImpl }), /EPERM/);
    // EPERM 也在重试集合里（Windows 锁文件时就是它）⇒ 应当重试到上限再抛
    assert.ok(calls > 1, `EPERM 应当重试（它在重试集合里），实际只调了 ${calls} 次`);

    let other = 0;
    const rmImpl2 = async () => {
      other += 1;
      const e = new Error("EACCES: denied");
      e.code = "EACCES";
      throw e;
    };
    // ★ 注意写法：必须是 `{ rmImpl: rmImpl2 }`。写成 `{ rmImpl2 }`（简写）的话对象键会变成
    //   "rmImpl2"，封装找不到注入的假实现 ⇒ 拿真 rm 去删一个不存在的目录 ⇒ 静默成功，
    //   断言「应当抛错」就变成了「没抛」——**一个自己写错的判据，而且它当时还挺绿**。
    await assert.rejects(() => cleanupDir("C:/x", { rmImpl: rmImpl2 }), /EACCES/);
    assert.equal(other, 6, `EACCES 在重试集合里 ⇒ 应当试满 6 次再抛（实际 ${other} 次）`);

    let foreign = 0;
    const rmImpl3 = async () => {
      foreign += 1;
      const e = new Error("EINVAL: bad argument");
      e.code = "EINVAL";
      throw e;
    };
    await assert.rejects(() => cleanupDir("C:/x", { rmImpl: rmImpl3 }), /EINVAL/);
    assert.equal(foreign, 1, `不在重试集合里的错误码必须**一次就抛**（实际调了 ${foreign} 次）`);
  });

  test("② 重试是有界的：一直失败就抛最后一次错，不会无限打转", async () => {
    let calls = 0;
    const rmImpl = async () => {
      calls += 1;
      const e = new Error("ENOTEMPTY: directory not empty");
      e.code = "ENOTEMPTY";
      throw e;
    };
    await assert.rejects(() => cleanupDir("C:/x", { rmImpl, attempts: 3 }), /ENOTEMPTY/);
    assert.equal(calls, 3, `应当正好试 3 次，实际 ${calls}`);
  });

  test("② 真删一个目录：封装能用，目录真的没了", async () => {
    const dir = await mkdtemp(join(tmpdir(), "linli-clean-"));
    await mkdir(join(dir, "子目录"), { recursive: true });
    await writeFile(join(dir, "子目录", "a.txt"), "x");
    assert.ok(existsSync(dir));
    await cleanupDir(dir);
    assert.equal(existsSync(dir), false, "cleanupDir 说删了，目录还在");
  });

  test("② 重试集合里包含 Windows 上真会遇到的五种错误码", () => {
    for (const code of ["ENOTEMPTY", "EBUSY", "EPERM", "EACCES", "ETIMEDOUT"]) {
      assert.ok(RETRYABLE.has(code), `重试集合里少了 ${code}`);
    }
    // ETIMEDOUT **不在** Node 内建 maxRetries 的表里 —— 这正是要自己兜一层的原因
    assert.ok(!["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes("ETIMEDOUT"));
  });
});
