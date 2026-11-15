/**
 * guestCart 寫入失敗回傳測試（主線審核）：addToGuestCart 回傳 boolean——
 * localStorage 寫唔入（無痕／quota／完全冇 localStorage）必須回 false，
 * 唔准 caller 假顯示「已加入」；成功先回 true。舊 caller 唔理回傳值都相容。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToGuestCart, getGuestCart } from './guestCart';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('addToGuestCart 回傳值', () => {
  it('localStorage 正常 → true，而且真係寫入咗', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(addToGuestCart(1, null, 1)).toBe(true);
    expect(addToGuestCart(2, 'M', 2)).toBe(true);
    expect(getGuestCart()).toEqual([
      { productId: 1, size: null, quantity: 1 },
      { productId: 2, size: 'M', quantity: 2 },
    ]);
  });

  it('setItem 拋錯（無痕／quota）→ false，唔會當成功', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    });
    expect(addToGuestCart(1, null, 1)).toBe(false);
    expect(getGuestCart()).toEqual([]);
  });

  it('完全冇 localStorage（node 預設）→ false，唔會炸', () => {
    // 確保冇 stub：node 環境本身冇 localStorage
    expect(addToGuestCart(1, null, 1)).toBe(false);
  });
});
