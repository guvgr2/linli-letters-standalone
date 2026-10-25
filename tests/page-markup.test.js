/**
 * 页面标记的静态护栏（2026-10-19 七轮审查 F1 之后立的）。
 *
 * 为什么值得单开一份：
 *   F1 是这一版里唯一挡发布的那条 —— `index.html` 少了一个注释开头，四行注释正文
 *   就变成 body 的直接文本节点，四个页面都能看见那段字、连注释的结尾符号一起印在屏幕上，
 *   而且**已经打进安装包**。这类事故的共同点：HTML 本身不报错，浏览器照单全收，
 *   接口与交互测试全绿，只有人肉看到页面最底部才会发现。
 *
 * 断言的原则（施工单里给的那条判据，我把它扩成三条）：
 *   ① **先剥掉合法注释，再找残留的注释结尾符号**。只 grep 结尾符号会被正常注释命中（假红）；
 *      只 grep 注释正文又会被注释里的同一句话命中（假绿）—— 必须先剥。
 *   ② 剥完之后不许出现"看起来像注释正文"的片段（`★` 开头、或已知的那几句）。
 *   ③ 反过来查一次：注释必须成对（开头数 == 结尾数），免得靠"少写结尾"糊过去。
 *
 * 跑法：node --test --test-force-exit tests\page-markup.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUBLIC = join(ROOT, "app", "public");

// ★ 2026-10-20：dock.html 已删 —— 桌面圆钮改成外壳纯 GDI+ 自绘（DesktopDock.cs），
//   不再有「用网页画两个圆钮」这一页。
const PAGES = ["index.html", "wallpaper.html", "splash.html"];

/** 剥掉所有合法注释（非贪婪，跨行）。返回剥完的文本。 */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/gu, "");
}

describe("① 页面里不许出现没被注释包住的注释正文（F1）", () => {
  for (const name of PAGES) {
    test(`${name} 剥掉合法注释后没有残留的注释结尾符号`, () => {
      const html = readFileSync(join(PUBLIC, name), "utf8");
      const stripped = stripComments(html);
      assert.ok(
        !stripped.includes("-->"),
        `${name} 里有注释结尾符号落在注释外面 —— 多半是某处少了注释开头（F1 就是这种事故）`,
      );
      // 开头符号同理：剥完还留着 `<!--` 说明有嵌套/写坏
      assert.ok(!stripped.includes("<!--"), `${name} 里有注释开头符号落在注释外面`);
    });
  }

  test("index.html 里 F1 那几句注释正文不许漏进正文", () => {
    const stripped = stripComments(readFileSync(join(PUBLIC, "index.html"), "utf8"));
    assert.ok(
      !/★[^\n]*两枚 video 必须都在 DOM 里/u.test(stripped),
      "注释正文漏到页面正文里了（F1 的原样复发）",
    );
    assert.ok(
      !/\.player-container 纯黑铺满/u.test(stripped),
      "播放页那段注释正文漏到页面正文里了（F1 的原样复发）",
    );
  });
});

describe("② 注释必须成对（防用'少写结尾'绕过上面那两条）", () => {
  for (const name of PAGES) {
    test(`${name} 的注释开头数与结尾数一致`, () => {
      const html = readFileSync(join(PUBLIC, name), "utf8");
      const opens = (html.match(/<!--/gu) ?? []).length;
      const closes = (html.match(/-->/gu) ?? []).length;
      assert.equal(opens, closes, `${name}：注释开头 ${opens} 个、结尾 ${closes} 个，不成对`);
      assert.ok(opens > 0, `${name} 一个注释都没有，说明这份文件被整段改写过，请人工确认`);
    });
  }
});

describe("③ 设置页的折叠块与路径提示（F7 / F8）", () => {
  test("details 收起时内部内容必须真的不显示（一行兜底，防第 3、第 4 处再犯）", () => {
    const css = ["styles.css", "styles-original.css"]
      .map((f) => readFileSync(join(PUBLIC, f), "utf8"))
      .join("\n");
    assert.match(
      css,
      /details:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{[^}]*display:\s*none/u,
      "缺 `details:not([open]) > :not(summary) { display: none; }` —— 收起后内部卡片仍占高度、与下一块重叠",
    );
  });

  test("曲目存储路径的输入框要有 title（长路径被裁时能悬停看全）", () => {
    const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
    const input = html.match(/<input[^>]*id="libraryDir"[^>]*>/u)?.[0] ?? "";
    assert.ok(input, "找不到 #libraryDir");
    assert.match(input, /\btitle=|aria-label=/u, "#libraryDir 没有 title，长路径被裁时用户看不到全貌");
  });
});
