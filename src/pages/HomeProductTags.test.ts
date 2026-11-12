import { describe, expect, it } from 'vitest';
import { mapDbProduct } from './Home';

const base: Parameters<typeof mapDbProduct>[0] = {
  id: 261,
  name: '米白立領金屬鈕扣短外套',
  sku: 'B261',
  price: 144,
  discountPrice: null,
  sizes: 'S, M',
  listedDate: new Date('2026-11-01T00:00:00Z'),
  image: '/product-2.jpg',
  stock: 3,
};

describe('首頁 DB 商品 mapper 重點標籤', () => {
  it('將公開 API 已批准標籤原序帶入 ProductCard 資料', () => {
    const product = mapDbProduct({ ...base, aiTags: ['米白', '立領', '金屬鈕扣'] });
    expect(product.aiTags).toEqual(['米白', '立領', '金屬鈕扣']);
    expect(product).toMatchObject({ id: '261', sku: 'B261', price: 144, soldOut: false });
  });

  it('沿用商品列表正規化：trim、去重、忽略空字串', () => {
    const product = mapDbProduct({
      ...base,
      aiTags: [' 米白 ', '立領', '米白', '', '   ', '立領'],
    });
    expect(product.aiTags).toEqual(['米白', '立領']);
  });

  it('冇標籤或全部係空值時唔留空容器資料', () => {
    expect(mapDbProduct(base).aiTags).toBeUndefined();
    expect(mapDbProduct({ ...base, aiTags: [] }).aiTags).toBeUndefined();
    expect(mapDbProduct({ ...base, aiTags: ['', '   '] }).aiTags).toBeUndefined();
  });
});
