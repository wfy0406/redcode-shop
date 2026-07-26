export * from "./errors";

/**
 * 商品分類（固定 7 類）—— 前後台共用
 * value 係 DB 儲存值（products.category varchar(32)），label 係界面顯示
 */
export const PRODUCT_CATEGORIES = [
  { value: "top", label: "上衣" },
  { value: "pants", label: "褲" },
  { value: "dress", label: "裙" },
  { value: "shoes", label: "鞋" },
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
