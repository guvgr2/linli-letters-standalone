// 待机素材与信件字体。
//
// ★ 为什么单独一个文件：`server.mjs` 一被 import 就会 listen 起服务，测试导不进它。
//   而这两块里的判据**必须能被单测直接验**才有意义 ——
//   白名单正则错一个字就是任意文件读取，字体魔数判错一次就是把垃圾写进数据目录。
//   （跟 `error-codes.mjs` 挪出来的理由一样：能验，才守得住。）
//
// 本文件只做纯计算 + 只读探测，**不写库**。要落盘的（环境音开关、字体字节）由
// `server.mjs` 调它的写接口 —— 读路径上一次库都不写，见下面 idleChoice 的注释。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIME_SLOTS, TIME_SLOT_LABELS, TOD_SLOT, SLOT_ORDER, playbackTimeOfDay, transitionFile } from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 待机素材（视频 + 环境音）
//
// 「待机」= 曲库里一首都没入库时，桌面那层该放什么。借的是原版游戏里那套
// Wallpaper_Presence / Wallpaper_Ambience：36 个 mp4（三套场景 × 三种状态 × 三个时段
// + 9 个过场片）与 22 段环境音。
//
// ★ 素材不进仓库（体积过大，绝不进 git），但待机壁纸视频（Wallpaper_Presence）会在
//   build.ps1 打包时从本机原版目录拷进安装包（落到 app/assets/Wallpaper_Presence），
//   让未装原版的用户也能用待机；环境音与曲目演奏视频仍不随包。
//   跟曲库一样是"指向"：打包时由 build.ps1 从游戏目录拷到 app\assets\，这里只负责找到它。
// ★ 路径按**安装后的落点**算：server.mjs 在 {app}\app\ 下，素材在它同级的 assets\ ⇒
//   默认 join(HERE, "assets")。再兜一层 join(HERE, "..", "assets")：万一打包脚本把素材
//   放在安装根（{app}\assets），这里也认。
// ★ LINLI_ASSETS_DIR 跟 LINLI_DATA_DIR / LINLI_PORT 同一套路，是**测试用的口子**：
//   真渲染体检要指着游戏目录里那 2.88 GB 真素材跑，不能为了自测把它们拷进仓库。
// ★ LINLI_ASSETS_DIR 给空串时不能当成"根目录是 ''"—— `join("", "x")` 是相对**当前工作目录**，
//   那等于让素材根跟着启动目录漂。空串一律丢弃，退到下面那两个默认落点。
// ★ 2026-10-19 补第三档：**本机原版游戏装过就把它的 assets 认下来**。
//   用户口径（m01034）：「刚打开软件就播放音乐，不应该是播放待机视频和待机音乐吗」
//   —— 待机视频/环境音只有原版那套 2.88 GB 素材能给，而打包时没把它拷进 app\assets
//   （仓库公开、包也不该有 2.8 GB），于是 hasAssets 恒 false、桌面那层只能退回一块空白。
//   原版**装在用户自己机器上**时，这些素材本来就在那儿；这里只是把它当"引用"找到，
//   不拷、不改、不写。找不到就照旧没有待机素材。
//   ★ 查找顺序写死在这：%APPDATA% 的 Steam 配置里那几个库盘 → 常见安装盘。
//     只认 `steamapps\common\BSide Olivia Lin Test\<版本>\assets\Wallpaper_Presence`。
// ★ 两个子目录名必须先声明：detectedGameAssets() 会用到 PRESENCE_SUBDIR，
//   而 ASSET_ROOTS 的初始化（下面几行）在模块加载时就会调到它 —— 声明晚了就是 TDZ 报错。
export const PRESENCE_SUBDIR = "Wallpaper_Presence";
export const AMBIENCE_SUBDIR = "Wallpaper_Ambience";

