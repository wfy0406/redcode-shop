/**
 * AI 試穿商品篩選純邏輯（2026-10-28 直播節目冊）。
 * 全部函數唔掂 React／tRPC：日期場次選項、最新上架排序、疊加篩選、
 * 換日期重設場次、空狀態分類，全部可以由測試直接覆蓋。
 */

export type TryOnListedSort = "newest" | "oldest";

/** 只依賴 listTryOnProducts 公開欄位；liveDate/liveSession 係公開直播場次 metadata。 */
export interface TryOnFilterProduct {
  id: number;
  name: string;
  sku: string;
  tryOnKind: string;
  listedDate: Date | string;
  liveDate: string | null;
  liveSession: string | null;
}

export interface TryOnLiveDateOption {
  date: string; // YYYYMMDD
  sessions: number[]; // 數字序
}

export interface TryOnProductFilters {
  search: string;
  kind: string; // "all" 或 TryOnProductKind
  liveDate: string | null;
  liveSession: number | null;
  sort: TryOnListedSort;
}

export interface TryOnLiveFilterState {
  liveDate: string | null;
  liveSession: number | null;
}

export type TryOnEmptyReason = "no-eligible" | "no-live-products" | "no-filter-match";

/** 只接受真實日曆日期嘅 YYYYMMDD；20261340 呢類假日期一律當冇直播標記。 */
export function isValidTryOnLiveDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** 場次只接受正整數字串（'1'、'2'…）；唔接受小數、負數或文字。 */
export function parseTryOnLiveSession(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  const session = Number(value);
  return Number.isInteger(session) && session > 0 ? session : null;
}

/**
 * 由實際合資格試穿商品清單衍生日期／場次選項：
 * 日期新至舊、場次數字序。唔會從全店 liveSessions 抄，避免空日期混入。
 */
export function deriveTryOnLiveDates(
  products: Array<Pick<TryOnFilterProduct, "liveDate" | "liveSession">>,
): TryOnLiveDateOption[] {
  const byDate = new Map<string, Set<number>>();
  for (const product of products) {
    if (!isValidTryOnLiveDate(product.liveDate)) continue;
    const date = product.liveDate;
    const sessions = byDate.get(date) ?? new Set<number>();
    const session = parseTryOnLiveSession(product.liveSession);
    if (session !== null) sessions.add(session);
    byDate.set(date, sessions);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // YYYYMMDD 字串序＝日期序
    .map(([date, sessions]) => ({ date, sessions: [...sessions].sort((a, b) => a - b) }));
}

export function tryOnLiveSessionsForDate(options: TryOnLiveDateOption[], date: string | null): number[] {
  if (!date) return [];
  return options.find((option) => option.date === date)?.sessions ?? [];
}

function listedTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** 上架次序：預設最新上架（listedDate 新至舊），可反向最早上架；同刻用 id 穩定次序。 */
export function sortTryOnProductsByListed<T extends Pick<TryOnFilterProduct, "id" | "listedDate">>(
  products: readonly T[],
  sort: TryOnListedSort,
): T[] {
  const direction = sort === "oldest" ? 1 : -1;
  return [...products].sort((a, b) => {
    const byDate = (listedTime(a.listedDate) - listedTime(b.listedDate)) * direction;
    return byDate !== 0 ? byDate : (a.id - b.id) * direction;
  });
}

function matchesLive(
  product: Pick<TryOnFilterProduct, "liveDate" | "liveSession">,
  liveDate: string | null,
  liveSession: number | null,
): boolean {
  if (!liveDate) return true;
  if (product.liveDate !== liveDate) return false;
  if (liveSession === null) return true;
  return parseTryOnLiveSession(product.liveSession) === liveSession;
}

/**
 * 直播日期＋場次＋部位＋搜尋疊加篩選，最後按上架次序排。
 * 換篩選只影響顯示清單，唔會郁到已揀商品（selections 由呼叫方獨立持有）。
 */
export function filterTryOnProducts<T extends TryOnFilterProduct>(
  products: readonly T[],
  filters: TryOnProductFilters,
): T[] {
  const needle = filters.search.trim().toLocaleLowerCase("zh-HK");
  const matched = products.filter((product) => {
    if (filters.kind !== "all" && product.tryOnKind !== filters.kind) return false;
    if (!matchesLive(product, filters.liveDate, filters.liveSession)) return false;
    if (!needle) return true;
    return `${product.name} ${product.sku}`.toLocaleLowerCase("zh-HK").includes(needle);
  });
  return sortTryOnProductsByListed(matched, filters.sort);
}

/** 只計直播日期／場次條件（唔理部位／搜尋），用嚟分辨「呢場本身冇貨」定「組合篩選冇結果」。 */
export function countTryOnLiveMatches(
  products: Array<Pick<TryOnFilterProduct, "liveDate" | "liveSession">>,
  liveDate: string | null,
  liveSession: number | null,
): number {
  if (!liveDate) return products.length;
  return products.filter((product) => matchesLive(product, liveDate, liveSession)).length;
}

/** 換直播日期必須重設場次；揀返同一日期就原樣保留。 */
export function changeTryOnLiveDate(
  current: TryOnLiveFilterState,
  nextDate: string | null,
): TryOnLiveFilterState {
  if (current.liveDate === nextDate) return current;
  return { liveDate: nextDate, liveSession: null };
}

/** 換場次唔會郁日期。 */
export function changeTryOnLiveSession(
  current: TryOnLiveFilterState,
  nextSession: number | null,
): TryOnLiveFilterState {
  if (current.liveSession === nextSession) return current;
  return { ...current, liveSession: nextSession };
}

/**
 * 空狀態分類（只在篩選後清單為空時呼叫）：
 * - no-eligible：本身冇任何合資格試穿商品
 * - no-live-products：揀咗嘅直播日期／場次本身冇合資格試穿商品
 * - no-filter-match：日期場次有貨，但同搜尋／部位組合後冇結果
 */
export function tryOnEmptyReason(args: {
  totalEligible: number;
  liveFilterActive: boolean;
  liveMatchCount: number;
}): TryOnEmptyReason {
  if (args.totalEligible === 0) return "no-eligible";
  if (args.liveFilterActive && args.liveMatchCount === 0) return "no-live-products";
  return "no-filter-match";
}

/** '20261028' → '2026.10.28'；無效輸入原樣返回，唔會假裝係日期。 */
export function formatTryOnLiveDate(value: string, style: "long" | "short" = "long"): string {
  if (!isValidTryOnLiveDate(value)) return value;
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return style === "short" ? `${month}.${day}` : `${value.slice(0, 4)}.${month}.${day}`;
}

export function tryOnLiveSessionLabel(session: number): string {
  return `第 ${session} 場`;
}
