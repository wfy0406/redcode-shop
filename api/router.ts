import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./authRouter";
import { productsRouter } from "./productsRouter";
import { cartRouter } from "./cartRouter";
import { ordersRouter } from "./ordersRouter";
import { praiseRouter } from "./praiseRouter";
import { usersRouter } from "./usersRouter";
import { promoRouter } from "./promoRouter";
import { settingsRouter } from "./settingsRouter";
import { analyticsRouter } from "./analyticsRouter";
import { membersRouter } from "./membersRouter";
import { auditRouter } from "./auditRouter";
import { approvalsRouter } from "./approvalsRouter";
import { airwallexRouter } from "./airwallexRouter";
import { vipRouter } from "./vipRouter";
import { pushRouter } from "./pushRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  products: productsRouter,
  cart: cartRouter,
  orders: ordersRouter,
  praise: praiseRouter,
  users: usersRouter,
  promo: promoRouter,
  settings: settingsRouter,
  analytics: analyticsRouter,
  members: membersRouter,
  audit: auditRouter,
  approvals: approvalsRouter,
  airwallex: airwallexRouter,
  // v2.1.0（VIP+免運）：VIP 狀態／規則／結帳報價／順豐站點
  vip: vipRouter,
  // v2.2.0（直播開播推送通知，老闆 2026-09-30 指令）：Web Push 訂閱＋申請／審批／發送
  push: pushRouter,
});

export type AppRouter = typeof appRouter;
