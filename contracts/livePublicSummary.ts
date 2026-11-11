import { productCategoryLabel } from "./types";

/**
 * 直播場次公開摘要（v2026.11.11.2）——server 首口 HTML／meta description／JSON-LD
 * 同 React 可見場次區共用嘅**同一份事實邏輯**，唔准 crawler 一套、用戶另一套。
 *
 * 真資料鐵律：
 * - 全部數字（件數、分類組成）由 caller 提供嘅真公開商品行計出嚟；
 *   呢個模組純函數、唔掂 DB，亦唔會自己編任何數字。
 * - products 表只有 liveDate／liveSession，**冇真開播時間**——呢度絕對唔出時間。
 * - 過往場次只係「場次商品記錄」：唔聲稱舊優惠仍有效，亦唔斷言一定已完結；
 *   價錢、庫存、優惠一律以商品頁而家顯示為準。
 */

/** 摘要需要嘅最小事實欄位（唔需要 description——冇描述嘅舊商品一樣計到） */
export interface LivePublicSummaryItem {
  id: number;
  name: string;
  category?: string | null;
}

export interface LiveCategoryCount {
  label: string;
  count: number;
}

export interface LivePublicSummary {
  /** 該日／該場公開商品實數（caller 要俾全場行，唔係展示 cap 後嘅子集） */
  totalCount: number;
  /** 真分類組成：件數多→少，同數按 label 排（穩定輸出，方便測試同 GEO 引用） */
  categories: LiveCategoryCount[];
  /** 代表商品（輸入順序、有名先計），俾首口 HTML／React 出商品內鏈 */
  highlights: { id: number; name: string }[];
}

/** 代表商品最多幾多件（手機排版唔會俾長摘要撑爆） */
export const LIVE_HIGHLIGHT_CAP = 3;
/** 事實句最多列幾多類，其餘收埋做「等 N 類」 */
const FACT_CATEGORY_CAP = 4;

/**
 * 由真公開商品行計摘要。空陣列都安全（totalCount 0、categories/highlights 空），
 * 但 caller 應該喺有貨先出摘要（空場次行 noindex 分流，唔係出「0 件」頁）。
 */
