export * from "./errors";

/**
 * 商品分類（固定 8 類）—— 前後台共用
 * value 係 DB 儲存值（products.category varchar(32)），label 係界面顯示
 */
export const PRODUCT_CATEGORIES = [
  { value: "top", label: "上衣" },
  { value: "pants", label: "褲" },
  { value: "dress", label: "裙" },
  { value: "shoes", label: "鞋" },
  { value: "accessory", label: "飾物" },
  { value: "lifestyle", label: "生活用品" },
  { value: "skincare", label: "護膚品" },
  { value: "other", label: "其他" },
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]["value"];

export const PRODUCT_CATEGORY_VALUES = PRODUCT_CATEGORIES.map(
  (c) => c.value,
) as ProductCategory[];

const CATEGORY_LABEL_MAP = Object.fromEntries(
  PRODUCT_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<ProductCategory, string>;

/** 類別 value → 中文 label；未知值當「其他」 */
export function productCategoryLabel(value: string | null | undefined): string {
  return CATEGORY_LABEL_MAP[(value ?? "other") as ProductCategory] ?? "其他";
}

/** 商品 SEO 用到嘅公開事實；前後端共用，避免首口 HTML 同 React 載入後各寫一套描述。 */
export interface ProductSeoFacts {
  name: string;
  description?: string | null;
  sku?: string | null;
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  stock: number;
}

/** 描述入面嘅 HTML、控制碼同 emoji 剝走；meta／JSON-LD 只用純文字。 */
export function plainProductSeoText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateProductSeoText(value: string, limit = 120): string {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 120;
  if (value.length <= cap) return value;
  return cap === 1 ? "…" : `${value.slice(0, cap - 1)}…`;
}

/**
 * 有真描述就用真描述；冇描述就用真貨號、分類、售價同庫存補強。
 * 唔虛構材質、尺碼、折扣或評價，亦唔再用每個商品都一樣嘅空泛句式。
 */
export function productSeoDescription(product: ProductSeoFacts, limit = 120): string {
  const plain = plainProductSeoText(product.description);
  if (plain) return truncateProductSeoText(plain, limit);
  const sku = product.sku?.trim() ? `貨號 ${product.sku.trim()}｜` : "";
  const price = product.discountPrice ?? product.price;
  const availability = product.stock > 0 ? `現貨 ${product.stock} 件` : "暫時缺貨";
  const fallback = `${product.name}｜${productCategoryLabel(product.category)}｜${sku}HK$${price}｜${availability}。RedCode 香港直播精選，商品頁可睇相片、尺寸同最新購買資料。`;
  return truncateProductSeoText(fallback, limit);
}
