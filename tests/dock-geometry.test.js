/**
 * 桌面圆钮 / 左侧导航浮层的几何与"它不是网页"护栏（2026-10-20 重写）。
 *
 * ★ 为什么重写：上一版的判据守的是「dock.html 的 left/top + 半径 == 外壳裁窗口用的圆心」
 *   —— 那套是 `WebView2 画页面 + SetWindowRgn 裁窗口` 的老架构。本机 WebView2 在那个
 *   窗口里反复崩，用户看到的是两个黑饼（点不动、没图标、没文字）；左侧导航也必须是
 *   **窗口外面**的独立浮层。两条都要求换掉架构 ⇒ 旧的判据前提整个作废，
 *   照旧写在报告里会变成"守着一个已经不存在的实现"。
 *
 * 现在的架构（`LayeredLayer.cs` 的注释里有完整来龙去脉）：
 *   · 桌面圆钮 = `DesktopDock.cs`，纯 GDI+ 画进一块逐像素 alpha 的 layer 位图；
 *   · 左侧导航 = `NavRail.cs`，同一套底子，`Owner = 主窗口`，贴在窗口左沿**外面**；
 *   · 两者都不许再引 WebView2 —— 引回去就等于把那台机器上的黑饼病请回来。
 *
 * 判据：
 *   ① 方向与比例：音乐在左上、信箱在右下，两心位移约 (1.1d, 1.2d)（d = 直径）；
 *   ② 两个圆完整落在画布内（越界 = 圆被裁掉一角）；
 *   ③ 承重件：拖动阈值 + 拖完存位置 + 点哪颗开哪页 都还在；
 *   ④ 不许回归网页：仓库里没有 dock.html，两个浮层源码里没有 WebView2；
 *   ⑤ 导航浮层：Owner 绑定 + 位置由主窗口算 + 不许拖 + 页面里没有 `.rail`。
 *
 * 跑法：node --test --test-force-exit tests\dock-geometry.test.js
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, ...p.split("/")), "utf8");

const DOCK = read("src/LinliShell/DesktopDock.cs");
const RAIL = read("src/LinliShell/NavRail.cs");
const LAYER = read("src/LinliShell/LayeredLayer.cs");
const INDEX = read("app/public/index.html");

/** 剥掉 C# 的两种注释。★ 不剥会假红：文件头恰好写着"上一版是 WebView2 画的"这段教训。 */
function stripCs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}
const DOCK_CODE = stripCs(DOCK);
const RAIL_CODE = stripCs(RAIL);

