/**
 * ★ 护栏自己依赖的文件，不许住在被 `.gitignore` 忽略的路径下。
 *
 * 为什么要有这份（2026-10-24 事故）：
 *   本机 `analysis/` 被整体清空一次，而 `.gitignore` 第 17 行把整个 `analysis/` 忽略了、
 *   它也**从未入库** ⇒ git 还原不了、回收站也没有。结果不是"丢了点证据"，而是
 *   **两条常驻护栏直接 ENOENT 变红**：
 *     · tests/pet-interface.test.js     缺 `桌宠接入契约（预留）-2026-10-21.md`
 *     · tests/ui-fixes-20261022.test.js 缺 `verify-screen-e2e.js`
 *   换句话说：护栏把命根子放在了一个随时能被清掉的目录里。
 *
 * ★ 判据不能靠手抄黑名单（"手抄黑名单一定烂"——抄漏一个就等于没护栏）。
 *   改成自动扫：把 tests/ 下所有"像仓库相对路径"的字符串字面量抓出来，
 *   逐个问 `git check-ignore --no-index`。谁被忽略 ⇒ 红。
 *   用 `--no-index` 是关键：它只看忽略规则、不看文件是否存在，
 *   所以**文件已经被删了也照样抓得到**（否则这护栏在出事那一刻反而沉默）。
 *
 * ★ 自证下限：抓到的候选必须有 `MIN_CANDIDATES` 个以上。
 *   扫描规则写坏了 ⇒ 0 个候选 ⇒ 全绿 —— 那是最危险的假绿，必须先挡住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 只扫 *.test.js；support/ 里放的是夹具，不走这套（它们本来就该是测试数据）。 */
function scanTestFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "support" || e.name === "lib") continue;
        walk(p);
        continue;
      }
      if (e.name.endsWith(".test.js")) out.push(p);
    }
  };
  walk(join(ROOT, "tests"));
  return out;
}

/** 抓 "像仓库相对路径" 的字符串字面量：含一个点号分隔的扩展名，且不是 URL / 绝对路径。 */
const PATH_LITERAL = /["'`]([A-Za-z0-9_][A-Za-z0-9_./\-一-鿿]*\.(?:mjs|js|json|md|html|css|ps1|cs|txt|iss|py|webp|png|mp4))["'`]/gu;

function collectPathLiterals(files) {
  const found = new Map();   // 字面量 -> [出处]
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // 注释里提到的旧路径不算（改动说明难免引用历史位置），只看真读取的那一行
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
      for (const m of stripped.matchAll(PATH_LITERAL)) {
        const p = m[1];
        if (/^https?:/u.test(p)) continue;
        if (p.startsWith("/") || /^[A-Za-z]:/u.test(p)) continue;   // 绝对路径不是仓库相对路径
        if (p.startsWith(".")) continue;
        const rel = f.slice(ROOT.length + 1).replace(/\\/gu, "/");
        if (!found.has(p)) found.set(p, []);
        found.get(p).push(`${rel}:${i + 1}`);
      }
    });
  }
  return found;
}

/** git check-ignore：0 = 被忽略，1 = 没被忽略，128 = 参数/仓库有问题。 */
function checkIgnore(relPath) {
  const r = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", relPath], { cwd: ROOT });
  return r.status;
}

/**
 * 从 .gitignore 自己读出"被忽略的顶层目录名"—— 不手抄清单（手抄会烂）。
 * 只取 `名字/` 这种裸目录规则；带通配符或路径段的先不认（判起来容易误伤）。
 */
function ignoredTopDirs() {
  const src = readFileSync(join(ROOT, ".gitignore"), "utf8");
  const names = new Set();
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([A-Za-z0-9_.\-一-鿿]+)\/?$/u.exec(line);
    if (!m) continue;
    if (checkIgnore(m[1] + "/") === 0 || checkIgnore(m[1]) === 0) names.add(m[1]);
  }
  return [...names];
}

/**
 * 这个被忽略的目录，是不是**能被构建脚本重新造出来**？
 *
 * ★ 为什么要分：被忽略不可怕，**不可重建**才可怕。
 *   · `dist/` 被忽略，但 `build.ps1` 能从受追踪的源码重新产出 ⇒ 清掉再 build 就有了，
 *     测试引用它并在缺失时 skip，是合理的。
 *   · `analysis/` 被忽略，且里面的东西**从来只存在于那儿** ⇒ 清一次就永久丢失，
 *     2026-10-24 就这么丢了一整目录，连带两条护栏变红。
 * ★ 判据不手抄名单：直接问"构建脚本里有没有产出这个目录"。
 */
