// 一次性：把当前曲库扫出来的 129 首（+3 个 midi 样本）连同分档导成测试夹具。
// 夹具是**字面量快照**，之后 core.mjs 的表若被改动，单测就会红 —— 这正是它的用处：
// 期望值不能由被测代码在测试时算出来（那是同义反复）。
import { readdirSync, writeFileSync } from "node:fs";
import { classifyGenre, songMode, LIBRARY_DIR_PATTERN } from "../app/core.mjs";
const DIR = process.argv[2] || "E:/linlimusic";
const names = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const solo = names.filter((n) => /^(?:Solo|PlaySing)_/iu.test(n)).sort();
const uploads = names.filter((n) => /^midi_/iu.test(n)).sort().slice(0, 3);
const tracks = [...solo, ...uploads].map((dir) => ({ dir, genre: classifyGenre(dir), mode: songMode(dir) }));
writeFileSync(new URL("../tests/fixtures/library-genres.json", import.meta.url),
  JSON.stringify({ note: "E://linlimusic 里 Solo_/PlaySing_ 全集 + 3 个 midi 样本；genre 与原版四档逐首对过", tracks }, null, 1) + "\n");
const t = {};
for (const r of tracks) t[r.genre] = (t[r.genre] || 0) + 1;
console.log(tracks.length, t);
