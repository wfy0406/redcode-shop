import {
  TRYON_PURCHASE_MAX_ITEMS,
  TRYON_PURCHASE_REQUEST_ID_PATTERN,
  type TryOnPurchaseItem,
} from '@contracts/purchase';
import type { CartLine, CartLineProduct } from '@/components/cart/types';

export type TryOnCheckoutOwner = number | 'guest';

export interface TryOnCheckoutDraftItem {
  productId: number;
  size: string | null;
  quantity: 1;
}

export interface TryOnCheckoutDraft {
  version: 1;
  userId: TryOnCheckoutOwner;
  lookId: string;
  /** 同一份草稿重試必須沿用；server 用它找回已 commit 但回應遺失嘅訂單。 */
  requestId: string;
  items: TryOnCheckoutDraftItem[];
  /** 只保存客人選擇，唔保存任何折扣金額；結帳及落單都由 server 重算。 */
  promoCode?: string;
  useWallet?: boolean;
}

export interface TryOnCheckoutOptions {
  promoCode?: string;
  useWallet?: boolean;
}

export interface TryOnCheckoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageKey(userId: TryOnCheckoutOwner): string {
  return `rc_tryon_checkout_${userId}`;
}

function validDraft(value: unknown, userId: TryOnCheckoutOwner): value is TryOnCheckoutDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<TryOnCheckoutDraft>;
  if (
    draft.version !== 1 ||
    draft.userId !== userId ||
    typeof draft.lookId !== 'string' ||
    !draft.lookId.trim() ||
    draft.lookId.length > 128 ||
    typeof draft.requestId !== 'string' ||
    !TRYON_PURCHASE_REQUEST_ID_PATTERN.test(draft.requestId) ||
    !Array.isArray(draft.items) ||
    draft.items.length < 1 ||
    draft.items.length > TRYON_PURCHASE_MAX_ITEMS ||
    (draft.promoCode !== undefined && (
      typeof draft.promoCode !== 'string' ||
      !draft.promoCode.trim() ||
      draft.promoCode.length > 32
    )) ||
    (draft.useWallet !== undefined && typeof draft.useWallet !== 'boolean')
  ) {
    return false;
  }
  const ids = new Set<number>();
  return draft.items.every((item) => {
    if (!item || typeof item !== 'object') return false;
    if (
      !Number.isInteger(item.productId) ||
      item.productId <= 0 ||
      item.quantity !== 1 ||
      (item.size !== null && (typeof item.size !== 'string' || item.size.length > 64)) ||
      ids.has(item.productId)
    ) {
      return false;
    }
    ids.add(item.productId);
    return true;
  });
}

function normalizedDraftItems(items: readonly TryOnPurchaseItem[]): TryOnCheckoutDraftItem[] {
  return items.map((item) => ({
    productId: item.productId,
    size: item.size?.trim() || null,
    quantity: 1,
  }));
}

function sameItems(a: readonly TryOnCheckoutDraftItem[], b: readonly TryOnCheckoutDraftItem[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return item.productId === other?.productId && item.size === other.size && item.quantity === other.quantity;
  });
}

