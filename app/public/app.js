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
  if (!lettersCache.length) {
    host.innerHTML = `<p class="hint">还没有信。点左下角写第一封。</p>`;
    return;
  }
  host.innerHTML = lettersCache.map((item) => {
    const her = item.origin === "proactive";
    const title = her ? `她写来一封：${firstLine(item.reply_text, 14)}` : (firstLine(item.content) || "（空信）");
    const unread = item.is_read === 0 && item.reply_text ? `<span class="unread-dot"></span>` : "";
    return `<button class="mrow${item.id === selectedLetterId ? " on" : ""}" data-id="${escapeHtml(item.id)}" type="button">
      <span class="mri">${her ? "✉" : "✎"}</span>
      <span class="mrt"><b>${escapeHtml(title)}</b><span>${formatTime(item.replied_at || item.created_at)} · ${letterState(item)}</span></span>
      ${unread}
    </button>`;
  }).join("");
  for (const row of host.querySelectorAll(".mrow")) {
    // ★ 信件 id 是服务端给的 UUID（randomUUID），不是自增整数 —— 别做数字转换。
    row.addEventListener("click", () => selectLetter(row.dataset.id));
  }
}

/** 右栏：选中了就显示往来，没选中就是空态。 */
function renderReader() {
  const box = $("reader");
  const empty = $("mailEmpty");
  // 宿主缺失就直接返回，不要在 null 上设属性：抛出去会被全局 onerror 抓走塞进 toast，
  // 用户看到的是一句英文 TypeError，而不是「读信区没画出来」这个真问题。
  if (!box || !empty) return;
  const item = lettersCache.find((l) => l.id === selectedLetterId);
  if (!item) {
    box.hidden = true;
    box.innerHTML = "";
    empty.hidden = false;
    const sub = empty.querySelector(".es");
    if (sub) sub.textContent = lettersCache.length ? "点击左侧信箱栏阅读信件" : "还没有信。左下角可以写第一封。";
    return;
  }
  empty.hidden = true;
  box.hidden = false;
  const parts = [];
  // ---- 我写出去的那封：走「明信片」卡（原版 .mail-responsive-card 是 16:9 的横卡）----
  if (item.origin !== "proactive") {
    parts.push(`
      <div class="letter">
        <div class="meta"><span class="who me">我</span><span class="when">${formatTime(item.created_at)}</span></div>
        <!-- ★ mine：这封是**用户自己写的**，要用他自己那支字（--compose-font），
             不能和林离那封同一支 —— 两个人字迹相同，一屏里就分不出谁写的了。 -->
        <div class="body mine">${escapeHtml(item.content)}</div>
      </div>`);
  }
  parts.push(replyCard(item));
  box.innerHTML = parts.join("");
}

/**
 * 她的回信 —— 照原版结构做成一张**16:9 的明信片卡**。
 * ★ 原版口径（assets/main-31595bd3.js 的 MailBoxReplyContent + index-9ba3e01a.css）：
 *   · .mail-responsive-card / .mail-card-content
 *     { width:auto; min-width:516px; min-height:290px; max-width:100%; aspect-ratio:16/9 }
 *   · 正文 .mail-box-reply-content-text
 *     { font-family:SentyTEA; padding:24px 28px; font-size:20px; line-height:1.5;
 *       white-space:pre-wrap; color:var(--tp-surface-1) }
 *   · 底图按状态换三张（这套三态是原版**本来就有**的，不是我们加的）：
 *       postcard_letter.webp  正常回信
 *       postcard_sealed.webp  已封
 *       postcard_retry.webp   失败、可重试
 *   · 另有一张 postcard_video.webp 是「她正在写」时用的（min-height:250px）。
 */
