/**
 * FB 影片連結工具（v2.2.7 老闆問「share/v/ 呢款得唔得」）
 *
 * Facebook 嵌入播放器（plugins/video.php）只認得含數字 ID 嘅影片永久連結。
 * 但老闆推送時入嘅可能係 share/v/、fb.watch 短鏈——呢啲要跟 redirect
 * 先去到我正式影片地址。所以呢度：
 *   1) fbVideoIdOf：由 URL 抽數字影片 ID（/videos/、watch?v=、/reel/、/posts/、story_fbid=）
 *   2) resolveFbEmbedUrl：抽唔到又係短鏈 → server 跟一次 redirect 解鏈再抽
 *      （結果入 memory cache，同一條鏈唔會重複解；失敗回 null，前端自然跌落「彈去 FB app」）
 *
 * 安全：只對 facebook.com／fb.watch／fb.me 域發请求；4 秒 timeout；URL 唔落 log。
 */

const ID_PATTERNS: RegExp[] = [
  /facebook\.com\/(?:[\w.%-]+\/)?(?:videos|reel)\/(\d{5,})/i,
  /[?&]v=(\d{5,})/,
  /facebook\.com\/(?:[\w.%-]+\/)?posts\/(\d{5,})/i,
  /[?&]story_fbid=(\d{5,})/,
];

const SHORT_LINK_RE = /(?:facebook\.com\/share\/|fb\.watch\/|fb\.me\/)/i;

export function fbVideoIdOf(url: string): string | null {
  for (const re of ID_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return m[1];
  }
  return null;
}

function embedForId(id: string): string {
  const canonical = `https://www.facebook.com/watch/?v=${id}`;
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonical)}&show_text=false&autoplay=1`;
}

/** url → 可嵌入嘅正式影片 ID（memory cache；null = 解過但解唔到） */
const resolvedCache = new Map<string, string | null>();

export async function resolveFbEmbedUrl(url: string): Promise<string | null> {
  const direct = fbVideoIdOf(url);
  if (direct) return embedForId(direct);
  if (!SHORT_LINK_RE.test(url)) return null;

  if (resolvedCache.has(url)) {
    const cached = resolvedCache.get(url);
    return cached ? embedForId(cached) : null;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // 扮普通瀏覽器，fb 先肯回 301 去正式地址
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    const id = fbVideoIdOf(res.url);
    if (resolvedCache.size > 500) resolvedCache.clear();
    resolvedCache.set(url, id);
    return id ? embedForId(id) : null;
  } catch {
    if (resolvedCache.size > 500) resolvedCache.clear();
    resolvedCache.set(url, null);
    return null;
  }
}