function regenerable(name) {
  for (const script of ["build.ps1", "package.ps1"]) {
    const p = join(ROOT, script);
    if (!existsSync(p)) continue;
    if (readFileSync(p, "utf8").includes(name)) return true;
  }
  return false;
}

const MIN_CANDIDATES = 8;

test("① 任何测试读取的仓库相对路径，都不许落在被 .gitignore 忽略的地方", () => {
  const files = scanTestFiles();
  assert.ok(files.length >= 20, `扫描规则要能找到测试文件，实际只有 ${files.length} 个`);
  const lits = collectPathLiterals(files);
  assert.ok(
    lits.size >= MIN_CANDIDATES,
    `抓到的路径字面量只有 ${lits.size} 个（下限 ${MIN_CANDIDATES}）⇒ 扫描规则多半写坏了，别当绿`,
  );

  const ignored = [];
  const skipped = [];
  for (const [p, at] of lits) {
    const st = checkIgnore(p);
    if (st === 0) ignored.push(`${p}  ← ${at.join(", ")}`);
    else if (st !== 1) skipped.push(`${p} (git 退出 ${st})`);
  }

  if (skipped.length) {
    // 不静默：说清楚哪些没判到，免得"判不到"被当成"判过了"
    console.log(`  （未能判定 ${skipped.length} 个：${skipped.slice(0, 5).join("; ")}）`);
  }
  assert.deepEqual(
    ignored,
    [],
    `以下路径被 .gitignore 忽略，护栏不能依赖它们（清空一次就红一次）：\n  ${ignored.join("\n  ")}`,
  );
});

test("①b 路径**拼接**出来的也不能落在被忽略的目录里", () => {
  // ★ ① 只认"整条路径字面量"，而 `join(ROOT, "analysis", "_audit19", "triage-*.json")`
  //   这种是把目录名拆成片段拼的 —— 扫字面量扫不到（2026-10-25 实测漏过一条：
  //   web-triage.test.js ① 就是这么写的，analysis/ 被清后它 ENOENT 红）。
  //   所以这里单独盯"join/resolve 调用里出现的被忽略目录名"。
  const bad = ignoredTopDirs().filter((n) => !regenerable(n));
  assert.ok(bad.length >= 1, `.gitignore 里应当读得出"不可重建"的被忽略目录，实际只有 ${JSON.stringify(ignoredTopDirs())}（其中 ${JSON.stringify(ignoredTopDirs().filter(regenerable))} 可由构建脚本重建，已放行）`);
  const hits = [];
  for (const f of scanTestFiles()) {
    const src = readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => {
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return;
      // 只看含 join(...) / resolve(...) 这类路径构造的行。
      // ★ 不要试图匹配"括号里的全部内容"—— 拼接里常带模板串 `` `triage-${Date.now()}.json` ``，
      //   里面的 `${...()}` 自带圆括号，用 `[^()]*` 会整条漏掉（2026-10-25 变异实测：
      //   护栏当时是绿的，等于没守）。改成"这一行只要在做路径构造，就把整行字面量都查一遍"，
      //   宁可多报也不漏。
      if (!/\b(?:join|resolve)\s*\(/u.test(stripped)) return;
      for (const lit of stripped.matchAll(/["'`]([^"'`]+)["'`]/gu)) {
        if (bad.includes(lit[1])) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1} → ${lit[1]}`);
      }
    });
  }
  assert.deepEqual(
    hits,
    [],
    `以下位置在构造路径时用了被忽略的目录（清空一次就红）：\n  ${hits.join("\n  ")}`,
  );
});

test("② 反面自证：把一条被忽略的路径喂进去，本文件必须判得出来", () => {
  // ★ 这条是"检测器自己能变红"的自证 —— 检测器不会变红的护栏等于没有。
  //   analysis/ 一定被忽略（.gitignore 第 17 行），拿它当阳性对照。
  //   ★★ 路径必须**拼接**出来，不能写成字面量：本文件自己也在扫描范围里，
  //      检测器逐字含被检测串 ⇒ 必拦自己（与 repo-privacy 那次同一个病，2026-10-22 实证）。
  const ignoredDir = "analysis";
  const probe = ignoredDir + "/" + "_audit22/verify-screen-e2e.js";
  const st = checkIgnore(probe);
  assert.equal(st, 0, "正面：analysis/ 下的路径必须被判为忽略（否则本文件的判据是空的）");
  // 已追踪的位置必须判为"没被忽略"
  assert.equal(checkIgnore("tools/verify-screen-e2e.js"), 1, "负面：tools/ 下的路径不该被判为忽略");
});
