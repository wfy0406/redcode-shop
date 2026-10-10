import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import { getDb } from "./queries/connection";
import { cartItems, luckyDraws, luckyPrizes, orders, orderItems, orderShipments, paymentProofs, products, promoCodes, sfStations, users, walletLedger, wmsSyncLog } from "@db/schema";
import { createRouter, authedProcedure, publicProcedure, staffProcedure } from "./middleware";
import { resolvePromoDiscount } from "./promoRouter";
import { computeWalletSplit, returnWalletForOrder } from "./wallet";
import { forwardOrderToWms, resetWmsSyncLogForReupload } from "./wmsSync";
import { sendOrderReviewAlertEmail } from "./email";
import { logAudit } from "./audit";
import { sendOrderApprovedEmail, sendOrderPendingEmail, orderVipEmailInfo, sendGuestOrderEmail, siteUrl, sendOrderPaidOnlineEmail } from "./email";
import {
  computeCheckoutQuote,
  getShippingRules,
  normalizeDeliveryMethod,
  normalizeRegion,
  recomputeVipTierInBackground,
} from "./vip";
import { getAirwallexConfig } from "./airwallex";
import {
  GUEST_LOOKUP_FAIL_MESSAGE,
  GUEST_ORDER_TTL_MS,
  RateLimiter,
  clientIpFromRequest,
  decideGuestShipping,
  guestTokenEquals,
  memberPhoneMatches,
  normalizeGuestPhone,
} from "./guestUtils";

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
// v2.1.0（VIP+免運）：API 邊界同時接受契約大寫值（HOME/SF_STATION/SF_LOCKER），入 DB 前正規化
const deliveryMethodEnum = z.enum([
  "address",
  "sf_station",
  "sf_locker",
  "HOME",
  "SF_STATION",
  "SF_LOCKER",
]);

// ===== 訪客購買（Guest Checkout，2026-10-09）rate limit buckets =====
// simple in-memory sliding window（server 重啟清零可接受，契約 v1.0 §1）：
// 落單同一 IP 10 分鐘最多 5 張；查單／token 查同一 IP 每分鐘 10 次。
const guestCreateLimiter = new RateLimiter(5, 10 * 60 * 1000);
const guestLookupLimiter = new RateLimiter(10, 60 * 1000);

