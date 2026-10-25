import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_BLOCKED_PORTS, portAcceptable } from "../app/ports.mjs";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

/**
 * 这一组守的是「随机端口撞进浏览器黑名单 ⇒ 关掉重选」这条分支。
 *
 * 为什么必须用**确定性**手段（advisor 2026-10-19 的追问）：这条分支是整轮改动里
 * 唯一新增的代码路径，而它只有在真撞上 6000/6666/10080 之类时才执行。原来只跑 5 次
 * 全量测试（Flake 率约 1/5）、且那 5 次里未必真执行过它 —— 用「没红」证明「分支对」
 * 本身就是假绿。所以这里分两层：
 *   ① 纯函数层：直接喂 6000 等黑名单端口，断言它判 false；喂 9034 判 true；
 *      显式要求 6000（requested !== 0）判 true（不许偷偷换掉用户指定端口）。
 *   ② 端到端层：用 `LINLI_TEST_FORCE_BLOCKED_PORT=6000` 让第一次 listen 被当成
 *      6000 来判，跑真实服务，断言输出里**先**有 `LINLI_PORT_RETRY=6000`、**后**有
 *      `LINLI_PORT=<真端口>`，且真端口不是 6000，并且这个端口上 `/api/session` 真能取到令牌
 *      —— 也就是「关掉重来」之后服务确实还能用，不是关掉就没起来。
 */

const HERE = dirnameOf(import.meta.url);
function dirnameOf(url) {
  return resolve(fileURLToPath(url), "..", "..");
}

describe("端口黑名单：判据本身", () => {
  test("① 浏览器黑名单端口（随机分配时）必须判为不可用", () => {
    for (const port of [6000, 6666, 10080]) {
      assert.equal(portAcceptable(port, 0), false, `${port} 应当不可用`);
      assert.ok(BROWSER_BLOCKED_PORTS.has(port), `${port} 应当在名单里`);
    }
  });

  test("② 普通端口判为可用", () => {
    for (const port of [9034, 27580, 5173]) {
      assert.equal(portAcceptable(port, 0), true, `${port} 应当可用`);
    }
  });

  test("③ 显式指定的端口一律认（哪怕它在黑名单里）", () => {
    // 外壳/生产都会显式给端口；偷偷换掉会让外壳连不上。
    assert.equal(portAcceptable(6000, 6000), true);
  });
});

function waitLines(child, timeoutMs = 20000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`等端口输出超时；已收到：\n${out}`));
    }, timeoutMs);
    const onData = (chunk) => {
      out += chunk.toString("utf8");
      const retried = out.includes("LINLI_PORT_RETRY=");
      const announced = /^LINLI_PORT=\d+$/mu.test(out);
      if (retried && announced) {
        clearTimeout(timer);
        resolvePromise(out);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`服务提前退出 code=${code}：\n${out}`));
    });
  });
}

describe("端口黑名单：真的会关掉重选", () => {
  test("④ 撞黑名单 ⇒ 先报 RETRY 再报真端口，且服务能取到令牌", async () => {
    const dir = await mkdtemp(join(tmpdir(), "linli-port-"));
    const child = spawn(process.execPath, [join(HERE, "app", "server.mjs")], {
      cwd: HERE,
      env: {
        ...process.env,
        LINLI_DATA_DIR: dir,
        LINLI_PORT: "0",
        LINLI_NO_GAME_ASSETS: "1",
        LINLI_NO_SHELL_OPEN: "1",
        // 关键：让第一次 listen 被当成 6000 来判 ⇒ 一定进重选分支
        LINLI_TEST_FORCE_BLOCKED_PORT: "6000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const out = await waitLines(child);
      const iRetry = out.indexOf("LINLI_PORT_RETRY=6000");
      const iPort = out.indexOf("LINLI_PORT=", iRetry);
      assert.ok(iRetry >= 0, `没看到 LINLI_PORT_RETRY=6000：\n${out}`);
      assert.ok(iPort > iRetry, `真端口必须出现在 RETRY 之后：\n${out}`);

      const real = Number((out.match(/^LINLI_PORT=(\d+)$/mu) ?? [])[1]);
      assert.ok(Number.isInteger(real) && real > 0, `没解析到真端口：\n${out}`);
      assert.notEqual(real, 6000, "真端口不许还是 6000");

      const r = await fetch(`http://127.0.0.1:${real}/api/session`);
      assert.equal(r.status, 200, "重选之后的端口必须真的能连");
      const body = await r.json();
      assert.ok(typeof body.token === "string" && body.token.length > 10);
    } finally {
      // 先等进程真退出再删目录：Windows 上服务还握着 letters.sqlite 时 rm 会 EBUSY。
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
      await cleanupDir(dir);
    }
  });
});