/** Buy-now 同購物車分開保存，所以原有購物車唔會被混合或清空。 */
export function saveTryOnCheckoutDraft(
  storage: TryOnCheckoutStorage,
  userId: TryOnCheckoutOwner,
  lookId: string,
  items: readonly TryOnPurchaseItem[],
  options: TryOnCheckoutOptions = {},
): boolean {
  const promoCode = options.promoCode?.trim().toUpperCase() || undefined;
  if (
    (userId !== 'guest' && (!Number.isInteger(userId) || userId <= 0)) ||
    items.length < 1 ||
    items.length > TRYON_PURCHASE_MAX_ITEMS ||
    items.some((item) => item.quantity !== 1) ||
    (options.promoCode !== undefined && options.promoCode.trim().length > 32) ||
    (options.useWallet !== undefined && typeof options.useWallet !== 'boolean')
  ) {
    return false;
  }
  const normalizedItems = normalizedDraftItems(items);
  const previous = readTryOnCheckoutDraft(storage, userId);
  // 返回試穿頁再撳同一份商品，仍當同一次結帳；成功清草稿後先會產生新請求編號。
  const reusableRequestId = previous?.lookId === lookId && sameItems(previous.items, normalizedItems)
    ? previous.requestId
    : null;
  let requestId = reusableRequestId;
  if (!requestId) {
    try {
      requestId = globalThis.crypto.randomUUID();
    } catch {
      return false;
    }
  }
  const draft: TryOnCheckoutDraft = {
    version: 1,
    userId,
    lookId,
    requestId,
    items: normalizedItems,
    ...(promoCode ? { promoCode } : {}),
    ...(options.useWallet !== undefined ? { useWallet: options.useWallet } : {}),
  };
  if (!validDraft(draft, userId)) return false;
  try {
    storage.setItem(storageKey(userId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function readTryOnCheckoutDraft(
  storage: TryOnCheckoutStorage,
  userId: TryOnCheckoutOwner,
): TryOnCheckoutDraft | null {
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (validDraft(parsed, userId)) return parsed;
    storage.removeItem(storageKey(userId));
    return null;
  } catch {
    return null;
  }
}

export function clearTryOnCheckoutDraft(storage: TryOnCheckoutStorage, userId: TryOnCheckoutOwner): void {
  try {
    storage.removeItem(storageKey(userId));
  } catch {
    // 私密瀏覽模式可能唔准寫 storage；訂單仍由 server 正常建立。
  }
}

export interface TryOnAddedRecord {
  version: 1;
  userId: number;
  lookId: string;
  items: TryOnCheckoutDraftItem[];
}

function addedStorageKey(userId: number, lookId: string): string {
  return `rc_tryon_added_${userId}_${encodeURIComponent(lookId)}`;
}

function validAddedRecord(value: unknown, userId: number, lookId: string): value is TryOnAddedRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TryOnAddedRecord>;
  if (record.version !== 1 || record.userId !== userId || record.lookId !== lookId || !Array.isArray(record.items)) return false;
  const ids = new Set<number>();
  return record.items.every((item) => {
    if (!item || typeof item !== 'object') return false;
    if (
      !Number.isInteger(item.productId) || item.productId <= 0 || item.quantity !== 1 ||
      (item.size !== null && (typeof item.size !== 'string' || item.size.length > 64)) || ids.has(item.productId)
    ) return false;
    ids.add(item.productId);
    return true;
  });
}

export function readTryOnAddedItems(
  storage: TryOnCheckoutStorage,
  userId: number,
  lookId: string,
): TryOnCheckoutDraftItem[] {
  try {
    const raw = storage.getItem(addedStorageKey(userId, lookId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return validAddedRecord(parsed, userId, lookId) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeTryOnAddedItems(
  storage: TryOnCheckoutStorage,
  userId: number,
  lookId: string,
  items: readonly TryOnCheckoutDraftItem[],
): TryOnCheckoutDraftItem[] {
  const next = [...items];
  const record: TryOnAddedRecord = { version: 1, userId, lookId, items: next };
  try {
    if (next.length === 0) storage.removeItem(addedStorageKey(userId, lookId));
    else storage.setItem(addedStorageKey(userId, lookId), JSON.stringify(record));
  } catch {
    // Storage 失效時仍保留同頁 state；server 嘅用戶鎖會防止並發重複行。
  }
  return next;
}

/** 只記呢個造型成功加車嘅項目；原本已在購物車嘅商品唔會被誤當成本次已加。 */
export function saveTryOnAddedItems(
  storage: TryOnCheckoutStorage,
  userId: number,
  lookId: string,
  items: readonly TryOnPurchaseItem[],
): TryOnCheckoutDraftItem[] {
  const merged = readTryOnAddedItems(storage, userId, lookId);
  for (const item of normalizedDraftItems(items)) {
    if (!merged.some((existing) => existing.productId === item.productId)) merged.push(item);
  }
  return writeTryOnAddedItems(storage, userId, lookId, merged);
}

export function replaceTryOnAddedItems(
  storage: TryOnCheckoutStorage,
  userId: number,
  lookId: string,
  items: readonly TryOnCheckoutDraftItem[],
): TryOnCheckoutDraftItem[] {
  return writeTryOnAddedItems(storage, userId, lookId, items);
}

export interface TryOnCartFreshness {
  /** undefined 同空陣列要分開：空陣列都可以係 server 最新確認嘅購物車。 */
  hasData: boolean;
  isFetching: boolean;
  isError: boolean;
  /** 只接受呢個 query hook mount 後真正完成嘅 server fetch，唔接受 Navbar 舊快取。 */
  isFetchedAfterMount: boolean;
}

/**
 * 加車後嘅「已加車」鎖唔可以被 stale cache 洗掉。
 * Navbar 可能早已將 cart.list 快取做空陣列；新鮮回應未到／refetch 失敗時必須保持鎖定。
 */
export function shouldReconcileTryOnAddedItems(
  addedCount: number,
  query: TryOnCartFreshness,
): boolean {
  return addedCount > 0 && query.hasData && query.isFetchedAfterMount && !query.isFetching && !query.isError;
}

/** 另一分頁如已移走商品，就解除「已加車」鎖；未能讀車時則保持鎖定，寧願唔誤加。 */
export function reconcileTryOnAddedItems(
  addedItems: readonly TryOnCheckoutDraftItem[],
  cartLines: readonly { productId: number; size: string | null; quantity: number }[],
): TryOnCheckoutDraftItem[] {
  return addedItems.filter((added) => cartLines.some((line) =>
    line.productId === added.productId && line.size === added.size && line.quantity > 0));
}

/** 結帳畫面只用呢個對照做顯示；真正金額仍會由 orders.create 再計一次。 */
export function buildTryOnCheckoutLines(
  items: readonly TryOnCheckoutDraftItem[],
  products: readonly CartLineProduct[],
): { lines: CartLine[]; missingProductIds: number[] } {
  const byId = new Map(products.map((product) => [product.id, product]));
  const lines: CartLine[] = [];
  const missingProductIds: number[] = [];
  items.forEach((item, index) => {
    const product = byId.get(item.productId);
    if (!product) {
      missingProductIds.push(item.productId);
      return;
    }
    lines.push({
      id: -(index + 1),
      size: item.size,
      quantity: item.quantity,
      product,
    });
  });
  return { lines, missingProductIds };
}
