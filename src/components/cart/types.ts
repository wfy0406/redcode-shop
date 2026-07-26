/**
 * 購物車 / 結帳共用結構型別
 * 對應 trpc cart.list / orders.create 回傳結構（structural typing，唔直接依賴 api 型別）
 */

export interface CartLineProduct {
  id: number;
  sku: string;
  name: string;
  image: string;
  price: number;
  discountPrice: number | null;
}

export interface CartLine {
  id: number;
  size: string | null;
  quantity: number;
  product: CartLineProduct;
}

/** 建立訂單後，付款 / 完成步驟用到嘅欄位 */
export interface CreatedOrder {
  id: number;
  orderNo: string;
  total: number;
}

/** 單價：有折用折後價（discountPrice ?? price） */
export function unitPrice(line: CartLine): number {
  return line.product.discountPrice ?? line.product.price;
}

/** 行小計 */
export function lineTotal(line: CartLine): number {
  return unitPrice(line) * line.quantity;
}

/** 成車小計 */
export function cartSubtotal(items: CartLine[]): number {
  return items.reduce((sum, line) => sum + lineTotal(line), 0);
}
