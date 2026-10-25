// 更新检查（实现思路照原版程序的本机服务，
// 那边的查询器与断点续传被压测与真机验证过；本文件只搬思路，路径与命名一律不抄）。
//
// 为什么要单独一个文件：`server.mjs` 一被 import 就会 listen 起服务，测试没法导入它。
//   版本比较、Release 解析、降级文案这些**纯逻辑**放在这里，护栏才能真的把它们读进来看。
//
// ★ 产品红线（本仓第一条）：**唯一外联＝用户自己填的模型 Key**。查更新是第二条外联，
//   所以它有三条自我约束，缺一条都不许上线：
//     ① 只在用户**点「检查更新」**时发请求（不在开机、不在进设置页、不在后台轮询时发）；
//     ② 只打 `api.github.com` / `github.com`，请求里不带任何本机信息（无 Cookie、无 Token、无设备码）；
//     ③ 失败一律**降级**成「打开发布页手动下载」，绝不假装「已是最新」，也绝不静默。
//
// ★ 版本口径：本仓的 tag 就写语义化版本（`1.0.0` / `v1.0.1` / `1.1.0-beta.1`），
//   和原版程序那套 `2008.2.7-linli9-1.0.5` 不同 —— 那边的 `releaseVersion()` 不用抄，
//   抄过来反而会把 `1.0.0-beta.1` 解析成「比 1.0.0 大」。

export const UPDATE_CHANNELS = Object.freeze(["stable", "beta"]);
export const DEFAULT_UPDATE_CHANNEL = "stable";

/** 成功结果的去重窗口：20 秒内连点「检查更新」不重复打外网（未登录 60 次/小时的配额很紧）。 */
export const UPDATE_CHECK_TTL_MS = 20_000;
/** 下载侧复用刚查到的结果；超过 10 分钟就先确认一次发布页（撤包/重传后地址会变）。 */
export const UPDATE_RELEASE_REUSE_MS = 600_000;
/** 限流退避 5 分钟，普通网络故障 60 秒 —— 两者不能共用同一个 TTL。 */
export const UPDATE_FAILURE_TTL_RATE_LIMITED_MS = 5 * 60_000;
export const UPDATE_FAILURE_TTL_MS = 60_000;
/** 单次查询上限（界面那边 8 秒时会给一句"仍在查询"，30 秒才放弃）。 */
export const UPDATE_TIMEOUT_MS = 30_000;
/** 更新日志最多展示 8000 字：Release 正文是用户可控文本，太长会把设置页撑爆。 */
export const UPDATE_NOTES_MAX = 8000;

export function normalizeUpdateChannel(text) {
  const value = String(text ?? "").trim().toLowerCase();
  return UPDATE_CHANNELS.includes(value) ? value : DEFAULT_UPDATE_CHANNEL;
}

/**
 * 剥掉 tag 的 v 前缀（`v1.0.0` → `1.0.0`）。
 * 只剥「v/V 紧跟数字」的那一个字符：`version-…` 这种正文开头的字母不许被当成前缀吃掉。
 */
export function stripTagPrefix(tag) {
  return String(tag ?? "").trim().replace(/^[vV](?=\d)/u, "");
}

/**
 * 把 tag 解析成可比较的两段：`{ nums: [主,次,修,第4段], pre: [预发布标识] }`。
 * 解析不出来返回 null —— 调用方据此走字符串兜底，而不是当成 0.0.0 把人按在更新提示里。
 *
 * 支持：`1.0.0` / `v1.0.0` / `1.0` / `1.0.0.3` / `1.1.0-beta.1` / `1.1.0+build.9`
 * 不支持（返回 null）：`nightly-2026` / `release/1.0` / 空串
 */
export function parseReleaseTag(tag) {
  const text = stripTagPrefix(tag);
  if (!text) return null;
  const m = /^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(text);
  if (!m) return null;
  const nums = m[1].split(".").map((part) => Number(part));
  while (nums.length < 4) nums.push(0);
  const pre = m[2] ? m[2].split(".").filter(Boolean) : [];
  return { nums, pre };
}

/**
 * 比两个**已解析**的版本：a < b 返 -1，相等 0，a > b 返 1。
 * 预发布规则照语义化版本：`1.1.0-beta.1 < 1.1.0`；标识逐段比，纯数字段按数值、其余按字典序，
 * 数字段小于字母段（这样 `beta.2 < beta.10`，`1.0.0-2 < 1.0.0-alpha`）。
 */
