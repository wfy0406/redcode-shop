import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, products } from "@db/schema";
import { createRouter, authedProcedure } from "./middleware";

export const cartRouter = createRouter({
  list: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    return db.query.cartItems.findMany({
      where: eq(cartItems.userId, ctx.user.userId),
      with: { product: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }),

  add: authedProcedure
    .input(
      z.object({
        productId: z.number().int().positive(),
        size: z.string().max(64).optional(),
        quantity: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const product = await db.query.products.findFirst({
        where: and(eq(products.id, input.productId), eq(products.isActive, true)),
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      const size = input.size ?? null;
      const sizeCond = size === null ? isNull(cartItems.size) : eq(cartItems.size, size);
      const existing = await db.query.cartItems.findFirst({
        where: and(
          eq(cartItems.userId, ctx.user.userId),
          eq(cartItems.productId, input.productId),
          sizeCond,
        ),
      });
      if (existing) {
        await db
          .update(cartItems)
          .set({ quantity: existing.quantity + input.quantity })
          .where(eq(cartItems.id, existing.id));
        return db.query.cartItems.findFirst({
          where: eq(cartItems.id, existing.id),
          with: { product: true },
        });
      }
      const [{ id }] = await db
        .insert(cartItems)
        .values({
          userId: ctx.user.userId,
          productId: input.productId,
          size,
          quantity: input.quantity,
        })
        .returning({ id: cartItems.id });
      return db.query.cartItems.findFirst({
        where: eq(cartItems.id, id),
        with: { product: true },
      });
    }),

  updateQuantity: authedProcedure
    .input(
      z.object({
        cartItemId: z.number().int().positive(),
        quantity: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const item = await db.query.cartItems.findFirst({
        where: and(
          eq(cartItems.id, input.cartItemId),
          eq(cartItems.userId, ctx.user.userId),
        ),
      });
      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: "購物車項目不存在" });
      }
      if (input.quantity === 0) {
        await db.delete(cartItems).where(eq(cartItems.id, item.id));
        return { ok: true, removed: true };
      }
      await db
        .update(cartItems)
        .set({ quantity: input.quantity })
        .where(eq(cartItems.id, item.id));
      return db.query.cartItems.findFirst({
        where: eq(cartItems.id, item.id),
        with: { product: true },
      });
    }),

  remove: authedProcedure
    .input(z.object({ cartItemId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const item = await db.query.cartItems.findFirst({
        where: and(
          eq(cartItems.id, input.cartItemId),
          eq(cartItems.userId, ctx.user.userId),
        ),
      });
      if (!item) {
        throw new TRPCError({ code: "NOT_FOUND", message: "購物車項目不存在" });
      }
      await db.delete(cartItems).where(eq(cartItems.id, item.id));
      return { ok: true };
    }),

  clear: authedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    await db.delete(cartItems).where(eq(cartItems.userId, ctx.user.userId));
    return { ok: true };
  }),
});
