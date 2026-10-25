/**
 * 信箱 / 曲库 / 演奏页的界面层 —— 照原版 BSide Olivia Lin Test 0.0.9.627 的排布复刻，
 * 主题换成我们的液态玻璃。单独成文件是为了不把 1600 多行的 app.js 再撑大：
 * 这里只管"长什么样、点了之后展开什么"，读写接口仍然调 app.js 里那套 api()。
 *
 * ★ 原版流程（feapp 的 MailBox 模板 + zh-cn 文案，逐条对着实现）：
 *   左栏 .mail-item 列表 → 点一封 → 右栏出现 .mail-responsive-card（16:9 明信片）
 *   → **再点这张卡** → 全屏 .mail-envelope-overlay 里信封打开（letter-fly 1.4s）
 *   把信纸抽出来放大到 671×378，信封壳往下走并淡出 → 只剩一封信 → ✕ 关掉。
 *   写信走同一张 16:9 卡（底图 postcard_user，右 180px 让给视频邮票），点「寄出信件」。
 *
 * ★ 所有 DOM 都在 index.html 里，本文件只做三件事：设 textContent、切 class、绑事件。
 *   一律不用 innerHTML 拼用户内容 —— 信的内容是用户写的，拼进去就是 XSS 的入口。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const ASSET = (name) => `assets/${name}`;

  // 原版 assets 带内容哈希后缀，这几个是实测存在的文件名。
  const IMG = {
    letter: ASSET("postcard_letter-d722fc17.webp"),
    sealed: ASSET("postcard_sealed-c25be03c.webp"),
    user: ASSET("postcard_user-b56da6ff.webp"),
    video: ASSET("postcard_video-d28a9270.webp"),
    retry: ASSET("postcard_retry-06a08832.webp"),
    empty: ASSET("mailbox-empty-ea417535.webp"),
  };
  const STAMP_VIDEOS = [
    ASSET("mail_stamp_1-2a740c6d.mp4"),
    ASSET("mail_stamp_2-3430adfd.mp4"),
    ASSET("mail_stamp_3-b13ceac4.mp4"),
    ASSET("mail_stamp_4-16236862.mp4"),
  ];
  const STAMP_IMAGES = [
    ASSET("stamp_1-cacac9b0.webp"),
    ASSET("stamp_2-e2fc3bbe.webp"),
    ASSET("stamp_3-14d40a34.webp"),
  ];
  /** 等待回信时的那支视频：原版 `mailbox_waiting_for_reply` 那一态用的就是它（home_idle）。 */
  const WAIT_VIDEO = ASSET("home_idle-eb9cb735.mp4");
  /** 原版文案（zh-cn `mailbox_waiting_for_reply`，逐字抄，别改成"她还在写"）。 */
  const WAIT_TEXT = "林离回信中...";

  const pick = (list, seed) => list[Math.floor(seed * list.length) % list.length];
  const escapeHtml = (text) => String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function stampFor(kind) {
    return kind === "sealed" ? IMG.sealed
      : kind === "retry" ? IMG.retry
        : kind === "video" ? IMG.video
          : IMG.letter;
  }

  // ---------------------------------------------------------------- 信封弹层

  let envelopeTimer = null;
  let onEnvelopeClosed = null;

  /** 打开信封：先只露出闭口的信封（可点），点一下才播展开动画 —— 原版就是这样两拍。 */
  function openEnvelope(text, onClosed) {
    const overlay = $("envelopeOverlay");
    const box = $("envelope");
    if (!overlay || !box) return;
    onEnvelopeClosed = onClosed ?? null;
    const body = $("envelopeText");
    // 信纸正文用 textContent：这里放的是她写的原话，不解释成 HTML。
    if (body) body.textContent = String(text ?? "");
    box.classList.remove("is-opening", "is-opened");
    overlay.hidden = false;
    // 重新触发入场（关掉再开同一封信也要有动画）：强制一次布局再挂 class。
    void overlay.offsetWidth;
    overlay.classList.add("is-visible");

    const shell = box.querySelector(".mail-envelope__shell");
    if (shell) shell.style.pointerEvents = "auto";
    if (envelopeTimer) clearTimeout(envelopeTimer);
  }

  function unfoldEnvelope() {
    const box = $("envelope");
    if (!box || box.classList.contains("is-opening")) return;
    box.classList.add("is-opening");
    const shell = box.querySelector(".mail-envelope__shell");
    if (shell) shell.style.pointerEvents = "none";
    // 1.4s 是原版 letter-fly 的时长；到位后把壳彻底隐藏，避免它挡住信纸的点击区。
    envelopeTimer = setTimeout(() => box.classList.add("is-opened"), 1400);
  }

  function closeEnvelope() {
    const overlay = $("envelopeOverlay");
    const box = $("envelope");
    if (envelopeTimer) clearTimeout(envelopeTimer);
    envelopeTimer = null;
    if (overlay) {
      overlay.classList.remove("is-visible");
      overlay.hidden = true;
    }
    if (box) box.classList.remove("is-opening", "is-opened");
    const done = onEnvelopeClosed;
    onEnvelopeClosed = null;
    if (done) done();
  }

  // ---------------------------------------------------------------- 读信

  /**
   * 「她正在回信」那一块：**圆形小视频**（她本人在动）+ 一行字。
   *
   * ★ 2026-10-20 用户口径：「在回信的过程中，要播放原版游戏的林离正在回信的动画」。
   *   上一版这张卡只有静态底图 postcard_video.webp ＋ 一行「她还在写……」——
   *   `.mail-card-waiting*` 那三条样式早在抄原版时就跟进来了，可**从来没人渲染它们**
   *   （纯死 CSS），所以等回信的时候画面一动不动。
   *
   * ★ 原版实现（main-31595bd3.js 的 MailBoxReplyContent，type 为空且 vault 里没内容那一支）：
   *   `<div class="flex items-center justify-center relative">`
   *     `<div class="absolute bottom-5 text-[var(--tp-primary-3)]">林离回信中...</div>`
   *     `<video src=home_idle muted autoplay loop playsinline
   *            class="rounded-full w-[clamp(64px,18cqw,128px)] aspect-square object-cover
   *                   border-2 border-[var(--tp-grey-0)]">`
   *   视频挂的是 `home_idle-eb9cb735.mp4`（她站着轻轻晃的那支），圆形裁切、2px 深墨描边。
   *   尺寸按卡片宽度的 18cqw 走 —— 我们这张卡是定宽 516px，用等价的百分比。
   *
   * ★ 播不动（无解码器 / 被策略拦）就把视频整个摘掉，只留文案：宁可少一块，
   *   也不能在纸面上留一个黑圆（那是"坏了"，不是"她在写"）。
   */
  function waitingBlock() {
    const box = document.createElement("div");
    box.className = "mail-card-waiting";

    const video = document.createElement("video");
    video.className = "mail-card-waiting-video";
    // 属性 + 特性都写：Autoplay 策略看的是 HTML 特性（muted/playsinline），
    // 只设 JS 属性在某些内核版本上会被判成"有声自动播放"直接拒掉。
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", "林离正在回信");
    video.src = WAIT_VIDEO;

    const text = document.createElement("div");
    text.className = "mail-card-waiting-text";
    text.textContent = WAIT_TEXT;

    const drop = () => { if (video.parentNode) video.remove(); };
    video.addEventListener("error", drop);

    box.appendChild(video);
    box.appendChild(text);
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(drop);
    return box;
  }

  /**
   * 右栏：选中一封之后画这张 16:9 明信片。
   * @param {{title:string, when:string, kind:string, text:string, from:string}} view
   *   kind: letter（她的回信）/ sealed（已封）/ retry（失败可重试）/ video（她还在写）
   */
  function renderCard(view) {
    const host = $("mailBody");
    const empty = $("mailEmpty");
    if (!host || !empty) return;
    empty.hidden = true;
    host.querySelectorAll(".mail-responsive-card").forEach((n) => n.remove());

    const card = document.createElement("div");
    card.className = `mail-responsive-card mail-responsive-card-${view.kind}`;
    card.style.backgroundImage = `url("${stampFor(view.kind)}")`;
    card.setAttribute("role", "button");
    card.tabIndex = 0;

    const meta = document.createElement("div");
    meta.className = "mail-card-meta";
    meta.textContent = `${view.from} · ${view.when}`;
    card.appendChild(meta);

    const text = document.createElement("div");
    text.className = "mail-box-reply-content-text";
    if (view.kind === "video") {
      // 等待回信 = 圆形小视频 + 文案（原版那一支），不要再叠一行静态正文。
      card.appendChild(waitingBlock());
    } else {
      text.textContent = view.text;
      card.appendChild(text);
    }

    // 右下角放大钮：悬停才出现（原版 .envelope-zoom-trigger 同款行为）。
    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "mail-card-zoom";
    zoom.title = "展开阅读";
    zoom.textContent = "⤢";
    zoom.addEventListener("click", (e) => {
      e.stopPropagation();
      openEnvelope(view.text);
    });
    card.appendChild(zoom);

    // ★ 2026-10-20：失败态的重试按钮。原版这张卡的版式里本来就留着右下角的重试位
    //   （`.mail-card-retry` 这条样式一直都在），但**从来没有代码渲染它** ——
    //   于是卡片印成"失败可重试"，用户却只能再写一封。动作由调用方给（`view.onRetry`）。
    if (view.kind === "retry" && typeof view.onRetry === "function") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "mail-card-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", (e) => {
        // 卡片本身点了是"拆信封"，别让重试顺带把卡点开。
        e.stopPropagation();
        retry.disabled = true;
        retry.textContent = "正在排队…";
        Promise.resolve()
          .then(() => view.onRetry())
          .catch(() => { retry.disabled = false; retry.textContent = "重试"; });
      });
      card.appendChild(retry);
    }

    // ★ 原版就是这样：卡片本身可点，点了才拆信封。不是所有信都适合展开 ——
    //   「她还在写」那张没有正文，展开一封信纸是空的，所以只给有正文的开。
    if (view.canOpen) {
      card.addEventListener("click", () => openEnvelope(view.text));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEnvelope(view.text); }
      });
    } else {
      card.style.cursor = "default";
    }
    host.appendChild(card);
  }

  function showEmpty(hint) {
    const host = $("mailBody");
    const empty = $("mailEmpty");
    if (!host || !empty) return;
    host.querySelectorAll(".mail-responsive-card").forEach((n) => n.remove());
    empty.hidden = false;
    const sub = empty.querySelector(".mail-content-empty-hint");
    if (sub && hint) sub.textContent = hint;
  }

  // ---------------------------------------------------------------- 写信

  let composeOpen = false;

  function openCompose() {
    const host = $("mailBody");
    const empty = $("mailEmpty");
    if (!host) return;
    composeOpen = true;
    if (empty) empty.hidden = true;
    host.querySelectorAll(".mail-responsive-card").forEach((n) => n.remove());

    const card = document.createElement("div");
    card.className = "mail-responsive-card mail-responsive-card-user";
    card.style.backgroundImage = `url("${IMG.user}")`;

    const meta = document.createElement("div");
    meta.className = "mail-card-meta";
    meta.textContent = "给林离写信";
    card.appendChild(meta);

    const area = document.createElement("textarea");
    area.id = "compose";
    area.className = "mail-box-write-content-textarea";
    area.maxLength = 4000;
    area.placeholder = "写点什么给她……";
    card.appendChild(area);

    // 视频邮票：4 支循环视频随机一支，可见即播；播不动退回静态邮票。
    const stamp = document.createElement("div");
    stamp.className = "mail-stamp";
    const video = document.createElement("video");
    video.className = "mail-stamp-video";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    const img = document.createElement("img");
    img.className = "mail-stamp-img";
    img.alt = "";
    img.hidden = true;
    const seed = Math.random();
    video.src = pick(STAMP_VIDEOS, seed);
    img.src = pick(STAMP_IMAGES, seed);
    video.addEventListener("error", () => { video.hidden = true; img.hidden = false; });
    stamp.appendChild(video);
    stamp.appendChild(img);
    card.appendChild(stamp);

    const send = document.createElement("button");
    send.type = "button";
    send.id = "sendBtn";
    send.className = "mail-footer-action-button mail-send-button";
    send.textContent = "寄出信件";
    card.appendChild(send);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "cancelCompose";
    cancel.className = "mail-send-cancel";
    cancel.textContent = "收起";
    card.appendChild(cancel);

    host.appendChild(card);
    area.focus();
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => { video.hidden = true; img.hidden = false; });

    cancel.addEventListener("click", () => { composeOpen = false; window.__mailRefresh?.(); });
    send.addEventListener("click", async () => {
      const content = area.value.trim();
      if (!content) return window.__mailToast?.(window.__mailCodeText?.("信是空的", "LETTER_EMPTY") ?? "信是空的");
      send.disabled = true;
      send.textContent = "寄出中……";
      try {
        await window.__mailSend(content);
        // ★ 寄出之后必须**自己**把这张卡收掉：__mailSend 里 loadLetters 会走到
        //   renderReader，而 renderReader 现在对"正在写信"是让路的（见 app.js 的注释），
        //   所以不在这里关，用户寄完还站在一张空的写信卡上（2026-10-18 实测）。
        composeOpen = false;
        window.__mailRefresh?.();
      } finally {
        send.disabled = false;
        send.textContent = "寄出信件";
      }
    });
  }

  // ---------------------------------------------------------------- 演奏页

  let playing = false;

  function openPlayer(title) {
    const page = $("playerPage");
    if (!page) return;
    playing = true;
    page.hidden = false;
    // ★ 显隐是**两条**：hidden 管"在不在无障碍树里"，.is-on 才管"画不画出来"。
    //   样式里 .player-page 是 display:none，只有 .player-page.is-on 是 display:block
    //   —— 只摘 hidden 的话，元素量出来是 0×0、整页还是不可见（2026-10-18 实测踩到）。
    page.classList.add("is-on");
    document.body.classList.add("is-playing");
    const t = $("playerTitle");
    if (t) t.textContent = title ?? "";
    // ★ 亮哪一枚由这里决定：app.js 的 play()/crossFadeTo() 管换片与交叉淡入，
    //   但哪一枚 .active 必须在**打开这一页时**就排一次 —— 重开时旧的 active 还留在
    //   另一枚上，两枚都不亮就是全黑。判据照 .under：上了 .under 的那枚在底下。
    for (const v of [$("playVideoA"), $("playVideoB")]) {
      if (v) v.classList.toggle("active", !v.classList.contains("under"));
    }
  }

  function closePlayer() {
    const page = $("playerPage");
    if (!page) return;
    playing = false;
    page.hidden = true;
    page.classList.remove("is-on");
    document.body.classList.remove("is-playing");
  }

  // ---------------------------------------------------------------- 事件

  function wire() {
    $("envelopeScene")?.addEventListener("click", (e) => {
      // 点信纸正文不算"打开"，只有点信封壳（还没展开时）才播动画。
      const box = $("envelope");
      if (!box || box.classList.contains("is-opening")) return;
      if (e.target.closest(".mail-envelope__letter")) return;
      unfoldEnvelope();
    });
    $("envelopeClose")?.addEventListener("click", (e) => { e.stopPropagation(); closeEnvelope(); });
    // ★ 「点一下拆信封」这句话写在信封下面（.mail-envelope__hint），可是那行字
    //   压根不是信封的子孙节点 —— 挂在场景层上的委托收不到它的点击。
    //   所以**同一个动作挂两处**（场景 + 提示语），两处都走 unfoldEnvelope（自带防重入）。
    $("envelopeHint")?.addEventListener("click", (e) => { e.stopPropagation(); unfoldEnvelope(); });
    $("envelopeOverlay")?.addEventListener("click", (e) => {
      // 点遮罩空白处关闭；点信封本体不关。
      if (e.target === $("envelopeOverlay") || e.target === $("envelopeScene")) closeEnvelope();
    });
    $("playerBack")?.addEventListener("click", () => {
      closePlayer();
      window.__mailStopPlayer?.();
    });
    $("writeBtn")?.addEventListener("click", () => openCompose());

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("envelopeOverlay") && !$("envelopeOverlay").hidden) return closeEnvelope();
      if (playing) { closePlayer(); window.__mailStopPlayer?.(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  window.__mailUI = {
    openEnvelope, closeEnvelope, renderCard, showEmpty, openCompose, openPlayer, closePlayer,
    get composing() { return composeOpen; },
  };
})();
