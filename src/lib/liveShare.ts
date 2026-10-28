/**
 * 直播節目分享（v2026.10.28.2）：全日／單場商品頁嘅分享 URL、文案、
 * Facebook／WhatsApp share link。全部純函數，唔掂 DOM／React，方便測試。
 *
 * 鐵律：
 * - 分享 URL 只含 `/products?liveDate=YYYYMMDD`（可加 `&liveSession=N`），
 *   用 URLSearchParams 正確編碼；本地 keyword 絕對唔入分享 URL。
 * - 入參先驗證：liveDate 要係真實日曆日期（20260230 唔收），liveSession 要係
 *   正整數字串；無效輸入絕對唔會反映落 URL／文案（normalize 回 null，
 *   caller 見 null 就唔好出分享掣）。
 */

/** YYYYMMDD 且係真實日曆日期（閏年都計；20230229／20261301 呢類唔過） */
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

/** 場次：正整數字串 1–999（前導零／小數／負數／非數字一律唔收） */
export function isValidLiveSession(s: string): boolean {
  return /^[1-9]\d{0,2}$/.test(s);
}

/** YYYYMMDD → 「2026年10月28日」（前提：已過 isValidLiveDate） */
export function formatLiveDateLabel(d: string): string {
  return `${d.slice(0, 4)}年${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日`;
}

export interface LiveShareTarget {
  liveDate: string;
  liveSession: string | null;
}

/**
 * 驗證＋正規化分享目標。liveDate 無效，或者 liveSession 出現但無效 → null
 * （caller 唔好出分享 UI，更唔可以將 raw input 放入 URL）。
 */
export function normalizeLiveShare(
  liveDate: string,
  liveSession?: string | null,
): LiveShareTarget | null {
  if (!isValidLiveDate(liveDate)) return null;
  if (liveSession == null || liveSession === '') return { liveDate, liveSession: null };
  if (!isValidLiveSession(liveSession)) return null;
  return { liveDate, liveSession };
}

/** 分享路徑：`/products?liveDate=YYYYMMDD` 或加 `&liveSession=N`（URLSearchParams 編碼） */
export function liveSharePath(t: LiveShareTarget): string {
  const p = new URLSearchParams({ liveDate: t.liveDate });
  if (t.liveSession) p.set('liveSession', t.liveSession);
  return `/products?${p.toString()}`;
}

/** 完整分享 URL（origin 尾隨嘅 / 會剝走，避免雙斜線） */
export function liveShareUrl(origin: string, t: LiveShareTarget): string {
  return `${origin.replace(/\/+$/, '')}${liveSharePath(t)}`;
}

/** 分享標題（系統分享 title）：全日／單場有分別 */
export function liveShareTitle(t: LiveShareTarget): string {
  const d = formatLiveDateLabel(t.liveDate);
  return t.liveSession
    ? `${d} 第${t.liveSession}場直播商品｜RedCode`
    : `${d} 全日直播商品｜RedCode`;
}

/** 分享內文（WhatsApp／系統分享 text）：全日强调全部場次；單場强调指定場次即睇即買 */
export function liveShareText(t: LiveShareTarget): string {
  const d = formatLiveDateLabel(t.liveDate);
  return t.liveSession
    ? `RedCode ${d} 第${t.liveSession}場直播商品，呢場主播推介款式即睇即買，直播優惠價發售！`
    : `RedCode ${d} 全日直播商品，當日全部場次精選一頁睇晒，直播優惠價發售！`;
}

/** Facebook sharer（開新視窗；crawler 會跟入面 u= 嗰條 URL 讀 OG） */
export function facebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}

/** WhatsApp 分享（wa.me；文案＋連結一齊 encode） */
export function whatsappShareUrl(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`;
}
