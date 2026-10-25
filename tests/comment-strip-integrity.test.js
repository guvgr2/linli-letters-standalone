/**
 * 「注释剥除不许弄丢代码」的护栏（2026-10-21）。
 *
 * 为什么要有这一条：一大批护栏测试是**静态读源码**的 —— 它们先把注释剥掉再断言，
 * 免得「注释里引用了旧文案」造成假绿/假红。剥的做法各处都是同一条正则：
 * 去掉 斜杠+星号 到下一个 星号+斜杠 之间的内容，再去掉整行以双斜杠开头的行。
 *
 * 那条正则只认字符，不认语法。所以 —— 只要注释里出现一个斜杠紧跟一个星号，
 * 它就被当成块注释开头，然后一路吞到后面第一个「星号+斜杠」，中间所有真代码一起消失。
 *
 * ★ 2026-10-21 真实事故：桌宠接口的注释里写了「认证与其它 /api/ 后接星号 相同」，
 *   那 2 个字符让 server.mjs 被吞掉 31,901 个字符（第 2523 行一直到 idle/settings 之后），
 *   于是 4 条静态断言同时报「路由不存在」—— **报错说的是路由，坏的是注释**。
 *   同一轮还在 app.js 里查出历史遗留的一处同样的写法（/api/font/ 后接星号），吞掉 1,677 个字符。
 *   更讽刺的是本文件第一版自己就踩了同一个坑：头部说明里写了那 2 个字符，
 *   文档注释被当场提前闭合，模块直接 ReferenceError —— 所以下面一律用文字描述它们。
 *
 * 判据（自证式，不抄任何清单、不会随代码长大而失效）：
 *   · 从**原文**里取出所有「代码行」（去掉行首注释标记之后的非空行）；
 *   · 每行先做归一化：把行内小块注释与行尾双斜杠注释去掉、再 trim ——
 *     因为 `} catch { 小注释 }` 这种行剥完注释后原文确实不在了，那是**正常**的；
 *   · 要求归一化后的每一行，都能在剥完注释的文本里**原样找到**。
 *   只要有一行找不到 ⇒ 说明它所在的代码块被当成注释吃掉了 ⇒ 红。
 *
 * 另加一条更粗的计数检查（块注释开头与结尾标记的出现次数必须相等）作为旁证：
 * 它抓不住 server.mjs 那次（那个文件碰巧多一个结尾标记抵消了），但能抓住 app.js 那类。
 *
 * 跑法：node --test --test-force-exit tests\comment-strip-integrity.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/** 与各护栏测试里那份 `stripComments` 逐字一致的剥法 —— 要测的就是这一条实现。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 代码行归一化：去掉行内块注释、行尾行注释，再 trim。 */
const normalizeCodeLine = (line) =>
  line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+\/\/.*$/u, "").trim();

/** 只扫会被静态护栏读的源码；第三方/压缩过的产物不参与（本仓目前没有，先留口子）。 */
const VENDOR_RE = /liquid-glass|vendor|\.min\./u;

function collectSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/^(node_modules|\.git|dist|bin|obj)$/u.test(entry.name)) walk(full);
        continue;
      }
      if (!/\.(mjs|js)$/u.test(entry.name) || VENDOR_RE.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(path.join(ROOT, "app"));
  return out.sort();
}

test("★ 剥注释不许弄丢代码行：每个源码里的「真代码行」剥完都必须还在", () => {
  const files = collectSources();
  // ★ 扫到的文件数要有个下限，否则「目录改名/扩展名变了 ⇒ 一个文件都没扫」会变成永久假绿。
  assert.ok(files.length >= 15, `只扫到 ${files.length} 个源码文件，扫描规则是不是失效了？`);

  const broken = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const stripped = stripComments(src);
    const codeLines = src
      .split("\n")
      .map(normalizeCodeLine)
      .filter((line) => line && !/^(\/\/|\*|\/\*)/u.test(line));
    const missing = [...new Set(codeLines.filter((line) => !stripped.includes(line)))];
    if (missing.length) {
      broken.push(
        `${path.relative(ROOT, file)} 有 ${missing.length} 行代码被当成注释吃掉了，` +
        `第一行是：${JSON.stringify(missing[0].slice(0, 100))}`,
      );
    }
  }
  assert.deepEqual(broken, [],
    "注释里出现了「斜杠紧跟星号」（例如把接口通配路径原样写进注释）⇒ 会被剥注释正则当成块注释开头，" +
    "把后面一大段真代码一起吞掉。改法：注释里不要写那两个连着的字符，用文字描述或写成 /api/… 。\n" +
    broken.join("\n"));
});

test("旁证：注释行里不许出现「斜杠紧跟星号」", () => {
  // ★ 为什么不查"开头/结尾标记计数相等"：孤立的**结尾**标记对剥注释是无害的
  //   （正则找不到配对的开口，什么也不做），拿它当错误只会制造噪声。
  //   真正有害的只有一种：**本该是注释内容的位置**出现「斜杠紧跟星号」——
  //   它会被当成新的块注释开口，往后一路吞到下一个结尾标记。这里就精确查这一种。
  const hits = [];
  for (const file of collectSources()) {
    const src = fs.readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      const t = line.trim();
      // 注释行：整行以双斜杠开头，或块注释的续行（行首星号）。
      // ★ 注意不含 `/**` 这种开口行 —— 它自己就是注释开始，不算"注释内容里出现开口"。
      const inCommentBody = t.startsWith("//") || (t.startsWith("*") && !t.startsWith("*/"));
      if (!inCommentBody) return;
      // ★ 只查**开口**（斜杠+星号）：注释正文行末尾出现**结尾**标记是正常的收尾，
      //   不是错误。开口出现才会往后吞代码。
      if (line.includes("/*")) {
        hits.push(`${path.relative(ROOT, file)} 第 ${i + 1} 行：${t.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    "注释正文里出现了「斜杠紧跟星号」或「星号紧跟斜杠」这类连着的字符 —— " +
    "剥注释的正则会把它们当成块注释标记，连累后面的真代码。用文字描述，或写成 /api/… 。\n" +
    hits.join("\n"));
});
