// 「OliviaSoul-community独立版」前端。
// 三块：信箱 / 记忆 / 设置。所有请求都打本地服务，不出本机。

const $ = (id) => document.getElementById(id);
let toastTimer = null;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  // ★ 26 秒而不是 2.6 秒：带错误号的那句话比原来长一截（多出「（LETTER_EMPTY）」这种尾巴），
  //   2.6 秒够看完一句普通提示，但不够看清一个号 —— 而用户要截图报障时号才是要紧的。
  //   号只给需要的人看；不需要的人 26 秒后它自己就走了，不占地方。
  //   ⚠️ 全角括号用 \uFF08/\uFF09 写：在 /u 模式里 `\（` 是非法转义，会直接 SyntaxError。
  const hasCode = /\uFF08[A-Z][A-Z0-9_]*\uFF09\s*$/u.test(text);
  toastTimer = setTimeout(() => el.classList.remove("on"), hasCode ? 26000 : 2600);
}

/**
 * 用户面前的那句话必须带号（用户 2026-10-17 的要求）。
 *
 * ★ 服务端的事走 `fail()`；**前端自己就能判的错**（空信、没选文件、缺字段）
 *   也得带号，而且**号码必须与后端那一处完全相同** —— 同一个错误不能因为
 *   「这次是前端先发现的」就报出另一个号，那样按号排查的人会对不上。
 *   号表真源在 `app/error-codes.mjs`，这里只是引用它的字面值。
 */
function codeText(message, code) {
  return `${message}（${code}）`;
}

// 会话令牌：服务端的写操作要它，防止本机其它进程（或任意网页）改配置。
// 令牌只发给通过来源检查的同源页面，取不到就说明我们不在自己的页面里。
let sessionToken = null;

async function ensureToken() {
  if (sessionToken) return sessionToken;
  const data = await api("/api/session");
  sessionToken = data.token;
  return sessionToken;
}

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = {};
  if (options.body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    headers["X-Linli-Token"] = await ensureToken();
  }
  // ★ options.auth = true：连 GET 也带令牌。数据备份/恢复那一组接口收的是本机敏感数据
  //   （备份清单、待恢复来源、导出包），服务端对它们的 GET 同样要求令牌 —— 否则同机的
  //   另一个网页/进程能读到「你的备份都在哪、下次开机会恢复成哪一份」。
  //   默认仍只在写操作时带，免得每条 GET 都多一次 ensureToken() 的时序耦合。
  if (options.auth) headers["X-Linli-Token"] = await ensureToken();
  const response = await fetch(path, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // ★ 出错号（2026-10-17）：服务端把「中文（错误号）」拼在 payload.error 里，
    //   这里**原样上屏、不许再拼一次**（重复拼会出现「…（LETTER_EMPTY）（LETTER_EMPTY）」）。
    //   code 同时挂到 Error 上，方便代码里按号分支，而不是去比中文文案。
    const err = new Error(payload.error ?? `请求失败（${response.status}）`);
    err.code = payload.code ?? null;
    err.status = response.status;
    throw err;
  }
  return payload;
}

// ---------------------------------------------------------------- 页面切换

const PAGES = ["mail", "library", "memory", "settings"];
function show(page) {
  // 离开曲库页就停掉时段轮询并卸掉播放器，别在后台继续解码 100MB 级的视频
  if (page !== "library") stopPlayerWatch();
  for (const name of PAGES) {
    const el = $(`page-${name}`);
    if (el) el.classList.toggle("on", name === page);
  }
  for (const btn of document.querySelectorAll(".rb")) {
    btn.classList.toggle("on", btn.dataset.page === page);
  }
  if (page === "memory") loadMemory();
  if (page === "settings") loadSettings();
  if (page === "library") loadLibrary();
}
for (const btn of document.querySelectorAll(".rb")) {
  btn.addEventListener("click", () => show(btn.dataset.page));
}
// 信箱页顶栏那枚齿轮就是「设置」的另一个入口（原版信箱页右上角也有一个齿轮）。
// ★ 走 show("settings") 而不是自己切 class：切页要带的副作用（停播放、加载数据）
//   都挂在 show() 里，绕过它就只换了个画面。
$("mailGear")?.addEventListener("click", () => show("settings"));

// ---------------------------------------------------------------- 信箱

function formatTime(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 列表里那一行标题：取第一句，太长就截断（原版列表也是这么给我看的）。 */
function firstLine(text, limit = 20) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

function letterState(item) {
  if (item.origin === "proactive") return "她先写的";
  // ★ 2026-10-17：status 5 不再是「生成失败」的同义词。
  //   从旧程序搬进来的信，没回信的也记 5（DSH 口径 status 5 = UNREPLIED），
  //   那些信**从来没失败过**，只是他没让林离回过。判失败的唯一依据是 error 有没有内容。
  if (item.status === 5 && item.error) return "生成失败";
  return item.reply_text ? "已回信" : "等她回信";
}

let lettersCache = [];
let selectedLetterId = null;

function renderLetterList() {
  const host = $("letters");
  const count = $("mailCount");
  if (count) count.textContent = String(lettersCache.length);
  if (!host) return;
  if (!lettersCache.length) {
    host.innerHTML = `<p class="hint" style="padding:8px 12px">还没有信。点下面「写信」写第一封。</p>`;
    return;
  }
  // ★ 2026-10-18 照原版 MailBoxItem 重排：40×40 图标 + 标题 + 时间，选中/悬停同一底色。
  //   原版图标底色按类型分（寄出 #6B645B / 回信 #4F6F5E / 错误 #2F3036），我们照抄这三个色值。
  //   未读另加一个小圆点 + 标题加粗（原版 .mail-item-subject-unread）。
  host.innerHTML = lettersCache.map((item) => {
    const her = item.origin === "proactive";
    const failed = item.status === 5 && item.error;
    const pending = !item.reply_text && !failed;
    const title = her
      ? `她写来一封：${firstLine(item.reply_text, 14)}`
      : (firstLine(item.content) || "（空信）");
    const iconClass = failed ? "is-error" : her || pending ? "is-pending" : "is-send";
    const icon = failed ? "!" : her ? "✉" : pending ? "✎" : "✉";
    const unread = item.is_read === 0 && item.reply_text ? `<span class="mail-item-unread"></span>` : "";
    const unreadClass = item.is_read === 0 && item.reply_text ? " mail-item-subject-unread" : "";
    return `<div class="mail-item${item.id === selectedLetterId ? " mail-item-selected" : ""}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0">
      <span class="mail-item-icon ${iconClass}">${icon}</span>
      <span class="mail-item-content">
        <span class="mail-item-subject${unreadClass}">${escapeHtml(title)}</span>
        <span class="mail-item-time">${formatTime(item.replied_at || item.created_at)} · ${letterState(item)}</span>
      </span>
      ${unread}
    </div>`;
  }).join("");
  for (const row of host.querySelectorAll(".mail-item")) {
    // ★ 信件 id 是服务端给的 UUID（randomUUID），不是自增整数 —— 别做数字转换。
    row.addEventListener("click", () => selectLetter(row.dataset.id));
    // 键盘可达：这是 div 不是 button，Enter / 空格要自己接。
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectLetter(row.dataset.id);
      }
    });
  }
}

/** 右栏：选中了就显示往来，没选中就是空态。
 *  ★ 2026-10-18 照原版 MailBox 重排：右栏不再是"上下两条"，而是**一张 16:9 明信片卡**
 *    （原版 .mail-responsive-card { min-width:516px; min-height:290px; aspect-ratio:16/9 }），
 *    点这张卡才拆信封（信封打开那一段在 mail-ui.js 的 openEnvelope）。
 */
function renderReader() {
  const empty = $("mailEmpty");
  // 宿主缺失就直接返回，不要在 null 上设属性：抛出去会被全局 onerror 抓走塞进 toast，
  // 用户看到的是一句英文 TypeError，而不是「读信区没画出来」这个真问题。
  if (!empty) return;
  const ui = window.__mailUI;
  if (!ui) return;
  // ★ 正在写信时右栏的东家长是那张写信卡，不是信 —— 而 loadLetters 每 5 秒**无条件**
  //   重画一次右栏，会把用户写到一半的草稿连卡一起清掉（2026-10-18 实测：
  //   点「写信」后等 6 秒 textarea 就没了）。所以这条轮询必须在这里让路。
  if (ui.composing) return;
  const item = lettersCache.find((l) => l.id === selectedLetterId);
  if (!item) {
    ui.showEmpty(lettersCache.length ? "点击左侧信箱栏阅读信件" : "还没有信。点下面「写信」写第一封。");
    return;
  }
  const card = replyCard(item);
  if (card) ui.renderCard(card);
}

/**
 * 把一封信折成 renderCard 要的形状 —— 三态照原版（这套态是原版**本来就有**的，不是我们加的）：
 *   · postcard_letter.webp  正常回信（可拆信封）
 *   · postcard_sealed.webp  已封
 *   · postcard_retry.webp   失败、可重试
 *   · postcard_video.webp   她正在写（min-height:250px）
 * ★ 2026-10-17：**只有带着 error 的 5 才是失败**。搬进来的旧信也是 5，
 *   它们没有回信、但也没出过错 —— 按「无回信」渲染，别给它盖一张失败卡。
 */
function replyCard(item) {
  const pro = item.origin === "proactive";
  if (item.status === 5 && item.error) {
    return { kind: "retry", from: "林离", when: formatTime(item.replied_at || item.created_at), text: item.error, canOpen: false };
  }
  if (item.reply_text) {
    return {
      kind: "letter",
      from: pro ? "林离（她先写来）" : "林离",
      when: formatTime(item.replied_at || item.created_at),
      text: item.reply_text,
      canOpen: true,
    };
  }
  // 她还在写
  return { kind: "video", from: "林离", when: formatTime(item.created_at), text: "她还在写……", canOpen: false };
}

/** ★ 走 api() 而不是裸 fetch：写操作服务端一律要 X-Linli-Token，
 *  以前这里没带令牌 ⇒ 401 被 catch 吞掉，"已读"这个动作其实从来没生效过。 */
