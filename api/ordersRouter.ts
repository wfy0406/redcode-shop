import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { getDb } from "./queries/connection";
import { cartItems, orders, orderItems, paymentProofs, products, promoCodes, wmsSyncLog } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure } from "./middleware";
import { resolvePromoDiscount } from "./promoRouter";
import { forwardOrderToWms, resetWmsSyncLogForReupload } from "./wmsSync";
import { logAudit } from "./audit";

const orderStatusEnum = z.enum([
  "pending_payment",
  "payment_review",
  "approved",
  "rejected",
  "shipped",
  "completed",
  "cancelled",
]);

// 取貨方式：address＝送到地址（預設）；sf_station＝順豐站自取；sf_locker＝順豐智能櫃自取
const deliveryMethodEnum = z.enum(["address", "sf_station", "sf_locker"]);

function generateOrderNo(): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `RC${ymd}${String(randomInt(0, 10000)).padStart(4, "0")}`;
}

function promoCodeDetail(code: string | undefined): string {
  return code?.trim() ? `（用優惠碼 ${code.trim()}）` : "";
}

/** 商品係咪已（自動）下架：人手下架 isActive=false，或者開咗定時下架兼時間已到 */
function isDelisted(p: {
  isActive: boolean;
  delistEnabled: boolean;
  delistAt: Date | null;
}): boolean {
  if (!p.isActive) return true;
  return p.delistEnabled && p.delistAt !== null && p.delistAt.getTime() <= Date.now();
}

export const ordersRouter = createRouter({
  create: authedProcedure
    .input(
      z
        .object({
          address: z.string().optional(),
          note: z.string().optional(),
          promoCode: z.string().optional(),
          // 順豐站／智能櫃（選填）：揀咗自取先需要填 pickupPoint
          deliveryMethod: deliveryMethodEnum.optional(),
          pickupPoint: z.string().max(255).optional(),
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
      // 下架（人手／定時到咗）嘅貨唔可以落單
      const delisted = cart.find((item) => isDelisted(item.product));
      if (delisted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `《${delisted.product.name}》已經下架，請由購物車移除後再結帳`,
        });
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

      const deliveryMethod = input?.deliveryMethod ?? "address";
      const pickupPoint =
        deliveryMethod === "address" ? null : (input?.pickupPoint?.trim() || null);

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
            deliveryMethod,
            pickupPoint,
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

      const created = await db.query.orders.findFirst({
        where: eq(orders.id, orderId),
        with: { items: true, proofs: true },
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.create",
        targetType: "order",
        targetId: orderNo,
        detail: `落單 ${orderNo}，${cart.length} 件貨，合計 HK$${created?.total ?? 0}${promoCodeDetail(input?.promoCode)}${deliveryMethod !== "address" ? `，自取（${deliveryMethod === "sf_station" ? "順豐站" : "智能櫃"}${pickupPoint ? `：${pickupPoint}` : ""}）` : ""}`,
      });
      return created;
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
      // v1.3 §2.3：客人重傳（之前被 WMS 拒過）→ 必須清走舊 wmsSyncLog，
      // 否則已成功送達嘅件會被 skip，WMS 永遠收唔到重審件
      if (order.status === "rejected") {
        await resetWmsSyncLogForReupload(order.id);
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
      // WMS 同步（唔阻客人回應）：失敗淨係 log + 寫 wmsSyncLog，後台可一掣重試
      void forwardOrderToWms(order.id).catch((e) => console.error("[wms] forward error:", e));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.attachProof",
        targetType: "order",
        targetId: order.orderNo,
        detail: `上傳付款截圖（訂單 ${order.orderNo}）`,
      });
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
      const reviewedOrder = await db.query.orders.findFirst({
        where: eq(orders.id, proof.orderId),
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: input.approve ? "order.approve" : "order.reject",
        targetType: "order",
        targetId: reviewedOrder?.orderNo ?? proof.orderId,
        detail: `${input.approve ? "批准" : "拒絕"}付款截圖（訂單 ${reviewedOrder?.orderNo ?? proof.orderId}）${input.note ? `：${input.note}` : ""}`,
      });
      return db.query.paymentProofs.findFirst({
        where: eq(paymentProofs.id, proof.id),
      });
    }),

  updateStatus: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        // 唔再要出貨步驟：審批完＝已確認（終態）；shipped/completed 只留畀 legacy 數據，唔再接受寫入
        status: z.enum(["cancelled"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        with: { items: true },
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      await db.transaction(async (tx) => {
        await tx
          .update(orders)
          .set({ status: input.status, updatedAt: new Date() })
          .where(eq(orders.id, input.orderId));
        // 取消訂單＝貨唔會出，落單時扣咗嘅庫存要加返（之前已取消嘅唔會重複加）
        if (order.status !== "cancelled") {
          for (const item of order.items) {
            await tx
              .update(products)
              .set({ stock: sql`${products.stock} + ${item.quantity}` })
              .where(eq(products.id, item.productId));
          }
        }
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.cancel",
        targetType: "order",
        targetId: order.orderNo,
        detail: `訂單 ${order.orderNo} 轉做已取消（庫存已加返）`,
      });
      return db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        with: { items: true, proofs: true },
      });
    }),

  /**
   * 完整刪除一張訂單（連截圖記錄／WMS 同步記錄／明細行一齊刪，資料庫唔留痕）。
   * 庫存規則：未收款嘅單（待收款／審核中／被拒）刪除會**加返庫存**（貨根本未出）；
   * 已確認／已取消／出貨類就唔郁庫存（已確認＝已收錢要留貨、已取消嘅喺取消嗰刻已經加返咗，唔好加兩次）。
   * 操作會審計留底（action: order.delete，detail 記低單號＋件數＋金額＋庫存有冇加返）。
   */
  remove: staffProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        with: { items: true },
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      const restoreStock = ["pending_payment", "payment_review", "rejected"].includes(
        order.status,
      );
      await db.transaction(async (tx) => {
        if (restoreStock) {
          for (const item of order.items) {
            await tx
              .update(products)
              .set({ stock: sql`${products.stock} + ${item.quantity}` })
              .where(eq(products.id, item.productId));
          }
        }
        await tx.delete(paymentProofs).where(eq(paymentProofs.orderId, order.id));
        await tx.delete(wmsSyncLog).where(eq(wmsSyncLog.orderId, order.id));
        await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
        await tx.delete(orders).where(eq(orders.id, order.id));
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.delete",
        targetType: "order",
        targetId: order.orderNo,
        detail: `完整刪除訂單 ${order.orderNo}（${order.items.length} 件貨，合計 HK$${order.total}，狀態 ${order.status}）${restoreStock ? "，庫存已加返" : "，庫存不變"}`,
      });
      return { ok: true, restoredStock: restoreStock };
    }),

  /** WMS 同步狀態（後台訂單列表 chip 用）：一單一列，冇列 = 未觸發過同步 */
  wmsSyncStates: staffProcedure.query(async () => {
    const db = getDb();
    return db.query.wmsSyncLog.findMany();
  }),

  /** 手動重試 WMS 同步（已成功嘅件會 skip，WMS 唔會重複出單） */
  resyncWms: staffProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await forwardOrderToWms(input.orderId);
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.resyncWms",
        targetType: "order",
        targetId: input.orderId,
        detail: `手動重試 WMS 同步（${result.status}，${result.okCount}/${result.lineCount} 件成功）`,
      });
      return result;
    }),
});
