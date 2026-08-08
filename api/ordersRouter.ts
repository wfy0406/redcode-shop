import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { getDb } from "./queries/connection";
import { cartItems, orders, orderItems, paymentProofs, products, promoCodes, users, wmsSyncLog } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure } from "./middleware";
import { resolvePromoDiscount } from "./promoRouter";
import { forwardOrderToWms, resetWmsSyncLogForReupload } from "./wmsSync";
import { sendOrderReviewAlertEmail } from "./email";
import { logAudit } from "./audit";
import { sendOrderApprovedEmail, sendOrderPendingEmail } from "./email";

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

/** 取貨方式顯示用 label（審計日誌用）：送貨上門／順豐站自取／順豐智能櫃自取 */
function deliveryLabel(method: string, pickupPoint: string | null): string {
  if (method === "sf_station") return `順豐站自取${pickupPoint ? `：${pickupPoint}` : ""}`;
  if (method === "sf_locker") return `順豐智能櫃自取${pickupPoint ? `：${pickupPoint}` : ""}`;
  return "送貨上門";
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

/**
 * 附付款截圖核心流程（2026-07-30 抽出：客人 attachPaymentProof 同員工 staffAttachProof 共用）：
 *  rejected 單先清舊 wmsSyncLog（唔清嘅話已成功送達嘅件會被 skip，WMS 永遠收唔到重審件）→
 *  同單未審嘅舊截圖自動作廢，等 staff 淨係見到最新一張 →
 *  插入新 pending 截圖 → 訂單轉 payment_review →
 *  背景同步 WMS（唔阻回應；失敗淨係 log + 寫 wmsSyncLog，後台可一掣重試）。
 * 回傳新 proof id。
 */
async function attachProofCore(
  orderId: number,
  orderStatus: string,
  imagePath: string,
): Promise<number> {
  const db = getDb();
  if (orderStatus === "rejected") {
    await resetWmsSyncLogForReupload(orderId);
  }
  await db
    .update(paymentProofs)
    .set({
      status: "rejected",
      reviewNote: "已被新截圖取代",
      reviewedAt: new Date(),
    })
    .where(and(eq(paymentProofs.orderId, orderId), eq(paymentProofs.status, "pending")));
  const [{ id }] = await db
    .insert(paymentProofs)
    .values({ orderId, imagePath, status: "pending" })
    .returning({ id: paymentProofs.id });
  await db
    .update(orders)
    .set({ status: "payment_review", updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  void forwardOrderToWms(orderId).catch((e) => console.error("[wms] forward error:", e));
  // 2026-08-04（Glo 要求）：訂單一轉待審批，即刻背景電郵通知負責人（leader@ows.redcode.red）
  // ——完整客戶資料＋訂單內容；失敗淨係 log，唔阻回應
  void (async () => {
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: { items: true },
    });
    if (!order) return;
    const user = await db.query.users.findFirst({ where: eq(users.id, order.userId) });
    if (!user) return;
    const r = await sendOrderReviewAlertEmail({
      orderNo: order.orderNo,
      createdAt: order.createdAt,
      customerName: user.name,
      customerPhone: user.phone,
      customerEmail: user.email,
      delivery: {
        method: order.deliveryMethod,
        pickupPoint: order.pickupPoint,
        address: order.address,
      },
      note: order.note,
      promoCode: order.promoCode,
      items: order.items.map((it) => ({
        productName: it.productName,
        size: it.size,
        price: it.price,
        quantity: it.quantity,
      })),
      total: order.total,
      discountAmount: order.discountAmount,
    });
    if (!r.ok) console.error(`[email] 待審批通知寄唔出（訂單 ${order.orderNo}）：`, r.error);
  })().catch((e) => console.error("[email] 待審批通知出錯:", e));
  return id;
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
          // 每人限用檢查用：先數呢個帳號之前用過呢個碼幾多次（口徑同 usedCount：計已建立訂單）
          const [{ n: myUses }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(orders)
            .where(
              and(
                eq(orders.promoCode, input.promoCode.toUpperCase().trim()),
                eq(orders.userId, ctx.user.userId),
              ),
            );
          const resolved = await resolvePromoDiscount(tx, input.promoCode, subtotal, myUses);
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
      // 待付款通知 email（2026-08-04）：會員有綁 email 先寄；結果寫埋入日誌 detail，方便後台排查
      let emailNote = "";
      if (created) {
        const member = await db.query.users.findFirst({
          where: eq(users.id, ctx.user.userId),
          columns: { name: true, email: true },
        });
        if (member?.email) {
          const result = await sendOrderPendingEmail({
            to: member.email,
            name: member.name,
            orderNo: created.orderNo,
            total: created.total,
            discountAmount: created.discountAmount,
            createdAt: created.createdAt,
            items: created.items.map((it) => ({
              productName: it.productName,
              size: it.size,
              price: it.price,
              quantity: it.quantity,
            })),
          });
          emailNote = result.ok
            ? `，待付款信已寄出至 ${member.email}`
            : `，待付款信寄出失敗（${result.error ?? "未知原因"}）`;
        } else {
          emailNote = "，會員冇綁 Email，冇寄待付款信";
        }
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.create",
        targetType: "order",
        targetId: orderNo,
        detail: `落單 ${orderNo}，${cart.length} 件貨，合計 HK$${created?.total ?? 0}${promoCodeDetail(input?.promoCode)}${deliveryMethod !== "address" ? `，自取（${deliveryMethod === "sf_station" ? "順豐站" : "智能櫃"}${pickupPoint ? `：${pickupPoint}` : ""}）` : ""}${emailNote}`,
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

  /**
   * 單據（receipt）：前台 /#/receipt/:orderId 用——白紙黑字可列印嘅正式單據。
   * 員工／admin 可以攞任何單；會員只可以攞自己嘅單（唔畀睇人哋嘅單）。
   */
  receipt: authedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
        with: { items: true, user: { columns: { name: true, phone: true } } },
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      const isStaff = ctx.user.role === "staff" || ctx.user.role === "admin";
      if (!isStaff && order.userId !== ctx.user.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "呢張唔係你嘅訂單" });
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
      // 核心流程（rejected 清舊 sync log／作廢舊截圖／插新 proof／轉 payment_review／同步 WMS）同員工版共用
      const id = await attachProofCore(order.id, order.status, input.imagePath);
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

  // 2026-07-30：員工／管理員代客上傳付款截圖（客人唔識傳，WhatsApp 將截圖傳畀員工嘅情況）——
  // 同客人版同一条流程：附截圖 → 訂單轉 payment_review → 背景同步 WMS 等回傳
  staffAttachProof: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        imagePath: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, input.orderId),
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
      const id = await attachProofCore(order.id, order.status, input.imagePath);
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.staffAttachProof",
        targetType: "order",
        targetId: order.orderNo,
        detail: `員工代客上傳付款截圖（訂單 ${order.orderNo}）`,
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
        with: { items: true },
      });
      // 已確認通知 email（2026-08-04 第二版）：批准嗰刻寄出，附訂單單據 HTML 附件；
      // 結果寫埋入日誌 detail（已寄出／寄出失敗／冇綁 Email），等客人話收唔到嗰陣後台即刻查到原因
      let emailNote = "";
      if (input.approve && reviewedOrder) {
        const member = await db.query.users.findFirst({
          where: eq(users.id, reviewedOrder.userId),
          columns: { name: true, email: true, phone: true },
        });
        if (member?.email) {
          const result = await sendOrderApprovedEmail({
            to: member.email,
            name: member.name,
            phone: member.phone,
            orderNo: reviewedOrder.orderNo,
            createdAt: reviewedOrder.createdAt,
            items: reviewedOrder.items.map((it) => ({
              productName: it.productName,
              size: it.size,
              price: it.price,
              quantity: it.quantity,
            })),
            total: reviewedOrder.total,
            discountAmount: reviewedOrder.discountAmount,
            delivery: {
              method: reviewedOrder.deliveryMethod,
              pickupPoint: reviewedOrder.pickupPoint,
              address: reviewedOrder.address,
            },
          });
          emailNote = result.ok
            ? `；確認信＋單據已寄出至 ${member.email}`
            : `；確認信寄出失敗（${result.error ?? "未知原因"}）`;
        } else {
          emailNote = "；會員冇綁 Email，冇寄確認信";
        }
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: input.approve ? "order.approve" : "order.reject",
        targetType: "order",
        targetId: reviewedOrder?.orderNo ?? proof.orderId,
        detail: `${input.approve ? "批准" : "拒絕"}付款截圖（訂單 ${reviewedOrder?.orderNo ?? proof.orderId}）${input.note ? `：${input.note}` : ""}${emailNote}`,
      });
      // 回傳 emailNote 畀後台 toast 直接顯示寄信結果（Glo 唔使再掘日誌先知道寄咗未）
      return { emailNote };
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
   * 後台手動改單：全量替換明細（加/減貨品、改數量）＋ 調折扣／實收金額。
   * 規則：
   * - 淨係未確認嘅單可以改（待收款／審核中／被拒）；已確認＝已收錢、已取消＝完結，唔准改
   * - 庫存按 productId 差額調整：加貨/加量即扣（conditional update 防超賣），減貨/減量/刪行加返
   * - 原本已喺單度嘅行沿用落單價；新加嘅行用而家有效價（discountPrice ?? price）
   * - 折扣同實收二揀一：畀 discountAmount 就 total = subtotal − discount；
   *   畀 total 就 discount = subtotal − total（實收優先；實收唔可以高過貨品合計）
   * - 改動審計留底；如果張單之前已送咗落 WMS，回應會附提示（WMS dedup 會擋重複 sourceRef，
   *   要用「WMS 拒絕重傳 → 客人再上截圖」嘅流程先會帶新資料過去）
   */
  adminUpdate: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              size: z.string().max(64).nullable().optional(),
              quantity: z.number().int().positive().max(999),
            }),
          )
          .min(1, "訂單至少要有一件貨"),
        discountAmount: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        // 2026-08-08（Glo 要求）：後台改單可以順手改 備註／收件地址／取貨方式／優惠碼
        // undefined＝唔郁；null／空字串＝清除。揀送貨上門會自動清 pickupPoint。
        // 優惠碼填新碼：server 驗證（存在/啟用/未過期/夠最低消費/未用完/每人限用，呢張單唔計入已用次數）
        // ＋usedCount+1＋重計折扣——但手動填咗折扣或實收就手動優先，優惠碼只作記錄。
        note: z.string().max(500).nullable().optional(),
        address: z.string().max(500).nullable().optional(),
        deliveryMethod: deliveryMethodEnum.optional(),
        pickupPoint: z.string().max(255).nullable().optional(),
        promoCode: z.string().max(32).nullable().optional(),
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
      // 2026-07-28 放寬：管理員可以直接改已確認／已取消嘅單；只剩已出貨／已完成唔改得
      if (order.status === "shipped" || order.status === "completed") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "已出貨／已完成嘅訂單唔可以再改",
        });
      }
      // 已取消嘅單：取消嗰刻已經加返晒庫存，改單只更新記錄，唔好再郁庫存（否則雙重返倉）
      const skipStock = order.status === "cancelled";
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const productRows = await db
        .select()
        .from(products)
        .where(inArray(products.id, productIds));
      const productMap = new Map(productRows.map((p) => [p.id, p]));
      for (const item of input.items) {
        if (!productMap.has(item.productId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `搵唔到商品 #${item.productId}`,
          });
        }
      }
      // 舊件數按 productId 合計（庫存按商品計，尺寸唔分倉）
      const oldQty = new Map<number, number>();
      for (const i of order.items) {
        oldQty.set(i.productId, (oldQty.get(i.productId) ?? 0) + i.quantity);
      }
      const newQty = new Map<number, number>();
      for (const i of input.items) {
        newQty.set(i.productId, (newQty.get(i.productId) ?? 0) + i.quantity);
      }
      // 價錢：原本喺單度嘅行沿用落單價；新行用而家有效價
      const oldPrice = new Map<string, number>();
      for (const i of order.items) {
        oldPrice.set(`${i.productId}|${i.size ?? ""}`, i.price);
      }
      const newLines = input.items.map((i) => {
        const p = productMap.get(i.productId)!;
        const price =
          oldPrice.get(`${i.productId}|${i.size ?? ""}`) ?? p.discountPrice ?? p.price;
        return {
          productId: i.productId,
          productName: p.name,
          sku: p.sku,
          size: i.size ?? null,
          price,
          quantity: i.quantity,
        };
      });
      const subtotal = newLines.reduce((s, l) => s + l.price * l.quantity, 0);

      // 2026-08-08（Glo 要求）：備註／地址／取貨方式新值（undefined＝跟返舊值）
      const nextNote = input.note === undefined ? order.note : input.note?.trim() || null;
      const nextAddress =
        input.address === undefined ? order.address : input.address?.trim() || null;
      const nextDeliveryMethod = input.deliveryMethod ?? order.deliveryMethod;
      const nextPickupPoint =
        nextDeliveryMethod === "address"
          ? null
          : input.pickupPoint === undefined
            ? order.pickupPoint
            : input.pickupPoint?.trim() || null;
      // 優惠碼有冇改動（唔分大小寫；舊值本身就係大寫儲存；同一個碼唔會重複驗證同扣配額）
      const promoInput = input.promoCode?.trim() || null;
      const promoWantsChange =
        input.promoCode !== undefined &&
        (promoInput ?? "").toUpperCase() !== (order.promoCode ?? "");

      // 實際折扣／實收／最終優惠碼喺 transaction 入面定（優惠碼驗證＋扣配額要用 tx 先夠 atomic）
      let discountAmount = 0;
      let total = 0;
      let nextPromoCode = order.promoCode;
      let promoAutoDiscount = false;

      await db.transaction(async (tx) => {
        if (!skipStock) {
          // 加貨／加量：差額扣庫存（唔夠貨會擋）
          for (const [pid, qty] of newQty) {
            const delta = qty - (oldQty.get(pid) ?? 0);
            if (delta > 0) {
              const deducted = await tx
                .update(products)
                .set({ stock: sql`${products.stock} - ${delta}` })
                .where(and(eq(products.id, pid), gte(products.stock, delta)))
                .returning({ id: products.id });
              if (deducted.length === 0) {
                const p = productMap.get(pid)!;
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `《${p.name}》庫存唔夠加（想加 ${delta} 件，淨返 ${p.stock} 件）`,
                });
              }
            }
          }
          // 減貨／減量／刪行：差額加返
          for (const [pid, qty] of oldQty) {
            const delta = qty - (newQty.get(pid) ?? 0);
            if (delta > 0) {
              await tx
                .update(products)
                .set({ stock: sql`${products.stock} + ${delta}` })
                .where(eq(products.id, pid));
            }
          }
        }
        // 明細全量替換 + 金額更新（同事務，唔會得一半）
        await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
        await tx.insert(orderItems).values(
          newLines.map((l) => ({ orderId: order.id, ...l })),
        );

        // 優惠碼改動（2026-08-08 Glo 要求）：空＝清除；新碼＝驗證＋usedCount+1＋重計折扣
        if (promoWantsChange) {
          if (!promoInput) {
            nextPromoCode = null;
          } else {
            // 每人限用檢查：數呢個帳號嘅其他訂單用過呢個碼幾多次（呢張單唔計）
            const [{ n: myUses }] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(orders)
              .where(
                and(
                  eq(orders.promoCode, promoInput.toUpperCase()),
                  eq(orders.userId, order.userId),
                  ne(orders.id, order.id),
                ),
              );
            const resolved = await resolvePromoDiscount(tx, promoInput, subtotal, myUses);
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
            nextPromoCode = resolved.promo.code;
            // 手動冇填折扣／實收：用優惠碼重計折扣
            if (input.total === undefined && input.discountAmount === undefined) {
              discountAmount = Math.min(resolved.discountAmount, subtotal);
              promoAutoDiscount = true;
            }
          }
        }
        // 折扣／實收：手動優先（實收 > 折扣）；冇手動就 優惠碼重計／清除歸零／跟返舊值
        if (input.total !== undefined) {
          if (input.total > subtotal) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `實收唔可以高過貨品合計 HK$${subtotal}`,
            });
          }
          discountAmount = subtotal - input.total;
        } else if (input.discountAmount !== undefined) {
          discountAmount = Math.min(input.discountAmount, subtotal);
        } else if (promoWantsChange) {
          // 換新碼嘅折扣上面已經 set 咗；清除碼就歸零
          discountAmount = nextPromoCode ? discountAmount : 0;
        } else {
          discountAmount = Math.min(order.discountAmount ?? 0, subtotal);
        }
        total = subtotal - discountAmount;

        await tx
          .update(orders)
          .set({
            discountAmount,
            total,
            note: nextNote,
            address: nextAddress,
            deliveryMethod: nextDeliveryMethod,
            pickupPoint: nextPickupPoint,
            promoCode: nextPromoCode,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));
      });

      const fmtLines = (lines: { productName: string; size: string | null; quantity: number }[]) =>
        lines
          .map((l) => `${l.productName}${l.size ? `-${l.size}` : ""}×${l.quantity}`)
          .join("、");
      const sync = await db.query.wmsSyncLog.findFirst({
        where: eq(wmsSyncLog.orderId, order.id),
      });
      const wmsWarning =
        sync && (sync.status === "sent" || sync.status === "partial")
          ? "呢張單之前已送落 WMS，改動唔會自動更新嗰邊。想 WMS 用新資料重審：叫 WMS 拒絕（重傳）等客人再上傳截圖；或者先同 WMS 講定再重試同步。"
          : null;
      // 備註／地址／取貨方式／優惠碼嘅改動都記落日誌（有改先寫，唔好洗版）
      const fieldChanges: string[] = [];
      if (nextNote !== order.note)
        fieldChanges.push(`備註「${order.note ?? "—"}」→「${nextNote ?? "—"}」`);
      if (nextAddress !== order.address)
        fieldChanges.push(`地址「${order.address ?? "—"}」→「${nextAddress ?? "—"}」`);
      if (
        nextDeliveryMethod !== order.deliveryMethod ||
        nextPickupPoint !== order.pickupPoint
      )
        fieldChanges.push(
          `取貨方式 ${deliveryLabel(order.deliveryMethod, order.pickupPoint)} → ${deliveryLabel(nextDeliveryMethod, nextPickupPoint)}`,
        );
      if (nextPromoCode !== order.promoCode)
        fieldChanges.push(
          `優惠碼 ${order.promoCode ?? "—"} → ${nextPromoCode ?? "—"}${promoAutoDiscount ? "（已按碼重計折扣）" : ""}`,
        );
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.adminUpdate",
        targetType: "order",
        targetId: order.orderNo,
        detail: `後台改單 ${order.orderNo}：貨品「${fmtLines(order.items)}」→「${fmtLines(newLines)}」；折扣 HK$${order.discountAmount} → HK$${discountAmount}；實收 HK$${order.total} → HK$${total}${skipStock ? "（已取消訂單：只更新記錄，庫存無變）" : ""}${fieldChanges.length ? `；${fieldChanges.join("；")}` : ""}`,
      });
      const updated = await db.query.orders.findFirst({
        where: eq(orders.id, order.id),
        with: { items: true, proofs: true },
      });
      return { order: updated, wmsWarning };
    }),

  /**
   * 訂貨統計（採購用）：按 產品×尺寸 聚合「有效訂單」件數，附上架日期同現貨庫存。
   * 有效＝排除 pending_payment／cancelled／rejected（2026-07-30 Glo 規則：未傳截圖嘅待付款單唔計；
   * 被拒單客人重傳截圖通過後會計返）。
   * 上架日期＝products.listedDate（商品管理可填）；產品改過名都唔會拆開兩行（max 攞最新名）。
   * 每個 size 一列；冇尺寸嘅貨 size=null。前台再按 HKT 上架日期分組顯示。
   */
  purchaseStats: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select({
        productId: orderItems.productId,
        name: sql<string>`max(${orderItems.productName})`,
        sku: sql<string>`max(${orderItems.sku})`,
        size: orderItems.size,
        units: sql<number>`sum(${orderItems.quantity})::int`,
        listedDate: products.listedDate,
        stock: products.stock,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(sql`${orders.status} not in ('pending_payment', 'cancelled', 'rejected')`)
      .groupBy(orderItems.productId, orderItems.size, products.listedDate, products.stock)
      .orderBy(desc(products.listedDate), desc(sql`sum(${orderItems.quantity})`));
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
