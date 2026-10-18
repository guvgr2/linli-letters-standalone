// 错误号表。
//
// ★ 号是**契约**，不是注释。两条规矩：
//   ① 号一律取自本表，调用方不许写字面量（tests/error-codes.test.js 盯着）；
//   ② 改号名必须同步改文档与测试。
//
// 为什么②要写死：姊妹项目 2026-10-17 的真实教训 ——
//   `LOCAL_AI_PROCESS_REMOVED` 收进错误号表时按前缀重命名成 `MODEL_LOCAL_PROCESS_REMOVED`，
//   代码和测试都改了，唯独 `docs/本地服务API清单.md` 没跟；那份文档又**没有任何机器校验会读**，
//   于是名字悄悄漂了，只有人眼对得出来。
//   ⇒ 号一旦定下就是对外契约：改名不是重构，是破坏性变更，必须文档同步。
//
// 为什么单独一个文件：`server.mjs` 一旦被 import 就会 `listen` 起服务，
//   测试没法导入它 ⇒ 表放这里，护栏测试才能真的把这张表读进来看。
//
// 分组规则：`域_具体事`。
//   COMMON    来源 / 令牌 / 请求体 / 路由 / 兜底
//   LETTER    写信
//   LIBRARY   曲库
//   IDLE      待机素材
//   FONT      信件字体
//   IMPORT    UserData 导入（.soul 归档）
//   PROACTIVE 主动来信设置
//   MODEL     模型接口
//   REPLY     生成队列（不回 HTTP，写进 letters.error 给界面看）

