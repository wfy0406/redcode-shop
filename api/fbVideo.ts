/**
 * FB 影片連結工具（v2.2.7 加解鏈；v2.2.8 加強：login 牆／HTML 摷 ID）
 *
 * Facebook 嵌入播放器（plugins/video.php）只認得含數字 ID 嘅影片永久連結。
 * 老闆推送時入嘅可能係 share/v/、fb.watch 短鏈——呢啲要跟 redirect
 * 先去到我正式影片地址。而且 data center IP 去 fb 成日俾 login 牆擋：
 * 跳轉目標會係 login.php?next=<正式地址>，所以要再拆 query 參數；
 * 仲唔得就掃 HTML 入面嘅 "video_id"／og:url／watch?v=。
 *
 * 三個出口：
 *   · resolveFbVideoId  → 數字 ID 或 null
 *   · resolveFbEmbedUrl → plugins/video.php 嵌入 URL 或 null（回顧／直播頁用）
 *   · resolveFbCanonical→ 正式 watch 連結；解唔到就回原本條（推播跳轉用，
 *                         intent:// 配 watch 路徑 FB app 一定認得）
 *
 * 安全：只對 facebook.com／fb.watch／fb.me 域發请求；5 秒 timeout；URL 唔落 log。
 * 結果入 memory cache（冇 TTL——同一條連結嘅 ID 唔會變），>500 條清空。
 */

const ID_PATTERNS: RegExp[] = [
  /facebook\.com\/(?:[\w.%-]+\/)?(?:videos|reel)\/(\d{5,})/i,
  /[?&]v=(\d{5,})/,
  /facebook\.com\/(?:[\w.%-]+\/)?posts\/(\d{5,})/i,
  /[?&]story_fbid=(\d{5,})/,
];

const HTML_ID_PATTERNS: RegExp[] = [
  /"video_id"\s*:\s*"?(\d{5,})"?/i,
  /"videoID"\s*:\s*"?(\d{5,})"?/,
  /og:url[^>]*content="[^"]*?(?:videos|reel)\/(\d{5,})/i,
  /watch\?v=(\d{5,})/,
  // FB HTML 成日 escape 斜線（videos\/123），兩款都認
  /\/(?:videos|reel)\\?\/(\d{5,})/,
];

const SHORT_LINK_RE = /(?:facebook\.com\/share\/|fb\.watch\/|fb\.me\/)/i;

