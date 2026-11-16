/**
 * Glo Glo 指南純邏輯測試：香港發文時間、價錢、加車尺寸邊界（鐵律：
 * sizeEnabled＋多尺寸 → 導商品頁，唔准偷塞預設尺寸）、正文分段、
 * 圖片排序、圖片 ↔ 商品對應、標籤修剪、meta description 組裝。
 */

import { describe, expect, it } from 'vitest';
import {
  formatGuideDateHK,
  guideDateTimeAttr,
  guideDescription,
  guideEffectivePrice,
  guideHasDiscount,
  guideHighlightTags,
  guideLiveDateLabel,
  guidePath,
  guideProductPath,
  guideTryOnKind,
  guideTryOnPath,
  parseGuideSlugParam,
  productForImage,
  resolveGuideCartAction,
  sortGuideImages,
  splitGuideBody,
} from './guideUtils';
import type { GuideImage, GuideProduct } from './types';

function product(partial: Partial<GuideProduct>): GuideProduct {
  return {
    id: 1,
    name: '針織外套',
    image: '/p1.jpg',
    photos: [],
    price: 200,
    discountPrice: null,
    category: 'top',
    stock: 5,
    sizeEnabled: false,
    sizes: [],
    aiTags: [],
    isActive: true,
    liveDate: null,
    liveSession: null,
    ...partial,
  };
}

function image(partial: Partial<GuideImage>): GuideImage {
  return {
    id: 1,
    path: '/uploads/glo-guide/a.png',
    alt: '',
    width: 800,
    height: 1200,
    position: 0,
    productId: 1,
    ...partial,
  };
}

describe('formatGuideDateHK 香港發文時間', () => {
  it('UTC 時間轉香港時區（跨日要 +8）', () => {
    expect(formatGuideDateHK('2026-11-14T16:30:00.000Z')).toBe('2026年11月15日 00:30');
  });

  it('已是香港時間嘅 offset 輸入唔會再移位', () => {
    expect(formatGuideDateHK('2026-11-15T09:05:00+08:00')).toBe('2026年11月15日 09:05');
  });

  it('無效輸入回原字串，唔會出 Invalid Date', () => {
    expect(formatGuideDateHK('not-a-date')).toBe('not-a-date');
  });

  it('dateTime 屬性：有效回 ISO、無效回空字串', () => {
    expect(guideDateTimeAttr('2026-11-14T16:30:00.000Z')).toBe('2026-11-14T16:30:00.000Z');
    expect(guideDateTimeAttr('junk')).toBe('');
  });
});

describe('價錢', () => {
  it('折扣價低過原價先用折扣價', () => {
    const p = product({ price: 200, discountPrice: 150 });
    expect(guideEffectivePrice(p)).toBe(150);
    expect(guideHasDiscount(p)).toBe(true);
  });

  it('折扣價高過或等於原價當冇折扣（防壞資料）', () => {
    const p = product({ price: 200, discountPrice: 250 });
    expect(guideEffectivePrice(p)).toBe(200);
    expect(guideHasDiscount(p)).toBe(false);
  });

  it('discountPrice null 用原價', () => {
    expect(guideEffectivePrice(product({ price: 99 }))).toBe(99);
  });
});

describe('resolveGuideCartAction 加車尺寸邊界', () => {
  it('sizeEnabled＋多尺寸 → navigate 去商品頁，唔加車', () => {
    const action = resolveGuideCartAction(
      product({ id: 7, sizeEnabled: true, sizes: ['S', 'M', 'L'] }),
    );
    expect(action).toEqual({ kind: 'navigate', to: '/products/7' });
  });

  it('sizeEnabled＋冇有效尺寸 → 都係 navigate（唔准假設唔使尺寸、唔准 size:null 加車）', () => {
    expect(resolveGuideCartAction(product({ id: 8, sizeEnabled: true, sizes: [] }))).toEqual({
      kind: 'navigate',
      to: '/products/8',
    });
  });

  it('sizeEnabled＋得空白尺寸字串 → 有效尺寸 0，一樣 navigate', () => {
    expect(resolveGuideCartAction(product({ id: 9, sizeEnabled: true, sizes: [' ', '  '] }))).toEqual({
      kind: 'navigate',
      to: '/products/9',
    });
  });

  it('sizeEnabled＋唯一尺寸 → 帶嗰個尺寸加車（唯一合法選項，唔係預設）', () => {
    const action = resolveGuideCartAction(product({ sizeEnabled: true, sizes: ['Free'] }));
    expect(action).toEqual({ kind: 'add', size: 'Free' });
  });

  it('空白尺寸過濾後淨返一個 → 當唯一尺寸直接 add', () => {
    const action = resolveGuideCartAction(product({ sizeEnabled: true, sizes: ['  ', 'M'] }));
    expect(action).toEqual({ kind: 'add', size: 'M' });
  });

  it('冇開尺寸（sizeEnabled=false）→ size null 加車（就算 DTO 有 sizes 都唔用）', () => {
    expect(resolveGuideCartAction(product({ sizeEnabled: false, sizes: ['S', 'M'] }))).toEqual({
      kind: 'add',
      size: null,
    });
  });
});

