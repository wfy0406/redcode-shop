import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, products } from "@db/schema";
import { logAudit } from "./audit";

/**
 * 待付款訂單自動取消（2026-07-30 Glo 規則）
 * 客人落單後 3 天（72 小時）都未上傳付款截圖（status 仲係 pending_payment），
 * 系統自動將張單轉做「已取消」＋逐行加返庫存（同後台人手取消同一套做法），
 * 審計日誌留底（actor＝系統）。
 * 已上傳截圖嘅單唔受影響：佢哋 status 一早轉咗 payment_review。
 * 開機時即刻掃一次，之後每 30 分鐘掃一次；任何失敗淨係 log，唔會冧 server。
 */

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** 掃描＋取消逾期待付款訂單，回傳取消咗幾多張 */
export async function sweepExpiredPendingOrders(now = new Date()): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - THREE_DAYS_MS);
  const expired = await db.query.orders.findMany({
    where: and(eq(orders.status, "pending_payment"), lt(orders.createdAt, cutoff)),
    with: { items: true },
  });

  let cancelled = 0;
  for (const order of expired) {
    try {
      await db.transaction(async (tx) => {
        // 雙重檢查：如果同一秒有客人啱啱傳咗截圖／員工改咗狀態，就唔好郁
        const [updated] = await tx
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")))
          .returning({ id: orders.id });
        if (!updated) return;
        // 取消訂單＝貨唔會出，落單時扣咗嘅庫存要加返（同 updateStatus 取消同一套）
        for (const item of order.items) {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} + ${item.quantity}` })
            .where(eq(products.id, item.productId));
        }
      });
      cancelled += 1;
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "order.autoCancel",
        targetType: "order",
        targetId: order.orderNo,
        detail: `訂單 ${order.orderNo} 落單滿 3 天未上傳付款截圖，系統自動取消（庫存已加返）`,
      });
    } catch (e) {
      console.error(`[sweeper] 取消訂單 ${order.orderNo} 失敗:`, e);
    }
  }
  return cancelled;
}

/** 開機啟動：即刻掃一次，之後每 30 分鐘掃一次 */
export function startOrderSweeper(): void {
  const run = (label: string) =>
    sweepExpiredPendingOrders()
      .then((n) => {
        if (n > 0) console.log(`[sweeper] ${label}：自動取消咗 ${n} 張逾期待付款訂單`);
      })
      .catch((e) => console.error(`[sweeper] ${label}失敗:`, e));

  void run("首次掃描");
  setInterval(() => void run("定時掃描"), SWEEP_INTERVAL_MS);
}