export function compareReleaseVersions(a, b) {
  for (let index = 0; index < 4; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] > b.nums[index] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  // 有预发布标识的那个更小：1.1.0-beta < 1.1.0
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;   // 前缀短的那个更小：beta < beta.1
    if (y === undefined) return 1;
    const xNumber = /^\d+$/u.test(x);
    const yNumber = /^\d+$/u.test(y);
    if (xNumber && yNumber) {
      const diff = Number(x) - Number(y);
      if (diff) return diff > 0 ? 1 : -1;
      continue;
    }
    if (xNumber) return -1;           // 数字段 < 字母段（语义化版本 11.4.3）
    if (yNumber) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 两边都解析不出来时的比较键（`nightly-2026` 这类非语义化 tag）。
 * ★ 这里把 v 前缀无条件剥掉（`stripTagPrefix` 只剥「v 紧跟数字」，因为 `version-1` 不能丢 v）；
 *   兜底路径上没有"这是不是一个版本号"的上下文，宁可把 `vnightly-a` 与 `nightly-a` 看成同一个，
 *   也不要因为一个前缀就永远提示可更新。顺带统一大小写。
 */
const fallbackVersionKey = (tag) => String(tag ?? "").trim().toLowerCase().replace(/^v/u, "");

/**
 * GitHub 上那条 tag 是否比本机版本新。
 *
 * ★ 解析失败时的兜底：仍然先剥 v 前缀再比字符串 —— 只差一个 `v` 不能被当成新版本，
 *   否则「装了最新版却永远提示可更新」（原版程序 1.0.6 踩过）。latest 为空时一律 false：
 *   降级应答里的 `latestTag` 就是空串，绝不能让它变成「有新版本」。
 */
export function isNewerRelease(currentTag, latestTag) {
  const latestText = stripTagPrefix(latestTag);
  if (!latestText) return false;
  const current = parseReleaseTag(currentTag);
  const latest = parseReleaseTag(latestTag);
  if (!current || !latest) return fallbackVersionKey(currentTag) !== fallbackVersionKey(latestTag);
  return compareReleaseVersions(latest, current) > 0;
}

/**
 * 安装包文件名判定。
 *
 * ★ 本仓的安装包叫 `OliviaSoul-community独立版-1.0.0-安装程序.exe`（install.iss 的
 *   `OutputBaseFilename`），不是原版程序的 `OliviaSoul-*-Setup.exe` —— 直接抄那条正则
 *   会一个包都匹配不上，表现成「最新 Release 没有安装包」。
 * ★ 只认 `.exe` + 「安装程序」两个特征，并且**先挡掉路径字符**：这个名字稍后要拼进落盘路径，
 *   `..\..\x.exe` 这种必须在这里就死掉，不能指望后面的 safePath 兜。
 */
export function isInstallerAssetName(name) {
  const text = String(name ?? "").trim();
  if (!text || text.length > 200) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(text)) return false;
  if (/^\.+$/u.test(text)) return false;
  return /^OliviaSoul.*安装程序\.exe$/iu.test(text);
}

export function updateReleasesPageUrl(repository) {
  return `https://github.com/${repository}/releases`;
}

/**
 * 把一条 GitHub Release 转成界面要的形态。
 *
 * optional=true 时（beta 列表里逐条挑）**没有安装包的条目返回 null 而不是抛错** ——
 * 测试版偶尔先建 Release 再传安装包，不能因此让整条通道查不到更新。
 */
export function releasePayloadFromRelease(release, { optional = false, repository = "" } = {}) {
  const latestTag = String(release?.tag_name ?? "").trim();
  const asset = Array.isArray(release?.assets)
    ? release.assets.find((item) => isInstallerAssetName(item?.name))
    : null;
  if (!latestTag || !asset) {
    if (optional) return null;
    throw new Error("最新 Release 没有安装包（发布页上还没有 .exe）");
  }
  let downloadUrl = null;
  try { downloadUrl = new URL(String(asset.browser_download_url ?? "")); } catch { downloadUrl = null; }
  // ★ 下载地址必须 https + github.com：这个地址最终会进下载器、进状态文件。
  //   不在这里钉死，一个被篡改的 Release 就能把下载指到任意主机。
  if (!downloadUrl || downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "github.com") {
    if (optional) return null;
    throw new Error("安装包下载地址无效（不是 https://github.com）");
  }
  return {
    latestTag,
    releaseUrl: String(release.html_url ?? updateReleasesPageUrl(repository)),
    publishedAt: String(release.published_at ?? ""),
    // 更新日志 = Release 正文。前端只许 textContent 渲染，绝不 innerHTML（正文是用户可控文本）。
    notes: String(release.body ?? "").trim().slice(0, UPDATE_NOTES_MAX),
    releaseName: String(release.name ?? "").trim().slice(0, 200),
    asset: {
      id: asset.id,
      name: String(asset.name),
      url: downloadUrl.toString(),
      size: Math.max(0, Number(asset.size) || 0),
      digest: String(asset.digest ?? "").trim().toLowerCase(),
    },
  };
}

