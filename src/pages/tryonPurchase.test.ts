import { describe, expect, it } from 'vitest';
import type { TryOnPurchaseItem } from '@contracts/purchase';
import {
  buildTryOnCheckoutLines,
  clearTryOnCheckoutDraft,
  readTryOnAddedItems,
  readTryOnCheckoutDraft,
  reconcileTryOnAddedItems,
  replaceTryOnAddedItems,
  saveTryOnAddedItems,
  saveTryOnCheckoutDraft,
  shouldReconcileTryOnAddedItems,
  type TryOnCheckoutStorage,
} from './tryonPurchase';

class MemoryStorage implements TryOnCheckoutStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const products = [
  { id: 101, sku: 'TOP-NOW', name: '目前品名一', image: '/top.jpg', price: 599, discountPrice: 499 },
  { id: 202, sku: 'PANTS-NOW', name: '目前品名二', image: '/pants.jpg', price: 399, discountPrice: null },
];

describe('試穿即買清單', () => {
  it('一件及兩件都原數保存，唔存品名或價錢快照', () => {
    const cases: TryOnPurchaseItem[][] = [
      [{ productId: 101, size: 'M', quantity: 1 }],
      [
        { productId: 101, size: 'M', quantity: 1 },
        { productId: 202, size: 'L', quantity: 1 },
      ],
    ];
    for (const items of cases) {
      const storage = new MemoryStorage();
      expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', items)).toBe(true);
      const draft = readTryOnCheckoutDraft(storage, 7);
      expect(draft?.items).toHaveLength(items.length);
      expect(JSON.stringify(draft)).not.toContain('price');
      expect(JSON.stringify(draft)).not.toContain('TOP-NOW');
    }
  });

  it('結帳顯示兩件目前品名、貨號及價錢，唔用生成時快照', () => {
    const { lines, missingProductIds } = buildTryOnCheckoutLines([
      { productId: 101, size: 'M', quantity: 1 },
      { productId: 202, size: 'L', quantity: 1 },
    ], products);
    expect(missingProductIds).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.product.name, line.product.sku, line.product.discountPrice ?? line.product.price])).toEqual([
      ['目前品名一', 'TOP-NOW', 499],
      ['目前品名二', 'PANTS-NOW', 399],
    ]);
  });

  it('逐項移除後只剩所揀商品；下架商品會明確報 missing', () => {
    const { lines, missingProductIds } = buildTryOnCheckoutLines([
      { productId: 202, size: null, quantity: 1 },
    ], products);
    expect(lines.map((line) => line.product.id)).toEqual([202]);
    expect(missingProductIds).toEqual([]);
    const missing = buildTryOnCheckoutLines([{ productId: 999, size: null, quantity: 1 }], products);
    expect(missing.lines).toEqual([]);
    expect(missing.missingProductIds).toEqual([999]);
  });

  it('拒絕其他帳號、壞 JSON、超過三件及非一件數量', () => {
    const storage = new MemoryStorage();
    saveTryOnCheckoutDraft(storage, 7, 'look-1', [{ productId: 101, quantity: 1 }]);
    expect(readTryOnCheckoutDraft(storage, 8)).toBeNull();
    storage.setItem('rc_tryon_checkout_7', '{bad');
    expect(readTryOnCheckoutDraft(storage, 7)).toBeNull();
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', [
      { productId: 1, quantity: 1 },
      { productId: 2, quantity: 1 },
      { productId: 3, quantity: 1 },
      { productId: 4, quantity: 1 },
    ])).toBe(false);
    const invalidQuantity = [{ productId: 101, quantity: 2 }] as unknown as TryOnPurchaseItem[];
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', invalidQuantity)).toBe(false);
  });

  it('可以清除即買清單，但唔涉及購物車或私人媒體', () => {
    const storage = new MemoryStorage();
    saveTryOnCheckoutDraft(storage, 7, 'look-1', [{ productId: 101, quantity: 1 }]);
    clearTryOnCheckoutDraft(storage, 7);
    expect(readTryOnCheckoutDraft(storage, 7)).toBeNull();
  });

  it('同一造型同一清單重用 requestId；換商品或成功清草稿後先建立新請求', () => {
    const storage = new MemoryStorage();
    const firstItems = [{ productId: 101, size: 'M', quantity: 1 }] as const;
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', firstItems)).toBe(true);
    const first = readTryOnCheckoutDraft(storage, 7);
    expect(first?.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', firstItems)).toBe(true);
    expect(readTryOnCheckoutDraft(storage, 7)?.requestId).toBe(first?.requestId);

    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', [{ productId: 202, size: 'L', quantity: 1 }])).toBe(true);
    const changed = readTryOnCheckoutDraft(storage, 7);
    expect(changed?.requestId).not.toBe(first?.requestId);

    clearTryOnCheckoutDraft(storage, 7);
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', firstItems)).toBe(true);
    expect(readTryOnCheckoutDraft(storage, 7)?.requestId).not.toBe(first?.requestId);
  });

  it('優惠碼及購物金只保存客人選擇，金額唔落草稿；同一清單改選擇仍重用 requestId', () => {
    const storage = new MemoryStorage();
    const items = [{ productId: 101, size: 'M', quantity: 1 }] as const;
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', items, {
      promoCode: '  vip10  ',
      useWallet: true,
    })).toBe(true);
    const first = readTryOnCheckoutDraft(storage, 7);
    expect(first?.promoCode).toBe('VIP10');
    expect(first?.useWallet).toBe(true);
    expect(JSON.stringify(first)).not.toContain('discountAmount');
    expect(JSON.stringify(first)).not.toContain('walletApplied');
    expect(JSON.stringify(first)).not.toContain('price');

    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', items, {
      promoCode: 'OTHER20',
      useWallet: false,
    })).toBe(true);
    const changed = readTryOnCheckoutDraft(storage, 7);
    expect(changed?.requestId).toBe(first?.requestId);
    expect(changed?.promoCode).toBe('OTHER20');
    expect(changed?.useWallet).toBe(false);
  });

  it('拒絕過長優惠碼或壞嘅購物金欄位，唔會將未核實資料帶去結帳', () => {
    const storage = new MemoryStorage();
    const items = [{ productId: 101, quantity: 1 }] as const;
    expect(saveTryOnCheckoutDraft(storage, 7, 'look-1', items, {
      promoCode: 'X'.repeat(33),
    })).toBe(false);
    storage.setItem('rc_tryon_checkout_7', JSON.stringify({
      version: 1,
      userId: 7,
      lookId: 'look-1',
      requestId: crypto.randomUUID(),
      items: [{ productId: 101, size: null, quantity: 1 }],
      useWallet: 'yes',
    }));
    expect(readTryOnCheckoutDraft(storage, 7)).toBeNull();
  });

  it('加車紀錄可按造型跨 remount 保留，而且唔會混入另一造型', () => {
    const storage = new MemoryStorage();
    const saved = saveTryOnAddedItems(storage, 7, 'look-1', [
      { productId: 101, size: 'M', quantity: 1 },
    ]);
    expect(saved).toEqual([{ productId: 101, size: 'M', quantity: 1 }]);
    expect(readTryOnAddedItems(storage, 7, 'look-1')).toEqual(saved);
    expect(readTryOnAddedItems(storage, 7, 'look-2')).toEqual([]);
    expect(readTryOnAddedItems(storage, 8, 'look-1')).toEqual([]);

    const merged = saveTryOnAddedItems(storage, 7, 'look-1', [
      { productId: 202, quantity: 1 },
    ]);
    expect(merged.map((item) => item.productId)).toEqual([101, 202]);
  });

  it('cart 對賬會完整取代舊紀錄；另一分頁移走商品後唔會復活已加車鎖', () => {
    const storage = new MemoryStorage();
    saveTryOnAddedItems(storage, 7, 'look-1', [
      { productId: 101, size: 'M', quantity: 1 },
      { productId: 202, quantity: 1 },
    ]);
    const added = readTryOnAddedItems(storage, 7, 'look-1');
    const reconciled = reconcileTryOnAddedItems(added, [
      { productId: 202, size: null, quantity: 1 },
    ]);
    expect(reconciled.map((item) => item.productId)).toEqual([202]);

    replaceTryOnAddedItems(storage, 7, 'look-1', reconciled);
    expect(readTryOnAddedItems(storage, 7, 'look-1').map((item) => item.productId)).toEqual([202]);
    replaceTryOnAddedItems(storage, 7, 'look-1', []);
    expect(readTryOnAddedItems(storage, 7, 'look-1')).toEqual([]);
  });

  it('addMany 後唔會被 Navbar 舊空車快取洗掉鎖定；只有新鮮 server 回應先可對賬', () => {
    const staleCachedEmptyCart = {
      hasData: true,
      isFetchedAfterMount: false,
      isFetching: false,
      isError: false,
    };
    expect(shouldReconcileTryOnAddedItems(1, staleCachedEmptyCart)).toBe(false);
    expect(shouldReconcileTryOnAddedItems(1, {
      ...staleCachedEmptyCart,
      isFetchedAfterMount: true,
      isFetching: true,
    })).toBe(false);
    expect(shouldReconcileTryOnAddedItems(1, {
      ...staleCachedEmptyCart,
      isFetchedAfterMount: true,
      isError: true,
    })).toBe(false);
    expect(shouldReconcileTryOnAddedItems(1, {
      ...staleCachedEmptyCart,
      hasData: false,
      isFetchedAfterMount: true,
    })).toBe(false);
    expect(shouldReconcileTryOnAddedItems(0, {
      ...staleCachedEmptyCart,
      isFetchedAfterMount: true,
    })).toBe(false);

    // 新鮮空陣列都係有效 server 確認：另一分頁真係移走咗商品時可以解鎖。
    expect(shouldReconcileTryOnAddedItems(1, {
      ...staleCachedEmptyCart,
      isFetchedAfterMount: true,
    })).toBe(true);
  });
});
