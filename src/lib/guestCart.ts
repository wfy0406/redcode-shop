/**
 * 訪客購物車（2026-10-09 訪客購買）——未登入客用 localStorage 存（契約 v1.1）。
 * key：rc_guest_cart；內容：{ productId, size, quantity }[]（價錢永遠 server 計，呢度唔存）。
 * 更新時 dispatch `rc-guest-cart-changed` CustomEvent，Navbar badge／Cart 頁靠佢即時刷新。
 */

export interface GuestCartItem {
  productId: number;
  size: string | null;
  quantity: number;
}

const KEY = 'rc_guest_cart';
const EVENT = 'rc-guest-cart-changed';

export function getGuestCart(): GuestCartItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 防衛式過濾：壞資料直接掉，唔好炸咗成頁
    return parsed
      .map((it) => {
        const o = it as Partial<GuestCartItem>;
        const productId = Number(o.productId);
        const quantity = Number(o.quantity);
        if (!Number.isInteger(productId) || productId <= 0) return null;
        if (!Number.isInteger(quantity) || quantity <= 0) return null;
        return { productId, size: o.size ?? null, quantity: Math.min(quantity, 99) };
      })
      .filter((it): it is GuestCartItem => it !== null);
  } catch {
    return [];
  }
}

function save(items: GuestCartItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // 私隱模式寫唔入就靜默（落單時 server 都會再驗）
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 加貨：同 productId＋同 size 就加數量（上限 99），否則新行 */
export function addToGuestCart(productId: number, size: string | null, quantity: number): void {
  const items = getGuestCart();
  const found = items.find((it) => it.productId === productId && it.size === size);
  if (found) {
    found.quantity = Math.min(99, found.quantity + quantity);
  } else {
    items.push({ productId, size, quantity: Math.min(99, Math.max(1, quantity)) });
  }
  save(items);
}

/** 更新某行數量；quantity <= 0 等於刪除（同 server cart 規矩一致） */
export function updateGuestCartQuantity(productId: number, size: string | null, quantity: number): void {
  let items = getGuestCart();
  if (quantity <= 0) {
    items = items.filter((it) => !(it.productId === productId && it.size === size));
  } else {
    const found = items.find((it) => it.productId === productId && it.size === size);
    if (found) found.quantity = Math.min(99, quantity);
  }
  save(items);
}

export function removeFromGuestCart(productId: number, size: string | null): void {
  save(getGuestCart().filter((it) => !(it.productId === productId && it.size === size)));
}

export function clearGuestCart(): void {
  save([]);
}

export function guestCartCount(): number {
  return getGuestCart().reduce((s, it) => s + it.quantity, 0);
}

/** React hook：subscribe 購物車變化（同頁其他 tab 嘅 storage event 都聽） */
export function subscribeGuestCart(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}
