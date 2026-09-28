import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders } from "@db/schema";
import { createRouter, authedProcedure } from "./middleware";
import { createHostedPayment, getAirwallexConfig } from "./airwallex";

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
});