export function fbVideoIdOf(url: string): string | null {
  for (const re of ID_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** login 牆款：login.php?next=<正式 FB 地址>——拆 query 參數摷返入面條鏈 */
function idFromNestedParams(url: string): string | null {
  try {
    const u = new URL(url);
    for (const key of ["next", "u", "url", "redirect_uri"]) {
      const inner = u.searchParams.get(key);
      if (inner && /facebook\.com/i.test(inner)) {
        const id = fbVideoIdOf(inner);
        if (id) return id;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function idFromHtml(html: string): string | null {
  const head = html.slice(0, 400_000);
  for (const re of HTML_ID_PATTERNS) {
    const m = re.exec(head);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function embedForId(id: string): string {
  const canonical = `https://www.facebook.com/watch/?v=${id}`;
  // v2.2.27 備註：v2.2.26 試過加 muted=1 做靜音自動播，老闆實測 FB 播放器照樣
  // 唔理（Samsung 撳唔郁／iPhone 黑屏）——手機上唯一穩陣係「手勢先載入 iframe」，
  // 所以唔再出靜音版；autoplay=1 留低，係為咗手勢載入後即播有聲。
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}&show_text=false&autoplay=1`;
}

/**
 * v2.2.11（老闆指令「播之前要有縮圖」）：影片縮圖。
 * graph.facebook.com/{id}/picture 係公開 endpoint，會 302 去 scontent CDN。
 * v2.2.14 老闆實測：對影片 ID 佢回嘅係通用灰圖（等於冇縮圖），
 * 所以直播／回顧已改用 resolveFbThumb 摷真縮圖；呢個留返備用。
 */
export function thumbForId(id: string): string {
  return `https://graph.facebook.com/${id}/picture`;
}

/**
 * v2.2.14（老闆指令「直播回顧要有真預覽圖，唔係個個一樣」）：伺服器摷真縮圖。
 * 做法：假扮嵌入播放器自己，問 plugins/video.php 攞播放器 HTML
 * （v2.2.9 實證呢條路 FB 對 data center IP 封得冇咁盡），
 * 喺 HTML 入面摷 og:image／"thumbnailImage" uri——係 scontent CDN 嘅真縮圖。
 * v2.2.21：scontent URL 有時效（oe/oh 參數），直載成日 404——所以而家由
 * GET /api/live-thumb/:id（boot.ts）經呢度摷 URL 再代載 bytes 自 host，
 * 客人部機淨係載我哋自己域名；摷唔到／被封 → null，endpoint 回 404，
 * 前端自行跌落設計 poster。
 * cache：摷到 cache 6 個鐘（scontent URL 有時效，唔好 cache 死）；
 *        摷唔到只 cache 15 分鐘（等 FB 解封後快啲恢復）。
 */
const THUMB_OK_TTL_MS = 6 * 60 * 60 * 1000;
const THUMB_MISS_TTL_MS = 15 * 60 * 1000;
const thumbCache = new Map<string, { url: string | null; at: number }>();

const THUMB_PATTERNS: RegExp[] = [
  /og:image(?::url)?[^>]*content="([^"]+)"/i,
  /content="([^"]+)"[^>]*og:image/i,
  /twitter:image[^>]*content="([^"]+)"/i,
  /"thumbnailImage"\s*:\s*\{[^{}]*"uri"\s*:\s*"([^"]+)"/,
  /"preferred_thumbnail"\s*:\s*\{[^{}]*"uri"\s*:\s*"([^"]+)"/,
  /"videoThumbnail"\s*:\s*\{[^{}]*"uri"\s*:\s*"([^"]+)"/,
  /"thumbSrc"\s*:\s*"([^"]+)"/,
  /\sposter="([^"]+)"/i,
];

/** FB HTML 入面嘅 URL 成日係 JSON escape（\/、\uXXXX）或者 HTML entity（&amp;），統一拆返 */
function unescapeFbUrl(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function thumbFromHtml(html: string): string | null {
  const head = html.slice(0, 600_000);
  for (const re of THUMB_PATTERNS) {
    const m = re.exec(head);
    if (m?.[1]) {
      const url = unescapeFbUrl(m[1]);
      // 安全：只准 FB CDN 域——唔好畀 HTML 入面嘅任咩 URL 變成我哋嘅「縮圖」
      if (isFbCdnUrl(url)) return url;
    }
  }
  return null;
}

/** 摷縮圖嘅實際工序——分開埋「點解摷唔到」＋「邊個來源摷中」，後台預覽診斷用（v2.2.15） */
export type ThumbProbe = {
  url: string | null;
  reason:
    | "ok_microlink"
    | "ok_oembed"
    | "ok_noembed"
    | "ok_html"
    | "ok_mwatch"
    | "ok_watch"
    | "fetch_fail"
    | "no_match";
};

/** 扮普通瀏覽器嘅 headers——oEmbed／video.php 路線用（同 resolveFbVideoId 一款） */
const THUMB_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
} as const;

/** v2.2.29：行動版 UA——m.facebook.com 對桌面 UA 嘅 data center IP 特別盡封，
 *  扮 iPhone Safari 先肯回真 watch 頁 HTML（og:image 喺入面） */
const THUMB_FETCH_HEADERS_MOBILE = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
} as const;

/** 只准 FB CDN 域——唔好畀上游回嘅任咩 URL 變成我哋嘅「縮圖」 */
function isFbCdnUrl(url: string): boolean {
  return /^https:\/\/[^/]*\.(fbcdn\.net|fbsbx\.com)\//.test(url);
}

/** 摷 JSON 回應入面嘅 thumbnail_url（oEmbed／noembed 兩條路線共用）；fetch 失敗 → undefined（當撞牆） */
async function jsonThumb(
  url: string,
  headers: Record<string, string>,
): Promise<string | null | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as {
      thumbnail_url?: unknown;
    } | null;
    const thumb = typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null;
    // 安全：只准 FB CDN 域——唔好畀上游回嘅任咩 URL 變成我哋嘅「縮圖」
    return thumb && isFbCdnUrl(thumb) ? thumb : null;
  } catch {
    return undefined;
  }
}

