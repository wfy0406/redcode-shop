/**
 * 精選商品資料（scaffold 示例數據）
 * 商品欄位跟需求：上架日期、產品圖、產品貨號、價錢、折扣（選填）、尺寸（選填）
 * DATA-SLOT: 之後接真商品 API
 */

export interface Product {
  id: string;
  name: string;
  /** 產品貨號 */
  sku: string;
  /** 原價（HKD） */
  price: number;
  /** 折扣價（選填） */
  discountPrice?: number;
  /** 尺寸（選填） */
  sizes?: string[];
  /** 上架日期 ISO */
  listedAt: string;
  image: string;
  /** 直播中商品 */
  live?: boolean;
  /** 斷貨 */
  soldOut?: boolean;
}

export const PRODUCTS: Product[] = [
  {
    id: 'rc-1001',
    name: '星夜緞面吊帶連身裙',
    sku: 'RC-1001',
    price: 328,
    discountPrice: 268,
    sizes: ['S', 'M', 'L'],
    listedAt: '2025-07-24',
    image: '/product-1.png',
    live: true,
  },
  {
    id: 'rc-1002',
    name: '法式碎花雪紡上衣',
    sku: 'RC-1002',
    price: 228,
    sizes: ['Free Size'],
    listedAt: '2025-07-22',
    image: '/product-2.png',
  },
  {
    id: 'rc-1003',
    name: '高腰顯瘦闊腳牛仔褲',
    sku: 'RC-1003',
    price: 298,
    discountPrice: 248,
    sizes: ['S', 'M', 'L', 'XL'],
    listedAt: '2025-07-20',
    image: '/product-3.png',
  },
  {
    id: 'rc-1004',
    name: '韓系針織短版外套',
    sku: 'RC-1004',
    price: 358,
    sizes: ['M', 'L'],
    listedAt: '2025-07-18',
    image: '/product-4.png',
  },
  {
    id: 'rc-1005',
    name: '晚宴閃粉一字肩上衣',
    sku: 'RC-1005',
    price: 268,
    discountPrice: 198,
    sizes: ['S', 'M'],
    listedAt: '2025-07-15',
    image: '/product-5.png',
    live: true,
  },
  {
    id: 'rc-1006',
    name: '氣質傘擺中長半身裙',
    sku: 'RC-1006',
    price: 248,
    listedAt: '2025-07-12',
    image: '/product-6.png',
    soldOut: true,
  },
];

export function formatPrice(value: number): string {
  return `$${value.toLocaleString('zh-HK')}`;
}

/** 上架 7 日內當新品 */
export function isNewArrival(listedAt: string): boolean {
  const listed = new Date(listedAt).getTime();
  return Date.now() - listed < 7 * 24 * 60 * 60 * 1000;
}

export function formatListedAt(listedAt: string): string {
  return new Intl.DateTimeFormat('zh-HK', { month: 'numeric', day: 'numeric' }).format(
    new Date(listedAt),
  );
}
