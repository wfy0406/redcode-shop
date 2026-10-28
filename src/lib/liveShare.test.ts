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
