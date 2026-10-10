/**
 * 訂單硬刪除共用邏輯（v2.5.5 第7版，2026-10-11 老闆指示抽出）：
 * 官網後台「永久刪除」（ordersRouter.remove）同 WMS 官網中心刪單回調
 * （wmsDeleteOrder.ts）共用呢度——兩邊行為保證一致，唔會再出現一邊刪到一邊刪唔到。
 *
 * 刪除順序（全部冇 cascade，漏一個都會 23503）：
 *   luckyDraws（中獎紀錄）→ orderShipments（WMS 出貨批次）→ paymentProofs（截圖）
 *   → wmsSyncLog（同步紀錄）→ orderItems（明細）→ orders 本身
 *
 * 庫存規則：未收款嘅單（待收款／審核中／被拒）刪除會**加返庫存**（貨根本未出）；
 * 已確認／已取消／出貨類就唔郁庫存（已取消嘅喺取消嗰刻已經加返咗，唔好加兩次）。
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { luckyDraws, orders, orderItems, orderShipments, paymentProofs, products, wmsSyncLog } from "@db/schema";

export interface HardDeleteResult {
  order: typeof orders.$inferSelect & { items: (typeof orderItems.$inferSelect)[] };
  restoreStock: boolean;
  drawsDeleted: number;
}

/** 完整刪除一張訂單；搵唔到返 null。所有外鍵表一齊刪（同一 transaction）。 */
export async function hardDeleteOrder(orderId: number): Promise<HardDeleteResult | null> {
  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: { items: true },
  });
  if (!order) return null;

  const restoreStock = ["pending_payment", "payment_review", "rejected"].includes(
    order.status,
  );
  let drawRowsDeleted = 0;
  await db.transaction(async (tx) => {
    if (restoreStock) {
      for (const item of order.items) {
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${item.quantity}` })
          .where(eq(products.id, item.productId));
      }
    }
    // 中獎訂單嘅抽獎紀錄一併硬刪（luckyDraws.orderId 有 FK 指住 orders，冇 cascade）；
    // 刪咗紀錄件獎品自然返返入池（takenCount 只計 pending/confirmed）
    const delDraws = await tx.delete(luckyDraws).where(eq(luckyDraws.orderId, order.id)).returning({ id: luckyDraws.id });
    drawRowsDeleted = delDraws.length;
    // v2.5.5 第6版（老闆實測 2026-10-11：「官網刪除唔到訂單」23503）：orderShipments（WMS 出貨批次）
    // 都有 FK 指住 orders（冇 cascade），出過貨／有批次紀錄嘅單唔刪佢先會爆 FK——連批次一齊刪
    await tx.delete(orderShipments).where(eq(orderShipments.orderId, order.id));
    await tx.delete(paymentProofs).where(eq(paymentProofs.orderId, order.id));
    await tx.delete(wmsSyncLog).where(eq(wmsSyncLog.orderId, order.id));
    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    await tx.delete(orders).where(eq(orders.id, order.id));
  });
  return { order, restoreStock, drawsDeleted: drawRowsDeleted };
}