export const ERR = {
  // ── 通用
  COMMON_ORIGIN_BLOCKED: "COMMON_ORIGIN_BLOCKED",
  COMMON_TOKEN_MISSING: "COMMON_TOKEN_MISSING",
  COMMON_BODY_TOO_LARGE: "COMMON_BODY_TOO_LARGE",
  COMMON_BODY_NOT_JSON: "COMMON_BODY_NOT_JSON",
  COMMON_BODY_NOT_OBJECT: "COMMON_BODY_NOT_OBJECT",
  COMMON_ROUTE_NOT_FOUND: "COMMON_ROUTE_NOT_FOUND",
  // ★ 2026-10-18：字体引导要「打开官网去下载」，而 `openExternal()` 是唯一能
  //   把用户带出程序的出口 —— 它一旦被随意传参，就是一个「点一下跳去任意地址」
  //   的洞。所以前端和外壳两侧各有一份同样的主机名白名单
  //   （app.js 的 ALLOWED_EXTERNAL_HOSTS / MainWindow.cs 的 AllowedExternalHosts），
  //   不在名单里的一律不发，并回这个号。
  //   ★ 归 COMMON 域而不是单开一个 EXTERNAL 域：它是**通用出口护栏**，
  //     不属于信件/字体/导入任何一个业务域；用户看到「这个网址不在允许打开的名单里」
  //     —— 下一步不用做任何事（程序自己拦的，不是他填错了什么）。
  COMMON_EXTERNAL_URL_NOT_ALLOWED: "COMMON_EXTERNAL_URL_NOT_ALLOWED",

  // ── 数据备份与恢复（照姊妹项目 data-safety.js 的号，只改域前缀）
  //   ★ 归 COMMON 域：它管的是整个数据目录，不属于信件/曲库/字体任何一个业务域。
  //   ★ 「名字无效」「正在用的库」「这份不存在」「打不开」必须分成四个号：
  //     用户下一步动作完全不同 —— 名字无效是程序内部问题（贴日志）、正在用的是点错了
  //     （换一份）、不存在是刷新列表、打不开是这份文件坏了（换一份旧的）。
  COMMON_BACKUP_NAME_INVALID: "COMMON_BACKUP_NAME_INVALID",
  COMMON_BACKUP_IS_LIVE: "COMMON_BACKUP_IS_LIVE",
  COMMON_BACKUP_NOT_FOUND: "COMMON_BACKUP_NOT_FOUND",
  COMMON_BACKUP_INVALID: "COMMON_BACKUP_INVALID",
  COMMON_BACKUP_DATABASE_MISSING: "COMMON_BACKUP_DATABASE_MISSING",
  //   这两个是「没有确认就不许动」：删除和恢复都不可撤销，误点一下少一份退路。
  COMMON_BACKUP_DELETE_NOT_CONFIRMED: "COMMON_BACKUP_DELETE_NOT_CONFIRMED",
  COMMON_RESTORE_NOT_CONFIRMED: "COMMON_RESTORE_NOT_CONFIRMED",
  //   正在等待重启后恢复的那一份不能删 —— 删了就等于把用户自己刚下的决定撤掉了。
  COMMON_BACKUP_PENDING_RESTORE: "COMMON_BACKUP_PENDING_RESTORE",
  COMMON_EXPORT_TOO_LARGE: "COMMON_EXPORT_TOO_LARGE",

  COMMON_INTERNAL: "COMMON_INTERNAL",

  // ── 信件
  LETTER_EMPTY: "LETTER_EMPTY",
  LETTER_TOO_LONG: "LETTER_TOO_LONG",
  LETTER_NOT_FOUND: "LETTER_NOT_FOUND",

  // ── 曲库
  LIBRARY_DIR_NOT_FOUND: "LIBRARY_DIR_NOT_FOUND",
  LIBRARY_SONG_REQUIRED: "LIBRARY_SONG_REQUIRED",
  LIBRARY_SONG_NOT_FOUND: "LIBRARY_SONG_NOT_FOUND",
  // 试听这两条是前端自判的：没片子、或者浏览器不放行自动播放。
  // 前者用户要换一首，后者多半是刚点进来还没跟页面交互过 —— 下一步动作相反，不能合并。
  LIBRARY_NO_VIDEO: "LIBRARY_NO_VIDEO",
  LIBRARY_AUDITION_FAILED: "LIBRARY_AUDITION_FAILED",
  LIBRARY_TITLE_REQUIRED: "LIBRARY_TITLE_REQUIRED",

  // ── 歌单（照姊妹项目的 PLAYLIST_ITEM_INCOMPLETE 一系）
  // ★ 前缀用 LIBRARY_ 不是 PLAYLIST_：错误号的域是**枚举**（COMMON/LETTER/LIBRARY/
  //   IDLE/FONT/IMPORT/PROACTIVE/MODEL/REPLY，见 tests/error-codes.test.js 第①条），
  //   开一个新域要连带改测试与文档。歌单本来就是曲库的一部分 —— 它装的都是曲库曲目，
  //   曲目不存在时回的还是 LIBRARY_SONG_NOT_FOUND —— 归进 LIBRARY 才对得上。
  // ★ 「歌单不存在」与「歌单里没有这一首」必须分两个号：前者多半是歌单刚被删、
  //   界面还拿着旧 id（刷新一下就好），后者是这首压根没加进去（用户要重新加）。
  LIBRARY_FOLDER_NAME_REQUIRED: "LIBRARY_FOLDER_NAME_REQUIRED",
  LIBRARY_FOLDER_NAME_TOO_LONG: "LIBRARY_FOLDER_NAME_TOO_LONG",
  LIBRARY_FOLDER_NOT_FOUND: "LIBRARY_FOLDER_NOT_FOUND",
  LIBRARY_PLAYLIST_ITEM_INCOMPLETE: "LIBRARY_PLAYLIST_ITEM_INCOMPLETE",
  LIBRARY_PLAYLIST_ITEM_NOT_FOUND: "LIBRARY_PLAYLIST_ITEM_NOT_FOUND",

  // ── 待机素材
  IDLE_AMBIENCE_NOT_BOOL: "IDLE_AMBIENCE_NOT_BOOL",

  // ── 信件字体
  FONT_FILE_TOO_LARGE: "FONT_FILE_TOO_LARGE",
  FONT_NOT_FONT: "FONT_NOT_FONT",
  // ★ 「文件不是字体」与「是字体、但读不出名字」必须分两个号：
  //   前者用户要**换一个文件**（这个根本不是字体），后者字体已经装上了、
  //   只是 @font-face 的族名不敢猜（猜错会盖住系统里真正的那一支），
  //   用户什么都不用做 —— 两种完全不同的下一步，压成一个号就把人指向错的动作。
  FONT_NAME_UNREADABLE: "FONT_NAME_UNREADABLE",
  FONT_SAVE_FAILED: "FONT_SAVE_FAILED",

  // ── UserData 导入（.soul 归档）
  //    ★ 失败**文案**与 DSH 侧 `server.js` 的 SOUL_* 一族逐字对齐 —— 用户在两端
  //      看到同一句话，出问题时两边说的才是同一件事。号本身按我侧分组规则
  //      （域_具体事）命名，与 DSH 号的对照关系写在 `错误号一览.md`。
  //    ★ 五类五种用户动作：收不下要换办法搬 / 读不懂是文件坏了 /
  //      备份没成这次就没动过库（先停手）/ 找不到预览就重新选一次文件。
  IMPORT_FILE_REQUIRED: "IMPORT_FILE_REQUIRED",
  // ⚠️ 「没有文件」与「没有预览 id」必须是**两个号**：一码多义会让按号排查的人以为
  //    出了同一件事，而这俩的下一步动作完全不同（重选文件 vs 重走预览）。
  IMPORT_PREVIEW_REQUIRED: "IMPORT_PREVIEW_REQUIRED",
  IMPORT_SOUL_TOO_LARGE: "IMPORT_SOUL_TOO_LARGE",
  IMPORT_SOUL_UNREADABLE: "IMPORT_SOUL_UNREADABLE",
  IMPORT_BACKUP_FAILED: "IMPORT_BACKUP_FAILED",
  IMPORT_PREVIEW_STALE: "IMPORT_PREVIEW_STALE",
  // ── 导出包（一键导入）那一支：与 .soul 导入同样是「拿一个外部文件进来」，同归 IMPORT 域
  //    ★ 五个号对应五种不同的坏法，用户动作各不相同：
  //      不是 zip / zip 里没文件 / 里面没有那个库文件（不是本程序导出的）/ 包太大（先别导）。
  IMPORT_TOO_LARGE: "IMPORT_TOO_LARGE",
  IMPORT_NAME_INVALID: "IMPORT_NAME_INVALID",
  IMPORT_ZIP_INVALID: "IMPORT_ZIP_INVALID",
  IMPORT_ZIP_EMPTY: "IMPORT_ZIP_EMPTY",
  IMPORT_LAYOUT_INVALID: "IMPORT_LAYOUT_INVALID",

  // ── 主动来信设置
  PROACTIVE_SETTINGS_INVALID: "PROACTIVE_SETTINGS_INVALID",

  // ── 模型
  MODEL_KEY_MISSING: "MODEL_KEY_MISSING",
  MODEL_HTTP_FAILED: "MODEL_HTTP_FAILED",
  MODEL_EMPTY_CONTENT: "MODEL_EMPTY_CONTENT",
  // ★ 连不上（DNS 错、代理没开、超时中断）与「连上了但对面回 4xx/5xx」是两件事：
  //   前者查自己的网络与代理，后者查接口地址、模型名与额度。以前都并进
  //   MODEL_HTTP_FAILED，用户按号查时会被指去改 baseUrl —— 而问题在网络。
  MODEL_UNREACHABLE: "MODEL_UNREACHABLE",

  // ── 生成队列
  REPLY_PRECHECK_BLOCKED: "REPLY_PRECHECK_BLOCKED",
  REPLY_PRECHECK_UNREADABLE: "REPLY_PRECHECK_UNREADABLE",
  REPLY_SELFCHECK_FAILED: "REPLY_SELFCHECK_FAILED",
};

