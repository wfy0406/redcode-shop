import type { RouteMeta } from "./og";

/**
 * 直播節目頁 SEO（v2026.10.28.2）：`/products?liveDate=YYYYMMDD[&liveSession=N]`
 * 首口 HTML 注入全日／單場專屬 title / description / og:url / canonical，
 * crawler（FB／WhatsApp／Google）唔行 JS 都讀到節目專屬預覽。
 *
 * 純函數、唔掂 DB（直播日期／場次本身就係客人手㨂嘅公開參數，唔使查庫）。
 *
 * 安全鐵律：
 * - liveDate 必須係真實日曆日期；liveSession 必須係正整數字串。
 * - 任何參數無效 → parse 回 null，caller 用返通用 /products meta；
 *   **絕對唔好將 raw input 反射落 title/description/canonical**（XSS／open-graph 注入）。
 */

/** YYYYMMDD 且係真實日曆日期（閏年計在內；20230229／20261301 唔過） */
export function isValidLiveDate(d: string): boolean {
  if (!/^\d{8}$/.test(d)) return false;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day
  );
}

/** 場次：正整數字串 1–999（前導零／小數／負數／非數字唔收） */
export function isValidLiveSession(s: string): boolean {
  return /^[1-9]\d{0,2}$/.test(s);
}

/** YYYYMMDD → 「2026年10月28日」（前提：已過 isValidLiveDate） */
export function formatLiveDateLabel(d: string): string {
  return `${d.slice(0, 4)}年${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日`;
}

export interface LiveFilter {
  liveDate: string;
  liveSession: string | null;
}

/**
 * 解析 query 參數成直播篩選。
 * - 冇 liveDate → null（caller 行通用 /products 流程，唔係錯）。
 * - liveDate 無效、或者 liveSession 出現但無效 → 都係 null（通用 fallback，
 *   永遠唔反射無效輸入；canonical 唔會出現唔合法嘅 query）。
 */
export function parseLiveQuery(
  liveDate: string | null,
  liveSession: string | null,
): LiveFilter | null {
  if (liveDate == null || liveDate === "") return null;
  if (!isValidLiveDate(liveDate)) return null;
  if (liveSession != null && liveSession !== "") {
    if (!isValidLiveSession(liveSession)) return null;
    return { liveDate, liveSession };
  }
  return { liveDate, liveSession: null };
}

/** canonical／og:url 用嘅 path：`/products?liveDate=YYYYMMDD` 或加 `&liveSession=N` */
export function livePath(f: LiveFilter): string {
  const p = new URLSearchParams({ liveDate: f.liveDate });
  if (f.liveSession) p.set("liveSession", f.liveSession);
  return `/products?${p.toString()}`;
}

/** 全日强调當日全部場次；單場强调指定場次＋即睇直播商品（兩條文案一定要有分別） */
export function liveTitle(f: LiveFilter): string {
  const d = formatLiveDateLabel(f.liveDate);
  return f.liveSession
    ? `${d} 第${f.liveSession}場直播商品｜RedCode Fashion Design`
    : `${d} 全日直播商品｜RedCode Fashion Design`;
}

export function liveDescription(f: LiveFilter): string {
  const d = formatLiveDateLabel(f.liveDate);
  return f.liveSession
    ? `RedCode ${d} 第${f.liveSession}場直播商品——呢一場主播推介嘅女裝款式即睇直播商品、睇中即刻落單，直播優惠價發售，順豐站自取。`
    : `RedCode ${d} 直播全日全部場次嘅精選女裝，一頁睇晒當日所有直播商品，直播優惠價發售，順豐站自取。`;
}

/**
 * 由 raw query 參數出 RouteMeta（俾 injectRouteMeta 注入）。
 * 無效／冇直播參數 → null（caller 用通用 /products meta）。
 */
export function liveRouteMeta(
  liveDate: string | null,
  liveSession: string | null,
): RouteMeta | null {
  const f = parseLiveQuery(liveDate, liveSession);
  if (!f) return null;
  return { title: liveTitle(f), description: liveDescription(f), path: livePath(f) };
}
