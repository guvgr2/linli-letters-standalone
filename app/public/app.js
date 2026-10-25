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
/** 当前停在哪一页（页头返回键与"从哪进来的回哪去"都要用它）。 */
function currentPage() {
  return PAGES.find((n) => $(`page-${n}`)?.classList.contains("on")) ?? "mail";
}
/**
 * 导航历史（2026-10-20 用户口径）：「设置页面删掉返回信箱的按钮……改成那个返回键，
 * 返回的逻辑抄原版游戏的就行」—— 原版是浏览器式"上一页"：从曲库进来的就该回曲库，
 * 固定回信箱会很怪。这里只记**页间跳转**（同页重复点击不记），容量封顶防无限增长。
 */
const navStack = [];
function show(page) {
  // 离开曲库页就停掉时段轮询并卸掉播放器，别在后台继续解码 100MB 级的视频
  if (page !== "library") stopPlayerWatch();
  const from = currentPage();
  if (from !== page) {
    navStack.push(from);
    if (navStack.length > 32) navStack.shift();
  }
  for (const name of PAGES) {
    const el = $(`page-${name}`);
    if (el) el.classList.toggle("on", name === page);
  }
  // ★★ 2026-10-20：左侧导航已经不是页面里的 `.rail` 了（整块删掉，见 index.html 里的说明）。
  //   它是外壳画在窗口**外面**的一枚独立浮层，看不见页面里的 class 变化
  //   ⇒ 每次切页都报一句 `page:<id>`，外壳据此点亮对应的那一颗。
  //   原来这里那两行 `.rb` 的 classList.toggle + querySelectorAll 绑定一并删除。
  try { window.chrome?.webview?.postMessage("page:" + page); } catch { /* 浏览器里没有这个通道 */ }
  if (page === "memory") { loadMemory(); loadDiary(); }
  if (page === "settings") loadSettings();
  if (page === "library") loadLibrary();
}
// ★ 2026-10-20：`for (const btn of document.querySelectorAll(".rb"))` 那段绑定整块删掉了 ——
//   页面里已经没有 `.rb`（左栏连同它的三个圆钮一起搬到了外壳的 NavRail 浮层里）。
//   导航点击现在从 NavRail → 外壳 `Go(page)` → 页面 `show()` 这一条路进来。
// ★ 各页右上角那枚齿轮（用户口径 2026-10-18：「设置键移到原版游戏的位置，
//   不要单开一个左侧圆按钮」）。左栏的设置圆钮已经去掉，所以这里是**唯一**的
//   设置入口 —— 用 querySelectorAll 兜住全部页，别再写死某一个 id。
// ★ 走 show("settings") 而不是自己切 class：切页要带的副作用（停播放、加载数据）
//   都挂在 show() 里，绕过它就只换了个画面。
for (const gear of document.querySelectorAll("[data-gear]")) {
  gear.addEventListener("click", () => show("settings"));
}
// ★ 2026-10-20：设置页左上角的 ← 返回键。回"上一页"（从哪页进来的回哪页），
//   逻辑抄原版；历史空（比如外壳直接发 go:settings 拉起来的）时回信箱。
$("settingsBack")?.addEventListener("click", () => {
  show(navStack.length ? navStack.pop() : "mail");
});

// ★ 2026-10-20（用户「记忆的设置键和字体应该固定住，不随上下滑动而动」）：
//   记忆页页头改回 sticky 钉住之后，滚动时卡片会从标题后面穿过去看着像压字。
//   解决办法不是让标题跟着滚走（用户不要），而是滚起来之后给页头一层淡底
//   （CSS 那头认 .is-scrolled）—— 第一帧仍然全透明，只在滚动之后才上底。
{
  const mem = $("page-memory");
  if (mem) {
    const sync = () => mem.classList.toggle("is-scrolled", mem.scrollTop > 8);
    mem.addEventListener("scroll", sync, { passive: true });
    sync();
  }
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
  //   从旧程序搬进来的信，没回信的也记 5（原版口径 status 5 = UNREPLIED），
  //   那些信**从来没失败过**，只是他没让林离回过。判失败的唯一依据是 error 有没有内容。
  if (item.status === 5 && item.error) return "生成失败";
  return item.reply_text ? "已回信" : "等她回信";
}

let lettersCache = [];
let selectedLetterId = null;