/** 界面要的成功应答。`currentIsNewer` 由后端算 —— 前端不许自己比 tag 文本（v 前缀事故）。 */
export function buildUpdatePayload({ release, channel, currentTag, repository = "" }) {
  const latestTag = String(release?.latestTag ?? "");
  return {
    channel: normalizeUpdateChannel(channel),
    degraded: false,
    currentTag: String(currentTag ?? ""),
    latestTag,
    updateAvailable: isNewerRelease(currentTag, latestTag),
    currentIsNewer: isNewerRelease(latestTag, currentTag),
    releaseUrl: String(release?.releaseUrl ?? updateReleasesPageUrl(repository)),
    publishedAt: String(release?.publishedAt ?? ""),
    assetName: String(release?.asset?.name ?? ""),
    assetSize: Number(release?.asset?.size ?? 0) || 0,
    assetUrl: String(release?.asset?.url ?? ""),
    notes: String(release?.notes ?? ""),
    releaseName: String(release?.releaseName ?? ""),
  };
}

/**
 * 降级应答：**不是「假装成功」，也不是 502 让界面报错**。
 *
 * 为什么必须有这条路：用户机器上 github.com 可能被拦、可能限流、可能没网。
 * 「查不到更新」是常态而不是异常，界面必须给出可操作的出路（打开发布页）。
 * ★ 这里 `updateAvailable` 恒为 false 且 `latestTag` 恒为空 —— 降级**绝不等同于「已是最新」**，
 *   前端看 `degraded` 分支，文案里也不许出现「已是最新」。
 */
export function buildUpdateFailurePayload({ error, channel, currentTag, repository = "" }) {
  const reason = String(error?.message ?? error ?? "未知原因").trim() || "未知原因";
  const rateLimited = error?.code === "UPDATE_RATE_LIMITED";
  const network = !rateLimited && (
    error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || /(fetch failed|网络|连接|超时|超时未响应|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|UND_ERR|getaddrinfo|CERT|SSL|TLS|socket|aborted)/iu.test(reason)
  );
  return {
    channel: normalizeUpdateChannel(channel),
    degraded: true,
    rateLimited,
    reason,
    message: rateLimited ? `未能检查更新：${reason}`
      : network ? `无法连接更新服务，可手动到发布页下载（原因：${reason}）`
      : `检查更新失败：${reason}（可手动到发布页下载）`,
    currentTag: String(currentTag ?? ""),
    latestTag: "",
    updateAvailable: false,
    currentIsNewer: false,
    releaseUrl: updateReleasesPageUrl(repository),
    publishedAt: "",
    assetName: "",
    assetSize: 0,
    assetUrl: "",
    notes: "",
    releaseName: "",
  };
}

/** 失败按原因分档退避：配额按出口 IP 共享，越查越黑，必须退得久一点。 */
export function failureTtl(error) {
  return error?.code === "UPDATE_RATE_LIMITED" || error?.status === 403 || error?.status === 429
    ? UPDATE_FAILURE_TTL_RATE_LIMITED_MS
    : UPDATE_FAILURE_TTL_MS;
}

/**
 * 更新查询器：查询 / 去重 / 合并并发 / 失败退避 / 强制重查。
 *
 * 全部状态都在这个闭包里 —— 不是模块级全局，测试可以各建各的互不污染。
 */
