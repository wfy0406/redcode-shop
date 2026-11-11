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

/** 分享內文（WhatsApp／系統分享 text）：全日强调全部場次；單場强调指定場次即睇即買。
 *  v2026.11.11：唔准無條件承諾「直播優惠價發售」——價錢／折扣係逐件貨嘅事實，
 *  以商品頁為準（同 api/lib/liveSeo.ts 及商品真描述口徑一致）。 */
export function liveShareText(t: LiveShareTarget): string {
  const d = formatLiveDateLabel(t.liveDate);
  return t.liveSession
    ? `RedCode ${d} 第${t.liveSession}場直播商品，呢場主播推介款式即睇即買；品名、價錢同庫存以商品頁為準！`
    : `RedCode ${d} 全日直播商品，當日全部場次精選一頁睇晒；品名、價錢同庫存以商品頁為準！`;
}

/** Facebook sharer（開新視窗；crawler 會跟入面 u= 嗰條 URL 讀 OG） */
export function facebookShareUrl(url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}

/** WhatsApp 分享（wa.me；文案＋連結一齊 encode） */
export function whatsappShareUrl(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`;
}

/** scheduleLiveMeta 用嘅最細 DOM 介面（測試可以注假 document） */
export interface LiveMetaElement {
  setAttribute(name: string, value: string): void;
  remove(): void;
}

export interface LiveMetaDom {
  title: string;
  head: { appendChild(el: LiveMetaElement): void };
  createElement(tag: string): LiveMetaElement;
  querySelector(selector: string): LiveMetaElement | null;
  querySelectorAll?(selector: string): { forEach(callback: (el: LiveMetaElement) => void): void };
}

export interface LiveMetaUpdate {
  title?: string;
  description?: string;
  /** 明確 robots 值：'index, follow' 還原可索引／'noindex, nofollow' 空場次 */
  robots?: 'index, follow' | 'noindex, nofollow';
  /** string＝設 self canonical＋og:url；null＝移除兩者；undefined＝唔郁（可逆設計） */
  canonicalPath?: string | null;
  /** error／真空場時清走首口舊直播 ItemList，避免 rendered JSON-LD 同而家事實相反。 */
  clearRouteSchema?: boolean;
}

/**
 * 直播場次頁嘅動態 meta 寫入（v2026.11.11.2）。
 *
 * 點解要 microtask：App root 嘅 SeoManager 係 parent component，React passive
 * effect 係 child 先、parent 後——Products 嘅 effect 就算即時寫入真摘要，
 * 都會俾 SeoManager 用 resolveSeo 舊通用句冚走（cached data 一 mount 就有嘅
 * 情況最明顯）。排入 microtask 之後，寫入會喺成個 effect flush（child＋parent）
 * 完結之後先執行，保證最終 rendered meta 係真摘要，唔係過渡版。
 *
 * 可逆：robots 同 canonicalPath 都係明確值——空場次寫 noindex／移除 canonical，
 * 之後故障返或者有貨返會寫返 index, follow／重建 canonical＋og:url（俾
 * querySelector 搵唔到嘅元素會 createElement 重建）。
 * 全部寫入都係 caller 提供嘅真資料；呢個函數唔會自己編文案。
 */
export function scheduleLiveMeta(
  meta: LiveMetaUpdate,
  doc: LiveMetaDom = document as unknown as LiveMetaDom,
): void {
  queueMicrotask(() => {
    if (meta.clearRouteSchema) {
      doc.querySelectorAll?.('script[data-redcode-route-schema^="/products?liveDate="]')
        .forEach((script) => script.remove());
    }
    if (meta.title) doc.title = meta.title;
    if (meta.description) {
      doc.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
    }
    if (meta.robots) {
      doc.querySelector('meta[name="robots"]')?.setAttribute('content', meta.robots);
    }
    if (meta.canonicalPath !== undefined) {
      const canonical = doc.querySelector('link[rel="canonical"]');
      const ogUrl = doc.querySelector('meta[property="og:url"]');
      if (meta.canonicalPath === null) {
        // 空場次唔係可索引頁：canonical 同 og:url 一齊移除（同 server 空場次一致）
        canonical?.remove();
        ogUrl?.remove();
      } else {
        const url = `https://redcode.red${meta.canonicalPath}`;
        // 還原 self canonical：俾移除咗嘅 link 要重建（empty→有貨／error 恢復可逆）
        const link = canonical ?? doc.createElement('link');
        link.setAttribute('rel', 'canonical');
        link.setAttribute('href', url);
        if (!canonical) doc.head.appendChild(link);
        if (ogUrl) {
          ogUrl.setAttribute('content', url);
        } else {
          const og = doc.createElement('meta');
          og.setAttribute('property', 'og:url');
          og.setAttribute('content', url);
          doc.head.appendChild(og);
        }
      }
    }
  });
}
