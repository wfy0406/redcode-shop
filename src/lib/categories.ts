import { PRODUCT_CATEGORIES } from "@contracts/types";

/**
 * 商品分類下拉選項（後台商品管理表單用）。
 * 資料源係 @contracts/types 嘅 PRODUCT_CATEGORIES（單一真相），
 * 呢度只係 map 做 { key, label } 方便 <select> render。
 */
export const CATEGORY_OPTIONS: { key: string; label: string }[] =
  PRODUCT_CATEGORIES.map((c) => ({ key: c.value, label: c.label }));
