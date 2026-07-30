import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, orderItems, promoCodes, users } from "@db/schema";
import { createRouter, adminProcedure } from "./middleware";

/**
 * 業務分析 —— 全部 admin only
 * 「今日」同每日分組一律用 HKT（UTC+8）；訂單數同 revenue 排除 pending_payment／cancelled／rejected
 * （2026-07-30 Glo 規則：未傳截圖嘅待付款單唔係實單，唔計入分析；
 * 唔再要出貨步驟：approved＝已確認＝終態；confirmedCount 連 legacy shipped/completed 一齊計）
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEAD_STATUSES = ["pending_payment", "cancelled", "rejected"] as const;

/** HKT 今日 00:00 對應嘅 UTC Date */
function hktTodayStartUtc(): Date {
  return new Date(Math.floor((Date.now() + HKT_OFFSET_MS) / DAY_MS) * DAY_MS - HKT_OFFSET_MS);
}

/** 將 UTC Date 轉做 HKT 嘅 YYYY-MM-DD */
function hktDateString(d: Date): string {
  return new Date(d.getTime() + HKT_OFFSET_MS).toISOString().slice(0, 10);
}

export const analyticsRouter = createRouter({
  summary: adminProcedure.query(async () => {
    const db = getDb();
    const todayStart = hktTodayStartUtc();

    const byStatus = await db
      .select({
        status: orders.status,
        count: sql<number>`count(*)::int`,
        revenue: sql<number>`coalesce(sum(${orders.total}), 0)::int`,
        todayCount: sql<number>`count(*) filter (where ${orders.createdAt} >= ${todayStart})::int`,
        todayRevenue: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.createdAt} >= ${todayStart}), 0)::int`,
      })
      .from(orders)
      .groupBy(orders.status);

    let totalOrders = 0;
    let totalRevenue = 0;
    let todayOrders = 0;
    let todayRevenue = 0;
    let pendingReview = 0;
    let confirmedCount = 0;
    let cancelledCount = 0;
    let rejectedCount = 0;
    for (const row of byStatus) {
      // 2026-07-30 Glo 規則：待付款（未傳截圖）嘅單唔計入訂單數同營業額
      if (row.status === "pending_payment") continue;
      totalOrders += row.count;
      todayOrders += row.todayCount;
      if (row.status === "cancelled") cancelledCount = row.count;
      else if (row.status === "rejected") rejectedCount = row.count;
      else {
        totalRevenue += row.revenue;
        todayRevenue += row.todayRevenue;
        if (row.status === "payment_review") pendingReview = row.count;
        // approved＝已確認＝終態；legacy shipped/completed 都計埋入已確認
        else if (
          row.status === "approved" ||
          row.status === "shipped" ||
          row.status === "completed"
        )
          confirmedCount += row.count;
      }
    }

    const [{ memberCount }] = await db
      .select({ memberCount: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, "member"));

    const [{ promoUsedCount }] = await db
      .select({
        promoUsedCount: sql<number>`coalesce(sum(${promoCodes.usedCount}), 0)::int`,
      })
      .from(promoCodes);

    return {
      todayOrders,
      todayRevenue,
      totalOrders,
      totalRevenue,
      pendingReview,
      confirmedCount,
      cancelledCount,
      rejectedCount,
      memberCount,
      promoUsedCount,
    };
  }),

  dailySeries: adminProcedure
    .input(
      z
        .object({ days: z.number().int().min(7).max(60).default(14) })
        .optional(),
    )
    .query(async ({ input }) => {
      const days = input?.days ?? 14;
      const db = getDb();
      const todayStart = hktTodayStartUtc();
      const rangeStart = new Date(todayStart.getTime() - (days - 1) * DAY_MS);

      const rows = await db
        .select({ createdAt: orders.createdAt, total: orders.total, status: orders.status })
        .from(orders)
        .where(sql`${orders.createdAt} >= ${rangeStart}`);

      const bucket = new Map<string, { orders: number; revenue: number }>();
      for (let i = days - 1; i >= 0; i--) {
        bucket.set(hktDateString(new Date(todayStart.getTime() - i * DAY_MS)), {
          orders: 0,
          revenue: 0,
        });
      }
      for (const row of rows) {
        if ((DEAD_STATUSES as readonly string[]).includes(row.status)) continue;
        const key = hktDateString(row.createdAt);
        const b = bucket.get(key);
        if (!b) continue; // HKT 換日令個別訂單跌出範圍嘅邊緣情況
        b.orders += 1;
        b.revenue += row.total;
      }
      return [...bucket.entries()].map(([date, b]) => ({
        date,
        orders: b.orders,
        revenue: b.revenue,
      }));
    }),

  // 實際 schema 係 orderItems 表（唔係 orders.items jsonb）——逐 line item 展開統計
  topProducts: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).default(8) })
        .optional(),
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 8;
      const db = getDb();
      return db
        .select({
          productId: orderItems.productId,
          name: orderItems.productName,
          sku: orderItems.sku,
          units: sql<number>`sum(${orderItems.quantity})::int`,
          revenue: sql<number>`sum(${orderItems.quantity} * ${orderItems.price})::int`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(sql`${orders.status} not in ('pending_payment', 'cancelled', 'rejected')`)
        .groupBy(orderItems.productId, orderItems.productName, orderItems.sku)
        .orderBy(desc(sql`sum(${orderItems.quantity})`))
        .limit(limit);
    }),
});
