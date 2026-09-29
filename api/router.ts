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
});

export type AppRouter = typeof appRouter;
