import type { Product } from '@/data/products';
import { PRODUCTS as DEMO_PRODUCTS } from '@/data/products';

/**
 * 商店頁共用輔助 —— 將 tRPC products router 嘅 DB row 映射做 shared <ProductCard> 用嘅 Product 型。
 * DB product（superjson 過咗之後 listedDate 係 Date 物件）：
 *   { id: number, sku, name, description: string|null, image, price, discountPrice: number|null,
 *     sizes: string|null（comma-separated，例如 "S,M,L"）, listedDate: Date, stock, isActive, createdAt }
 */
export interface ShopProduct {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  image: string;
  price: number;
  discountPrice: number | null;
  sizes: string | null;
  listedDate: Date;
  stock: number;
}

/** sizes DB 欄位係 comma-separated 字串（"S,M,L"），拆返做陣列 */
export function parseSizes(sizes: string | null | undefined): string[] {
  if (!sizes) return [];
  return sizes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 價錢係 HKD integer，顯示 HK$268 */
export function formatHKD(value: number): string {
  return `HK$${value.toLocaleString('zh-HK')}`;
}

/** 上架 7 日內當「新上架」（listedDate 經 superjson 係 Date） */
export function isNewWithin7Days(listedDate: Date | string): boolean {
  const listed = new Date(listedDate).getTime();
  return Date.now() - listed < 7 * 24 * 60 * 60 * 1000;
}

/** 上架日期顯示（zh-HK） */
export function formatListedDate(listedDate: Date | string): string {
  return new Date(listedDate).toLocaleDateString('zh-HK');
}

/** DB row → shared ProductCard 嘅 Product（id 轉字串、listedDate 轉 ISO、sizes 拆陣列、stock≤0 當斷貨） */
export function toCardProduct(p: ShopProduct): Product {
  return {
    id: String(p.id),
    name: p.name,
    sku: p.sku,
    price: p.price,
    discountPrice: p.discountPrice ?? undefined,
    sizes: parseSizes(p.sizes),
    listedAt: new Date(p.listedDate).toISOString(),
    image: p.image,
    soldOut: p.stock <= 0,
  };
}

/**
 * 靜態示範模式：當後端 API 連唔到（例如純前端預覽），用呢啲內建示範商品。
 * 回傳 ShopProduct 形狀，等 shop 頁面可以無縫 fallback。
 */
export function demoShopProducts(): ShopProduct[] {
  return DEMO_PRODUCTS.map((p, i) => ({
    id: i + 1,
    sku: p.sku,
    name: p.name,
    description: null,
    image: p.image,
    price: p.price,
    discountPrice: p.discountPrice ?? null,
    sizes: p.sizes ? p.sizes.join(',') : null,
    listedDate: new Date(p.listedAt),
    stock: p.soldOut ? 0 : 10,
  }));
}
