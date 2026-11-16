import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_RETURN_KEY,
  AUTH_RETURN_TTL_MS,
  MAX_RETURN_PATH_LENGTH,
  consumeAuthReturn,
  fromLocationState,
  peekAuthReturn,
  sanitizeInternalPath,
  stashAuthReturn,
} from './authReturn';

/** 簡單 in-memory sessionStorage 假身（node 環境本身冇 sessionStorage） */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe('sanitizeInternalPath', () => {
  it('接受站內深層連結（query + hash）', () => {
    expect(sanitizeInternalPath('/try-on?productId=101&photoIndex=0&guide=autumn-knit')).toBe(
      '/try-on?productId=101&photoIndex=0&guide=autumn-knit',
    );
    expect(sanitizeInternalPath('/account')).toBe('/account');
    expect(sanitizeInternalPath('/payment?orderId=42#summary')).toBe('/payment?orderId=42#summary');
  });

  it('拒絕 // 開頭（protocol-relative 外站跳轉）', () => {
    expect(sanitizeInternalPath('//evil.com/phish')).toBeNull();
    expect(sanitizeInternalPath('//')).toBeNull();
  });

  it('拒絕外部 scheme 同相對路徑（冇單一 / 開頭）', () => {
    expect(sanitizeInternalPath('https://evil.com')).toBeNull();
    expect(sanitizeInternalPath('javascript:alert(1)')).toBeNull();
    expect(sanitizeInternalPath('try-on?productId=101')).toBeNull();
    expect(sanitizeInternalPath('')).toBeNull();
  });

  it('拒絕反斜線（\\ 型混淆跳轉）', () => {
    expect(sanitizeInternalPath('/\\evil.com')).toBeNull();
    expect(sanitizeInternalPath('/try-on\\..\\admin')).toBeNull();
  });

  it('拒絕控制字符（換行、CR、DEL）', () => {
    expect(sanitizeInternalPath('/try-on\nLocation: https://evil.com')).toBeNull();
    expect(sanitizeInternalPath('/try-on\revil')).toBeNull();
    expect(sanitizeInternalPath('/try-on?x=1\x1fy=2')).toBeNull();
  });

  it('拒絕非字串同超長輸入', () => {
    expect(sanitizeInternalPath(null)).toBeNull();
    expect(sanitizeInternalPath(undefined)).toBeNull();
    expect(sanitizeInternalPath(123)).toBeNull();
    expect(sanitizeInternalPath({ pathname: '/account' })).toBeNull();
    expect(sanitizeInternalPath(`/${'a'.repeat(MAX_RETURN_PATH_LENGTH)}`)).toBeNull();
    expect(sanitizeInternalPath(`/${'a'.repeat(MAX_RETURN_PATH_LENGTH - 1)}`)).not.toBeNull();
  });

  it('trim 前後空白先驗證', () => {
    expect(sanitizeInternalPath('  /account  ')).toBe('/account');
  });
});

describe('fromLocationState', () => {
  it('字串形式直接用（淨化後）', () => {
    expect(fromLocationState({ from: '/try-on?productId=101&guide=autumn-knit' })).toBe(
      '/try-on?productId=101&guide=autumn-knit',
    );
  });

  it('物件形式 { pathname } 相容，search/hash 有就拼埋', () => {
    expect(fromLocationState({ from: { pathname: '/account' } })).toBe('/account');
    expect(
      fromLocationState({ from: { pathname: '/try-on', search: '?productId=101', hash: '#top' } }),
    ).toBe('/try-on?productId=101#top');
  });

  it('冇 state／冇 from／唔合法 → null', () => {
    expect(fromLocationState(null)).toBeNull();
    expect(fromLocationState(undefined)).toBeNull();
    expect(fromLocationState({})).toBeNull();
    expect(fromLocationState({ from: 'https://evil.com' })).toBeNull();
    expect(fromLocationState({ from: { pathname: '//evil.com' } })).toBeNull();
  });
});

describe('sessionStorage 兜底（stash / peek / consume）', () => {
  let store: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    store = fakeStorage();
    vi.stubGlobal('sessionStorage', store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stash → peek roundtrip，原樣攞返深層連結', () => {
    const path = '/try-on?productId=101&photoIndex=0&guide=autumn-knit';
    expect(stashAuthReturn(path, 1_000)).toBe(true);
    expect(store.getItem(AUTH_RETURN_KEY)).toBe(JSON.stringify({ path, ts: 1_000 }));
    expect(peekAuthReturn(1_000)).toBe(path);
    // peek 唔清記號
    expect(peekAuthReturn(1_000)).toBe(path);
  });

  it('stash 拒絕唔合法路徑（唔寫入）', () => {
    expect(stashAuthReturn('https://evil.com', 1_000)).toBe(false);
    expect(store.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('TTL 內有效，過期 → null 兼清走記號', () => {
    store.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: '/try-on?productId=101', ts: 1_000 }));
    expect(peekAuthReturn(1_000 + AUTH_RETURN_TTL_MS)).toBe('/try-on?productId=101');
    expect(peekAuthReturn(1_000 + AUTH_RETURN_TTL_MS + 1)).toBeNull();
    expect(store.getItem(AUTH_RETURN_KEY)).toBeNull(); // 過期殘留被清走
  });

  it('未來時間戳（時鐘跳咗）→ null', () => {
    store.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: '/account', ts: 10_000_000 }));
    expect(peekAuthReturn(1_000)).toBeNull();
  });

  it('壞 JSON／壞 payload → null 兼清走', () => {
    store.setItem(AUTH_RETURN_KEY, 'not-json{{{');
    expect(peekAuthReturn(1_000)).toBeNull();
    expect(store.getItem(AUTH_RETURN_KEY)).toBeNull();

    store.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: '//evil.com', ts: 1_000 }));
    expect(peekAuthReturn(1_000)).toBeNull();

    store.setItem(AUTH_RETURN_KEY, JSON.stringify({ ts: 1_000 }));
    expect(peekAuthReturn(1_000)).toBeNull();
  });

  it('consume 一次性：讀到一次，第二次冇', () => {
    stashAuthReturn('/orders', 1_000);
    expect(consumeAuthReturn(1_000)).toBe('/orders');
    expect(consumeAuthReturn(1_000)).toBeNull();
    expect(store.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('冇記號時 consume 回 null（唔會炸）', () => {
    expect(consumeAuthReturn(1_000)).toBeNull();
  });
});

describe('sessionStorage 唔用得（私隱模式拋錯）', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stash 回 false、peek/consume 回 null，全部唔炸', () => {
    expect(stashAuthReturn('/try-on?productId=101', 1_000)).toBe(false);
    expect(peekAuthReturn(1_000)).toBeNull();
    expect(consumeAuthReturn(1_000)).toBeNull();
  });

  it('state.from 主線唔受 storage 故障影響', () => {
    // 頁面邏輯係「state.from 優先，storage 只係兜底」——呢度驗證 state 解析唔掂 storage
    expect(fromLocationState({ from: '/try-on?productId=101&guide=autumn-knit' })).toBe(
      '/try-on?productId=101&guide=autumn-knit',
    );
  });
});
