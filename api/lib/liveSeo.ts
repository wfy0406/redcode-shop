import type { RouteMeta } from "./og";
import {
  emptyLivePublicCopy,
  livePublicDescription,
  type LivePublicSummary,
} from "@contracts/livePublicSummary";

/**
 * 直播節目頁 SEO（v2026.10.28.2）：`/products?liveDate=YYYYMMDD[&liveSession=N]`
 * 首口 HTML 注入全日／單場專屬 title / description / og:url / canonical，
 * crawler（FB／WhatsApp／Google）唔行 JS 都讀到節目專屬預覽。
 *
 * v2026.11.11：格式合法 ≠ 可索引。邊個日期／場次真係有公開商品，
 * 要由 caller 用公開商品目錄查詢（catalogSeo.listPublicCatalog）證實：
 * - 查到有公開商品 → liveRouteMeta（self canonical＋直播專屬文案）。
 * - 查詢成功但零公開商品（未開賣／已下架嘅空場次）→ emptyLiveRouteMeta
 *   （noindex＋移除 self canonical，唔准扮有貨）。
 * - DB 故障 → caller 回通用 /products meta，唔好誤報空場次。
 * 呢個檔保持純函數、唔掂 DB；DB 分叉決定喺 caller（vite.ts）。
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
  // 唔准無條件承諾「直播優惠價發售」——價錢／折扣係逐件貨嘅事實，
  // 一律以商品頁為準（同 contracts/types.ts productSeoDescription 口徑一致）。
  return f.liveSession
    ? `RedCode ${d} 第${f.liveSession}場直播商品——呢一場主播推介嘅女裝款式即睇直播商品、睇中即刻落單；品名、價錢同庫存以商品頁為準，順豐站自取。`
    : `RedCode ${d} 直播全日全部場次嘅精選女裝，一頁睇晒當日所有直播商品；品名、價錢同庫存以商品頁為準，順豐站自取。`;
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

/**
 * 真空場次（caller 已用公開商品目錄證實零公開商品）嘅 meta：
 * 如實講暫未公開／已下架，noindex＋移除 self canonical——
 * 唔准再用直播專屬 title/description 扮有貨（薄頁誤導 crawler）。
 * 文案嚟自 contracts/livePublicSummary.emptyLivePublicCopy——React 空場次
 * meta 分流用同一個 builder，前後端一字唔差。
 * f 係已過 parseLiveQuery 嘅合法值，先會出現喺文案；raw input 永遠唔入。
 */
export function emptyLiveRouteMeta(f: LiveFilter): RouteMeta {
  const copy = emptyLivePublicCopy(f);
  // 雙重保險：正常唔會 null（f 已過真日曆驗證）；萬一都係保守 noindex
  if (!copy) return { canonical: null, noindex: true };
  return { ...copy, canonical: null, noindex: true };
}

/**
 * sitemap 用嘅直播全日／單場 URL（由公開商品查詢得出嘅 liveDate/liveSession 組合）。
 * DB 落嚟嘅值都照過 parseLiveQuery——唔合法嘅日期／場次唔入 sitemap；
 * 同一 URL（全日同單場各自）去重。
 */
