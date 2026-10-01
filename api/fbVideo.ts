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
  reason: "ok_oembed" | "ok_html" | "ok_mwatch" | "fetch_fail" | "no_match";
};

/** 扮普通瀏覽器嘅 headers——oEmbed／video.php 兩條路線共用（同 resolveFbVideoId 一款） */
const THUMB_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
} as const;

/** 只准 FB CDN 域——唔好畀上游回嘅任咩 URL 變成我哋嘅「縮圖」 */
function isFbCdnUrl(url: string): boolean {
  return /^https:\/\/[^/]*\.(fbcdn\.net|fbsbx\.com)\//.test(url);
}

async function fetchThumb(id: string): Promise<ThumbProbe> {
  // v2.2.21（老闆實測：縮圖全部跌落 poster）：第一來源改做 FB oEmbed。
  // 舊路線摷 video.php 播放器 HTML，FB 對 data center IP 時好時壞 → 成日 fetch_fail；
  // oEmbed 係官方公開 endpoint，回 JSON 直出 thumbnail_url，輕身兼冇咁易封。
  // 摷唔到先落返原本嘅 HTML og:image 路線兜底。URL 唔落 log（鐵律）。
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      `https://www.facebook.com/plugins/video/oembed.json?url=${encodeURIComponent(canonicalForId(id))}`,
      {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: THUMB_FETCH_HEADERS,
      },
    );
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        thumbnail_url?: unknown;
      } | null;
      const thumb = typeof data?.thumbnail_url === "string" ? data.thumbnail_url : null;
      if (thumb && isFbCdnUrl(thumb)) return { url: thumb, reason: "ok_oembed" };
    }
    // oEmbed 非 200／冇 thumbnail_url／域唔啱：唔算敗，落返 HTML 路線
  } catch {
    // oEmbed 撞牆（timeout／網絡）：落返 HTML 路線
  }

  let fallbackReason: "fetch_fail" | "no_match" = "fetch_fail";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonicalForId(id))}&show_text=false`,
      {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: THUMB_FETCH_HEADERS,
      },
    );
    clearTimeout(timer);
    if (res.ok) {
      const thumb = thumbFromHtml(await res.text());
      if (thumb) return { url: thumb, reason: "ok_html" };
      fallbackReason = "no_match";
    }
    // 非 200／摷唔到 og:image：唔算完，落第三條路線
  } catch {
    // video.php 撞牆（timeout／網絡）：落第三條路線
  }

  // v2.2.23（老闆實測：oEmbed／video.php 喺 Render 長期失敗）：第三條路線——
  // m.facebook.com 行動版 watch 頁，對 data center IP 封得冇咁盡，HTML 照有 og:image
  // （重用 thumbFromHtml）。URL 唔落 log（鐵律）。
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://m.facebook.com/watch/?v=${id}`, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: THUMB_FETCH_HEADERS,
    });
    clearTimeout(timer);
    if (res.ok) {
      const thumb = thumbFromHtml(await res.text());
      if (thumb) return { url: thumb, reason: "ok_mwatch" };
      fallbackReason = "no_match";
    }
  } catch {
    // 三條路線全敗
  }
  return { url: null, reason: fallbackReason };
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

/** 後台預覽診斷用（v2.2.15 老闆指令）：唔經 cache 即場摷，連「點解摷唔到」一齊回；
 *  v2.2.21 起 reason 標註邊個來源摷中：ok_oembed（官方 oEmbed JSON）／ok_html（播放器 HTML og:image）；
 *  v2.2.23 加 ok_mwatch（行動版 watch 頁 og:image）——三條路線全敗先回 fetch_fail／no_match */
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
