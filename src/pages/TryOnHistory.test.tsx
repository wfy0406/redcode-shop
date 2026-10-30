import { describe, expect, it } from 'vitest';
import {
  buildAbsoluteShareUrl,
  buildRecordProductShareText,
  buildRecordShareText,
  currentPrice,
  hasDiscount,
  hkDateLabel,
  hkDateTimeLabel,
  isRecordExpired,
  moneyHkd,
  recordDownloadFilename,
} from './TryOnHistory';

describe('TryOnHistory 純輔助', () => {
  it('moneyHkd：四捨五入、唔會出負數', () => {
    expect(moneyHkd(599)).toBe('HK$599');
    expect(moneyHkd(1234.6)).toBe('HK$1,235');
    expect(moneyHkd(-5)).toBe('HK$0');
  });

  it('currentPrice / hasDiscount：優惠價低過原價先當有折扣', () => {
    expect(currentPrice({ productPrice: 599, productDiscountPrice: 499 })).toBe(499);
    expect(currentPrice({ productPrice: 399, productDiscountPrice: null })).toBe(399);
    expect(hasDiscount({ productPrice: 599, productDiscountPrice: 499 })).toBe(true);
    expect(hasDiscount({ productPrice: 599, productDiscountPrice: 599 })).toBe(false);
    expect(hasDiscount({ productPrice: 599, productDiscountPrice: null })).toBe(false);
  });

  it('isRecordExpired：過咗 expiresAt 即過期；壞日期當未過期', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(isRecordExpired({ expiresAt: new Date('2026-10-25T11:59:59Z') }, now)).toBe(true);
    expect(isRecordExpired({ expiresAt: new Date('2026-10-25T12:00:01Z') }, now)).toBe(false);
    expect(isRecordExpired({ expiresAt: '2026-10-25T11:00:00Z' }, now)).toBe(true);
    expect(isRecordExpired({ expiresAt: 'not-a-date' }, now)).toBe(false);
  });

  it('hkDateLabel：null → —，否則香港時區日期', () => {
    expect(hkDateLabel(null)).toBe('—');
    expect(hkDateLabel(undefined)).toBe('—');
    expect(hkDateLabel('bad')).toBe('—');
    // 2026-10-25 00:30 UTC = 香港 08:30 同一日
    expect(hkDateLabel(new Date('2026-10-25T00:30:00Z'))).toBe('2026/10/25');
    // 2026-10-24 16:30 UTC = 香港 10-25 00:30，要跨日
    expect(hkDateLabel(new Date('2026-10-24T16:30:00Z'))).toBe('2026/10/25');
  });

  it('hkDateTimeLabel：null → —，否則香港時區日期＋時間', () => {
    expect(hkDateTimeLabel(null)).toBe('—');
    const label = hkDateTimeLabel(new Date('2026-10-25T00:30:00Z'));
    expect(label).toContain('2026');
    expect(label).toContain('08:30');
  });

  it('buildAbsoluteShareUrl：相對 path 組 origin；處理多餘斜線', () => {
    expect(buildAbsoluteShareUrl('https://redcode.example', '/try-on/shared?x=1')).toBe('https://redcode.example/try-on/shared?x=1');
    expect(buildAbsoluteShareUrl('https://redcode.example/', '/try-on/shared')).toBe('https://redcode.example/try-on/shared');
    expect(buildAbsoluteShareUrl('https://redcode.example', 'try-on/shared')).toBe('https://redcode.example/try-on/shared');
    expect(buildAbsoluteShareUrl('https://redcode.example/', '')).toBe('https://redcode.example');
    // 真實分享連結格式：path param publicId ＋ query e/s（同 api/tryonSharing.ts 一致）
    expect(
      buildAbsoluteShareUrl('https://redcode.example', '/try-on/shared/abc-123?e=1761902400000&s=sig'),
    ).toBe('https://redcode.example/try-on/shared/abc-123?e=1761902400000&s=sig');
  });

  it('buildRecordShareText：品名貨號價錢齊；有折扣會標明原價', () => {
    const plain = buildRecordShareText({ productName: '針織上衣', productSku: 'TOP-01', productPrice: 399, productDiscountPrice: null });
    expect(plain).toContain('針織上衣');
    expect(plain).toContain('TOP-01');
    expect(plain).toContain('HK$399');
    expect(plain).not.toContain('原價');
    const discounted = buildRecordShareText({ productName: '針織上衣', productSku: 'TOP-01', productPrice: 599, productDiscountPrice: 499 });
    expect(discounted).toContain('HK$499');
    expect(discounted).toContain('原價');
  });

  it('PNG 分享文字補公開商品網址，保留品名貨號價錢且不帶私人媒體 URL', () => {
    const record = {
      productId: 123,
      productName: '針織上衣',
      productSku: 'TOP-01',
      productPrice: 599,
      productDiscountPrice: 499,
      outputUrl: 'https://private.example/signed-try-on.png?signature=secret',
    };
    const text = buildRecordProductShareText(record, 'https://redcode.example/');
    expect(text).toContain('針織上衣');
    expect(text).toContain('TOP-01');
    expect(text).toContain('HK$499');
    expect(text).toContain('商品網址：https://redcode.example/products/123');
    expect(text).not.toContain('private.example');
    expect(text).not.toContain('signature=');
  });

  it('recordDownloadFilename：跟試穿頁命名規則', () => {
    expect(recordDownloadFilename({ productSku: 'TOP-01', stepNumber: 2 })).toBe('RedCode-AI試穿-TOP-01-第2件.png');
  });
});