export function summarizeLiveProducts(
  items: readonly LivePublicSummaryItem[],
  highlightCap = LIVE_HIGHLIGHT_CAP,
): LivePublicSummary {
  const byCategory = new Map<string, number>();
  const highlights: { id: number; name: string }[] = [];
  for (const item of items) {
    const label = productCategoryLabel(item.category);
    byCategory.set(label, (byCategory.get(label) ?? 0) + 1);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (name && highlights.length < highlightCap && Number.isInteger(item.id) && item.id > 0) {
      highlights.push({ id: item.id, name });
    }
  }
  const categories = [...byCategory.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hant-HK"));
  return { totalCount: items.length, categories, highlights };
}

/** 香港今日 YYYYMMDD（直播日期係香港曆日；formatToParts 唔靠 en-CA 字串格式） */
export function hkTodayYmd(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

export type LiveEra = "past" | "current";

/**
 * 場次時代：liveDate 早過香港今日 → 'past'（用中性「場次商品記錄」文案）。
 * 輸入格式唔合法 → 保守當 'current'（唔會將今日場次誤標做歷史記錄）。
 */
export function liveEra(liveDate: string, todayYmd: string): LiveEra {
  if (!/^\d{8}$/.test(liveDate) || !/^\d{8}$/.test(todayYmd)) return "current";
  return liveDate < todayYmd ? "past" : "current";
}

/**
 * 事實句（server meta description 同 React 場次區共用，一字唔差）：
 * 「共 N 件公開商品：上衣 5 件、裙 4 件；代表商品：A、B、C。」＋時代備註。
 * - includeHighlights=false：淨件數＋分類（React 會改用商品內鏈出代表商品名）。
 * - 過往場次：中性「場次商品記錄」，價錢／庫存／優惠以商品頁而家顯示為準；
 *   今日或未來場次：照舊「以商品頁為準」，唔承諾任何優惠。
 * 零商品回 ""（caller 行空場次分流，唔出「0 件」句子）。
 */
export function liveFactsSentence(
  summary: LivePublicSummary,
  era: LiveEra,
  opts: { includeHighlights?: boolean } = {},
): string {
  if (summary.totalCount <= 0) return "";
  const includeHighlights = opts.includeHighlights !== false;
  let out = `共 ${summary.totalCount} 件公開商品`;
  if (summary.categories.length > 0) {
    const shown = summary.categories.slice(0, FACT_CATEGORY_CAP);
    const more = summary.categories.length - shown.length;
    out += `：${shown.map((c) => `${c.label} ${c.count} 件`).join("、")}`;
    if (more > 0) out += ` 等 ${summary.categories.length} 類`;
  }
  if (includeHighlights && summary.highlights.length > 0) {
    out += `；代表商品：${summary.highlights.map((h) => h.name).join("、")}`;
  }
  out += "。";
  out +=
    era === "past"
      ? "呢頁係當日場次商品記錄；品名、價錢同庫存以商品頁而家顯示為準。"
      : "品名、價錢同庫存以商品頁為準。";
  return out;
}

/** YYYYMMDD → 「2026年10月28日」（輸入要先過真日曆日期驗證；呢度唔再驗） */
function liveDateLabel(d: string): string {
  return `${d.slice(0, 4)}年${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日`;
}

/**
 * YYYYMMDD 且係**真實日曆日期**（閏年計在內；20230229／20261301 唔過）。
 * shared builder 自己做真驗證，唔靠 caller——唔准將唔存在嘅日期格式化落公開文案。
 * （同 api/lib/liveSeo.ts、src/lib/liveShare.ts 嘅驗證規則一致。）
 */
export function isValidLiveDateYmd(d: string): boolean {
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
export function isValidLiveSessionStr(s: string): boolean {
  return /^[1-9]\d{0,2}$/.test(s);
}

/**
 * 直播場次公開 description——server 首口 meta（api/lib/liveSeo.ts liveFactDescription）
 * 同 React 場次摘要到位後嘅 document meta description 都用呢一個 builder，
 * 一字唔差（HK 今日由 caller 計，前後端同一標準）。
 * - 全日／單場文案一定有分別（「全日全部場次」 vs 「第N場」）。
 * - 真日期、場次、公開商品實數、真分類組成、代表商品名全部來自 summary。
 * - 過往場次中性「場次商品記錄」；冇真開播時間，文案絕對唔出時間。
 * - summary 係空（零公開商品）→ 回 null：caller 行空場次／通用 fallback，
 *   唔好出「0 件」假摘要。
 * - liveDate 唔係**真實日曆日期**（20230229／20261301）或 liveSession 唔係
 *   正整數字串 → 回 null：builder 自己驗證，唔靠 caller，絕不反射無效輸入。
 */
export function livePublicDescription(
  filter: { liveDate: string; liveSession: string | null },
  summary: LivePublicSummary,
  todayYmd: string,
): string | null {
  if (!isValidLiveDateYmd(filter.liveDate)) return null;
  if (filter.liveSession != null && !isValidLiveSessionStr(filter.liveSession)) return null;
  const facts = liveFactsSentence(summary, liveEra(filter.liveDate, todayYmd));
  if (!facts) return null;
  const d = liveDateLabel(filter.liveDate);
  const which = filter.liveSession
    ? `${d} 第${filter.liveSession}場直播商品`
    : `${d} 全日全部場次直播商品`;
  return `RedCode ${which}——${facts}`;
}

/**
 * 真空場次（查詢成功、零公開商品）嘅公開文案——server 首口
 * （api/lib/liveSeo.ts emptyLiveRouteMeta）同 React 空場次 meta 分流都用呢一個
 * builder，前後端一字唔差。如實講暫未公開／已下架，唔扮有貨；
 * noindex／canonical 移除由 caller 各自處理（server 用 RouteMeta、client 寫 DOM）。
 * 輸入唔係真日曆日期／正整數場次 → 回 null（絕不反射）。
 */
export function emptyLivePublicCopy(
  filter: { liveDate: string; liveSession: string | null },
): { title: string; description: string } | null {
  if (!isValidLiveDateYmd(filter.liveDate)) return null;
  if (filter.liveSession != null && !isValidLiveSessionStr(filter.liveSession)) return null;
  const d = liveDateLabel(filter.liveDate);
  const which = filter.liveSession ? `${d} 第${filter.liveSession}場直播` : `${d} 直播`;
  return {
    title: `${which}暫未有公開商品｜RedCode Fashion Design`,
    description: `RedCode ${which}而家冇公開商品——可能未開賣、已賣晒或已下架；去全部貨品睇最新直播精選女裝，品名、價錢同庫存以商品頁為準。`,
  };
}

/** 直播場次頁自身 path（canonical 用）：/products?liveDate=YYYYMMDD〔&liveSession=N〕；無效輸入 → null */
export function livePublicPath(filter: {
  liveDate: string;
  liveSession: string | null;
}): string | null {
  if (!isValidLiveDateYmd(filter.liveDate)) return null;
  if (filter.liveSession != null && !isValidLiveSessionStr(filter.liveSession)) return null;
  const p = new URLSearchParams({ liveDate: filter.liveDate });
  if (filter.liveSession) p.set("liveSession", filter.liveSession);
  return `/products?${p.toString()}`;
}

/** resolveLiveMetaUpdate 嘅決策（結構同 src/lib/liveShare.ts scheduleLiveMeta 入參一致） */
export interface LiveMetaDecision {
  title?: string;
  description?: string;
  /** 明確 robots 值：空場次 noindex；其餘一律還原 index, follow（可逆） */
  robots?: "index, follow" | "noindex, nofollow";
  /** string＝設 self canonical＋og:url；null＝移除兩者；undefined＝唔郁 */
  canonicalPath?: string | null;
  /** 已證實空場或查詢故障時移除 server 舊直播 ItemList，唔畀 rendered DOM 留假貨品事實。 */
  clearRouteSchema?: boolean;
}

/**
 * 直播場次頁動態 meta 嘅決策（v2026.11.11.2，React Products 用）。
 * 決策包 query 狀態，唔係齋睇 data——React Query refetch 故障時可以保留舊
 * data=[]，齋睇 data 會將 DB 故障誤當空場次：
 * ─ status 係 pending／error（包括空場次之後 refetch 故障）→ 恢復通用直播
 *   title／description（caller 提供，同 resolveSeo 一份）＋index, follow＋
 *   self canonical。初次 error 同「曾經空場→而家故障」都行呢度。
 * ─ success＋[]（查詢成功、零公開商品＝真空場次）→ 空場次文案＋
 *   noindex, nofollow＋移除 canonical，同 server emptyLiveRouteMeta 一致。
 * ─ success＋有公開商品 → description 做 livePublicDescription（同首口一字唔差），
 *   並還原 robots／canonical（empty→有貨 可逆）。
 * filter 無效 → null（絕不反射）。
 */
export function resolveLiveMetaUpdate(
  filter: { liveDate: string; liveSession: string | null },
  query: {
    status: "pending" | "error" | "success";
    data?: readonly LivePublicSummaryItem[] | null;
  },
  todayYmd: string,
  generic: { title: string; description: string },
): LiveMetaDecision | null {
  const path = livePublicPath(filter);
  if (!path) return null;
  if (query.status !== "success") {
    return {
      title: generic.title,
      description: generic.description,
      robots: "index, follow",
      canonicalPath: path,
      // 初次 pending 唔清 server 真 ItemList；已證實查詢故障先清舊資料，
      // 避免畫面轉用通用文案之後，JSON-LD 仲聲稱舊場次有貨。
      ...(query.status === "error" ? { clearRouteSchema: true } : {}),
    };
  }
  const rows = query.data ?? [];
  if (rows.length === 0) {
    const empty = emptyLivePublicCopy(filter);
    return empty
      ? { ...empty, robots: "noindex, nofollow", canonicalPath: null, clearRouteSchema: true }
      : null;
  }
  const description = livePublicDescription(filter, summarizeLiveProducts(rows), todayYmd);
  if (!description) return null;
  return {
    title: generic.title,
    description,
    robots: "index, follow",
    canonicalPath: path,
  };
}
