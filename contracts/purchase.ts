import { z } from "zod";

/** AI 試穿後購買只傳商品 ID、尺寸及數量；品名、貨號、價錢全部由 server 重新讀取。 */
export const TRYON_PURCHASE_MAX_ITEMS = 3;

/** 同一次即買由草稿帶到落單；server 會化成穩定訂單編號，斷線重試可回原單。 */
export const TRYON_PURCHASE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const tryOnPurchaseRequestIdSchema = z.string().regex(
  TRYON_PURCHASE_REQUEST_ID_PATTERN,
  "即買請求編號格式唔啱",
);

export const tryOnPurchaseItemSchema = z.object({
  productId: z.number().int().positive(),
  size: z.string().trim().max(64).optional(),
  quantity: z.literal(1).default(1),
});

export const tryOnPurchaseItemsSchema = z
  .array(tryOnPurchaseItemSchema)
  .min(1, "至少要揀一件商品")
  .max(TRYON_PURCHASE_MAX_ITEMS, "每次最多購買三件試穿商品")
  .superRefine((items, context) => {
    const seen = new Set<number>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.productId)) {
        context.addIssue({
          code: "custom",
          path: [index, "productId"],
          message: "同一件商品唔可以重複提交",
        });
      }
      seen.add(item.productId);
    }
  });

export type TryOnPurchaseItem = z.infer<typeof tryOnPurchaseItemSchema>;