/**
 * ★ 2026-10-21 加：**随包的自制过渡片**目录（`app/transitions/`）。
 *
 * 为什么要有：原版有 9 个过场片（`{场景}_Transition_{旧}_{新}.mp4`），但**不随包**
 *（红线：原版素材不打包不复制），只认本机装过的原版目录 ⇒ 没装原版的用户切时段是硬切。
 * 这批是咱们自己生成的（纯本机、版权干净，生成脚本在 `analysis/_feat-20261021/`），
 * 命名**沿用现有规则** ⇒ `transitionFile()` / `VIDEO_NAME_RE` / 前端播放全部复用，零改动。
 *
 * ★ 优先级：**素材根（原版）优先，找不到才落到这里** —— 装了原版的用户继续看原版的高质量
 *   过场片，咱们这批只是"没装原版时的兜底"，不抢原版的位。
 *   （所以**不能**把这批 3 支 A 场景自制过渡片塞进 `app/assets/Wallpaper_Presence/`：
 *   那个目录在 ASSET_ROOTS 里排在原版目录**前面**，一旦塞进"只有 3 支 A"的残缺集，
 *   就会把 B/C 场景与原版高质量过场全挡掉——待机视频/环境音的查找被残缺集劫持。
 *   反之，build.ps1 在打包时把**完整**原版 Wallpaper_Presence（27 正片 + 9 过场）拷进
 *   app\assets\Wallpaper_Presence\，正是要靠这个"优先"让安装包自包含；那是完整集，不算劫持。）
 * ★ 2026-10-21：这个目录允许用 `LINLI_TRANSITIONS_DIR` 指到别处。加它不是为了产品功能，
 *   是为了**测试能把"自带片也没有"这个状态造出来** —— 2026-10-21 起 A/B/C 九个方向全有片子，
 *   测试若不能隔离这一层，"素材全缺 ⇒ url:null + 过场片缺失"这条契约就永远测不到了
 *   （那条契约是真的：安装包残缺时用户会撞上）。与 `LINLI_ASSETS_DIR` 同一个口径。
 */
export const TRANSITIONS_DIR = process.env.LINLI_TRANSITIONS_DIR || join(HERE, "transitions");

/** 盘符清单：只留真存在的（在 A–Z 上 existsSync 一次，26 次系统调用，代价可以忽略）。 */
function driveRoots() {
  const list = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { if (statSync(root).isDirectory()) list.push(root); } catch { /* 没这个盘 */ }
  }
  return list;
}

/** 本机所有 Steam「库根」目录。
 *
 *  ★ 2026-10-19 实测踩坑：只按 `C:\Program Files (x86)\Steam` 那几个常见路径找是**找不到**的 ——
 *    本机的 Steam 装在 `D:\steam1`，游戏库在 `E:\SteamLibrary`，而
 *    `E:\SteamLibrary\steamapps\libraryfolders.vdf` **不存在**（那个文件只在 Steam 自己的
 *    安装目录里有）。所以必须按「盘符 × 顶层目录」去翻，认出哪个目录里有
 *    `steamapps\libraryfolders.vdf`（或 `config\libraryfolders.vdf`），再顺着里面的 "path" 展开。
 *    只读顶层目录名，不递归全盘：每盘一次 readdir。 */
