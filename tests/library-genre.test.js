// 曲库分档：古典 / ACG / 轻音乐 / 我的上传。
//
// ★ 这份测试守的是**用户 2026-10-14 逐张截图给出的地面真值**：
//     古典 48 + ACG 68 + 轻音乐 13 = 129，正好等于曲库里 Solo_ 98 + PlaySing_ 31 的全集。
//   夹具是**字面量快照**（可以按目录名逐条核对），不是从被测代码现算的 ——
//   期望值若由 classifyGenre 自己生成，就是拿常量跟常量比，改错了永远绿。
//   ⇒ 夹具与 core.mjs 的 KEY 表是两份独立的字面量，改坏任何一份都会红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GENRES, SONG_MODES, classifyGenre, songKey, songMode } from "../app/core.mjs";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/library-genres.json", import.meta.url), "utf8"));

test("129 首曲子逐首对得上，且四档的计数就是原版的 48 / 68 / 13", () => {
  const tally = {};
  for (const row of FIX.tracks) {
    const got = classifyGenre(row.dir, row.dir);
    assert.equal(got, row.genre, `${row.dir} 应当分到「${row.genre}」，实际是「${got}」`);
    tally[row.genre] = (tally[row.genre] ?? 0) + 1;
  }
  // ★ 数字写死在这里（不是 tally 自比）：原版截图数出来的就是这三个数。
  assert.deepEqual(tally, { 古典: 48, ACG: 68, 轻音乐: 13, 我的上传: 3 });
});

test("页签的四个档就是这四个，顺序照原版", () => {
  assert.deepEqual([...GENRES], ["古典", "ACG", "轻音乐", "我的上传"]);
});

test("「模式」列：独奏 / 弹唱 / 个人上传 —— 原版写的是弹唱，不是演唱", () => {
  // 原版截图上 20 多行都写着「弹唱」（PlaySing 那批本来就是边弹边唱）。
  // 这一条用**字面量**钉住：把 SONG_MODES.sing 改回"演唱"就该红。
  assert.equal(SONG_MODES.sing, "弹唱");
  assert.equal(SONG_MODES.solo, "独奏");
  assert.equal(SONG_MODES.upload, "个人上传");
  assert.equal(songMode("Solo_Chopin_Etude_Op10_No1"), "独奏");
  assert.equal(songMode("PlaySing_Moon_Halo_Ziyun_original"), "弹唱");
  assert.equal(songMode("midi_11565_1784483750"), "个人上传");
  assert.equal(songMode("oliviasoul_x"), "个人上传");
});

test("查表用的键：前缀与来源尾巴都要去掉", () => {
  assert.equal(songKey("Solo_Chopin_Etude_Op10_No1"), "Chopin_Etude_Op10_No1");
  assert.equal(songKey("PlaySing_Moon_Halo_Ziyun_original"), "Moon_Halo");
  assert.equal(songKey("PlaySing_Da_Capo_Ziyun_original"), "Da_Capo");
});

test("逐首的抽查：这三类是对表才知道的，关键词一定判错", () => {
  // 克罗地亚狂想曲在原版是**轻音乐**，不是古典 —— 关键词认得出 "rhapsody"，
  // 但它归错档。只有对过表才会把它放对。
  assert.equal(classifyGenre("Solo_Croatian_Rhapsody"), "轻音乐");
  // 同族的西班牙狂想曲却真是古典（李斯特）。这两首靠名字分不开 —— 表里就是不一样。
  assert.equal(classifyGenre("Solo_Rhapsodie_Espagnole_S254_P1"), "古典");
  assert.equal(classifyGenre("Solo_Rhapsodie_Espagnole_S254_P2"), "古典");
  // 10 首童谣的目录名是拼音，关键词一个都认不出来。
  for (const dir of [
    "PlaySing_Yao_Lan_Qu_Ziyun_original", "PlaySing_Liang_Zhi_Lao_Hu_Ziyun_original",
    "PlaySing_Xiao_Tu_Zi_Guai_Guai_Ziyun_original", "PlaySing_Wai_Po_Qiao_Ziyun_original",
    "PlaySing_Mo_Li_Hua_Ziyun_original", "PlaySing_Fen_Shua_Jiang_Ziyun_original",
    "PlaySing_You_Yi_Di_Jiu_Tian_Chang_Ziyun_original", "PlaySing_Song_Bie_Ziyun_original",
    "PlaySing_Sheng_Ri_Kuai_Le_Ge_Ziyun_original", "PlaySing_Zhao_Peng_You_Ziyun_original",
  ]) {
    assert.equal(classifyGenre(dir), "轻音乐", `${dir} 是童谣那一档`);
  }
});

test("我的上传 = midi_ / oliviasoul_ 那一批（用户 10-14 原话）", () => {
  assert.equal(classifyGenre("midi_11565_1784483750"), "我的上传");
  assert.equal(classifyGenre("midi_119482_1784214630"), "我的上传");
  assert.equal(classifyGenre("oliviasoul_1"), "我的上传");
});

test("表外的新曲子走关键词兜底，认不出才落在轻音乐", () => {
  // 表里没有的曲子（用户以后往曲库丢的）——关键词还认得出作曲家的就走古典
  assert.equal(classifyGenre("Solo_Chopin_Ballade_No1"), "古典");
  assert.equal(classifyGenre("Solo_Waltz_In_A_Minor"), "古典");
  // 曲名也参与判定（原版那一列有时只写曲式不写人）
  assert.equal(classifyGenre("Solo_Unknown_Thing", "Op.12 No.3"), "古典");
  assert.equal(classifyGenre("PlaySing_Moon_Halo_Live"), "ACG");
  assert.equal(classifyGenre("Solo_Genshin_Natlan_Theme"), "ACG");
  // 什么线索都没有 ⇒ 兜底到最不容易"冒犯"的那一档
  assert.equal(classifyGenre("Solo_Untitled_01"), "轻音乐");
});

test("判据只看名字：不吃网络、不吃文件、不吃元数据", () => {
  // 同一个名字在任何时候都必须给同一个答案（这条挡的是"以后有人偷偷加个异步"）。
  const dir = "Solo_Chopin_Nocturne_Op9_No2";
  const first = classifyGenre(dir);
  for (let i = 0; i < 5; i++) assert.equal(classifyGenre(dir), first);
});