function markRead(id) {
  api(`/api/letters/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
}

function selectLetter(id) {
  selectedLetterId = id;
  renderLetterList();
  renderReader();
  const item = lettersCache.find((l) => l.id === id);
  if (item && item.is_read === 0 && item.reply_text) {
    item.is_read = 1;                  // 本地先记上，红点立刻消失；服务端那边同步
    renderLetterList();
    markRead(item.id);
  }
}

/** 拉信件列表并重画。★ 这个函数在 2026-10-18 重排时被整段替换掉了（连同写信卡），
 *  可它下面还有 4 处调用，少一行就是整个页面启动即 ReferenceError。
 *  ★ 轮询每 5 秒跑一次，所以这里**不能**动用户正在阅读的那封：
 *    选中的还在就保持不动，不在了才退回到"有未读先摆未读"。
 */
async function loadLetters(keepSelection = null) {
  try {
    const { letters } = await api("/api/letters");
    lettersCache = letters;
    const stillThere = selectedLetterId !== null && letters.some((l) => l.id === selectedLetterId);
    if (!stillThere) {
      const target = keepSelection ? letters.find((l) => l.id === keepSelection) : null;
      const unread = target ?? letters.find((l) => l.is_read === 0 && l.reply_text);
      selectedLetterId = unread ? unread.id : null;
      if (unread && unread.is_read === 0) markRead(unread.id);
    }
    renderLetterList();
    renderReader();
    updateComposeQuota();
  } catch (error) {
    toast(error.message);
  }
}


/** 左下角那条：说今天寄了几封（事实），不编一个我们根本没有的每日限额。 */
function updateComposeQuota() {
  const el = $("composeQuota");
  if (!el) return;
  const now = new Date();
  const mine = lettersCache.filter((l) => l.origin !== "proactive" && l.created_at);
  const today = mine.filter((l) => {
    const d = new Date(l.created_at * 1000);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  });
  el.textContent = mine.length
    ? `今天已寄 ${today.length} 封 · 一共 ${mine.length} 封`
    : "今天还没有寄出";
}

// ---------------------------------------------------------------- 给 mail-ui.js 的接口
// mail-ui.js 只管排版与交互（信封展开、写信卡），读写接口留在本文件 ——
// 这样 api() / 令牌 / 错误号那套还只有一份实现，不会在两边各长一套。

window.__mailToast = (text) => toast(text);
window.__mailCodeText = (message, code) => codeText(message, code);
window.__mailStopPlayer = () => stopPlayerWatch();
// 取消写信 / 寄出之后回到读信态。★ 这里**不看** DOM 上还有没有写信卡：
//   mail-ui.js 每次都先自己把卡拆了再叫这条，那正是我们想要的结果；
//   按"卡还在就不重画"来挡，等于永远不重画（2026-10-18 踩到）。
window.__mailRefresh = () => renderReader();

/** 「寄出信件」：与旧按钮同一条链路（先本地挡空信，再 POST，成功后重拉列表并选中刚寄出的那封）。 */
window.__mailSend = async (content) => {
  const { id } = await api("/api/letters", { method: "POST", body: { content } });
  toast("已寄出，等她回信");
  selectedLetterId = id;
  await loadLetters(id);             // 刚寄出的那封直接选中，右侧立刻变成"她还在写……"
};

// ---------------------------------------------------------------- 曲库

let allSongs = [];        // 曲库目录里扫出来的全部（每首带 genre / mode）
let deskSongs = [];       // 已入库（"音乐桌面"上摆着的）
// ★ 默认停在「古典」—— 原版也是这一档起手（第一张截图里 古典 就是选中态）。
//   页签值直接就是分档名，因为分档是服务端算好的：前端不做任何分类判断。
const LIB_TABS = ["古典", "ACG", "轻音乐", "我的上传"];
let libTab = LIB_TABS[0];
// 歌单：左栏页签里的最后几个（在四个分档之后）。名称与顺序跟着服务端，
// 前端不缓存名字，只缓存 id → 详情，避免改名后两处对不上。
let folders = [];         // [{id, name, order, count, ...}]
let openFolderId = null;  // 当前点开的歌单（null = 没点开任何歌单）
let folderDetail = null;  // 上面那个歌单的完整内容（含条目）

/** 原版「最近演出」的相对时间（语言包 T="刚刚" V="{n}分钟前" W="{n}小时前" X="{month}月{day}日"）。
 *  ★ 口径照原版：一分钟内说「刚刚」，一小时内说「n 分钟前」，一天内说「n 小时前」，
 *    超过一天就直接给日期 —— 原版就是这么粗，不要自作聪明加"昨天/前天"。 */
function recentLabel(playedAt, now) {
  const delta = Math.max(0, (now ?? Math.floor(Date.now() / 1000)) - playedAt);
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  const d = new Date(playedAt * 1000);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 上一次点「播放」的那首 + 那批「最近演出」。
 *  ★ 2026-10-18：原来左栏只有四个分档页签，用户根本看不出"我刚才听的去哪了"。
 *    原版有「最近演出」这一栏（语言包 Q="最近演出"），这里补上。 */
let recentSongs = [];
let recentNow = 0;

async function loadRecent() {
  try {
    const data = await api("/api/library/recent?limit=12");
    recentSongs = data.songs ?? [];
    recentNow = data.now ?? Math.floor(Date.now() / 1000);
  } catch {
    recentSongs = [];   // 拿不到就当没有历史，不影响曲库本身
  }
}

// ---------------------------------------------------------------- 歌单
// 照姊妹项目（E:\olivia-soul-community-kit\repo\source\local-service\public\
// game-favorites.js）的交互：曲目行上「加播单」→ 弹出歌单列表 → 勾选即写入、
// 取消什么都不做；再点同一个按钮收回。姊妹项目那份是注入进原版游戏的，
// 我们这边没有原版 feapp，所以同样的交互自己画。

async function loadFolders() {
  try {
    const data = await api("/api/folders");
    folders = data.folders ?? [];
  } catch {
    folders = [];   // 拿不到就当没有歌单，不影响曲库本身
  }
}

async function openFolder(id) {
  try {
    const data = await api(`/api/folders/${encodeURIComponent(id)}`);
    openFolderId = id;
    folderDetail = data.folder;
  } catch (error) {
    // 这个歌单已经不在了（多半是另一个窗口删的）：退回"没点开"的状态，
    // 别让左栏停在一个读不到内容的页签上。
    openFolderId = null;
    folderDetail = null;
    toast(error.message);
    await loadFolders();
  }
  renderLibTabs();
  renderSongs();
}

/** 把一首歌加进歌单 / 从歌单里拿走。成功后刷新页签计数与当前列表。 */
async function toggleFolderItem(folderId, dir, add) {
  try {
    if (add) {
      await api(`/api/folders/${encodeURIComponent(folderId)}/items`, { method: "POST", body: { dir } });
    } else {
      await api(`/api/folders/${encodeURIComponent(folderId)}/items?dir=${encodeURIComponent(dir)}`, { method: "DELETE" });
    }
    await loadFolders();
    if (openFolderId) await openFolder(openFolderId);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function createFolder(name) {
  try {
    const data = await api("/api/folders", { method: "POST", body: { name } });
    folders = data.folders ?? folders;
    renderLibTabs();
    return data.folder;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

async function renameFolder(folderId, name) {
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", body: { name } });
    folders = data.folders ?? folders;
    if (openFolderId === folderId && data.folder) folderDetail = data.folder;
    renderLibTabs();
    renderSongs();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function deleteFolder(folderId) {
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" });
    folders = data.folders ?? [];
    if (openFolderId === folderId) {
      openFolderId = null;
      folderDetail = null;
    }
    renderLibTabs();
    renderSongs();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

/** 重排：把新的 dir 顺序整份发给服务端（它只认歌单里已有的曲目，缺的按原序接在后面）。 */
async function reorderFolder(folderId, order) {
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folderId)}/items`, {
      method: "PATCH",
      body: { order },
    });
    if (openFolderId === folderId) folderDetail = data.folder;
    renderSongs();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function loadLibrary() {
  try {
    const data = await api("/api/library");
    $("libraryDir").value = data.dir ?? "";
    const total = data.count ?? 0;
    const note = data.error ? data.error : `${total} 首`;
    $("libraryState").textContent = note;
    allSongs = data.songs ?? [];
    // 设置页那一行要把**分档结果**摊开写出来 —— 这是"导入时自动分类"这件事的凭据：
    // 用户扫一眼就知道分完了，分成了几档，不用自己去点页签数。
    if ($("libraryState2")) {
      $("libraryState2").textContent = data.error
        ? data.error
        : `${total} 首 · 导入时自动分档：${genreTally()}`;
    }
    await loadImported();              // 表格要知道哪些已入库，所以先拉它
    await loadRecent();                // 「最近演出」要在页签前拿到，页签上带条数
    await loadFolders();               // 歌单页签也排在页签行里，条数跟着一起出
    renderLibTabs();
    renderSongs();
  } catch (error) {
    toast(error.message);
  }
}

/** 「古典 48 · ACG 68 · 轻音乐 13 · 我的上传 2455」——只统计有曲子的档。 */
function genreTally() {
  const counts = new Map();
  for (const s of allSongs) counts.set(s.genre, (counts.get(s.genre) ?? 0) + 1);
  return LIB_TABS.filter((g) => counts.get(g)).map((g) => `${g} ${counts.get(g)}`).join(" · ");
}

/** 曲库列表里的一行。★ 2026-10-18 照原版 SongCard 重排：
 *  48×48 圆角封面（没有封面就用曲名首字）+ 曲名(18px) + 副标题演奏方式(12px)
 *  + 行末 hover 才出现的「入库」。
 *  ★ 原版口径：行 = 「封面 + 曲名 + 副标题」三件套，`#` 序号属于表头那一列，
 *    不在行里重复画（用户 m11700 原话「这个曲库做的太不像了」）。
 *  ★ 原版没有 emoji，缩略图一律用文字/色块。
 */
function songRow(song, index) {
  const inDesk = deskSongs.some((s) => s.dir === song.dir);
  const on = song.dir === player.dir;
  // 「官方」标记：目录名符合原版 TOD 命名（<曲名>_TOD1200/1730/2000_*_L.mp4）的，
  // 能按当前时段出片；其余是用户自己放进来的。标记用来解释"为什么这首点开是黑的"。
  const official = song.todVariants > 0;
  const initial = (song.name ?? "?").trim().charAt(0) || "?";
  // 「加播单」只在已入库的曲目上出现：歌单条目要求曲目在 songs 表里
  // （服务端 POST /api/folders/:id/items 会回 LIBRARY_SONG_NOT_FOUND），
  // 界面上就别给一个点了必然失败的按钮。
  const addBtn = inDesk
    ? `<button class="song-item-add" data-add-folder="${escapeHtml(song.dir)}" type="button" title="加进歌单">加播单</button>`
    : "";
  return `<div class="song-item${on ? " song-item-on" : ""}" data-dir="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" title="${escapeHtml(song.dir)}">
    <span class="song-item-icon">${escapeHtml(initial)}</span>
    <span class="song-item-content">
      <span class="song-item-title">${escapeHtml(song.name)}${official ? `<span class="song-item-official" title="有原版分时段的演奏视频">官方</span>` : ""}</span>
      <span class="song-item-sub">${escapeHtml(song.mode ?? "")}</span>
    </span>
    ${addBtn}
    <button class="song-item-import" data-import="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" type="button">${inDesk ? "已在桌面" : "入库"}</button>
  </div>`;
}

/** 「加播单」下拉：列出全部歌单，勾选即加入，取消什么都不做。
 *  ★ 照姊妹项目 game-favorites.js 的行为 —— 再点同一个按钮就收回，
 *    列表顶部留一行「新建歌单」当作没有歌单时的去处。 */
function openAddToFolderMenu(anchor, dir) {
  closeAddToFolderMenu();
  if (!folders.length) {
    toast("还没有歌单。先点页签栏最后的「＋」建一个。");
    return;
  }
  const menu = document.createElement("div");
  menu.className = "folder-menu";
  // 勾选态要真去问：这首歌可能已经在几个歌单里了。逐个歌单要详情太浪费
  // （几百个歌单就是几百次请求），所以开菜单时只画、勾选态等答案回来再补。
  menu.innerHTML = folders.map((f) => `
    <label class="folder-menu-row" title="${escapeHtml(f.name)}">
      <input type="checkbox" data-folder-pick="${escapeHtml(f.id)}" disabled>
      <span class="folder-menu-name">${escapeHtml(f.name)}</span>
      <span class="folder-menu-count">${f.count ?? 0}</span>
    </label>`).join("");
  document.body.appendChild(menu);
  const box = anchor.getBoundingClientRect();
  // 贴着按钮弹：默认往下，靠近窗口底边就翻到上面去。
  const top = box.bottom + 6 + menu.offsetHeight > window.innerHeight
    ? box.top - menu.offsetHeight - 6
    : box.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  for (const input of menu.querySelectorAll("[data-folder-pick]")) {
    input.addEventListener("change", async () => {
      const ok = await toggleFolderItem(input.dataset.folderPick, dir, input.checked);
      if (!ok) input.checked = !input.checked;   // 写失败就把勾去掉，别让界面撒谎
    });
  }  // 勾选态：并发问一遍（歌单数一般个位数，够了）。
  Promise.all(folders.map(async (f) => {
    try {
      const data = await api(`/api/folders/${encodeURIComponent(f.id)}`);
      const hit = (data.folder?.items ?? []).some((it) => it.dir === dir);
      const input = menu.querySelector(`[data-folder-pick="${CSS.escape(f.id)}"]`);
      if (input) {
        input.checked = hit;
        input.disabled = false;
      }
    } catch {
      // 这个歌单读不到（可能刚被删）：留着禁用态，用户点不动也就不会误操作
    }
  }));
  // 点外面收回（延迟一拍，免得这次点击本身又被当成"点外面"）。
  // ★ 菜单里点一下**不算**点外面：用户要在同一首歌上连续勾几个歌单，
  //   一次勾完就收起来会逼他每勾一个都重新点「加播单」，几首歌就得点几十次。
  setTimeout(() => {
    document.addEventListener("click", (e) => {
      if (!menu.isConnected) return;
      if (menu.contains(e.target)) return;
      closeAddToFolderMenu();
    }, { once: true });
  }, 0);
}

function closeAddToFolderMenu() {
  for (const old of document.querySelectorAll(".folder-menu")) old.remove();
}

/** 整夹播放：把歌单的曲目顺序交给播放队列，从第一首开始。 */
async function playFolder(folderId) {
  try {
    const data = await api(`/api/folders/${encodeURIComponent(folderId)}`);
    const f = data.folder;
    if (!f?.items?.length) {
      toast("这个歌单还是空的。");
      return;
    }
    setQueue(f.items.map((it) => ({ dir: it.dir, name: it.name })), 0);
    await play(f.items[0].dir, f.items[0].name);
  } catch (error) {
    toast(error.message);
  }
}

function renderSongs() {
  const host = $("songs");
  if (!host) return;
  const count = $("songCount");
  if (count) count.textContent = String(allSongs.length);
  // 「最近演出」那一栏第三列显示的是相对时间而不是模式，表头跟着换字。
  const modeHead = document.querySelector(".song-list-head-mode");
  // 歌单：点开某个歌单时，列表换成它自己的条目，并且出现一条"整夹播放"的工具行。
  if (openFolderId) {
    renderFolderSongs(host, modeHead);
    return;
  }
  // ★ 「最近演出」不是一个分档（也没有 genre），它按 last_played_at 倒排，
  //   行尾挂的是相对时间而不是「独奏/弹唱」那种模式字 —— 所以单开一条分支，
  //   不去污染 allSongs 的过滤逻辑。
  if (libTab === "最近演出") {
    if (modeHead) modeHead.textContent = "演出时间";
    if (!recentSongs.length) {
      host.innerHTML = `<p class="hint" style="padding:8px 12px">还没演过。点一首的「播放」，这里就会记下时间。</p>`;
      return;
    }
    host.innerHTML = recentSongs.map((s) => {
      // 历史里的曲子可能已经不在当前曲库目录里了（目录改过/文件删了），
      // 这时仍然显示，但补上真正的分档名当副标题，不假装它是某一档的成员。
      const known = allSongs.find((x) => x.dir === s.dir);
      return recentRow(s, known);
    }).join("");
    return;
  }
  const rows = allSongs.filter((s) => s.genre === libTab);
  if (modeHead) modeHead.textContent = "模式";
  if (!rows.length) {
    host.innerHTML = `<p class="hint" style="padding:8px 12px">这一档还没有曲目。（分档是导入时按目录名自动做的，设置页可以改曲库目录）</p>`;
    return;
  }
  host.innerHTML = rows.map((s, i) => songRow(s, i)).join("");
}

/** 歌单内容。★ 跟分档列表的区别只有三处：
 *  ① 有工具行（整夹播放 / 改名 / 删除）；
 *  ② 每行末尾是「移出」而不是「入库」；
 *  ③ 行可以拖拽重排（姊妹项目 folder-manager.js 那边也是拖拽排序）。 */
function renderFolderSongs(host, modeHead) {
  if (modeHead) modeHead.textContent = "模式";
  const f = folderDetail;
  if (!f) {
    host.innerHTML = `<p class="hint" style="padding:8px 12px">这个歌单读不到了。</p>`;
    return;
  }
  const tools = `<div class="folder-tools">
    <button class="folder-play" data-folder-play="1" type="button"${f.items.length ? "" : " disabled"}>整夹播放</button>
    <button class="folder-tool" data-folder-rename="1" type="button">改名</button>
    <button class="folder-tool folder-tool-danger" data-folder-delete="1" type="button">删除歌单</button>
  </div>`;
  if (!f.items.length) {
    host.innerHTML = `${tools}<p class="hint" style="padding:8px 12px">这个歌单还是空的。在右边任意一首曲目上点「加播单」就能加进来。</p>`;
    bindFolderTools(host, f);
    return;
  }
  const rows = f.items.map((item) => {
    const known = allSongs.find((x) => x.dir === item.dir);
    return folderItemRow(item, known);
  }).join("");
  host.innerHTML = tools + rows;
  bindFolderTools(host, f);
}

/** 歌单里的一行：骨架同 songRow，行尾换成「移出」。 */
function folderItemRow(item, known) {
  const initial = (item.name ?? "?").trim().charAt(0) || "?";
  const on = item.dir === player.dir;
  return `<div class="song-item${on ? " song-item-on" : ""}" draggable="true" data-dir="${escapeHtml(item.dir)}" data-name="${escapeHtml(item.name)}" title="${escapeHtml(item.dir)}">
    <span class="song-item-icon">${escapeHtml(initial)}</span>
    <span class="song-item-content">
      <span class="song-item-title">${escapeHtml(item.name)}</span>
      <span class="song-item-sub">${escapeHtml(known?.mode ?? "")}</span>
    </span>
    <button class="song-item-import" data-folder-remove="${escapeHtml(item.dir)}" type="button">移出</button>
  </div>`;
}

function bindFolderTools(host, f) {
  const playBtn = host.querySelector("[data-folder-play]");
  if (playBtn) playBtn.addEventListener("click", () => playFolder(f.id));
  const renameBtn = host.querySelector("[data-folder-rename]");
  if (renameBtn) {
    renameBtn.addEventListener("click", async () => {
      const name = await askFolderName(f.name);
      if (name && name !== f.name) await renameFolder(f.id, name);
    });
  }
  const deleteBtn = host.querySelector("[data-folder-delete]");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      // ★ 删除是不可逆的（条目没有外键，删了歌单条目一起没了），必须问一句。
      if (!window.confirm(`删除歌单「${f.name}」？里面的曲目不会从曲库里消失，只是这个歌单没了。`)) return;
      await deleteFolder(f.id);
    });
  }
  for (const btn of host.querySelectorAll("[data-folder-remove]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await toggleFolderItem(f.id, btn.dataset.folderRemove, false);
    });
  }
  // 拖拽重排：只改顺序，不动内容。
  let dragDir = null;
  for (const row of host.querySelectorAll(".song-item[draggable]")) {
    row.addEventListener("dragstart", () => {
      dragDir = row.dataset.dir;
      row.classList.add("is-dragging");
    });
    row.addEventListener("dragend", () => {
      dragDir = null;
      row.classList.remove("is-dragging");
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (dragDir && dragDir !== row.dataset.dir) row.classList.add("is-drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      row.classList.remove("is-drop");
      const target = row.dataset.dir;
      if (!dragDir || dragDir === target) return;
      const order = f.items.map((it) => it.dir).filter((d) => d !== dragDir);
      const at = order.indexOf(target);
      order.splice(at < 0 ? order.length : at, 0, dragDir);
      await reorderFolder(f.id, order);
    });
  }
}

