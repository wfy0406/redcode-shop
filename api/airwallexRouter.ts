import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders } from "@db/schema";
import { createRouter, authedProcedure, publicProcedure } from "./middleware";
import { createHostedPayment, getAirwallexConfig } from "./airwallex";
import {
  GUEST_LOOKUP_FAIL_MESSAGE,
  RateLimiter,
  clientIpFromRequest,
  guestTokenEquals,
} from "./guestUtils";

// 訪客開付款 rate limit（2026-10-09）：同一 IP 每分鐘 10 次（同查單共用一個寬鬆口徑）
const guestPaymentLimiter = new RateLimiter(10, 60 * 1000);

/**
 * Airwallex 網上付款 tRPC（2026-09 F5；2026-09-29 hotfix 改官方 SDK 契約）：
 * trpc.airwallex.createPayment.useMutation({ orderId })
 *   成功回傳 { enabled: true, intentId, clientSecret, env, currency, returnUrl, orderNo, amount }
 *     → 前端用 src/lib/airwallexCheckout.ts 嘅 redirectToAirwallexCheckout()
 *     → 官方 Airwallex.js redirectToCheckout 跳去託管付款頁
 *   env 未配置        回傳 { enabled: false } → 前端成個「網上付款」區唔 render
 *   訂單唔係自己嘅／唔係 pending_payment → throw TRPCError（中文訊息）
 */
export const airwallexRouter = createRouter({
  createPayment: authedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // 未配置 Airwallex（後台設定／env 未齊）：畀前端知唔好顯示網上付款區，個站照常用手動過數
      const cfg = await getAirwallexConfig();
      if (!cfg) {
        return { enabled: false as const };
      }
      const db = getDb();
      // 只准付自己嘅單（唔畀攞人哋 orderId 開付款連結）
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.id, input.orderId), eq(orders.userId, ctx.user.userId)),
      });
      if (!order) {
        throw new TRPCError({ code: "NOT_FOUND", message: "訂單不存在" });
      }
      if (order.status !== "pending_payment") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "呢張訂單而家唔係待付款狀態，唔可以再網上付款",
        });
      }
      // 俾完錢 Airwallex 跳返呢個 server route，再 302 去 #/payment（HashRouter 收唔到外層 query）
      const returnUrl = `${cfg.publicBaseUrl}/api/airwallex/return?orderId=${order.id}`;
      try {
        const session = await createHostedPayment({
          cfg,
          orderId: order.id,
          orderNo: order.orderNo,
          // orders.total 係 integer 港元（元）；Airwallex amount 亦係 major unit（元），直接傳
          amount: order.total,
          returnUrl,
        });
        // 記低 intent id（2026-09-29 三 bug hotfix）：客人俾完錢跳返 /api/airwallex/return
        // 嗰陣如果 webhook 仲未到，server 就靠呢個 id 主動向 Airwallex 查證收款補狀態。
        // 失敗唔影響跳轉（webhook 到咗一樣會寫返），所以淨係 log。
        try {
          await db
            .update(orders)
            .set({ airwallexIntentId: session.intentId })
            .where(eq(orders.id, order.id));
        } catch (e) {
          console.error(`[airwallex] 記低 intent id 失敗（訂單 ${order.orderNo}）：`, e);
        }
        return {
          enabled: true as const,
          intentId: session.intentId,
          clientSecret: session.clientSecret,
          env: session.env,
          currency: session.currency,
          returnUrl: session.returnUrl,
          orderNo: order.orderNo,
          amount: order.total,
        };
      } catch (e) {
        console.error(`[airwallex] 開付款單失敗（訂單 ${order.orderNo}）：`, e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "開網上付款單失敗，請稍後再試，或者改用截圖上傳方式付款",
        });
      }
    }),

  /**
   * 訪客網上付款（2026-10-09 訪客購買 Guest Checkout，契約 v1.0 §3）：
   * 唔使登入——憑 orderNo＋guestToken 雙因子核實（token 只經落單回應／email 魔法連結得出，
   * constant-time 比對；唔中 → 統一 NOT_FOUND 訊息防單號枚舉）。
   * 限 userId IS NULL 嘅訪客單、status='pending_payment' 且未過 30 分鐘保留期。
   * returnUrl 帶 gt=<guestToken>：/api/airwallex/return 認住佢 302 返去 #/guest-payment。
   */
  createGuestPayment: publicProcedure
    .input(z.object({ orderNo: z.string().trim().min(1).max(32), guestToken: z.string().trim().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      if (!guestPaymentLimiter.allow(clientIpFromRequest(ctx.req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "操作太頻密，請一分鐘後再試",
        });
      }
      // 同 createPayment 一致：未配置就回 enabled:false（訪客結帳入口照理已擋，呢度兜底）
      const cfg = await getAirwallexConfig();
      if (!cfg) {
        return { enabled: false as const };
      }
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: and(eq(orders.orderNo, input.orderNo), isNull(orders.userId)),
      });
      if (!order || !guestTokenEquals(order.guestToken ?? "", input.guestToken)) {
        throw new TRPCError({ code: "NOT_FOUND", message: GUEST_LOOKUP_FAIL_MESSAGE });
      }
      if (order.status !== "pending_payment") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "呢張訂單而家唔係待付款狀態，唔可以再付款",
        });
      }
      // 30 分鐘付款保留期：過期唔准開付款（sweeper 好快會取消佢＋回庫存）
      if (!order.expiresAt || order.expiresAt.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "付款保留期已過，請重新落單",
        });
      }
      // 俾完錢 Airwallex 跳返 /api/airwallex/return；gt 畀 server 認住係訪客單，
      // 302 去 #/guest-payment?orderNo=…&token=…&ap=done（HashRouter 收唔到外層 query）
      const returnUrl = `${cfg.publicBaseUrl}/api/airwallex/return?orderId=${order.id}&gt=${encodeURIComponent(input.guestToken)}`;
      try {
        const session = await createHostedPayment({
          cfg,
          orderId: order.id,
          orderNo: order.orderNo,
          // orders.total 係 integer 港元（元）；Airwallex amount 亦係 major unit（元），直接傳
          amount: order.total,
          returnUrl,
        });
        // 記低 intent id（同會員單一致）：webhook 遲到／漏咗時 return 主動查證靠佢
        try {
          await db
            .update(orders)
            .set({ airwallexIntentId: session.intentId })
            .where(eq(orders.id, order.id));
        } catch (e) {
          console.error(`[airwallex] 記低 intent id 失敗（訪客訂單 ${order.orderNo}）：`, e);
        }
        return {
          enabled: true as const,
          intentId: session.intentId,
          clientSecret: session.clientSecret,
          env: session.env,
          currency: session.currency,
          returnUrl: session.returnUrl,
          orderNo: order.orderNo,
          amount: order.total,
        };
      } catch (e) {
        console.error(`[airwallex] 開訪客付款單失敗（訂單 ${order.orderNo}）：`, e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "開網上付款單失敗，請稍後再試",
        });
      }
    }),
});
