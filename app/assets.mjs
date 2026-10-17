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
import { TIME_SLOTS, TIME_SLOT_LABELS, TOD_SLOT, playbackTimeOfDay, transitionFile } from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 待机素材（视频 + 环境音）
//
// 「待机」= 曲库里一首都没入库时，桌面那层该放什么。借的是原版游戏里那套
// Wallpaper_Presence / Wallpaper_Ambience：36 个 mp4（三套场景 × 三种状态 × 三个时段
// + 9 个过场片）与 22 段环境音。
//
// ★ 素材不随仓库、也不进 public/ —— 仓库是公开的，而 2.88 GB 视频更不可能塞进安装包。
//   跟曲库一样是"指向"：打包时由 build.ps1 从游戏目录拷到 app\assets\，这里只负责找到它。
// ★ 路径按**安装后的落点**算：server.mjs 在 {app}\app\ 下，素材在它同级的 assets\ ⇒
//   默认 join(HERE, "assets")。再兜一层 join(HERE, "..", "assets")：万一打包脚本把素材
//   放在安装根（{app}\assets），这里也认。
// ★ LINLI_ASSETS_DIR 跟 LINLI_DATA_DIR / LINLI_PORT 同一套路，是**测试用的口子**：
//   真渲染体检要指着游戏目录里那 2.88 GB 真素材跑，不能为了自测把它们拷进仓库。
// ★ LINLI_ASSETS_DIR 给空串时不能当成"根目录是 ''"—— `join("", "x")` 是相对**当前工作目录**，
//   那等于让素材根跟着启动目录漂。空串一律丢弃，退到下面那两个默认落点。
const ASSET_ROOTS = [
  String(process.env.LINLI_ASSETS_DIR ?? "").trim(),
  join(HERE, "assets"),
  join(HERE, "..", "assets"),
].filter(Boolean);
export const PRESENCE_SUBDIR = "Wallpaper_Presence";
export const AMBIENCE_SUBDIR = "Wallpaper_Ambience";

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

/** 环境音也钉住一段（同样不能每轮换），且同样只读：按种子从排好序的目录里取。 */
export function idleAmbienceFile(dir, seed, getSetting) {
  if (!dir) return null;
  const keep = String(getSetting("idle_ambience") ?? "");
  if (AMBIENCE_NAME_RE.test(keep) && existsSync(join(dir, keep))) return keep;
  const files = readdirSync(dir).filter((f) => AMBIENCE_NAME_RE.test(f)).sort((a, b) => a.localeCompare(b, "en"));
  if (!files.length) return null;
  return files[seededInt(Number(seed) || 0, 3) % files.length];
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
  const ambienceFile = idleAmbienceFile(assetRoot(AMBIENCE_SUBDIR), seed, getSetting);
  // 环境音开关（设置页那张卡片控制）。
  // ★ 关掉时**连地址都不给**：只给 `ambienceOn:false` 而照发地址，前端任何一个
  //   忘了判开关的地方都会把声音放出来 —— 用户的"关"不该依赖调用方记得检查。
  const ambienceOn = String(getSetting("idle_ambience_on") ?? "1") === "1";
  return {
    ...base,
    video: `/api/idle/video?file=${encodeURIComponent(file)}`,
    ambience: ambienceOn && ambienceFile
      ? `/api/idle/ambience?file=${encodeURIComponent(ambienceFile)}`
      : null,
    hasAssets: true,
    ambienceOn,
  };
}

/** 换时段时的过场片：from/to 必须是相邻的两档，否则返回 null（前端直接切正片）。 */
export function idleTransition({ from, to, scene, seed = 0, getSetting }) {
  const fromSlot = String(from ?? "").trim();
  const toSlot = String(to ?? "").trim();
  const wanted = /^[ABC]$/u.test(String(scene ?? "")) ? String(scene) : idleChoice(seed, getSetting).scene;
  const file = transitionFile(wanted, fromSlot, toSlot);
  if (!file) {
    return { url: null, file: null, scene: wanted, from: fromSlot, to: toSlot, reason: "不是相邻时段" };
  }
  const dir = assetRoot(PRESENCE_SUBDIR);
  if (!dir || !existsSync(join(dir, file))) {
    return { url: null, file: null, scene: wanted, from: fromSlot, to: toSlot, reason: "过场片缺失" };
  }
  return {
    scene: wanted, from: fromSlot, to: toSlot, file,
    url: `/api/idle/video?file=${encodeURIComponent(file)}`,
  };
}

/** 设置页「待机」卡片要看的一行状态：现在用哪套、素材在不在。 */
export function idleSettingsView({ seed = 0, getSetting, now = new Date() }) {
  const { scene, state } = idleChoice(seed, getSetting);
  const tod = idleTimeOfDay(null, now);
  const slot = TOD_SLOT[tod] ?? "1200";
  const presence = assetRoot(PRESENCE_SUBDIR);
  return {
    ambience: String(getSetting("idle_ambience_on") ?? "1") === "1",
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
  if (!dir) return null;
  const target = join(dir, name);
  return existsSync(target) ? target : null;
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