describe('指南商品 → AI 試穿深連結', () => {
  it('重用試穿部位判斷；下架及唔支援商品唔出資格', () => {
    expect(guideTryOnKind(product({ category: 'top' }))).toBe('top');
    expect(guideTryOnKind(product({ category: 'accessory', name: '金色頸鏈' }))).toBe('necklace');
    expect(guideTryOnKind(product({ category: 'accessory', name: '泛稱飾品' }))).toBeNull();
    expect(guideTryOnKind(product({ category: 'top', isActive: false }))).toBeNull();
  });

  it('缺貨但未下架仍可做視覺預覽，同現有 tryon.listProducts 一致', () => {
    expect(guideTryOnKind(product({ category: 'top', stock: 0 }))).toBe('top');
  });

  it('保留 productId、商品原圖 photoIndex 同 guide slug', () => {
    expect(guideTryOnPath(product({ id: 42 }), 'autumn-knit', 2)).toBe(
      '/try-on?productId=42&photoIndex=2&guide=autumn-knit',
    );
    expect(guideTryOnPath(product({ id: 42 }), 'glo-guide-20261117-ab12', -1)).toBe(
      '/try-on?productId=42&photoIndex=0&guide=glo-guide-20261117-ab12',
    );
  });

  it('來源 slug 只接受安全站內格式', () => {
    expect(parseGuideSlugParam('autumn-knit')).toBe('autumn-knit');
    expect(parseGuideSlugParam('glo-guide-20261117-ab12')).toBe('glo-guide-20261117-ab12');
    expect(parseGuideSlugParam('')).toBeNull();
    expect(parseGuideSlugParam('../account')).toBeNull();
    expect(parseGuideSlugParam('https://evil.example')).toBeNull();
    expect(parseGuideSlugParam('a'.repeat(181))).toBeNull();
  });
});

describe('正文分段＋圖片', () => {
  it('splitGuideBody：換行分段、去空白段', () => {
    expect(splitGuideBody('第一段。\n\n第二段。\n   \n第三段。')).toEqual([
      '第一段。',
      '第二段。',
      '第三段。',
    ]);
  });

  it('sortGuideImages：按 position 升冪，唔改原陣列', () => {
    const imgs = [image({ id: 1, position: 2 }), image({ id: 2, position: 0 }), image({ id: 3, position: 1 })];
    const sorted = sortGuideImages(imgs);
    expect(sorted.map((i) => i.id)).toEqual([2, 3, 1]);
    expect(imgs.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('productForImage：圖片 productId 對應返真商品；null 或搵唔到都回 null', () => {
    const products = [product({ id: 1, name: '甲' }), product({ id: 2, name: '乙' })];
    expect(productForImage(image({ productId: 2 }), products)?.name).toBe('乙');
    expect(productForImage(image({ productId: 99 }), products)).toBeNull();
    expect(productForImage(image({ productId: null }), products)).toBeNull();
  });
});

describe('標籤／日期／路徑／description', () => {
  it('guideHighlightTags：去空白、去重複、最多 3 個', () => {
    expect(guideHighlightTags([' 顯瘦 ', '顯瘦', '百搭', '', '針織', '第四個'])).toEqual([
      '顯瘦',
      '百搭',
      '針織',
    ]);
  });

  it('guideLiveDateLabel：YYYYMMDD → 中文日期；無效回 null', () => {
    expect(guideLiveDateLabel('20260912')).toBe('2026年9月12日');
    expect(guideLiveDateLabel('2026-09-12')).toBeNull();
    expect(guideLiveDateLabel(null)).toBeNull();
  });

  it('路徑 helper', () => {
    expect(guidePath('autumn-knit')).toBe('/glo-guide/autumn-knit');
    expect(guideProductPath(42)).toBe('/products/42');
  });

  it('guideDescription：有 excerpt 用 excerpt（唔加料）', () => {
    expect(
      guideDescription({ excerpt: '  轉季三件頭咁襯。  ', theme: '轉季', title: '標題' }),
    ).toBe('轉季三件頭咁襯。');
  });

  it('guideDescription：冇 excerpt 用主題組句，唔會出空 description', () => {
    expect(guideDescription({ excerpt: ' ', theme: '轉季 layering', title: '轉季點襯' })).toContain(
      '轉季 layering',
    );
    expect(guideDescription({ excerpt: '', theme: '', title: '轉季點襯' })).toContain('轉季點襯');
  });
});
