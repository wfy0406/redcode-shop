/**
 * 直播分享 helper 測試（v2026.10.28.2）——純函數，node 環境行。
 * 覆蓋：真實日曆日期／數字場次驗證、URL 編碼（URLSearchParams）、
 * 日期格式化、全日／單場分享文案分別、FB／WhatsApp share link、無效輸入唔反射。
 */
import { describe, expect, it } from 'vitest';
import {
  facebookShareUrl,
  formatLiveDateLabel,
  isValidLiveDate,
  isValidLiveSession,
  liveSharePath,
  liveShareText,
  liveShareTitle,
  liveShareUrl,
  normalizeLiveShare,
  scheduleLiveMeta,
  whatsappShareUrl,
} from './liveShare';

describe('isValidLiveDate — 真實日曆日期', () => {
  it('正常日期過', () => {
    expect(isValidLiveDate('20261028')).toBe(true);
    expect(isValidLiveDate('20240229')).toBe(true); // 閏年 2 月 29 日
  });
  it('假日曆日期唔過', () => {
    expect(isValidLiveDate('20230229')).toBe(false); // 平年冇 2/29
    expect(isValidLiveDate('20261301')).toBe(false); // 冇 13 月
    expect(isValidLiveDate('20260230')).toBe(false); // 2 月冇 30 日
    expect(isValidLiveDate('20261000')).toBe(false);
    expect(isValidLiveDate('20261032')).toBe(false);
  });
  it('格式唔啱唔過', () => {
    expect(isValidLiveDate('')).toBe(false);
    expect(isValidLiveDate('2026102')).toBe(false);
    expect(isValidLiveDate('2026-10-28')).toBe(false);
    expect(isValidLiveDate('20261028<br>')).toBe(false);
  });
});

describe('isValidLiveSession — 正整數場次', () => {
  it('正整數過', () => {
    expect(isValidLiveSession('1')).toBe(true);
    expect(isValidLiveSession('12')).toBe(true);
    expect(isValidLiveSession('999')).toBe(true);
  });
  it('零／前導零／負數／小數／非數字唔過', () => {
    expect(isValidLiveSession('')).toBe(false);
    expect(isValidLiveSession('0')).toBe(false);
    expect(isValidLiveSession('01')).toBe(false);
    expect(isValidLiveSession('-1')).toBe(false);
    expect(isValidLiveSession('1.5')).toBe(false);
    expect(isValidLiveSession('abc')).toBe(false);
    expect(isValidLiveSession('1"><script>')).toBe(false);
  });
});

describe('normalizeLiveShare — 無效輸入回 null（絕不反射）', () => {
  it('有效全日／單場', () => {
    expect(normalizeLiveShare('20261028')).toEqual({ liveDate: '20261028', liveSession: null });
    expect(normalizeLiveShare('20261028', '')).toEqual({ liveDate: '20261028', liveSession: null });
    expect(normalizeLiveShare('20261028', '2')).toEqual({ liveDate: '20261028', liveSession: '2' });
  });
  it('無效日期／場次 → null', () => {
    expect(normalizeLiveShare('20261301')).toBeNull();
    expect(normalizeLiveShare('not-a-date')).toBeNull();
    expect(normalizeLiveShare('20261028', 'abc')).toBeNull();
    expect(normalizeLiveShare('20261028', '0')).toBeNull();
  });
});

describe('liveSharePath / liveShareUrl — URLSearchParams 編碼', () => {
  it('全日淨 liveDate', () => {
    expect(liveSharePath({ liveDate: '20261028', liveSession: null })).toBe(
      '/products?liveDate=20261028',
    );
  });
  it('單場 liveDate + liveSession', () => {
    expect(liveSharePath({ liveDate: '20261028', liveSession: '2' })).toBe(
      '/products?liveDate=20261028&liveSession=2',
    );
  });
  it('origin 尾隨 / 剝走，唔會雙斜線', () => {
    expect(liveShareUrl('https://redcode.red/', { liveDate: '20261028', liveSession: null })).toBe(
      'https://redcode.red/products?liveDate=20261028',
    );
  });
});

describe('日期格式化＋分享文案（全日／單場有分別）', () => {
  it('formatLiveDateLabel', () => {
    expect(formatLiveDateLabel('20261028')).toBe('2026年10月28日');
    expect(formatLiveDateLabel('20260101')).toBe('2026年1月1日');
  });
  it('全日：標題／內文强调全部場次', () => {
    const t = { liveDate: '20261028', liveSession: null };
    expect(liveShareTitle(t)).toBe('2026年10月28日 全日直播商品｜RedCode');
    expect(liveShareText(t)).toContain('全日直播商品');
    expect(liveShareText(t)).toContain('全部場次');
  });
  it('單場：標題／內文强调指定場次即睇即買', () => {
    const t = { liveDate: '20261028', liveSession: '2' };
    expect(liveShareTitle(t)).toBe('2026年10月28日 第2場直播商品｜RedCode');
    expect(liveShareText(t)).toContain('第2場');
    expect(liveShareText(t)).toContain('即睇即買');
  });
  it('分享文案唔再無條件承諾直播優惠價；品名／價錢／庫存以商品頁為準', () => {
    for (const t of [
      { liveDate: '20261028', liveSession: null },
      { liveDate: '20261028', liveSession: '2' },
    ]) {
      expect(liveShareText(t)).not.toContain('直播優惠價發售');
      expect(liveShareText(t)).not.toContain('優惠繼續生效');
      expect(liveShareText(t)).toContain('以商品頁為準');
    }
  });
});

