/**
 * 單一商品公開事實 mapper（v2026.11.11 商品公開資料一致性）：
 * 可見首口 HTML 摘要（og.ts）、Product JSON-LD 同 Google Merchant Feed（merchantFeed.ts）
 * 三個公開出口一律由呢度取材，口徑只有一套。
 *
 * 規矩：
 * ─ 只用 products 表已核實真欄位（name/description/sku/category/price/discountPrice/
 *   stock/image/photos/sizes/sizeEnabled）；AI 標籤係未核實內容，呢度完全唔碰，
 *   絕對唔會當佢哋係規格。
 * ─ brand 冇任何真欄位：呢度唔出 brand，Feed 用 identifier_exists=no、
 *   JSON-LD 省略 brand，唔再硬編碼「全部貨都係 RedCode 品牌」。
 * ─ 描述清理同截斷全部行 contracts/types.ts 嘅 plainProductSeoText +
 *   productSeoDescription／truncateProductSeoText，三邊同一份規則。
 */
import {
  productCategoryLabel,
  productSeoDescription,
  truncateProductSeoText,
} from "@contracts/types";

/** mapper 接受嘅商品行結構（products.$inferSelect 子集；測試可以直接俾 plain object） */
export interface ProductPublicRow {
  id: number;
  name: string;
  description?: string | null;
  sku?: string | null;
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  stock: number;
  image: string;
  photos?: string[] | null;
  sizes?: string | null;
  sizeEnabled?: boolean;
}

/** Google Merchant Feed 描述上限（GMC description attribute 上限 5000 字元） */
export const FEED_DESCRIPTION_LIMIT = 5000;
/** GMC 每件貨最多 10 張 additional_image_link */
export const FEED_ADDITIONAL_IMAGE_MAX = 10;
/** GMC title 上限 150 字元 */
export const FEED_TITLE_LIMIT = 150;

/**
 * 內部 8 類 → Google product taxonomy ID 明確 mapping（ID 對照官方 taxonomy：
 * Shirts & Tops=212、Pants=204、Dresses=2271、Shoes=187、Skin Care=567、
 * Home & Garden=536；accessory 用正確上層 Apparel & Accessories=166，
 * 因為「飾物」冇欄位分珠宝(188)定衣物配件(167)，唔猜細類）。
 * other／未知類冇誠實對應 → 唔出 google_product_category（GMC 會自動分類），
 * 絕對唔會亂套 166 呃 Google。
 */
const GOOGLE_PRODUCT_CATEGORY_BY_INTERNAL: Record<string, string> = {
  top: "212",
  pants: "204",
  dress: "2271",
  shoes: "187",
  accessory: "166",
  lifestyle: "536",
  skincare: "567",
};

/** 內部分類 → google_product_category ID；other／未知 → null（Feed 省略呢個元素） */
export function googleProductCategoryId(category: string | null | undefined): string | null {
  return GOOGLE_PRODUCT_CATEGORY_BY_INTERNAL[category ?? ""] ?? null;
}

/** g:product_type 用真內部分類 label（同公開商品頁顯示嘅分類一致） */
export function productTypeLabel(category: string | null | undefined): string {
  return productCategoryLabel(category);
}

/** 尺寸選項：sizeEnabled=false（袋/飾物呢類）→ 空；否則 split 逗號、trim、去空。 */
export function productSizeOptions(row: ProductPublicRow): string[] {
  if (!row.sizeEnabled) return [];
  return (row.sizes ?? "")
    .split(",")
    .map((size) => size.trim())
    .filter(Boolean);
}

/**
 * 商品公開圖（絕對 URL）：photos 非空用晒成個相簿（photos[0]＝封面，同 image 欄同步），
 * 否則淨得 image 一張。首口 og:image 用 urls[0]；JSON-LD image 同 Feed
 * image_link＋additional_image_link 用同一個 array，三邊一致。
 */
export function productImageUrls(row: ProductPublicRow, origin: string): string[] {
  const raw = row.photos && row.photos.length > 0 ? row.photos : [row.image];
  return raw.map((u) => (u.startsWith("http") ? u : `${origin}${u}`));
}

/**
 * 真折扣價：discountPrice 存在兼真係平過原價先算數；壞資料（折扣仲貴過原價）
 * 當冇折扣，唔會好似舊 JSON-LD 咁將虚高原價當售價出街。
 */
export function productSalePrice(row: ProductPublicRow): number | null {
  return row.discountPrice != null && row.discountPrice < row.price
    ? row.discountPrice
    : null;
}

/** 實際售價：有真折扣用折扣價，否則原價。首口摘要、JSON-LD offers.price 同 Feed 實收價一致。 */
export function productEffectivePrice(row: ProductPublicRow): number {
  return productSalePrice(row) ?? row.price;
}

/** 庫存口徑：stock > 0 先有貨（首口「現貨 N 件」、JSON-LD InStock、Feed in stock 同源） */
export function productInStock(row: ProductPublicRow): boolean {
  return row.stock > 0;
}

/**
 * Feed 描述：同可見首口／JSON-LD 一樣行 productSeoDescription——
 * 有真（已批准先會入 DB 嘅）描述用真描述；冇描述用真貨號、分類、售價同庫存補強，
 * 唔再係「{名}｜RedCode 香港女裝直播」呢類冇事實嘅模板兜底。
 */
export function productFeedDescription(row: ProductPublicRow): string {
  return productSeoDescription(row, FEED_DESCRIPTION_LIMIT);
}

/** Feed title：同其他出口一樣用 truncateProductSeoText（截斷補「…」，唔硬切） */
export function productFeedTitle(row: ProductPublicRow): string {
  return truncateProductSeoText(row.name, FEED_TITLE_LIMIT);
}
