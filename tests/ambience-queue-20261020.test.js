/**
 * 待机环境音「不再一直同一首 + 放完自动接下一首」的护栏（2026-10-20）。
 *
 * 用户两句原话：
 *   ① 「为什么待机时播放的音乐还是那一首一直循环，待机音乐可不止那些」
 *   ② 「过了一会后待机音乐消失了，但待机画面还在」
 *
 * 根因（两个，一个比一个安静）：
 *   · `idleAmbienceFile()` 一个时段只挑**一个**文件，而 TOD12 覆盖 12:00–17:30（5.5 小时）
 *     ⇒ 目录里躺着 22 支，整下午只听得到同一支；
 *   · `<audio id="amb">` **既没有 loop、也没有 ended 处理**
 *     ⇒ 一支放完就永久静音，而待机正片是 loop 的 ⇒ 画面还在、声音没了。
 *
 * 判据分两层：
 *   A. 纯函数 `idleAmbienceQueue()` 真的给出「全目录、按种子轮转、可复现」的顺序；
 *   B. 前端 wallpaper.html 真的在 `ended` 上接下一支，并且「同一批不打断正在放的那首」。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanupDir, cleanupDirSync } = require("./support/cleanup.cjs");

const ROOT = path.resolve(__dirname, "..");

// assets.mjs 是 ESM，用动态 import。
let idleAmbienceQueue = null;
test.before(async () => {
  ({ idleAmbienceQueue } = await import("../app/assets.mjs"));
});

/** 造一个只有环境音的临时目录：ambient_loop_1..22.mp3（外加两个不该被认的干扰项）。 */
function makeAssetsDir(count = 22) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linli-amb-"));
  for (let i = 1; i <= count; i += 1) fs.writeFileSync(path.join(dir, `ambient_loop_${i}.mp3`), "x");
  // ★ 干扰项：这两支不该进队列（文件名不合口径 / 扩展名不对）
  fs.writeFileSync(path.join(dir, "ambient_loop_99.ogg"), "x");
  fs.writeFileSync(path.join(dir, "theme.mp3"), "x");
  return dir;
}

const noPin = () => "";
const pin = (name) => (key) => (key === "idle_ambience" ? name : "");

test("A① 一个时段给的是**整个目录**，不是一支", () => {
  const dir = makeAssetsDir();
  try {
    const q = idleAmbienceQueue(dir, 12345, noPin, 2);
    assert.equal(q.length, 22, `只给了 ${q.length} 支 —— 用户听到的自然只有一首`);
    assert.equal(new Set(q).size, 22, "队列里有重复项");
    // 不合口径的文件名不该混进来
    assert.ok(!q.includes("theme.mp3"), "theme.mp3 混进队列了");
    assert.ok(!q.includes("ambient_loop_99.ogg"), "ambient_loop_99.ogg 混进队列了");
  } finally { cleanupDirSync(dir); }
});

test("A② 同一份种子 / 同一个时段 ⇒ 同一份顺序（不许每次刷新都换）", () => {
  const dir = makeAssetsDir();
  try {
    const a = idleAmbienceQueue(dir, 777, noPin, 3);
    const b = idleAmbienceQueue(dir, 777, noPin, 3);
    assert.deepEqual(a, b, "同种子同 slot 给出的顺序不一样 —— 那会变成「每 30 秒换一首」");
    // 但不同时段应当从不同的地方起（否则一天下来还是同一个顺序开场）
    const c = idleAmbienceQueue(dir, 777, noPin, 4);
    assert.notDeepEqual(a, c, "换了时段顺序居然一模一样（轮转没生效）");
    // 起点不同，但成员集合必须一样
    assert.deepEqual([...a].sort(), [...c].sort(), "两个时段的成员集合不同 —— 有文件被漏掉了");
  } finally { cleanupDirSync(dir); }
});

test("A③ 用户手动钉过某一首 ⇒ 只给那一首（他的选择不许被「轮换」顶掉）", () => {
  const dir = makeAssetsDir();
  try {
    assert.deepEqual(idleAmbienceQueue(dir, 1, pin("ambient_loop_7.mp3"), 0), ["ambient_loop_7.mp3"]);
    // 钉的那支已经不在了 ⇒ 退回整目录轮转（否则待机就彻底没声了）
    const q = idleAmbienceQueue(dir, 1, pin("ambient_loop_77.mp3"), 0);
    assert.equal(q.length, 22, "钉住的文件不存在时没有回退到整目录");
  } finally { cleanupDirSync(dir); }
});

test("A④ 目录不存在 / 是空目录 ⇒ 空队列（不抛）", () => {
  assert.deepEqual(idleAmbienceQueue("", 1, noPin, 0), [], "空路径应当直接给空队列");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linli-amb-empty-"));
  try {
    assert.deepEqual(idleAmbienceQueue(dir, 1, noPin, 0), [], "空目录给了非空队列");
  } finally { cleanupDirSync(dir); }
});

/** 剥注释后读 wallpaper.html（里面 `<script>` 是普通 JS）。 */
function wallpaperJs() {
  const html = fs.readFileSync(path.join(ROOT, "app/public/wallpaper.html"), "utf8");
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("B① 放完自动接下一支（ended → nextAmbience），不是永久静音", () => {
  const js = wallpaperJs();
  assert.match(js, /amb\.addEventListener\("ended", \(\) => \{ void nextAmbience\(\); \}\)/u,
    "没有 ended 处理 —— 这正是「过了一会音乐消失了、画面还在」的根因");
  const fn = js.slice(js.indexOf("async function nextAmbience()"), js.indexOf("async function nextAmbience()") + 900);
  assert.match(fn, /ambIndex = \(ambIndex \+ 1\) % ambQueue\.length/u, "下一支不是按队列环形取");
  // 一轮走完要回去重新问一次服务器（时段可能变了），而不是硬从头轮
  assert.match(fn, /if \(ambIndex === 0\) \{ await tick\(\)/u, "一轮走完没有回头问一次服务器");
});

test("B② 同一批地址不打断正在放的那首（每 30 秒一次轮询，不能每次都重播）", () => {
  const js = wallpaperJs();
  const start = js.indexOf("function syncAmbience(");
  assert.ok(start > 0, "找不到 syncAmbience");
  let depth = 0;
  let end = start;
  const open = js.indexOf("{", start);
  for (let i = open; i < js.length; i += 1) {
    if (js[i] === "{") depth += 1;
    else if (js[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const fn = js.slice(open, end);
  assert.match(fn, /const same = q\.length === ambQueue\.length/u, "没比较「是不是同一批」");
  assert.match(fn, /if \(!same\)/u, "同一批时也必须不动 —— 否则每次轮询都把这首从头放");
  assert.match(fn, /amb\.paused && !amb\.ended/u,
    "「同一批要不要续上」必须排掉 ended 那一种（ended 归 nextAmbience 管，两处一起动会跳歌）");
});

test("B③ 队列为空时不能拿空地址去 play（会静音且不报错）", () => {
  const js = wallpaperJs();
  const fn = js.slice(js.indexOf("function playAmbience"), js.indexOf("function playAmbience") + 400);
  assert.match(fn, /if \(!url\) return stopAmbience\(\)/u, "空地址没走 stopAmbience");
});
