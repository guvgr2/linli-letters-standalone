// 播放队列的推进规则：上一首 / 下一首 / 播完自动往下。
//
// 为什么值得单独守：这三条以前全是错的，而且**界面看不出来**。
//   ① 随机播放有图标、有切换、有 toast，唯独没有随机 —— 点了图标变，行为还是顺序的；
//   ② 正片播完没人接 ended，停在那儿，看起来像"这首歌播完了"而不是"卡住了"；
//   ③ 顺序播放本该在最后一首停住，但因为 ② 根本走不到判断那一步，四种模式表现完全一样。
// 所以这里测的是**规则本身**，不是浏览器行为。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = new URL("../app/public/app.js", import.meta.url);
const src = readFileSync(APP, "utf8");

/** 把 app.js 里那段 step/advance 原样抠出来跑 —— 不复制一份规则，避免测试慢慢和实现分家。 */
function loadLogic() {
  const start = src.indexOf("async function step(delta)");
  const end = src.indexOf('$("pbPlay")?.addEventListener', start);
  assert.ok(start > 0 && end > start, "找不到 step/advance 那段源码（改名或挪位置了？）");
  const body = src.slice(start, end);

  // step/advance 依赖的四个外部量，用可注入的假货替掉：
  //   playlist() 给列表、player.dir 记当前、playMode 是模式下标、play() 记下播了什么。
  const harness = `
    let player = { dir: null };
    let playMode = 0;
    let played = [];
    let list = [];
    function playlist() { return list; }
    async function play(dir, name) { played.push({ dir, name }); player.dir = dir; }
    const PLAY_MODES = [{ key: "order" }, { key: "repeat" }, { key: "single" }, { key: "shuffle" }];
    ${body}
    return {
      setList: (l) => { list = l; },
      setCurrent: (d) => { player.dir = d; },
      setMode: (i) => { playMode = i; },
      getPlayed: () => played,
      reset: () => { played = []; },
      step, advance,
    };
  `;
  return new Function(harness)();
}

const SONGS = [{ dir: "a", name: "A" }, { dir: "b", name: "B" }, { dir: "c", name: "C" }];

test("下一首按列表顺序走", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("a");
  await L.step(1);
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["b"]);
});

test("上一首从第一首绕回最后一首（列表循环语义）", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("a");
  await L.step(-1);
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["c"]);
});

test("当前这首不在队列里时，下一首从列表头开始（不是原地打转）", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("zzz");
  await L.step(1);
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["a"]);
});

test("随机模式挑的不是当前这首", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("a"); L.setMode(3);   // 3 = shuffle
  // 多跑几轮：至少不能一直是"顺序的下一首" b
  const picked = new Set();
  for (let i = 0; i < 40; i++) {
    L.reset(); L.setCurrent("a");
    await L.step(1);
    const d = L.getPlayed()[0]?.dir;
    assert.notEqual(d, "a", "随机挑到了当前正在播的那首");
    picked.add(d);
  }
  assert.deepEqual([...picked].sort(), ["b", "c"], "随机应该能挑到列表里除当前以外的每一首");
});

test("随机模式在只有一首时不会卡死（退回顺序）", async () => {
  const L = loadLogic();
  L.setList([{ dir: "a", name: "A" }]); L.setCurrent("a"); L.setMode(3);
  await L.step(1);
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["a"], "只有一首时也应该继续播这一首，而不是什么都不做");
});

test("顺序播放：播完中途的某一首会往下走", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("a"); L.setMode(0);   // 0 = order
  await L.advance();
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["b"]);
});

test("顺序播放：最后一首播完就停住，不绕回第一首", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("c"); L.setMode(0);
  await L.advance();
  assert.deepEqual(L.getPlayed(), [], "顺序播放到最后一首应该停住，不能绕回去");
});

test("列表循环：最后一首播完绕回第一首", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("c"); L.setMode(1);   // 1 = repeat
  await L.advance();
  assert.deepEqual(L.getPlayed().map((p) => p.dir), ["a"]);
});

test("随机播放：播完挑一首不是自己的", async () => {
  const L = loadLogic();
  L.setList(SONGS); L.setCurrent("b"); L.setMode(3);
  await L.advance();
  const d = L.getPlayed()[0]?.dir;
  assert.ok(d === "a" || d === "c", `随机播完应该挑 a 或 c，实际挑了 ${d}`);
});

test("空队列时所有动作都不炸、也不播任何东西", async () => {
  const L = loadLogic();
  L.setList([]);
  await L.step(1);
  await L.advance();
  assert.deepEqual(L.getPlayed(), []);
});

test("正片真的接了 ended（以前只有过场片接）", () => {
  // ① 加监听
  assert.match(src, /v\.addEventListener\("ended", v\.__onEndedSong\)/u,
    "正片没有接 ended —— 一首放完会停在那儿");
  // ② 加之前先摘掉上一首的，否则 v 是常驻元素、监听越挂越多，播完一次连跳好几首
  const addAt = src.indexOf('v.addEventListener("ended", v.__onEndedSong)');
  const removeAt = src.indexOf("v.removeEventListener(\"ended\", v.__onEndedSong)");
  assert.ok(removeAt > 0 && removeAt < addAt, "接 ended 之前必须先摘掉上一首挂的那个监听");
  // ③ ended 里走的是 advance，不是 step(1) —— 顺序播放"停住"靠的是 advance 里的判断
  assert.match(src, /v\.__onEndedSong = \(\) => \{ void advance\(\); \}/u,
    "ended 里应该走 advance()（它知道顺序播放要在最后一首停住）");
});
