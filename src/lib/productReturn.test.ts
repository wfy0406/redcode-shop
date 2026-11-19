import { describe, expect, it } from 'vitest';
import {
  clearProductReturn,
  isInternalReturnUrl,
  PRODUCT_RETURN_KEY,
  PRODUCT_RETURN_MAX_AGE_MS,
  productReturnMatches,
  readProductReturn,
  readProductReturnFor,
  resolveScrollIntent,
  saveProductReturn,
} from './productReturn';

/**
 * U01 productReturn 純邏輯測試（node 環境，假 storage）：
 * - 來源記錄 save/read 往返；壞 JSON／壞 shape／外站 URL／過期 → null
 * - 詳情頁只接受同一件商品嘅記錄
 * - resolveScrollIntent：PUSH 捲頁頂；POP＋URL 對上 → restore；POP 對唔上 → native（唔搶 scroll）
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const ENTRY = {
  url: '/products?category=dress&liveDate=20261110',
  scrollY: 1234,
  productId: 42,
  ts: 1_800_000_000_000,
};

describe('isInternalReturnUrl', () => {
  it('站內相對 URL 先收', () => {
    expect(isInternalReturnUrl('/products')).toBe(true);
    expect(isInternalReturnUrl('/products?liveDate=20261110')).toBe(true);
  });
  it('外站／協議相對／非字串一律拒收', () => {
    expect(isInternalReturnUrl('https://evil.com')).toBe(false);
    expect(isInternalReturnUrl('//evil.com/x')).toBe(false);
    expect(isInternalReturnUrl('')).toBe(false);
    expect(isInternalReturnUrl(null)).toBe(false);
    expect(isInternalReturnUrl(123)).toBe(false);
  });
});

describe('saveProductReturn / readProductReturn', () => {
  it('合法記錄可以 save → read 往返', () => {
    const store = fakeStorage();
    expect(saveProductReturn(ENTRY, store)).toBe(true);
    expect(readProductReturn(store, ENTRY.ts + 1000)).toEqual(ENTRY);
  });

  it('外站 URL／壞 productId／負 scrollY 唔寫得入', () => {
    const store = fakeStorage();
    expect(saveProductReturn({ ...ENTRY, url: 'https://evil.com' }, store)).toBe(false);
    expect(saveProductReturn({ ...ENTRY, url: '//evil.com' }, store)).toBe(false);
    expect(saveProductReturn({ ...ENTRY, productId: 0 }, store)).toBe(false);
    expect(saveProductReturn({ ...ENTRY, productId: 1.5 }, store)).toBe(false);
    expect(saveProductReturn({ ...ENTRY, scrollY: -1 }, store)).toBe(false);
    expect(store._map.size).toBe(0);
  });

  it('壞 JSON → null（唔會 throw）', () => {
    const store = fakeStorage({ [PRODUCT_RETURN_KEY]: '{not-json' });
    expect(readProductReturn(store, ENTRY.ts)).toBeNull();
  });

  it('shape 唔啱（缺欄／錯型）→ null', () => {
    const store = fakeStorage({
      [PRODUCT_RETURN_KEY]: JSON.stringify({ url: '/products', scrollY: 'abc' }),
    });
    expect(readProductReturn(store, ENTRY.ts)).toBeNull();
  });

  it('過期記錄 → null；未來時間戳（時鐘偏差 >60s）→ null', () => {
    const store = fakeStorage({ [PRODUCT_RETURN_KEY]: JSON.stringify(ENTRY) });
    expect(readProductReturn(store, ENTRY.ts + PRODUCT_RETURN_MAX_AGE_MS + 1)).toBeNull();
    expect(readProductReturn(store, ENTRY.ts - 61_000)).toBeNull();
    // 保鮮期內正常
    expect(readProductReturn(store, ENTRY.ts + PRODUCT_RETURN_MAX_AGE_MS - 1)).toEqual(ENTRY);
  });

  it('storage 被禁（getItem/setItem throw）→ 安全降級', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(saveProductReturn(ENTRY, broken)).toBe(false);
    expect(readProductReturn(broken)).toBeNull();
    expect(() => clearProductReturn(broken)).not.toThrow();
  });

  it('null storage（SSR／無 sessionStorage）→ null／false', () => {
    expect(saveProductReturn(ENTRY, null)).toBe(false);
    expect(readProductReturn(null)).toBeNull();
  });
});

describe('readProductReturnFor（詳情頁只認同一件商品）', () => {
  it('productId 對上 → 回記錄；對唔上 → null', () => {
    const store = fakeStorage({ [PRODUCT_RETURN_KEY]: JSON.stringify(ENTRY) });
    expect(readProductReturnFor(42, store, ENTRY.ts + 1)).toEqual(ENTRY);
    expect(readProductReturnFor(43, store, ENTRY.ts + 1)).toBeNull();
  });
});

describe('productReturnMatches', () => {
  it('pathname+search 全對先算 match', () => {
    expect(productReturnMatches(ENTRY, '/products', '?category=dress&liveDate=20261110')).toBe(true);
    expect(productReturnMatches(ENTRY, '/products', '')).toBe(false);
    expect(productReturnMatches(ENTRY, '/products', '?category=top')).toBe(false);
    expect(productReturnMatches(ENTRY, '/', '')).toBe(false);
  });
});

describe('resolveScrollIntent（自製返回掣同原生 back 同一套決策）', () => {
  it('PUSH／REPLACE → top（維持轉頁捲頁頂）', () => {
    expect(resolveScrollIntent('PUSH', ENTRY, '/products', '?category=dress&liveDate=20261110')).toBe('top');
    expect(resolveScrollIntent('REPLACE', ENTRY, '/products', '?category=dress&liveDate=20261110')).toBe('top');
    expect(resolveScrollIntent('PUSH', null, '/products', '')).toBe('top');
  });

  it('POP＋記錄 URL 對上 → restore-product', () => {
    expect(resolveScrollIntent('POP', ENTRY, '/products', '?category=dress&liveDate=20261110')).toBe(
      'restore-product',
    );
  });

  it('POP 但冇記錄／URL 對唔上 → native（唔准搶去 scroll 0）', () => {
    expect(resolveScrollIntent('POP', null, '/products', '')).toBe('native');
    expect(resolveScrollIntent('POP', ENTRY, '/products', '')).toBe('native');
    expect(resolveScrollIntent('POP', ENTRY, '/', '')).toBe('native');
  });
});
