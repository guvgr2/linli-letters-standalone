/**
 * 首装曲库：没选过曲库目录时，接口必须说「还没选」，不能说「目录不存在」。
 *
 * 为什么单开一份（2026-10-19 第十六轮审查 §3）：
 *   原来 `app/server.mjs` 的默认曲库目录是开发机自己的 `E:\<作者的曲库>`，
 *   打包发给别人之后，新用户第一次点「曲库」看到的是"目录不存在或还没有挂上"，
 *   输入框里还预填着陌生人的路径，连用户协议里都照抄了一句"默认是 …"。
 *   改法是把默认值清空 + 回 `needPick: true`，让界面走「先选一个目录」的引导。
 *   这份用例守的就是这条口径 —— 谁把默认值改回去，这里立刻红。
 *
 * 跑法：node --test --test-force-exit tests\firstrun-library.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupDir, cleanupDirSync } from "./support/cleanup.cjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

function waitForPort(child, logs, timeoutMs = 30000) {
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

/** 起一套全空的数据目录（没设过 library_dir），外加一份真曲库等着被指过去。 */
async function bootEmpty() {
  const dataDir = await mkdtemp(join(tmpdir(), "linli-firstrun-"));
  const libraryDir = join(dataDir, "music");
  for (const name of ["solo_first_a", "playsing_first_b"]) {
    const full = join(libraryDir, name);
    await mkdir(full, { recursive: true });
    await writeFile(join(full, `${name}_TOD1200_NI_L.mp4`), Buffer.alloc(16));
  }

  const logs = [];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LINLI_DATA_DIR: dataDir,
      LINLI_PORT: "0",
      LINLI_ASSETS_DIR: join(dataDir, ".no-assets"),
      LINLI_NO_GAME_ASSETS: "1",
      LINLI_NO_SHELL_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const port = await waitForPort(child, logs);
  const base = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(`${base}/api/session`)).json()).token;

  const req = (path, { method = "GET", body } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "x-linli-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
  const jget = async (p) => {
    const res = await req(p);
    return { res, body: await res.json().catch(() => null) };
  };

  return {
    dataDir, libraryDir, jget,
    post: (p, body) => req(p, { method: "POST", body }),
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill();
        await exited.catch(() => {});
      }
      await cleanupDir(dataDir).catch(() => {});
    },
  };
}

describe("首装曲库：没选目录 = needPick，不是报错", () => {
  test("① 全新数据目录：dir 为空、needPick 为真、不是 error", async () => {
    const fx = await bootEmpty();
    try {
      const { res, body } = await fx.jget("/api/library");
      assert.equal(res.status, 200);
      assert.equal(body.dir, "", "没选过目录时 dir 必须是空串（不能兜底成开发机路径）");
      assert.equal(body.needPick, true, "界面靠 needPick 走「先选一个目录」的引导");
      assert.equal(body.error, null, "还没选目录不是错误 —— 不许回「目录不存在」");
      assert.deepEqual(body.songs, []);
    } finally { await fx.kill(); }
  });

  test("② 指到真曲库之后：needPick 消失、曲子列出来", async () => {
    const fx = await bootEmpty();
    try {
      const put = await fx.post("/api/library/dir", { dir: fx.libraryDir });
      assert.equal(put.status, 200);
      const { body } = await fx.jget("/api/library");
      assert.equal(body.dir, fx.libraryDir);
      assert.ok(!body.needPick, "指了目录就不该再提示 needPick");
      assert.equal(body.error ?? null, null);
      assert.equal(body.songs.length, 2);
    } finally { await fx.kill(); }
  });

  test("③ 指到不存在的目录：当场 400 拒绝，且原设置不动（「没选」与「选错」必须能区分）", async () => {
    const fx = await bootEmpty();
    try {
      const put = await fx.post("/api/library/dir", { dir: join(fx.dataDir, "no-such-dir") });
      // ★ 这里原本我以为会 200 + 下次 GET 报错，实际服务端是**当场 400 拒绝**（LIBRARY_DIR_NOT_FOUND）。
      //   当场拒绝更好：不会把不存在的目录写进 settings，也就不会把用户卡在一个永远列不出东西的状态。
      assert.equal(put.status, 400, "不存在的目录必须在设置那一刻就被拒绝");
      const errBody = await put.json();
      assert.equal(errBody.code, "LIBRARY_DIR_NOT_FOUND");
      // 拒绝之后曲库仍然是「还没选」——而不是「选了一个坏目录」
      const after = await fx.jget("/api/library");
      assert.equal(after.body.dir, "");
      assert.equal(after.body.needPick, true);
      assert.equal(after.body.error, null);
    } finally { await fx.kill(); }
  });

  /**
   * ④ 兜底必须是**空串字面量**，不能挂在某个常量上。
   * 第十七轮复核（§3）指出：`DEFAULT_LIBRARY_DIR` 改成 `""` 之后全文件零引用，
   * 它成了死常量；那时把常量改回作者本机路径，行为一点不变（没人读它），
   * 上面三条行为用例全绿 —— 护栏咬不住。将来有人顺手写成
   * `getSetting("library_dir", DEFAULT_LIBRARY_DIR)`，这个 P1 就原样回来了。
   * 所以这里加一条源码级断言：兜底只能绑在 `""` 字面量上。
   * ★ 这条不是"测实现细节"，而是把"默认曲库不指向任何具体路径"这个**产品决定**
   *   钉在代码上 —— 行为用例测不到"没人读的常量被人改了"。
   */
  test("④ 曲库目录的兜底必须是空串字面量（不能挂到常量上）", async () => {
    const src = await readFile(SERVER, "utf8");
    assert.match(
      src,
      /getSetting\(\s*"library_dir"\s*,\s*""\s*\)/u,
      "library_dir 的兜底必须是空串字面量 —— 否则首次启动会指到某个具体目录（作者本机路径就是这么混进来的）",
    );
    // 反向：全仓不许再出现「默认曲库 = 某个绝对路径」的常量（盘符开头的那种）
    assert.doesNotMatch(
      src,
      /DEFAULT_LIBRARY_DIR\s*=\s*"[A-Za-z]:[\\/]/u,
      "不许再有指向具体盘符的默认曲库常量",
    );
  });
});