/** 「最近演出」的一行：骨架跟 songRow 一致（48px 首字封面 + 曲名 + 副标题），
 *  只是行尾换成原版的相对时间（刚刚 / n 分钟前 / n 小时前 / M月D日），
 *  并且不可播（曲子已被删）时整行置灰、不给点击。 */
function recentRow(song, known) {
  const initial = (song.name ?? "?").trim().charAt(0) || "?";
  const gone = !known;
  const sub = gone ? "曲库里已经找不到这一首" : (known.mode ?? "");
  return `<div class="song-item${gone ? " is-gone" : ""}" data-dir="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" title="${escapeHtml(song.dir)}">
    <span class="song-item-icon">${escapeHtml(initial)}</span>
    <span class="song-item-content">
      <span class="song-item-title">${escapeHtml(song.name)}</span>
      <span class="song-item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="song-item-time">${escapeHtml(recentLabel(song.lastPlayedAt, recentNow))}</span>
  </div>`;
}

/** 曲库页顶部页签。★ 2026-10-18 照原版补：
 *  原版（feapp 语言包 zh-cn-bd81633d.js）就是 A="古典" M="抒情" D="摇滚" E="爵士" U="全部"，
 *  页签行在原版里是 flex 一行、当前项底部一道下划线（tab-active），不是整块高亮 ——
 *  整块高亮会跟曲目行的选中态撞成一片。
 *  ★ 最左多一个「最近演出」（原版 Q="最近演出"）：它不是一个分档，而是按 last_played_at
 *    倒排的历史；有历史才出现，没听过任何东西时不占位。
 *  ★ 歌单页签排在四个分档之后：分档是"曲库自带的分类"，歌单是"我自己编的"，
 *    两类东西不该混在一起排。 */
function renderLibTabs() {
  const host = $("libraryTabs");
  if (!host) return;
  const counts = new Map();
  for (const s of allSongs) counts.set(s.genre, (counts.get(s.genre) ?? 0) + 1);
  const tabs = (recentSongs.length ? ["最近演出"] : []).concat(LIB_TABS);
  const parts = tabs.map((g) => {
    const n = g === "最近演出" ? recentSongs.length : counts.get(g);
    const on = !openFolderId && g === libTab;
    return `<button class="library-tab${on ? " on" : ""}" data-tab="${escapeHtml(g)}" type="button">${escapeHtml(g)}${
      n ? ` <span class="library-tab-n">${n}</span>` : ""}</button>`;
  });
  // 歌单页签：名字是用户起的，可能很长，样式上限制宽度、超出打省略号。
  for (const f of folders) {
    const on = openFolderId === f.id;
    parts.push(`<button class="library-tab library-tab-folder${on ? " on" : ""}" data-folder="${escapeHtml(f.id)}" type="button" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}${
      f.count ? ` <span class="library-tab-n">${f.count}</span>` : ""}</button>`);
  }
  parts.push(`<button class="library-tab library-tab-new" data-new-folder="1" type="button" title="新建歌单">＋</button>`);
  host.innerHTML = parts.join("");
  for (const btn of host.querySelectorAll(".library-tab")) {
    btn.addEventListener("click", async () => {
      if (btn.dataset.newFolder) {
        const name = await askFolderName(null);
        if (name) await createFolder(name);
        return;
      }
      if (btn.dataset.folder) {
        if (openFolderId === btn.dataset.folder) return;
        await openFolder(btn.dataset.folder);
        return;
      }
      // ★ 从歌单页签切回普通页签时**不能**因为"libTab 没变"就 return：
      //   libTab 一直是上次选的分档，切进歌单时它并没有被改；真正要退掉的是 openFolderId。
      //   所以先看有没有退掉歌单，再看是不是原地没动。
      const leavingFolder = Boolean(openFolderId);
      if (leavingFolder) {
        openFolderId = null;
        folderDetail = null;
      }
      if (!leavingFolder && libTab === btn.dataset.tab) return;
      libTab = btn.dataset.tab;
      renderLibTabs();
      renderSongs();
    });
  }
}

/** 新建 / 改名歌单的输入框。用原生 prompt 是刻意的：这首歌单名最长 40 个字，
 *  一句话就够，为它单独做一套弹层不值得（而且 prompt 在 WebView2 里是可用的）。 */
async function askFolderName(current) {
  const answer = window.prompt(current ? "歌单新名字" : "新建歌单，起个名字", current ?? "");
  if (answer === null) return null;
  const name = answer.replace(/\s+/gu, " ").trim();
  return name || null;
}

/** 曲库页底部那条「已入库」：原版是 .mail-footer 那块渐变底，我们照抄。
 *  只列最近 4 首，点一下就在右栏放大播放（列表太长会把左栏顶没了）。 */
async function loadImported() {
  const host = $("imported");
  const label = $("importedCount");
  if (label) label.textContent = deskSongs.length ? `${deskSongs.length} 首在桌面` : "桌面还是空的";
  try {
    const { songs } = await api("/api/library/songs");
    // ★ 先落数据、再管渲染：`#imported` 这块宿主在曲库页重做时已经删了，
    //   老代码在这里 `if (!host) return;` 提前返回，导致 deskSongs 永远是空数组 ——
    //   「N 首在桌面」恒显示"桌面还是空的"，曲库行上的「加播单」按钮也一个都不出现。
    deskSongs = songs ?? [];
    if (label) label.textContent = deskSongs.length ? `${deskSongs.length} 首在桌面` : "桌面还是空的";
    if (!host) return;
    if (!deskSongs.length) {
      host.innerHTML = `<span class="imported-empty">入库后按当前时段播放</span>`;
      return;
    }
    host.innerHTML = deskSongs.slice(-4).map((s) => `
      <button class="imported-chip${s.dir === player.dir ? " on" : ""}" data-dir="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}" type="button" title="${escapeHtml(s.dir)}">
        <span>${s.dir === player.dir ? "▶" : "♪"}</span>${escapeHtml(s.name)}
      </button>`).join("");
    for (const row of host.querySelectorAll(".imported-chip")) {
      row.addEventListener("click", () => play(row.dataset.dir, row.dataset.name));
    }
  } catch (error) {
    host.innerHTML = `<span class="imported-empty">${escapeHtml(error.message)}</span>`;
  }
}