// ---------------------------------------------------------------- 回顾：三种看法
// ★ 2026-10-21：列表 / 时间轴 / 日历。三种看法共用同一份 lettersCache 与 /api/timeline，
//   前端只负责排版，不在浏览器里重新算"哪天有信"——聚合口径只有服务端那一份（app/timeline.mjs）。
let mailView = "list";          // "list" | "timeline" | "calendar"
let timelineDays = null;        // null = 还没取过（渲染时会去拉）
let timelineLoading = false;
const calMonthCache = new Map(); // 'YYYY-MM' → days[]（翻回去不用再请求）
let calMonth = null;             // 日历当前停在哪个月
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 本地时区的 'YYYY-MM-DD'。★ 不能用 toISOString()：那是 UTC，东八区会把凌晨算到前一天。 */
function localDayStr(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 只要时分（时间轴每一行右侧那个"14:22"）。 */
function clockOf(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 往时间轴/日历里塞东西之前，先确认手上这份数据是新写的（寄出/重试之后要作废）。 */
function invalidateTimeline() {
  timelineDays = null;
  calMonthCache.clear();
}

async function loadTimeline() {
  if (timelineDays !== null || timelineLoading) return;
  timelineLoading = true;
  try {
    const data = await api("/api/timeline");
    timelineDays = Array.isArray(data?.days) ? data.days : [];
  } catch {
    timelineDays = [];            // 取不到就给空态，绝不弹错打断写信
  } finally {
    timelineLoading = false;
  }
  if (mailView === "timeline") renderLetterList();
}

async function loadCalendarMonth(month) {
  if (calMonthCache.has(month)) return;
  try {
    const data = await api(`/api/timeline?month=${encodeURIComponent(month)}`);
    calMonthCache.set(month, Array.isArray(data?.days) ? data.days : []);
  } catch {
    calMonthCache.set(month, []);  // 同上：回顾取不到就静默
  }
  if (mailView === "calendar" && calMonth === month) renderLetterList();
}

function setMailView(view) {
  mailView = view === "timeline" || view === "calendar" ? view : "list";
  const box = $("mailViewSwitch");
  if (box) {
    for (const btn of box.querySelectorAll(".mail-viewswitch-btn")) {
      const on = btn.dataset.view === mailView;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  if (mailView === "timeline") void loadTimeline();
  if (mailView === "calendar") {
    if (!calMonth) calMonth = localDayStr().slice(0, 7);
    void loadCalendarMonth(calMonth);
  }
  renderLetterList();
}

/** 视图切换与"时间轴/日历里的点击"都走这里 —— 一次性委托在 #letters 上，
 *  列表每 5 秒重画也不会重复挂监听（重复挂就会一次点击跑两遍）。 */
function bindMailReview() {
  const box = $("mailViewSwitch");
  if (box) {
    box.addEventListener("click", (event) => {
      const btn = event.target.closest(".mail-viewswitch-btn");
      if (btn) setMailView(btn.dataset.view);
    });
  }
  const host = $("letters");
  if (!host) return;
  host.addEventListener("click", (event) => {
    const nav = event.target.closest(".cal-nav");
    if (nav) {
      const [y, m] = (calMonth ?? localDayStr().slice(0, 7)).split("-").map(Number);
      const next = new Date(y, m - 1 + Number(nav.dataset.step), 1);
      calMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
      void loadCalendarMonth(calMonth);
      renderLetterList();
      return;
    }
    const cell = event.target.closest(".cal-cell");
    if (cell && cell.dataset.day) {
      const days = calMonthCache.get(calMonth) ?? [];
      const hit = days.find((d) => d.day === cell.dataset.day);
      if (hit?.letters?.length) selectLetter(String(hit.letters[0].id));
      else if (hit?.diary?.excerpt) toast(`那天她写：${hit.diary.excerpt}`);
      return;
    }
    const diary = event.target.closest(".timeline-diary");
    if (diary) {
      if (diary.dataset.excerpt) toast(`那天她写：${diary.dataset.excerpt}`);
      return;
    }
    const row = event.target.closest(".timeline-row");
    if (row?.dataset.id) selectLetter(row.dataset.id);
  });
}

function renderLetterList() {
  const host = $("letters");
  const count = $("mailCount");
  if (count) count.textContent = String(lettersCache.length);
  if (!host) return;
  // ★ 三种看法共用这一个出口：列表每 5 秒轮询重画，时间轴/日历也一样重画 ——
  //   所以重画前后要把滚动位置保住，否则每 5 秒被拽回顶部（这条是实测出来的，不是预防）。
  const keepScroll = host.scrollTop;
  if (mailView === "timeline") {
    renderTimeline(host);
    host.scrollTop = keepScroll;
    return;
  }
  if (mailView === "calendar") {
    renderCalendar(host);
    host.scrollTop = keepScroll;
    return;
  }
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
  host.scrollTop = keepScroll;
}

/** 时间轴：按本地日倒序，一天一块，她写的日记与两边来往混在同一条线上。
 *  ★ 数据只来自 /api/timeline（服务端聚合），前端不自己算哪天有什么 —— 两边口径必须只有一份。 */
function renderTimeline(host) {
  if (timelineDays === null) {
    // 还没取过：先让空态不至于空白，同时去拉一次（拉回来会自己重画）。
    host.innerHTML = `<p class="hint" style="padding:8px 12px">正在把来往按日子捋一遍…</p>`;
    void loadTimeline();
    return;
  }
  if (!timelineDays.length) {
    host.innerHTML = `<p class="hint" style="padding:8px 12px">这阵子还没有可以回头翻的东西。</p>`;
    return;
  }
  host.innerHTML = timelineDays.map((item) => {
    const [y, m, d] = String(item.day).split("-").map(Number);
    const weekday = WEEKDAY_CN[new Date(y, m - 1, d).getDay()];
    const bits = [];
    if (item.letterCount) bits.push(`${item.letterCount} 封`);
    if (item.hasDiary) bits.push("日记");
    const diary = item.diary
      ? `<div class="timeline-diary" data-excerpt="${escapeHtml(item.diary.excerpt ?? "")}" role="button" tabindex="0">
           <span class="timeline-diary-tag">她的日记</span>
           <span class="timeline-text">${escapeHtml(item.diary.excerpt ?? "")}</span>
         </div>`
      : "";
    const rows = (item.letters ?? []).map((letter) => {
      const her = letter.origin === "proactive";
      // ★ 状态点要能一眼分开四种（差距分析点名的判据就是"区分已回/待回/失败"）：
      //   失败=橙红、她写的=暖灰、我已寄且她已回=绿、我已寄她还没回=中性灰。
      //   以前这里照抄列表图标的 is-pending 深色（#2F3036），在暗底上等于看不见。
      const replied = letter.status === 4;
      const dotClass = letter.failed ? "is-error" : her ? "is-her" : replied ? "is-send" : "is-waiting";
      const tail = letter.failed ? "没写成" : her ? "她先写的" : "我写的";
      const unread = letter.is_read === 0 && !her ? " timeline-row-unread" : "";
      return `<div class="timeline-row${unread}" data-id="${escapeHtml(letter.id)}" role="button" tabindex="0">
        <span class="timeline-dot ${dotClass}"></span>
        <span class="timeline-text">${escapeHtml(letter.preview || "（空信）")}</span>
        <span class="timeline-row-meta">${escapeHtml(clockOf(letter.created_at))} · ${escapeHtml(tail)}</span>
      </div>`;
    }).join("");
    return `<div class="timeline-day">
      <div class="timeline-date">
        <span class="timeline-date-md">${m} 月 ${d} 日</span>
        <span class="timeline-date-wd">周${weekday}</span>
        <span class="timeline-date-count">${escapeHtml(bits.join(" · "))}</span>
      </div>
      <div class="timeline-items">${diary}${rows}</div>
    </div>`;
  }).join("");
}

/** 日历：一个月的格子，哪天有信/有日记就把那格点亮；点某天跳到那天。
 *  ★ 周一开头（国产日记类应用的通行排法），不是周日。 */
function renderCalendar(host) {
  const month = calMonth ?? localDayStr().slice(0, 7);
  const days = calMonthCache.get(month);
  const [y, m] = month.split("-").map(Number);
  const nav = `<div class="cal-head">
      <button class="cal-nav" type="button" data-step="-1" aria-label="上个月">‹</button>
      <span class="cal-title">${y} 年 ${m} 月</span>
      <button class="cal-nav" type="button" data-step="1" aria-label="下个月">›</button>
    </div>`;
  if (!days) {
    host.innerHTML = `${nav}<p class="hint" style="padding:8px 12px">正在翻这个月…</p>`;
    void loadCalendarMonth(month);
    return;
  }
  const marks = new Map(days.map((item) => [item.day, item]));
  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // 周一 = 0
  const total = new Date(y, m, 0).getDate();
  const today = localDayStr();
  const blanks = Array.from({ length: firstWeekday }, () => `<span class="cal-cell is-blank"></span>`).join("");
  const cells = Array.from({ length: total }, (_, i) => {
    const dayNum = i + 1;
    const day = `${month}-${String(dayNum).padStart(2, "0")}`;
    const hit = marks.get(day);
    const dots = [
      hit?.letterCount ? `<i class="cal-dot is-letter"></i>` : "",
      hit?.hasDiary ? `<i class="cal-dot is-diary"></i>` : "",
    ].join("");
    const cls = ["cal-cell"];
    if (hit?.letterCount || hit?.hasDiary) cls.push("has-mark");
    if (day === today) cls.push("is-today");
    return `<button class="${cls.join(" ")}" type="button" data-day="${day}">
      <span class="cal-cell-num">${dayNum}</span>
      <span class="cal-dots">${dots}</span>
    </button>`;
  }).join("");
  host.innerHTML = `${nav}
    <div class="cal-weekdays">${["一", "二", "三", "四", "五", "六", "日"].map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="cal-grid">${blanks}${cells}</div>`;
}

/** ★ 2026-10-21：往年今日——打开时若"去年的今天"有信件或她的日记，在信箱顶部给一行淡字提示。
 *  后端 /api/onthisday 已就绪（纯本机查 letters+diary 的同年月日）。只读，不改任何数据；
 *  取不到就静默隐藏，绝不打扰写信主流程（这是锦上添花的回顾，不是主功能）。
 */
async function loadOnThisDay() {
  const el = $("onThisDay");
  if (!el) return;
  try {
    const data = await api("/api/onthisday?years=1");
    const letters = Array.isArray(data?.letters) ? data.letters : [];
    const diary = data?.diary || null;
    if (!letters.length && !diary) { el.hidden = true; return; }
    const mmdd = String(data?.day || "").slice(5);   // 2025-10-21 → 10-21
    const bits = [];
    if (letters.length) bits.push(`你写过 ${letters.length} 封`);
    if (diary) bits.push("她写过一篇日记");
    el.innerHTML = `<span class="onthisday-lead">去年的今天（${escapeHtml(mmdd)}）</span>，${escapeHtml(bits.join("，"))}`;
    el.hidden = false;
    el.onclick = () => {
      if (letters.length && letters[0]?.id) selectLetter(String(letters[0].id));
      else if (diary?.excerpt) toast(`去年的今天她写：${diary.excerpt}`);
    };
  } catch {
    el.hidden = true;   // 回顾功能取不到就静默，绝不弹错打扰写信
  }
}

/** ★ 2026-10-21：连续写信——你连着写了几天，信箱里给一行淡字。
 *  用户拍板的口径：不是勋章/积分/弹窗，也不飘红；断了不惩罚（streak 归零就隐藏，不提示"断了"）。
 *  数据来自 /api/writing-stats（只数你写的信，纯本机）。 */
async function loadWritingStreak() {
  const el = $("writingStreak");
  if (!el) return;
  try {
    const { streak = 0, thisMonth = 0 } = await api("/api/writing-stats");
    if (streak >= 2) {
      el.textContent = `你已经连续 ${streak} 天给她写信了 · 这个月写了 ${thisMonth} 封`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  } catch {
    el.hidden = true;   // 统计取不到就静默，绝不打扰写信主流程
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
  // ★ 右栏标题栏（2026-10-18 用户截图对照原版）：#mailHeader 一直是空 DOM，
  //   没有任何代码填它。原版选中一封后 header 显示「标题 + 时间」，没选中显示「欢迎来到信箱 + 日期」。
  //   顺带：没选中时 header 也别空着一块 —— 空态插画自己居中，header 藏掉更接近原版空态。
  const header = $("mailHeader");
  if (header) {
    if (item) {
      const her = item.origin === "proactive";
      const title = her ? "她写来一封" : firstLine(item.content) || "（空信）";
      header.innerHTML = `<div class="mail-content-header-text">
        <span class="mail-content-title">${escapeHtml(title)}</span>
        <span class="mail-content-sub">${escapeHtml(formatTime(item.replied_at || item.created_at))}</span>
      </div>`;
      header.hidden = false;
    } else {
      header.innerHTML = "";
      header.hidden = true;
    }
  }
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
    return {
      kind: "retry",
      from: "林离",
      when: formatTime(item.replied_at || item.created_at),
      text: item.error,
      canOpen: false,
      // ★ 2026-10-20：这张卡以前是死的 —— 版式是"失败可重试"，但没有任何动作可点。
      onRetry: () => retryLetter(item.id),
    };
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
  // 她还在写 —— 文案跟原版一致（zh-cn `mailbox_waiting_for_reply`）；卡片上真正显示的是
  // mail-ui.js 的 waitingBlock（圆形小视频 + 这行字），这里的 text 只是给无 JS 兜底/日志用。
  return { kind: "video", from: "林离", when: formatTime(item.created_at), text: "林离回信中...", canOpen: false };
}

/** ★ 走 api() 而不是裸 fetch：写操作服务端一律要 X-Linli-Token，
 *  以前这里没带令牌 ⇒ 401 被 catch 吞掉，"已读"这个动作其实从来没生效过。 */
function markRead(id) {
  api(`/api/letters/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
}

/** 把一封"生成失败"的信放回队列。
 *  ★ 为什么不在前端等结果：回信是模型写的，几秒到几十秒 —— 点了就回，卡片立刻回到
 *    「她还在写……」，剩下的交给那条 5 秒一次的列表轮询。
 *  ★ 服务端只认「真的失败过」的信；状态不对会回 409，这里照实弹出来，别假装已重排。 */
async function retryLetter(id) {
  try {
    await api(`/api/letters/${encodeURIComponent(id)}/retry`, { method: "POST" });
  } catch (error) {
    toast(error.message);
    throw error;              // 让卡片上的按钮恢复成"重试"
  }
  const item = lettersCache.find((l) => l.id === id);
  if (item) { item.status = 1; item.error = null; }
  invalidateTimeline();              // 重试成功后时间轴上那天的状态点要跟着变
  renderLetterList();
  renderReader();
  await loadLetters(id);
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
  invalidateTimeline();              // 刚寄出 ⇒ 时间轴/日历上今天要立刻点亮
  await loadLetters(id);             // 刚寄出的那封直接选中，右侧立刻变成"她还在写……"
  void loadWritingStreak();          // 刚寄出 ⇒ 连续天数/本月封数当场刷新
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
// 照原版程序（public/
// game-favorites.js）的交互：曲目行上「加播单」→ 弹出歌单列表 → 勾选即写入、
// 取消什么都不做；再点同一个按钮收回。原版程序那份是注入进原版游戏的，
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

/** 曲库目录输入框的 title 同步（七轮审查 F8：长路径会被裁，实测 scrollWidth 442 > clientWidth 318）。
 *  输入框能横向滚动，不算功能缺陷，但新用户第一眼看到的路径就可能被切断，
 *  所以把完整值挂到 title 上，悬停能看全。
 *  ★ 空值时退回 `placeholder`：这台机器没设过 library_dir 时，框里显示的是默认曲库目录
 *    （placeholder），此时 title 也得跟着显示那条路径，否则悬停只看到一句废话。 */
function syncDirTitle() {
  const el = $("libraryDir");
  if (!el) return;
  const shown = (el.value || el.placeholder || "").trim();
  el.title = shown ? `曲库目录：${shown}` : "曲库目录（路径长时可悬停看全）";
}

async function loadLibrary() {
  try {
    const data = await api("/api/library");
    $("libraryDir").value = data.dir ?? "";
    syncDirTitle();
    const total = data.count ?? 0;
    // ★ 2026-10-19（第十六轮审查 P1）：曲库目录默认值不再是开发机路径。
    //   `needPick` = 还没选过目录 —— 这不是错误，是"还没开始"；文案不能写成
    //   "目录不存在"，新用户第一次打开会以为程序坏了。
    const needPick = Boolean(data.needPick);
    const note = needPick
      ? "还没选曲库目录 —— 在设置里选一个放曲目的文件夹"
      : data.error || `${total} 首`;
    // ★ 这个宿主在曲库页重做时删掉了（右栏换成了「音乐桌面」）。这里必须带 `?.`：
    //   裸写 `$("libraryState").textContent` 会在解构 null 时抛异常，被外层 catch
    //   吞成一句 toast，而**后面的 renderSongs() 就永远不执行** —— 表现是
    //   「曲库目录填了、接口也返回 2584 首，列表却一首都不显示」。
    const state = $("libraryState");
    if (state) state.textContent = note;
    allSongs = data.songs ?? [];
    // 首装引导与列表互斥：没指目录时把列表让出来，给一条能走的路。
    const guide = $("libEmpty");
    if (guide) guide.hidden = !needPick;
    const list = $("songs");
    if (list) list.hidden = needPick;
    // 设置页那一行要把**分档结果**摊开写出来 —— 这是"导入时自动分类"这件事的凭据：
    // 用户扫一眼就知道分完了，分成了几档，不用自己去点页签数。
    if ($("libraryState2")) {
      $("libraryState2").textContent = needPick
        ? "还没选曲库目录 —— 点「更改」挑一个放曲目的文件夹。"
        : data.error
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
 *  `#` 序号 + 48×48 圆角封面 + 曲名(18px) + 副标题 `作曲家 · 时长`(12px)
 *  + 模式列 + 行末 hover 才出现的「试听 / 加播单」。
 *  ★ 原版口径（`analysis\_original-ui\feapp\assets\main-31595bd3.js` @368356 的
 *    SongCard 调用点 + 骨架屏尺寸）：序号 `w-[20px] px-[18px]`、封面 `w-[48px] h-[48px]
 *    rounded-2`、标题 `flex-1 h-[36px]`、模式 `w-[60px]`、动作区 `w-[170px]`；
 *    副标题就是 `作曲家 · 时长`，语言包 `Ke="试听"`、`Rs="加播单"`、`de="播放"`。
 *  ★ 原版没有 emoji，缩略图一律用文字/色块。
 *  ★ 时长还没读（ffprobe 属于第 2 步「曲名与时段」的活），这里先只出作曲家；
 *    没作曲家就退回落款 `mode`，绝不编一个数字上去。
 */
function songRow(song, index) {
  const inDesk = deskSongs.some((s) => s.dir === song.dir);
  const on = song.dir === player.dir;
  // 「官方」标记：目录名符合原版 TOD 命名（<曲名>_TOD1200/1730/2000_*_L.mp4）的，
  // 能按当前时段出片；其余是用户自己放进来的。标记用来解释"为什么这首点开是黑的"。
  const official = song.todVariants > 0;
  const initial = (song.name ?? "?").trim().charAt(0) || "?";
  const sub = [song.composer, song.duration].filter((x) => x).join(" · ") || (song.mode ?? "");
  // 「加播单」只在已入库的曲目上出现：歌单条目要求曲目在 songs 表里
  // （服务端 POST /api/folders/:id/items 会回 LIBRARY_SONG_NOT_FOUND），
  // 界面上就别给一个点了必然失败的按钮。
  const addBtn = inDesk
    ? `<button class="song-item-add" data-add-folder="${escapeHtml(song.dir)}" type="button" title="加进歌单">加播单</button>`
    : "";
  // ★ 2026-10-19：封面。以前这一格只有曲名首字母，用户说「没有封面太难看了」。
  //   现在服务端在 `/api/library` 里给出 `song.cover`（官方 129 首才有；图从本机原版
  //   缓存里流出来，见 app/covers.mjs）。<img> 加载失败就把 img 摘掉、退回首字母块，
  //   别让列表里出现一排碎图标。
  const coverCell = song.cover
    ? `<img class="song-item-cover-img" src="${escapeHtml(song.cover)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : "";
  return `<div class="song-item${on ? " song-item-on" : ""}" data-dir="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" title="${escapeHtml(song.dir)}">
    <span class="song-item-num">${index + 1}</span>
    <span class="song-item-play" aria-hidden="true"></span>
    <span class="song-item-cover">${coverCell}<span class="song-item-cover-fallback">${escapeHtml(initial)}</span></span>
    <span class="song-item-content">
      <span class="song-item-title">${escapeHtml(song.name)}${official ? `<span class="song-item-official" title="有原版分时段的演奏视频">官方</span>` : ""}</span>
      <span class="song-item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="song-item-mode">${escapeHtml(song.mode ?? "")}</span>
    <span class="song-item-actions">
      <button class="song-item-audition" data-audition="${escapeHtml(song.dir)}" type="button" title="淡入听一下这首">试听</button>
      ${addBtn}
      ${inDesk
        ? `<button class="song-item-remove" data-remove-song="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" type="button" title="从音乐桌面移出">移出</button>`
        : `<button class="song-item-import" data-import="${escapeHtml(song.dir)}" data-name="${escapeHtml(song.name)}" type="button">入库</button>`}
    </span>
  </div>`;
}

/** 「加播单」下拉：列出全部歌单，勾选即加入，取消什么都不做。
 *  ★ 照原版程序 game-favorites.js 的行为 —— 再点同一个按钮就收回，
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
 *  ③ 行可以拖拽重排（原版程序 folder-manager.js 那边也是拖拽排序）。 */
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
      //   2026-10-20：从 window.confirm 换成自绘弹层 —— 原生弹框这一族在 WebView2 里
      //   全靠宿主设置，prompt 已经实测是静默失效的；一处病一次治完，别再赌第二个。
      const ok = await askDialog({
        title: "删除歌单",
        hint: `删除「${f.name}」？里面的曲目不会从曲库里消失，只是这个歌单没了。`,
        input: false,
        okText: "删除",
        danger: true,
      });
      if (!ok) return;
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

/**
 * 页面自绘的「问一句话」弹层。★ 2026-10-20 新增，替掉 window.prompt / window.confirm。
 *
 * 为什么非做不可：上一版 askFolderName() 用的是 `window.prompt()`，而 **WebView2 里
 * prompt 不弹窗、静默返回 null** —— 用户点「＋」建歌单，界面一动不动；建不出歌单，
 * 曲目上的「加播单」也就永远是空的。用户的原话是「咱们的歌单功能是摆设」。
 *
 * 用法（一个组件三种形态）：
 *   askDialog({ title, hint, value })                 → 返回输入的名字（取消返回 null）
 *   askDialog({ title, hint, input: false })          → 返回 true（取消返回 null）
 *   askDialog({ title, hint, input: false, danger: true }) —— 只是把确定键标红
 *
 * ★ Esc / 点遮罩 / 点 ✕ / 点取消 一律 resolve(null)：调用方只需要判 null。
 * ★ 每次打开都把输入框清空再填，避免上一次的值残留（改名时最容易被看到）。
 */
function askDialog({ title, hint = "", value = "", okText = "确定", input = true, danger = false }) {
  return new Promise((resolve) => {
    const modal = $("askModal");
    const elTitle = $("askTitle");
    const elHint = $("askHint");
    const elInput = $("askInput");
    const okBtn = $("askOk");
    if (!modal || !elTitle || !elHint || !elInput || !okBtn) { resolve(null); return; }

    elTitle.textContent = title;
    elHint.textContent = hint;
    elHint.hidden = !hint;
    elInput.hidden = !input;
    elInput.value = input ? String(value ?? "") : "";
    okBtn.textContent = okText;
    okBtn.classList.toggle("is-danger", !!danger);

    let done = false;
    const cleanup = () => {
      modal.hidden = true;
      modal.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey, true);
      okBtn.removeEventListener("click", onOk);
    };
    const finish = (v) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(v);
    };
    const submit = () => {
      if (!input) { finish(true); return; }
      const name = elInput.value.replace(/\s+/gu, " ").trim();
      // 空名字不能提交：否则会建出一个没有名字、在页签上点不到的幽灵歌单。
      if (!name) { elHint.textContent = "名字不能空着"; elHint.hidden = false; elInput.focus(); return; }
      finish(name);
    };
    const onOk = () => submit();
    const onClick = (e) => { if (e.target?.dataset?.askClose === "1") finish(null); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };

    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey, true);

    modal.hidden = false;
    if (input) { elInput.focus(); elInput.select(); }
    else { okBtn.focus(); }
  });
}

/** 新建 / 改名歌单：问一个名字。取消返回 null。 */
async function askFolderName(current) {
  const name = await askDialog({
    title: current ? "歌单改名" : "新建歌单",
    hint: current ? "改个名字，里面的曲目不受影响。" : "起个名字，最多 40 个字。建好后在曲目行上点「加播单」就能往里放歌。",
    value: current ?? "",
    okText: current ? "改名" : "新建",
  });
  return name || null;
}

/** 曲库页右栏「音乐桌面」：原版那张卡片的同款。
 *  标题 + 首数 + 右上「歌单」按钮 + 居中唱机插画 + 「暂无曲目」，
 *  有曲目时插画收小、下面列出曲目（点一首就在桌面壁纸层放）。
 *  ★ 原版空态文案 `Z="暂无曲目"`，标题 `Y="音乐桌面"`。 */
function renderDesk() {
  const count = $("deskCount");
  if (count) count.textContent = String(deskSongs.length);
  const art = document.querySelector(".desk-art");
  const empty = $("deskEmpty");
  const list = $("deskList");
  if (!list) return;
  const has = deskSongs.length > 0;
  art?.classList.toggle("is-small", has);
  if (empty) empty.hidden = has;
  list.hidden = !has;
  if (!has) { list.innerHTML = ""; return; }
  // ★ 2026-10-20：每行右边加一颗「×」＝从音乐桌面移出（用户：「添加进音乐结果删不掉了」）。
  //   行本身从 <button> 改成 <div role="button">：button 里不能嵌 button，
  //   嵌套按钮在 Chromium 里会把内层那个直接吃掉（点了变成播这首）。
  list.innerHTML = deskSongs.map((s, i) => `
    <div class="desk-row${s.dir === player.dir ? " on" : ""}" data-dir="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}"
         role="button" tabindex="0" title="${escapeHtml(s.dir)}">
      <span class="desk-row-num">${i + 1}</span>
      <span class="desk-row-name">${escapeHtml(s.name)}</span>
      <button class="desk-row-remove" data-remove-song="${escapeHtml(s.dir)}" data-name="${escapeHtml(s.name)}"
              type="button" title="从音乐桌面移出" aria-label="从音乐桌面移出">×</button>
    </div>`).join("");
  for (const row of list.querySelectorAll(".desk-row")) {
    const start = () => { if (!row.classList.contains("is-gone")) void play(row.dataset.dir, row.dataset.name); };
    row.addEventListener("click", (e) => {
      // 点「×」不播这首（那颗按钮自己有处理器，这里只负责别抢）
      if (e.target.closest("[data-remove-song]")) return;
      start();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); }
    });
  }
}

$("deskListBtn")?.addEventListener("click", async () => {
  // ★ 2026-10-20：这颗按钮原来**只弹一句 toast**（"音乐桌面上一共 N 首…"），
  //   跟"歌单"两个字毫无关系 —— 用户把整块功能叫「摆设」，它要负一半责任。
  //   现在真的去歌单：一个都没有就先建，有就打开第一个（页签行最右边的「＋」还能再加）。
  if (!folders.length) {
    const name = await askFolderName(null);
    if (name) await createFolder(name);
    return;
  }
  await openFolder(folders[0].id);
  toast(`已打开歌单「${folders[0].name}」。页签行最右边的「＋」可以再建一个。`);
});

/** 「音乐桌面」上的曲子。曲库表格要知道哪些已入库，所以两边共用同一份数据。
 *  ★ 2026-10-19：用户口径「曲库页面和原版的排版一点都不像」——左栏那排「已入库」chip
 *    和底部页脚都不是原版的东西，已从 HTML 里摘掉。这里只负责把数据落进 deskSongs
 *    并刷新右栏那张「音乐桌面」卡片，不再往页面上画替代品。
 *  ★ 「先落数据、再管渲染」这条依然成立：早先的写法是 `if (!host) return;` 提前返回，
 *    结果 deskSongs 永远是空数组 —— 「N 首在桌面」恒显示"桌面还是空的"，
 *    曲库行上的「加播单」按钮也一个都不出现。 */
async function loadImported() {
  try {
    const { songs } = await api("/api/library/songs");
    deskSongs = songs ?? [];
    renderDesk();
  } catch (error) {
    toast(error.message);
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

/** 从「音乐桌面」拿走一首（2026-10-20 用户：「我添加进音乐结果删不掉了」）。
 *  ★ 以前只有入库、没有出库：界面上那颗按钮在入库后变成「已在桌面」，点了还是 upsert，
 *    所以用户加进来就再也拿不掉。现在同一个位置变成「移出」，点了先问一句（不可逆）。
 *  ★ 只从 songs 表里删（＝桌面清单），**不动磁盘上的曲子文件**，也不动曲库扫描结果 ——
 *    想要还能再点「入库」加回来。
 */
async function removeSong(dir, name) {
  const ok = await askDialog({
    title: "从音乐桌面移出",
    hint: `${name} —— 只是从桌面清单里拿走，曲子文件还在，随时可以再入库。`,
    input: false,
    okText: "移出",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/library/songs?dir=${encodeURIComponent(dir)}`, { method: "DELETE" });
    toast(`已移出：${name}`);
    await loadImported();
    renderSongs();
  } catch (error) {
    toast(error.message);
  }
}

/** 「试听」：淡入放 15 秒就停，不写库、不动队列、不碰桌面壁纸。
 *  ★ 照原版程序「试听起名」的听感约定（听 15 秒）：15 秒够听出旋律，又不会让用户
 *    以为自己在正式播放。音量从 0 淡入 0.35 秒，避免突兀地响一下。
 *  ★ 用的是独立的 Audio 对象，不复用底部播放条 —— 试听不该改变「现在在放哪首」。
 */
let auditionAudio = null;
let auditionTimer = null;
const AUDITION_MS = 15000;

function stopAudition() {
  if (auditionTimer) { clearTimeout(auditionTimer); auditionTimer = null; }
  if (auditionAudio) {
    auditionAudio.pause();
    auditionAudio.src = "";
    auditionAudio = null;
  }
  for (const el of document.querySelectorAll(".song-item-audition.is-on")) el.classList.remove("is-on");
}

async function auditionSong(dir) {
  // 再点同一个按钮就停（原版试听是开关行为）。
  const wasOn = auditionAudio?.dataset?.dir === dir;
  stopAudition();
  if (wasOn) return;
  const song = allSongs.find((s) => s.dir === dir);
  if (!song) return;
  // 曲线：问后端要这首在当前时段的那段片子里的音轨地址。没有片子就没法试听
  // —— 明说原因，别让用户以为按钮坏了。
  const data = await api(`/api/stage/next?dir=${encodeURIComponent(dir)}`);
  if (!data?.url) {
    toast(codeText("这首在当前时段没有演奏视频，试听不了", "LIBRARY_NO_VIDEO"));
    return;
  }
  const audio = new Audio(data.url);
  audio.dataset.dir = dir;
  audio.volume = 0;
  auditionAudio = audio;
  const btn = document.querySelector(`[data-audition="${CSS.escape(dir)}"]`);
  btn?.classList.add("is-on");
  try {
    await audio.play();
  } catch {
    stopAudition();
    toast(codeText("试听没能开始播放", "LIBRARY_AUDITION_FAILED"));
    return;
  }
  // 淡入到 0.35：15 秒的短听不需要满音量，也免得盖住用户正在听的别的东西。
  const t0 = performance.now();
  const fadeIn = () => {
    if (auditionAudio !== audio) return;
    const k = Math.min(1, (performance.now() - t0) / 350);
    audio.volume = 0.35 * k;
    if (k < 1) requestAnimationFrame(fadeIn);
  };
  requestAnimationFrame(fadeIn);
  auditionTimer = setTimeout(stopAudition, AUDITION_MS);
}

// 列表里的点击：点整行＝播放（原版点曲目就直接进演奏页），末尾那个按钮＝入库
$("songs")?.addEventListener("click", (event) => {
  const imp = event.target.closest("[data-import]");
  if (imp) {
    event.stopPropagation();
    return void importSong(imp.dataset.import, imp.dataset.name);
  }
  // ★ 2026-10-20：「移出音乐桌面」。必须拦在「点整行＝播放」前面，
  //   否则点这颗按钮会顺带把那首曲子播起来（然后在删除途中被打断）。
  const rem = event.target.closest("[data-remove-song]");
  if (rem) {
    event.stopPropagation();
    return void removeSong(rem.dataset.removeSong, rem.dataset.name);
  }
  const add = event.target.closest("[data-add-folder]");
  if (add) {
    event.stopPropagation();
    return void openAddToFolderMenu(add, add.dataset.addFolder);
  }
  // 「试听」：淡入放一小段就停，不入库、不动队列 —— 原版 `Ke="试听"`。
  // 它必须拦在「点整行＝播放」前面，否则试听会变成正式播放并顶掉当前曲。
  const audition = event.target.closest("[data-audition]");
  if (audition) {
    event.stopPropagation();
    return void auditionSong(audition.dataset.audition);
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

// ★ 2026-10-19：窗口里**不再有自己的播放器**（用户口径 m01034：点播放是放到桌面上放）。
//   这里只留"现在桌面在放哪首"这一份状态，给播放条、列表高亮、右栏那行用。
//   以前那套（playVideoA/B 双缓冲、end 事件续播、30 秒时段轮询、跨时段预热、
//   交叉淡入）整套删掉 —— 桌面那层（wallpaper.html）里本来就有一份更完整的实现，
//   两边各播一份只会一份无声、一份重复解码。
let player = { dir: null, name: null, tod: null };

function stopPlayerWatch() {
  player = { dir: null, name: null, tod: null };
}

/** 给外壳发消息（不在原生窗口里就静默丢弃）。 */
function tellShell(action) {
  try { window.chrome?.webview?.postMessage(action); } catch { /* 浏览器里没有这个通道 */ }
}

/** 点一首播放 —— **放到桌面上放，不在窗口里放**。
 *  ★ 2026-10-19（用户口径 m01034）：「程序内点播放按钮是要把视频播放到桌面，
 *    不是在程序内播放，因为这个程序是作为桌面壁纸的」。
 *    所以这里改成：把这一首钉成"桌面该放的那首"（POST /api/stage/play），
 *    再让外壳去通知桌面那层立刻换片；窗口里那套视频（playVideoA/B、结束续播、
 *    30 秒时段轮询、预热）全部不要了 —— 那些逻辑在桌面那层（wallpaper.html）里已有一份。
 *  ★ 为什么还要 writePlayerMeta / paintNowPlaying：窗口里的播放条与列表高亮得知道
 *    "现在桌面在放哪首"，不然点了播放、界面上一点反应都没有，看起来像没点中。
 */
async function play(dir, name) {
  try {
    // 先把窗口里那套播放器停掉（老版本可能已经起了）
    stopPlayerWatch();
    const info = await api("/api/stage/play", { method: "POST", body: { dir } });
    if (!info.url) return toast(codeText("这首曲子在这个时段没有可用的视频", "LIBRARY_SONG_NOT_FOUND"));
    pbState = { t: 0, d: 0, playing: false, has: false };   // 换曲：上一首的进度作废，等新一秒的报表
    player.dir = dir;
    player.name = name ?? info.title ?? "";
    player.tod = info.tod;
    writePlayerMeta(info, player.name);
    paintNowPlaying();
    // 时段/变体数在 info 里，进度条这边没有真在播的 video，只能停在 0。
    paintProgress();
    setSetting2("last_played_title", player.name);
    // ★ 告诉外壳"桌面那层该换片了"：wallpaper.html 收到立刻重跑一次 tick()，
    //   不用等它自己的 30 秒轮询 —— 点了播放桌面却半分钟后才变，用户会以为没生效。
    tellShell("stage:changed");
    // 「最近演出」的时间会从「刚刚」一路走到「n 分钟前」，条数也可能变。
    loadRecent().then(() => renderLibTabs()).catch(() => {});
    renderSongs();                     // 让正在播的那一行亮起来
    loadImported();
    toast(`已在桌面播放：${player.name}`);
  } catch (error) {
    toast(error.message);
  }
}

/** 回到待机（桌面放 Wallpaper_Presence 的待机视频与环境音）。
 *  ★ 2026-10-20（用户原话：「我点了暂停画面直接卡住了，不应该是点了暂停以后回到待机吗」）：
 *    曲库底部播放条的播放键就是这个语义 —— 在放 ⇒ 回待机；没在放 ⇒ 播列表第一首。
 *    **不做"画面冻结式暂停"**。之前把它当死代码删了，用户一句话判回来 ——
 *    删代码前先想清楚交互语义。
 *  ★★ 2026-10-20 续播（用户原话：「咱们程序没有暂停后再点播放续播的功能，咱们的原版程序
 *    有，直接抄过来」）：pauseAt 传秒数 ⇒ 先 POST /api/stage/pause 把断点（哪首 + 第几秒）
 *    记到服务端再回待机；下次点播放键时 resumePaused() 会把它接回来。不传 ⇒ 老的
 *    "直接回待机"（断点一并作废）。 */
async function playIdle(pauseAt = null) {
  try {
    stopPlayerWatch();
    if (pauseAt != null) {
      await api("/api/stage/pause", { method: "POST", body: { t: pauseAt } });
    } else {
      await api("/api/stage/play", { method: "POST", body: { idle: true } });
    }
    player.dir = "";
    player.name = "";
    writePlayerMeta(null, "");
    pbState = { t: 0, d: 0, playing: false, has: false };   // 回待机后不再有进度可画
    paintNowPlaying();
    paintProgress();
    tellShell("stage:changed");
    renderSongs();
    toast(pauseAt != null ? "已暂停，桌面回到待机（再点播放从断点继续）" : "桌面回到待机");
  } catch (error) {
    toast(error.message);
  }
}

/** 有暂停断点就从断点续播（原版程序语义）。返回 true = 已经接手；false = 没有断点。
 *  ★ 续播就是普通点播（POST /api/stage/play）多带一个 resumeT 参数 —— 入库、
 *    最近演出、外壳通知全部复用同一条路；桌面那层由服务端 15 秒窗口里的 resumeT
 *    从断点起播（wallpaper.html crossFade 的 startAt）。 */
async function resumePaused() {
  const st = await api("/api/stage/pause");
  if (!st || !st.paused) return false;
  const info = await api("/api/stage/play", { method: "POST", body: { dir: st.dir, resumeT: st.t } });
  if (!info.url) { toast(codeText("这首曲子在这个时段没有可用的视频", "LIBRARY_SONG_NOT_FOUND")); return true; }
  pbState = { t: st.t ?? 0, d: 0, playing: true, has: true };   // 总时长等下一秒的报表补上
  player.dir = st.dir;
  player.name = st.title ?? info.title ?? "";
  player.tod = info.tod;
  writePlayerMeta(info, player.name);
  paintNowPlaying();
  paintProgress();
  renderSongs();
  tellShell("stage:changed");
  toast(`继续播放：${player.name}（从 ${mmss(st.t ?? 0)} 开始）`);
  return true;
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

// ---- 曲库页底部那条控制条（原版是 webplayer 独立的 PlaybackView，这里收成一条浮在底部） ----
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

// ★ 2026-10-20 定稿（用户两句话合并）：
//   「我点了暂停画面直接卡住了，不应该是点了暂停以后回到待机吗」
//   「咱们程序没有暂停后再点播放续播的功能，咱们的原版程序有，直接抄过来」
//   ⇒ 播放键三态：
//     ① 在放     ⇒ 暂停：记断点（当前秒）+ 桌面回待机（不冻结画面）；
//     ② 有断点   ⇒ 续播：从断点那一秒接着放（服务端 15 秒窗口把 resumeT 带给桌面层）；
//     ③ 都不是   ⇒ 播当前列表第一首（老行为）。
$("pbPlay")?.addEventListener("click", () => {
  if (player.dir) return void playIdle(pbState.has ? pbState.t : null);
  resumePaused()
    .then((resumed) => {
      if (resumed) return;
      const first = playlist()[0];
      if (first) play(first.dir, first.name);
    })
    .catch((error) => toast(error.message));
});
$("pbPrev")?.addEventListener("click", () => step(-1));
$("pbNext")?.addEventListener("click", () => step(1));
// 循环方式：顺序 → 列表循环 → 单曲循环 → 随机，四态轮转。
// ★ 2026-10-19：真正的"播完接着放"发生在桌面那层（窗口关着也得继续走），
//   所以模式要**落库**、由服务端按队列算下一首（POST /api/stage/advance）。
//   这边只负责显示与改值；上次选的模式下次打开还在。
// ★ 2026-10-20：只画播放条那颗 #pbMode 了。曲库「音乐桌面」卡片上那个写模式名的
//   #deskMode 已经删掉 —— 用户口径：「在音乐桌面的单曲循环按钮就删了吧，
//   底下的播放条有一个了，要不就重复了」。播放条那颗是四态轮转的唯一入口。
function paintPlayMode() {
  const mode = PLAY_MODES[playMode] ?? PLAY_MODES[0];
  const barBtn = $("pbMode");
  if (barBtn) {
    barBtn.innerHTML = mode.icon;
    barBtn.title = mode.label;
    barBtn.classList.toggle("is-active", mode.key !== "order");
  }
}
/** 把模式同步到服务端；失败要说话，否则用户以为切过去了、桌面还按旧顺序走。 */
async function savePlayMode(mode) {
  try {
    await api("/api/stage/mode", { method: "POST", body: { mode } });
  } catch (error) {
    toast(error.message);
  }
}
async function loadPlayMode() {
  try {
    const { mode } = await api("/api/stage/mode");
    playMode = Math.max(0, PLAY_MODES.findIndex((m) => m.key === mode));
    paintPlayMode();
  } catch { /* 读不到就按默认的"顺序播放"显示 */ }
}
/** 四态轮转：顺序 → 列表循环 → 单曲循环 → 随机。两个入口（曲库工具行、播放条）共用。 */
function cyclePlayMode() {
  playMode = (playMode + 1) % PLAY_MODES.length;
  const mode = PLAY_MODES[playMode];
  paintPlayMode();
  toast(`播放顺序：${mode.label}`);
  void savePlayMode(mode.key);
}
$("pbMode")?.addEventListener("click", () => cyclePlayMode());
// ★ S36：这才是用户真正点得到的那个入口（#pbMode 在 hidden 的播放页里）。
// 静音：窗口里没有 video 了，声音在桌面那层 ⇒ 把"静音/取消静音"发给外壳转给壁纸页。
let shellMuted = false;
$("pbMute")?.addEventListener("click", (e) => {
  shellMuted = !shellMuted;
  tellShell(`stage:mute:${shellMuted ? "1" : "0"}`);
  // ★ 按钮里是内联 SVG，不能再改 textContent（会连 svg 一起抹掉）。
  //   静音态用"喇叭 + 一道斜杠"的 alt 图标整体替换 innerHTML。
  //   （这里不许用 emoji：原版全站零 emoji。）
  const btn = e.currentTarget;
  btn.innerHTML = shellMuted
    ? `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h3l4.5-3.5v13L7 15H4z" fill="currentColor"/><path d="M15.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h3l4.5-3.5v13L7 15H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`;
  btn.title = shellMuted ? "取消静音" : "静音";
  toast(shellMuted ? "桌面已静音" : "桌面已取消静音");
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
/** ★ 2026-10-20：播放/暂停互换要的是暂停图标（两条竖杠），不是"停止"方块。 */
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4.5h3.4v15H7zM13.6 4.5H17v15h-3.4z" fill="currentColor"/></svg>`;
/** ICON_STOP 删了：旧 paintProgress 用它表示"桌面播放中"，现在换真暂停图标。 */
/** 四种循环方式（原版 ot 枚举：Repeat / Shuffle / Single / 顺序） */
const PLAY_MODES = [
  { key: "order", label: "顺序播放", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
  { key: "repeat", label: "列表循环", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9a5 5 0 0 1 5-5h9m0 0l-3-3m3 3l-3 3M20 15a5 5 0 0 1-5 5H6m0 0l3 3m-3-3l3-3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
  { key: "single", label: "单曲循环", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9a5 5 0 0 1 5-5h9m0 0l-3-3m3 3l-3 3M20 15a5 5 0 0 1-5 5H6m0 0l3 3m-3-3l3-3" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="16" font-size="8" fill="currentColor" text-anchor="middle">1</text></svg>` },
  { key: "shuffle", label: "随机播放", icon: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h4l12 12h-4M4 18h4L20 6h-4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
];
let playMode = 0;

/** 播放条的进度/按钮状态。
 *  ★ 2026-10-20：桌面壁纸层每秒上报真实进度（{playback:{t,d,playing}}，外壳转进来），
 *    有真进度就画真进度 + 播放/暂停图标互换；没有（还没收到报表 / 桌面没在放曲子）
 *    才退回旧口径（条子留空，文字如实说）。 */
let pbState = { t: 0, d: 0, playing: false, has: false };
function paintProgress() {
  const fill = $("pbFill"), play = $("pbPlay"), now = $("pbNow"), total = $("pbTime");
  if (!$("pbLine") || !fill || !play || !now || !total) return;
  if (pbState.has) {
    const pct = pbState.d > 0 ? Math.min(100, (pbState.t / pbState.d) * 100) : 0;
    fill.style.width = pct + "%";
    now.textContent = mmss(pbState.t);
    total.textContent = mmss(pbState.d);
    // ★ 播放/暂停互换图标走 innerHTML —— 按钮里是 svg，改 textContent 会连 svg 一起抹掉。
    play.innerHTML = pbState.playing ? ICON_PAUSE : ICON_PLAY;
    play.title = pbState.playing ? "暂停" : "播放";
    return;
  }
  const playing = Boolean(player.dir);
  fill.style.width = "0%";
  now.textContent = playing ? "桌面播放中" : mmss(0);
  total.textContent = playing ? "" : mmss(0);
  play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  play.title = playing ? "暂停" : "播放";
}

// 点进度条跳转（2026-10-20，**自研**——原版没有，用户明确要做）：
// 按点击横坐标算比例 ⇒ 目标秒数 ⇒ 发给外壳转给壁纸层设 currentTime。
$("pbLine")?.addEventListener("click", (e) => {
  if (!pbState.has || !(pbState.d > 0)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  tellShell(`seek:${(ratio * pbState.d).toFixed(3)}`);
});

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
  if (sub) sub.textContent = st?.tod ? `第 ${st.tod} 档` : "";
  if (cover) cover.textContent = (name.trim().charAt(0) || "♪").toUpperCase();
}

function setSetting2(key, value) { try { localStorage.setItem(key, value); } catch { /* 无痕模式下忽略 */ } }

$("saveLibraryDir")?.addEventListener("click", async () => {
  try {
    // ★ 2026-10-20（用户口径）：在外壳里点「更改」直接弹**系统的文件夹选择对话框**
    //   （原版就是这么做的），不再让用户手敲路径。浏览器里没有 host object ⇒ 退回手填。
    //   ★ 桥走 shellBridge()（.sync 同步代理）：模态对话框实测不卡死
    //     （探针 ModalTrap：1515ms 正常返回，见 analysis/_audit22/hostobj-probe）。
    const bridge = shellBridge();
    if (bridge) {
      // 同步代理直接回路径；await 对非 Promise 值是直通的，留着不碍事。
      const picked = await bridge.PickFolder("选择曲库文件夹");
      const dir = String(picked ?? "");
      if (!dir) return;                        // 用户取消 —— 什么都不改
      $("libraryDir").value = dir;
      syncDirTitle();
      await api("/api/library/dir", { method: "POST", body: { dir } });
      toast("已保存");
      await loadLibrary();
      return;
    }
    await api("/api/library/dir", { method: "POST", body: { dir: $("libraryDir").value.trim() } });
    syncDirTitle();
    toast("已保存");
    await loadLibrary();
  } catch (error) {
    toast(error.message);
  }
});

// 一边打字一边同步 title：不然改完路径要等到点「保存」才更新，鼠标先悬停上去就看到旧值。
$("libraryDir")?.addEventListener("input", syncDirTitle);

// 首装引导那颗按钮：直接把人送到设置页那一行，并聚焦目录输入框 ——
// 用户不用自己在一长页设置里找「曲目存储路径」在哪。
$("libEmptyPick")?.addEventListener("click", () => {
  show("settings");
  const dir = $("libraryDir");
  if (dir) {
    dir.focus();
    dir.select();
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

let memAll = { items: [], conflicts: [] };
let memShown = 20;

/** 搜索 / 字段筛选 / 分页（每页 20 条）。
 *  ★ 为什么在前端筛：一次 `/api/memory?...&limit=100` 已经把条目都拿回来了（服务端上限就是 100），
 *    再为每次敲键盘发一次请求只会让输入变卡；等哪天条目数超过 100 再换服务端搜索。
 *  ★ 冲突条目不受筛选影响：`renderMemItems` 里的「有 N 条不一致」说的是全量。 */
function memFiltered() {
  const q = ($("memSearch")?.value ?? "").trim().toLowerCase();
  const field = $("memField")?.value ?? "";
  return memAll.items.filter((it) => {
    if (field && it.field !== field) return false;
    if (!q) return true;
    return `${it.field} ${it.value}`.toLowerCase().includes(q);
  });
}

function paintMem() {
  const list = memFiltered();
  const active = memAll.items.filter((it) => it.status !== "deleted");
  const count = $("memCount");
  if (count) count.textContent = active.length ? `${list.filter((it) => it.status !== "deleted").length}/${active.length} 条` : "";
  const more = $("memMore");
  if (more) more.style.display = list.length > memShown ? "" : "none";
  renderMemItems(list.slice(0, memShown), memAll.conflicts);
  const sel = $("memField");
  if (sel) {
    const keep = sel.value;
    const fields = [...new Set(memAll.items.map((it) => it.field))].sort((a, b) => a.localeCompare(b, "zh"));
    sel.innerHTML = `<option value="">全部字段</option>${fields
      .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("")}`;
    sel.value = keep;
  }
}

async function loadMemory() {
  try {
    // ★ include_deleted=1：软删除的条目要能"恢复"，所以一次拉全；limit=100 是服务端上限。
    const data = await api("/api/memory?include_deleted=1&limit=100");
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
    memAll = { items: data.items ?? [], conflicts: data.conflicts ?? [] };
    paintMem();
    $("ctx").textContent = data.context ?? "";
  } catch (error) {
    toast(error.message);
  }
}

// ---------------------------------------------------------------- A1 记忆条目（可更正）
//
// ★ 这是这一版的重点：原来"她记住的东西"只有一块只读的 kv 列表，用户看到写错的
//   只能忍着；模型下一封又会按自己的推断覆盖回去。现在每条都是可操作的：
//   · 模型写的 ⇒ 「改成…」（在行内展开输入框）与「这条不对」（软删除）
//   · 你改过的 ⇒ 标「你改的」，并给「撤回」（回到模型那条）
//   · 被软删除的 ⇒ 折叠起来，给「恢复」
// ★ 交互上不做弹窗：行内展开、回车提交、Esc 取消 —— 编辑一条记忆不该打断读信。

function renderMemItems(items, conflicts) {
  const host = $("memList");
  const empty = $("memEmpty");
  const count = $("memCount");
  const conflictBox = $("memConflict");
  if (!host) return;
  const active = items.filter((it) => it.status !== "deleted");
  const removed = items.filter((it) => it.status === "deleted");
  // ★ 条数由 `paintMem()` 按**筛选后的全量**来写 —— 这里看到的只是当前这一页，
  //   拿它当条数会把「共 37 条」显示成「20 条」。
  if (empty) empty.style.display = items.length ? "none" : "block";
  if (conflictBox) {
    // ★ 冲突只提醒、不替用户决定：按"你改过的那条优先"走，但把"模型后来又写了什么"摆出来。
    const list = (conflicts ?? []).filter((c) => c.active);
    conflictBox.style.display = list.length ? "block" : "none";
    conflictBox.textContent = list.length
      ? `有 ${list.length} 条模型和你的说法不一致 —— 下面按"你改过的"显示，模型那条收在它下面。`
      : "";
  }
  const row = (it, isRemoved) => {
    const mine = it.origin === "user";
    return `
      <div class="mem-row${mine ? " mine" : ""}${isRemoved ? " gone" : ""}" data-id="${escapeHtml(it.id)}">
        <div class="mem-k">${escapeHtml(it.field)}</div>
        <div class="mem-v">${escapeHtml(it.value)}</div>
        <div class="mem-acts">
          ${isRemoved
            ? `<button class="lnk" data-mem="restore" type="button">恢复</button>`
            : `${mine ? `<span class="mem-tag">你改的</span>` : ""}
               <button class="lnk" data-mem="edit" type="button">改成…</button>
               ${mine
                 ? `<button class="lnk" data-mem="undo" type="button">撤回</button>`
                 : `<button class="lnk" data-mem="del" type="button">这条不对</button>`}`}
        </div>
        ${it.supersedes ? `<div class="mem-src">替换了模型原来的说法</div>` : ""}
        ${it.sourceLetterId ? `<div class="mem-src"><button class="lnk" data-mem="source" type="button">出自哪封信</button></div>` : ""}
      </div>`;
  };
  host.innerHTML = [
    ...active.map((it) => row(it, false)),
    ...(removed.length
      ? [`<div class="mem-gone-h">已经不要的（${removed.length}）</div>`, ...removed.map((it) => row(it, true))]
      : []),
  ].join("");
}

async function memAction(id, action, button) {
  const row = button.closest(".mem-row");
  const valueEl = row?.querySelector(".mem-v");
  try {
    if (action === "edit") {
      // 行内展开输入框：回车提交、Esc 取消（不做弹窗，见上面的注释）。
      if (row.querySelector("input.mem-edit")) return;
      const old = valueEl.textContent;
      valueEl.innerHTML = `<input class="mem-edit" type="text" maxlength="200" value="${escapeHtml(old)}">`;
      const input = valueEl.querySelector("input");
      input.focus();
      input.select();
      const done = async (commit) => {
        if (!commit || input.value.trim() === old.trim()) { valueEl.textContent = old; return; }
        await api(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: { value: input.value.trim() } });
        toast("记下了 —— 以后按你写的这条为准");
        await loadMemory();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); void done(true); }
        if (e.key === "Escape") { e.preventDefault(); valueEl.textContent = old; }
      });
      input.addEventListener("blur", () => { void done(false); });
      return;
    }
    if (action === "del") {
      await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("这条不当真了 —— 可以在这里恢复");
      await loadMemory();
      return;
    }
    if (action === "undo") {
      await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("撤回你的改法 —— 模型原来的说法回来了");
      await loadMemory();
      return;
    }
    if (action === "restore") {
      await api(`/api/memory/${encodeURIComponent(id)}/restore`, { method: "POST" });
      await loadMemory();
      return;
    }
    if (action === "source") {
      const src = await api(`/api/memory/${encodeURIComponent(id)}/source`);
      const t = src?.letter?.createdAt ?? src?.letter?.created_at;
      toast(t ? `这条出自 ${formatClock(t)} 那封信` : "这条不是从某封信里读出来的");
    }
  } catch (error) {
    toast(error.message);
    await loadMemory();
  }
}

$("memList")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mem]");
  if (!btn) return;
  const row = btn.closest(".mem-row");
  if (!row) return;
  void memAction(row.dataset.id, btn.dataset.mem, btn);
});

$("memSearch")?.addEventListener("input", () => { memShown = 20; paintMem(); });
$("memField")?.addEventListener("change", () => { memShown = 20; paintMem(); });
$("memMore")?.addEventListener("click", () => { memShown += 20; paintMem(); });

// ---------------------------------------------------------------- A2 她的日记

/** 日记列表：按天倒序，每篇折叠；展开时才拉全文与 facts（列表接口只给摘要）。 */
async function loadDiary() {
  const host = $("diaryList");
  if (!host) return;
  try {
    const data = await api("/api/diary?limit=30");
    const items = data.items ?? [];
    $("diaryCount").textContent = items.length ? `${items.length} 篇` : "";
    $("diaryEmpty").style.display = items.length ? "none" : "block";
    host.innerHTML = items.map((it) => `
      <details class="diary-item" data-day="${escapeHtml(it.day)}">
        <summary><span class="diary-day">${escapeHtml(it.day)}</span><span class="diary-ex">${escapeHtml(it.excerpt ?? "")}</span></summary>
        <div class="diary-body" data-loaded="0"></div>
      </details>`).join("");
  } catch (error) {
    toast(error.message);
  }
}

/** 展开一篇：正文 + 「这天发生过什么」（facts 原样摊开，方便核对有没有编）。 */
async function openDiary(day, box) {
  if (box.dataset.loaded === "1") return;
  try {
    const d = await api(`/api/diary/${encodeURIComponent(day)}`);
    const facts = typeof d.facts === "string" ? JSON.parse(d.facts) : (d.facts ?? {});
    const letters = Array.isArray(facts.letters) ? facts.letters : [];
    const plays = Array.isArray(facts.plays) ? facts.plays : [];
    const evidence = [
      letters.length ? `信 ${letters.length} 封` : "",
      plays.length ? `放过的曲子：${plays.map((p) => `${String(p.dir).replace(/_/gu, " ")}×${p.count}`).join("、")}` : "",
      facts.world ? `那天她在${facts.world.activity}` : "",
    ].filter(Boolean).join(" · ");
    box.innerHTML = `
      <div class="diary-text">${escapeHtml(d.body ?? "").replace(/\n/gu, "<br>")}</div>
      <div class="diary-facts">${evidence ? `这天发生过什么：${escapeHtml(evidence)}` : "这一天只有些零零碎碎的事。"}</div>`;
    box.dataset.loaded = "1";
  } catch (error) {
    box.textContent = error.message;
    toast(error.message);
  }
}

$("diaryList")?.addEventListener("toggle", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.open) return;
  const box = el.querySelector(".diary-body");
  if (box) void openDiary(el.dataset.day, box);
}, true);

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
//
// ★★ 2026-10-20（用户口径：「模型选择可以学习原版程序……不像咱们还要自己手动输入模型名，
//   模型界面全部都要学习原版程序」）：这张表从「给输入框当 datalist」升级成**下拉的正本** ——
//   界面上那个「选择模型」直接按 provider 分组列出来，选一条就把它的地址与型号一起填好；
//   只有选「自定义」才展开地址与型号两个输入框。整页只读这一份，HTML 里不抄第二份。
const PROVIDER_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4"],
    note: "deepseek-chat / deepseek-reasoner 已退役，别再填。",
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1"],
    note: "开放平台与 Z.ai 的编号节奏不同，以你的控制台为准。",
  },
  moonshot: {
    label: "Kimi 月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"],
    note: "国际区用 api.moonshot.ai。",
  },
  qwen: {
    label: "通义千问（百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3.7-plus", "qwen3.6-plus", "qwen-plus"],
    note: "阿里云百炼；新加坡、美国与 Coding Plan 是不同地址。",
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    models: ["MiniMax-M3", "MiniMax-M2.7"],
    note: "型号以官方控制台为准。",
  },
  custom: {
    label: "自定义 / 本地中转",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [],
    note: "本地或中转：自己填地址和模型名；地址不提供 /models 时也能直接填型号。",
  },
};
const CUSTOM_PRESET = "__custom__";

/** 地址归一：去掉尾部斜杠与误粘进来的 `/chat/completions` —— 与 server.mjs 的写法一致。 */
function normalizeModelBase(value) {
  return String(value ?? "").trim().replace(/\/+$/u, "").replace(/\/chat\/completions$/iu, "");
}

/** 扁平化的预设表：一条 = 一家 × 一个型号。下拉的 value 就是 `provider|model`。 */
function presetItems() {
  return Object.entries(PROVIDER_PRESETS).flatMap(([provider, preset]) =>
    (preset.models ?? []).map((model) => ({ provider, model, baseUrl: preset.baseUrl })));
}

/** 当前填的「地址 + 型号」正好等于清单里某一项时返回它，否则 null（= 自定义）。 */
function currentPreset() {
  const base = normalizeModelBase($("baseUrl").value);
  const model = $("modelName").value.trim();
  return presetItems().find((item) => item.model === model && normalizeModelBase(item.baseUrl) === base) ?? null;
}

/** ★ 2026-10-20：**已经保存、但不在清单里**的那一条（比如本机的 `deepseek-chat`）。
 *  它不是预设，是把用户现在的配置摆回下拉里 —— 否则页面一进来就落「自定义」，
 *  看着像"还得自己手敲"，而用户这次要的正是「不用手敲」。 */
const CURRENT_PRESET = "__current__";
let currentEntry = null;   // { provider, model, baseUrl, label }

/** 按**地址**反查是哪一家（型号不在清单里也算认得）。认不出返回 ""。 */
function providerOfBaseUrl(value) {
  const base = normalizeModelBase(value);
  if (!base) return "";
  return Object.keys(PROVIDER_PRESETS).find((provider) => (
    (PROVIDER_PRESETS[provider]?.models?.length ?? 0) > 0
    && normalizeModelBase(PROVIDER_PRESETS[provider].baseUrl) === base
  )) ?? "";
}

/** 把「已保存、但不在清单里」的那条塞进下拉。**幂等**：loadSettings 会跑很多次，只留一条。 */
function ensureCurrentOption(model) {
  const select = $("modelPreset");
  if (!select) return;
  for (const stale of select.querySelectorAll(`option[value="${CURRENT_PRESET}"]`)) stale.remove();
  currentEntry = null;
  const savedModel = String(model?.model ?? "").trim();
  if (!savedModel) return;
  // 正好是清单里某一项（型号 + 地址都对得上）⇒ 不需要这条「兜底项」。
  if (presetItems().some((item) => item.model === savedModel
    && normalizeModelBase(item.baseUrl) === normalizeModelBase(model.baseUrl))) return;
  const provider = providerOfBaseUrl(model.baseUrl);
  const label = provider ? (PROVIDER_PRESETS[provider]?.label ?? provider) : "";
  currentEntry = { provider: provider || "custom", model: savedModel, baseUrl: model.baseUrl ?? "", label };
  const option = document.createElement("option");
  option.value = CURRENT_PRESET;
  option.textContent = `${label ? `${label} · ` : ""}${savedModel}（当前在用，不在清单里）`;
  select.prepend(option);
}

/** 画下拉。**只画一次**（dataset.ready 挡重入）：loadSettings 会被调用很多次，
 *  每次重建 optgroup 会把用户正展开的选择面板弹回去。 */
function renderModelPresets() {
  const select = $("modelPreset");
  if (!select || select.dataset.ready === "1") return;
  for (const [provider, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (!preset.models?.length) continue;
    const group = document.createElement("optgroup");
    group.label = preset.label;
    for (const model of preset.models) {
      const option = document.createElement("option");
      option.value = `${provider}|${model}`;
      option.textContent = model;
      group.append(option);
    }
    select.append(group);
  }
  const custom = document.createElement("option");
  custom.value = CUSTOM_PRESET;
  custom.textContent = "自定义（自己填接口地址和模型名）";
  select.append(custom);
  select.dataset.ready = "1";
}

/** 选中的是自定义 ⇒ 展开地址与型号；否则收起（值仍留在 input 上，「保存」照旧读它们）。
 *  ★ 「当前在用（不在清单里）」这一条**不展开**：地址与型号是已知的，展开只会让人以为要重填。 */
function syncModelRows() {
  const value = $("modelPreset").value;
  const isCustom = value === CUSTOM_PRESET;
  $("modelCustom").hidden = !isCustom;
  const item = currentPreset();
  let note = "";
  if (isCustom) {
    note = PROVIDER_PRESETS.custom.note ?? "";
  } else if (value === CURRENT_PRESET && currentEntry) {
    // 认得是哪一家 ⇒ 直接给那一家的提示（例如 DeepSeek 那句"v4 系列才是现在能用的"）。
    note = currentEntry.provider !== "custom"
      ? (PROVIDER_PRESETS[currentEntry.provider]?.note ?? "")
      : "这个接口地址不在清单里：型号与地址都是你自己填的，换之前自己核对。";
  } else if (item) {
    note = PROVIDER_PRESETS[item.provider]?.note ?? "";
  }
  $("modelPresetNote").textContent = note;
}

/** 从下拉选了一条：把它的地址与型号填进去。 */
function applyModelPreset(value) {
  if (value === CURRENT_PRESET && currentEntry) {
    // 回到「你原来那一份」——包括用户先在清单里点来点去又改回主意的情况。
    $("baseUrl").value = currentEntry.baseUrl;
    $("modelName").value = currentEntry.model;
  } else if (value !== CUSTOM_PRESET) {
    const item = presetItems().find((entry) => `${entry.provider}|${entry.model}` === value);
    if (item) {
      $("baseUrl").value = item.baseUrl;
      $("modelName").value = item.model;
    }
  }
  syncModelRows();
}

/** 「当前在用」那一格：报告的是**已保存**的配置，不是输入框里的草稿。
 *  ★ 型号不在清单里也要报出厂商名（`DeepSeek · deepseek-chat`），不然用户看不出这是哪一家。 */
function renderModelCurrent(model) {
  const savedModel = String(model.model ?? "").trim();
  const item = presetItems().find(
    (entry) => entry.model === savedModel
      && normalizeModelBase(entry.baseUrl) === normalizeModelBase(model.baseUrl),
  );
  const provider = item ? item.provider : providerOfBaseUrl(model.baseUrl);
  const label = provider ? (PROVIDER_PRESETS[provider]?.label ?? "") : "";
  const name = savedModel ? (label ? `${label} · ${savedModel}` : savedModel) : "还没有选";
  $("modelCurrent").textContent = model.hasKey ? name : `${name}（还没有 Key）`;
}

// ---------------------------------------------------------------- 更新
//
// 2026-10-20 用户口径：「咱们程序里有检查更新界面吗，接收 github 仓库 release，不会的话
// 原版程序逻辑就挺好的，版本号管理，更新检查，beta 版……好像还有更新断点续传，你仔细借鉴一下吧」。
//
// 界面这一侧的规矩（与原版程序同一套，只改成本程序写法）：
//   ① **不在进设置页时联网**：第一屏只显示当前版本 + 上次的下载进度（都是本机数据）。
//      联网只有一个入口 —— 用户点「检查更新」。★ 2026-10-20 更正：本仓红线不是
//      「唯一外联＝用户自填的 Key」（那是老说法，早就不成立了）—— 会离开本机的接口有 6 条，
//      清单在 `app/contracts/http_contract.json` 的 `privacy.leaves_machine`；
//      真正的红线是「**每一条都由用户当轮的动作触发，程序自己不往外发**」。
//   ② 「有没有新版本」「当前版本是不是比 GitHub 高」一律听后端（`updateAvailable` /
//      `currentIsNewer`）：GitHub 的 tag 带 v 前缀、本机版本号不带，前端自己比字符串
//      会把「已是最新」显示成「当前版本更高」（原版程序 1.0.6 的原事故）。
//   ③ `degraded`（查不到）既不是「有新版本」，也**绝不是**「已经是最新版本」——
//      它必须说清原因并把发布页交给用户。
//   ④ 下载状态每秒问一次**本机**服务（不出网），暂停/续传/取消都只改本机状态。
//      续传的关键不在界面：服务端拿 `.part` 的文件长度当偏移量发 `Range`。

const UPDATE_CHANNEL_TEXT = Object.freeze({ stable: "稳定版", beta: "测试版" });
/** 服务端认的「正在动」状态。cancelling / pausing 也要算进来 —— 那是收尾中的过渡态。 */
const UPDATE_ACTIVE_STATES = Object.freeze(["connecting", "downloading", "verifying", "cancelling", "pausing"]);

let updateInfo = null;        // 后端最后一次「检查更新」的应答（含 degraded）
let updateSnapshot = null;    // 后端最后一次「下载状态」的应答
let updatePollTimer = null;   // 下载进行中的轮询（只打本机）
let updateActionPending = false;
// 发布页地址由 `/api/about` 给（后端一处真源）—— 前端不抄仓库名，免得换仓库后两边漂移。
let updateReleasesFallback = "";

function updateChannelLabel(channel) {
  return UPDATE_CHANNEL_TEXT[channel === "beta" ? "beta" : "stable"];
}

function renderUpdateChannel(channel) {
  const value = channel === "beta" ? "beta" : "stable";
  const select = $("updateChannel");
  if (select && select.value !== value) select.value = value;
  const hint = $("updateChannelHint");
  if (hint) {
    hint.textContent = `当前通道：${updateChannelLabel(value)}`
      + (value === "beta" ? "（正式版和预发布都收，可能不稳定）" : "（只收正式版）");
  }
  return value;
}

function updateSizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function updateTimeText(seconds) {
  if (seconds == null) return "计算中";
  return Number(seconds) >= 60 ? `${Math.ceil(Number(seconds) / 60)} 分钟` : `${Math.ceil(Number(seconds))} 秒`;
}

const updateIsActive = (state) => UPDATE_ACTIVE_STATES.includes(state?.state) || state?.running === true;

/**
 * 降级出路。
 * ★ 这里**不许**把 `degraded` 落进「已是最新」那一支：查不到的时候我们什么都不知道。
 */
function renderUpdateFallback(data) {
  const box = $("updateFallback");
  if (!box) return;
  const degraded = data?.degraded === true;
  box.hidden = !degraded;
  if (!degraded) return;
  const url = String(data.releaseUrl ?? "").trim();
  $("updateFallbackMessage").textContent = String(data.message ?? "无法连接更新服务，可手动到发布页下载");
  $("updateFallbackUrl").textContent = url;
  $("updateFallbackUrl").hidden = !url;
  $("openReleasePage").hidden = !url;
}

/** 把一次「检查更新」的应答铺到界面上。 */
function renderUpdateInformation(data) {
  updateInfo = data;
  const channel = renderUpdateChannel(data.channel);
  const degraded = data.degraded === true;
  const version = data.currentTag || "?";
  const box = $("updateVersion");
  if (box) {
    box.textContent = degraded
      ? `当前 ${version} · 未能检查更新（${updateChannelLabel(channel)}）`
      : `当前 ${version} · GitHub 最新 ${data.latestTag}（${updateChannelLabel(channel)}）`;
  }
  renderUpdateFallback(data);

  // 更新说明：Release 正文。★ textContent，不是 innerHTML —— 这是用户可控文本。
  const notes = String(data.notes ?? "");
  const notesRow = $("updateNotesRow");
  if (notesRow) {
    notesRow.hidden = degraded || !notes;
    if (notes) {
      $("updateNotesTitle").textContent = `更新说明${data.releaseName ? ` · ${data.releaseName}` : ` · ${data.latestTag}`}`;
      $("updateNotes").textContent = notes;
    }
  }

  const row = $("updateDownloadRow");
  if (row) row.hidden = !data.updateAvailable;
  if (data.updateAvailable) {
    const button = $("downloadUpdate");
    if (button && !updateIsActive(updateSnapshot)) {
      button.textContent = "下载并安装更新";
      button.disabled = false;
    }
  }

  const out = $("updateResult");
  if (out) {
    out.dataset.tone = degraded ? "bad" : "";
    out.textContent = degraded ? String(data.message ?? "检查更新失败")
      : data.updateAvailable ? "发现新版本，可以下载（支持暂停与断点续传）"
        : data.currentIsNewer === true ? "当前版本高于 GitHub 公开版，无需更新"
          : "当前已经是最新版本";
  }
  // 上一次检查若还挂着一个旧任务的进度，顺手刷一遍：换版本后按钮文案要跟着变。
  if (updateSnapshot) renderUpdateDownload(updateSnapshot);
}

/** 下载状态铺到界面：进度、速度、剩余时间、三个按钮的显隐与文案。 */
function renderUpdateDownload(state) {
  updateSnapshot = state;
  const details = $("updateDownloadDetails");
  const meter = $("updateMeter");
  const bar = $("updateProgress");
  const busy = updateIsActive(state);
  const paused = state?.state === "paused";
  const completed = state?.state === "completed";
  const total = Number(state?.totalBytes) || 0;
  const bytes = Number(state?.bytes) || 0;
  const percent = Math.max(0, Math.min(100, Number(state?.percent) || 0));

  if (meter) meter.hidden = total <= 0;
  if (bar) bar.value = percent;
  if (details) {
    details.textContent = total > 0
      ? `${percent.toFixed(1)}% · ${updateSizeText(bytes)} / ${updateSizeText(total)}`
        + (state.state === "downloading"
          ? ` · ${Number(state.bytesPerSecond) > 0 ? `${updateSizeText(state.bytesPerSecond)}/s` : "速度计算中"}`
            + ` · 剩余约 ${updateTimeText(state.remainingSeconds)}`
          : "")
      : "还没开始下载。";
  }

  const text = $("updateTransferResult");
  if (text) {
    const message = {
      connecting: "正在连接下载源，检查可续传进度……",
      pausing: "正在暂停下载并保存进度……",
      paused: "已暂停，进度已保留；点「继续下载」从断点接着下。",
      cancelling: "正在停止下载并删除本次下载文件……",
      cancelled: "已取消下载，本次下载文件已删除。",
      downloading: "正在下载；网络断了也可以点重试接着下。",
      verifying: "下载完成，正在校验安装包……",
      completed: "校验通过，可以安装。",
      failed: `${state.error || "下载中断"}${bytes > 0 ? "（进度已保留，可接着下）" : ""}`,
    }[state.state];
    text.dataset.tone = state.state === "failed" ? "bad" : state.state === "completed" ? "good" : "";
    text.textContent = message ?? (bytes > 0 ? "发现上次的下载进度，可以继续下载。" : "");
  }

  const button = $("downloadUpdate");
  if (button) {
    button.hidden = false;
    button.disabled = busy || updateActionPending || !updateInfo?.updateAvailable;
    button.textContent = completed ? "安装更新"
      : paused ? "继续下载"
        : state.state === "failed" ? "重试下载"
          : busy ? "正在下载……" : bytes > 0 ? "继续下载 / 校验" : "下载并安装更新";
  }
  const pause = $("pauseUpdate");
  if (pause) {
    pause.hidden = !["connecting", "downloading", "pausing"].includes(state.state);
    pause.disabled = updateActionPending || state.state === "pausing";
    pause.textContent = state.state === "pausing" ? "正在暂停……" : "暂停下载";
  }
  const cancel = $("cancelUpdate");
  if (cancel) {
    cancel.hidden = !(busy || paused || (bytes > 0 && !completed));
    cancel.disabled = updateActionPending || ["cancelling", "pausing"].includes(state.state);
    cancel.textContent = state.state === "cancelling" ? "正在取消……" : "取消下载";
  }
}

/** 下载状态只问本机服务（`/api/update/download`），不出网。 */
async function refreshUpdateStatus() {
  try {
    renderUpdateDownload(await api("/api/update/download"));
  } catch (error) {
    const text = $("updateTransferResult");
    if (text) text.textContent = `读取下载进度失败：${error.message}`;
  }
}

function stopUpdatePolling() {
  clearInterval(updatePollTimer);
  updatePollTimer = null;
}

/** 下载在动的时候每秒刷一次；停了就自己收表（别留一个永远跑的定时器）。 */
function ensureUpdatePolling() {
  if (updatePollTimer) return;
  updatePollTimer = setInterval(() => {
    if (!updateIsActive(updateSnapshot)) return void stopUpdatePolling();
    if (currentPage() !== "settings") return;   // 已经离开设置页：表留着，回来接着刷
    void refreshUpdateStatus();
  }, 1000);
}

/**
 * 查一次更新（**唯一**会出网的动作）。
 * 慢提示不是装饰：连不上 GitHub 时后端要等满 30 秒才降级，没有这句话用户只会看到一片卡住。
 */
async function loadUpdate() {
  const out = $("updateResult");
  if (out) {
    out.dataset.tone = "";
    out.textContent = "正在查询 GitHub 上的发布列表……";
  }
  const slow = setTimeout(() => {
    if (out && !updateInfo) out.textContent = "仍在查询（最长约 30 秒）；连不上会给你一条发布页链接。";
  }, 8000);
  try {
    renderUpdateInformation(await api("/api/update"));
  } catch (error) {
    // 连本机后端都问不到：同样不弹窗，改成页面内降级 + 发布页入口。
    renderUpdateInformation({
      degraded: true,
      message: `无法连接更新服务，可手动到发布页下载（${error.message}）`,
      currentTag: updateInfo?.currentTag ?? "",
      channel: $("updateChannel")?.value ?? "stable",
      releaseUrl: updateReleasesFallback,
    });
  } finally {
    clearTimeout(slow);
  }
}

async function startUpdateDownload() {
  if (updateActionPending) return;
  updateActionPending = true;
  try {
    renderUpdateDownload(await api("/api/update/download", { method: "POST", body: {} }));
    ensureUpdatePolling();
  } catch (error) {
    toast(error.message);
  } finally {
    updateActionPending = false;
    renderUpdateDownload(updateSnapshot ?? { state: "idle" });
  }
}

async function pauseUpdateDownload() {
  if (updateActionPending) return;
  updateActionPending = true;
  if ($("pauseUpdate")) $("pauseUpdate").textContent = "正在暂停……";
  try {
    renderUpdateDownload(await api("/api/update/download/pause", {
      method: "POST",
      body: { jobId: updateSnapshot?.jobId ?? null },
    }));
  } catch (error) {
    toast(error.message);
  } finally {
    updateActionPending = false;
    renderUpdateDownload(updateSnapshot ?? { state: "idle" });
  }
}

async function cancelUpdateDownload() {
  if (updateActionPending) return;
  updateActionPending = true;
  if ($("cancelUpdate")) $("cancelUpdate").textContent = "正在取消……";
  try {
    renderUpdateDownload(await api("/api/update/download/cancel", {
      method: "POST",
      body: { jobId: updateSnapshot?.jobId ?? null },
    }));
    stopUpdatePolling();
  } catch (error) {
    toast(error.message);
  } finally {
    updateActionPending = false;
    renderUpdateDownload(updateSnapshot ?? { state: "idle" });
  }
}

async function installUpdatePackage() {
  const path = String(updateSnapshot?.path ?? "");
  if (!path) return void toast("安装包不见了，请重新校验或重新下载");
  const ok = window.confirm("现在安装？\n\n"
    + "· 安装程序会先关掉本程序，然后覆盖安装（装到同一个目录）\n"
    + "· 你的信、记忆、曲库设置都在数据目录里，不会被覆盖\n"
    + "· 装完需要你自己再打开一次程序");
  if (!ok) return;
  try {
    await api("/api/update/install", { method: "POST", body: { path } });
    toast("安装程序已启动，本程序即将关闭");
  } catch (error) {
    toast(error.message);
  }
}

/** 进设置页时调一次：只读本机（版本号 + 上次的下载进度），**不联网**。 */
async function initUpdateCard() {
  try {
    const about = await api("/api/about");
    updateReleasesFallback = String(about.releasesUrl ?? "");
    const box = $("updateVersion");
    if (box && !updateInfo) box.textContent = `当前 ${about.version}`;
  } catch { /* 读不到版本号就不写，别在这块弹错打扰用户 */ }
  await refreshUpdateStatus();
  if (updateIsActive(updateSnapshot)) ensureUpdatePolling();
}

$("checkUpdate")?.addEventListener("click", () => { void loadUpdate(); });
$("updateChannel")?.addEventListener("change", async (event) => {
  const value = event.target.value === "beta" ? "beta" : "stable";
  try {
    await api("/api/update/channel", { method: "POST", body: { channel: value } });
    renderUpdateChannel(value);
    // 缓存里那条是旧通道的结果 ⇒ 切完立刻重查一次（这是用户刚做过的动作，不算偷偷联网）。
    await loadUpdate();
  } catch (error) {
    toast(error.message);
    renderUpdateChannel(updateInfo?.channel ?? "stable");
  }
});
$("openReleasePage")?.addEventListener("click", () => {
  const url = String($("updateFallbackUrl")?.textContent ?? "").trim();
  if (!url) return void toast("没有可打开的发布页地址");
  openExternal(url);
});
// ★ 同一个按钮三种用：已完成 ⇒ 安装；暂停/失败/有进度 ⇒ 继续（服务端按 .part 长度续传）；否则开始。
$("downloadUpdate")?.addEventListener("click", () => {
  if (updateSnapshot?.state === "completed") return void installUpdatePackage();
  void startUpdateDownload();
});
$("pauseUpdate")?.addEventListener("click", () => { void pauseUpdateDownload(); });
$("cancelUpdate")?.addEventListener("click", () => { void cancelUpdateDownload(); });

/** 主动来信的默认值（来自 core.mjs 的 PROACTIVE_DEFAULTS，由 /api/proactive 带下来）。
 *  「恢复默认」只填回输入框，不落库 —— 与原版程序同一口径：填完还要自己点一下保存。 */
let proactiveDefaults = null;

async function loadSettings() {
  try {
    const model = await api("/api/model");
    renderModelPresets();
    $("baseUrl").value = model.baseUrl ?? "";
    $("modelName").value = model.model ?? "";
    // 已保存的配置正好是清单里某一项 ⇒ 下拉停在它上面；**不在清单里**（本机的 deepseek-chat 就是）
    // ⇒ 塞一条「当前在用，不在清单里」停在它上面，而不是把用户扔进「自定义」再让他手敲一遍。
    ensureCurrentOption(model);
    const preset = currentPreset();
    $("modelPreset").value = preset ? `${preset.provider}|${preset.model}`
      : (currentEntry ? CURRENT_PRESET : CUSTOM_PRESET);
    $("apiKey").value = "";
    $("apiKey").placeholder = model.hasKey ? "已保存（DPAPI 加密），留空表示不修改" : "还没有填写";
    $("modelState").textContent = model.hasKey ? "Key 已保存" : "还没有 Key";
    renderModelCurrent(model);
    syncModelRows();

    const data = await api("/api/proactive");
    const s = data.settings;
    proactiveDefaults = data.defaults ?? proactiveDefaults;
    $("pEnabled").checked = !!s.enabled;
    $("pStart").value = s.windowStart;
    $("pEnd").value = s.windowEnd;
    $("pGap").value = s.minGapHours;
    $("pDay").value = s.maxPerDay;
    $("pWeek").value = s.maxPerWeek;
    // ★ 用 trigger.label（人话），不要 trigger.kind —— 那是内部代号，
    //   原样渲染出来会变成「现在可以写（song_played）」。
    $("proactiveVerdict").textContent = data.verdict?.ok
      ? `现在可以写：由头是「${data.verdict.trigger?.label ?? "她惦记着一件小事"}」`
      : `现在不写：${data.verdict?.reason ?? ""}`;
    // ★ 2026-10-20（照原版程序补齐）：额度用掉多少、她此刻在忙什么，都直接摆在明面上 ——
    //   以前这两件事只有点了「现在判断一次」才有一行字，平时那两格是空的。
    const stats = data.stats ?? {};
    const day = Number(stats.last24h ?? 0);
    const week = Number(stats.last7d ?? 0);
    $("proactiveStats").textContent = `已发：24 小时 ${day} / ${s.maxPerDay} 封 · 7 天 ${week} / ${s.maxPerWeek} 封`
      + (Number(stats.unread ?? 0) > 0 ? ` · 还有 ${stats.unread} 封没读` : "");
    const her = data.her ?? {};
    $("proactiveHer").textContent = her.label
      ? (her.busy
        ? `她这会儿${her.label} —— 这个状态下她不会写信，等她闲下来再说。`
        : `她这会儿${her.label} —— 她闲下来的时候才可能先写给你。`)
      : "这会儿读不到她在做什么（桌面那一层没开的时候世界状态是空的）；这不影响她按时间写信。";
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
    void refreshWorld();    // 她的世界：开关 + 「她此刻」那一行（A3）
    startWorldTicker();
    // ★ 2026-10-20：应用行为 / 弹唱视角 / 显示屏幕 / 开机自启四块的当前值。
    void loadBehavior();
    // ★ 数据备份那张卡必须在这里刷：不刷的话，首屏停在 HTML 里写死的
    //   「正在读取备份列表……」—— 用户看到的是一条永远不动的占位文字，
    //   只有点了某个按钮才会变（实测过：点「现在备份一份」之后才突然正确）。
    void dsLoad();
    // ★ 2026-10-20：「更新」那张卡只读本机（当前版本 + 上次的下载进度），**不联网**。
    //   联网只有一个入口 —— 用户点「检查更新」。红线是「每一条外发都由用户动作触发」
    //   （完整清单见 `app/contracts/http_contract.json` 的 `privacy.leaves_machine`）。
    void initUpdateCard();
  } catch (error) {
    toast(error.message);
  }
}

/** 设置页「关于」那块的数据目录 —— 空着就等于"我说在本机，你信我"，填出来才算是凭据。 */
async function fillAbout() {
  const el = $("dataDir");
  try {
    const a = await api("/api/about");
    if (el) {
      el.textContent = `版本 ${a.version} ｜ 数据目录：${a.dataDir}`;
      el.title = `信件与记忆都写在 ${a.dataDir}；曲库读的是 ${a.libraryDir}`;
    }
    // ★ 曲目目录这一行必须**一进设置页就有字**：「曲库」页那个输入框是 loadLibrary()
    //   里填的，而用户可能直接点齿轮进设置，那条路径根本不会跑 loadLibrary ⇒
    //   输入框空着，看起来像"没配过"。/api/about 本来就带 libraryDir，顺手用。
    const dir = $("libraryDir");
    if (dir && !dir.value) dir.value = a.libraryDir ?? "";
  } catch { /* 探不到就不写，别在这块弹错打扰用户 */ }
}

// ---------------------------------------------------------------- 待机
//
// ★ 状态行要说清两件事：现在用的是哪一套（场景/状态），以及素材到底在不在。
//   素材不在（比如打包时漏拷了 assets\）就直说"没找到待机素材" ——
//   别让用户以为"没曲子时桌面就该是空的"，那其实是一个可以修的毛病。
async function refreshIdle() {
  const box = $("idleState"), toggle = $("idleAmbience");
  const ambVol = $("ambienceVolume"), songVol = $("songVolume");
  if (!box && !toggle && !ambVol && !songVol
      && !document.querySelector("#stateCards .view-card")) return;
  try {
    const s = await api("/api/idle/settings");
    if (toggle) toggle.checked = Boolean(s.ambience);
    // ★ 音量回填只在"没在拖"的时候做，否则会跟用户的手抢滑块
    //   （典型症状：一边拖一边被服务端旧值拽回去，看着像滑块坏了）。
    if (ambVol && !ambVol.dataset.dragging) setRange(ambVol, s.ambienceVolume);
    if (songVol && !songVol.dataset.dragging) setRange(songVol, s.songVolume);
    // ★ 2026-10-20：「状态」三张卡的勾选态也在这里同步 —— 它和待机行读的是同一个接口，
    //   再发一次请求纯属浪费；服务端没钉过状态时回的是种子随机值，照它打勾就行
    //   （用户一点就钉住了，之后不会再变）。
    if (s.state) syncStateCards(s.state);
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

// ---------------------------------------------------------------- 她的世界（A3）设置行
//
// ★ 规格 4.2：开关打开时下面多一行「她此刻」，点「为什么」把依据摊开。
//   刷新时机：打开设置页一次 + 页面可见时每 60 秒（`startWorldTicker`）。
let worldTicker = null;
let worldLastState = null;

async function refreshWorld() {
  const toggle = $("worldStage");
  const row = $("worldNowRow");
  const text = $("worldNowText");
  if (!toggle && !row) return;
  try {
    const data = await api("/api/world/now");
    if (toggle && document.activeElement !== toggle) toggle.checked = Boolean(data.enabled);
    worldLastState = data.state ?? null;
    if (row) row.hidden = !data.enabled;
    if (text) {
      const s = data.state;
      const practice = data.practice;
      text.textContent = practice
        ? `在练「${practice.title}」`
        : s ? `${s.activity} —— ${s.detail ?? ""}`.trim() : "—";
    }
  } catch (error) {
    if (text) text.textContent = `读取失败：${error.message}`;
  }
}

function startWorldTicker() {
  if (worldTicker) return;
  worldTicker = setInterval(() => {
    if (document.hidden) return;                 // 页面看不见就别白问
    if ($("page-settings")?.getAttribute("aria-hidden") === "true") return;
    void refreshWorld();
  }, 60000);
}

/** 「为什么」：把这一条的依据摊开（规格 4.2 的可解释性要求）。 */
async function openWorldWhy() {
  const modal = $("worldWhyModal");
  if (!modal) return;
  let state = worldLastState;
  const line = $("worldWhyLine");
  const list = $("worldWhyList");
  try {
    const data = await api("/api/world/now");
    state = data.state ?? state;
    worldLastState = state;
  } catch { /* 拉不到就用上一次的，弹层里照样把能说的说完 */ }
  if (line) {
    line.textContent = state ? `「${state.activity}」—— ${state.detail ?? ""}`.trim() : "还没算出来";
  }
  if (list) {
    const ev = state?.evidence ?? {};
    const rows = [];
    if (ev.hour !== undefined) rows.push(`现在 ${Number(ev.hour)} 点，按她的作息这时候在${state.activity}`);
    if (ev.lastLetterAt) rows.push(`你上一封信是 ${formatClock(ev.lastLetterAt)} 写的`);
    if (ev.lastReplyAt) rows.push(`她上一封回信在 ${formatClock(ev.lastReplyAt)}`);
    if (ev.topSong) rows.push(`你最近常放「${ev.topSong}」（${ev.topSongCount ?? 1} 次）`);
    if (ev.topSongAt) rows.push(`最后一次是 ${formatClock(ev.topSongAt)}`);
    if (ev.habit) rows.push(`你平时习惯在 ${ev.habit} 前后写信`);
    if (!rows.length) rows.push(state?.reason ?? "这一条没有更多依据");
    list.innerHTML = rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  }
  modal.hidden = false;
}

/** 时间戳（秒）→「今天 21:40」/「10-18 09:05」。依据弹层里只求看得懂。 */
function formatClock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const d = new Date(n * 1000);
  const pad = (x) => String(x).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

/** 滑块 + 右端数字一起更新（`output` 是同一个值的只读展示，不是另一个状态）。 */
function setRange(input, value) {
  if (!(input instanceof HTMLInputElement)) return;
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  input.value = String(n);
  // ★ 2026-10-20 滑块改自绘后，填充比例由这里写进 --fill（styles.css 拿它画已选段）。
  input.style.setProperty("--fill", `${n}%`);
  const out = $(input.id + "N");
  if (out) out.textContent = String(n);
}

/** 音量滑块：拖动时本地立刻生效（数字跟着动），停手 200ms 才落库并喊桌面层刷新。
 *  ★ 为什么不在 `input` 事件里直接发请求：拖一次会发几十个请求，每个都要写一次库。
 *  ★ 为什么落库后要 tellShell("stage:changed")：声音出在桌面那一层，
 *    它不刷新就一直是旧音量 —— 用户会以为"拖了没反应"。 */
function wireVolume(input) {
  if (!(input instanceof HTMLInputElement)) return;
  let timer = 0;
  setRange(input, input.value);   // ★ 2026-10-20 自绘滑块：首屏就把填充比例画对（不然闪 50%）
  const commit = async () => {
    delete input.dataset.dragging;
    const field = input.id === "ambienceVolume" ? "ambienceVolume" : "songVolume";
    try {
      await api("/api/idle/settings", { method: "POST", body: { [field]: Number(input.value) } });
      tellShell("stage:volume");
    } catch (error) {
      toast(error.message);
      await refreshIdle();
    }
  };
  input.addEventListener("pointerdown", () => { input.dataset.dragging = "1"; });
  input.addEventListener("input", () => {
    input.dataset.dragging = "1";
    setRange(input, input.value);
    clearTimeout(timer);
    timer = setTimeout(commit, 200);
  });
  input.addEventListener("keyup", commit);
  input.addEventListener("blur", () => { if (input.dataset.dragging) { clearTimeout(timer); void commit(); } });
}
wireVolume($("ambienceVolume"));
wireVolume($("songVolume"));

$("idleAmbience")?.addEventListener("change", async (e) => {
  try {
    await api("/api/idle/settings", { method: "POST", body: { ambience: e.target.checked } });
    toast(e.target.checked ? "待机环境音已开" : "待机环境音已关");
    tellShell("stage:volume");   // 桌面那层立刻照新开关走，别等 30 秒
    await refreshIdle();
  } catch (error) {
    toast(error.message);
  }
});

// 她的世界开关：改完立刻让桌面层重算（她可能正练着，关掉要马上停）。
$("worldStage")?.addEventListener("change", async (e) => {
  try {
    const r = await api("/api/world/stage", { method: "POST", body: { enabled: e.target.checked } });
    toast(r.enabled ? "她会在你不放歌的时候练一会儿琴" : "她不会再自己在桌面上弹琴了");
    tellShell("stage:changed");
    await refreshWorld();
  } catch (error) {
    toast(error.message);
    await refreshWorld();
  }
});

$("worldWhy")?.addEventListener("click", () => { void openWorldWhy(); });

// 「为什么」弹层的关闭：✕ / 遮罩 / 「知道了」/Esc 都走同一处。
(function wireWorldWhyModal() {
  const modal = $("worldWhyModal");
  if (!modal) return;
  const close = () => { modal.hidden = true; };
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
})();

// ---------------------------------------------------------------- 应用行为 / 弹唱视角 / 状态 / 显示屏幕
//
// ★★ 2026-10-20 用户口径（对照原版设置页三张截图）：「原版游戏的设置界面是可以让用户选择
//   弹唱视角，状态，显示屏幕，应用行为的……而咱们不行，你弄一下。」
//   四块的分工（谁落库、谁归外壳）：
//     弹唱视角 → 服务端 play_view（NI/WI，曲库视频文件名里的视角段）
//     状态     → 服务端 idle_state（R1/R2/R3 = 日常/创作/思考）
//     关闭时   → 服务端 close_behavior（ask/tray/quit），点 × 时由本文件执行
//     开机自启 / 显示屏幕 → 外壳（注册表 Run 项 / Screen.AllScreens），只有独立窗口里有

/** 外壳桥（只在独立窗口里有；浏览器打开时是 undefined —— 那两项开关要能 graceful 降级）。
 *  ★★ 必须走 `hostObjects.sync`（同步代理），**不能**用不带 .sync 的那个。
 *     不带 .sync 的是异步代理：它的方法调用返回的不是值，而是一个 thenable 函数
 *     （typeof "function"，String() 出来是 "function () { [native code] }"）。
 *     2026-10-20 用户截图：显示屏幕下拉里躺着 "function 0 { [native code] }"
 *     —— 就是 `String(bridge.ListScreens() ?? "")` 把那个 thenable 函数字符串化了，
 *     于是开机自启永远对不上 "on"、屏幕列表变成一行乱码、SetScreen 永远不等于 "ok"。
 *     实测证据（同机同 WebView2 运行时）：analysis/_audit22/hostobj-probe/result.txt
 *       · 同步代理  ListScreens() ⇒ "S1|0|0|1920|1080|1;…"（直接就是值）
 *       · 异步代理  ListScreens() ⇒ function，String() ⇒ "function () { [native code] }"
 *       · 同步代理 + 模态对话框（PickFolder 的形状）⇒ MODAL-OK 1515ms，不卡死
 *     一手依据：WebView2 SDK 文档 —— hostObjects.{name} 是 promise，
 *     hostObjects.sync.{name} 才是同步代理（阻塞等宿主跑完再回值）。 */
function shellBridge() {
  return window.chrome?.webview?.hostObjects?.sync?.linliShell;
}

/** 调外壳桥的单个方法，兜住一切异常：旧外壳没有这些方法（或宿主临时出事）时返回
 *  fallback —— 读不到就按"没有"显示，不摆骗人的界面；更不许把整个 loadBehavior
 *  掀翻（原来 GetAutostart 那一抛，后面的屏幕枚举整段都不跑，下拉就剩个空壳）。 */
function bridgeRead(fn, fallback) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 卡片组的勾选态同步（aria-checked 是唯一真源，CSS 照它画 ✓ 与描边）。 */
function syncViewCards(view) {
  for (const card of document.querySelectorAll("#viewCards .view-card")) {
    card.setAttribute("aria-checked", card.dataset.view === view ? "true" : "false");
  }
}
function syncStateCards(state) {
  for (const card of document.querySelectorAll("#stateCards .view-card")) {
    card.setAttribute("aria-checked", card.dataset.state === state ? "true" : "false");
  }
}

/** 点 × 时的行为（应用行为那块设置的就是它）。ask = 每次问一句（原版「不设置」档）。 */
let closeBehavior = "ask";
function closeWindowWithBehavior() {
  if (closeBehavior === "tray") { tellShell("close"); return; }
  if (closeBehavior === "quit") { tellShell("quit"); return; }
  const modal = $("closeAskModal");
  if (!modal) { tellShell("quit"); return; }   // 没有弹层就按老行为走，别让 × 失灵
  modal.hidden = false;
  $("closeAskQuit")?.focus();
}

// 「关闭时怎么办」弹层：三个出口 + 原版同款的「记住该设定」。
(function wireCloseAskModal() {
  const modal = $("closeAskModal");
  if (!modal) return;
  const done = async (action) => {
    const remember = $("closeAskRemember")?.checked === true;
    modal.hidden = true;
    if (remember) {
      // 记住 = 把这次的选择写进设置（顺带把设置页那个下拉也拨过去）。
      try {
        await api("/api/app/behavior", { method: "POST", body: { closeBehavior: action } });
        closeBehavior = action;
        const sel = $("closeBehavior");
        if (sel) sel.value = action;
      } catch { /* 记不住不耽误这次关闭 */ }
    }
    tellShell(action === "tray" ? "close" : "quit");
  };
  $("closeAskTray")?.addEventListener("click", () => { void done("tray"); });
  $("closeAskQuit")?.addEventListener("click", () => { void done("quit"); });
  // 遮罩 / ✕ / Esc 都是"取消"——什么都不做，把窗口留着。
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") modal.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) modal.hidden = true; });
})();

/** 设置页一打开就把这四块的当前值摆好（loadSettings 末尾调）。 */
async function loadBehavior() {
  // 落库的两项：关闭时行为 + 弹唱视角。
  try {
    const b = await api("/api/app/behavior");
    closeBehavior = b.closeBehavior ?? "ask";
    const sel = $("closeBehavior");
    if (sel) sel.value = closeBehavior;
  } catch { /* 读不到就沿用默认 ask —— 别让设置页打不开 */ }
  try {
    const v = await api("/api/stage/view");
    syncViewCards(v.view ?? "NI");
  } catch { /* 默认 NI */ }

  // 外壳管的两项：开机自启 + 屏幕枚举。
  const bridge = shellBridge();
  const auto = $("appAutostart");
  if (auto) {
    if (!bridge) {
      // 浏览器模式没有外壳：开关留着但禁用，并说清为什么（不能摆一个骗人的开关）。
      auto.checked = false;
      auto.disabled = true;
      auto.title = "开机自启动要在独立窗口里设置（浏览器打开时没有这个开关）";
    } else {
      auto.disabled = false;
      auto.title = "";
      auto.checked = bridgeRead(() => String(bridge.GetAutostart()), "") === "on";
    }
  }
  const sel = $("stageScreen");
  if (sel && !bridge) {
    sel.innerHTML = "";
    const only = document.createElement("option");
    only.value = "";
    only.textContent = "默认（浏览器里换不了屏幕）";
    sel.appendChild(only);
    sel.disabled = true;
  } else if (sel && bridge) {
    sel.disabled = false;
    const current = bridgeRead(() => String(bridge.GetScreen()), "");
    sel.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "默认（铺满整个桌面）";
    sel.appendChild(def);
    try {
      // ListScreens 回「名字|左|上|宽|高|是否主屏;…」（竖线分隔，绕开 JSON 转义）。
      for (const row of bridgeRead(() => String(bridge.ListScreens()), "").split(";")) {
        if (!row) continue;
        const cells = row.split("|");
        const name = cells[0] ?? "";
        if (!name) continue;
        const opt = document.createElement("option");
        opt.value = name;
        const pretty = name.replace(/^\\\\\.\\/, "");
        // 带上分辨率：只写 DISPLAY2 用户认不出是哪块（多屏时尤其），
        // 原版也只给名，但用户这轮骂的就是"信息不准"—— 名 + 尺寸 + 主屏标记一次给足。
        const size = cells[3] && cells[4] ? ` · ${cells[3]}×${cells[4]}` : "";
        opt.textContent = pretty + size + (cells[5] === "1" ? "（主屏幕）" : "");
        if (name === current) opt.selected = true;
        sel.appendChild(opt);
      }
    } catch { /* 枚举不到就只留默认项 */ }
  }
}

// 弹唱视角：点了就落库 + 让桌面那层立刻换片（不通知要等它 30 秒轮询，像点了没反应）。
for (const card of document.querySelectorAll("#viewCards .view-card")) {
  card.addEventListener("click", async () => {
    const view = card.dataset.view;
    try {
      await api("/api/stage/view", { method: "POST", body: { view } });
      syncViewCards(view);
      tellShell("stage:changed");
      toast(view === "NI" ? "弹唱视角：专注演奏" : "弹唱视角：视线交互");
    } catch (error) {
      toast(error.message);
    }
  });
}
// 状态：日常 / 创作 / 思考 → R1 / R2 / R3（服务端会连同场景一起钉住，见 /api/idle/settings）。
for (const card of document.querySelectorAll("#stateCards .view-card")) {
  card.addEventListener("click", async () => {
    const state = card.dataset.state;
    try {
      await api("/api/idle/settings", { method: "POST", body: { state } });
      syncStateCards(state);
      tellShell("stage:changed");
      const name = card.querySelector(".view-card-name")?.textContent ?? state;
      toast(`她待机的状态：${name}`);
    } catch (error) {
      toast(error.message);
    }
  });
}
// 关闭时行为：只落库，下一次点 × 就按它走。
$("closeBehavior")?.addEventListener("change", async (e) => {
  try {
    await api("/api/app/behavior", { method: "POST", body: { closeBehavior: e.target.value } });
    closeBehavior = e.target.value;
  } catch (error) {
    toast(error.message);
    void loadBehavior();
  }
});
// 开机自启：外壳写 HKCU Run 项（值名与安装程序一致，卸载时会一起清掉）。
$("appAutostart")?.addEventListener("change", async (e) => {
  const bridge = shellBridge();
  if (!bridge) { e.target.checked = !e.target.checked; return; }
  const r = bridgeRead(() => String(bridge.SetAutostart(e.target.checked)), "err:调不到外壳（这是旧版程序吗？）");
  if (r !== "ok") {
    toast(`开机启动没改成功：${r}`);
    e.target.checked = !e.target.checked;
    return;
  }
  toast(e.target.checked ? "开机时会把她拉起来待命（只进托盘）" : "开机不再自动启动");
});
// 显示屏幕：外壳把壁纸层 / 圆钮 / 主窗口搬到选中的那块屏。
$("stageScreen")?.addEventListener("change", (e) => {
  const bridge = shellBridge();
  if (!bridge) return;
  const name = e.target.value;
  const r = bridgeRead(() => String(bridge.SetScreen(name)), "err:调不到外壳（这是旧版程序吗？）");
  if (r !== "ok") {
    toast(`屏幕没换成功：${r}`);
    return;
  }
  toast(name ? "她和圆钮已经搬到那块屏幕" : "已恢复默认（铺满整个桌面）");
});

// ---------------------------------------------------------------- 信件字体
//
// ★ 这一版**不再"检测系统字体"**了。上一版是拿像素比去找用户系统里装的那一支
//   （SentyTEA / HanyiSentyTea…）；现在字体由用户自己从官网下、再从界面上导进来，
//   存在**本程序的数据目录**里（见 server.mjs 的 /api/font/ 那几个路由），由服务端说了算。
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
  // ★ 2026-10-19 审查 N1：设置页「反馈问题 / 建议新功能」拼出来的地址是
  //   https://github.com/<owner>/<repo>/issues/new?…（仓库地址在后端 maintenance.mjs 里）。
  //   上一版这里没有 github.com，于是点下去被前端拦下、只弹一句「不在允许打开的名单里」；
  //   在打包外壳里更糟：前端放行、postMessage 到 C# 后被那边的白名单静默丢弃，点了完全没反应。
  //   issues/new 只落在 github.com 上，不再放 api.github.com / raw 之类更宽的主机。
  "github.com", "www.github.com",
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
// ★ 2026-10-19 规格（UI规格 4.1）：一屏两个开关 —— 「主动来信」（默认开）与
//   「她在练琴时放出来」（默认关）。以前的版本只问主动来信，现在的文案与开关
//   都在 HTML 里（#introProactive / #introWorld），这里只负责读值、落盘、只问一次。
// ★ 关闭（Esc / 点遮罩 / ✕）的语义：**两个都落成关**，并且记为已答过 ——
//   不留"半开"的状态，否则用户关掉弹窗却发现她在桌面上弹琴，会显得程序自作主张。
(function introAsk() {
  const modal = $("introModal");
  if (!modal) return;
  let lastFocus = null;
  let answered = false;

  const proactiveBox = $("introProactive");
  const worldBox = $("introWorld");

  function close(commit) {
    modal.hidden = true;
    if (!answered) void save(commit);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function save(commit) {
    answered = true;
    const proactiveOn = commit ? Boolean(proactiveBox?.checked) : false;
    const worldOn = commit ? Boolean(worldBox?.checked) : false;
    try {
      // 两件事各走各的接口：主动来信有自己的开关与限频，她的世界有自己的。
      await api("/api/proactive", { method: "POST", body: { enabled: proactiveOn, asked: true } });
      await api("/api/world/stage", { method: "POST", body: { enabled: worldOn, asked: true } });
      await loadSettings();
      toast(worldOn
        ? "好了。你不放歌的时候，她可能会在桌面上练一会儿。"
        : "好了。她只会在你先写信时回信。");
      // 桌面层要不要立刻按新开关走，不能等它 30 秒那一轮。
      tellShell("stage:changed");
    } catch (error) {
      toast(error.message);
    }
  }

  window.__maybeAskProactive = (shouldAsk) => {
    if (!shouldAsk || !modal.hidden) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    // 默认值每次都重置：主动来信开（用户 2026-10-14 定的口径），练琴关。
    if (proactiveBox) proactiveBox.checked = true;
    if (worldBox) worldBox.checked = false;
    $("introYes")?.focus();
  };
  $("introYes")?.addEventListener("click", () => close(true));
  $("introNo")?.addEventListener("click", () => close(false));
  modal.addEventListener("click", (e) => { if (e.target.dataset.close === "1") close(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close(false);
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

// ★★ 2026-10-20（用户口径：「模型选择可以学习原版程序……模型界面全部都要学习原版程序」）
//   与原版程序 public/app.js 的 modelPreset / queryModels 同一套做法：
//   · 「选择模型」选一条 = 把它的地址与型号一起填好；
//   · 只有「自定义」才展开手填字段；
//   · 「查询模型列表」拿你填的 Key 直接问那家的 /models，把编号列成下拉。
$("modelPreset").addEventListener("change", () => applyModelPreset($("modelPreset").value));

$("modelNameOptions").addEventListener("change", () => {
  const picked = $("modelNameOptions").value;
  if (picked) $("modelName").value = picked;
});

/** 把输入框里这一份存下去，返回读回来的配置（失败时抛，由调用方 toast）。 */
async function saveModelConfig() {
  const preset = currentPreset();
  const baseUrl = $("baseUrl").value.trim();
  const patch = {
    // provider 只在「清单里认得出来」时才有名字，认不出就按**地址**再认一次，
    // 还不认得才是 custom。★ 别写成 `preset ? … : "custom"` —— 型号不在清单里时
    // （本机的 deepseek-chat）那样会把库里原本对的 "deepseek" 悄悄改成 "custom"。
    provider: preset?.provider || providerOfBaseUrl(baseUrl) || "custom",
    baseUrl,
    model: $("modelName").value.trim(),
  };
  const key = $("apiKey").value;
  if (key) patch.apiKey = key;
  const { model } = await api("/api/model", { method: "POST", body: patch });
  $("apiKey").value = "";
  $("apiKey").placeholder = model.hasKey ? "已保存（DPAPI 加密），留空表示不修改" : "还没有填写";
  $("modelState").textContent = model.hasKey ? "Key 已保存" : "还没有 Key";
  renderModelCurrent(model);
  return model;
}

$("saveModel").addEventListener("click", async () => {
  try {
    await saveModelConfig();
    toast("已保存");
  } catch (error) {
    toast(error.message);
  }
});

// ★ 先存再测：只测不存的话，用户刚在下拉里换了型号、没点保存就点测试，测的还是**上一个**型号 ——
//   通了会以为新模型通了，不通又会去改一份根本没生效的配置。原版程序也是「保存并测试」一颗按钮。
$("testModel").addEventListener("click", async () => {
  const btn = $("testModel");
  btn.disabled = true;
  btn.textContent = "测试中……";
  try {
    await saveModelConfig();
    const result = await api("/api/model/test", { method: "POST" });
    $("modelState").textContent = result.ok ? `通了：${result.sample ?? ""}` : `不通：${result.error}`;
    toast(result.ok ? `通了：${result.sample ?? ""}` : `不通：${result.error}`);
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存并测试";
  }
});

// ★ 只查询，**不改**已保存的配置，也不动输入框里已经填好的型号（原版程序同样是这个边界）。
$("queryModels").addEventListener("click", async () => {
  const btn = $("queryModels");
  btn.disabled = true;
  btn.textContent = "查询中……";
  try {
    const result = await api("/api/model/models", {
      method: "POST",
      body: { baseUrl: $("baseUrl").value.trim(), apiKey: $("apiKey").value },
    });
    if (!result.ok) {
      $("modelState").textContent = `没查到：${result.error}`;
      toast(`没查到：${result.error}`);
      return;
    }
    // 查到之后切到「自定义」：候选项是**这家**给的，再被预设的地址盖回去就没意义了。
    $("modelPreset").value = CUSTOM_PRESET;
    syncModelRows();
    const select = $("modelNameOptions");
    select.replaceChildren();
    const head = document.createElement("option");
    head.value = "";
    head.textContent = `查到 ${result.models.length} 个，选一个`;
    select.append(head);
    for (const id of result.models) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
    $("modelQueryField").hidden = false;
    $("modelState").textContent = `查到 ${result.models.length} 个模型，选一个再保存`;
  } catch (error) {
    $("modelState").textContent = `没查到：${error.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "查询模型列表";
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
    // ★ 2026-10-20：开关从「开/关下拉」改成勾选框（照原版程序）—— 一个布尔值用下拉表达
    //   本来就是多一层。这里读 .checked，别再读 .value。
    enabled: $("pEnabled").checked,
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
    $("proactiveState").textContent = "已保存";
    toast("已保存");
    await loadSettings();
  } catch (error) {
    $("proactiveState").textContent = `没保存：${error.message}`;
    toast(error.message);
  }
});

// ★ 2026-10-20（照原版程序的「恢复默认」）：只把输入框填回默认值，**不落库** ——
//   填完还要自己点一下「保存」。默认值来自服务端的 PROACTIVE_DEFAULTS（真源在 core.mjs），
//   这里不写第二份数字。
$("resetProactive").addEventListener("click", () => {
  if (!proactiveDefaults) {
    $("proactiveState").textContent = "没读到默认值，先重新打开一次设置页";
    return;
  }
  $("pEnabled").checked = proactiveDefaults.enabled !== false;
  $("pStart").value = proactiveDefaults.windowStart;
  $("pEnd").value = proactiveDefaults.windowEnd;
  $("pGap").value = proactiveDefaults.minGapHours;
  $("pDay").value = proactiveDefaults.maxPerDay;
  $("pWeek").value = proactiveDefaults.maxPerWeek;
  $("proactiveState").textContent = "已填回默认值 —— 还要点一下「保存」";
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
  // ★ 2026-10-20：选择器里原来还带着 `.rb`（左栏那三个圆钮）。左栏已经搬出页面
  //   （见 index.html 与 NavRail.cs），页面里再没有 `.rb` ⇒ 一起去掉，别留个死选择器。
  const SELECTOR = "button:not(.lnk)";
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
  // 隐私政策 = 数据在哪 / 什么会离开本机 / 卸载会留下什么 —— 这三条才是"隐私"要回答的
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
const stage = { active: "A", tod: null, dir: null, mode: null, idle: { tod: null, slot: null, scene: null, state: null }, timer: null };

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

/** 素材**暂时**没有：把画面收干净，但**保留轮询**。
 *  ★ 不清 stage.timer 是刻意的：素材是可能被用户后补上的，收一次画面就永久停摆，
 *    等于逼用户去设置页关一次再开一次（2026-10-15 审核抓到的真实缺陷）。
 *  ★ 2026-10-19：原来还有一个 stopStage()（连 timer 一起清），改了 startStage 之后
 *    它一个调用点都没有了 —— 删掉，别留死代码。真要停轮询就在 startStage 里
 *    换 timer 前 clearInterval 那一下。 */
function stageIdlePause() {
  if (stage.mode === null) return;
  stage.mode = null;
  stage.dir = null;
  stage.idle = { tod: null, slot: null, scene: null, state: null };
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
 *    这是真渲染验证抓出来的缺口（接口有、页面 audio 数量为 0）。
 *  ★★ 2026-10-20 重写（用户：「为什么我把音量调为零还有声音」）：
 *    以前这层**无条件**播一路环境音、音量写死 0.45、不读任何设置 —— 而桌面壁纸那层
 *    （wallpaper.html）本来就按设置在播 ⇒ 外壳在跑时永远有两路声音，设置页调 0 也压不住
 *    写死 0.45 的这一路。现在：壁纸层在跑 ⇒ 窗口层一律哑巴（声音只从桌面那一层出，
 *    与 2026-10-19「曲子不双声道」的定稿同一口径）；只有浏览器模式（没有壁纸层）才由
 *    窗口层出声，且音量照设置页走（读不到就退默认 35，与服务端 DEFAULT_AMBIENCE_VOLUME 一致）。 */
let idleAudio = null;
let idleAudioVolume = null;
/** 桌面壁纸层在不在跑：浏览器里没有外壳 ⇒ 没有；有外壳时看壁纸开关
 *  （与设置页 stageWallpaper 开关、startStage 的口径一致：默认开，"0" 才算关）。 */
function wallpaperLayerOn() {
  if (!(window.chrome && window.chrome.webview)) return false;
  return localStorage.getItem("stage_wallpaper") !== "0";
}
async function idleAmbienceStart(n) {
  if (wallpaperLayerOn() || !n.ambience || n.ambienceOn === false) return idleAmbienceStop();
  try {
    const s = await api("/api/idle/settings");
    if (typeof s.ambienceVolume === "number") idleAudioVolume = Math.min(1, Math.max(0, s.ambienceVolume / 100));
  } catch { /* 读不到就沿用上一次的值 */ }
  if (idleAudioVolume === null) idleAudioVolume = 0.35;
  if (!idleAudio) { idleAudio = new Audio(); idleAudio.loop = true; window.__idleAudio = idleAudio; /* 自查钩子：new Audio 不进 DOM */ }
  idleAudio.volume = idleAudioVolume;
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
    stage.idle = { tod: n.tod, slot: n.slot, scene: n.scene, state: n.state };
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
      // ★ 2026-10-20 与壁纸层同病同治：换首判据要有曲目本身（info.dir），
      //   用户点播必须立刻切，不能等同时段的这首播完。
      if (stage.mode !== "song") { stage.mode = "song"; stage.tod = info.tod; stage.dir = info.dir; document.body.classList.add("stage-on"); idleAmbienceStop(); stageCrossFade(info.url); }
      else if (info.dir !== stage.dir || info.tod !== stage.tod) { stage.tod = info.tod; stage.dir = info.dir; stageCrossFade(info.url); }
      return;
    }
    // 没有曲子 ⇒ 走待机视频；待机素材也没有才真的什么都不播。
    const n = await api("/api/idle/next");
    // ★ 2026-10-15 修（审核）：只收画面、**保留定时器** —— 定时器一清就再也不自愈了。
    if (!n.hasAssets || !n.video) return stageIdlePause();
    if (stage.mode !== "idle") {
      stage.mode = "idle";
      stage.dir = null;
      stage.idle = { tod: n.tod, slot: n.slot, scene: n.scene, state: n.state };
      document.body.classList.add("stage-on");
      stageCrossFade(n.video);
      void idleAmbienceStart(n);
    } else if (n.tod !== stage.idle.tod || n.scene !== stage.idle.scene || n.state !== stage.idle.state) {
      // ★ 2026-10-20：状态卡/场景变了也要换片（以前只认时段，用户切状态没反应）。
      await stageIdleSwitch(n);
      void idleAmbienceStart(n);
    } else {
      void idleAmbienceStart(n); // 同一轮轮询：把被浏览器拦下的自动播放再试一次
    }
  } catch { /* 轮询失败就下一轮再试 */ }
}

// ★ 2026-10-19 口径再更正（用户：「背景只透过壁纸视频试试，就是不透过后面程序的界面」）。
//   桌面那一层（外壳 WallpaperHost → WorkerW）照旧铺整屏壁纸；**窗口自己**这层 #stage
//   也重新起片，当窗口的背景 —— 窗口不透明了，玻璃能透的只剩这层视频。
//   ★ 这条视频一律 muted（index.html 里就写着 muted）：声音只从**桌面那一层**出，
//     否则同一个曲子两路同时响，还差几十毫秒，听起来像回声。
async function startStage() {
  if (stage.timer) clearInterval(stage.timer);
  await stageTick();
  stage.timer = setInterval(() => { stageTick(); }, 30000);
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
  // ★ 2026-10-20：× 不再无条件退出 —— 按「应用行为 → 关闭时」的设置走
  //   （不设置 = 每次问一句 / 最小化到托盘 / 直接退出）。
  document.getElementById("wcQuit")?.addEventListener("click", () => closeWindowWithBehavior());
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
    // ★ 2026-10-20：壁纸层每秒上报的真实播放进度（外壳原样转进来），
    //   曲库底部播放条靠它画真进度、换播放/暂停图标。
    else if (m && typeof m === "object" && m.playback) {
      pbState = {
        t: Number(m.playback.t) || 0,
        d: Number(m.playback.d) || 0,
        playing: Boolean(m.playback.playing),
        has: true,
      };
      paintProgress();
    }
  });
})();

loadSettings();

// 桌面壁纸层（背景视频）：没有这个键就当作开 —— 装了之后第一眼就该是那层壁纸。
const stageToggle = $("stageWallpaper");
if (stageToggle) stageToggle.checked = localStorage.getItem("stage_wallpaper") !== "0";
startStage();
// 播放顺序是落库的设定：开机时把上次选的模式显示回来（否则界面写"顺序播放"、
// 桌面却按"单曲循环"走，两边对不上）。
void loadPlayMode();

loadLetters();
void loadOnThisDay();   // 往年今日只在启动时查一次，不进 5s 轮询
void loadWritingStreak();
bindMailReview();       // 列表/时间轴/日历的切换与点击（一次性委托，重画不会重复挂）
setInterval(loadLetters, 5000);

// ---------------------------------------------------------------- 数据备份与恢复
// 三条约束（照原版程序 data-safety.js，都是踩过坑立的），界面上必须让人看见：
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
    const name = decodeURIComponent(res.headers.get("X-Export-Name") || "oliviasoul-community-userdata.zip");
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
// ---- 维护：数据搬家 / 诊断包 / 反馈 ----------------------------------------
// ★ 这一组都在「设置 → 维护 / 诊断与反馈」里，只有出事才会用到，所以每个动作都要
//   当场给出结果（成功写清「下一步是什么」，失败写清「你该干什么」），不能只 toast 一句。

/** 搬家列表：扫出来的每一份都给一个按钮，但那只是「键」——服务端会重新扫一遍再比对。 */
function renderMigrateList(items) {
  const host = $("migrateList");
  if (!host) return;
  if (!items.length) {
    // ★ 方向口径（2026-10-20 用户原话）：搬家是「把旧版本的数据搬进来」，
    //   不是把现在的数据搬出去 —— 空结果的文案也要把方向说死。
    host.innerHTML = `<p class="hint">没有扫到旧版本的数据（本机没找到其它 OliviaSoul / 旧版林离的库）。</p>`;
    return;
  }
  host.innerHTML = items.map((it) => {
    const meta = [
      it.letterCount ? `${it.letterCount} 封信` : "",
      it.songCount ? `${it.songCount} 首曲子` : "",
      it.sizeBytes ? fmtBytes(it.sizeBytes) : "",
    ].filter(Boolean).join(" · ");
    const tag = it.isCurrent ? `<span class="ds-tag">正在使用</span>` : "";
    return `<div class="ds-row">
      <div class="ds-row-main">
        <code>${escapeHtml(it.path)}</code>
        <span>${escapeHtml(meta || "读不出内容")}${it.error ? `（${escapeHtml(it.error)}）` : ""}</span>
      </div>
      ${tag}
      ${it.isCurrent ? "" : `<button type="button" data-migrate="${escapeHtml(it.path)}">搬到这里</button>`}
    </div>`;
  }).join("");
  for (const btn of host.querySelectorAll("[data-migrate]")) {
    btn.addEventListener("click", () => migrateFrom(btn.dataset.migrate, btn));
  }
}

function migrateStatus(message, tone) {
  const el = $("migrateState");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone ?? "";
}

async function scanMigrations(btn) {
  if (btn) btn.disabled = true;
  migrateStatus("正在扫描本机……（找旧版本的数据，最多几秒）");
  try {
    const done = await api("/api/maintenance/migrate", { auth: true });
    renderMigrateList(done.items ?? []);
    migrateStatus(`扫到 ${done.items.length} 份旧数据（含当前正在用的这份），用时 ${done.scannedMs} 毫秒。`);
  } catch (error) {
    migrateStatus(error.message, "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 搬家 = 把对方那份库复制过来，**下次启动**才替换。所以文案必须说「重开」。 */
async function migrateFrom(path, btn) {
  const ok = window.confirm(`把这份数据复制到当前安装？\n\n来源：${path}\n\n· 现在这份库会先自动留档（backup-*）\n· 搬完要关掉程序再打开才生效`);
  if (!ok) return;
  if (btn) btn.disabled = true;
  migrateStatus("正在复制……");
  try {
    const done = await api("/api/maintenance/migrate", { method: "POST", body: { path } });
    const bits = [`✓ 已复制 ${done.letterCount} 封信、${done.songCount} 首曲子的数据`];
    bits.push(done.warning || "关掉程序再打开就生效。");
    migrateStatus(bits.join(" "), "good");
  } catch (error) {
    migrateStatus(error.message, "bad");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function diagStatus(message, tone) {
  const el = $("diagState");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone ?? "";
}

async function diagShowContents() {
  const box = $("diagListBox");
  try {
    const info = await api("/api/maintenance/diagnostic", { auth: true });
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
      <div class="ds-row"><div class="ds-row-main"><code>会打包</code><span>${info.entries.map(escapeHtml).join("、") || "（空）"}</span></div></div>
      <div class="ds-row"><div class="ds-row-main"><code>不会打包</code><span>${info.excludes.map(escapeHtml).join("、")}</span></div></div>
      <div class="ds-row"><div class="ds-row-main"><code>落盘位置</code><span>${escapeHtml(info.dir)}</span></div></div>`;
    diagStatus("下面是打包内容：只有日志与运行信息。");
  } catch (error) {
    diagStatus(error.message, "bad");
  }
}

async function diagExport() {
  diagStatus("正在打包……");
  try {
    const done = await api("/api/maintenance/diagnostic", { method: "POST", body: {} });
    diagStatus(`✓ 已导出 ${done.name}（${fmtBytes(done.bytes)}）：${done.entries.map((e) => e.name).join("、")}`, "good");
    await diagShowContents();
  } catch (error) {
    diagStatus(error.message, "bad");
  }
}

/** 反馈入口的地址由后端给（仓库地址写在服务端），页面只负责把它交给系统浏览器。 */
async function openFeedback(kind) {
  try {
    const { url } = await api(`/api/maintenance/feedback?kind=${kind}`, { auth: true });
    openExternal(url);
  } catch (error) {
    diagStatus(`${error.message}。可以先把诊断包导出来发给作者。`, "bad");
  }
}

$("migrateScan")?.addEventListener("click", (e) => scanMigrations(e.currentTarget));
$("diagList")?.addEventListener("click", diagShowContents);
$("diagExport")?.addEventListener("click", diagExport);
$("diagReveal")?.addEventListener("click", async () => {
  try {
    await api("/api/maintenance/reveal", { method: "POST", body: {} });
  } catch { /* 打不开目录不影响别的 */ }
});
$("fbBug")?.addEventListener("click", () => openFeedback("bug"));
$("fbIdea")?.addEventListener("click", () => openFeedback("idea"));