export function createUpdateFeed({
  currentTag,
  repository,
  request = fetch,
  now = () => Date.now(),
  timeoutMs = UPDATE_TIMEOUT_MS,
  releaseReuseMs = UPDATE_RELEASE_REUSE_MS,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(repository ?? ""))) {
    throw new Error("更新仓库配置无效（要写成 owner/repo）");
  }
  const REPOSITORY = String(repository);
  /** 当前缓存条目：成功是 `{channel, at, release}`，失败多一个 `ttl`。 */
  let last = null;
  /** 同一通道上「正在进行的那次查询」。不设它的话，N 个客户端 = N 次外网往返。 */
  const inflight = new Map();
  /** 诊断用：真打了几次外网（护栏靠它判「并发只起一次」，不靠数耗时）。 */
  let requests = 0;

  async function fetchReleaseCandidates(signal, channel) {
    const beta = normalizeUpdateChannel(channel) === "beta";
    const endpoint = beta
      ? `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`
      : `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
    requests += 1;
    const response = await request(endpoint, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "LinliLetters-Updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 404) {
      // 仓库还没有任何 Release（本仓 1.0.0 发布前就是这种状态）。
      throw new Error("这个仓库还没有发布任何版本（Releases 里是空的），所以查不到更新");
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const resetAt = Number(response.headers.get("x-ratelimit-reset")) || 0;
      const at = resetAt ? new Date(resetAt * 1000) : null;
      const when = at && !Number.isNaN(at.getTime())
        ? `，约 ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} 后恢复`
        : "";
      if (response.status === 429 || remaining === "0") {
        const error = new Error(`GitHub 接口限流（未登录时每个出口 IP 每小时 60 次）${when}；`
          + "可稍后重试，或直接到发布页手动下载");
        error.code = "UPDATE_RATE_LIMITED";
        error.status = response.status;
        throw error;
      }
      const error = new Error(`GitHub HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`GitHub HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = await response.json();
    if (!beta) return [body];
    // draft 只有登录后才看得到，这里仍显式排除：将来若改成带 token 请求，也不会把草稿当正式版发出去。
    return (Array.isArray(body) ? body : []).filter((release) => release?.draft !== true);
  }

  async function fetchLatestRelease(signal, channel) {
    const beta = normalizeUpdateChannel(channel) === "beta";
    const candidates = await fetchReleaseCandidates(signal, channel);
    for (const candidate of candidates) {
      const release = releasePayloadFromRelease(candidate, { optional: beta, repository: REPOSITORY });
      if (release) return release;
    }
    throw new Error(beta
      ? "这个仓库还没有发布任何带安装包的版本（Releases 里是空的），所以查不到更新"
      : "最新 Release 没有安装包（发布页上还没有 .exe）");
  }

  const fresh = (entry, channel) => Boolean(entry)
    && entry.channel === channel
    && now() - entry.at < (entry.error ? entry.ttl : UPDATE_CHECK_TTL_MS);

  /**
   * 同一通道的查询合并成一次：并发的后来者等同一个 Promise。
   * ★ 必须在 finally 里比对**同一个 task** 再删 —— 否则一次失败会把这条通道永久钉死在
   *   那份 rejected Promise 上（原版程序 1.1.1 的原 bug）。
   */
  function coalesce(channel, run) {
    const pending = inflight.get(channel);
    if (pending) return pending;
    const task = (async () => run())().finally(() => {
      if (inflight.get(channel) === task) inflight.delete(channel);
    });
    inflight.set(channel, task);
    return task;
  }

  async function check(signal, channel) {
    const wanted = normalizeUpdateChannel(channel);
    const cached = fresh(last, wanted) ? last : null;
    if (cached) {
      if (cached.error) throw cached.error;
      return cached.release;
    }
    return coalesce(wanted, async () => {
      // 排队等锁期间前一个查询可能已经写好了缓存（成功或失败两种都算），先复查一次再用。
      const again = fresh(last, wanted) ? last : null;
      if (again) {
        if (again.error) throw again.error;
        return again.release;
      }
      try {
        const release = await fetchLatestRelease(signal, wanted);
        last = { channel: wanted, at: now(), release };
        return release;
      } catch (error) {
        last = { channel: wanted, at: now(), error, ttl: failureTtl(error) };
        throw error;
      }
    });
  }

  /** 强制重查（绕过复用）。给「下载发现地址/摘要和记录不符」用：这时只认发布页上的当下事实。 */
  async function renew(signal, channel) {
    const wanted = normalizeUpdateChannel(channel);
    const release = await fetchLatestRelease(signal, wanted);
    last = { channel: wanted, at: now(), release };
    return release;
  }

  function cachedRelease(channel) {
    const wanted = normalizeUpdateChannel(channel);
    return last && !last.error && last.channel === wanted ? last : null;
  }

  /**
   * 下载前拿 Release：
   *   · 刚查过（10 分钟内）就直接复用，省一次配额；
   *   · 太旧就先真查一次确认（不吃 check() 的 20 秒去重），**查不到就退回旧结果**
   *     —— 顺序不能反，否则「检查成功、点下载却撞上限流」。
   *   · releaseReuseMs = 0 表示不复用（每次下载都先确认一次）。
   */
  async function releaseForDownload(signal, channel) {
    const wanted = normalizeUpdateChannel(channel);
    const cached = cachedRelease(wanted);
    let release = cached && releaseReuseMs > 0 && now() - cached.at <= releaseReuseMs ? cached.release : null;
    if (!release) {
      try { release = await renew(signal, wanted); }
      catch (error) {
        if (!cached) throw error;
        release = cached.release;
      }
    }
    if (!isNewerRelease(currentTag, release.latestTag)) throw new Error("当前已经是最新版本");
    return release;
  }

  return {
    check,
    renew,
    cachedRelease,
    releaseForDownload,
    stats: () => ({ requests, channel: last?.channel ?? null, at: last?.at ?? null }),
  };
}
