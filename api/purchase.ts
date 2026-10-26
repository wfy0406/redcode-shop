import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import { products } from "@db/schema";
import type { TryOnPurchaseItem } from "@contracts/purchase";
import { getDb } from "./queries/connection";

export type PurchaseProduct = typeof products.$inferSelect;

/** 結帳報價同落單共用嘅已核實商品行；正常購物車行亦符合呢個結構。 */
export interface ResolvedPurchaseItem {
  productId: number;
  size: string | null;
  quantity: number;
  product: PurchaseProduct;
}

function isDelisted(product: PurchaseProduct): boolean {
  if (!product.isActive) return true;
  return Boolean(
    product.delistEnabled &&
      product.delistAt !== null &&
      product.delistAt.getTime() <= Date.now(),
  );
}

export function purchaseSizes(product: Pick<PurchaseProduct, "sizes">): string[] {
  return (product.sizes ?? "")
    .split(",")
    .map((size) => size.trim())
    .filter(Boolean);
}

/**
 * 將客戶端嘅 ID 清單對返目前 DB 商品。任何品名、貨號或價錢欄都唔會由客戶端帶入訂單。
 * 需要尺寸嘅商品必須揀現有選項；AI 試穿結果不會當成尺碼依據。
 */
export function resolveTryOnPurchaseItems(
  items: readonly TryOnPurchaseItem[],
  productRows: readonly PurchaseProduct[],
): ResolvedPurchaseItem[] {
  const byId = new Map(productRows.map((product) => [product.id, product]));
  const seen = new Set<number>();

  return items.map((item) => {
    if (seen.has(item.productId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "同一件商品唔可以重複提交" });
    }
    seen.add(item.productId);

    const product = byId.get(item.productId);
    if (!product || isDelisted(product)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `商品 #${item.productId} 已下架或唔存在，請更新購買清單`,
      });
    }

    const sizes = purchaseSizes(product);
    const needsSize = product.sizeEnabled && sizes.length > 0;
    let size: string | null = null;
    if (needsSize) {
      const candidate = item.size?.trim() ?? "";
      if (!candidate || !sizes.includes(candidate)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `請為《${product.name}》揀返有效尺寸`,
        });
      }
      size = candidate;
    }

    return {
      productId: product.id,
      size,
      quantity: item.quantity,
      product,
    };
  });
}

export async function loadTryOnPurchaseItems(
  items: readonly TryOnPurchaseItem[],
): Promise<ResolvedPurchaseItem[]> {
  const db = getDb();
  const ids = [...new Set(items.map((item) => item.productId))];
  const rows = ids.length
    ? await db.select().from(products).where(inArray(products.id, ids))
    : [];
  return resolveTryOnPurchaseItems(items, rows);
}
