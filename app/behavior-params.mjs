// 行为参数真源读取（2026-10-16 起，阈值不再写死在 core.mjs）
//
// 为什么单开一个文件：硬校验的每一个数字（回信 240/10/8/7、主动信 200/12/3/5 …）
// 以前是**写死在 core.mjs 里的字面量**。原版程序把同一批数字维护在
// `harness/行为参数.json` 里 —— 两份就一定会各改各的，而且是静默的：改 JSON 的那侧
// 以为生效了，改代码的那侧以为没变。
//
// ⇒ 从此**只认一份**：随包下发的 `app/harness/行为参数.json`。
//   ★ 这里**不留任何"读不到就用硬编码"的回退** —— 回退就是第二份真源，
//     两边漂移正是从"为了不崩先给个默认值"开始的。读不到就抛，让它在启动时现形。
//
// 只读这四段：`reply` / `proactive` / `antifabrication` / `targets`。
// ★ 2026-10-16（T9 近况层接线）：`nearTerm` 段**现在开始消费** —— 上游已把可执行判定式
//   补齐（`行为参数.json` 的 `nearTerm.tiers` + `thresholdMode:"letters"` +
//   `allowRollback:false` + `userToggle.key="keep-current-shape"`），封锁解除。
//   档位判定本身是纯函数（见 core.mjs 的 `resolveDriftTier`），阈值只从这份 JSON 读。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PARAMS_PATH = fileURLToPath(new URL("./harness/行为参数.json", import.meta.url));

let cached = null;

const NUMERIC_FIELDS = ["maxChars", "minChars", "maxParagraphs", "maxAsciiRun"];

function assertLimits(where, seg) {
  if (!seg || typeof seg !== "object") throw new Error(`行为参数.json 缺 ${where} 段`);
  for (const k of NUMERIC_FIELDS) {
    if (!Number.isFinite(seg[k])) throw new Error(`行为参数.json 的 ${where}.${k} 不是数字（实际 ${JSON.stringify(seg[k])}）`);
  }
  if (!Array.isArray(seg.forbiddenWords) && !Array.isArray(seg.extraForbiddenWords)) {
    throw new Error(`行为参数.json 的 ${where} 段既没有 forbiddenWords 也没有 extraForbiddenWords`);
  }
}

export function behaviorParams() {
  if (cached) return cached;
  let raw;
  try {
    raw = readFileSync(PARAMS_PATH, "utf8");
  } catch (e) {
    throw new Error(
      `行为参数真源读不到：${PARAMS_PATH}（${e.message}）—— 硬校验值只认这一份，拒绝回退到硬编码（回退 = 第二份真源）`,
    );
  }
  // 上游的部分 .md/.ps1 带 BOM；这里也顺手容忍，免得哪天加 BOM 就整站起不来。
  const parsed = JSON.parse(raw.replace(/^﻿/, ""));
  assertLimits("reply", parsed.reply);
  assertLimits("proactive", parsed.proactive);
  cached = parsed;
  return parsed;
}

/** 回信那道闸的判据（含编译好的前缀正则）。 */
export function replyLimits() {
  const r = behaviorParams().reply;
  if (typeof r.forbidNamePrefixRegex !== "string") throw new Error("行为参数.json 的 reply.forbidNamePrefixRegex 不是字符串");
  return { ...r, namePrefix: new RegExp(r.forbidNamePrefixRegex) };
}

/**
 * 主动信那道闸的判据。
 * ★ `minCharsWhenMultiParagraph` 缺失时**退到 minChars**（而不是变成 0）——
 *   少一个字段不该让最短长度这道闸整个消失。
 */
export function proactiveLimits() {
  const p = behaviorParams().proactive;
  return {
    ...p,
    minCharsWhenMultiParagraph: Number.isFinite(p.minCharsWhenMultiParagraph) ? p.minCharsWhenMultiParagraph : p.minChars,
  };
}

/**
 * 近况层（drift）的判据（T9，2026-10-16）。
 *
 * ★ 这里是「读真源」，不是「定口径」—— 口径在 `行为参数.json` 的 `nearTerm`，两边同一份。
 *   本函数只做形状校验（缺字段/形状不对就抛），绝不替真源补默认值：
 *   补一个 `enabled:false` 或一个空 `tiers` 就等于「静默关掉近况层」，
 *   而这正是行为参数统一那批注释里说的「为了不崩先给个默认值 ⇒ 两边漂移」的同一类错。
 *
 * ⚠️ 三条最容易实现错的点（真源 `nearTerm.tiers` 已写死，这里只负责不误解）：
 *   ① 第 0 档是 **不注入**（`inject:false`），调用方要传 -1、不是传「第 0 档的文本」；
 *   ② 第 2 档起**累积** —— 档 2 = 第 1+2 档全部文本，档 3 = 第 1+2+3 档全部；
 *   ③ `allowRollback:false` = 档位不回退（删了信也不降档），调用方须把历史最高档**既读又写**。
 */
export function nearTermLimits() {
  const n = behaviorParams().nearTerm;
  if (!n || typeof n !== "object") throw new Error("行为参数.json 缺 nearTerm 段");
  if (!Array.isArray(n.tiers) || n.tiers.length === 0) {
    throw new Error("行为参数.json 的 nearTerm.tiers 不是非空数组");
  }
  for (const t of n.tiers) {
    if (!Number.isInteger(t?.tier) || !Number.isInteger(t?.lettersFrom)) {
      throw new Error(`行为参数.json 的 nearTerm.tiers 有形状不对的档：${JSON.stringify(t)}`);
    }
    if (t.lettersTo !== null && !Number.isInteger(t.lettersTo)) {
      throw new Error(`行为参数.json 的 nearTerm.tiers 的 lettersTo 必须是整数或 null：${JSON.stringify(t)}`);
    }
    if (typeof t.inject !== "boolean") {
      throw new Error(`行为参数.json 的 nearTerm.tiers 的 inject 必须是布尔：${JSON.stringify(t)}`);
    }
  }
  if (typeof n.variable !== "string" || !n.variable) throw new Error("行为参数.json 的 nearTerm.variable 缺失");
  if (typeof n.carrier !== "string" || !n.carrier) throw new Error("行为参数.json 的 nearTerm.carrier 缺失");
  const t = n.userToggle;
  if (!t || typeof t.key !== "string" || !t.key) throw new Error("行为参数.json 的 nearTerm.userToggle.key 缺失");
  return {
    enabled: n.enabled === true,
    thresholdMode: n.thresholdMode ?? "letters",
    allowRollback: n.allowRollback === true,
    tiers: [...n.tiers].sort((a, b) => a.tier - b.tier),
    variable: n.variable,
    carrier: n.carrier,
    userToggle: {
      key: t.key,
      default: t.default === true,
      label: typeof t.label === "string" ? t.label : "",
    },
    tierOverride: n.tierOverride ?? null,
  };
}