function steamLibraryRoots() {
  const roots = new Set();
  for (const drive of driveRoots()) {
    let names = [];
    try {
      names = readdirSync(drive, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const name of names) {
      const dir = join(drive, name);
      const vdf = [
        join(dir, "steamapps", "libraryfolders.vdf"),
        join(dir, "config", "libraryfolders.vdf"),
      ].find((p) => existsSync(p));
      if (!vdf) continue;
      roots.add(dir);
      try {
        // "path" 是全部库目录；vdf 里是双反斜杠，要还原。
        const text = readFileSync(vdf, "utf8");
        for (const m of text.matchAll(/"path"\s+"([^"]+)"/gu)) roots.add(m[1].replaceAll("\\\\", "\\"));
      } catch { /* 这个 vdf 读不了就算了，起码 root 本身还在 */ }
    }
  }
  return [...roots];
}

let _detectedAssets = null;
let _detectedOnce = false;
/** 本机原版游戏的 assets 目录（含 Wallpaper_Presence 的那个），没有就 null。只探一次。 */
export function detectedGameAssets() {
  if (_detectedOnce) return _detectedAssets;
  _detectedOnce = true;
  // ★ 测试开关：`LINLI_NO_GAME_ASSETS=1` 时**不**去认本机装的原版。
  //   护栏测试要造"这台机器上没有待机素材"的场景，而测试机往往正装着游戏
  //   （本机就是），不关掉自动发现的话，这个场景永远造不出来。
  if (String(process.env.LINLI_NO_GAME_ASSETS ?? "") === "1") return null;
  const env = String(process.env.LINLI_GAME_ASSETS ?? "").trim();
  const candidates = env ? [env] : [];
  for (const root of steamLibraryRoots()) {
    const common = join(root, "steamapps", "common", "BSide Olivia Lin Test");
    let versions = [];
    try { versions = readdirSync(common); } catch { continue; }
    for (const v of versions) candidates.push(join(common, v, "assets"));
  }
  for (const dir of candidates) {
    try {
      if (statSync(join(dir, PRESENCE_SUBDIR)).isDirectory()) { _detectedAssets = dir; break; }
    } catch { /* 不是这个 */ }
  }
  return _detectedAssets;
}

const ASSET_ROOTS = [
  String(process.env.LINLI_ASSETS_DIR ?? "").trim(),
  join(HERE, "assets"),
  join(HERE, "..", "assets"),
  detectedGameAssets(),   // 本机装过原版 ⇒ 直接用它那套（只读引用）
].filter(Boolean);

/** 素材根目录下某个子目录，找到第一个真存在的；都没有就 null。 */
export function assetRoot(subdir) {
  for (const root of ASSET_ROOTS) {
    const dir = join(root, subdir);
    try { if (statSync(dir).isDirectory()) return dir; } catch { /* 不存在就试下一个 */ }
  }
  return null;
}

/** 素材根（父目录）。外壳/设置页要告诉用户"素材落在哪"，给的是这个而不是某个子目录。 */
export function assetsDir() {
  const presence = assetRoot(PRESENCE_SUBDIR);
  return presence ? dirname(presence) : null;
}

// ★ 白名单正则：只认这几种文件名，别的（..\..\server.mjs、.mp4.exe、绝对路径）一律 400。
//   过场片也是 mp4，所以 /api/idle/video 两条都放行。**绝不**把 query 字符串拼进路径。
export const PRESENCE_NAME_RE = /^[ABC]_R[123]_(?:1200|1730|2000)\.mp4$/u;
export const TRANSITION_NAME_RE = /^[ABC]_Transition_(?:1200_1730|1730_2000|2000_1200)\.mp4$/u;
export const VIDEO_NAME_RE = /^(?:[ABC]_R[123]_(?:1200|1730|2000)|[ABC]_Transition_(?:1200_1730|1730_2000|2000_1200))\.mp4$/u;
export const AMBIENCE_NAME_RE = /^ambient_loop_\d{1,2}\.mp3$/u;

export const IDLE_SCENES = Object.freeze(["A", "B", "C"]);
export const IDLE_STATES = Object.freeze(["R1", "R2", "R3"]);

/** 32 位可复现伪随机：同一种子必得同一结果。这里要的正是"每次都一样"，不是"随便"。 */
export function seededInt(seed, salt) {
  let t = (Number(seed) + Math.imul(salt, 0x9e3779b9)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

export const IDLE_SEED_KEY = "idle_seed";

/**
 * 当前该用哪一套场景/状态。
 * ★★ 为什么必须**持久化**（写进 settings 的 idle_scene / idle_state）：
 *   前端每 30 秒轮询一次 /api/idle/next。如果把"随机挑一组"写在请求里，
 *   每一轮都会换片 ⇒ 桌面上的画面 30 秒跳一次，根本没法看。
 *   第一组随机挑完之后就钉住，之后只在设置页里能看到、也不再变。
 * ★ 原版客户端里**没有**"选哪套场景/状态"的规则 —— 那是游戏后端把 URL 推给 CEF 页面的，
 *   页面只管播。所以我们自己决定场景与状态，然后按时段换后缀。借原版的只有「换片 + 过场」这一段。
 *
 * @param {string} seed 已落库的种子（十进制字符串；非法值由调用方归一成 "0"）
 * @param {(key: string) => string|null} getSetting 只读设置
 */
export function idleChoice(seed, getSetting) {
  const scene = String(getSetting("idle_scene") ?? "");
  const state = String(getSetting("idle_state") ?? "");
  // 老库里已经钉过的照旧用 —— 不让老用户一升级就换画面。
  if (IDLE_SCENES.includes(scene) && IDLE_STATES.includes(state)) return { scene, state };
  const n = Number.isFinite(Number(seed)) ? Number(seed) : 0;
  return {
    scene: IDLE_SCENES[seededInt(n, 1) % IDLE_SCENES.length],
    state: IDLE_STATES[seededInt(n, 2) % IDLE_STATES.length],
  };
}

/** 环境音**按时段轮换**：同一时段内钉住（不能每轮 tick 都换），换时段就换一首。
 *  ★ 2026-10-20（用户：「待机音乐只会循环一个背景音乐」）：以前只按种子钉一个文件，
 *    一天到晚都是同一首 ⇒ 把时段 slot 混进选取盐值，早/午/晚各挑各的。
 *  只读：按「种子 + 时段」从排好序的目录里取；用户手动钉过的（idle_ambience 设置）照旧最优先。 */
export function idleAmbienceFile(dir, seed, getSetting, slot = null) {
  if (!dir) return null;
  const keep = String(getSetting("idle_ambience") ?? "");
  if (AMBIENCE_NAME_RE.test(keep) && existsSync(join(dir, keep))) return keep;
  const files = readdirSync(dir).filter((f) => AMBIENCE_NAME_RE.test(f)).sort((a, b) => a.localeCompare(b, "en"));
  if (!files.length) return null;
  const salt = Number(slot) || 0;
  return files[seededInt((Number(seed) || 0) + salt, 3) % files.length];
}

/** 同一时段里的**全部**环境音，按「种子 + 时段」轮转出一个播放顺序。
 *
 *  ★ 2026-10-20（用户：「待机时播放的音乐还是那一首一直循环，待机音乐可不止那些」）：
 *    `idleAmbienceFile` 只挑**一个**文件，而一个时段（TOD12 覆盖 12:00–17:30）长达几小时，
 *    于是整段时间只有同一首 —— 目录里明明躺着十几首。
 *    这里给出顺序，前端放完一首接下一首，一轮走完再从第一首开始。
 *  ★ 用户手动钉过 `idle_ambience` 的，只返回那一首（那是他的选择，不许被"轮换"顶掉）。
 */
export function idleAmbienceQueue(dir, seed, getSetting, slot = null) {
  if (!dir) return [];
  const keep = String(getSetting("idle_ambience") ?? "");
  if (AMBIENCE_NAME_RE.test(keep) && existsSync(join(dir, keep))) return [keep];
  const files = readdirSync(dir)
    .filter((f) => AMBIENCE_NAME_RE.test(f))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (!files.length) return [];
  const salt = Number(slot) || 0;
  const start = seededInt((Number(seed) || 0) + salt, 3) % files.length;
  return files.slice(start).concat(files.slice(0, start));
}

/** 当前时段（正常跟本地时钟；todOverride 只给单测/预加载用，跟 /api/library/play 一个套路）。 */
export function idleTimeOfDay(todOverride, now = new Date()) {
  const todParam = String(todOverride ?? "").toUpperCase();
  if (TIME_SLOTS.includes(todParam)) return todParam;
  return playbackTimeOfDay(now.getHours() * 60 + now.getMinutes());
}

/** /api/idle/next 的主体：按当前时间给出该播的正片与环境音。 */
export function idleNext({ todOverride = null, seed = 0, getSetting, now = new Date() }) {
  const tod = idleTimeOfDay(todOverride, now);
  const label = TIME_SLOT_LABELS[tod] ?? tod;
  const slot = TOD_SLOT[tod] ?? "1200";
  const { scene, state } = idleChoice(seed, getSetting);
  const base = { tod, label, scene, state, slot };
  const presence = assetRoot(PRESENCE_SUBDIR);
  if (!presence) return { ...base, video: null, ambience: null, hasAssets: false };
  let file = `${scene}_${state}_${slot}.mp4`;
  if (!PRESENCE_NAME_RE.test(file) || !existsSync(join(presence, file))) {
    // ★ 选中的那一组在这个时段缺片 ⇒ 退到目录里同时段的任意一片。
    //   只在这一次响应里用，不改库（GET 不写库）—— 素材补回来它自己就恢复了。
    const alt = readdirSync(presence).find((f) => PRESENCE_NAME_RE.test(f) && f.endsWith(`_${slot}.mp4`));
    if (!alt) return { ...base, video: null, ambience: null, hasAssets: false };
    file = alt;
  }
  const ambienceFile = idleAmbienceFile(assetRoot(AMBIENCE_SUBDIR), seed, getSetting, slot);
  // 环境音开关（设置页那张卡片控制）。
  // ★ 关掉时**连地址都不给**：只给 `ambienceOn:false` 而照发地址，前端任何一个
  //   忘了判开关的地方都会把声音放出来 —— 用户的"关"不该依赖调用方记得检查。
  const ambienceOn = String(getSetting("idle_ambience_on") ?? "1") === "1";
  // ★ 2026-10-20：整条轮换队列（第一项就是 ambience）。前端放完一首接下一首。
  const ambienceQueue = ambienceOn
    ? idleAmbienceQueue(assetRoot(AMBIENCE_SUBDIR), seed, getSetting, slot)
    : [];
  return {
    ...base,
    video: `/api/idle/video?file=${encodeURIComponent(file)}`,
    ambience: ambienceOn && ambienceFile
      ? `/api/idle/ambience?file=${encodeURIComponent(ambienceFile)}`
      : null,
    ambienceQueue: ambienceQueue.map((f) => `/api/idle/ambience?file=${encodeURIComponent(f)}`),
    hasAssets: true,
    ambienceOn,
  };
}

/** 换时段时的过场片：from/to 必须是相邻的两档，否则返回 null（前端直接切正片）。
 *
 * ★ 2026-10-19 真机探针补的两件事（这条路由此前零测试）：
 *   ① 参数其实是**两套写法混着的**：`/api/idle/next` 回的 `slot` 是 `"1200"/"1730"/"2000"`
 *      （前端就是拿它以原样回传），而别处的 `tod` 是 `"TOD12"/"TOD1730"/"TOD20"`。
 *      以前这里只认前者，传后者会得到一句「不是相邻时段」—— **它其实是把"你名字写错了"
 *      报成了"这两档不相邻"**，两种完全不同的问题给同一句话，排查时会被带偏。
 *      现在两套写法都收，真不认识的才说「认不出这两个时段」。
 *   ② `reason` 分得更细：认不出 / 不相邻 / 素材缺失，三种各说各的。
 */
export function idleTransition({ from, to, scene, seed = 0, getSetting }) {
  const wanted = /^[ABC]$/u.test(String(scene ?? "")) ? String(scene) : idleChoice(seed, getSetting).scene;
  const base = { scene: wanted, from: String(from ?? "").trim(), to: String(to ?? "").trim() };

  // 两套写法归一：`TOD12 → 1200`；本来就是 `1200` 的原样留着。
  const toSlotOf = (value) => {
    const raw = String(value ?? "").trim();
    if (SLOT_ORDER.includes(raw)) return raw;
    const mapped = TOD_SLOT[raw];
    return mapped && SLOT_ORDER.includes(mapped) ? mapped : null;
  };
  const fromSlot = toSlotOf(base.from);
  const toSlot = toSlotOf(base.to);
  if (!fromSlot || !toSlot) {
    return { url: null, file: null, ...base, reason: "认不出这两个时段" };
  }

  const file = transitionFile(wanted, fromSlot, toSlot);
  if (!file) {
    return { url: null, file: null, ...base, from: fromSlot, to: toSlot, reason: "不是相邻时段" };
  }
  const dir = assetRoot(PRESENCE_SUBDIR);
  if (!dir || !existsSync(join(dir, file))) {
    // ★ 2026-10-21：原版过场片不随包 ⇒ 没装原版时原来直接"过场片缺失"（前端硬切）。
    //   现在先落到**随包的自制过渡片**（app/transitions/，同名同规则、版权干净、纯本机生成）；
    //   url 形状与原版完全一致 ⇒ 前端零改动。连它都没有（理论上不会：随包了）才真的缺失。
    if (existsSync(join(TRANSITIONS_DIR, file))) {
      return {
        scene: wanted, from: fromSlot, to: toSlot, file,
        url: `/api/idle/video?file=${encodeURIComponent(file)}`,
        source: "built-in",
      };
    }
    return { url: null, file: null, ...base, from: fromSlot, to: toSlot, reason: "过场片缺失" };
  }
  return {
    scene: wanted, from: fromSlot, to: toSlot, file,
    url: `/api/idle/video?file=${encodeURIComponent(file)}`,
  };
}

/** 设置页「待机」卡片要看的一行状态：现在用哪套、素材在不在。 */
export const DEFAULT_AMBIENCE_VOLUME = 35;
// ★ 2026-10-20（用户原话：「咱们的程序的音乐声音是不是太小了，我要把声音调到好大才能听见，
//   这个歌曲音量你和原版游戏学学吧」）：原版曲子是不衰减全量放的（同一批 mp4，音轨就那点
//   动态，放多大声全靠这条滑块）⇒ 默认值跟原版口径对齐 = 100（不衰减）。用户自己存过
//   的值不受影响（读侧只认库里的 song_volume）。再小就只剩 mp4 本身的响度了，那是素材
//   的天花板，不是程序的锅。
export const DEFAULT_SONG_VOLUME = 100;

/**
 * 音量设置的读取口径：**读侧宽容**（值坏了就用默认，不能因为一个脏值让设置页打不开），
 * 写侧的严格校验在 server.mjs（非法值一律 400，不静默夹）。
 * 存的是 0–100 的整数（跟界面上的滑块一致），播放时才除 100 变成 0–1。
 */
export function volumeSetting(getSetting, key, fallback) {
  const raw = String(getSetting(key) ?? "").trim();
  if (!/^\d{1,3}$/u.test(raw)) return fallback;
  return Math.min(100, Math.max(0, Number(raw)));
}

export function idleSettingsView({ seed = 0, getSetting, now = new Date() }) {
  const { scene, state } = idleChoice(seed, getSetting);
  const tod = idleTimeOfDay(null, now);
  const slot = TOD_SLOT[tod] ?? "1200";
  const presence = assetRoot(PRESENCE_SUBDIR);
  return {
    ambience: String(getSetting("idle_ambience_on") ?? "1") === "1",
    // ★ 2026-10-19 用户要求：「这个背景音要加个调节背景音音量的条，还要加个调节演奏音量的条」
    //   ⇒ 两条音量都落库（ambience_volume / song_volume，0–100），桌面那层每次 tick 读它。
    //   以前这两个值是写死在 wallpaper.html 里的常量（0.35 / 0.55），改不了。
    ambienceVolume: volumeSetting(getSetting, "ambience_volume", DEFAULT_AMBIENCE_VOLUME),
    songVolume: volumeSetting(getSetting, "song_volume", DEFAULT_SONG_VOLUME),
    scene,
    state,
    tod,
    slot,
    label: TIME_SLOT_LABELS[tod] ?? tod,
    hasAssets: Boolean(presence && existsSync(join(presence, `${scene}_${state}_${slot}.mp4`))),
    ambienceAssets: Boolean(assetRoot(AMBIENCE_SUBDIR)),
    assetsDir: presence ?? null,
  };
}

/**
 * 把 query 里那个文件名收成一个**只可能是白名单里那个文件**的名字。
 * ★ 防目录穿越就靠两步：① 只取 basename（`..\..\server.mjs` 会先被削成 `server.mjs`）；
 *   ② 正则白名单（`server.mjs`、`x.mp4.exe`、`passwd` 全都不符 ⇒ null）。
 *   全程不把 query 原样拼进路径。
 */
export function idleFileName(raw, pattern) {
  const name = basename(String(raw ?? ""));
  return pattern.test(name) ? name : null;
}

/** 待机素材目录里某个白名单文件的绝对路径；不在就 null。 */
export function idleFilePath(subdir, raw, pattern) {
  const name = idleFileName(raw, pattern);
  if (!name) return null;
  const dir = assetRoot(subdir);
  if (dir) {
    const target = join(dir, name);
    if (existsSync(target)) return target;
  }
  // ★ 2026-10-21 回退：素材根里没有（没装原版）时，试**随包的自制过渡片**（app/transitions/）。
  //   白名单校验（idleFileName：basename + 正则）在进来之前已做过 ⇒ 这条回退同样防穿越。
  const builtin = join(TRANSITIONS_DIR, name);
  return existsSync(builtin) ? builtin : null;
}

// ---------------------------------------------------------------- 信件字体
//
// ★ 为什么字体**不进程序、也不进系统**（2026-10-15 用户定）：
//   ① 不进程序 —— 它是汉仪版权字体，随安装包分发同时踩官方条款 4.4.3（不得附带地
//      提供给第三人）与 4.4.4（不得嵌入计算机程序）。见 协议.txt / THIRD-PARTY-NOTICES.txt。
//   ② 不进系统 —— 程序不该替用户改他的机器（不碰 C:\Windows\Fonts、不碰注册表、
//      不调字体安装 API）。用户从官网下的是他自己的文件，我们凭他一句"就用它"把它收进
//      **本程序自己的数据目录**，只在本程序里用；将来连程序带目录一起删，系统里不留痕迹。
//   ⇒ 存放位置 %APPDATA%\LinliLetters\fonts\（跟着 DATA_DIR 走，测试时
//     可以用 LINLI_DATA_DIR 指到别处）。前端用 @font-face 从 /api/font/file 取这份文件。
// ★★ 两个槽位（2026-10-15 补第二支）：**原版本来就是两支，各管一档**，我们以前只接了一支。
//     读自原版 assets/index-9ba3e01a.css（只有 2 条 @font-face）：
//       · letter  = 林离写的信 —— 读信正文 `.mail-envelope__letter-text`（20px/1.5）
//                                 与她的回信 `.mail-box-reply-content-*` ⇒ **SentyTEA**（新蒂下午茶体）
//       · compose = 你自己写信那个输入框 `.mail-box-write-content` / `-dialog-content`
//                                 ⇒ **HanyiSentyGarden**（漢儀新蒂花園體）
//     以前写信框复用 --letter-font ⇒ 写信与读信同一支，跟原版差这一处。
export const FONT_SLOTS = Object.freeze({ letter: "letter.ttf", compose: "compose.ttf" });
// 常见字体魔数：TrueType、CFF/OpenType(OTTO)、Apple 'true'、字体集合 'ttcf'。
// ★ 只认这四种。不能"传什么存什么" —— 那 fonts/ 就成了任意文件的落地点。
export const FONT_MAGICS = Object.freeze([0x00010000, 0x4f54544f, 0x74727565, 0x74746366]);
export const FONT_MAX_BYTES = 80 * 1024 * 1024;
// 得有其中一张才谈得上有字形（TrueType 轮廓 / CFF 轮廓 / 位图/彩色）。
const GLYPH_TABLES = ["glyf", "CFF ", "CFF2", "CBDT", "EBDT", "sbix"];

/**
 * 把 sfnt 的表目录真读一遍，读不通就不是字体。返回 { dir, numTables, tags }，否则 null。
 * ★ 只看开头 4 个字节的魔数是不够的：前 4 字节对得上、后面全是垃圾的文件照样过关，
 *   fonts\ 仍然是任意内容的落地点，而且会声明一个**永远加载不出来**的 @font-face
 *   （字迹静默退回楷体，界面上却查不出哪儿错了）。
 *   ⇒ 现在真的走表目录：表数合理、目录装得进文件、有 name 表、有字形表。
 * ★ 只认裸 sfnt（.ttf / .otf / .ttc）。WOFF/WOFF2 的表目录是另一套封装，不支持 ——
 *   不支持要说清楚，不能"收下再说"（收下就是坏 @font-face）。
 */
export function fontTableDir(buf) {
  if (!buf || buf.length < 12) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o, false);
  const u32 = (o) => dv.getUint32(o, false);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (!FONT_MAGICS.includes(u32(0))) return null;
  // TTC（字体集合）真正的 offset table 在第 12 字节指向的偏移处，取第一支。
  let dir = 0;
  if (tag(0) === "ttcf") {
    dir = u32(12);
    if (dir + 12 > buf.length || !FONT_MAGICS.includes(u32(dir))) return null;
  }
  const numTables = u16(dir + 4);
  // 表数上限给个宽松值：真实字体几十张，这里 512 足够，只为挡掉"垃圾当表数"。
  if (numTables === 0 || numTables > 512) return null;
  if (dir + 12 + numTables * 16 > buf.length) return null;
  const tags = [];
  for (let i = 0; i < numTables; i++) tags.push(tag(dir + 12 + i * 16));
  if (!tags.includes("name")) return null;                        // 连名字都没有 ⇒ 声明不出族名
  if (!tags.some((t) => GLYPH_TABLES.includes(t))) return null;   // 没有字形数据 ⇒ 什么也显示不出来
  return { dir, numTables, tags };
}

/** 是不是一个**能用的**字体文件。 */
export function looksLikeFont(buf) {
  return fontTableDir(buf) !== null;
}

/**
 * 从字体的 name 表里读出家族名（nameID=1），读不到返回 null。
 * ★ 这里**真的读了文件**：/api/font/status 不能"文件在就报 ok" ——
 *   用户可能把一个坏文件（或改了扩展名的别的东西）放进目录，那样前端会声明一个
 *   永远加载不出来的 @font-face，字迹静默退回楷体却查不出原因。
 * ★ 只解析 name 表这一小块，不引字体库：我们要的只是一个"能显示给人看的名字"。
 */
export function readFontFamily(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o, false);
  const u32 = (o) => dv.getUint32(o, false);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  // 表目录的解析跟 looksLikeFont 共用一份（ttcf 的偏移跳转那一段也在里面），别写两遍。
  const head = fontTableDir(buf);
  if (!head) return null;
  const { dir, numTables } = head;
  let nameOff = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = dir + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    if (tag(rec) === "name") { nameOff = u32(rec + 8); break; }
  }
  if (nameOff < 0 || nameOff + 6 > buf.length) return null;
  const count = u16(nameOff + 2);
  const strings = nameOff + u16(nameOff + 4);
  // 候选：nameID=1（家族名）优先，退而求其次 nameID=16（排版家族名）。
  for (const wanted of [1, 16]) {
    let best = null;
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12;
      if (rec + 12 > buf.length) break;
      if (u16(rec + 6) !== wanted) continue;
      const platform = u16(rec);
      const language = u16(rec + 4);
      const len = u16(rec + 8);
      const start = strings + u16(rec + 10);
      if (!len || start + len > buf.length) continue;
      let text;
      try {
        // Windows(3) / Unicode(0) 平台是 UTF-16BE；Mac(1) 那档家族名基本是 ASCII。
        text = (platform === 3 || platform === 0)
          ? new TextDecoder("utf-16be").decode(buf.subarray(start, start + len))
          : buf.toString("latin1", start, start + len);
      } catch { continue; }
      text = text.replace(/[\u0000-\u001f]/gu, "").trim();
      if (!text) continue;
      // 打分：Windows/Unicode 平台、英文(0x409) 最优先 —— 那是最通用的那个名字。
      const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 0x0409 ? 2 : 0);
      if (!best || score > best.score) best = { score, text };
    }
    if (best) return best.text;
  }
  return null;
}