/** 摷 HTML 頁入面嘅 og:image／thumbnailImage（video.php／m.facebook／www watch 共用） */
async function htmlThumb(
  url: string,
  headers: Record<string, string>,
): Promise<string | null | undefined> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    return thumbFromHtml(await res.text());
  } catch {
    return undefined;
  }
}

/**
 * v2.2.39（老闆實測：五條 FB 路線又全數被封，deploy 清 cache 後縮圖全軍跌 poster）：
 * 第六條路線——microlink（api.microlink.io，免 key 第三方 metadata proxy）。
 * 佢哋用自己嘅 server 摷 FB og:image 再回 JSON，我哋 server 全程唔掂 facebook.com，
 * FB 點封我哋 IP 都照摷到。v2.2.39 起排第一——其餘五條全部直連 FB，封緊嗰陣
 * 逐條試只係嘥時間；microlink 冇效先跌落去舊路線碰運氣。
 * 留意：microlink 免費額有限（每 IP 每日幾十次）——thumbCache 6 個鐘＋
 * v2.2.38 persistent disk 雙保險之下，每條片實際只會摷一兩次，用量極低。
 * 佢回嘅 image.url 照過 isFbCdnUrl 白名單先收，唔會變成任咩 URL 嘅 proxy。
 */
async function microlinkThumb(canonical: string): Promise<string | null | undefined> {
  try {
    const ctrl = new AbortController();
    // microlink 代摷要行佢哋自己嘅流程，比直摷慢——畀佢 12 秒
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(canonical)}`, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as {
      status?: unknown;
      data?: { image?: { url?: unknown } | null } | null;
    } | null;
    if (data?.status !== "success") return null;
    const raw = data?.data?.image?.url;
    const thumb = typeof raw === "string" ? raw : null;
    // 安全：只准 FB CDN 域——同其他路線一款規矩
    return thumb && isFbCdnUrl(thumb) ? thumb : null;
  } catch {
    return undefined;
  }
}

async function fetchThumb(id: string): Promise<ThumbProbe> {
  // v2.2.29（老闆實測：回顧縮圖「又無晒」——部署重開清 cache 後三條舊路線全被封）：
  // 擴成五條路線逐條試，一條中即回。undefined＝撞牆（timeout／非 200），null＝回咗但冇圖。
  // v2.2.39：六條路線。順序：microlink 代摷（唔經 FB，封唔到）→ 官方 oEmbed
  // → noembed 代摷 → video.php 播放器 HTML → m.facebook 行動版（電話 UA）→ www watch 桌面頁。
  // URL 唔落 log（鐵律）。
  const canonical = canonicalForId(id);
  const routes: Array<() => Promise<{ url: string; reason: ThumbProbe["reason"] } | null | undefined>> = [
    async () => {
      const t = await microlinkThumb(canonical);
      return t === undefined ? undefined : t ? { url: t, reason: "ok_microlink" } : null;
    },
    async () => {
      const t = await jsonThumb(
        `https://www.facebook.com/plugins/video/oembed.json?url=${encodeURIComponent(canonical)}`,
        THUMB_FETCH_HEADERS,
      );
      return t === undefined ? undefined : t ? { url: t, reason: "ok_oembed" } : null;
    },
    async () => {
      const t = await jsonThumb(
        `https://noembed.com/embed?url=${encodeURIComponent(canonical)}`,
        THUMB_FETCH_HEADERS,
      );
      return t === undefined ? undefined : t ? { url: t, reason: "ok_noembed" } : null;
    },
    async () => {
      const t = await htmlThumb(
        `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}&show_text=false`,
        THUMB_FETCH_HEADERS,
      );
      return t === undefined ? undefined : t ? { url: t, reason: "ok_html" } : null;
    },
    async () => {
      const t = await htmlThumb(
        `https://m.facebook.com/watch/?v=${id}`,
        THUMB_FETCH_HEADERS_MOBILE,
      );
      return t === undefined ? undefined : t ? { url: t, reason: "ok_mwatch" } : null;
    },
    async () => {
      const t = await htmlThumb(canonical, THUMB_FETCH_HEADERS);
      return t === undefined ? undefined : t ? { url: t, reason: "ok_watch" } : null;
    },
  ];

  let sawNoMatch = false;
  for (const route of routes) {
    const hit = await route();
    if (hit) return hit;
    if (hit === null) sawNoMatch = true;
  }
  // 全部路線回咗但冇圖 → no_match（FB 真係冇提供）；有撞牆 → fetch_fail（遲啲會自動好返）
  return { url: null, reason: sawNoMatch ? "no_match" : "fetch_fail" };
}