function formatDay(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function importSong(dir, name) {
  try {
    await api("/api/library/import", { method: "POST", body: { dir } });
    toast(`已入库：${name}`);
    await loadImported();
    renderSongs();
  } catch (error) {
    toast(error.message);
  }
}

// 列表里的点击：点整行＝播放（原版点曲目就直接进演奏页），末尾那个按钮＝入库
$("songs")?.addEventListener("click", (event) => {
  const imp = event.target.closest("[data-import]");
  if (imp) {
    event.stopPropagation();
    return void importSong(imp.dataset.import, imp.dataset.name);
  }
  const add = event.target.closest("[data-add-folder]");
  if (add) {
    event.stopPropagation();
    return void openAddToFolderMenu(add, add.dataset.addFolder);
  }
  const row = event.target.closest(".song-item");
  // 曲子已经被删掉（最近演出里的灰行）就不发播放请求 —— 否则后端只会回一首 404。
  if (row && row.dataset.dir && !row.classList.contains("is-gone")) {
    // ★ 在哪一栏点开，就按那一栏的顺序当队列：在歌单里点下一首就是歌单的下一首，
    //   不会跳到曲库里毫不相干的一首。
    const list = listRowsForQueue();
    if (list.length) setQueue(list);
    play(row.dataset.dir, row.dataset.name);
  }
});

/** 当前列表栏里能播的那些行，按显示顺序 —— 给 step() 当队列用。
 *  只取带 dir 且不是灰行的（灰行点都点不动，放进队列后面必然 404）。 */
function listRowsForQueue() {
  const host = $("songs");
  if (!host) return [];
  return [...host.querySelectorAll(".song-item[data-dir]")]
    .filter((el) => !el.classList.contains("is-gone"))
    .map((el) => ({ dir: el.dataset.dir, name: el.dataset.name }));
}

$("libHelp")?.addEventListener("click", () => toast("曲子来自你填的那个本机目录，只存路径、不随包。入库＝摆到「音乐桌面」上，可以按当前时段播放。"));

// 时段边界：06:00 / 16:00 / 20:00 —— 与 core.mjs 的 playbackTimeOfDay 同口径，
// 傍晚从 16:00 起（不是 17:30，TOD1730 只是素材标签，别被名字骗了）。
const SLOT_BOUNDARIES = [360, 960, 1200];
// ★ 播放条是**固定 DOM**（index.html 里就写好的），不再每次播放重画一块 innerHTML ——
//   重画会把 video 元素整个换掉，交叉淡入那套就没地方站了。
let player = { dir: null, name: null, tod: null, active: "A", timer: null, warmed: null };

function minutesNow() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function minutesToBoundary() {
  const m = minutesNow();
  for (const b of SLOT_BOUNDARIES) if (m < b) return b - m;
  return SLOT_BOUNDARIES[0] + 1440 - m; // 跨到次日 06:00
}
function activeVideo() { return player.active === "A" ? $("playVideoA") : $("playVideoB"); }

function stopPlayerWatch() {
  if (player.timer) clearInterval(player.timer);
  if (player.warmed) player.warmed.el.remove();
  for (const v of [$("playVideoA"), $("playVideoB")]) { try { v?.pause(); } catch { /* 没在播 */ } }
  player = { dir: null, name: null, tod: null, active: "A", timer: null, warmed: null };
  // 播放条上的字留着不清：停掉之后还显示上一首，比清成空白更好读
}

/**
 * 时段跨越时不硬切：两个 video 叠加，旧的淡出、新的淡入（900ms）。
 * 竞品是专门做了 Transition_1200_1730.mp4 这类转场片，我们没有转场素材，
 * 用交叉淡入等价实现，并在跨越前 90 秒把下一时段的文件预热好，避免切档黑屏。
 */
async function play(dir, name) {
  try {
    const info = await api(`/api/library/play?dir=${encodeURIComponent(dir)}`);
    if (!info.url) return toast(codeText("这首曲子在这个时段没有可用的视频", "LIBRARY_SONG_NOT_FOUND"));
    stopPlayerWatch();

    player.dir = dir;
    player.name = name;
    player.tod = info.tod;
    const v = $("playVideoA");
    const b = $("playVideoB");
    if (b) { b.classList.add("under"); b.removeAttribute("src"); }
    v.classList.remove("under");
    // ★ .active 是原版 webplayer 的显隐开关（`video{opacity:0} video.active{opacity:1}`）：
    //   没有它，片子在播、元素也是满尺寸的，但整页是黑的 —— 看起来像"播放失败"。
    v.classList.add("active");
    v.src = info.url;
    // ★ 2026-10-18：曲子是"演奏录像"，播完必须有下一拍，不能停在那里。
    //   原版 webplayer 播完一场是回到列表；我们是单页内嵌窗口，停住反而像卡死 ——
    //   所以照它同屏循环：`ended` 时从头再来（原版 .player-container 也没有播完态）。
    //   过场片那套（stageCrossFade 的 loop:false + onEnded）是另一条线，与此无关。
    v.loop = PLAY_MODES[playMode].key === "single";
    v.play().catch(() => { /* 需要用户先点一下才出声也没关系 */ });
    // ★ 2026-10-18：正片也要接 ended —— 以前只有过场片接了 ended，
    //   正片播完就停在那儿，要手动点下一首。「播放条」不是这个行为。
    //   顺序 / 列表循环 / 随机都往下走；单曲循环由 loop 属性接管（ended 不会触发）。
    //   ★ 必须先移除上一首挂的监听：v 是常驻元素，重复播放会越挂越多，
    //     播完一次会连跳好几首。
    if (v.__onEndedSong) { v.removeEventListener("ended", v.__onEndedSong); v.__onEndedSong = null; }
    v.__onEndedSong = () => { void advance(); };
    v.addEventListener("ended", v.__onEndedSong);
    writePlayerMeta(info, name);
    paintNowPlaying();
    paintProgress();
    // ★ 原版点一首就直接进全屏演奏页（.player-container 铺满）。我们照做，
    //   但页面里带着「返回」和曲名 —— 原版是独立窗口，我们是内嵌窗口，得有路退出来。
    window.__mailUI?.openPlayer(name);

    player.timer = setInterval(async () => {
      try {
        const cur = await api(`/api/library/play?dir=${encodeURIComponent(dir)}`);
        if (cur.tod !== player.tod && cur.url) {
          crossFadeTo(cur, name);
          player.tod = cur.tod;
          player.warmed = null;
        }
        // 距边界 90 分钟内就开始预热下一时段（本地文件，提前打开省去切档时的黑屏）
        if (!player.warmed && minutesToBoundary() <= 90) await warmNextSlot(player);
      } catch { /* 轮询失败就下一轮再试，不打扰用户 */ }
    }, 30000);

    setSetting2("last_played_title", name);
    // ★ 播放一落库就顺手刷「最近演出」：这一行的时间会从「刚刚」一路走到「n 分钟前」，
    //   页签上的条数也可能因为这首第一次被听而变化。失败不打扰用户（不影响播放本身）。
    api("/api/library/played", { method: "POST", body: { title: name, dir } })
      .then(() => loadRecent())
      .then(() => renderLibTabs())
      .catch(() => {});
    renderSongs();                     // 让正在播的那一行亮起来
    loadImported();
  } catch (error) {
    toast(error.message);
  }
}

/** 右栏上方那条：曲名 + 时段 + 变体数。
 *  ★ info.file 是素材的内部文件名（形如 TOD2000_NI_L.mp4），那是给机器看的，
 *    原样贴出来等于把内部代号丢给用户。只留人话：时段 + 有几个变体。 */
function writePlayerMeta(info, name) {
  const t = $("playerTitle"), s = $("playerSlot");
  if (t) t.textContent = info ? (name ?? "") : "还没有在播";
  if (s) s.textContent = info ? `${info.label} · ${info.variantCount} 个变体` : "点左边任意一首开始";
  // 播放条左栏也走同一份数据，别让它和顶栏显示的曲名对不上
  paintNowPlaying();
  // 顶上那个时段标签跟播放条里的 slot 是同一条信息，这里一并刷新
  const sub = $("pbSlot");
  if (sub) sub.textContent = info ? info.label : "";
}

function crossFadeTo(info, name) {
  const a = $("playVideoA"), b = $("playVideoB");
  const incoming = player.active === "A" ? b : a;
  const outgoing = player.active === "A" ? a : b;
  incoming.src = info.url;
  // 与 play() 一致：单曲循环时才开 loop，其余模式靠 ended 事件往下走
  incoming.loop = PLAY_MODES[playMode].key === "single";
  incoming.play().catch(() => {});
  incoming.classList.remove("under");
  incoming.classList.add("active");
  outgoing.classList.add("under");
  outgoing.classList.remove("active");
  // 转场走完把旧的停掉，别让它继续占解码
  setTimeout(() => outgoing.pause(), 950);
  player.active = player.active === "A" ? "B" : "A";
  writePlayerMeta(info, name);
}

// ---- 演奏页上的控制条（原版那边是 webplayer 独立的 PlaybackView，这里收成一条浮在底部） ----
// ★ 2026-10-18 队列：以前「上一首 / 下一首」永远走 deskSongs（没有就走整个曲库），
//   所以在歌单里点「下一首」会跳到曲库里完全无关的一首去。现在哪来的就从哪走：
//   整夹播放 / 从某个页签点开一首 → 都先把那批顺序塞进 queue，step() 按它走。
//   queue 为空时才退回原来的 deskSongs → allSongs 兜底（直接点播放条时的老行为）。
let queue = [];

/** 设定接下来按什么顺序播。list = [{dir, name}]，at = 从第几首开始（只用于定位当前）。 */
function setQueue(list, at = 0) {
  queue = Array.isArray(list) ? list.filter((s) => s && s.dir).map((s) => ({ dir: s.dir, name: s.name })) : [];
}

function playlist() {
  if (queue.length) return queue;
  // 上一首 / 下一首在"音乐桌面"里走；桌面是空的时候退回到整个曲库，别让按钮点了没反应。
  return deskSongs.length ? deskSongs : allSongs;
}

async function step(delta) {
  const list = playlist();
  if (!list.length) return;
  const at = list.findIndex((s) => s.dir === player.dir);
  // 当前这首不在列表里（比如刚从别处点开）时：从列表头开始，而不是原地打转。
  const base = at < 0 ? (delta > 0 ? -1 : 0) : at;
  let next;
  if (PLAY_MODES[playMode].key === "shuffle" && delta > 0 && list.length > 1) {
    // 随机：从"除了当前这首以外"里挑，避免连点下一首时原地打转。
    const pool = list.filter((s) => s.dir !== player.dir);
    next = pool[Math.floor(Math.random() * pool.length)];
  } else {
    next = list[(base + delta + list.length) % list.length] ?? list[0];
  }
  if (!next) return;
  await play(next.dir, next.name);
}

/** 一首播完自动往下走。
 *  ★ 顺序播放（order）是**唯一**会停住的模式：播到列表最后一首就不再继。
 *    其余三种都该接着来 —— 列表循环回到第一首；单曲循环由 loop 属性接管、根本不会走到这；
 *    随机挑一首不重复的。以前 ended 没人接，所以"顺序播放"看起来和别的模式一样，
 *    只是因为大家都停住了。
 */
async function advance() {
  const mode = PLAY_MODES[playMode].key;
  const list = playlist();
  if (!list.length) return;
  if (mode === "order") {
    const at = list.findIndex((s) => s.dir === player.dir);
    if (at < 0 || at >= list.length - 1) return;   // 最后一首：停住，不放回去
  }
  await step(1);
}

$("pbPlay")?.addEventListener("click", () => {
  const v = activeVideo();
  if (!v || !v.src) {
    const first = playlist()[0];
    if (first) play(first.dir, first.name);
    return;
  }
  if (v.paused) v.play().catch(() => {}); else v.pause();
});
$("pbPrev")?.addEventListener("click", () => step(-1));
$("pbNext")?.addEventListener("click", () => step(1));
// 循环方式：顺序 → 列表循环 → 单曲循环 → 随机，四态轮转。
// ★ 单曲循环靠 video 的 loop 属性落地，不是「播完再 seek(0)」——
//   后者在片尾会有一次到空帧的闪，前者是无缝衔接。
$("pbMode")?.addEventListener("click", (e) => {
  playMode = (playMode + 1) % PLAY_MODES.length;
  const mode = PLAY_MODES[playMode];
  const btn = e.currentTarget;
  btn.innerHTML = mode.icon;
  btn.title = mode.label;
  btn.classList.toggle("is-active", mode.key !== "order");
  const v = activeVideo();
  if (v) v.loop = mode.key === "single";
  toast(mode.label);
});
$("pbMute")?.addEventListener("click", (e) => {
  const v = activeVideo();
  if (!v) return;
  v.muted = !v.muted;
  // ★ 按钮里是内联 SVG，不能再改 textContent（会连 svg 一起抹掉）。
  //   静音态用"喇叭 + 一道斜杠"的 alt 图标整体替换 innerHTML。
  //   （这里不许用 emoji：原版全站零 emoji。）
  const btn = e.currentTarget;
  btn.innerHTML = v.muted
    ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h3l4.5-3.5v13L7 15H4z" fill="currentColor"/><path d="M15.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h3l4.5-3.5v13L7 15H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`;
});

/** 秒 → `m:ss`（原版 x() 就是这个格式：`${M}:${A.padStart(2,"0")}`，
 *  **分钟不补零**。旧版写成 `MM:SS` 两边都补零，跟原版对不上。 */
function mmss(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** 播放条上那排按钮的图标。★ 一律内联 SVG —— 原版全站零 emoji。
 *  播放/暂停要能互换，所以抽成函数而不是写死在 HTML 里。 */
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>`;
/** 四种循环方式（原版 ot 枚举：Repeat / Shuffle / Single / 顺序） */
const PLAY_MODES = [
  { key: "order", label: "顺序播放", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
  { key: "repeat", label: "列表循环", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9a5 5 0 0 1 5-5h9m0 0l-3-3m3 3l-3 3M20 15a5 5 0 0 1-5 5H6m0 0l3 3m-3-3l3-3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
  { key: "single", label: "单曲循环", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9a5 5 0 0 1 5-5h9m0 0l-3-3m3 3l-3 3M20 15a5 5 0 0 1-5 5H6m0 0l3 3m-3-3l3-3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" font-size="8" fill="currentColor" text-anchor="middle">1</text></svg>` },
  { key: "shuffle", label: "随机播放", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h4l12 12h-4M4 18h4L20 6h-4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
];
let playMode = 0;

function paintProgress() {
  const v = activeVideo();
  const fill = $("pbFill"), play = $("pbPlay"), now = $("pbNow"), total = $("pbTime");
  // ★ 元素一起判：只判 pbLine 挡不住后面的裸用 —— 播放条控件缺一个，
  //   timeupdate 每 250ms 抛一次 TypeError，控制台刷屏、进度条也不动。
  if (!v || !$("pbLine") || !fill || !play || !now || !total) return;
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  const pct = dur ? Math.min(100, (v.currentTime / dur) * 100) : 0;
  fill.style.width = `${pct}%`;
  // 原版是**两端各一个时间**（左已播、右总长），不是 `a / b` 拼在一起。
  now.textContent = mmss(v.currentTime || 0);
  total.textContent = mmss(dur);
  // ★ 播放/暂停互换图标走 innerHTML —— 按钮里是 svg，改 textContent 会连 svg 一起抹掉。
  play.innerHTML = v.paused ? ICON_PLAY : ICON_STOP;
}

/** 播放条左栏（封面 + 曲名 + 时段）跟着当前曲目刷新。
 *  封面没有图，用曲名首字充数 —— 跟曲库里 .song-item-icon 同一套口径。 */
function paintNowPlaying() {
  const st = player;
  const name = st?.name || "";
  const el = $("pbName"), sub = $("pbSlot"), cover = $("pbCoverText");
  if (el) {
    el.textContent = name || "还没有播放";
    // 名字装得下就别跑马灯（一直晃是噪音）。装不下才开动画。
    el.style.animation = name && name.length > 26 ? "" : "none";
  }
  if (sub) sub.textContent = st?.slot ? `第 ${st.slot} 档` : "";
  if (cover) cover.textContent = (name.trim().charAt(0) || "♪").toUpperCase();
}
// ★ 这里以前写 ["vA","vB"]，而页面上的 id 是 stageVideo/stageVideoB —— 取到 null，
//   进度条与按钮状态从来没更新过。现在统一走 playVideoA/playVideoB（演奏页那两枚）。
for (const id of ["playVideoA", "playVideoB"]) {
  const v = $(id);
  v?.addEventListener("timeupdate", () => { if (v === activeVideo()) paintProgress(); });
  v?.addEventListener("loadedmetadata", () => { if (v === activeVideo()) paintProgress(); });
  v?.addEventListener("play", () => { if (v === activeVideo()) paintProgress(); });
  v?.addEventListener("pause", () => { if (v === activeVideo()) paintProgress(); });
}

/** 提前把下一时段的文件交给一个隐藏 video 预热（不显示、不出声）。 */
async function warmNextSlot(st) {
  const order = ["TOD12", "TOD1730", "TOD20"];
  const next = order[(order.indexOf(st.tod) + 1) % order.length];
  try {
    const info = await api(`/api/library/play?dir=${encodeURIComponent(st.dir)}&tod=${next}`);
    if (!info.url || info.tod === st.tod) return;
    const warm = document.createElement("video");
    warm.preload = "auto";
    warm.muted = true;
    warm.style.display = "none";
    warm.src = info.url;
    document.body.appendChild(warm);
    st.warmed = { el: warm, tod: info.tod };
  } catch { /* 预热失败不影响正常切换 */ }
}

function setSetting2(key, value) { try { localStorage.setItem(key, value); } catch { /* 无痕模式下忽略 */ } }

$("saveLibraryDir")?.addEventListener("click", async () => {
  try {
    await api("/api/library/dir", { method: "POST", body: { dir: $("libraryDir").value.trim() } });
    toast("已保存");
    await loadLibrary();
  } catch (error) {
    toast(error.message);
  }
});

$("importRandom")?.addEventListener("click", async () => {
  const btn = $("importRandom");
  if (btn) { btn.disabled = true; btn.textContent = "入库中……"; }
  try {
    const data = await api("/api/library");
    const songs = data.songs ?? [];
    if (!songs.length) return toast(codeText("这个目录下没有曲目", "LIBRARY_SONG_NOT_FOUND"));
    const pick = songs[Math.floor(Math.random() * songs.length)];
    await api("/api/library/import", { method: "POST", body: { dir: pick.dir } });
    toast(`已入库：${pick.name}`);
    await loadImported();
    renderSongs();
  } catch (error) {
    toast(error.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "随机入库"; }
  }
});

// ---------------------------------------------------------------- 记忆

const LEDGER_ORDER = [
  "关系", "关系依据", "已承认情感", "已承认称呼", "既有亲密", "既有边界",
  "亲密上限", "本封亲密判定", "说话者", "未决", "摘要待核实", "事实伪造", "结论",
];

async function loadMemory() {
  try {
    const data = await api("/api/memory");
    const entries = Object.entries(data.ledger ?? {});
    const dl = $("ledger");
    if (!entries.length) {
      dl.innerHTML = "";
      $("ledgerEmpty").style.display = "block";
    } else {
      $("ledgerEmpty").style.display = "none";
      const ordered = [...entries].sort((a, b) => {
        const ia = LEDGER_ORDER.indexOf(a[0]);
        const ib = LEDGER_ORDER.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      dl.innerHTML = ordered.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || "—")}</dd>`).join("");
    }
    $("ctx").textContent = data.context ?? "";
  } catch (error) {
    toast(error.message);
  }
}

// ---------------------------------------------------------------- 从旧程序搬信进来（.soul 导入）
//
// 两步走：先预览、再确认。★ 预览**一行都不写库** —— 数字先给他看清楚，他说了才动刀。
// 预览只存在服务端内存里（30 分钟），所以中间重启或过期就会报 IMPORT_PREVIEW_STALE，
// 这时候唯一的正确动作是让他重新选一次文件（不是我们偷偷重试）。
let soulPreviewId = null;

function setSoulState(text) { const el = $("soulState"); if (el) el.textContent = text; }

/**
 * 预览：把选中的 .soul **原样 POST 上去**。
 *
 * ★ 不能走 api()：那个封装只发 JSON（body 会被 JSON.stringify 成字符串）。
 * ★ 也**不许**先 file.arrayBuffer() 再发 —— .soul 可能上 GB，读进内存会当场把页面搞死。
 *   File 自己就是 Blob，直接当 fetch body 是流式上传，内存里只有一块缓冲区。
 *   （上面 importFontBytes 读进内存是另一回事：字体就几 MB，且服务端要算魔数。）
 * ★ 令牌要手动带：服务端那道令牌闸对所有写操作一视同仁，漏了就是 403。
 */
async function previewSoul(file) {
  soulPreviewId = null;
  if ($("soulConfirm")) $("soulConfirm").disabled = true;
  if ($("soulPick")) $("soulPick").disabled = true;
  setSoulState(`正在读「${file.name}」……大文件要等一会儿`);
  try {
    const token = await ensureToken();
    const response = await fetch("/api/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Linli-Token": token },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    // 服务端的中文已经是「哪句话不对（错误号）」，原样上屏，不再拼一次。
    if (!response.ok) throw new Error(payload.error ?? `这个文件读不出来（${response.status}）`);

    const { counts, total, noDateCount, note } = payload;
    let text = `文件里共 ${total} 组往来：新增 ${counts.added}、库里已有 ${counts.skipped}、文件内重复 ${counts.conflicts}`;
    // 缺日期只在真有的时候才提 —— 一个都没有就别拿这句话吓人。
    // ★ 不说「排在最早」：服务端兜底是 base - (len - index)，它们只是按文件里的先后顺序挨着排下来，
    //   日期是占位不是真实时间。说成真实顺序就是在骗人。
    if (noDateCount > 0) text += `；其中 ${noDateCount} 组文件里没写日期，只能按先后顺序排`;
    if (note) text += `；${note}`;
    if (counts.added === 0) {
      // ★ added === 0 就不给确认按钮：预览已经把「一封都不用写」摆明了，
      //   再让他点一次确认，只会换来一次备份 + 0 封写入，纯属白折腾。
      text += "；没有要新增的 —— 这份文件里的信，库里都已经有了。";
    } else {
      soulPreviewId = payload.previewId;
    }
    setSoulState(text);
  } catch (error) {
    setSoulState(error.message);
  } finally {
    if ($("soulPick")) $("soulPick").disabled = false;
    if ($("soulConfirm")) $("soulConfirm").disabled = !soulPreviewId;
  }
}

/** 确认：这一步是普通 JSON（body 里只有预览号），令牌交给 api() 带。 */
async function confirmSoul() {
  if (!soulPreviewId) return;
  const id = soulPreviewId;
  if ($("soulConfirm")) $("soulConfirm").disabled = true;
  if ($("soulPick")) $("soulPick").disabled = true;
  setSoulState("正在写进库……");
  try {
    const result = await api("/api/import/confirm", { method: "POST", body: { previewId: id } });
    soulPreviewId = null;      // 一份预览只能用一次，服务端那边也是 take（取走就不再复用）
    let text = `已写入 ${result.written} 封`;
    // ★ 预览是某一刻的快照，落库那刻的库可能已经变了（同一份文件确认过两次就会这样）
    //   ⇒ 有就如实报，不假装全都写进去了。
    if (result.staleSkipped > 0) text += `（确认前已入库 ${result.staleSkipped} 封，没重复写）`;
    if (result.note) text += `；${result.note}`;
    if (result.backup) text += `；落库前的备份：${result.backup}`;
    setSoulState(text);
    // 搬完立刻刷这两处：信箱本来就是 5 秒一次轮询，但用户刚点完就该看见。
    await loadLetters();
    await loadMemory();
    toast(`已搬进 ${result.written} 封`);
  } catch (error) {
    // ★ 两种号必须让用户重选文件，不能让他一直点确认：
    //   410 预览已过期/已用过；500 备份失败时预览也已经被 take 走了（服务端先取预览、再备份）。
    //   其余（比如网络断了）预览号可能还在 ⇒ 留着，重试一次是合理的。
    if (error.code === "IMPORT_PREVIEW_STALE" || error.code === "IMPORT_BACKUP_FAILED") soulPreviewId = null;
    setSoulState(error.message);
  } finally {
    if ($("soulPick")) $("soulPick").disabled = false;
    if ($("soulConfirm")) $("soulConfirm").disabled = !soulPreviewId;
  }
}

$("soulPick")?.addEventListener("click", () => $("soulFile")?.click());
$("soulConfirm")?.addEventListener("click", () => { void confirmSoul(); });
$("soulFile")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";       // 清掉，允许再选同一个文件（跟 fontFile 那处一个道理）
  if (!file) return;
  void previewSoul(file);
});

// ---------------------------------------------------------------- 设置

// 2026-10-13 核对过一轮（1.0.0 那版写的是 deepseek-chat / glm-4.6 / kimi-k2-0905，
// 全是过时编号；deepseek-chat 与 deepseek-reasoner 官方已在 2026-07-24 退役）。
// 型号会一直变，所以这里是「候选 + 可自己填」，不是写死一个。
const PROVIDER_PRESETS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4"],
    note: "deepseek-chat / deepseek-reasoner 已退役，别再填。",
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1"],
    note: "开放平台与 Z.ai 的编号节奏不同，以你的控制台为准。",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"],
    note: "国际区用 api.moonshot.ai。",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.7-plus", "qwen3.6-plus", "qwen-plus"],
    note: "阿里云百炼；新加坡、美国与 Coding Plan 是不同地址。",
  },
  minimax: {
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M3", "MiniMax-M2.7"],
    note: "型号以官方控制台为准。",
  },
  custom: {
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    note: "本地 / 中转：自己填地址和模型名。",
  },
};

function fillModelList(provider) {
  const list = document.getElementById("modelList");
  const preset = PROVIDER_PRESETS[provider];
  if (!list || !preset) return;
  list.innerHTML = (preset.models ?? []).map((m) => `<option value="${m}"></option>`).join("");
}

async function loadSettings() {
  try {
    const model = await api("/api/model");
    $("provider").value = model.provider ?? "deepseek";
    $("baseUrl").value = model.baseUrl ?? "";
    $("modelName").value = model.model ?? "";
    $("apiKey").value = "";
    $("apiKey").placeholder = model.hasKey ? "已保存（DPAPI 加密），留空表示不修改" : "还没有填写";
    $("modelState").textContent = model.hasKey ? "Key 已保存" : "还没有 Key";

    const data = await api("/api/proactive");
    const s = data.settings;
    $("pEnabled").value = s.enabled ? "1" : "0";
    $("pStart").value = s.windowStart;
    $("pEnd").value = s.windowEnd;
    $("pGap").value = s.minGapHours;
    $("pDay").value = s.maxPerDay;
    $("pWeek").value = s.maxPerWeek;
    // ★ 用 trigger.label（人话），不要 trigger.kind —— 那是内部代号，
    //   原样渲染出来会变成「现在可以写（song_played）」。
    $("proactiveVerdict").textContent = data.verdict?.ok
      ? `现在可以写：由头是「${data.verdict.trigger?.label ?? "她惦记着一件小事"}」`
      : `现在不发：${data.verdict?.reason ?? ""}`;
    // ★ T9 近况层：勾选状态与文案都从服务端（真源）来 —— 界面不写死键名与文案。
    const nt = data.nearTerm;
    if (nt) {
      $("proactiveKeepShape").checked = !!nt.on;
      $("proactiveKeepShapeLabel").textContent = nt.label || "保持她现在的样子";
      $("proactiveKeepShape").disabled = nt.enabled === false;
    }
    maybeAskProactive(data.shouldAsk);
    fillAbout();
    void refreshFont();     // 顺带把「信件字体」那张卡片刷新（不再弹引导窗）
    void refreshIdle();     // 顺带把「待机」那张卡片刷新（场景/状态、素材在不在）
    // ★ 数据备份那张卡必须在这里刷：不刷的话，首屏停在 HTML 里写死的
    //   「正在读取备份列表……」—— 用户看到的是一条永远不动的占位文字，
    //   只有点了某个按钮才会变（实测过：点「现在备份一份」之后才突然正确）。
    void dsLoad();
  } catch (error) {
    toast(error.message);
  }
}

/** 设置页「关于」那块的数据目录 —— 空着就等于"我说在本机，你信我"，填出来才算是凭据。 */
async function fillAbout() {
  const el = $("dataDir");
  if (!el) return;
  try {
    const a = await api("/api/about");
    el.textContent = `版本 ${a.version} ｜ 数据目录：${a.dataDir}`;
    el.title = `信件与记忆都写在 ${a.dataDir}；曲库读的是 ${a.libraryDir}`;
  } catch { /* 探不到就不写，别在这块弹错打扰用户 */ }
}

// ---------------------------------------------------------------- 待机
//
// ★ 状态行要说清两件事：现在用的是哪一套（场景/状态），以及素材到底在不在。
//   素材不在（比如打包时漏拷了 assets\）就直说"没找到待机素材" ——
//   别让用户以为"没曲子时桌面就该是空的"，那其实是一个可以修的毛病。
async function refreshIdle() {
  const box = $("idleState"), toggle = $("idleAmbience");
  if (!box && !toggle) return;
  try {
    const s = await api("/api/idle/settings");
    if (toggle) toggle.checked = Boolean(s.ambience);
    if (box) {
      // ★ 2026-10-15 改：A/R3 是**我们自己挑素材用的变量**（原版根本没有这套规则，
      //   服务端注释里也承认），不该摆到用户面前 —— 人看不懂，也不需要看。
      box.textContent = s.hasAssets
        ? `现在放的是：${s.label}的画面` + (s.ambienceAssets ? "，带背景音" : "（环境音素材缺失）")
        : "没找到待机素材 —— 曲库为空时桌面上不会有画面。";
    }
  } catch (error) {
    if (box) box.textContent = `待机设置读取失败：${error.message}`;
  }
}

$("idleAmbience")?.addEventListener("change", async (e) => {
  try {
    await api("/api/idle/settings", { method: "POST", body: { ambience: e.target.checked } });
    toast(e.target.checked ? "待机环境音已开" : "待机环境音已关");
    await refreshIdle();
  } catch (error) {
    toast(error.message);
  }
});

// ---------------------------------------------------------------- 信件字体
//
// ★ 这一版**不再"检测系统字体"**了。上一版是拿像素比去找用户系统里装的那一支
//   （SentyTEA / HanyiSentyTea…）；现在字体由用户自己从官网下、再从界面上导进来，
//   存在**本程序的数据目录**里（见 server.mjs 的 /api/font/*），由服务端说了算。
//   为什么不随包、为什么不装进系统：见 styles.css 顶部「信件字体」那段。
// ★ 前端要做的三件事：① 问服务端有没有；② 有就声明 @font-face 并把 --letter-font
//   换过去；③ 没有就引导用户导一份（弹窗 + 文件选择）。
// ★★ 两支字体（2026-10-15 补上第二支）—— 原版就是两支，各管一档，不能混用：
//   读自原版 assets/index-9ba3e01a.css（它只有 2 条 @font-face）。
//   ① letter  = **林离写的信**：读信正文 `.mail-envelope__letter-text`（20px/行高1.5）
//                                和她的回信 `.mail-box-reply-content-*` ⇒ 新蒂**下午茶体** SentyTEA
//   ② compose = **你自己写信**时那个输入框 `.mail-box-write-content` / `-dialog-content`
//                                ⇒ 新蒂**花园体** HanyiSentyGarden（漢儀新蒂花園體）
//   ★ 程序界面（按钮/列表/设置）用的是**系统 UI 字体栈**，跟这两支都无关 ——
//     原版界面名义上写的是阿里巴巴普惠体，但那支字体游戏包里没有、系统里也没有，
//     真机本来就在回退到系统栈。所以界面那档**不需要下载任何字体**。
const FONT_SLOTS = [
  { slot: "letter", face: "LinliLetter", cssVar: "--letter-font",
    what: "林离写的信（读信正文、她的回信）", font: "新蒂下午茶体 SentyTEA",
    // 官网直达页（个人非商业免费）。
    page: "https://www.sentyfont.com/sentytea.htm" },
  { slot: "compose", face: "LinliCompose", cssVar: "--compose-font",
    what: "你自己写信时那个输入框", font: "新蒂花园体 HanyiSentyGarden（漢儀新蒂花園體）",
    // ★ 官网的字体页是脚本渲染的列表，花园体在「手写字体 Handwriting」分类里，
    //   没有稳定的直达子页 ⇒ 给官网首页 + 字体全名，不给一个可能失效的深链。
    //   ★ 不写任何第三方"字体下载站"：那些站基本都是未授权分发，还常捆绑广告软件。
    page: "https://www.sentyfont.com/" },
];
// @font-face 的族名**全部是我们自己起的名**，不叫 "SentyTEA" / "HanyiSentyGarden" ——
// 不能去声明一个跟系统字体同名的族，那会盖住用户系统里真正装的那一份。
const LETTER_FACE = "LinliLetter";
// "关掉就算问过了"记在这里 —— 只在还没导入时问一次，别每次启动都弹。
const FONT_ASKED_KEY = "font_intro_asked";

let fontStatusCache = null;
let letterFallback = null;

/**
 * 楷体那一串兜底，**从 CSS 的 --letter-font 里原样取一次**再缓存。
 * ★ 不在这里手抄一份：CSS 改了兜底、这里没改，两边就对不上了。
 * ★ 必须在第一次注入 @font-face 之前取 —— 注入后这个变量会被我们覆盖掉。
 */
const FALLBACK_CACHE = new Map();
function fallbackStack(cssVar) {
  if (FALLBACK_CACHE.has(cssVar)) return FALLBACK_CACHE.get(cssVar);
  let v = "";
  try { v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim(); } catch { /* 拿不到就用下面这句 */ }
  const stack = v || '"KaiTi", "楷体", serif';
  FALLBACK_CACHE.set(cssVar, stack);
  return stack;
}

/** 声明某一槽的 @font-face（走本机服务 /api/font/file?slot=…）并把队首换成它。 */
function applyFont(cfg) {
  const id = `fontFace-${cfg.slot}`;
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `@font-face{font-family:"${cfg.face}";src:url("/api/font/file?slot=${cfg.slot}") format("truetype");font-display:swap}`;
    document.head.appendChild(style);
  }
  // ★ 用行内 style 改：命中优先级高于 CSS 的 :root，不必跟样式表的写法较劲。
  document.documentElement.style.setProperty(cfg.cssVar, `"${cfg.face}", ${fallbackStack(cfg.cssVar)}`);
}

/** 撤回注入 —— CSS 的 :root 那条兜底还在，于是自然退回楷体。 */
function clearFont(cfg) {
  document.getElementById(`fontFace-${cfg.slot}`)?.remove();
  document.documentElement.style.removeProperty(cfg.cssVar);
}

/** 设置页那张卡片：两支各一行，各自的状态、导入按钮、下载地址。 */
function renderFontCard(all = fontStatusCache) {
  for (const cfg of FONT_SLOTS) {
    const st = (all && all[cfg.slot]) || { ok: false };
    const state = $(`fontState-${cfg.slot}`), imp = $(`fontImport-${cfg.slot}`);
    const dl = $(`fontDownload-${cfg.slot}`), url = $(`fontUrl-${cfg.slot}`);
    if (!state) continue;
    if (st.ok) {
      const mb = st.bytes ? `（${(st.bytes / 1024 / 1024).toFixed(1)} MB）` : "";
      state.textContent = `已导入「${st.family ?? cfg.face}」${mb} —— 这一档的字迹跟原版一致。`;
      state.title = "字体只存在本程序的数据目录里，没有装进你电脑的系统字体。";
    } else {
      state.textContent = `还没导入 —— ${cfg.what}现在退回系统楷体。`;
      state.title = "";
    }
    if (imp) imp.hidden = Boolean(st.ok);
    if (dl) dl.hidden = Boolean(st.ok);
    if (url) {
      url.hidden = Boolean(st.ok);
      // ★ 把网址明文写出来：这是本程序里唯一一处"对外"，得让用户看得见去哪儿。
      if (!st.ok) url.textContent = `要下的字体：${cfg.font}　官网（个人非商业免费）：${cfg.page}`;
    }
  }
}

/** 问一次服务端、按结果注入或撤回字体，再把卡片刷新一遍。
 *  ★ 原来这里还负责"本次会话第一次刷新时自动弹引导窗"，2026-10-18 取消了
 *    （理由见下面 renderFontCard 之后那段注释）。ask 参数保留着，
 *    现在没有调用方传它 —— 留着是为了以后做「点这里补上字体」的显式入口，
 *    而不是让启动流程再去拦人。
 */
async function refreshFont() {
  let all = { letter: { ok: false }, compose: { ok: false } };
  try { all = await api("/api/font/status"); } catch { /* 拿不到就按"两支都不在"渲染 */ }
  fontStatusCache = all;
  for (const cfg of FONT_SLOTS) {
    const st = all[cfg.slot];
    if (st && st.ok) applyFont(cfg); else clearFont(cfg);
  }
  renderFontCard(all);
  // ★ 不再自动弹引导窗（2026-10-18 改）。
  //   原来两支都没导入时会在启动后弹一个居中的模态框 —— 实测它正好盖住信箱页，
  //   用户一打开程序看到的就是「字体缺失」而不是信。字体缺失是**可选优化**，
  //   不是使用前提（缺了退回系统楷体，程序照常能用），所以不该用模态框拦人。
  //   现在只在设置页那张字体卡里写清楚缺什么、去哪儿下 —— 用户想装自然会去看。
  //   __maybeAskFont 仍然保留，改成只能被显式调用（比如以后做「点这里补上字体」的入口）。
  return all;
}

// ★ 前端这一侧也要**独立**校验一次白名单，不能只信外壳：
//   ① 浏览器里没有外壳通道（壳没起来 / 用浏览器开着调试页），走 window.open 兜底 —— 那条路
//      完全在外壳管控之外，天然拿不到白名单保护；
//   ② 页面本身由本机服务吐出，万一被注入，攻击者改不了外壳里的 AllowedExternalHosts，
//      但改得了这里传进去的字符串 —— 两边各校验一次，任何一侧失守都不会把 ShellExecute 交出去。
// ★ 与 src/LinliShell/MainWindow.cs 的 AllowedExternalHosts 必须保持一致（改一处就要改两处）。
const ALLOWED_EXTERNAL_HOSTS = Object.freeze([
  "sentyfont.com", "www.sentyfont.com",
  "hanyi.com.cn", "www.hanyi.com.cn",
]);

/** 网址是否在「允许用系统浏览器打开」的白名单里：必须 https，且主机名精确命中。 */
function externalUrlAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;   // 挡掉 file: / javascript: / 自定义协议
  return ALLOWED_EXTERNAL_HOSTS.includes(u.hostname.toLowerCase());
}

/** 打开外部网址。外壳里走 C# 那条通道（那边有域名白名单）；浏览器里直接开新标签。 */
function openExternal(url) {
  if (!externalUrlAllowed(url)) {
    // 不静默失败：白名单外的网址多半是配置写错了，直接提示，免得用户点了没反应还不知道为什么。
    toast(codeText("这个网址不在允许打开的名单里", "COMMON_EXTERNAL_URL_NOT_ALLOWED"));
    return;
  }
  const host = window.chrome && window.chrome.webview;
  if (host) {
    try { host.postMessage("open:" + url); return; } catch { /* 通道断了就走下面的兜底 */ }
  }
  try { window.open(url, "_blank", "noopener"); } catch { /* 弹窗被拦，网址已经写在页面上了 */ }
}

// 隐藏的那个 file input 是两支共用的 ⇒ 点"导入"时先记下是哪一支，change 里再取用。
let pendingFontSlot = "letter";
function pickFontFile(slot) { pendingFontSlot = slot; $("fontFile")?.click(); }

/**
 * 把用户选中的字体原始字节 POST 上去。
 * ★ 不能走 api()：那个封装只发 JSON（body 会被 JSON.stringify）。
 *   这里要发的是一坨二进制，所以自己 fetch，并**手动带上会话令牌** ——
 *   服务端那道令牌闸对所有写操作一视同仁，漏了就是 403。
 */
async function importFontBytes(file, slot = "letter") {
  const token = await ensureToken();
  const buf = await file.arrayBuffer();
  const response = await fetch(`/api/font/import?slot=${encodeURIComponent(slot)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Linli-Token": token },
    body: buf,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `导入失败（${response.status}）`);
  return payload;
}

// 两支各绑一套「导入 / 去官网下载」。
for (const cfg of FONT_SLOTS) {
  $(`fontImport-${cfg.slot}`)?.addEventListener("click", () => pickFontFile(cfg.slot));
  // 「去官网下载」：★ 只有用户**点了**才会对外。程序自己不发任何网络请求。
  $(`fontDownload-${cfg.slot}`)?.addEventListener("click", () => openExternal(cfg.page));
}
$("fontRecheck")?.addEventListener("click", () => {
  void refreshFont().then((all) => {
    const n = FONT_SLOTS.filter((c) => all[c.slot]?.ok).length;
    toast(n === FONT_SLOTS.length ? "两支字体都在，字迹跟原版一致。"
      : n === 0 ? "两支都还没导入 —— 现在都用系统楷体。"
      : `已导入 ${n}/${FONT_SLOTS.length} 支 —— 缺的那支现在用楷体。`);
  });
});
$("fontFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";       // 清掉，允许再选同一个文件
  if (!file) return;
  const cfg = FONT_SLOTS.find((c) => c.slot === pendingFontSlot) ?? FONT_SLOTS[0];
  try {
    const st = await importFontBytes(file, cfg.slot);
    await refreshFont();
    toast(st.ok ? `「${cfg.what}」这支已经导入 —— 字迹换过来了。`
      : codeText("导入成功，但没能从文件里读出字体名", "FONT_NAME_UNREADABLE"));
  } catch (error) {
    toast(error.message);
  }
});

// ---------------------------------------------------------------- 导入字体的引导弹窗
//
// ★ 只在「还没导入」时自动弹**一次**（关掉也算问过，记在 localStorage）。
//   每次启动都弹比不弹还烦人 —— 跟主动来信那个「只问一次」是同一个口径。
// ★ 结构照抄 #legalModal / #introModal，天然就是那套液态玻璃，不另写样式。
(function fontModal() {
  const modal = $("fontModal");
  if (!modal) return;
  let lastFocus = null;
  const asked = () => { try { return localStorage.getItem(FONT_ASKED_KEY) === "1"; } catch { return false; } };
  const markAsked = () => { try { localStorage.setItem(FONT_ASKED_KEY, "1"); } catch { /* 无痕模式下忽略 */ } };

  function close() {
    modal.hidden = true;
    markAsked();                    // ★ 关掉就算问过了：下次不再自动弹
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  window.__maybeAskFont = (ok) => {
    if (ok || !modal.hidden || asked()) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    $("fontPick")?.focus();         // 焦点落在主按钮上（无障碍）
  };
  // 弹窗里只导入"林离写的信"那支（它是主要的一支）；另一支在设置页那张卡片上单独导入。
  $("fontPick")?.addEventListener("click", () => { close(); pickFontFile("letter"); });
  $("fontPage")?.addEventListener("click", () => { close(); openExternal(FONT_SLOTS[0].page); });
  $("fontLater")?.addEventListener("click", () => close());
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });
})();

// ---------------------------------------------------------------- 第一次打开时的询问弹窗
//
// ★ 用户 2026-10-14 定：主动来信**默认开启** ⇒ 这个弹窗问的不是"要不要打开"，
//   而是「确认 / 关掉」—— 告知一次她会在什么时候写信、有多克制，顺便给一次反悔的机会。
//   ⇒ 点"好，就让她这样" ⇒ 保持开着；点"先不用，关掉吧" / Esc / 遮罩 ⇒ 关掉。
// ★ 只问一次：以上每一种都算答过（asked=true），不再天天问。
(function introAsk() {
  const modal = $("introModal");
  if (!modal) return;
  let lastFocus = null;
  let answered = false;

  function close() {
    modal.hidden = true;
    // ★ 关掉也算答过：不然每开一次问一次，比不写信还烦人。
    if (!answered) send(false);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  async function send(yes) {
    answered = true;
    try {
      await api("/api/proactive", { method: "POST", body: { enabled: yes, asked: true } });
      await loadSettings();
      toast(yes ? "她会偶尔给你写信 —— 随时可以在设置里关掉。" : "已经关掉了，她只会在你先写信时回信。");
    } catch (error) {
      toast(error.message);
    }
  }
  window.__maybeAskProactive = (shouldAsk) => {
    if (!shouldAsk || !modal.hidden) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    $("introYes")?.focus();
  };
  // ★ 走 close() 而不只是 hidden=true：close() 会顺便把焦点还回去。
  //   send() 一进来就把 answered 置 true（同步），所以 close() 不会再补发一次。
  $("introYes")?.addEventListener("click", () => { void send(true); close(); });
  $("introNo")?.addEventListener("click", () => { void send(false); close(); });
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });
})();

function maybeAskProactive(shouldAsk) {
  window.__maybeAskProactive?.(shouldAsk);
}

// ---------------------------------------------------------------- 弹窗的液态玻璃高光
//
// ★ 配方跟 design-preview 第 2 节一致：高光斑跟着指针走。
//   CSS 里写的默认值 --mx:22% / --my:6% 就是"指针还没进来"的样子（跟飞机版一样钉在左上）。
// ★ 每个 .modal-box 各自记自己的高光位置，所以上一次弹窗的指针位置不会串到下一个弹窗上。
(function glassHighlight() {
  for (const box of document.querySelectorAll(".modal-box")) {
    box.addEventListener("pointermove", (e) => {
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height) return;
      box.style.setProperty("--mx", `${Math.round((e.clientX - r.left) / r.width * 1000) / 10}%`);
      box.style.setProperty("--my", `${Math.round((e.clientY - r.top) / r.height * 1000) / 10}%`);
    });
  }
})();

$("provider").addEventListener("change", () => {
  const preset = PROVIDER_PRESETS[$("provider").value];
  if (!preset) return;
  fillModelList($("provider").value);
  if (!$("baseUrl").value.trim() || confirm("用这个服务商的默认接口地址覆盖当前填写？")) {
    $("baseUrl").value = preset.baseUrl;
  }
  if (preset.models?.length && !preset.models.includes($("modelName").value.trim())) {
    $("modelName").value = preset.models[0];
  }
  $("modelState").textContent = preset.note ?? "";
});

$("saveModel").addEventListener("click", async () => {
  const patch = {
    provider: $("provider").value,
    baseUrl: $("baseUrl").value.trim(),
    model: $("modelName").value.trim(),
  };
  const key = $("apiKey").value;
  if (key) patch.apiKey = key;
  try {
    const { model } = await api("/api/model", { method: "POST", body: patch });
    $("apiKey").value = "";
    $("apiKey").placeholder = model.hasKey ? "已保存（DPAPI 加密），留空表示不修改" : "还没有填写";
    $("modelState").textContent = model.hasKey ? "Key 已保存" : "还没有 Key";
    toast("已保存");
  } catch (error) {
    toast(error.message);
  }
});

$("testModel").addEventListener("click", async () => {
  const btn = $("testModel");
  btn.disabled = true;
  btn.textContent = "测试中……";
  try {
    const result = await api("/api/model/test", { method: "POST" });
    toast(result.ok ? `通了：${result.sample ?? ""}` : `不通：${result.error}`);
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连通性";
  }
});

$("saveProactive").addEventListener("click", async () => {
  // ★ 2026-10-15 修（审核）：`Number("") === 0` 且 `Number.isFinite(0)` 为真 ⇒
  //   以前清空输入框送上去的是 **0**，不是兜底值。7 天最多 = 0 时判据
  //   `已发 >= 上限` 恒真 ⇒ 主动来信**静默永久关停**，用户还以为是自己没配置对。
  const num = (id, fallback) => {
    const raw = String($(id).value ?? "").trim();
    if (raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const patch = {
    enabled: $("pEnabled").value === "1",
    windowStart: $("pStart").value.trim() || "09:00",
    windowEnd: $("pEnd").value.trim() || "21:30",
    minGapHours: num("pGap", 20),
    maxPerDay: num("pDay", 1),
    // ★ 兜底值必须和 core.mjs 的 PROACTIVE_DEFAULTS.maxPerWeek（4）一致 ——
    //   输入框被清空时走的就是这个兜底，写 3 会把"7 天 4 封"悄悄改回 3 封。
    maxPerWeek: num("pWeek", 4),
    // ★ T9 近况层开关（键名 keepCurrentShape ↔ 真源 nearTerm.userToggle.key）。
    keepCurrentShape: $("proactiveKeepShape").checked,
  };
  try {
    await api("/api/proactive", { method: "POST", body: patch });
    toast("已保存");
    await loadSettings();
  } catch (error) {
    toast(error.message);
  }
});

$("checkProactive").addEventListener("click", async () => {
  const btn = $("checkProactive");
  btn.disabled = true;
  btn.textContent = "判断中……";
  try {
    const result = await api("/api/proactive/check", { method: "POST", body: {} });
    toast(result.sent ? "她写了一封新的" : `没写：${result.reason}`);
    await loadLetters();
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "现在判断一次";
  }
});

// ---------------------------------------------------------------- 液态玻璃交互
// 与设计预览（design-preview.html ② 节）同一套：指针位置 → 高光跟着走；
// 进入 → 扫一道光；按下 → 从指针位置散两层涟漪。**参数全在 styles.css 里**，这里只管接线。
// ★ 三处不能改：
//   ① 用 pointerdown 不是 click —— 按下那一刻就要有反馈，等到 click 就晚了半拍；
//   ② 进入时要先 remove 再 void offsetWidth 再 add —— 不强制重排，第二次进入不会重放动画；
//   ③ 涟漪用完后要 remove —— 不删的话连点十次就是十个 span 挂在按钮里。
(function enableGlass() {
  function upgrade(el) {
    if (el.dataset.glass === "1") return;
    el.dataset.glass = "1";
    const sheen = document.createElement("span");
    sheen.className = "sheen";
    el.appendChild(sheen);

    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
      el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
    });
    el.addEventListener("pointerenter", () => {
      el.classList.remove("sheen-on");
      void el.offsetWidth;                       // 强制重排，否则连续进入不放第二遍
      el.classList.add("sheen-on");
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const big = Math.max(r.width, r.height) * 2.1;
      [[big, "ripple"], [big * 1.5, "ripple two"]].forEach(([size, cls]) => {
        const d = document.createElement("span");
        d.className = cls;
        d.style.width = d.style.height = size + "px";
        d.style.left = x + "px";
        d.style.top = y + "px";
        el.appendChild(d);
        setTimeout(() => d.remove(), 1000);
      });
    });
  }

  // 信件/曲目/已导入里的按钮都是**动态渲染**出来的 ⇒ 每次 DOM 变了都要再扫一遍。
  // dataset.glass 的守卫保证幂等，所以重复扫不会重复接线。
  // ★ 排除 .lnk（协议那行小链接）：它要的是"低对比、不抢版面"，
  //   套上跟随高光反而把它变成视觉焦点，跟放这行字的用意相反。
  const SELECTOR = "button:not(.lnk), .rb";
  function scan() {
    document.querySelectorAll(SELECTOR).forEach(upgrade);
  }
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();

// ---------------------------------------------------------------- 协议弹层
//
// 正文来自 legal.js（由仓库根的 协议.txt 生成），HTML 里一个字都不抄 ——
// 抄一份就有两处会各改各的，而"设置页里看到的"和"安装时同意的"必须是同一份。
(function legalModal() {
  const modal = document.getElementById("legalModal");
  const titleEl = document.getElementById("legalTitle");
  const bodyEl = document.getElementById("legalBody");
  const hintEl = document.getElementById("legalHint");
  if (!modal || !titleEl || !bodyEl || !window.LEGAL) return;
  const L = window.LEGAL;
  // 正文在 协议.txt 里是缩进过的（给人读的排版），进 DOM 前把公共缩进去掉
  const dedent = (s) => String(s ?? "").replace(/^ {4}/gmu, "");
  // 隐私政策 = 数据在哪 / 唯一的对外连接 / 卸载会留下什么 —— 这三条才是"隐私"要回答的
  const PRIVACY = ["一、", "二、", "六、"];
  const pick = (keys) => L.sections.filter((s) => keys.some((k) => s.head.startsWith(k)));

  let lastFocus = null;
  function render(which) {
    const isPrivacy = which === "privacy";
    const secs = isPrivacy ? pick(PRIVACY) : L.sections;
    titleEl.textContent = isPrivacy ? "隐私政策" : L.title;
    bodyEl.textContent = "";
    const lead = document.createElement("p");
    lead.className = "lead";
    lead.textContent = L.lead;
    bodyEl.appendChild(lead);
    for (const s of secs) {
      const h = document.createElement("h4");
      h.textContent = s.head;
      bodyEl.appendChild(h);
      if (s.body) {
        const p = document.createElement("p");
        p.textContent = dedent(s.body);       // textContent：正文里的 %APPDATA%、< > 都当字面量
        bodyEl.appendChild(p);
      }
    }
    if (!isPrivacy && L.tail) {
      const p = document.createElement("p");
      p.className = "tail";
      p.textContent = L.tail;
      bodyEl.appendChild(p);
    }
    hintEl.textContent = isPrivacy ? `摘自《${L.title}》` : "安装时你同意的就是这份";
    bodyEl.scrollTop = 0;
  }
  function open(which) {
    lastFocus = document.activeElement;
    render(which);
    modal.hidden = false;
    modal.querySelector(".modal-x").focus();
  }
  function close() {
    modal.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();   // 焦点还回触发它的那个链接
  }
  document.getElementById("lnkTerms")?.addEventListener("click", () => open("terms"));
  document.getElementById("lnkPrivacy")?.addEventListener("click", () => open("privacy"));
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });
})();

// ------------------------------------------------- 桌面壁纸层（窗口里的那层背景视频）

// ★ 口径更正（2026-10-15）：原版没有"舞台"这个词。它自己的叫法是 `Wallpaper_Presence`
//   （壁纸，36 个 mp4，随安装包走）；曲子演奏视频是联网下载到
//   %APPDATA%\miHoYo\Olivia-steam\cache\studio\video\ 的，不在安装包里。
//   「舞台」是我们自己起的内部代号，本文件一律改回原版口径，叫**桌面壁纸层**。
// ★ 原版游戏的"桌面"就是这么一层循环播放的视频 —— 我们不复刻它的素材，只学这层结构：
//   一层视频当壁纸，液态玻璃浮在上面。
// ★ 播什么有两种，跟桌面壁纸那一层同一套口径：
//     ① 曲库里有曲子 → 播曲子（只存路径，不随包），按时段挑变体；
//     ② 一首都没入库 → 播**待机视频**（借原版的 Wallpaper_Presence 素材，服务端按时间挑）。
//   两种都没有，才什么都不做，底下那层氛围渐变自然露出来当兜底。
// ★ 两枚 video 是为跨时段时不硬切：交叉淡入；待机换时段时还会先过一段 Transition 过场片。
const stage = { active: "A", tod: null, mode: null, idle: { tod: null, slot: null, scene: null }, timer: null };

function stageVideos() { return [$("stageVideo"), $("stageVideoB")]; }

/** 模糊延伸的底层（#cbg）：每 1.2 秒从"当前在前面那枚 video"抓一帧，画进 80×50 的小画布，
 *  再由 CSS 放大 + 模糊铺满。★ 不另外解一遍视频 —— drawImage 直接取当前已解码的那帧，
 *  代价几乎为零（HEVC 软解是这里最贵的一步，绝不能开第二路）。 */
const cbg = $("cbg");
const cctx = cbg ? cbg.getContext("2d") : null;
function pumpBackdrop() {
  if (!cctx) return;
  const v = stage.active === "A" ? $("stageVideo") : $("stageVideoB");
  if (!v || v.readyState < 2 || !v.videoWidth) return;
  const tw = cbg.width, th = cbg.height;
  const sw = v.videoWidth, sh = v.videoHeight;
  const ta = tw / th, sa = sw / sh;
  let cw, ch, cx, cy;
  if (sa > ta) { ch = sh; cw = sh * ta; cx = (sw - cw) / 2; cy = 0; }
  else { cw = sw; ch = sw / ta; cx = 0; cy = (sh - ch) / 2; }
  try { cctx.drawImage(v, cx, cy, cw, ch, 0, 0, tw, th); } catch { /* 还没解出帧 */ }
}
/** 关掉那层背景时画布也要擦干净，否则会留着最后一帧的模糊色。 */
function clearBackdrop() { if (cctx) cctx.clearRect(0, 0, cbg.width, cbg.height); }
setInterval(() => { stage.mode === null ? clearBackdrop() : pumpBackdrop(); }, 1200);

/**
 * 交叉淡入换一段画面。
 * ★ loop=false + onEnded 给**过场片**用：过场片是一次性的，播完切正片。
 *   复用同一个元素前先把上一轮挂的 ended 回调摘掉，否则那枚 once 监听会串到下一段。
 */
function stageCrossFade(url, opts = {}) {
  const [a, b] = stageVideos();
  if (!a || !b) return;
  const incoming = stage.active === "A" ? b : a;
  const outgoing = stage.active === "A" ? a : b;
  if (incoming.__onEnded) { incoming.removeEventListener("ended", incoming.__onEnded); incoming.__onEnded = null; }
  incoming.loop = opts.loop !== false;
  incoming.src = url;
  incoming.play().catch(() => { /* 自动播放被拦就下一轮再试 */ });
  if (opts.onEnded) {
    incoming.__onEnded = opts.onEnded;
    incoming.addEventListener("ended", opts.onEnded, { once: true });
  }
  incoming.classList.remove("under");
  outgoing.classList.add("under");
  setTimeout(() => { try { outgoing.pause(); } catch { /* 已经停了 */ } }, 950);
  stage.active = stage.active === "A" ? "B" : "A";
}

function stopStage() {
  document.body.classList.remove("stage-on");
  idleAmbienceStop();
  clearBackdrop();
  for (const v of stageVideos()) {
    if (!v) continue;
    try { v.pause(); } catch { /* 没在播 */ }
    v.classList.add("under");
  }
  if (stage.timer) clearInterval(stage.timer);
  stage.timer = null;
  stage.mode = null;
  stage.idle = { tod: null, slot: null, scene: null };
}

/** 素材**暂时**没有：把画面收干净，但**保留轮询**。
 *  ★ 跟 stopStage() 的区别就一条：不清 stage.timer。素材是可能被用户后补上的，
 *    收一次画面就永久停摆，等于逼用户去设置页关一次再开一次。 */
function stageIdlePause() {
  if (stage.mode === null) return;
  stage.mode = null;
  stage.idle = { tod: null, slot: null, scene: null };
  document.body.classList.remove("stage-on");
  idleAmbienceStop();
  clearBackdrop();
  for (const v of stageVideos()) {
    if (!v) continue;
    try { v.pause(); } catch { /* 没在播 */ }
    v.classList.add("under");
  }
}

/** 待机的环境音：一个复用的 audio，循环播 ambient_loop_*.mp3。
 *  ★ 接口（/api/idle/next）从第一版就把 ambience URL 给出来了，但前端一直没人播它 ——
 *    这是真渲染验证抓出来的缺口（接口有、页面 audio 数量为 0）。 */
let idleAudio = null;
function idleAmbienceStart(n) {
  if (!n.ambience || n.ambienceOn === false) return idleAmbienceStop();
  if (!idleAudio) { idleAudio = new Audio(); idleAudio.loop = true; idleAudio.volume = 0.45; window.__idleAudio = idleAudio; /* 自查钩子：new Audio 不进 DOM */ }
  if (idleAudio.src !== location.origin + n.ambience) {
    idleAudio.src = n.ambience;
    idleAudio.play().catch(() => { /* 自动播放被拦就下一轮再试 */ });
  } else if (idleAudio.paused) {
    idleAudio.play().catch(() => { /* 同上 */ });
  }
}
function idleAmbienceStop() {
  if (!idleAudio) return;
  try { idleAudio.pause(); } catch { /* 没在播 */ }
  idleAudio.src = "";
}

/** 待机换时段：先播 `{场景}_Transition_{旧}_{新}.mp4`，播完切正片；缺片就直切。 */
async function stageIdleSwitch(n) {
  const from = stage.idle.slot;
  stage.idle = { tod: n.tod, slot: n.slot, scene: n.scene };
  let transUrl = null;
  try {
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(n.slot)}&scene=${encodeURIComponent(n.scene)}`;
    transUrl = (await api(`/api/idle/transition?${q}`))?.url ?? null;
  } catch { /* 拿不到过场片就直切 */ }
  if (transUrl) stageCrossFade(transUrl, { loop: false, onEnded: () => stageCrossFade(n.video) });
  else stageCrossFade(n.video);
}

async function stageTick() {
  try {
    // 挑哪一首由服务端说了算（/api/stage/next），桌面壁纸也用这一个接口 ——
    // 两边各写一遍"上次播过的 / 已导入的 / 曲库第一首"，迟早会改歪一边。
    const info = await api("/api/stage/next");
    if (info?.url) {
      if (stage.mode !== "song") { stage.mode = "song"; stage.tod = info.tod; document.body.classList.add("stage-on"); idleAmbienceStop(); stageCrossFade(info.url); }
      else if (info.tod !== stage.tod) { stage.tod = info.tod; stageCrossFade(info.url); }
      return;
    }
    // 没有曲子 ⇒ 走待机视频；待机素材也没有才真的什么都不播。
    const n = await api("/api/idle/next");
    // ★ 2026-10-15 修（审核）：以前这里直接 stopStage()，而 stopStage 会 clearInterval
    //   把**唯一的**那支 30 秒轮询清掉；轮询只在 startStage() 里重建（要用户手动开关
    //   背景视频才走得到）⇒ 一次"没素材"之后，素材后来补上了也**永远不会自愈**。
    //   正确做法：只收画面、**保留定时器**。
    if (!n.hasAssets || !n.video) return stageIdlePause();
    if (stage.mode !== "idle") {
      stage.mode = "idle";
      stage.idle = { tod: n.tod, slot: n.slot, scene: n.scene };
      document.body.classList.add("stage-on");
      stageCrossFade(n.video);
      idleAmbienceStart(n);
    } else if (n.tod !== stage.idle.tod) {
      await stageIdleSwitch(n);
      idleAmbienceStart(n);
    } else {
      idleAmbienceStart(n); // 同一轮轮询：把被浏览器拦下的自动播放再试一次
    }
  } catch { /* 轮询失败就下一轮再试 */ }
}

// ★ 2026-10-18 口径更正（用户原话）：「视频是壁纸，不要播放在程序里，要播放在桌面」。
//   原版游戏就是这么分工的：**程序窗口里只有信箱界面**，演奏视频铺在 Windows 桌面那一层
//   （由外壳 WallpaperHost.cs 挂到 Progman 的 WorkerW 上，走 wallpaper.html）。
//   所以这里不在窗口里起任何视频 —— startStage 保号只是为了按住老调用点，
//   真正的壁纸在 C# 侧，和页面无关。
async function startStage() {
  stopStage();   // 把以前可能已经在播的舞台视频收掉（老版本会在这里起片）
}

$("stageWallpaper")?.addEventListener("change", (e) => {
  setSetting2("stage_wallpaper", e.target.checked ? "1" : "0");
  // 开关交给外壳：它读的就是这条设置，决定要不要往桌面上铺壁纸层。
  try { window.chrome?.webview?.postMessage(e.target.checked ? "wallpaper:on" : "wallpaper:off"); } catch { /* 浏览器里没有这个通道 */ }
  toast(e.target.checked ? "桌面壁纸已开" : "桌面壁纸已关");
});

// ---------------------------------------------------------------- 原生窗口

// ★ 外壳的 MainWindow 是**无边框**的，所以拖动、收进托盘、退出这三件事
//   得由页面发一句话给 C#（window.chrome.webview.postMessage），那边照做。
//   在浏览器里打开时没有这个通道 ⇒ 什么都不做、窗口条也不显示（那时浏览器自带标题栏）。
// ★ 判据是"有没有 chrome.webview"，不是"userAgent 里有没有 Edge" ——
//   UA 判断会误伤：Edge 里手动打开同一个地址也会匹配到，那是我们**没有**自己窗口的情况。
(function initNativeWindow() {
  const host = window.chrome && window.chrome.webview;
  if (!host) return;
  document.body.classList.add("native");
  const bar = document.getElementById("winchrome");
  if (!bar) return;
  bar.hidden = false;

  const say = (action) => { try { host.postMessage(action); } catch { /* 通道断了就算了 */ } };
  // 拖动：按在这条上（按钮除外）就叫窗口跟着走。
  bar.addEventListener("mousedown", (e) => { if (e.target.closest(".wc")) return; say("drag"); });
  document.getElementById("wcMin")?.addEventListener("click", () => say("min"));
  document.getElementById("wcMax")?.addEventListener("click", () => say("max"));
  document.getElementById("wcQuit")?.addEventListener("click", () => say("quit"));
  // ★ 双击窗口条＝最大化/还原（Windows 的通用手势，原版是系统标题栏所以自带）。
  bar.addEventListener("dblclick", (e) => { if (e.target.closest(".wc")) return; say("max"); });
})();

// ---------------------------------------------------------------- 启动

// ★ 启动时要先读一次设置：第一次打开的询问弹窗挂在 loadSettings() 末尾。
//   不在这里调的话，只有用户自己点进「设置」页才会弹 —— 那就不叫"第一次打开时问"了。
//   （这一条是真渲染抓出来的：接口全 200、单测全绿，可弹窗就是不出现。）
// 外壳（原生窗口 / 桌面壁纸上的那两个圆钮）发来的指令：切到某一页。
// 没有这个通道就是普通浏览器，什么都不做。
(function listenShell() {
  const host = window.chrome && window.chrome.webview;
  if (!host) return;
  host.addEventListener("message", (e) => {
    const m = e.data;
    if (typeof m === "string" && m.startsWith("go:")) show(m.slice(3));
  });
})();

loadSettings();

// 桌面壁纸层（背景视频）：没有这个键就当作开 —— 装了之后第一眼就该是那层壁纸。
const stageToggle = $("stageWallpaper");
if (stageToggle) stageToggle.checked = localStorage.getItem("stage_wallpaper") !== "0";
startStage();

loadLetters();
setInterval(loadLetters, 5000);

// ---------------------------------------------------------------- 数据备份与恢复
// 三条约束（照姊妹项目 data-safety.js，都是踩过坑立的），界面上必须让人看见：
//   ① 恢复/导入**不当场生效**：点了之后只排进队列，关掉程序再打开才换库；
//   ② 换库之前当前这一份会自动留档成 before-restore-*.sqlite；
//   ③ 导出包会清掉 API Key（它可能被发出去）。

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dsStatus(text, kind = "") {
  const el = $("dataSafetyStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `ds-status${kind ? ` is-${kind}` : ""}`;
}

/** 把一份备份排进待恢复；确认框里要说清"现在这份会先留档"。 */
async function dsAskRestore(file) {
  const ok = window.confirm(
    `恢复这份备份？\n\n${file}\n\n`
    + "· 现在这份库会先自动留档成 before-restore-*.sqlite\n"
    + "· 恢复要关掉程序再打开才生效",
  );
  if (!ok) return;
  try {
    await api("/api/data/restore", { method: "POST", body: { file, confirm: true }, auth: true });
    toast("已安排恢复：关掉程序再打开就生效");
    await dsLoad();
  } catch (error) {
    toast(error.message);
  }
}

async function dsAskDelete(file) {
  const ok = window.confirm(`删除这份备份？\n\n${file}\n\n删了就找不回来了。`);
  if (!ok) return;
  try {
    await api("/api/data/delete", { method: "POST", body: { file, confirm: true }, auth: true });
    await dsLoad();
  } catch (error) {
    toast(error.message);
  }
}

function renderDsPending(pending) {
  const host = $("dsPending");
  if (!host) return;
  host.innerHTML = "";
  if (!pending) { host.hidden = true; return; }
  host.hidden = false;
  const line = document.createElement("div");
  line.className = "ds-pending-text";
  line.textContent = `⚠ 已安排一次恢复：关掉程序再打开就生效 —— ${pending.label || pending.source}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ds-inline";
  btn.textContent = "取消这次恢复";
  btn.addEventListener("click", async () => {
    try {
      await api("/api/data/cancel-restore", { method: "POST", body: {}, auth: true });
      toast("已取消");
      await dsLoad();
    } catch (error) { toast(error.message); }
  });
  host.append(line, btn);
}

function renderDsList(list, pendingSource) {
  const host = $("dsList");
  if (!host) return;
  host.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "ds-empty";
    empty.textContent = "还没有备份。点「现在备份一份」留个退路。";
    host.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "ds-row";
    const waiting = pendingSource && pendingSource === item.file;
    const main = document.createElement("div");
    main.className = "ds-row-main";
    main.innerHTML = `<span class="ds-row-kind"></span><span class="ds-row-time"></span><span class="ds-row-size"></span>`;
    main.querySelector(".ds-row-kind").textContent = item.kind;
    main.querySelector(".ds-row-time").textContent = fmtTime(item.at);
    main.querySelector(".ds-row-size").textContent = fmtBytes(item.bytes);
    const acts = document.createElement("div");
    acts.className = "ds-row-acts";
    if (waiting) {
      const tag = document.createElement("span");
      tag.className = "ds-row-waiting";
      tag.textContent = "等待重启恢复，不能删";
      acts.appendChild(tag);
    } else {
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.className = "ds-inline";
      inspect.textContent = "看内容";
      inspect.addEventListener("click", async () => {
        try {
          const detail = await api("/api/data/inspect", { method: "POST", body: { file: item.file }, auth: true });
          const tables = Object.entries(detail.tables ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ");
          dsStatus(`${item.file}：${tables || "（没有表）"}`);
        } catch (error) { dsStatus(error.message, "bad"); }
      });
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "ds-inline";
      restore.textContent = "恢复这一个";
      restore.addEventListener("click", () => dsAskRestore(item.file));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ds-inline ds-danger";
      del.textContent = "删除";
      del.addEventListener("click", () => dsAskDelete(item.file));
      acts.append(inspect, restore, del);
    }
    row.append(main, acts);
    host.appendChild(row);
  }
}

async function dsLoad() {
  const listHost = $("dsList");
  if (!listHost) return;
  try {
    const st = await api("/api/data/status", { auth: true });
    $("dataSafetySummary").textContent = st.total
      ? `备份目录里共 ${st.total} 份，占 ${fmtBytes(st.bytes)}（当前库 ${fmtBytes(st.live)}）`
      : "备份目录里还没有备份文件。";
    renderDsPending(st.pending);
    renderDsList(st.items ?? [], st.pending?.source ?? null);
    const periodic = st.periodic ?? { enabled: true, days: 1, keep: 7 };
    $("dsPeriodicEnabled").checked = Boolean(periodic.enabled);
    $("dsPeriodicDays").value = String(periodic.days);
    $("dsPeriodicKeep").value = String(periodic.keep);
    const periodicCount = (st.items ?? []).filter((i) => i.kind === "周期自动备份").length;
    $("dsPeriodicStatus").textContent = periodic.enabled
      ? `开着：每 ${periodic.days} 天一份，只保留最近 ${periodic.keep} 份周期备份（手动备份与升级前备份不会被清理）。目前有 ${periodicCount} 份。`
      : "周期备份已关闭。";
  } catch (error) {
    dsStatus(error.message, "bad");
  }
}

$("dsBackup")?.addEventListener("click", async () => {
  dsStatus("正在备份…");
  try {
    const st = await api("/api/data/backup", { method: "POST", body: {}, auth: true });
    dsStatus(`✓ 已备份 ${st.made.file}（${fmtBytes(st.made.bytes)}）`, "good");
    await dsLoad();
  } catch (error) { dsStatus(error.message, "bad"); }
});

$("dsExport")?.addEventListener("click", async () => {
  dsStatus("正在导出…");
  try {
    const res = await fetch("/api/data/export", {
      method: "POST",
      headers: { "X-Linli-Token": await ensureToken(), "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `导出失败（${res.status}）`);
    }
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get("X-Export-Name") || "linli-userdata.zip");
    const urlv = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlv;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(urlv), 4000);
    dsStatus(`✓ 已导出 ${name}（${fmtBytes(blob.size)}，其中的 API Key 已被清掉）`, "good");
  } catch (error) { dsStatus(error.message, "bad"); }
});

$("dsImport")?.addEventListener("click", () => $("dsImportFile")?.click());
$("dsImportFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!window.confirm(`导入 ${file.name}？\n\n· 现在这份库会先自动留档\n· 导入要关掉程序再打开才生效`)) return;
  dsStatus("正在导入…");
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/data/import?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "X-Linli-Token": await ensureToken(), "Content-Type": "application/octet-stream" },
      body: buf,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `导入失败（${res.status}）`);
    dsStatus("✓ 已导入：关掉程序再打开就生效（旧库已自动留档）", "good");
    await dsLoad();
  } catch (error) { dsStatus(error.message, "bad"); }
  e.target.value = "";
});

$("dsPeriodicCleanup")?.addEventListener("click", async () => {
  if (!window.confirm("清理超出保留份数的周期备份？\n\n只删周期自动备份，手动备份与升级前备份不会动。")) return;
  try {
    const done = await api("/api/data/periodic-cleanup", { method: "POST", body: { confirm: true }, auth: true });
    dsStatus(done.removed.length ? `✓ 清理了 ${done.removed.length} 份，留下 ${done.kept} 份` : "没有需要清理的", "good");
    await dsLoad();
  } catch (error) { dsStatus(error.message, "bad"); }
});
$("dsPeriodicSave")?.addEventListener("click", async () => {
  try {
    await api("/api/data/periodic", {
      method: "POST",
      body: {
        enabled: $("dsPeriodicEnabled").checked,
        days: Number($("dsPeriodicDays").value),
        keep: Number($("dsPeriodicKeep").value),
      },
    });
    toast("已保存");
    await dsLoad();
  } catch (error) { dsStatus(error.message, "bad"); }
});

// 备份目录是用户自己的文件夹，用外壳的白名单之外的方式打开是不行的 ——
// 走系统默认处理（explorer），不经过网页跳转，所以不碰 openExternal 的白名单。
$("dsReveal")?.addEventListener("click", async () => {
  try {
    const st = await api("/api/data/status", { auth: true });
    await fetch("/api/data/reveal", { method: "POST", headers: { "X-Linli-Token": await ensureToken(), "Content-Type": "application/json" }, body: JSON.stringify({ dir: st.dir }) });
  } catch { /* 打不开就算了，不影响别的 */ }
});
