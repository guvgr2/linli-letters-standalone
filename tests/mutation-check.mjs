// 变异测试：护栏不能只"绿着"，得证明它**绿得有理由**。
//
// 做法：基线全绿 → 逐个植入一处"看起来无害"的错误 → 每个都必须变红 → 复原复跑。
// ★ 红数不是判据，要看**失败原因**是不是这条变异该挑出来的那条。
// ★ 「没匹配上原文」≠「仍然绿」：前者是这次**根本没测到**，必须分开报（memory 里的教训）。
// ★ 每条变异带 `file`（改哪个文件）与 `tests`（跑哪套测试）：护栏不只长在 core.mjs 上。
//
// 跑法：node tests/mutation-check.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORE = join(ROOT, "app", "core.mjs");
const NODE = process.execPath;

const CORE_TESTS = ["tests/core.test.js"];
const LEGAL_TESTS = ["tests/legal.test.js"];
// ★ 导入族的护栏是**两层**：import-preview.test.js 测纯函数「算得对」，
//   import-route.test.js 起真服务测「接对了」（路由挂没挂、令牌闸、事务与备份）。
//   变异植入 import-preview.mjs 后两层都可能抓到 —— 只跑纯函数那层，
//   像「counts 与桶脱钩」这种只在 HTTP 响应里露头的错就会漏。
const IMPORT_TESTS = ["tests/import-preview.test.js", "tests/import-route.test.js"];
// ★ 待机与字体那一组路由的护栏：起真服务测"接对了"（路由挂没挂、令牌闸、Range、落盘）。
//   白名单/种子/字形表这些纯规则**还没有独立的纯函数测试文件** —— 它们目前只由这一层守着，
//   所以下面的变异必须打在**能在 HTTP 响应里露头**的位置，不要打内部细节。
const IDLE_FONT_TESTS = ["tests/idle-font-route.test.js"];
const COLUMN_TESTS = ["tests/import-columns.test.js"];
const TIER_TESTS = ["tests/tier-count.test.js"];
const VARS_TESTS = ["tests/harness-vars.test.js"];

// ---------------------------------------------------------------- 变异清单
//
// name 里不能出现 Windows 文件名非法字符（* / \ : ? " < > |）—— 见 memory。
// from 必须**原样**出现在 core.mjs 里，否则这一条等于没测，脚本会单独标出来。