/** 查單／付款頁共用嘅訪客單輸出（契約 v1.1 §2/§4）：secondsLeft／canPay 即時重算 */
async function guestOrderPayload(
  order: typeof orders.$inferSelect & {
    items: (typeof orderItems.$inferSelect)[];
    // v2.4.0（Wave 2）：出貨批次（call site 已 with: { shipments: true }）
    shipments?: (typeof orderShipments.$inferSelect)[];
  },
  opts: { includeToken: boolean },
) {
  const nowMs = Date.now();
  const expiresMs = order.expiresAt?.getTime() ?? null;
  const secondsLeft =
    order.status === "pending_payment" && expiresMs !== null
      ? Math.max(0, Math.floor((expiresMs - nowMs) / 1000))
      : 0;
  // canPay 要即時問 Airwallex 配置（設定被閂咗就唔畀付，前端顯示「即時付款維護中」）
  const cfg = await getAirwallexConfig();
  return {
    orderNo: order.orderNo,
    status: order.status,
    total: order.total,
    items: order.items.map((it) => ({
      // v2.4.0（Wave 2）：orderItem id——出貨批次 itemIds 對返邊件貨用
      id: it.id,
      // productId 畀前端「重新落單」重灌購物車用（已逾時態；order-lookup.md §4.2）
      productId: it.productId,
      productName: it.productName,
      size: it.size,
      price: it.price,
      quantity: it.quantity,
      // v2.4.0（Wave 2）：逐件出貨狀態／取消原因／員工更改標示
      shipStatus: it.shipStatus,
      cancelReason: it.cancelReason,
      // v2.5.4：同款多件部分取消 — 已取消件數（0＝冇取消）
      cancelledQty: it.cancelledQty ?? 0,
      staffChangedAt: it.staffChangedAt?.toISOString() ?? null,
      staffChangeNote: it.staffChangeNote,
    })),
    // v2.4.0（Wave 2）：出貨批次（順豐單號／寄出時間／物流方式；已作廢批次唔出）
    shipments: (order.shipments ?? [])
      .filter((s) => s.reversedAt == null)
      .map((s) => ({
        id: s.id,
        shipMethod: s.shipMethod,
        sfNo: s.sfNo,
        itemIds: JSON.parse(s.itemIds) as number[],
        shippedAt: s.shippedAt.toISOString(),
      })),
    deliveryMethod: order.deliveryMethod,
    address: order.address,
    stationName: order.stationName,
    // v2.5.5（老闆指示 msg76c 補窿）：訪客電話跟單返 — 魔法連結路徑（guestByToken）前端冇電話，
    // 唔返嘅話「移入會員訂單」記低嘅 pendingClaim 冇電話，登入返嚟接唔返（老闆實測：Google 登入後變空嘅我的訂單）。
    // 安全性：呢個 payload 本身已經係 token／電話核實過先拎到（地址都照返），電話係客人自己張單嘅資料。
    guestPhone: order.guestPhone ?? null,
    // v2.5.5 第3版（老闆指示 msg85）：訪客查單都要見到退款狀態——同 WMS 退款狀態同步（WMS 退款審批→回調更新），
    // 同會員「我的訂單」嘅 REFUND_BADGES 一套文案。冇退款就 null。
    refundStatus: order.refundStatus ?? null,
    createdAt: order.createdAt.toISOString(),
    expiresAt: order.expiresAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    secondsLeft,
    canPay: order.status === "pending_payment" && secondsLeft > 0 && cfg !== null,
    // guestToken 只喺電話核實通過後（guestLookup）先返；guestByToken 唔返（契約 §4）
    ...(opts.includeToken ? { guestToken: order.guestToken } : {}),
  };
}

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
    // 2026-10-09（訪客購買）：訪客單 userId=NULL——唔好再查 users，用落單快照頂上
    const user = order.userId != null
      ? await db.query.users.findFirst({ where: eq(users.id, order.userId) })
      : null;
    const customerName = user?.name ?? order.guestName;
    const customerPhone = user?.phone ?? order.guestPhone;
    const customerEmail = user?.email ?? order.guestEmail;
    if (!customerName || !customerPhone) return;
    const r = await sendOrderReviewAlertEmail({
      orderNo: order.orderNo,
      createdAt: order.createdAt,
      customerName,
      customerPhone,
      customerEmail,
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
          // v2.1.0（VIP+免運）：新增 region（HK/MO/OVERSEAS，預設跟會員預設地區）＋
          // stationId（對 sfStations.id；server 會攞站名做快照寫落 stationName／pickupPoint）
          deliveryMethod: deliveryMethodEnum.optional(),
          pickupPoint: z.string().max(255).optional(),
          region: z.enum(["HK", "MO", "OVERSEAS", "hk", "mo", "overseas"]).optional(),
          stationId: z.string().trim().max(64).optional(),
          // v2.5.0（購物金）：true＝用購物金抵銷（server 重算，唔信前端金額）；
          // 唔夠俾全單 → 尾數照舊即時付款／上傳截圖；訂單取消購物金自動返還
          useWallet: z.boolean().optional(),
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

      // v2.1.0（VIP+免運）：落單地區預設跟會員預設收件地區（舊會員＝HK）
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
        columns: { defaultRegion: true },
      });
      const region = normalizeRegion(input?.region ?? me?.defaultRegion);

      // v2.1.0：server 重用 checkoutQuote 共用邏輯計最終金額（VIP 折扣→優惠碼→免運判定），
      // 唔准信前端金額；站點 ID 會校驗存在＋active＋同地區匹配
      let quote;
      try {
        quote = await computeCheckoutQuote(ctx.user.userId, {
          region,
          deliveryMethod: input?.deliveryMethod,
          stationId: input?.stationId,
          // 優惠碼喺下面 transaction 入面先真正驗證＋扣配額；呢度唔傳，避免重複解析
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg === "STATION_INVALID") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "站點唔存在或已停用" });
        }
        if (msg === "STATION_REGION_MISMATCH") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "站點同收件地區唔啱，請重新揀過" });
        }
        throw e;
      }

      // Generate a unique order number (RC + date + random 4 digits)
      let orderNo = generateOrderNo();
      for (let i = 0; i < 10; i++) {
        const dup = await db.query.orders.findFirst({
          where: eq(orders.orderNo, orderNo),
        });
        if (!dup) break;
        orderNo = generateOrderNo();
      }

      const deliveryMethod = quote.deliveryMethod;
      // 自取站點：有 stationId 就用站名快照做 pickupPoint（兼容舊嘅顯示／WMS／email 流程）；
      // 冇 stationId 就沿用舊嘅自由文本 pickupPoint
      const pickupPoint =
        deliveryMethod === "address"
          ? null
          : (quote.stationName ?? input?.pickupPoint?.trim() ?? null) || null;

      // PostgreSQL 支援真 transaction：扣庫存 + 優惠碼 + 購物金 + insert order + items + clear cart 一齊 atomic
      const { orderId, walletApplied } = await db.transaction(async (tx) => {
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
        // v2.1.0（VIP+免運）：先 VIP 後優惠碼——優惠碼以 VIP 折後價做基數（疊加，見 api/vip.ts 檔頭）
        const vipDiscountDollars = quote.vipDiscountCents / 100;
        const couponBase = subtotal - vipDiscountDollars;
        let promoCodeValue: string | null = null;
        let couponDiscount = 0;
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
          const resolved = await resolvePromoDiscount(tx, input.promoCode, couponBase, myUses);
          promoCodeValue = resolved.promo.code;
          couponDiscount = Math.min(resolved.discountAmount, couponBase);
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
        // 總折扣＝VIP 折扣＋優惠碼折扣（discountAmount 舊欄係整數港元，兩者加埋寫入）
        const discountAmount = vipDiscountDollars + couponDiscount;
        const total = subtotal - discountAmount;

        // v2.5.0（購物金）：落單即扣（同事務 conditional update 防超扣＋防並發雙使）；
        // 扣完即記流水賬（spend 負數）。cashDue=0 → 唔使再俾錢，下面直接轉待審批。
        let walletApplied = 0;
        let walletBalanceAfter = 0;
        if (input?.useWallet && total > 0) {
          const meWallet = await tx.query.users.findFirst({
            where: eq(users.id, ctx.user.userId),
            columns: { storeCredit: true },
          });
          const { walletApplied: applied } = computeWalletSplit(total, meWallet?.storeCredit ?? 0, true);
          if (applied > 0) {
            const [deducted] = await tx
              .update(users)
              .set({ storeCredit: sql`${users.storeCredit} - ${applied}` })
              .where(and(eq(users.id, ctx.user.userId), gte(users.storeCredit, applied)))
              .returning({ storeCredit: users.storeCredit });
            if (!deducted) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "購物金餘額唔夠，請刷新結帳頁再試",
              });
            }
            walletApplied = applied;
            walletBalanceAfter = deducted.storeCredit;
          }
        }

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
            // v2.1.0（VIP+免運）：地區／站點快照／免運標記／VIP 快照／規則備註（分號分隔）
            region: quote.region,
            stationId: quote.stationId,
            stationName: quote.stationName,
            shippingFree: quote.shippingFree,
            vipTierAtPurchase: quote.vipTier,
            vipDiscountCents: quote.vipDiscountCents,
            remark: quote.remarks.length > 0 ? quote.remarks.join("；") : null,
            // v2.5.0（購物金）：扣咗幾多寫落單（顯示＋取消返還用）
            walletUsed: walletApplied,
          })
          .returning({ id: orders.id });

        // 購物金流水賬（同事務；refId 對返 orderNo）
        if (walletApplied > 0) {
          await tx.insert(walletLedger).values({
            userId: ctx.user.userId,
            type: "spend",
            amount: -walletApplied,
            balanceAfter: walletBalanceAfter,
            refType: "order",
            refId: orderNo,
            note: `訂單 ${orderNo} 使用購物金抵銷`,
          });
        }

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
        return { orderId: id, walletApplied, walletBalanceAfter };
      });

      const created = await db.query.orders.findFirst({
        where: eq(orders.id, orderId),
        with: { items: true, proofs: true },
      });
      // v2.5.0（購物金）：購物金全數支付（cashDue=0）→ 唔使再俾錢，直接轉待審批（同已收款一樣），
      // 背景轉 WMS＋寄「已收款」信＋內部待審批通知。冪等：conditional update 淨郁 pending_payment。
      const cashDue = (created?.total ?? 0) - walletApplied;
      if (created && walletApplied > 0 && cashDue <= 0) {
        const [claimedWallet] = await db
          .update(orders)
          .set({ status: "payment_review", paymentChannel: "wallet", paidAt: new Date(), updatedAt: new Date() })
          .where(and(eq(orders.id, created.id), eq(orders.status, "pending_payment")))
          .returning({ id: orders.id });
        if (claimedWallet) {
          void logAudit({
            actorId: ctx.user.userId,
            actorRole: ctx.user.role,
            action: "order.paidWallet",
            targetType: "order",
            targetId: orderNo,
            detail: `訂單 ${orderNo} 全數以購物金支付（HK$${walletApplied}），轉待審批`,
          });
          void forwardOrderToWms(created.id).catch((e) =>
            console.error(`[wallet] ${orderNo} 轉 WMS 出錯:`, e),
          );
          void (async () => {
            try {
              const member = await db.query.users.findFirst({
                where: eq(users.id, ctx.user.userId),
                columns: { name: true, email: true, phone: true },
              });
              if (!member) return;
              const items = created.items.map((it) => ({
                productName: it.productName,
                size: it.size,
                price: it.price,
                quantity: it.quantity,
              }));
              const delivery = {
                method: created.deliveryMethod,
                pickupPoint: created.pickupPoint,
                address: created.address,
              };
              if (member.email) {
                const r = await sendOrderPaidOnlineEmail({
                  to: member.email,
                  orderNo: created.orderNo,
                  items,
                  total: created.total,
                  delivery,
                  paidAt: new Date(),
                  vip: orderVipEmailInfo(created),
                  walletUsed: walletApplied,
                });
                if (!r.ok) console.error(`[email] 購物金支付通知寄唔出（${orderNo}）：`, r.error);
              }
              const r2 = await sendOrderReviewAlertEmail({
                orderNo: created.orderNo,
                createdAt: created.createdAt,
                customerName: member.name,
                customerPhone: member.phone,
                customerEmail: member.email,
                delivery,
                note: created.note,
                promoCode: created.promoCode,
                items,
                total: created.total,
                discountAmount: created.discountAmount,
              });
              if (!r2.ok) console.error(`[email] 購物金單待審批通知寄唔出（${orderNo}）：`, r2.error);
            } catch (e) {
              console.error("[wallet] 全購物金單寄信出錯:", e);
            }
          })();
          // 回傳俾前端嘅物件同步最新狀態（前端直接跳「已收款待審批」畫面）
          created.status = "payment_review";
          created.paymentChannel = "wallet";
        }
      }
      // 待付款通知 email（2026-08-04）：會員有綁 email 先寄；結果寫埋入日誌 detail，方便後台排查
      // v2.5.0（購物金）：全購物金單已轉待審批（上面寄咗「已收款」信），唔好再寄待付款信
      let emailNote = "";
      if (created && cashDue > 0) {
        const member = await db.query.users.findFirst({
          where: eq(users.id, ctx.user.userId),
          columns: { name: true, email: true },
        });
        if (member?.email) {
          const result = await sendOrderPendingEmail({
            to: member.email,
            name: member.name,
            orderNo: created.orderNo,
            orderId: created.id,
            total: created.total,
            discountAmount: created.discountAmount,
            createdAt: created.createdAt,
            // v2.1.1（Wave 2）：單據顯示 VIP 級別＋VIP 折扣行
            vip: orderVipEmailInfo(created),
            // v2.5.0（購物金）：用咗購物金就喺信入面列明扣減＋尾數
            walletUsed: walletApplied > 0 ? walletApplied : undefined,
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
        detail: `落單 ${orderNo}，${cart.length} 件貨，合計 HK$${created?.total ?? 0}${walletApplied > 0 ? `，購物金扣減 HK$${walletApplied}（尾數 HK$${Math.max(0, cashDue)}）` : ""}${promoCodeDetail(input?.promoCode)}${quote.vipDiscountCents > 0 ? `，VIP${quote.vipTier === "GOLD" ? "金" : "銀"}會員折 HK$${quote.vipDiscountCents / 100}` : ""}${quote.shippingFree ? "，免運" : ""}${region !== "HK" ? `，${region === "MO" ? "澳門" : "國外"}單` : ""}${deliveryMethod !== "address" ? `，自取（${deliveryMethod === "sf_station" ? "順豐站" : "智能櫃"}${pickupPoint ? `：${pickupPoint}` : ""}）` : ""}${emailNote}`,
      });
      return created;
    }),

  /**
   * 訪客落單（2026-10-09 訪客購買 Guest Checkout，契約 v1.0 §1）：
   * 唔使登入；**只限 Airwallex 即時付款**（未配置＝唔開得單，唔准手動上傳單據）。
   * server 重算金額（唔准信前端）：冇 VIP、冇優惠碼、region 固定 HK；
   * 免運只有「滿額＋自取點」一條路（decideGuestShipping，同 vip.ts 檔頭規則嘅訪客子集）。
   * 落單即扣庫存（transaction＋conditional update 防超賣），30 分鐘未付 orderSweeper 自動取消＋回庫存。
   */
  createGuest: publicProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              productId: z.number().int().positive(),
              size: z.string().max(64).optional(),
              quantity: z.number().int().positive().max(99),
            }),
          )
          .min(1, "至少要揀一件貨")
          .max(20, "一張單最多 20 項貨品"),
        name: z.string().trim().min(1, "請填客戶名").max(64),
        phone: z.string().min(1, "請填電話").max(32),
        email: z.email("Email 格式唔啱").max(255),
        deliveryMethod: z.enum(["address", "sf_station", "sf_locker"]),
        address: z.string().max(500).optional(),
        stationId: z.string().trim().max(64).optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // ① 落單 rate limit：同一 IP 10 分鐘最多 5 張訪客單
      if (!guestCreateLimiter.allow(clientIpFromRequest(ctx.req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "落單太頻密，請幾分鐘後再試",
        });
      }
      // ② 訪客單只收即時付款：Airwallex 未配置就唔開得單（唔准落手動單）
      const cfg = await getAirwallexConfig();
      if (!cfg) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "即時付款暫時未能使用，請稍後再試",
        });
      }
      // ③ 電話 normalize（純 8 位）；格式唔啱即擋
      const phone = normalizeGuestPhone(input.phone);
      if (!phone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "電話號碼格式唔啱（請輸入香港 8 位數字電話）",
        });
      }
      const email = input.email.trim().toLowerCase();
      const db = getDb();

      // ④ 取貨方式校驗：上門要地址；自取要有效站點（存在＋active＋HK 區）
      const deliveryMethod = input.deliveryMethod;
      let address: string | null = null;
      let stationId: string | null = null;
      let stationName: string | null = null;
      if (deliveryMethod === "address") {
        address = input.address?.trim() || null;
        if (!address) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "送貨上門要填收貨地址" });
        }
      } else {
        if (!input.stationId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "請揀自取站點" });
        }
        const station = await db.query.sfStations.findFirst({
          where: eq(sfStations.id, input.stationId),
        });
        if (!station || !station.active) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "站點唔存在或已停用" });
        }
        if (station.region !== "HK") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "站點同收件地區唔啱，請重新揀過" });
        }
        stationId = station.id;
        stationName = station.name;
      }

      // ⑤ 商品校驗＋server 重算小計（整數港元，同會員單口徑）
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const productRows = await db.select().from(products).where(inArray(products.id, productIds));
      const productMap = new Map(productRows.map((p) => [p.id, p]));
      for (const item of input.items) {
        const p = productMap.get(item.productId);
        if (!p) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `搵唔到商品 #${item.productId}` });
        }
        if (isDelisted(p)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `《${p.name}》已經下架，請移除後再結帳`,
          });
        }
      }
      const subtotal = input.items.reduce(
        (sum, item) =>
          sum + (productMap.get(item.productId)!.discountPrice ?? productMap.get(item.productId)!.price) * item.quantity,
        0,
      );

      // ⑥ 免運判定（訪客：冇 VIP；只有滿額＋自取點先免運，上門永遠到付）
      const rules = await getShippingRules();
      const shipping = decideGuestShipping(rules, deliveryMethod, subtotal * 100);

      // ⑦ 單號（RC+日期+4 位隨機，撞號重生）＋ 30 分鐘付款死線 ＋ 查單 token
      let orderNo = generateOrderNo();
      for (let i = 0; i < 10; i++) {
        const dup = await db.query.orders.findFirst({ where: eq(orders.orderNo, orderNo) });
        if (!dup) break;
        orderNo = generateOrderNo();
      }
      const guestToken = randomUUID();
      const expiresAt = new Date(Date.now() + GUEST_ORDER_TTL_MS);

      // ⑧ transaction：逐項 conditional 扣庫存（防超賣）＋insert order＋items
      const orderId = await db.transaction(async (tx) => {
        for (const item of input.items) {
          const deducted = await tx
            .update(products)
            .set({ stock: sql`${products.stock} - ${item.quantity}` })
            .where(and(eq(products.id, item.productId), gte(products.stock, item.quantity)))
            .returning({ id: products.id });
          if (deducted.length === 0) {
            const p = productMap.get(item.productId)!;
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `《${p.name}》庫存不足（淨返 ${p.stock} 件）`,
            });
          }
        }
        const [{ id }] = await tx
          .insert(orders)
          .values({
            orderNo,
            // 訪客單：userId=NULL，客戶資料落快照欄；paymentChannel 鎖死 airwallex
            userId: null,
            status: "pending_payment",
            total: subtotal,
            address,
            note: input.note?.trim() || null,
            promoCode: null,
            discountAmount: 0,
            deliveryMethod,
            pickupPoint: stationName,
            region: "HK",
            stationId,
            stationName,
            shippingFree: shipping.shippingFree,
            vipTierAtPurchase: null,
            vipDiscountCents: 0,
            remark: shipping.remarks.length > 0 ? shipping.remarks.join("；") : null,
            paymentChannel: "airwallex",
            guestName: input.name,
            guestPhone: phone,
            guestEmail: email,
            guestToken,
            expiresAt,
          })
          .returning({ id: orders.id });
        await tx.insert(orderItems).values(
          input.items.map((item) => {
            const p = productMap.get(item.productId)!;
            return {
              orderId: id,
              productId: item.productId,
              productName: p.name,
              sku: p.sku,
              size: item.size ?? null,
              price: p.discountPrice ?? p.price,
              quantity: item.quantity,
            };
          }),
        );
        return id;
      });

      // ⑨ 訪客確認信（never-throw）：呢封信係訪客嘅命根——魔法連結直達付款頁；
      // 寄失敗唔阻落單，結果寫入 audit detail 方便後台排查
      const createdAt = new Date();
      const magicUrl = `${siteUrl()}/#/guest-payment?orderNo=${orderNo}&token=${guestToken}`;
      const emailResult = await sendGuestOrderEmail({
        to: email,
        name: input.name,
        orderNo,
        total: subtotal,
        createdAt,
        expiresAt,
        items: input.items.map((item) => {
          const p = productMap.get(item.productId)!;
          return {
            productName: p.name,
            size: item.size ?? null,
            price: p.discountPrice ?? p.price,
            quantity: item.quantity,
          };
        }),
        magicUrl,
      });
      const emailNote = emailResult.ok
        ? `，確認信已寄出至 ${email}`
        : `，確認信寄出失敗（${emailResult.error ?? "未知原因"}）`;

      // ⑩ 審計留底（**唔准寫 guestToken**——token 只經回應＋email 魔法連結送出）
      void logAudit({
        actorId: null,
        actorRole: "guest",
        actorNameFallback: `訪客 ${input.name}`,
        action: "order.createGuest",
        targetType: "order",
        targetId: orderNo,
        detail: `訪客落單 ${orderNo}，${input.items.length} 項貨，合計 HK$${subtotal}，${deliveryLabel(deliveryMethod, stationName)}${shipping.shippingFree ? "，免運" : ""}，30 分鐘付款保留（${expiresAt.toISOString()} 前）${emailNote}`,
      });

      return {
        orderId,
        orderNo,
        guestToken,
        total: subtotal,
        expiresAt: expiresAt.toISOString(),
      };
    }),

  /**
   * 查單（契約 v1.0 §2，2026-10-09 擴展到會員單）：雙因子＝訂單編號＋落單電話
   * （orderNo 只有 4 位隨機，唔可以齋單號查）。訪客單同會員單都搵到：
   *  - 訪客單（userId 空）：對 guestPhone，核實後返完整 payload ＋ guestToken（畀前端即刻去開付款）
   *  - 會員單：對會員帳號電話（8 位／852 變體都接受），核實後只返基本資料
   *    （kind: 'member'，冇 items 冇 token）——詳情要登入會員先睇到，順勢引導登入
   * 唔中 → 統一 NOT_FOUND 訊息（唔好分開話邊樣錯、唔好話係咪會員單，防單號枚舉偷睇）。
   */
  guestLookup: publicProcedure
    .input(z.object({ orderNo: z.string().trim().min(1).max(32), phone: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      if (!guestLookupLimiter.allow(clientIpFromRequest(ctx.req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "查詢太頻密，請一分鐘後再試",
        });
      }
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.orderNo, input.orderNo),
        // v2.4.0（Wave 2）：訪客查單都睇到出貨批次／逐件狀態
        with: { items: true, user: { columns: { phone: true } }, shipments: true },
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
      }
      // 會員單：核實帳號電話，只返基本資料（引導登入睇詳情）
      if (order.userId != null) {
        if (!memberPhoneMatches(order.user?.phone, input.phone)) {
          throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
        }
        return {
          kind: "member" as const,
          orderNo: order.orderNo,
          status: order.status,
          createdAt: order.createdAt.toISOString(),
        };
      }
      // 訪客單：核實落單電話，返完整 payload
      const phone = normalizeGuestPhone(input.phone);
      if (!phone || order.guestPhone !== phone) {
        throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
      }
      // v2.5.4 hotfix（老闆指示 msg72 黑屏）：guestOrderPayload 係 async——
      // 唔 await 就 spread 會得返 { kind:"guest" } 空殼（Promise 冇可列舉屬性），
      // 前端 items undefined → order.items.map 直接炸 → 成頁黑屏。一定要 await。
      return { kind: "guest" as const, ...(await guestOrderPayload(order, { includeToken: true })) };
    }),

  /**
   * 訪客付款／狀態頁查單（契約 v1.1 §4）：憑 email 魔法連結／落單回應嘅 guestToken 查。
   * token 用 constant-time 比對（防時序旁路）；唔中 → 同一 NOT_FOUND 訊息。
   */
  guestByToken: publicProcedure
    .input(z.object({ orderNo: z.string().trim().min(1).max(32), token: z.string().trim().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      if (!guestLookupLimiter.allow(clientIpFromRequest(ctx.req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "查詢太頻密，請一分鐘後再試",
        });
      }
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.orderNo, input.orderNo), isNull(orders.userId)),
        with: { items: true, shipments: true },
      });
      if (!order || !guestTokenEquals(order.guestToken ?? "", input.token)) {
        throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
      }
      return guestOrderPayload(order, { includeToken: false });
    }),

  /**
   * 訪客單移入會員旗下（2026-10-09 查單擴展）：
   * 會員登入後憑 orderNo＋guestToken（查單／魔法連結已核實過嘅能力憑證）認領訪客單。
   * 只改 userId——寄送方式、地址、站點、金額全部照舊（用戶明確要求：按原有方式寄送）。
   * 已綁其他帳號 → CONFLICT；已綁自己 → already:true（idempotent）；token 唔中 → 統一 NOT_FOUND。
   * guestToken 永遠唔落 audit detail（安全規則）。
   */
  claimGuestOrder: authedProcedure
    .input(z.object({ orderNo: z.string().trim().min(1).max(32), guestToken: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.orderNo, input.orderNo),
      });
      if (!order || !guestTokenEquals(order.guestToken ?? "", input.guestToken)) {
        throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
      }
      if (order.userId === ctx.user.userId) {
        // v2.5.5（老闆指示 msg79e）：已綁自己都要補計 VIP — 移入嘅訪客單要計入年度消費同會員級別
        recomputeVipTierInBackground(ctx.user.userId, order.orderNo);
        return { ok: true as const, already: true };
      }
      if (order.userId != null) {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已經綁定咗另一個帳號" });
      }
      // 條件式 update 防 race：兩個帳號同時認領，只得一個成功
      const claimed = await db
        .update(orders)
        .set({ userId: ctx.user.userId })
        .where(and(eq(orders.id, order.id), isNull(orders.userId)))
        .returning({ id: orders.id });
      if (claimed.length === 0) {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已經綁定咗另一個帳號" });
      }
      // v2.5.5（老闆指示 msg79e「移入會員記得要計翻個消費金額，係計vip幾級」）：
      // 認領成功即重算年度消費＋VIP 級別（背景跑，唔阻回應；升級會寄信＋同步 WMS）
      recomputeVipTierInBackground(ctx.user.userId, order.orderNo);
      const member = await db.query.users.findFirst({
        where: eq(users.id, ctx.user.userId),
        columns: { name: true },
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.claim_guest",
        targetType: "order",
        targetId: order.orderNo,
        detail: `會員「${member?.name ?? ctx.user.userId}」將訪客訂單 ${order.orderNo} 移入旗下（寄送方式同地址照舊）`,
      });
      return { ok: true as const, already: false };
    }),

  myOrders: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db.query.orders.findMany({
      where: eq(orders.userId, ctx.user.userId),
      // v2.4.0（Wave 2）：連出貨批次一齊返（訂單卡顯示順豐單號／追蹤連結／寄出時間）
      with: { items: true, proofs: true, shipments: true },
      orderBy: [desc(orders.createdAt)],
    });
    // v2.2.46（直播抽獎）：中獎訂單掛返獎品資料出嚟，我的訂單會顯示「中獎框」
    const orderIds = rows.map((o) => o.id);
    const prizeMap = new Map<number, { name: string | null; imagePath: string | null; drawDate: string | null }>();
    if (orderIds.length > 0) {
      const wins = await db
        .select({
          orderId: luckyDraws.orderId,
          name: luckyPrizes.name,
          imagePath: luckyPrizes.imagePath,
          drawDate: luckyDraws.drawDate,
        })
        .from(luckyDraws)
        .innerJoin(luckyPrizes, eq(luckyDraws.prizeId, luckyPrizes.id))
        .where(and(inArray(luckyDraws.orderId, orderIds), eq(luckyDraws.status, "confirmed")));
      for (const w of wins) {
        if (w.orderId != null) prizeMap.set(w.orderId, { name: w.name, imagePath: w.imagePath, drawDate: w.drawDate });
      }
    }
    return rows.map((o) => ({ ...o, prize: prizeMap.get(o.id) ?? null }));
  }),

  myOrderById: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.id, input.id), eq(orders.userId, ctx.user.userId)),
        // v2.4.0（Wave 2）：連出貨批次一齊返
        with: { items: true, proofs: true, shipments: true },
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
        // v2.4.0（Wave 2）：單據都顯示出貨批次（順豐單號／寄出時間）
        with: { items: true, user: { columns: { name: true, phone: true } }, shipments: true },
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
          // v2.4.0（Wave 2）：後台訂單管理顯示出貨批次同逐件狀態
          shipments: true,
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
      // v2.1.0（VIP+免運）：訂單一確認收款，背景重算會員 VIP 級別（本年度已付款消費達標即升級）
      // 2026-10-09（訪客購買）：訪客單 userId=NULL，冇 VIP 體系，唔使重算
      if (input.approve && reviewedOrder && reviewedOrder.userId != null) {
        recomputeVipTierInBackground(reviewedOrder.userId, reviewedOrder.orderNo);
      }
      // 已確認通知 email（2026-08-04 第二版）：批准嗰刻寄出，附訂單單據 HTML 附件；
      // 結果寫埋入日誌 detail（已寄出／寄出失敗／冇綁 Email），等客人話收唔到嗰陣後台即刻查到原因
      let emailNote = "";
      if (input.approve && reviewedOrder) {
        // 2026-10-09（訪客購買）：訪客單用落單快照（name/phone/email）；員工代傳截圖嘅訪客單都行到呢度
        const member = reviewedOrder.userId != null
          ? await db.query.users.findFirst({
              where: eq(users.id, reviewedOrder.userId),
              columns: { name: true, email: true, phone: true },
            })
          : null;
        const recipient = member?.email ?? reviewedOrder.guestEmail;
        const recipientName = member?.name ?? reviewedOrder.guestName;
        const recipientPhone = member?.phone ?? reviewedOrder.guestPhone;
        if (recipient && recipientName) {
          const result = await sendOrderApprovedEmail({
            to: recipient,
            name: recipientName,
            phone: recipientPhone ?? "",
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
            vip: orderVipEmailInfo(reviewedOrder),
            delivery: {
              method: reviewedOrder.deliveryMethod,
              pickupPoint: reviewedOrder.pickupPoint,
              address: reviewedOrder.address,
            },
          });
          emailNote = result.ok
            ? `；確認信＋單據已寄出至 ${recipient}`
            : `；確認信寄出失敗（${result.error ?? "未知原因"}）`;
        } else {
          emailNote = "；客戶冇 Email，冇寄確認信";
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

  // 2026-09-29（Glo 指示）：Airwallex 網上已收款嘅訂單冇付款截圖，
  // 待審批工作枱一樣要見到兼可以一掣批准；批准＝確認款項無誤，訂單轉已確認＋寄確認信。
  // （拒絕／退款唔喺度做——錢已經收咗，要退嘅話去 WMS 官網中心申請退款，原路退回。）
  reviewOnlinePayment: staffProcedure
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
      if (order.paymentChannel !== "airwallex") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢張唔係網上付款訂單" });
      }
      // 冪等轉態：只有第一個將 payment_review 轉走嘅請求生效（防兩個員工同時撳批准）
      const claimed = await db
        .update(orders)
        .set({ status: "approved", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "payment_review")))
        .returning({ id: orders.id });
      if (claimed.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "訂單已經處理咗" });
      }
      // v2.1.0（VIP+免運）：確認收款後背景重算 VIP 級別
      // 2026-10-09（訪客購買）：訪客網上付款單都行呢條路——userId=NULL 冇 VIP，唔使重算
      if (order.userId != null) {
        recomputeVipTierInBackground(order.userId, order.orderNo);
      }
      // 已確認通知 email：同截圖批准一致，批准嗰刻寄出，附訂單單據 HTML 附件
      // 2026-10-09（訪客購買）：訪客單用落單快照做收件人
      let emailNote = "";
      const member = order.userId != null
        ? await db.query.users.findFirst({
            where: eq(users.id, order.userId),
            columns: { name: true, email: true, phone: true },
          })
        : null;
      const recipient = member?.email ?? order.guestEmail;
      const recipientName = member?.name ?? order.guestName;
      const recipientPhone = member?.phone ?? order.guestPhone;
      if (recipient && recipientName) {
        const result = await sendOrderApprovedEmail({
          to: recipient,
          name: recipientName,
          phone: recipientPhone ?? "",
          orderNo: order.orderNo,
          createdAt: order.createdAt,
          items: order.items.map((it) => ({
            productName: it.productName,
            size: it.size,
            price: it.price,
            quantity: it.quantity,
          })),
          total: order.total,
          discountAmount: order.discountAmount,
          vip: orderVipEmailInfo(order),
          delivery: {
            method: order.deliveryMethod,
            pickupPoint: order.pickupPoint,
            address: order.address,
          },
        });
        emailNote = result.ok
          ? `；確認信＋單據已寄出至 ${recipient}`
          : `；確認信寄出失敗（${result.error ?? "未知原因"}）`;
      } else {
        emailNote = "；客戶冇 Email，冇寄確認信";
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.approve",
        targetType: "order",
        targetId: order.orderNo,
        detail: `批准網上付款訂單（訂單 ${order.orderNo}，Airwallex 已收款）${emailNote}`,
      });
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
      let walletReturned = 0;
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
        // v2.5.0（購物金）：取消即返還用咗嘅購物金（walletReturnedAt 冪等鎖，唔會返兩次）
        walletReturned = await returnWalletForOrder(tx, order, "訂單取消返還（後台人手取消）");
      });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "order.cancel",
        targetType: "order",
        targetId: order.orderNo,
        detail: `訂單 ${order.orderNo} 轉做已取消（庫存已加返）${walletReturned > 0 ? `，購物金 HK$${walletReturned} 已返還` : ""}`,
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
      // v2.1.0：API 接受契約大寫值（HOME/SF_STATION/SF_LOCKER），入 DB 前正規化返舊值
      const nextDeliveryMethod = input.deliveryMethod
        ? normalizeDeliveryMethod(input.deliveryMethod)
        : (order.deliveryMethod as "address" | "sf_station" | "sf_locker");
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
            // 2026-10-09（訪客購買）：訪客單 userId=NULL——優惠碼係會員體系，直接當 0 次
            const [{ n: myUses }] = order.userId != null
              ? await tx
                  .select({ n: sql<number>`count(*)::int` })
                  .from(orders)
                  .where(
                    and(
                      eq(orders.promoCode, promoInput.toUpperCase()),
                      eq(orders.userId, order.userId),
                      ne(orders.id, order.id),
                    ),
                  )
              : [{ n: 0 }];
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
      // v2.2.55：中獎訂單連抽獎紀錄一齊刪（見交易入面註解）— 計數畀 audit 用
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
        // v2.2.55（老闆指令「刪除咗中獎紀錄都要刪除」）：中獎訂單嘅抽獎紀錄一併硬刪——
        // luckyDraws.orderId 有 FK 指住 orders（冇 cascade），唔刪佢先張單會 23503 刪唔到；
        // 刪咗紀錄件獎品自然返返入池（takenCount 只計 pending/confirmed）
        const delDraws = await tx.delete(luckyDraws).where(eq(luckyDraws.orderId, order.id)).returning({ id: luckyDraws.id });
        drawRowsDeleted = delDraws.length;
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
        detail: `完整刪除訂單 ${order.orderNo}（${order.items.length} 件貨，合計 HK$${order.total}，狀態 ${order.status}）${restoreStock ? "，庫存已加返" : "，庫存不變"}${drawRowsDeleted > 0 ? `，中獎紀錄一併刪咗 ${drawRowsDeleted} 筆` : ""}`,
      });
      return { ok: true, restoredStock: restoreStock, drawsDeleted: drawRowsDeleted };
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