describe('Facebook／WhatsApp share link', () => {
  const url = 'https://redcode.red/products?liveDate=20261028&liveSession=2';
  it('Facebook sharer：u= encode 成條 URL', () => {
    expect(facebookShareUrl(url)).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    );
  });
  it('WhatsApp：文案＋連結一齊 encode（query 唔會甩出嚟）', () => {
    const wa = whatsappShareUrl('測試文案', url);
    expect(wa.startsWith('https://wa.me/?text=')).toBe(true);
    expect(wa).toContain(encodeURIComponent(url));
    // raw & 唔准出現喺 text 參數入面（會截斷文案）
    expect(wa).not.toContain('&liveSession');
  });
});

// scheduleLiveMeta 嘅假 document（node 環境冇 DOM）
function makeFakeDoc() {
  const store = new Map<string, { attrs: Record<string, string>; removed: boolean }>();
  const appended: { attrs: Record<string, string> }[] = [];
  const doc = {
    title: '',
    appended,
    head: {
      appendChild(el: { setAttribute(n: string, v: string): void }) {
        appended.push((el as unknown as { __rec: { attrs: Record<string, string> } }).__rec);
      },
    },
    createElement: () => {
      const rec = { attrs: {} as Record<string, string> };
      return Object.assign(
        {
          setAttribute: (n: string, v: string) => {
            rec.attrs[n] = v;
          },
          remove: () => {},
        },
        { __rec: rec },
      );
    },
    querySelector(sel: string) {
      if (!store.has(sel)) store.set(sel, { attrs: {}, removed: false });
      const rec = store.get(sel)!;
      if (rec.removed) return null; // 移除咗嘅元素 querySelector 搵唔到
      return {
        setAttribute: (n: string, v: string) => {
          rec.attrs[n] = v;
        },
        remove: () => {
          rec.removed = true;
        },
      };
    },
    attr(sel: string, name: string) {
      return store.get(sel)?.attrs[name];
    },
    removed(sel: string) {
      return store.get(sel)?.removed === true;
    },
  };
  return doc;
}

describe('scheduleLiveMeta — 場次動態 meta（v2026.11.11.2）', () => {
  it('microtask 寫入喺同步 effect flush 之後先落 DOM（cached-mount 唔會被 parent 通用句冚走）', async () => {
    const doc = makeFakeDoc();
    // child（Products）effect 先跑：排入真摘要
    scheduleLiveMeta({ description: '真全場摘要' }, doc);
    // parent（SeoManager）effect 後跑：同步用通用句冚
    doc.querySelector('meta[name="description"]')!.setAttribute('content', '通用直播句');
    // 同步階段完結時仲係通用句
    expect(doc.attr('meta[name="description"]', 'content')).toBe('通用直播句');
    // microtask flush 之後：真摘要先係最終值
    await Promise.resolve();
    expect(doc.attr('meta[name="description"]', 'content')).toBe('真全場摘要');
  });

  it('空場次分流：title／description／noindex／移除 canonical＋og:url 一次過寫', async () => {
    const doc = makeFakeDoc();
    scheduleLiveMeta(
      {
        title: '2026年11月11日 第2場直播暫未有公開商品｜RedCode Fashion Design',
        description: 'RedCode 2026年11月11日 第2場直播而家冇公開商品……',
        robots: 'noindex, nofollow',
        canonicalPath: null,
      },
      doc,
    );
    await Promise.resolve();
    expect(doc.title).toContain('暫未有公開商品');
    expect(doc.attr('meta[name="robots"]', 'content')).toBe('noindex, nofollow');
    expect(doc.removed('link[rel="canonical"]')).toBe(true);
    expect(doc.removed('meta[property="og:url"]')).toBe(true);
  });

  it('可逆：空場次之後恢復（error 或有貨）→ index,follow＋重建 canonical＋og:url', async () => {
    const doc = makeFakeDoc();
    // 先入空場（移除 canonical／og:url、noindex）
    scheduleLiveMeta({ robots: 'noindex, nofollow', canonicalPath: null }, doc);
    await Promise.resolve();
    expect(doc.removed('link[rel="canonical"]')).toBe(true);
    // 之後恢復：robots 還原、canonical link 重建、og:url 重建入 head
    scheduleLiveMeta(
      { robots: 'index, follow', canonicalPath: '/products?liveDate=20261111&liveSession=2' },
      doc,
    );
    await Promise.resolve();
    expect(doc.attr('meta[name="robots"]', 'content')).toBe('index, follow');
    expect(doc.appended.some((el) => el.attrs.rel === 'canonical'
      && el.attrs.href === 'https://redcode.red/products?liveDate=20261111&liveSession=2')).toBe(true);
    expect(doc.appended.some((el) => el.attrs.property === 'og:url'
      && el.attrs.content === 'https://redcode.red/products?liveDate=20261111&liveSession=2')).toBe(true);
  });

  it('canonicalPath undefined → canonical 完全唔郁', async () => {
    const doc = makeFakeDoc();
    scheduleLiveMeta({ description: '只改描述' }, doc);
    await Promise.resolve();
    expect(doc.removed('link[rel="canonical"]')).toBe(false);
    expect(doc.appended).toHaveLength(0);
  });

  it('error／真空場決策可清走首口舊直播 ItemList，唔留過時貨品事實', async () => {
    const schema = {
      removed: false,
      setAttribute: () => {},
      remove() { this.removed = true; },
    };
    const doc = Object.assign(makeFakeDoc(), {
      querySelectorAll: () => [schema],
    });
    scheduleLiveMeta({ clearRouteSchema: true }, doc);
    await Promise.resolve();
    expect(schema.removed).toBe(true);
  });
});
