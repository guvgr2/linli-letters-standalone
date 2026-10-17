// 协议的护栏：**设置页里那份**与**安装程序里那份**必须逐字相同，且入口不能被悄悄删掉。
//
// 为什么要有这套：用户 2026-10-13 明确说过「设置页的协议还是别删了」——
//   上一轮我为了"设置页简洁"把整块协议拿掉了，只留在安装向导里。现在改成
//   底部一行小链接 + 弹层。这条链路（协议.txt → legal.js → 弹层 / install.iss）
//   少任何一环都是"用户看不到他同意过什么"，必须能被测试挡住。
//
// 每条断言都要能被变异打红。改这个文件时，同步跑一次 negative control（见文件末尾注释）。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseLegal } from "../tools/legal-parse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
/**
 * ★ 读 CSS 要先把注释剥掉。
 *   为什么：纯"文本存在"的断言挡不住**被注释掉的规则** ——
 *   `/* .modal[hidden]{display:none} *​/` 里那几个字还在，正则照样命中，
 *   于是"弹层一进页面就顶着整屏"这种明显错误判不出来（变异测试里抓出来的）。
 *   剥掉注释之后，"这条规则在不在生效"才接近于"这几行字在不在"。
 */
const readCss = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//gu, "");

const SOURCE = "协议.txt";
const GENERATED = "app/public/legal.js";
const INSTALLER = "install.iss";
const INDEX = "app/public/index.html";
const APPJS = "app/public/app.js";
const CSS = "app/public/styles.css";

/** 把 legal.js 当普通脚本跑一遍，取出它挂上去的那个对象。 */
function loadGenerated() {
  const win = {};
  new Function("window", read(GENERATED))(win);
  return win.LEGAL;
}

test("协议解析：标题 / 导语 / 十一条 / 结尾钩子都拆出来", () => {
  const L = parseLegal(read(SOURCE));
  assert.match(L.title, /协议/);
  assert.equal(L.sections.length, 11, `应当正好十一条，实际 ${L.sections.length}`);
  // ★ 条数上两位数时解析器最容易出错：写死 `6` 时「十一、」会被并进第十条的 body。
  //   这条断言钉住"每一节的开头都是它自己的编号"，不只是总数对。
  const heads = L.sections.map((s) => s.head);
  assert.match(heads[6], /^七、/u, `第七条开头不对：${heads[6]}`);
  assert.match(heads[9], /^十、/u, `第十条开头不对：${heads[9]}`);
  assert.match(heads[10], /^十一、/u, `第十一条没被单独拆出来（十/十一 合并了）：${heads[10] ?? "(缺)"}`);
  assert.ok(!/十一、/.test(L.sections[9].body), "第十条的正文里混进了第十一条 ⇒ 正则没匹配上两位数");
  for (const s of L.sections) {
    assert.ok(s.head.length > 0 && s.body.length > 0, `这一条缺头或缺正文：${JSON.stringify(s)}`);
  }
  assert.match(L.lead, /请先读完/);
  assert.match(L.tail, /我同意/, "★ 结尾那句「勾选我同意即表示…」不能丢 —— 它是协议的受理条款");
});

test("解析：BOM / CRLF / 孤立的 CR / 多余空行都不能影响结果", () => {
  const base = parseLegal(read(SOURCE));
  // ★ 造 CRLF 变体前必须先归一：直接在 CRLF 源上把 \n 换成 \r\n 会造出 `\r\r\n`，
  //   那是**测试自己写错了**，不是解析器不稳健（第一版就是这么假红的）。
  const lf = read(SOURCE).replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  assert.deepEqual(parseLegal("\uFEFF" + lf.replace(/\n/gu, "\r\n") + "\n\n\n"), base,
    "CRLF 不该改变解析结果");
  assert.deepEqual(parseLegal(lf.replace(/\n/gu, "\r")), base,
    "★ 只有 CR 的老式换行也不该改变结果");
  assert.deepEqual(parseLegal(lf), base, "同一份内容去掉 BOM 后结果不变");
});