/** 字体落在数据目录的哪一份。slot 只认 letter / compose，其余回落 letter。 */
export function fontFile(dataDir, slot) {
  const name = FONT_SLOTS[slot] ?? FONT_SLOTS.letter;
  const key = FONT_SLOTS[slot] ? slot : "letter";
  return { key, name, path: join(dataDir, "fonts", name) };
}
export const FONT_DIR_NAME = "fonts";

/**
 * 数据目录里某一槽字体的状态：文件真在、且真是字体，才 ok。
 * ★ slot 只认 letter / compose 两个，其余一律回落到 letter —— 不能让调用方指定任意文件名。
 */
export function letterFontStatus(dataDir, slot = "letter") {
  const f = fontFile(dataDir, slot);
  if (!existsSync(f.path)) return { ok: false, slot: f.key, fileName: f.name };
  let buf;
  try { buf = readFileSync(f.path); } catch { return { ok: false, slot: f.key, fileName: f.name }; }
  if (!looksLikeFont(buf)) return { ok: false, slot: f.key, fileName: f.name, note: "文件头不是字体格式" };
  return {
    ok: true, slot: f.key, fileName: f.name, bytes: buf.length,
    family: readFontFamily(buf) ?? (f.key === "compose" ? "LinliCompose" : "LinliLetter"),
  };
}

/** 两支一起问：设置页要一次显示"读信那支在不在 / 写信那支在不在"。 */
export function allFontStatus(dataDir) {
  return { letter: letterFontStatus(dataDir, "letter"), compose: letterFontStatus(dataDir, "compose") };
}
