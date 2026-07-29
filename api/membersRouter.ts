import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, orderItems, orders, paymentProofs, users, wmsSyncLog } from "@db/schema";
import { createRouter, adminProcedure, staffProcedure } from "./middleware";
import { logAudit } from "./audit";

/**
 * 會員列表 —— staff（員工）＋ admin 可用（2026-07-29 起：員工都可以睇同改會員資料）
 * totalSpent 排除 cancelled/rejected；按註冊時間 createdAt desc
 * update：修改會員基本資料（名/電話/email/地址/年齡/生日月份），電話撞號會 CONFLICT
 * remove：刪除會員（仍係 admin only）；有訂單嘅會員要 alsoDeleteOrders=true 先刪得（連訂單一併刪，唔可以復原）
 */
export const membersRouter = createRouter({
  // 2026-07-28：加搜尋（q＝名或電話模糊對照）＋地址欄
  list: staffProcedure
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
  detail: staffProcedure
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
          birthMonth: users.birthMonth,
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

  /**
   * 修改會員資料（員工＋管理員，2026-07-29）：名/電話/email/地址/年齡/生日月份
   * 淨係改有傳嘅欄；email/地址/年齡/生日月份傳 null＝清空；電話撞咗人哋嘅號會 CONFLICT
   */
  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1, "名稱必填").max(255).optional(),
        phone: z
          .string()
          .trim()
          .min(8, "電話至少 8 位")
          .max(32)
          .regex(/^[0-9+\-\s]+$/, "電話格式唔啱")
          .optional(),
        email: z.string().trim().email("Email 格式唔啱").max(255).nullable().optional(),
        address: z.string().nullable().optional(),
        age: z.number().int().min(0).max(150).nullable().optional(),
        birthMonth: z.number().int().min(1).max(12).nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [target] = await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, input.id))
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      }
      if (target.role !== "member") {
        throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號請去「員工帳號」頁修改" });
      }
      if (input.phone) {
        const dup = await db.query.users.findFirst({ where: eq(users.phone, input.phone) });
        if (dup && dup.id !== input.id) {
          throw new TRPCError({ code: "CONFLICT", message: "呢個電話號碼已經註冊咗" });
        }
      }
      const data: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.phone !== undefined) data.phone = input.phone;
      if (input.email !== undefined) data.email = input.email;
      if (input.address !== undefined) data.address = input.address;
      if (input.age !== undefined) data.age = input.age;
      if (input.birthMonth !== undefined) data.birthMonth = input.birthMonth;
      if (Object.keys(data).length > 0) {
        await db.update(users).set(data).where(eq(users.id, input.id));
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "member.update",
        targetType: "member",
        targetId: input.id,
        detail: `修改會員「${input.name ?? target.name}」資料（${Object.keys(data).join("、") || "冇改動"}）`,
      });
      return { ok: true };
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
