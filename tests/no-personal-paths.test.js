/**
 * 发布物里不许出现作者本机的路径 / 目录名。
 *
 * 为什么要有这一条（2026-10-19 第十六轮审查 §4）：
 *   作者的开发机路径散落在源码注释、协议文本、前端占位符里，比如
 *   `E:\<作者的曲库>`（6 处兜底 + 协议第三条 + 输入框 placeholder）、
 *   `E:\linli-letters\…`（注释里引用了本仓库的 analysis 报告）、
 *   `E:\olivia-soul-community-kit`（姊妹项目路径）。这些会**原样进安装包**，
 *   等于把作者的用户名、目录结构、工作站布局一起发给陌生人。
 *   更糟的是它们会漂移：有人改了代码没改注释，下一个人照着注释做就错。
 *
 * ★ 扫描面 = 真正会发给用户的东西：`app/` 下的文本文件、仓库根的协议/LICENS/notice、
 *   `installer/` 的构建脚本，以及**已经组装好的** `dist/package/app`（存在才扫）。
 *   不扫 `tests/`、`analysis/`、`tools/` —— 那些不随包发，其中测试与审查脚本
 *   本来就要写到这些路径才能跑（扫了会变成"为了过测试而不敢写脚本"）。
 *
 * ★ 判据按「具体到足以确认是本机/本仓库」来写，不是见人就杀：
 *   `guvgr13@outlook.com` 是协议里给用户的联系方式，**必须保留**，
 *   所以不能拿 `guvgr` 当关键词乱扫。
 *
 * 跑法：node --test --test-force-exit tests\no-personal-paths.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 会随包发出去的文本文件后缀（图片/视频/字体/压缩包不读）。 */
const TEXT_EXT = new Set([".mjs", ".js", ".html", ".css", ".json", ".txt", ".md", ".iss", ".ps1", ".user", ".ico.md"]);
const SKIP_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mp3", ".ttf", ".otf", ".woff", ".woff2", ".ico", ".exe", ".dll", ".zip", ".pdb"]);

/** 作者本机/本仓库的痕迹。每条都是「看到就说明这一版会把别人的机器信息发出去」。
 *  ★ 只抓**带盘符或带用户目录**的路径。像 `olivia-soul-community-kit` 这种纯项目名不算
 *    （它出现在 harness-manifest 的 `sourceRepo` 与注释里，是上游仓库的名字，本来就该写）。
 *    `E:\linlimusic` 这种也没问题：它后面跟着盘符，新用户没有 E 盘。 */
const FORBIDDEN = [
  { re: /[A-Za-z]:[\\/]+linlimusic/iu, why: "作者本机的曲库路径（新用户没有这个盘）" },
  { re: /[A-Za-z]:[\\/]+linli-letters/iu, why: "作者本机的仓库路径" },
  { re: /[A-Za-z]:[\\/]+olivia-soul-community-kit/iu, why: "姊妹项目在本机的路径" },
  { re: /[A-Za-z]:[\\/]+Users[\\/]+guvgr/iu, why: "作者本机的用户目录" },
];

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walk(full, out);
    } else if (TEXT_EXT.has(extname(e.name).toLowerCase()) && !SKIP_EXT.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** 收集「会随包发出去」的文件清单。 */
async function shippedFiles() {
  const files = await walk(join(ROOT, "app"));
  for (const name of ["协议.txt", "LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
    const full = join(ROOT, name);
    if (existsSync(full)) files.push(full);
  }
  const installer = join(ROOT, "installer");
  if (existsSync(installer)) files.push(...(await walk(installer)));
  // ★ 已经组装好的发布树才是"真正发出去的那份"。源码干净、dist 脏一样会发脏的出去。
  const packed = join(ROOT, "dist", "package", "app");
  if (existsSync(packed)) files.push(...(await walk(packed)));
  return files;
}

describe("发布物里没有作者本机的路径", () => {
  test("① app/ 与协议、许可证、installer、已组装的 dist 里都查不到本机路径", async () => {
    const files = await shippedFiles();
    assert.ok(files.length > 50, `扫描面太小（${files.length} 个文件），可能读错目录了`);

    const hits = [];
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      for (const { re, why } of FORBIDDEN) {
        const m = re.exec(text);
        if (m) hits.push(`${relative(ROOT, file)}：${why} ⇒ 命中「${m[0]}」`);
      }
    }
    assert.deepEqual(hits, [], `发布物里有作者本机痕迹：\n${hits.join("\n")}`);
  });

  test("② 曲库目录的输入框不许预填作者本机的路径（通用示例可以）", async () => {
    const html = await readFile(join(ROOT, "app", "public", "index.html"), "utf8");
    const tag = /<input[^>]*id="libraryDir"[^>]*>/iu.exec(html)?.[0] ?? "";
    assert.ok(tag, "找不到 #libraryDir");
    const placeholder = /placeholder="([^"]*)"/iu.exec(tag)?.[1] ?? "";
    // ★ 通用示例（`D:\音乐` 这种）是帮忙，不是泄漏；但作者自己的 `E:\<曲库>` 不行。
    for (const { re, why } of FORBIDDEN) {
      assert.ok(!re.test(placeholder), `placeholder 里还有${why}：${placeholder}`);
    }
  });

  test("③ 打包用的 csproj 必须剥符号路径（否则异常堆栈会带出本机用户名）", async () => {
    const csproj = await readFile(join(ROOT, "src", "LinliShell", "LinliShell.csproj"), "utf8");
    assert.match(csproj, /<DebugType>\s*none\s*<\/DebugType>/iu, "Release 必须 DebugType=none");
    assert.match(csproj, /<PathMap>/iu, "必须有 PathMap，把本机源码根映射成占位名");
  });
});