/**
 * 把号拼进用户看得懂的那句话。
 *
 * 两条腿一起走：
 *   - 用户看到的是「中文（错误号）」—— 报障时截图一句话就能定位，不用复述现象；
 *   - 程序/日志/测试拿到的是 `code` 纯号 —— 不带文案，不会随文案措辞漂移。
 *
 * ★ 前端 `app.js` 的 `api()` **原样上屏 `payload.error`**，不许再拼一次
 *   （服务端拼过、前端又拼，会出现「…（LETTER_EMPTY）（LETTER_EMPTY）」）。
 */
export function codeMessage(message, code) {
  return `${message}（${code}）`;
}

/**
 * ★ 带状态码 + 错误号的错误。
 *   原来所有异常都走最外层那个 catch ⇒ 一律 500，于是"请求体写错了"这种
 *   **用户自己的问题**也被报成服务端故障，还把 JS 解析器的原文回吐出去
 *   （`Expected property name or '}' in JSON at position 1`）。
 *   用户看得懂的是"请求体不是合法的 JSON"，不是解析器那句话。
 *
 * 放在这个文件里而不是 server.mjs：server.mjs 一被 import 就会 listen 起服务，
 *   护栏测试导不进它 ⇒ 类和它的默认号一起挪到这里，才验得动。
 */
export class ApiError extends Error {
  constructor(status, message, code = ERR.COMMON_INTERNAL) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
