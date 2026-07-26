import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./authRouter";
import { productsRouter } from "./productsRouter";
import { cartRouter } from "./cartRouter";
import { ordersRouter } from "./ordersRouter";
import { praiseRouter } from "./praiseRouter";
import { usersRouter } from "./usersRouter";
import { promoRouter } from "./promoRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  products: productsRouter,
  cart: cartRouter,
  orders: ordersRouter,
  praise: praiseRouter,
  users: usersRouter,
  promo: promoRouter,
});

export type AppRouter = typeof appRouter;
