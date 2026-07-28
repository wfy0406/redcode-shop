import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, orderItems, orders, paymentProofs, users, wmsSyncLog } from "@db/schema";
import { createRouter, adminProcedure } from "./middleware";
import { logAudit } from "./audit";

/**
 * 會員列表 —— admin only
 * totalSpent 排除 cancelled/rejected；按註冊時間 createdAt desc
 * remove：刪除會員；有訂單嘅會員要 alsoDeleteOrders=true 先刪得（連訂單一併刪，唔可以復原）
 */
export const membersRouter = createRouter({
  // 2026-07-28：加搜尋（q＝名或電話模糊對照）＋地址欄
  list: adminProcedure
    .input(z.object({ q: z.string().trim().max(100).optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const q = input?.q?.trim();
      // 用家輸入嘅 % / _ / \ 先 escape，唔畀佢哋變通配符
      const term = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      return db
        .select({
          id: users.id,
          name: users.name,
          phone: users.phone,
          email: users.email,
          address: users.address,
          createdAt: users.createdAt,
          orderCount: sql<number>`count(${orders.id})::int`,
          totalSpent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'rejected')), 0)::int`,
        })
        .from(users)
        .leftJoin(orders, eq(orders.userId, users.id))
        .where(
          term
            ? and(
                eq(users.role, "member"),
                sql`(${users.name} ilike ${term} escape '\\' or ${users.phone} ilike ${term} escape '\\')`,
              )
            : eq(users.role, "member"),
        )
        .groupBy(users.id)
        .orderBy(desc(users.createdAt));
    }),

  /**
   * 會員詳情（前台撳行彈出）：基本資料（唔回 passwordHash）＋訂單統計＋最近 10 張訂單
   */
  detail: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [user] = await db
        .select({
          id: users.id,
          name: users.name,
          phone: users.phone,
          email: users.email,
          address: users.address,
          age: users.age,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!user || user.role !== "member") {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      const [stats] = await db
        .select({
          orderCount: sql<number>`count(${orders.id})::int`,
          totalSpent: sql<number>`coalesce(sum(${orders.total}) filter (where ${orders.status} not in ('cancelled', 'rejected')), 0)::int`,
        })
        .from(orders)
        .where(eq(orders.userId, input.id));
      const recentOrders = await db
        .select({
          id: orders.id,
          orderNo: orders.orderNo,
          status: orders.status,
          total: orders.total,
          deliveryMethod: orders.deliveryMethod,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.userId, input.id))
        .orderBy(desc(orders.createdAt))
        .limit(10);
      return {
        user,
        orderCount: stats.orderCount,
        totalSpent: stats.totalSpent,
        recentOrders,
      };
    }),

  remove: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        // 會員有訂單時，必須明確授權先可以連訂單一併刪除（預設擋住，保住營業數據）
        alsoDeleteOrders: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      if (input.id === ctx.user.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "唔可以刪除自己嘅帳號" });
      }
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號唔可以喺會員管理刪除" });
      }
      const orderRows = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.userId, input.id));
      if (orderRows.length > 0 && !input.alsoDeleteOrders) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `「${target.name}」有 ${orderRows.length} 張訂單，刪除會連埋訂單一齊冇晒，請確認先好再撳`,
        });
      }
      if (orderRows.length > 0) {
        // 先刪晒啲 child rows（FK 冇 cascade），順序：同步記錄 → 截圖 → 明細 → 訂單
        const ids = orderRows.map((r) => r.id);
        await db.delete(wmsSyncLog).where(inArray(wmsSyncLog.orderId, ids));
        await db.delete(paymentProofs).where(inArray(paymentProofs.orderId, ids));
        await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
        await db.delete(orders).where(eq(orders.userId, input.id));
      }
      await db.delete(cartItems).where(eq(cartItems.userId, input.id));
      await db.delete(users).where(eq(users.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.remove",
        targetType: "member",
        targetId: input.id,
        detail: `刪除會員「${target.name}」${orderRows.length > 0 ? `（連埋 ${orderRows.length} 張訂單）` : ""}`,
      });
      return { ok: true, id: input.id, deletedOrders: orderRows.length };
    }),
});