function replyCard(item) {
  const tag = item.origin === "proactive" ? `<span class="tag">她先写的</span>` : "";
  const when = formatTime(item.replied_at || item.created_at);
  let kind, body;
  // ★ 2026-10-17：**只有带着 error 的 5 才是失败**。搬进来的旧信也是 5，
  //   它们没有回信、但也没出过错 —— 按「无回信」渲染，别给它盖一张失败卡（那张卡是给重试用的）。
  if (item.status === 5 && item.error) {
    kind = "retry";
    body = `<div class="reply-text err">${escapeHtml(item.error)}</div>`;
  } else if (item.reply_text) {
    kind = "letter";
    body = `<div class="reply-text">${escapeHtml(item.reply_text)}</div>`;
  } else {
    // 她还在写：原版这时候用的就是 postcard_video 那张（配一段循环视频）。
    kind = "video";
    body = `<div class="reply-text pending">她还在写……</div>`;
  }
  return `
    <div class="letter">
      <div class="meta"><span class="who her">林离</span>${tag}<span class="when">${when}</span></div>
      <div class="reply-card" data-kind="${kind}">${body}</div>
    </div>`;
}

/** ★ 走 api() 而不是裸 fetch：写操作服务端一律要 X-Linli-Token，
 *  以前这里没带令牌 ⇒ 401 被 catch 吞掉，"已读"这个动作其实从来没生效过。 */
