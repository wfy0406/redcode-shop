import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { getDb } from "./queries/connection";
import { cartItems, orders, orderItems, paymentProofs, products, promoCodes } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure } from "./middleware";
import { resolvePromoDiscount } from "./promoRouter";

const orderStatusEnum = z.enum([
  "pending_payment",
  "payment_review",
  "approved",
  "rejected",
  "shipped",
  "completed",
  "cancelled",
]);

function generateOrderNo(): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `RC${ymd}${String(randomInt(0, 10000)).padStart(4, "0")}`;
}

export const ordersRouter = createRouter({
  create: authedProcedure
    .input(
      z
        .object({
          address: z.string().optional(),
          note: z.string().optional(),
          promoCode: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const cart = await db.query.cartItems.findMany({
        where: eq(cartItems.userId, ctx.user.userId),
        with: { product: true },
      });
      if (cart.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "購物車係空嘅" });
      }
      const subtotal = cart.reduce(
        (sum, item) =>
          sum + (item.product.discountPrice ?? item.product.price) * item.quantity,
        0,
      );

      // Generate a unique order number (RC + date + random 4 digits)
      let orderNo = generateOrderNo();
      for (let i = 0; i < 10; i++) {
        const dup = await db.query.orders.findFirst({
          where: eq(orders.orderNo, orderNo),
        });
        if (!dup) break;
        orderNo = generateOrderNo();
      }

      // PostgreSQL 支援真 transaction：扣庫存 + 優惠碼 + insert order + items + clear cart 一齊 atomic
      const orderId = await db.transaction(async (tx) => {
        // 每件貨驗庫存 + 扣庫存（conditional update 防超賣）
        for (const item of cart) {
          const deducted = await tx
            .update(products)
            .set({ stock: sql`${products.stock} - ${item.quantity}` })
            .where(
              and(
                eq(products.id, item.productId),
                gte(products.stock, item.quantity),
              ),
            )
            .returning({ id: products.id });
          if (deducted.length === 0) {
            const fresh = await tx.query.products.findFirst({
              where: eq(products.id, item.productId),
            });
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `《${item.product.name}》庫存不足（淨返 ${fresh?.stock ?? 0} 件）`,
            });
          }
        }

        // 優惠碼：server 重算折扣 + usedCount 遞增（同事務）
        let promoCodeValue: string | null = null;
        let discountAmount = 0;
        if (input?.promoCode?.trim()) {
          const resolved = await resolvePromoDiscount(tx, input.promoCode, subtotal);
          promoCodeValue = resolved.promo.code;
          discountAmount = Math.min(resolved.discountAmount, subtotal);
          const bumped = await tx
            .update(promoCodes)
            .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
            .where(
              and(
                eq(promoCodes.id, resolved.promo.id),
                or(
                  isNull(promoCodes.usageLimit),
                  lt(promoCodes.usedCount, promoCodes.usageLimit),
                ),
              ),
            )
            .returning({ id: promoCodes.id });
          if (bumped.length === 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已用完" });
          }
        }
        const total = subtotal - discountAmount;

        const [{ id }] = await tx
          .insert(orders)
          .values({
            orderNo,
            userId: ctx.user.userId,
            status: "pending_payment",
            total,
            address: input?.address ?? null,
            note: input?.note ?? null,
            promoCode: promoCodeValue,
            discountAmount,
          })
          .returning({ id: orders.id });

        await tx.insert(orderItems).values(
          cart.map((item) => ({
            orderId: id,
            productId: item.productId,
            productName: item.product.name,
            sku: item.product.sku,
            size: item.size,
            price: item.product.discountPrice ?? item.product.price,
            quantity: item.quantity,
          })),
        );
        await tx.delete(cartItems).where(eq(cartItems.userId, ctx.user.userId));
        return id;
      });

      return db.query.orders.findFirst({
        where: eq(orders.id, orderId),
        with: { items: true, proofs: true },
      });
    }),

  myOrders: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    return db.query.orders.findMany({
      where: eq(orders.userId, ctx.user.userId),
      with: { items: true, proofs: true },
      orderBy: [desc(orders.createdAt)],
    });
  }),

  myOrderById: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.userId, ctx.user.userId)),
        with: { items: true, proofs: true },
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      return order;
    }),

  attachPaymentProof: authedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        imagePath: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.id, input.orderId), eq(orders.userId, ctx.user.userId)),
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      if (!["pending_payment", "rejected"].includes(order.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "呢張訂單而家唔可以上傳付款證明",
        });
      }
      // 同單未審嘅舊截圖自動作廢，等 staff 淨係見到最新一張
      await db
        .update(paymentProofs)
        .set({
          status: "rejected",
          reviewNote: "已被新截圖取代",
          reviewedAt: new Date(),
        })
        .where(
          and(eq(paymentProofs.orderId, order.id), eq(paymentProofs.status, "pending")),
        );
      const [{ id }] = await db
        .insert(paymentProofs)
        .values({ orderId: order.id, imagePath: input.imagePath, status: "pending" })
        .returning({ id: paymentProofs.id });
      await db
        .update(orders)
        .set({ status: "payment_review", updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      return db.query.paymentProofs.findFirst({
        where: eq(paymentProofs.id, id),
      });
    }),

  adminList: staffProcedure
    .input(z.object({ status: orderStatusEnum.optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      return db.query.orders.findMany({
        where: input?.status ? eq(orders.status, input.status) : undefined,
        with: {
          user: {
            columns: {
              id: true,
              name: true,
              phone: true,
              address: true,
              role: true,
            },
          },
          items: true,
          proofs: true,
        },
        orderBy: [desc(orders.createdAt)],
      });
    }),

  reviewProof: staffProcedure
    .input(
      z.object({
        proofId: z.number().int().positive(),
        approve: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const proof = await db.query.paymentProofs.findFirst({
        where: eq(paymentProofs.id, input.proofId),
      });
      if (!proof) {
        throw new TRPCError({ code: "NOT_FOUND", message: "付款證明不存在" });
      }
      if (proof.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "已經審核過" });
      }
      await db
        .update(paymentProofs)
        .set({
          status: input.approve ? "approved" : "rejected",
          reviewedBy: ctx.user.userId,
          reviewNote: input.note ?? null,
          reviewedAt: new Date(),
        })
        .where(eq(paymentProofs.id, proof.id));
      await db
        .update(orders)
        .set({ status: input.approve ? "approved" : "rejected", updatedAt: new Date() })
        .where(eq(orders.id, proof.orderId));
      return db.query.paymentProofs.findFirst({
        where: eq(paymentProofs.id, proof.id),
      });
    }),

  updateStatus: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        // 新主流程終態係 shipped（進行出貨＝完成）；completed 只留畀 legacy 數據，唔再接受寫入
        status: z.enum(["shipped", "cancelled"]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      await db
        .update(orders)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));
      return db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        with: { items: true, proofs: true },
      });
    }),
});