test("★ legal.js 与 协议.txt 逐字一致（改了源头忘了同步就红）", () => {
  // ★ 这条是整套的核心：不要写成"legal.js 非空"，那证明不了两边是同一份。
  const expected = parseLegal(read(SOURCE));
  const actual = loadGenerated();
  assert.deepEqual(actual, expected,
    "legal.js 与 协议.txt 不一致 —— 跑 node tools/sync-legal.mjs（不要手改 legal.js）");
});

test("★ 设置页里必须有协议入口，而且它真的能打开（不是个死链接）", () => {
  const html = read(INDEX);
  // 用户原话：「设置页的协议还是别删了」⇒ 入口被拿掉就该红
  assert.match(html, /id="lnkTerms"/, "设置页缺少「服务协议」入口");
  assert.match(html, /id="lnkPrivacy"/, "设置页缺少「隐私政策」入口");
  assert.match(html, /id="legalModal"/, "缺少协议弹层容器");
  assert.match(html, /id="legalTitle"/, "弹层缺少标题位");
  assert.match(html, /id="legalBody"/, "弹层缺少正文位");
  assert.match(html, /src="legal\.js"/, "没加载 legal.js ⇒ 弹层会打开成空白");
  // 弹层要能关：遮罩 + 关闭按钮 + 底部按钮都得带 data-close
  assert.ok((html.match(/data-close="1"/g) ?? []).length >= 3, "关闭路径不全（遮罩/×/按钮）");

  const js = read(APPJS);
  assert.match(js, /getElementById\("lnkTerms"\)\??\.addEventListener\("click"/, "正文没有接线到弹层");
  assert.match(js, /getElementById\("lnkPrivacy"\)\??\.addEventListener\("click"/, "隐私入口没有接线");
  assert.match(js, /e\.key === "Escape"/, "★ 弹层必须能用 Esc 关掉");
  assert.match(js, /bodyEl\.textContent/, "正文要用 textContent 填（协议里有 %APPDATA%、< > 之类字面量）");
  // 正文不能抄进 HTML —— 抄一份就有两处会各改各的
  assert.ok(!/你的东西都在你自己机器上/.test(html), "★ 协议正文不许手抄进 index.html，只能从 legal.js 来");
});

test("★ 安装时读的和设置页看的是同一份 协议.txt", () => {
  const iss = read(INSTALLER);
  const m = /LicenseFile\s*=\s*(.+)/u.exec(iss);
  assert.ok(m, "install.iss 里没有 LicenseFile ⇒ 安装向导不再展示协议");
  assert.equal(m[1].trim().replace(/^"|"$/gu, ""), SOURCE,
    `安装向导读的必须是同一份 ${SOURCE}，实际是 ${m[1].trim()}`);
});

test("★ 协议正文里不许出现 markdown 记号（两处都是按纯文本显示的）", () => {
  // 安装向导的 LicenseMemo 是纯文本、弹层也是 textContent ⇒ `**加粗**` 会原样露出星号。
  // 第一版就是这么漏的：截图里"那是读的你**自己那个厂商账户**里剩多少"。
  const L = loadGenerated();
  const all = [L.lead, ...L.sections.flatMap((s) => [s.head, s.body]), L.tail].join("\n");
  assert.ok(!/\*\*/u.test(all), "★ 协议里出现 ** —— 会原样显示成星号（协议.txt 是纯文本，不是 markdown）");
  assert.ok(!/^\s*[-*]\s+/mu.test(all), "★ 协议里出现 markdown 列表记号，同样会原样露出来");
  assert.ok(!/[`#]/u.test(all), "★ 协议里出现 markdown 的 ` 或 #");
});

test("★ 第四条必须写明字体的新口径：不含字体 + 给官网地址 + 不许退回旧说法", () => {
  const L = loadGenerated();
  const four = L.sections.find((s) => s.head.startsWith("四、"));
  assert.ok(four, "缺第四条");
  // 2026-10-15 决定：不再随包字体（汉仪协议 4.4.3 / 4.4.4 禁止附带或嵌入分发）。
  // 这条钉住的是"协议说的和包里装的是同一件事"：包里没有字体，协议就不能说随附了。
  assert.match(four.body, /不包含[^。]*不随附|不随附[^。]*字体/u,
    "第四条没写明本程序不包含/不随附字体文件");
  // ★ 官网地址用**字面量**钉死域名，别拿被测代码现算期望值（那叫同义反复，永远绿）。
  assert.match(four.body, /sentyfont/i, "第四条没给出官网地址（个人非商业免费下载）");
  assert.match(four.body, /不主张任何权利/, "第四条没写明这个字体的权利不归我们");
  assert.match(four.body, /第十条/, "第四条要把权利人的下架路径指到第十条");
  // ★ 反向断言：旧口径必须绝迹，否则有人会把「随附」的说法加回来。
  const all = [L.lead, ...L.sections.flatMap((s) => [s.head, s.body]), L.tail].join("\n");
  assert.ok(!/随附了?\s*SentyTEA/u.test(all), "★ 协议里又出现「随附（了）SentyTEA」的旧说法");
  assert.ok(!/取自原版游戏客户端/u.test(all), "★ 协议里又出现「取自原版游戏客户端」的旧说法");
});

test("★ 下架通知与安全报告这两个入口不能被悄悄删掉", () => {
  const L = loadGenerated();
  const CONTACT = "guvgr13@outlook.com";
  const takedown = L.sections.find((s) => s.head.includes("下架"));
  const security = L.sections.find((s) => s.head.includes("安全"));
  assert.ok(takedown, "缺「下架与侵权通知」一条");
  assert.ok(security, "缺「安全问题的报告入口」一条");
  assert.ok(takedown.body.includes(CONTACT), "下架那一条里没有联系方式");
  assert.ok(security.body.includes(CONTACT), "安全报告那一条里没有联系方式");
});

test("底部链接的样式要「低对比、不抢版面」，且不被液态玻璃高光套上", () => {
  const css = readCss(CSS);   // ★ 剥注释：见 readCss 上面的说明
  assert.match(css, /\.legalbar\s*\{/, "缺少 .legalbar 布局");
  assert.match(css, /\.lnk\s*\{[^}]*color:\s*var\(--tx4\)/s, "小链接应当是低对比的次级文字色");
  assert.match(css, /\.lnk:hover\s*\{[^}]*background:\s*none/s, "小链接不该有实心底");
  assert.match(css, /\.modal\[hidden\]\s*\{\s*display:\s*none/, "★ 弹层的 hidden 必须真的能藏住（否则一进页面就顶着）");
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.modal-box\s*\{\s*animation:\s*none/s,
    "勾了「减少动效」就别给弹层放动画");

  const js = read(APPJS);
  assert.match(js, /querySelectorAll\(SELECTOR\)|button:not\(\.lnk\)/, "协议小链接必须被排除在液态玻璃之外");
  assert.match(js, /const SELECTOR = "button:not\(\.lnk\), \.rb"/, "★ 排除写在选择器里，别只在 upgrade() 里加 if");
});

// 阴性对照（手工跑，三条都该让上面变红）：
//   ① 把 legal.js 里某一条正文改一个字            ⇒ 「逐字一致」红
//   ② 删掉 index.html 里的 id="lnkTerms"          ⇒ 「设置页入口」红
//   ③ 把 install.iss 的 LicenseFile 改成别的文件  ⇒ 「同一份」红
//   ④ 把弹层的 .modal[hidden]{display:none} 删掉  ⇒ 「低对比」那条红