export async function resolveFbThumb(id: string): Promise<string | null> {
  const hit = thumbCache.get(id);
  if (hit) {
    const ttl = hit.url ? THUMB_OK_TTL_MS : THUMB_MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.url;
  }
  const probe = await fetchThumb(id);
  if (thumbCache.size > 500) thumbCache.clear();
  thumbCache.set(id, { url: probe.url, at: Date.now() });
  return probe.url;
}

/**
 * v2.2.29：丟咗某條 ID 嘅 cache——boot.ts 代載 bytes 失敗時用。
 * scontent URL 有時效（oe/oh 參數），cache 咗 6 個鐘內可能已過期；
 * 丟 cache 即場重摷，等 endpoint 可以自愈，唔使等 TTL 先恢復。
 */
export function evictFbThumb(id: string): void {
  thumbCache.delete(id);
}

/** 後台預覽診斷用（v2.2.15 老闆指令）：唔經 cache 即場摷，連「點解摷唔到」一齊回；
 *  reason 標註邊個來源摷中：ok_microlink（第三方代摷，唔經 FB，v2.2.39）／ok_oembed（官方 oEmbed JSON）／
 *  ok_noembed（第三方 oEmbed proxy）／ok_html（播放器 HTML og:image）／
 *  ok_mwatch（行動版 watch 頁，電話 UA）／ok_watch（桌面 watch 頁）；
 *  六條路線全敗先回 fetch_fail／no_match */
export async function probeFbThumb(id: string): Promise<ThumbProbe> {
  return fetchThumb(id);
}

export function canonicalForId(id: string): string {
  return `https://www.facebook.com/watch/?v=${id}`;
}

/** url → 影片 ID（memory cache；null = 解過但解唔到） */
const idCache = new Map<string, string | null>();

export async function resolveFbVideoId(url: string): Promise<string | null> {
  const direct = fbVideoIdOf(url) ?? idFromNestedParams(url);
  if (direct) return direct;
  if (!SHORT_LINK_RE.test(url)) return null;

  if (idCache.has(url)) return idCache.get(url) ?? null;

  let id: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // 扮普通瀏覽器，fb 先肯回 301／回 HTML（官方 API 冇 token 解唔到短鏈）
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
      },
    });
    clearTimeout(timer);
    id =
      fbVideoIdOf(res.url) ??
      idFromNestedParams(res.url) ??
      idFromHtml(await res.text());
  } catch {
    id = null;
  }

  // v2.2.9 老闆實測短鏈解唔到（FB 封 data center IP）：第二招——
  // 假扮係嵌入播放器自己，直接問 plugins/video.php 攞播放器 HTML，
  // 入面成日有 "video_id"／正式影片地址；呢條路 FB 封得冇咁盡。
  if (!id) {
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 5000);
      const res2 = await fetch(
        `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`,
        {
          method: "GET",
          redirect: "follow",
          signal: ctrl2.signal,
          headers: {
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
          },
        },
      );
      clearTimeout(timer2);
      id = idFromHtml(await res2.text());
    } catch {
      id = null;
    }
  }

  if (idCache.size > 500) idCache.clear();
  idCache.set(url, id);
  return id;
}

/** 回顧／直播頁嵌入用：解到 ID → video.php 嵌入 URL；解唔到 → null（前端跌落「彈去 FB app」） */
export async function resolveFbEmbedUrl(url: string): Promise<string | null> {
  const id = await resolveFbVideoId(url);
  return id ? embedForId(id) : null;
}

/** 推播跳轉用：解到 ID → 正式 watch 連結（FB app intent filter 一定認得 /watch）；解唔到 → 原本條 */
export async function resolveFbCanonical(url: string): Promise<string> {
  const id = await resolveFbVideoId(url);
  return id ? canonicalForId(id) : url;
}
