// 曲目推进规则 + 「播放到底在哪播」的护栏。
//
// ★ 2026-10-19 语义大改（用户口径 m01034）：
//   「程序内点播放按钮是要把视频播放到桌面，不是在程序内播放」——
//   窗口里那套播放器（playVideoA/B 双缓冲、ended 续播、advance、跨时段预热）整套删掉了，
//   播放改由 `POST /api/stage/play` 钉到桌面那层。
//   所以这里只剩两件事值得守：
//     ① 上一首 / 下一首 / 随机的**队列推进规则**（step 还在，规则没变）；
//     ② 播放确实被送到了桌面那层（而不是又悄悄在窗口里起了视频）。
//   以前那几条「正片接 ended / advance 在最后一首停住」测的是窗口内播放器，
//   那个实现已经不存在了，留着只会守着一个不存在的对象。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = new URL("../app/public/app.js", import.meta.url);
const src = readFileSync(APP, "utf8");
const WALLPAPER = new URL("../app/public/wallpaper.html", import.meta.url);
const wallpaper = readFileSync(WALLPAPER, "utf8");

/** 把 app.js 里 step() 原样抠出来跑 —— 不复制一份规则，避免测试慢慢和实现分家。 */
function loadLogic() {
  const start = src.indexOf("async function step(delta)");
  const end = src.indexOf('$("pbPlay")?.addEventListener', start);
  assert.ok(start > 0 && end > start, "找不到 step 那段源码（改名或挪位置了？）");
  const body = src.slice(start, end);

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
      step,
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

test("空队列时所有动作都不炸、也不播任何东西", async () => {
  const L = loadLogic();
  L.setList([]);
  await L.step(1);
  assert.deepEqual(L.getPlayed(), []);
});

// ---------------------------------------------------------------- 播放到底在哪播

test("点播放是把这一首钉到桌面那层（不是窗口内起视频）", () => {
  const start = src.indexOf("async function play(dir, name)");
  // ★ 2026-10-20：playIdle() 删了（pbPlay 改走 playback:toggle 遥控链路），
  //   切片终点改用 play() 后面紧跟的 writePlayerMeta。
  const end = src.indexOf("function writePlayerMeta(", start);
  assert.ok(start > 0 && end > start, "找不到 play() 源码");
  const body = src.slice(start, end);

  assert.match(body, /\/api\/stage\/play/u, "play() 必须把曲子交给桌面那层（POST /api/stage/play）");
  assert.match(body, /tellShell\("stage:changed"\)/u, "换片之后要叫外壳通知桌面立刻换，不能等 30 秒轮询");
  // 窗口内那套视频 / 全屏演奏页都不该再被 play() 碰
  assert.doesNotMatch(body, /playVideoA|playVideoB/u, "play() 里不该再操作窗口内的 video");
  assert.doesNotMatch(body, /openPlayer/u, "play() 不该再打开窗口内的全屏演奏页");
});

test("窗口内播放器已经删干净（不留半截实现）", () => {
  for (const dead of ["crossFadeTo", "warmNextSlot", "minutesToBoundary", "function advance("]) {
    assert.equal(src.includes(dead), false, `${dead} 已经删了，不该又冒出来`);
  }
});

// ★ 2026-10-19 审查 S37：这条的标题与注释原来写"并且循环播放 / 曲子要循环播（原版就是一场接一场）"，
//   而 §13 之后曲子已经改成 loop:false（放完问服务端要下一首，顺序/循环/单曲/随机四种走法由
//   /api/stage/advance 决定）。断言本身仍然成立（守的是 crossFade 的默认语义：只有显式
//   loop:false 才不循环），但旧文案会把后来人引到"把自动续播拆了"那条错路上去。
test("桌面那层：收到换片通知会立刻重算，换片默认循环（过场片才显式 loop:false）", () => {
  assert.match(wallpaper, /d\.stage === "changed"/u, "wallpaper.html 要处理外壳发来的换片消息");
  assert.match(
    wallpaper,
    /incoming\.loop = opts\.loop !== false/u,
    "crossFade 默认 loop=true；曲子之所以不循环，是调用点显式传 loop:false（见 stage-mode-guards ⑧）",
  );
});