/** 取 C# 里的整型常量（`private const int Radius = 31;`）。 */
function num(src, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`, "u").exec(src);
  assert.ok(m, `找不到常量 ${name}`);
  return Number(m[1]);
}

describe("桌面圆钮：布局照原版（音乐左上 / 信箱右下）", () => {
  test("① 方向与相对位移约 1.1d / 1.2d", () => {
    const r = num(DOCK, "Radius");
    const d = r * 2;

    const mcx = num(DOCK, "MusicCx"), mcy = num(DOCK, "MusicCy");
    const lcx = num(DOCK, "MailCx"), lcy = num(DOCK, "MailCy");

    assert.ok(mcx < lcx, `音乐必须比信箱靠左（MusicCx=${mcx} vs MailCx=${lcx}）`);
    assert.ok(mcy < lcy, `音乐必须比信箱靠上（MusicCy=${mcy} vs MailCy=${lcy}）`);

    // 原版两颗钮不是规规矩矩排一列，而是错开摆：(+1.1d, +1.2d)。
    // 容差 ±0.15d —— 手感上差不多，但"两个圆重叠/贴在一起"这种明显错误会被抓住。
    const dx = (lcx - mcx) / d, dy = (lcy - mcy) / d;
    assert.ok(Math.abs(dx - 1.1) <= 0.15, `横向位移 ${dx.toFixed(2)}d 偏离原版的 1.1d`);
    assert.ok(Math.abs(dy - 1.2) <= 0.15, `纵向位移 ${dy.toFixed(2)}d 偏离原版的 1.2d`);
  });

  test("② 两个圆完整落在画布内（越界就会被 layer 位图切掉一角）", () => {
    const r = num(DOCK, "Radius");
    const w = num(DOCK, "DockW"), h = num(DOCK, "DockH");
    for (const [name, cx, cy] of [
      ["音乐", num(DOCK, "MusicCx"), num(DOCK, "MusicCy")],
      ["信箱", num(DOCK, "MailCx"), num(DOCK, "MailCy")],
    ]) {
      assert.ok(cx - r >= 0 && cx + r <= w, `${name}圆左右越界：${cx}±${r} vs 0..${w}`);
      assert.ok(cy - r >= 0 && cy + r <= h, `${name}圆上下越界：${cy}±${r} vs 0..${h}`);
    }
  });

  test("③ 拖动 / 点击的承重件都还在", () => {
    // ★ 用户 2026-10-20 特别提醒「桌面的那两个按钮是能移动的」，
    //   而且上一版正因为"页面死了 ⇒ drag 消息发不出来"变成拖不动。
    assert.match(LAYER, /Location = new Point\(_downLoc\.X \+ now\.X - _downScreen\.X/u,
      "拖动必须真的改 Location（上一版是页面发消息叫外壳拖，页面一死就拖不动）");
    assert.match(LAYER, /Math\.Abs\(now\.X - _downScreen\.X\) > 4/u,
      "必须有位移阈值，否则点一下手抖就变成拖动，圆钮永远点不中");
    assert.match(LAYER, /Capture = true;/u, "按下要捕获鼠标，否则拖出窗口就断了");
    assert.match(LAYER, /else if \(idx >= 0 && idx == pressed\) OnItemClicked\(idx\);/u,
      "拖完松手不许再触发点击（否则一拖就打开界面）");
    assert.match(DOCK, /protected override void OnDragEnded\(\)/u, "桌面圆钮要接「拖完」这一下");
    assert.match(DOCK, /System\.IO\.File\.WriteAllText\(_posFile/u, "拖完必须把位置落盘");
    assert.match(DOCK, /OpenPageRequested\?\.Invoke\(this, page\)/u, "点圆钮必须能开页面");
  });
});

describe("两个浮层都不许再是网页（黑饼病的根因）", () => {
  test("④ 没有 dock.html，源码里没有 WebView2", () => {
    assert.ok(!existsSync(join(ROOT, "app", "public", "dock.html")),
      "dock.html 必须删掉 —— 存在就说明有人又把圆钮塞回网页里");
    for (const [name, src] of [["DesktopDock.cs", DOCK_CODE], ["NavRail.cs", RAIL_CODE]]) {
      assert.ok(!/WebView2/u.test(src), `${name} 不许再引 WebView2（本机内核在那个窗口里反复崩）`);
      assert.ok(!/SetWindowRgn/u.test(src), `${name} 不许用 SetWindowRgn（只有硬边，做不出柔边玻璃）`);
    }
    assert.match(LAYER, /UpdateLayeredWindow\(/u, "浮层必须走逐像素 alpha 的 layered window");
    assert.match(LAYER, /WS_EX_LAYERED|0x00080000/u, "必须带 WS_EX_LAYERED");
  });
});

describe("左侧导航：窗口外面的独立浮层", () => {
  test("⑤ Owner 绑定 + 位置由主窗口算 + 不许拖", () => {
    assert.match(RAIL, /Owner = owner;/u, "导航浮层必须是主窗口的 Owned 窗口（跟随显隐、不进任务栏）");
    assert.match(RAIL, /owner\.LocationChanged \+= OnOwnerMoved;/u, "主窗口移动时浮层要跟");
    assert.match(RAIL, /owner\.SizeChanged \+= OnOwnerMoved;/u, "主窗口改尺寸时浮层要跟");
    assert.match(RAIL, /b\.Left - pillW - gap/u,
      "位置必须由主窗口左沿算出来（贴在窗口**外面**，中间留缝），不许写死坐标");
    assert.match(RAIL, /protected override bool AllowDrag => false;/u,
      "导航是贴靠件，拖走了就对不上窗口");
    // 当前页必须是米色实心圆（原版口径），否则用户看不出在哪一页
    assert.match(RAIL, /Color\.FromArgb\(255, 0xD8, 0xCF, 0xC4\)/u, "选中态必须是米色实心圆（--p2）");
    assert.match(RAIL, /#121214|0x12, 0x12, 0x14/u, "胶囊必须是近黑不透明（#121214）");
  });

  test("⑥ 页面里不许再有一条左栏（否则就是两个导航）", () => {
    assert.ok(!/class="rail"/u.test(INDEX), "index.html 里不许再有 .rail");
    assert.ok(!/class="rb\b/u.test(INDEX), "index.html 里不许再有 .rb 圆钮");
    assert.ok(!/data-page=/u.test(INDEX), "index.html 里不许再有 data-page（那是页面内导航的绑定）");
    const CSS = read("app/public/styles.css");
    assert.ok(!/^\.rail\b/mu.test(CSS), "styles.css 里不许再有 .rail 规则（死代码）");
    assert.ok(!/^\.rb[\s.{:]/mu.test(CSS), "styles.css 里不许再有 .rb 规则（死代码）");
  });

  test("⑦ 悬空：整颗胶囊退到窗口外面，中间留一道看得见的缝", () => {
    // ★ 2026-10-20 用户第二次提这件事：「那个浮窗太靠近主窗口了，再往左移一点」。
    //   上一版值是 4dip（胶囊几乎压着窗口边），观感是"贴在边上"而不是"挂在外面"。
    //   这条守的是**看得见**这件事：缝小于 16dip，在 1.5× 缩放的高分屏上也只剩二十几像素，
    //   一眼看过去还是"贴边"。要再调小必须先推翻这条注释与用户口径。
    const gap = num(RAIL_CODE, "OutsideGap");
    assert.ok(gap >= 16, `OutsideGap=${gap}dip 太小（<16）—— 胶囊会重新贴上窗口边`);

    // 胶囊**整个**在窗口左沿外面：右沿 = b.Left - gap，不给"半个胶囊压在窗口上"留余地。
    const shadow = num(RAIL_CODE, "ShadowPad"),
      item = num(RAIL_CODE, "Item"), pad = num(RAIL_CODE, "Pad");
    assert.match(RAIL_CODE, /private const int PillW = Item \+ Pad \* 2;/u,
      "PillW 必须由 Item/Pad 推出来，别手抄一个数（改一颗钮的直径就该跟着变）");
    assert.match(RAIL_CODE, /private const int RailW = PillW \+ ShadowPad \* 2;/u,
      "画布宽 = 胶囊 + 两侧落影余量（少了就把自己的影子裁掉）");
    const pillW = item + pad * 2;
    assert.ok(shadow > 0, "落影余量不能是 0");
    assert.match(RAIL_CODE, /int pillLeft = b\.Left - pillW - gap;/u,
      "胶囊左沿必须按「窗口左沿 − 胶囊宽 − 缝」算");
    assert.ok(gap < pillW, "缝不能大到离谱（那不是悬空，是飞走了）");

    // 贴屏幕左沿 / 最大化时放不下 ⇒ 必须收到窗口内侧，否则导航直接跑出屏幕（等于没了）。
    assert.match(RAIL_CODE, /if \(pillLeft < wa\.Left \+ 2\)/u, "必须有「外面放不下」的判定");
    assert.match(RAIL_CODE, /pillLeft = b\.Left \+ \(int\)Math\.Round\(D\(10\)\);/u,
      "放不下时要收到窗口内沿（留 10dip），不许让浮层跑到屏幕外");
    // 内侧/外侧只该记一次日志（Reposition 每帧都可能被叫，别刷屏）
    assert.match(RAIL_CODE, /if \(!_reportedInside \|\| inside != _reportedInside\)/u,
      "贴靠方式变化才记日志");
  });
});