const MUTATIONS = [
  // ---- 借鉴竞品那 9 条 ----
  {
    name: "她自己的作息(1)-闸门只留用户那一侧",
    from: "if (act && Object.prototype.hasOwnProperty.call(HER_BUSY, act)) {",
    to: "if (act && Object.prototype.hasOwnProperty.call({}, act)) {",
  },
  {
    // ★ 等价变异：`>=2` 改成 `>=1` 是**行为中性**的 —— unansweredWaitHours(1,·) 返回 0，
    //   `since < 0` 永远不成立 ⇒ 两版行为完全一致。它不是缺口，别当成"护栏没测到"报。
    //   （标 equivalent 是为了把它和真正的「仍绿」分开，而不是为了让报告好看。）
    name: "未回复(2)-等价变异(门槛1封,行为中性)",
    from: "if (unread >= 2) {",
    to: "if (unread >= 1) {",
    equivalent: true,
  },
  {
    name: "未回复(2)-门槛抬高到3封(2封未读不再等待)",
    from: "if (unread >= 2) {",
    to: "if (unread >= 3) {",
  },
  {
    name: "未回复(2)-只1封也算冷",
    from: "if (n <= 1) return 0;",
    to: "if (n <= 0) return 0;",
  },
  {
    name: "未回复(2)-压力不衰减(永远顶到上限)",
    from: "return Math.min(base * Math.pow(UNANSWERED_BASE, n - 2), UNANSWERED_CAP_HOURS);",
    to: "return Math.min(base * Math.pow(UNANSWERED_BASE, n - 2) * 0 + UNANSWERED_CAP_HOURS, UNANSWERED_CAP_HOURS);",
  },
  {
    name: "关系中位间隔(3)-有样本也不用,写死退回设置值",
    from: "  if (u === null) return s.minGapHours;",
    to: "  return s.minGapHours;",
  },
  {
    name: "关系中位间隔(3)-中位数不剔异常样本",
    from: ".filter((g) => Number.isFinite(g) && g >= 0.5 && g <= 168);",
    to: ".filter((g) => Number.isFinite(g) && g >= 0);",
  },
  {
    name: "离线不补发(4)-一开程序就发",
    from: "if (quiet >= 24) {",
    to: "if (false) {",
  },
  {
    name: "离线不补发(4)-宽限不抖动",
    from: "return 60 + (v % 241);",
    to: "return 60;",
  },
  {
    name: "不发原因有名字(5)-代号串到别的原因上",
    from: 'HER_BUSY: "her_busy",',
    to: 'HER_BUSY: "out_of_hours",',
  },
  {
    name: "由头质量下限(6)-下限归零,形同虚设",
    from: "export const SHALLOW_UNTIL = 8;",
    to: "export const SHALLOW_UNTIL = 0;",
  },
  {
    name: "由头质量下限(6)-根本不判",
    from: "if (shallow && (TRIGGER_WEIGHT[trigger?.kind] ?? 0) < 2) {",
    to: "if (false && (TRIGGER_WEIGHT[trigger?.kind] ?? 0) < 2) {",
  },
  {
    // ★ from 必须**原样**出现在源码里，否则这条等于没测（脚本会标「没打中原文」）。
    //   TRIGGER_WEIGHT 后来被拆成多行、还加了 open_loop/reunion/music_anchor，
    //   这里跟着改到现在的真实行（只动 time_of_day 那一个数字）。
    name: "由头质量下限(6)-权重表把空洞由头抬到有事那一档",
    from: "  music_anchor: 1, time_of_day: 1,",
    to: "  music_anchor: 1, time_of_day: 3,",
  },
  {
    name: "生成前先扣(7)-等于没扣(due 就是 now)",
    from: "  return now + base * (0.9 + (Math.abs(Math.floor(Number(jitterSeed) || 0)) % 21) / 100);",
    to: "  return now;",
  },
  {
    name: "生成前先扣(7)-不抖动(每次同一个值)",
    from: "(Math.abs(Math.floor(Number(jitterSeed) || 0)) % 21) / 100",
    to: "0.05",
  },
  {
    name: "回信降级(8)-把点名那句之后的整段都删了",
    from: "for (const s of list) out = out.slice(0, s.start) + out.slice(s.end);",
    to: "for (const s of list) out = out.slice(0, s.start);",
  },
  {
    name: "回信降级(8)-删过却不标记",
    from: "? { ...again, degraded: true }",
    to: "? { ...again, degraded: false }",
  },
  {
    name: "曲名上限(9)-不做截断",
    from: "return name.length > SONG_NAME_MAX ? name.slice(0, SONG_NAME_MAX - 1).trimEnd() + \"…\" : name;",
    to: "return name;",
  },
  {
    name: "曲名上限(9)-硬切不带省略号",
    from: "name.slice(0, SONG_NAME_MAX - 1).trimEnd() + \"…\"",
    to: "name.slice(0, SONG_NAME_MAX - 1)",
  },

  // ---- 原有几道闸的回归（确认新写的一批测试没把旧护栏架空） ----
  {
    name: "配额->写成>(上限1时会发第2封)",
    from: "if ((ctx.proactive24h ?? 0) >= s.maxPerDay) {",
    to: "if ((ctx.proactive24h ?? 0) > s.maxPerDay) {",
  },
  {
    name: "窗口终点-改成开区间",
    from: "if (!Number.isFinite(minutes) || minutes < start || minutes > end) {",
    to: "if (!Number.isFinite(minutes) || minutes < start || minutes >= end) {",
  },
  {
    name: "时段填错-静默回退默认值",
    from: "if (s.invalid.length > 0) {",
    to: "if (false) {",
  },
  {
    name: "主动信专属禁词-漏掉共用那批",
    from: "const FORBIDDEN_PROACTIVE = [\n  ...FORBIDDEN_REPLY,",
    to: "const FORBIDDEN_PROACTIVE = [",
  },
  // ---- T8（2026-10-16）：硬校验值只认 行为参数.json ----
  {
    // 真源侧 P2 拍板的双条件被吃回单值 ⇒ 一句 12 字的合法主动信又被拒掉（C1 记的就是这个）。
    name: "T8(1)-主动信最短长度退回单值(P2双条件被吃)",
    from: "const floor = paragraphs.length >= 2 ? (minCharsWhenMultiParagraph ?? minChars) : minChars;",
    to: "const floor = minChars;",
  },
  {
    // 主动信改读回信的上限 ⇒ 两边一样严，「主动信比回信更严」那条就守不住了。
    name: "T8(2)-主动信上限改读回信的(两边一样严)",
    from: "maxChars: P.maxChars,",
    to: "maxChars: replyLimits().maxChars,",
  },
  {
    // 禁词表抄回代码里 ⇒ 从此两份，真源改词表我侧不动。
    name: "T8(3)-禁词表抄回代码(不再读真源)",
    from: "const FORBIDDEN_REPLY = replyLimits().forbiddenWords;",
    to: "const FORBIDDEN_REPLY = [\"由头\"];",
  },
  // ---- T9（2026-10-16）：近况层档位只认真源 nearTerm ----
  {
    // ★ 真源 P1 拍板「档位不回退」被吃掉 ⇒ 删几封信她就「忘记自己是谁」，退回生疏。
    //   锚点是「与历史最高档取较高者」那一行（在「第 0 档不注入」判定之前）。
    name: "T9(1)-不回退被吃掉(删信件就降档)",
    from: "    if (Number.isFinite(max)) tier = Math.max(tier, Math.floor(max));",
    to: "    if (Number.isFinite(max)) tier = tier;",
  },
  {
    // ★ 用户开关（keep-current-shape）被忽略 ⇒ 勾了「保持她现在的样子」照样注入近况层。
    name: "T9(2)-用户开关被忽略(勾了也照注入)",
    from: "  if (on) return -1;",
    to: "  if (on) return 0;",
  },
  {
    // ★ 第 0 档改成「注入第 0 档文本」而不是 -1 ⇒ 0–3 封信就开始叠近况，两端不同档。
    name: "T9(3)-第0档改成注入(该传-1却给了文本)",
    from: "  if (!hit || hit.inject === false) return -1;",
    to: "  if (!hit || hit.inject === false) return tier;",
  },
  {
    // ★ 累积被吃掉换成「只给本档」⇒ 档 2 不含档 1，「第 2 档起累积」失守。
    name: "T9(4)-近况文本不再累积(只给本档)",
    from: "      .filter((p) => p.tier >= 1 && p.tier <= n)",
    to: "      .filter((p) => p.tier === n)",
  },
  {
    // ★ 总闸被短路 ⇒ 真源 nearTerm.enabled=false 时仍注入。
    name: "T9(5)-总闸短路(enabled=false 仍注入)",
    from: "  if (!N.enabled) return -1;",
    to: "  if (!N.enabled) return 0;",
  },
  {
    // ★ 同上：`^` 那一版是 2026-10-14 加「我的上传」档之前的写法，现在锚点已经扩了。
    name: "曲库目录-不锚在开头(MySolo 会混进来)",
    from: "/^(?:solo|playsing|midi|oliviasoul)/iu",
    to: "/(?:solo|playsing|midi|oliviasoul)/iu",
  },
  {
    name: "原游戏时段-傍晚推到17:30",
    from: 'return m >= 360 && m < 960 ? "TOD12" : m >= 960 && m < 1200 ? "TOD1730" : "TOD20";',
    to: 'return m >= 360 && m < 1050 ? "TOD12" : m >= 1050 && m < 1200 ? "TOD1730" : "TOD20";',
  },

  // ---- 协议那一链（用户 2026-10-13：「设置页的协议还是别删了」） ----
  {
    name: "协议-改了源头忘了同步(legal.js 与 协议.txt 差一个字)",
    file: "app/public/legal.js",
    tests: LEGAL_TESTS,
    from: "    信件、设置、账本、曲库索引，全部存在本机",
    to: "    内容、设置、账本、曲库索引，全部存在本机",
  },
  {
    name: "协议-设置页入口被删掉(回到上一轮那种「只留在安装包里」)",
    file: "app/public/index.html",
    tests: LEGAL_TESTS,
    from: '<button class="lnk" id="lnkTerms">服务协议</button>',
    to: '<button class="lnk">服务协议</button>',
  },
  {
    name: "协议-弹层藏不住(一进页面就顶着整屏)",
    file: "app/public/styles.css",
    tests: LEGAL_TESTS,
    from: ".modal[hidden] { display: none; }",
    to: "/* .modal[hidden] { display: none; } */",
  },
  {
    name: "协议-安装时读的不是同一份",
    file: "install.iss",
    tests: LEGAL_TESTS,
    from: "LicenseFile=协议.txt",
    to: "LicenseFile=LICENSE.txt",
  },
  {
    name: "协议-正文被手抄进 index.html(从此有两份会各改各的)",
    file: "app/public/index.html",
    tests: LEGAL_TESTS,
    from: "      <div class=\"legalbar\">",
    to: "      <p>一、你的东西都在你自己机器上</p>\n      <div class=\"legalbar\">",
  },
  {
    name: "协议-小链接被套上液态玻璃高光(变成视觉焦点)",
    file: "app/public/app.js",
    tests: LEGAL_TESTS,
    from: 'const SELECTOR = "button:not(.lnk), .rb";',
    to: 'const SELECTOR = "button, .rb";',
  },
  {
    // ★ 第一版真漏过这个：截图里"那是读的你**自己那个厂商账户**里剩多少"，
    //   星号原样显示 —— 安装向导按纯文本渲染、弹层用 textContent，都不是 markdown。
    //   （这条会同时让「逐字一致」变红：改的是派生文件，源头没跟着动。两条都对。）
    name: "协议-正文里混进 markdown 星号(会原样露出来)",
    file: "app/public/legal.js",
    tests: LEGAL_TESTS,
    from: "那是读的你「你自己那个厂商账户」里剩多少",
    to: "那是读的你**自己那个厂商账户**里剩多少",
  },

  // ---- UserData 导入预览（2026-10-16，照 DSH《一键导入机制说明》§5 第一步落地）----
  {
    // ★ 最要紧的一条：两个判据调换先后。外表看只是「换个顺序」，实际会把
    //   给用户看的数字从「冲突 1」漂成「跳过 1」—— 同一份文件导两次结论就不一样了。
    name: "导入预览-判据顺序翻转(文件内重复不再优先)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: `    if (seen.has(id)) { conflicts.push(id); continue; }
    seen.add(id);
    if (known.has(id)) { skipped.push(id); continue; }`,
    to: `    if (known.has(id)) { skipped.push(id); continue; }
    seen.add(id);
    if (seen.has(id)) { conflicts.push(id); continue; }`,
  },
  {
    name: "导入预览-忘了登记文件内已见(重复信被当成新信)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: "    seen.add(id);",
    to: "    /* 忘了登记：下一封同名信会被当成全新信 */",
  },
  {
    name: "导入预览-counts 与桶脱钩(给UI看的数字自己算一套)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: "counts: { added: added.length, skipped: skipped.length, conflicts: conflicts.length },",
    to: "counts: { added: added.length, skipped: skipped.length, conflicts: 0 },",
  },
  {
    // ★ 指纹被截断后仍然「稳定」，所以只测相等是抓不到的 —— 必须用 md5 标准值钉死。
    name: "内容指纹-只取前10字符(不再是可信赖的身份键)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: 'update(String(text ?? ""), "utf8")',
    to: 'update(String(text ?? "").slice(0, 10), "utf8")',
  },

  // ---- 契约已到后的导入映射（2026-10-16 20:39 DSH 回执 U1/U2/U3 + 视频裁决）----
  // ⚠️ 2026-10-17 07:2x 重定锚点：并行会话把取值口径从「裸 `item.content`」换成
  //    `incomingOf()/replyOf()`（`.soul` 真字段名是 `incoming`/`reply`，`content` 只是兜底），
  //    老锚点全部失配 ⇒ 这 4 条会被脚本标「没打中原文」（= 根本没测到）。
  //    ★ 教训同型：变异锚点是对源码的**逐字引用**，源码一重构它们就静默失效；
  //      所以「没打中」必须单独报、且必须当轮修，不能和「仍绿」混在一起看。
  {
    // ★ U1 判据写反：整批信的来源标反 ⇒ 「她主动写来的」被当成用户来信、重复触发回信。
    name: "U1-来源判据翻转(空串判成用户来信)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: 'return incomingOf(item) === "" ? "proactive" : null;',
    to: 'return incomingOf(item) !== "" ? "proactive" : null;',
  },
  {
    // 手一抖加了 trim：纯空格的来信会被判成「她先写」。正文是真的（只是空白），来源却变了。
    name: "U1-判空前先trim(纯空格来信被当成她先写)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: 'return incomingOf(item) === "" ? "proactive" : null;',
    to: 'return incomingOf(item).trim() === "" ? "proactive" : null;',
  },
  {
    // ★ U2 最危险的一条：没回过信的历史信落 1 ⇒ 我侧队列只挑 status=1 ⇒ 立刻替她补一封
    //   = 伪造新信。这是 DSH 特意点名「导入永不产生 1」的地方。
    name: "U2-无回信的历史信落1(被队列捞起来伪造新信)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: 'return replyOf(item) === "" ? IMPORT_STATUSES.UNREPLIED : IMPORT_STATUSES.REPLIED;',
    to: 'return replyOf(item) === "" ? STATUS.PENDING : IMPORT_STATUSES.REPLIED;',
  },
  {
    // md5("") 是个恒等值 —— 拿它当去重键会把每一封「她先写」的信撞成同一封。
    name: "U3-空正文也算md5(所有她先写的信撞成同一封)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: '  if (incoming === "" && reply === "") return null;',
    to: "  if (false) return null;",
  },
  {
    // ★ 2026-10-17 新增：`.soul` 的真实字段名是 `incoming`，**不是** `content`。
    //   只按 `content` 取 ⇒ 真 `.soul` 每封都被读成空串：整批判成 proactive、状态全落 5。
    //   这条守的就是「取值口径」，是上面 4 条的**上游** —— 上游错了下面全对也没用。
    name: "U0-取值口径退回只认content(真.soul整批读成空串)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: "const v = item?.incoming ?? item?.content;",
    to: "const v = item?.content;",
  },
  {
    // 拿不到时间就填 0：0 是个合法时间戳（1970），而「未标记」与「1970 年归档」
    // 是两回事 —— 填 0 之后按 archived_at IS NOT NULL 过滤就会把它们全收进来。
    name: "U3-拿不到归档时间填0(未标记被当成已归档)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: `  if (created !== undefined && created !== null) return Number(created);
  return null;`,
    to: `  if (created !== undefined && created !== null) return Number(created);
  return 0;`,
  },
  {
    // ★ 路由无关是硬要求：server.js:2774 那条 .soul 导入路径也会写 reply_video，
    //   只数"用户手传"就会漏掉一批，报告里的 N 比实际少。
    name: "视频-只数手动上传(漏掉.soul导入带进来的视频)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: "if (row?.reply_video !== null && row?.reply_video !== undefined) n += 1;",
    to: "if (row?.reply_video !== null && row?.reply_video !== undefined && row?.manual === true) n += 1;",
  },
  {
    // ★ 栏目那 15 条进 prompt 是本轮刚补上的缺口。最可能的退化方式是"嫌它长，留个标题不填内容"
    //   —— 外表看测试全绿（标题还在），模型其实一条约束都没拿到。
    name: "栏目-留标题不填内容(15条约束悄悄消失)",
    file: "app/harness-render.mjs",
    tests: ["tests/harness-render.test.js"],
    from: `"# 人设", persona, "", "# 栏目", fields]`,
    to: `"# 人设", persona, "", "# 栏目", ""]`,
  },
  {
    // 规范丢了照样发信 —— 这是整条链上最危险的一类错（T4 的起因），不能把校验摘掉。
    name: "栏目-去掉空规范校验(没规矩也照样发信)",
    file: "app/harness-render.mjs",
    tests: ["tests/harness-render.test.js"],
    from: "if (typeof text !== \"string\" || !text.trim()) {",
    to: "if (false) {",
  },
  {
    // 0 是最容易"顺手省略"的数 —— 但 DSH 明确要求「不要写 0 装作没有」，
    //   纯文本用户看到"未搬运 0 个"才知道系统数过了，而不是压根没看。
    name: "视频-0个时省略报告(静默丢失)",
    file: "app/import-preview.mjs",
    tests: IMPORT_TESTS,
    from: 'if (!Number.isInteger(n) || n < 0) return "本次导入未搬运回信视频：未统计";',
    to: 'if (!Number.isInteger(n) || n <= 0) return "本次导入未搬运回信视频：未统计";',
  },

  // ---- 导入两列的迁移（2026-10-16 U3，用户已批「可以，加，推」）----
  {
    // ★ 这一条要是漏了，老库永远缺那两列，而规划层说"不用改" ⇒ 导入静默退化成半成品。
    name: "导入列-规划永远说不用改(老库永远缺两列)",
    file: "app/db-import-columns.mjs",
    tests: COLUMN_TESTS,
    from: "const missing = IMPORT_COLUMNS.filter((c) => !have.has(c.name));",
    to: "const missing = [];",
  },
  {
    // ★ 备份必须在改之前。挪到后面就是"改坏了才备份" —— 那份副本已经是改过的了，等于没备份。
    name: "导入列-备份挪到ALTER之后(改坏了才备份)",
    file: "app/db-import-columns.mjs",
    tests: COLUMN_TESTS,
    from: `  if (typeof backup === "function") backup();
  for (const sql of plan.statements) conn.exec(sql);`,
    to: `  for (const sql of plan.statements) conn.exec(sql);
  if (typeof backup === "function") backup();`,
  },
  {
    // 幂等失效的表现不是报错，是**每次启动都多一份备份文件** —— 用户磁盘被慢慢塞满，且没人察觉。
    name: "导入列-每次启动都备份(幂等失效,备份刷屏)",
    file: "app/db-import-columns.mjs",
    tests: COLUMN_TESTS,
    from: "if (plan.missing.length === 0) return { applied: [], backedUp: false, missing: [] };",
    to: "if (false) return { applied: [], backedUp: false, missing: [] };",
  },
  {
    // ALTER 被吃掉（权限/只读/语句不合法）时如果当成功，后面导入会拿着"假装有列"的库继续跑，
    // 去重键全落空 ⇒ 同一封信导 N 遍。必须喊。
    name: "导入列-ALTER没生效也当成功(静默带着缺列跑)",
    file: "app/db-import-columns.mjs",
    tests: COLUMN_TESTS,
    from: "if (notApplied.length > 0) {",
    to: "if (false) {",
  },

  // ---- 近况层档位计数口径（真源 tierDataSource：只算「用户来信且已回信」）----
  {
    // SQLite 三值逻辑：`origin <> 'proactive'` 对 NULL 行得 NULL ⇒ 用户来信全被漏掉，档位永远 0。
    name: "档位计数-丢掉 origin IS NULL(用户来信全漏,档位恒0)",
    tests: TIER_TESTS,
    from: `"SELECT COUNT(*) value FROM letters WHERE (origin IS NULL OR origin <> 'proactive') AND status = 4"`,
    to: `"SELECT COUNT(*) value FROM letters WHERE origin <> 'proactive' AND status = 4"`,
  },
  {
    // 少了 status 过滤 ⇒ 在途信(1/3)与失败信(5)也算进「往来多久」，档位偏高。
    name: "档位计数-不判 status=4(在途失败信推高档位)",
    tests: TIER_TESTS,
    from: `"SELECT COUNT(*) value FROM letters WHERE (origin IS NULL OR origin <> 'proactive') AND status = 4"`,
    to: `"SELECT COUNT(*) value FROM letters WHERE (origin IS NULL OR origin <> 'proactive')"`,
  },
  {
    // 纯函数与 SQL 是同一规则的两处表达；把判定取反 ⇒ 一致性测试必须红。
    name: "档位计数-纯函数判定取反(与SQL漂移)",
    tests: TIER_TESTS,
    from: "  return !proactive && Number(row.status) === TIER_COUNTED_STATUS;",
    to: "  return !proactive && Number(row.status) !== TIER_COUNTED_STATUS;",
  },
  {
    // 回归护栏：有人又把取「往来封数」的地方改回裸全表 COUNT（这正是修复前原状）。
    // ★ 2026-10-18 改锚点：原来锚的是 `currentDriftTier` 里的 `const letters = …`，
    //   但那个函数在本项目**根本不存在**（是从姊妹项目抄来的名字）⇒ from 出现 0 次、
    //   这条变异一直"没打中"，护栏等于空转。现在改锚生产链路上真正的取数点
    //   `evaluateProactive()` 的 exchangedCount（喂给 core 判档位的就是它）。
    name: "档位计数-取数点改回裸全表(护栏空转)",
    file: "app/server.mjs",
    tests: TIER_TESTS,
    from: "    exchangedCount: count(TIER_COUNT_SQL),",
    to: `    exchangedCount: count("SELECT COUNT(*) value FROM letters"),`,
  },

  // ---- 🟡-4 那组断言的"牙齿"检查（2026-10-17，DSH [#11] §2）----
  //
  // ★ 为什么需要这组：第一版把 00-栏目.md 正文塞进 **rules** 参数再断言"输出包含它"，
  //   而生产链路（server.mjs:528-529）走的是 **fields** 参数 ⇒ 把 fields 段删掉它照样绿。
  //   这是"看着绿、其实没测"的典型，只有拿变异打一遍才看得见。
  {
    name: "栏目护栏-删掉fields段(00-栏目.md整段消失)",
    file: "app/harness-render.mjs",
    tests: VARS_TESTS,
    from: `return [REPLY_LEAD, "", "# 写法", rules, "", "# 人设", persona, "", "# 栏目", fields].join("\\n");`,
    to: `return [REPLY_LEAD, "", "# 写法", rules, "", "# 人设", persona].join("\\n");`,
  },
  {
    name: "栏目护栏-删掉persona段(人设消失)",
    file: "app/harness-render.mjs",
    tests: VARS_TESTS,
    from: `return [REPLY_LEAD, "", "# 写法", rules, "", "# 人设", persona, "", "# 栏目", fields].join("\\n");`,
    to: `return [REPLY_LEAD, "", "# 写法", rules, "", "# 栏目", fields].join("\\n");`,
  },
  {
    name: "栏目护栏-删掉rules段(写法消失)",
    file: "app/harness-render.mjs",
    tests: VARS_TESTS,
    from: `return [REPLY_LEAD, "", "# 写法", rules, "", "# 人设", persona, "", "# 栏目", fields].join("\\n");`,
    to: `return [REPLY_LEAD, "", "# 人设", persona, "", "# 栏目", fields].join("\\n");`,
  },

  // ---- 待机素材与信件字体（2026-10-18 从姊妹侧搬回来的那组路由） ----
  //   ★ 这几条打的是**行为**，不是"文件里有没有这行字"：
  //     白名单松一格、开关不落库、超限当作正常请求放过去 —— 三种都是"接口看着还在，
  //     但用户的按钮不灵了"的典型，只有真起一次服务发真 HTTP 才抓得住。
  {
    name: "待机-环境音关了还把地址发出去(前端漏判就出声)",
    file: "app/assets.mjs",
    tests: IDLE_FONT_TESTS,
    from: "ambience: ambienceOn && ambienceFile",
    to: "ambience: ambienceFile",
  },
  {
    // 只改**服务端真正的入口**（idleFileName 里的白名单判定）。别去动 assets.mjs 顶部的
    // PRESENCE_NAME_RE 声明：同一个正则被删两处引用，第二处就"没打中原文"了。
    name: "待机-片名白名单松成任意 .mp4(目录穿越的口子)",
    file: "app/assets.mjs",
    tests: IDLE_FONT_TESTS,
    from: "return pattern.test(name) ? name : null;",
    to: "return /\\.mp4$/u.test(name) ? name : null;",
  },
  {
    name: "字体-开关只收布尔退化成真值判断(\"yes\" 被当成开)",
    file: "app/server.mjs",
    tests: IDLE_FONT_TESTS,
    from: "if (body.ambience !== undefined && typeof body.ambience !== \"boolean\") {",
    to: "if (false) {",
  },
  {
    name: "字体-任意文件都当真字体收下(不验文件头)",
    file: "app/assets.mjs",
    tests: IDLE_FONT_TESTS,
    from: "export function looksLikeFont(buf) {",
    to: "export function looksLikeFont(buf) {\n  if (buf) return true;",
  },
  {
    // ★ 打 `idleChoice` 的**定义**而不是调用点：这句话在文件里有三处调用，
    //   只改一处另两处照旧 ⇒ 既是"没打中"也是"打了却测不出来"，归因会糊掉。
    //   从定义处让种子失效，三条路径一起坏，才是这条变异真正想表示的事。
    name: "待机-场景/状态跟着种子失效(每 30 秒轮询换一次片)",
    file: "app/assets.mjs",
    tests: IDLE_FONT_TESTS,
    from: "export function idleChoice(seed, getSetting) {",
    to: "export function idleChoice(seed, getSetting) {\n  seed = Math.random() * 1e9 | 0;",
  },
];

// ---------------------------------------------------------------- 执行

function runTests(files) {
  const r = spawnSync(NODE, ["--test", "--test-force-exit", "--test-concurrency=3",
    ...files.map((f) => join(ROOT, f))], { encoding: "utf8", windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // ★ 2026-10-17 修（审核）：原来只认 TAP 格式的 `# pass N` / `# fail N`，
  //   但 Node 22 的 `node --test` 默认输出的是 spec reporter 格式：
  //       ℹ tests 49 / ℹ pass 49 / ℹ fail 0
  //   ⇒ 正则永远匹配不到 ⇒ pass/fail **恒为 -1** ⇒ 两个后果：
  //     ① 结尾「复原后与基线不一致」的核对因 `after.fail(-1) !== 0` 恒真，
  //        **每次都打印「文件可能被写坏」的假警报**（真出事时会被当成噪声忽略）；
  //     ② 那道「复原后基线核对」的保险**从未真正生效**。
  //   现在同时认两种前缀（# 或 ℹ），并允许中间的空白。
  const failed = /^\s*[#ℹ]\s*fail\s+(\d+)/m.exec(out);
  const passed = /^\s*[#ℹ]\s*pass\s+(\d+)/m.exec(out);
  const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return {
    ok: r.status === 0,
    fail: failed ? Number(failed[1]) : -1,
    pass: passed ? Number(passed[1]) : -1,
    names,
    out,
    // ★ 解析不出来要能被发现：不能让 -1 悄悄溜进判据（上面的恒真就是这么来的）
    parsed: !!(failed && passed),
  };
}

const paths = new Set(MUTATIONS.map((m) => m.file ?? "app/core.mjs"));
const originals = new Map([...paths].map((p) => [p, readFileSync(join(ROOT, p), "utf8")]));

// ---------------------------------------------------------------- 自检：分子与分母
//
// ★ 2026-10-17 借 DSH `[#10]` §3 的自查法：**凡宣称「N 项都验过」，都要有一条
//   「N 的分子与分母能对上」的机器检查**。他是靠「46 份配置 vs 44 份日志」对不上
//   才发现那 2 份没有证据 —— 只数「日志 44 份，看着挺多」的话那个洞会一直漏下去。
//
//   本脚本同型的两条：
//     ① **重名** —— 两条变异取了同一个名字，汇总里会被看成一个 ⇒ 分子悄悄少一个，
//        而且看不出来 ⇒ 硬失败（这属于「证据自相矛盾」，不是「覆盖不够」）；
//     ② **覆盖缺口** —— 某个测试文件**零**变异打在它守护的源码上 ⇒ 它「绿着」
//        并不代表「绿得有理由」，而「绿得有理由」正是本脚本存在的理由 ⇒ 明确列出来。
//        （只报告不判红：我从未宣称「每个测试文件都被变异覆盖」，现在把真实分母摆出来。）
{
  const counted = new Map();
  for (const m of MUTATIONS) counted.set(m.name, (counted.get(m.name) ?? 0) + 1);
  const dups = [...counted].filter(([, c]) => c > 1);
  if (dups.length) {
    console.log(`★ 变异条目重名 ${dups.length} 组（汇总里会被看成一个 ⇒ 分子分母对不上）：`);
    for (const [n, c] of dups) console.log(`  · x${c} ${n}`);
    process.exit(1);
  }

  const allTests = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.js")).sort().map((f) => `tests/${f}`);
  const covered = new Set(MUTATIONS.flatMap((m) => m.tests ?? CORE_TESTS));
  const uncovered = allTests.filter((t) => !covered.has(t));
  console.log(`变异 ${MUTATIONS.length} 条，打在 ${paths.size} 个源文件上；覆盖 ${covered.size}/${allTests.length} 个测试文件`);
  if (uncovered.length) {
    console.log(`★ 以下 ${uncovered.length} 个测试文件**零变异覆盖**（绿着，但没证明「绿得有理由」）：`);
    for (const t of uncovered) console.log(`  · ${t}`);
    console.log("  （这是缺口登记，不是失败；补一条变异就从这张表上划掉一个。）\n");
  }
}

console.log("— 基线 —");
// ★ 2026-10-17 修（审核）：基线原本只跑 core + legal 两个文件，而仓库有 14 个
//   `tests/*.test.js` ⇒ 核对覆盖面只有 2/14。现在基线跑**全部**测试文件：
//   变异是针对单个文件的，但「复原后有没有把仓库搞坏」这个问题必须问全部测试。
//   （各条变异仍只跑自己那条 `tests` 指定的文件，保证"谁被抓到"判据不变。）
const BASE_TESTS = readdirSync(join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => `tests/${f}`);
if (BASE_TESTS.length === 0) {
  console.log("★ tests/ 下没有 .test.js ⇒ 基线无从谈起。");
  process.exit(1);
}
const base = runTests(BASE_TESTS);
if (!base.parsed) {
  console.log("★ 解析不出 pass/fail 数字 ⇒ 基线核对不可信（多半是 node --test 的输出格式又变了）。");
  console.log("  原始输出尾部：\n" + base.out.split("\n").slice(-12).join("\n"));
  process.exit(1);
}
if (!base.ok) {
  console.log(`基线就不绿（fail=${base.fail}）⇒ 变异结果不可信，先修基线。`);
  console.log(base.names.map((n) => `  · ${n}`).join("\n"));
  process.exit(1);
}
console.log(`基线 ${base.pass} pass / ${base.fail} fail（覆盖 ${BASE_TESTS.length} 个测试文件）\n`);

const killed = [];
const alive = [];
const missed = [];
const equivalent = [];

for (const m of MUTATIONS) {
  const rel = m.file ?? "app/core.mjs";
  const original = originals.get(rel);
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    missed.push({ ...m, hits });
    continue;
  }
  const tests = m.tests ?? CORE_TESTS;
  writeFileSync(join(ROOT, rel), original.replace(m.from, m.to), "utf8");
  const r = runTests(tests);
  writeFileSync(join(ROOT, rel), original, "utf8");

  if (r.ok) (m.equivalent ? equivalent : alive).push(m);
  else killed.push({ ...m, fail: r.fail, names: r.names });

  const mark = !r.ok
    ? `变红 ✓ (${r.fail} 条)`
    : m.equivalent ? "等价 ○" : "仍绿 ✗";
  console.log(`${mark.padEnd(16)} ${m.name}`);
  if (!r.ok) for (const n of r.names.slice(0, 3)) console.log(`                  ↳ ${n}`);
}

