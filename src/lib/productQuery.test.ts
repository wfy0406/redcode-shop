import { describe, expect, it } from 'vitest';
import { isProductNotFoundError } from './productQuery';

describe('商品查詢錯誤分類', () => {
  it('明確 NOT_FOUND／HTTP 404 必須視為已刪或下架，唔准用示範商品', () => {
    expect(isProductNotFoundError({ data: { code: 'NOT_FOUND', httpStatus: 404 } })).toBe(true);
    expect(isProductNotFoundError({ data: { httpStatus: 404 } })).toBe(true);
  });

  it('網絡故障、server 500 或其他錯誤先可以用示範商品兜底', () => {
    expect(isProductNotFoundError(new TypeError('fetch failed'))).toBe(false);
    expect(isProductNotFoundError({ data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } })).toBe(false);
    expect(isProductNotFoundError(null)).toBe(false);
  });
});
