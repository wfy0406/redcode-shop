import { describe, expect, it } from 'vitest';
import { normalizeAiTags, parseAiTagsJson, toCardProduct } from './shop-utils';
import type { ShopProduct } from './shop-utils';

describe('normalizeAiTags', () => {
  it('保留非空字串、trim、去重（順序保留）', () => {
    expect(normalizeAiTags([' 顯瘦 ', '百搭', '顯瘦', '', '  ', '針織'])).toEqual([
      '顯瘦',
      '百搭',
      '針織',
    ]);
  });

  it('非字串成員同非陣列輸入都回 []', () => {
    expect(normalizeAiTags(['a', 1, null, undefined, {}, 'b'])).toEqual(['a', 'b']);
    expect(normalizeAiTags('顯瘦')).toEqual([]);
    expect(normalizeAiTags(null)).toEqual([]);
    expect(normalizeAiTags(undefined)).toEqual([]);
    expect(normalizeAiTags({})).toEqual([]);
  });
});

describe('parseAiTagsJson（adminList raw JSON 防壞資料）', () => {
  it('正常 JSON 陣列 → 標籤陣列', () => {
    expect(parseAiTagsJson('["顯瘦","百搭"]')).toEqual(['顯瘦', '百搭']);
  });

  it('null / 空字串 / undefined → []', () => {
    expect(parseAiTagsJson(null)).toEqual([]);
    expect(parseAiTagsJson('')).toEqual([]);
    expect(parseAiTagsJson(undefined)).toEqual([]);
  });

  it('壞 JSON／非陣列 JSON 都回 [] 唔會 throw', () => {
    expect(parseAiTagsJson('{not json')).toEqual([]);
    expect(parseAiTagsJson('"顯瘦"')).toEqual([]);
    expect(parseAiTagsJson('123')).toEqual([]);
    expect(parseAiTagsJson('{"a":1}')).toEqual([]);
  });

  it('JSON 入面嘅壞成員會被過濾', () => {
    expect(parseAiTagsJson('["顯瘦", 42, null, " ", "百搭"]')).toEqual(['顯瘦', '百搭']);
  });
});

describe('toCardProduct 保留 aiTags', () => {
  const base: ShopProduct = {
    id: 7,
    sku: 'RC-0007',
    name: '測試上衣',
    description: null,
    image: '/product-1.jpg',
    price: 199,
    discountPrice: null,
    sizes: null,
    sizeEnabled: true,
    category: 'top',
    listedDate: new Date('2026-01-02T00:00:00Z'),
    stock: 5,
  };

  it('有 aiTags → 正規化後保留落 CardProduct', () => {
    const card = toCardProduct({ ...base, aiTags: [' 顯瘦 ', '百搭', '顯瘦'] });
    expect(card.aiTags).toEqual(['顯瘦', '百搭']);
  });

  it('冇 aiTags／空陣列 → undefined（卡片唔顯示）', () => {
    expect(toCardProduct(base).aiTags).toBeUndefined();
    expect(toCardProduct({ ...base, aiTags: [] }).aiTags).toBeUndefined();
  });
});
