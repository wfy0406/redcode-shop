/**
 * productReturn —— 商品詳情「返回」來源記錄（U01）
 *
 * 客人喺站內商品卡撳入詳情嗰刻，用呢個 tab-scoped sessionStorage 記低：
 * 來源 URL（pathname+search）、scrollY、productId、時間戳。
 * 詳情頁返回掣同原生 browser/OS back 行同一套恢復邏輯（Layout 嘅
 * resolveScrollIntent）：POP 返到嚟源 URL → 等商品卡渲染穩定先 restore
 * scroll，並 focus 返原本嗰張卡。
 *
 * 安全規則：
 * - 只接受站內相對 URL（'/' 開頭、唔准 '//' 協議相對）——絕對唔會記外站；
 * - storage 被禁／JSON 壞／shape 唔啱／過期 → 全部安全當冇來源（返 /products）；
 * - 唔好用 history.length 估有冇上一頁（直接開詳情都有 length≥1）。
 */

export interface ProductReturnEntry {
  /** 來源頁 pathname+search（例如 /products?category=dress） */
  url: string;
  /** 撳卡嗰刻嘅 window.scrollY */
  scrollY: number;
  /** 邊件商品（詳情頁核對先用得，避免隔籬商品嘅陳年記錄誤觸發） */
  productId: number;
  /** 記錄時間（ms epoch） */
  ts: number;
}

export const PRODUCT_RETURN_KEY = 'rc:product-return:v1';
/** 來源記錄保鮮期：隔咗 12 個鐘嘅舊記錄唔再當係「啱啱從列表嚟」 */
export const PRODUCT_RETURN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageOrNull(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** 站內相對 URL 先收（'/' 開頭；'//' 協議相對＝潛在外站，拒收） */
export function isInternalReturnUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

function isValidEntry(v: unknown): v is ProductReturnEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isInternalReturnUrl(e.url) &&
    typeof e.scrollY === 'number' &&
    Number.isFinite(e.scrollY) &&
    e.scrollY >= 0 &&
    typeof e.productId === 'number' &&
    Number.isInteger(e.productId) &&
    e.productId > 0 &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts)
  );
}

/**
 * 記低來源。productId 無效／URL 唔係站內 → 唔寫（回 false）；
 * storage 被禁（private mode 等）→ catch 咗回 false，唔阻正常導航。
 */
export function saveProductReturn(
  entry: ProductReturnEntry,
  storage?: StorageLike | null,
): boolean {
  if (!isValidEntry(entry)) return false;
  const store = storageOrNull(storage);
  if (!store) return false;
  try {
    store.setItem(PRODUCT_RETURN_KEY, JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

/** 讀返來源記錄；壞 JSON／壞 shape／過期 → null（caller 當冇來源處理） */
export function readProductReturn(
  storage?: StorageLike | null,
  now: number = Date.now(),
): ProductReturnEntry | null {
  const store = storageOrNull(storage);
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(PRODUCT_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidEntry(parsed)) return null;
  if (now - parsed.ts > PRODUCT_RETURN_MAX_AGE_MS || parsed.ts > now + 60_000) return null;
  return parsed;
}

/** 詳情頁專用：記錄存在而且係呢件商品先有得用（唔啱件 → null → fallback /products） */
export function readProductReturnFor(
  productId: number,
  storage?: StorageLike | null,
  now: number = Date.now(),
): ProductReturnEntry | null {
  const entry = readProductReturn(storage, now);
  if (!entry || entry.productId !== productId) return null;
  return entry;
}

/** 成功 restore 後 consume（唔好畀下次無關導航重播） */
export function clearProductReturn(storage?: StorageLike | null): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.removeItem(PRODUCT_RETURN_KEY);
  } catch {
    /* storage 被禁都唔阻導航 */
  }
}

/** 記錄嘅來源 URL 同而家嘅 location 係咪一樣（pathname+search 全對先算） */
export function productReturnMatches(
  entry: ProductReturnEntry,
  pathname: string,
  search: string,
): boolean {
  return entry.url === `${pathname}${search}`;
}

export type ScrollIntent =
  /** 正常轉頁：捲返頁頂（原有行為） */
  | 'top'
  /** POP 返到來源列表：等卡渲染好 → restore scrollY＋focus 卡 */
  | 'restore-product'
  /** POP 但冇匹配記錄：交俾瀏覽器原生 scroll restoration，我哋唔插手 */
  | 'native';

/**
 * Layout 轉頁捲動決策（單一來源，自製返回掣同原生 back 都行呢度）：
 * - PUSH/REPLACE → 照舊捲頁頂；
 * - POP ＋記錄 URL 對得上而家 location → 恢復商品來源位置；
 * - POP 但對唔上 → 唔准搶去 scroll 0（修咗舊版 POP 都硬 scrollTo(0) 嘅問題）。
 */
export function resolveScrollIntent(
  navigationType: 'POP' | 'PUSH' | 'REPLACE',
  entry: ProductReturnEntry | null,
  pathname: string,
  search: string,
): ScrollIntent {
  if (navigationType !== 'POP') return 'top';
  if (entry && productReturnMatches(entry, pathname, search)) return 'restore-product';
  return 'native';
}