console.log("\n— 复原后复跑 —");
// ★ 2026-10-17 修（审核）：复原后的核对同样要跑**全部**测试文件 —— 变异可能改到
//   core.mjs 以外的文件（m.file），只重跑 core+legal 会漏掉其它文件被写坏的情况。
const after = runTests(BASE_TESTS);
console.log(`基线 ${after.pass} pass / ${after.fail} fail`);

console.log("\n— 汇总 —");
console.log(`变异总数 ${MUTATIONS.length}：变红 ${killed.length} ／ 仍绿 ${alive.length} ／ 等价 ${equivalent.length} ／ 没打中原文 ${missed.length}`);
// ★ DSH `[#10]` §3 的闭合核对：分母（MUTATIONS.length）必须等于分子（四类判定之和）。
//   将来若有人在循环里加了 `continue` 却不归类，这里立刻对不上；否则那条变异会
//   「配了却不留证据」—— 正是他那 2 份日志缺口的同型。
const accounted = killed.length + alive.length + equivalent.length + missed.length;
if (accounted !== MUTATIONS.length) {
  console.log(`★ 分子分母对不上：清单 ${MUTATIONS.length} 条，实际只判定 ${accounted} 条 ⇒ 有变异被静默跳过。`);
  process.exit(1);
}
if (alive.length) {
  console.log("\n★ 仍绿 = 这条护栏没有测试在守，必须补：");
  for (const m of alive) console.log(`  · ${m.name}`);
}
if (equivalent.length) {
  console.log("\n等价变异（行为中性，不构成缺口；但说明这两处是同一条判据的两道保险）：");
  for (const m of equivalent) console.log(`  · ${m.name}`);
}
if (missed.length) {
  console.log("\n★ 没打中原文 = 这次根本没测到（原文已改？）单独报，别和「仍绿」混在一起：");
  for (const m of missed) console.log(`  · ${m.name}（出现 ${m.hits} 次）`);
}
// ★ 2026-10-17 修（审核）：`parsed` 为假时 pass/fail 都是 -1 ⇒ 上面这个判据
//   恒为真 ⇒ **每次都打印假警报**，真出事时会被当成噪声忽略掉。
//   解析不出来就明说是「核对本身不可信」，不要把 -1 当成真数字去比。
if (!after.parsed) {
  console.log("\n★ 复原后解析不出 pass/fail ⇒ 这次核对本身不可信，请人工确认文件已复原。");
  console.log("  原始输出尾部：\n" + after.out.split("\n").slice(-12).join("\n"));
} else if (after.pass !== base.pass || after.fail !== 0) {
  console.log("\n★ 复原后与基线不一致 ⇒ 文件可能被写坏，检查改动过的文件。");
  console.log(`  基线 ${base.pass} pass / ${base.fail} fail → 现在 ${after.pass} pass / ${after.fail} fail`);
  if (after.names.length) console.log(after.names.slice(0, 10).map((n) => `  · ${n}`).join("\n"));
}

process.exit(alive.length || missed.length || !after.ok ? 1 : 0);

