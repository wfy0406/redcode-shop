import type { Product, ProductCategory } from '@contracts/types';

/**
 * shop-utils —— 統一「卡片形產品」嘅資料形狀同 demo 數據
 *
 * 之前 ProductCard / Home / Products / ProductDetail 各自定義 Product 型別，
 * demo 數據三份唔同步（折扣價 / 上架日期唔一致）。而家統一喺呢度：
 *
 * DB product（superjson 過咗之後 listedDate 係 Date 物件；為穩陣起見都兼容 ISO 字串）：
 *   { id: number, sku, name, description: string|null, image, price, discountPrice: number|null,
 *     sizes: string|null（comma-separated，例如 "S,M,L"）, sizeEnabled: boolean,
 *     category, listedDate: Date, stock, isActive, createdAt }
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
  /** 尺寸選項總開關：false = 商品頁唔顯示尺寸、落單唔使揀（舊數據/示範數據冇呢欄當 true） */
  sizeEnabled: boolean;
  category: ProductCategory;
  listedDate: Date | string;
  stock: number;
}

export function parseSizes(sizes: string | null | undefined): string[] {
  if (!sizes) return [];
  return sizes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function effectivePrice(p: { price: number; discountPrice: number | null }): number {
  return p.discountPrice ?? p.price;
}

export function hasDiscount(p: { discountPrice: number | null }): boolean {
  return p.discountPrice != null;
}

export function formatHKD(n: number): string {
  return `HK$${n}`;
}

/** ProductCard 需要嘅形狀（同 src/data/products 嘅 Product 兼容：listedAt 係 YYYY-MM-DD 字串） */
export interface CardProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  discountPrice?: number;
  sizes?: string[];
  category?: ProductCategory;
  listedAt: string;
  image: string;
  soldOut: boolean;
  stock: number;
}

/** listedDate 兼容 Date（superjson）同 ISO 字串；Invalid 就用今日保底，唔好畀 Intl.DateTimeFormat 爆（Invalid time value） */
function toListedAt(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function toCardProduct(p: ShopProduct): CardProduct {
  return {
    id: String(p.id),
    name: p.name,
    sku: p.sku,
    price: p.price,
    discountPrice: p.discountPrice ?? undefined,
    sizes: p.sizes ? parseSizes(p.sizes) : undefined,
    category: p.category,
    listedAt: toListedAt(p.listedDate),
    image: p.image,
    soldOut: p.stock <= 0,
    stock: p.stock,
  };
}

/** 示範數據（API 未返／失敗時展示；日期相對而家推算，等「今日上架」成日有嘢睇） */
export function demoShopProducts(): ShopProduct[] {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const demo: Array<Omit<Product, 'listedDate'> & { listedDaysAgo: number }> = [
    { id: 1, sku: 'RC-KNIT-001', name: '粉色針織開衫外套', image: '/product-1.jpg', price: 268, discountPrice: 228, sizes: ['S', 'M', 'L'], category: 'top', stock: 30, listedDaysAgo: 0 },
    { id: 2, sku: 'RC-TOP-002', name: '白色雪紡荷葉邊恤衫', image: '/product-2.jpg', price: 198, sizes: ['S', 'M', 'L'], category: 'top', stock: 25, listedDaysAgo: 1 },
    { id: 3, sku: 'RC-DRESS-003', name: '黑色顯瘦連身裙', image: '/product-3.jpg', price: 328, discountPrice: 288, sizes: ['S', 'M', 'L', 'XL'], category: 'dress', stock: 18, listedDaysAgo: 2 },
    { id: 4, sku: 'RC-PANTS-004', name: '高腰闊腳長褲', image: '/product-4.jpg', price: 238, sizes: ['S', 'M', 'L'], category: 'pants', stock: 20, listedDaysAgo: 5 },
    { id: 5, sku: 'RC-SKIRT-005', name: '紫色碎花半身裙', image: '/product-5.jpg', price: 188, sizes: ['S', 'M', 'L'], category: 'dress', stock: 22, listedDaysAgo: 8 },
    { id: 6, sku: 'RC-SWEAT-006', name: '奶油白 oversize 衛衣', image: '/product-6.jpg', price: 228, sizes: ['S', 'M', 'L'], category: 'top', stock: 35, listedDaysAgo: 12 },
  ];
  return demo.map(({ listedDaysAgo, ...p }) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: null,
    image: p.image,
    price: p.price,
    discountPrice: p.discountPrice ?? null,
    sizes: p.sizes ? p.sizes.join(',') : null,
    sizeEnabled: true,
    category: p.category ?? 'other',
    listedDate: new Date(now - listedDaysAgo * DAY),
    stock: p.stock,
  }));
}