function markRead(id) {
  api(`/api/letters/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
}

function selectLetter(id) {
  selectedLetterId = id;
  showCompose(false);                  // 选中信件 ⇒ 右栏从"写信"切回"读信"
  renderLetterList();
  renderReader();
  const item = lettersCache.find((l) => l.id === id);
  if (item && item.is_read === 0 && item.reply_text) {
    item.is_read = 1;                  // 本地先记上，红点立刻消失；服务端那边同步
    renderLetterList();
    markRead(item.id);
  }
}

/**
 * 写信卡右上角那枚**视频邮票**（原版叫 mail_stamp，见 assets/main-31595bd3.js 的
 * MailBoxWriteContent）。★ 原版口径：
 *   · 4 支循环视频随机挑一支（`i=[Sa,ka,$a,Ca]` + `Math.random`）
 *   · 元素是 <video autoplay muted loop playsinline>，每次卡片**变得可见**时 play()
 *     （`watch(() => isVisible, async A => { if (A) { …await h.value.play() } })`）
 *   · 关掉视频时退回静态邮票图（`useVideoStamp` 为假走 <img>）
 * 我们照抄这套：可见时换一支、播起来；播不动（解码器缺失等）就退回静态图。
 */
const STAMP_VIDEOS = [
  "mail/mail_stamp_1.mp4", "mail/mail_stamp_2.mp4",
  "mail/mail_stamp_3.mp4", "mail/mail_stamp_4.mp4",
];
const STAMP_IMAGES = ["mail/stamp_1.webp", "mail/stamp_2.webp", "mail/stamp_3.webp"];

function pickStamp(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function stampStart() {
  const video = $("writeStampVideo");
  const img = $("writeStampImg");
  if (!video || !img) return;
  video.src = pickStamp(STAMP_VIDEOS);
  img.src = pickStamp(STAMP_IMAGES);
  video.hidden = false;
  img.hidden = true;
  // 每次显示都从头播 —— 原版也是每次可见就 play()，不是接着上一轮的进度。
  video.currentTime = 0;
  const p = video.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => stampFallback());     // 播不动就退回静态邮票，别留一个空白洞
  }
  // 解码中途失败（编解码器缺失、文件被删）也走同一条退路。
  video.onerror = stampFallback;
}

function stampFallback() {
  const video = $("writeStampVideo");
  const img = $("writeStampImg");
  if (!video || !img) return;
  try { video.pause(); } catch { /* 没在播就算了 */ }
  video.hidden = true;
  img.hidden = false;
}

function showCompose(on) {
  if ($("composePanel")) $("composePanel").hidden = !on;
  if (on) {
    const reader = $("reader");
    const mailEmpty = $("mailEmpty");
    if (reader) reader.hidden = true;
    if (mailEmpty) mailEmpty.hidden = true;
    $("compose")?.focus();
    stampStart();                      // ★ 卡片一露出来就换一支新邮票并开始播
  } else {
    stampStop();
    renderReader();                    // 复原成"读信 / 空态"
  }
}

/** 离开写信卡就停掉邮票：让它挂在后台空转是白烧 CPU/电。 */
function stampStop() {
  const video = $("writeStampVideo");
  if (!video) return;
  try { video.pause(); } catch { /* 没在播就算了 */ }
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

async function loadLetters(keepSelection = null) {
  try {
    const { letters } = await api("/api/letters");
    lettersCache = letters;
    // 已经选中的那封还在 ⇒ 保持不动（每 5 秒一次的轮询不该把用户正在读的信顶掉）。
    const stillThere = selectedLetterId !== null && letters.some((l) => l.id === selectedLetterId);
    if (!stillThere) {
      // 有没读过的就先摆出来给她看；全都读过了就留空态 —— 两个状态都要能到。
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

$("openCompose")?.addEventListener("click", () => showCompose(true));
$("cancelCompose")?.addEventListener("click", () => showCompose(false));
$("mailHelp")?.addEventListener("click", () => toast("左边是你们的往来，点一封就在右边读。收起窗口她照样会写。"));

$("sendBtn").addEventListener("click", async () => {
  const content = $("compose").value.trim();
  // ★ 前端先挡一次是为了不让用户白等一个来回；但**号必须与后端同一个**（LETTER_EMPTY），
  //   否则同一个错误会随"谁先发现"而报出两个不同的号，排查时对不上。
  if (!content) return toast(codeText("信是空的", "LETTER_EMPTY"));
  const btn = $("sendBtn");
  btn.disabled = true;
  btn.textContent = "寄出中……";
  try {
    const { id } = await api("/api/letters", { method: "POST", body: { content } });
    $("compose").value = "";
    toast("已寄出，等她回信");
    selectedLetterId = null;
    await loadLetters(id);             // 刚寄出的那封直接选中，右侧立刻变成"她还在写……"
    showCompose(false);
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "寄出";
  }
});

// ---------------------------------------------------------------- 曲库

let allSongs = [];        // 曲库目录里扫出来的全部（每首带 genre / mode）
let deskSongs = [];       // 已入库（"音乐桌面"上摆着的）
// ★ 默认停在「古典」—— 原版也是这一档起手（第一张截图里 古典 就是选中态）。
//   页签值直接就是分档名，因为分档是服务端算好的：前端不做任何分类判断。
const LIB_TABS = ["古典", "ACG", "轻音乐", "我的上传"];
let libTab = LIB_TABS[0];

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

/** 模式列：独奏 / 弹唱 / 个人上传 —— 跟原版那一列同一个意思。
 *  ★ 以前这里写的是"这一首有哪几个时段的变体"（白天/傍晚/夜晚的小胶囊）。
 *    那是把「模式」这一列读错了：原版的模式说的是**演奏方式**，不是时段。
 *    而且三个小胶囊在一行里最扎眼 —— 用户说"有点乱"就有它一份。
 *    有没有变体、能不能入库，交给右边那个按钮（入库 / 已在桌面）去说。 */
function modeCell(song) {
  return `<span class="tr-mode-t">${escapeHtml(song.mode ?? "")}</span>`;
}

function renderSongs() {
  const host = $("songs");
  const inDesk = new Set(deskSongs.map((s) => s.dir));
  const rows = allSongs.filter((s) => s.genre === libTab);
  if (!rows.length) {
    host.innerHTML = `<p class="hint">这一档还没有曲目。（分档是导入时按目录名自动做的，设置页可以改曲库目录）</p>`;
    return;
  }
  // ★ 曲目这一格只放一行曲名。
  //   以前下面还挂一行目录名（`Solo_Air_On_The_G_String_From_Orchestral_Suite_...`），
  //   可它跟上面的曲名本来就是同一句话，只是一串下划线 —— 看过去就是重复，是"乱"的一份。
  //   原版那一行写的是**艺人**（`Rachmaninoff · 4:18`），我们没有艺人，宁可不写，
  //   也别拿目录名去凑那一行。想看目录名的，鼠标停在整行上有 title。
  host.innerHTML = rows.map((s, i) => `
    <div class="trow${s.dir === player.dir ? " on" : ""}" data-dir="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}" title="${escapeHtml(s.dir)}">
      <span class="tr-no">${i + 1}</span>
      <span class="tr-t">
        <span class="tr-thumb">${s.dir === player.dir ? "▶" : "♪"}</span>
        <span class="tr-tt"><b>${escapeHtml(s.name)}</b></span>
      </span>
      <span class="tr-mode">${modeCell(s)}</span>
      <span class="tr-act">
        <button data-play="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}" type="button">试听</button>
        <button data-import="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}" type="button">${inDesk.has(s.dir) ? "已在桌面" : "入库"}</button>
      </span>
    </div>`).join("");
}

async function loadImported() {
  const host = $("imported");
  if (!host) return;
  try {
    const { songs } = await api("/api/library/songs");
    deskSongs = songs ?? [];
    const c = $("deskCount");
    if (c) c.textContent = String(deskSongs.length);
    if (!deskSongs.length) {
      host.innerHTML = `<p class="hint">音乐桌面还是空的。左边任意一行点「入库」，或者点上面「随机入库」。</p>`;
      return;
    }
    host.innerHTML = deskSongs.map((s) => `
      <button class="drow${s.dir === player.dir ? " on" : ""}" data-dir="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}" type="button">
        <span class="di">${s.dir === player.dir ? "▶" : "♪"}</span>
        <span class="dt">
          <b>${escapeHtml(s.name)}</b>
          <span>${escapeHtml(s.mode ?? "")} · ${escapeHtml(s.genre ?? "")} · ${formatDay(s.added_at)}</span>
        </span>
      </button>`).join("");
    for (const row of host.querySelectorAll(".drow")) {
      row.addEventListener("click", () => play(row.dataset.dir, row.dataset.name));
    }
  } catch (error) {
    host.innerHTML = `<p class="hint">${escapeHtml(error.message)}</p>`;
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

// 表格里的点击：试听 / 入库 / 点整行也算试听
$("songs").addEventListener("click", (event) => {
  const playBtn = event.target.closest("[data-play]");
  if (playBtn) return void play(playBtn.dataset.play, playBtn.dataset.name);
  const imp = event.target.closest("[data-import]");
  if (imp) return void importSong(imp.dataset.import, imp.dataset.name);
  const row = event.target.closest(".trow");
  if (row && row.dataset.dir) play(row.dataset.dir, row.dataset.name);
});

for (const tab of document.querySelectorAll("#libTabs .tab")) {
  tab.addEventListener("click", () => {
    libTab = tab.dataset.tab;
    for (const t of document.querySelectorAll("#libTabs .tab")) t.classList.toggle("on", t === tab);
    renderSongs();
  });
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
function activeVideo() { return player.active === "A" ? $("vA") : $("vB"); }

function stopPlayerWatch() {
  if (player.timer) clearInterval(player.timer);
  if (player.warmed) player.warmed.el.remove();
  for (const v of [$("vA"), $("vB")]) { try { v?.pause(); } catch { /* 没在播 */ } }
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
    const v = $("vA");
    $("vB").classList.add("under");
    $("vB").removeAttribute("src");
    v.classList.remove("under");
    v.src = info.url;
    v.play().catch(() => { /* 需要用户先点一下才出声也没关系 */ });
    writePlayerMeta(info, name);

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
    api("/api/library/played", { method: "POST", body: { title: name } }).catch(() => {});
    renderSongs();                     // 让正在播的那一行亮起来
    loadImported();
  } catch (error) {
    toast(error.message);
  }
}

function writePlayerMeta(info, name) {
  const t = $("pbTitle"), m = $("pbMeta"), s = $("pbSlot");
  if (t) t.textContent = name ?? "还没有在播";
  // ★ info.file 是素材的内部文件名（形如 TOD2000_NI_L.mp4），那是给机器看的，
  //   原样贴出来等于把内部代号丢给用户。播放条上只留人话：时段 + 有几个变体。
  if (m) m.textContent = info
    ? `${info.label} · ${info.variantCount} 个变体`
    : "点左边任意一首的「试听」";
  if (s) s.textContent = info ? `${info.label}` : "—";
}

function crossFadeTo(info, name) {
  const a = $("vA"), b = $("vB");
  const incoming = player.active === "A" ? b : a;
  const outgoing = player.active === "A" ? a : b;
  incoming.src = info.url;
  incoming.play().catch(() => {});
  incoming.classList.remove("under");
  outgoing.classList.add("under");
  // 转场走完把旧的停掉，别让它继续占解码
  setTimeout(() => outgoing.pause(), 950);
  player.active = player.active === "A" ? "B" : "A";
  writePlayerMeta(info, name);
}

// ---- 播放条上的按钮 / 进度 ----
function playlist() {
  // 上一首 / 下一首在"音乐桌面"里走；桌面是空的时候退回到整个曲库，别让按钮点了没反应。
  return deskSongs.length ? deskSongs : allSongs;
}

async function step(delta) {
  const list = playlist();
  if (!list.length) return;
  const at = list.findIndex((s) => s.dir === player.dir);
  const next = list[(at + delta + list.length) % list.length] ?? list[0];
  await play(next.dir, next.name);
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
$("pbMute")?.addEventListener("click", (e) => {
  const v = activeVideo();
  if (!v) return;
  v.muted = !v.muted;
  // ★ 用 e.currentTarget 而不是再查一次 DOM：按钮在监听器里一定在，
  //   再查一次就把「元素还在」这个已知事实变成了一次可能为 null 的取值。
  e.currentTarget.textContent = v.muted ? "🔇" : "🔊";
});

function paintProgress() {
  const v = activeVideo();
  const fill = $("pbFill"), time = $("pbTime"), play = $("pbPlay");
  // ★ 四个元素一起判：只判 pbLine 挡不住后面的裸用 —— 播放条控件缺一个，
  //   timeupdate 每 250ms 抛一次 TypeError，控制台刷屏、进度条也不动。
  if (!v || !$("pbLine") || !fill || !time || !play) return;
  const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  const pct = total ? Math.min(100, (v.currentTime / total) * 100) : 0;
  fill.style.width = `${pct}%`;
  const mmss = (sec) => `${
    String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  time.textContent = `${mmss(v.currentTime || 0)} / ${mmss(total)}`;
  play.textContent = v.paused ? "▶" : "❚❚";
}
for (const id of ["vA", "vB"]) {
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

$("saveLibraryDir").addEventListener("click", async () => {
  try {
    await api("/api/library/dir", { method: "POST", body: { dir: $("libraryDir").value.trim() } });
    toast("已保存");
    await loadLibrary();
  } catch (error) {
    toast(error.message);
  }
});

$("importRandom").addEventListener("click", async () => {
  const btn = $("importRandom");
  btn.disabled = true;
  btn.textContent = "入库中……";
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
    btn.disabled = false;
    btn.textContent = "随机入库";
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
    void refreshFont();     // 顺带把「信件字体」那张卡片刷新（首次会触发一次引导弹窗）
    void refreshIdle();     // 顺带把「待机」那张卡片刷新（场景/状态、素材在不在）
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
 *  ★ 引导弹窗只在**本次会话第一次**刷新时问（ask 默认就走这个"只问一次"），
 *    之后不管是"重新检查"还是重进设置页，都只刷状态、不再弹。
 */
let fontBooted = false;
async function refreshFont({ ask = true } = {}) {
  const shouldAsk = ask && !fontBooted;
  fontBooted = true;
  let all = { letter: { ok: false }, compose: { ok: false } };
  try { all = await api("/api/font/status"); } catch { /* 拿不到就按"两支都不在"渲染 */ }
  fontStatusCache = all;
  for (const cfg of FONT_SLOTS) {
    const st = all[cfg.slot];
    if (st && st.ok) applyFont(cfg); else clearFont(cfg);
  }
  renderFontCard(all);
  // ★ 引导弹窗只在两支**都没导入**时才问 —— 只差一支的话，设置页那两行已经写清楚了。
  if (shouldAsk) window.__maybeAskFont?.(Boolean(all.letter?.ok) && Boolean(all.compose?.ok));
  return all;
}

/** 打开外部网址。外壳里走 C# 那条通道（那边有域名白名单）；浏览器里直接开新标签。 */
function openExternal(url) {
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

async function startStage() {
  if (localStorage.getItem("stage_wallpaper") === "0") return stopStage();
  await stageTick();
  if (stage.timer) clearInterval(stage.timer);
  // 跨时段时换片。30 秒一次，跟曲库、壁纸那边的轮询同频。
  stage.timer = setInterval(() => { void stageTick(); }, 30000);
}

$("stageWallpaper")?.addEventListener("change", (e) => {
  setSetting2("stage_wallpaper", e.target.checked ? "1" : "0");
  if (e.target.checked) startStage(); else stopStage();
  toast(e.target.checked ? "背景视频已开" : "背景视频已关");
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
  document.getElementById("wcQuit")?.addEventListener("click", () => say("quit"));
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