export function liveSitemapPaths(
  filters: readonly (LiveFilter | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of filters) {
    const f = raw ? parseLiveQuery(raw.liveDate, raw.liveSession) : null;
    if (!f) continue;
    const p = livePath(f);
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

function escapeLiveHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * /live 首口真節目內鏈：同一個公開商品查詢得出嘅日期／場次先會出現，
 * 假日曆日期、無效場次同 raw 注入字串一律由 liveSitemapPaths 過濾。
 * 最新日期排先、同日主頁後按場次號排序；上限避免首口 HTML 無限膨脹。
 */
export function renderPublicLiveIndex(
  filters: readonly (LiveFilter | null | undefined)[],
  limit = 24,
): string {
  const entries = liveSitemapPaths(filters)
    .map((path) => {
      const url = new URL(path, "https://redcode.red");
      const filter = parseLiveQuery(url.searchParams.get("liveDate"), url.searchParams.get("liveSession"));
      return filter ? { path, filter } : null;
    })
    .filter((entry): entry is { path: string; filter: LiveFilter } => entry !== null)
    .sort((a, b) => {
      const byDate = b.filter.liveDate.localeCompare(a.filter.liveDate);
      if (byDate !== 0) return byDate;
      if (a.filter.liveSession === null) return b.filter.liveSession === null ? 0 : -1;
      if (b.filter.liveSession === null) return 1;
      return Number(a.filter.liveSession) - Number(b.filter.liveSession);
    });
  const cap = Number.isFinite(limit) ? Math.max(1, Math.min(48, Math.floor(limit))) : 24;
  const rows = entries.slice(0, cap).map(({ path, filter }) => {
    const label = `${formatLiveDateLabel(filter.liveDate)} ${filter.liveSession ? `第${filter.liveSession}場` : "全日"}直播商品`;
    return `<li><a href="${escapeLiveHtml(path)}">${escapeLiveHtml(label)}</a></li>`;
  });
  if (rows.length === 0) return "";
  return `<section id="redcode-live-index-seo"><h2>直播節目商品</h2><p>按日期或場次直接睇當日公開商品；品名、價錢同庫存以商品頁為準。</p><ul>${rows.join("")}</ul></section>`;
}

/** 加落 /live 已注入嘅公開摘要；冇真場次或注入失敗時保留原內容。 */
export function injectPublicLiveIndex(
  html: string,
  filters: readonly (LiveFilter | null | undefined)[],
): string {
  try {
    if (html.includes('id="redcode-live-index-seo"')) return html;
    const block = renderPublicLiveIndex(filters);
    if (!block) return html;
    return html.replace(
      '<nav aria-label="相關公開頁面">',
      `${block}<nav aria-label="相關公開頁面">`,
    );
  } catch {
    return html;
  }
}

/**
 * 真資料增強版直播 description（v2026.11.11.2）：真日期、場次、公開商品實數、
 * 真分類組成、代表商品名，全部來自 caller 用公開目錄查出嘅全場商品行
 * （summary 係真全場，唔係展示 cap 後嘅子集）。
 * 直接共用 contracts/livePublicSummary.livePublicDescription——React 場次摘要
 * 到位後嘅 document meta description 用同一個 builder，前後端一字唔差。
 * 過往場次（todayYmd 由 caller 用香港今日計）用中性「場次商品記錄」文案，
 * 唔聲稱舊優惠仍有效或一定已完結；冇真開播時間，所以文案絕對唔出時間。
 * summary 空（唔應該發生——caller 喺有貨先計）→ 跌返舊版通用直播文案。
 */
export function liveFactDescription(
  f: LiveFilter,
  summary: LivePublicSummary,
  todayYmd: string,
): string {
  return livePublicDescription(f, summary, todayYmd) ?? liveDescription(f);
}

/** JSON-LD ItemList 入面嘅商品（同首口 HTML 目錄顯示嘅係同一批） */
export interface LiveFactItem {
  id: number;
  name: string;
}

/**
 * 有真公開商品嘅直播節目頁 RouteMeta：直播專屬 title、真資料 description、
 * self canonical，再加只含真資料嘅 CollectionPage／ItemList structured data
 * （ItemList 就係首口 HTML 商品目錄嗰批真連結，numberOfItems 同顯示一致）。
 * products 表冇真開播時間／真回放／真 FAQ，所以**唔加** BroadcastEvent／
 * VideoObject／FAQ——唔准編。title 同 liveTitle 一致（首口同分享預覽唔分叉）。
 */
export function liveFactRouteMeta(
  f: LiveFilter,
  summary: LivePublicSummary,
  todayYmd: string,
  items: readonly LiveFactItem[],
): RouteMeta {
  const title = liveTitle(f);
  const description = liveFactDescription(f, summary, todayYmd);
  const path = livePath(f);
  const origin = "https://redcode.red";
  return {
    title,
    description,
    path,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title,
      description,
      url: `${origin}${path}`,
      inLanguage: "zh-Hant-HK",
      isPartOf: { "@type": "WebSite", name: "RedCode Fashion Design", url: `${origin}/` },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: items.length,
        itemListElement: items.map((p, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: `${origin}/products/${p.id}`,
          name: p.name,
        })),
      },
    },
  };
}
