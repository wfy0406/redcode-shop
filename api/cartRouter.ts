import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, products } from "@db/schema";
import { tryOnPurchaseItemsSchema } from "@contracts/purchase";
import { createRouter, authedProcedure } from "./middleware";
import { resolveTryOnPurchaseItems } from "./purchase";

// 雙 int4 advisory-lock namespace；唔同抽獎（845120／845121）或其他單 key 鎖共用 key space。
const CART_USER_LOCK_NS = 731260;

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
      return db.transaction(async (tx) => {
        // PostgreSQL 普通 unique index 會放過多個 NULL size；add／addMany 共用會員鎖，
        // 跨 process 都串行「讀現有行 → 更新／插入」，避免無尺寸商品出現重複行。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${CART_USER_LOCK_NS}, ${ctx.user.userId})`);
        const product = await tx.query.products.findFirst({
          where: and(eq(products.id, input.productId), eq(products.isActive, true)),
        });
        if (!product) {
          throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
        }
        // 定時下架時間到咗 → 當下架，唔可以再加入購物車
        if (
          product.delistEnabled &&
          product.delistAt !== null &&
          product.delistAt.getTime() <= Date.now()
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "呢件商品已經下架" });
        }
        const size = input.size ?? null;
        const sizeCond = size === null ? isNull(cartItems.size) : eq(cartItems.size, size);
        const existing = await tx.query.cartItems.findFirst({
          where: and(
            eq(cartItems.userId, ctx.user.userId),
            eq(cartItems.productId, input.productId),
            sizeCond,
          ),
        });
        if (existing) {
          await tx
            .update(cartItems)
            .set({ quantity: existing.quantity + input.quantity })
            .where(eq(cartItems.id, existing.id));
          return tx.query.cartItems.findFirst({
            where: eq(cartItems.id, existing.id),
            with: { product: true },
          });
        }
        const [{ id }] = await tx
          .insert(cartItems)
          .values({
            userId: ctx.user.userId,
            productId: input.productId,
            size,
            quantity: input.quantity,
          })
          .returning({ id: cartItems.id });
        return tx.query.cartItems.findFirst({
          where: eq(cartItems.id, id),
          with: { product: true },
        });
      });
    }),

  /** 試穿後一次過加一至三件：整批成功先 commit，唔會兩件變成只加到一件。 */
  addMany: authedProcedure
    .input(z.object({ items: tryOnPurchaseItemsSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${CART_USER_LOCK_NS}, ${ctx.user.userId})`);
        const ids = input.items.map((item) => item.productId);
        const rows = await tx.select().from(products).where(inArray(products.id, ids));
        const resolved = resolveTryOnPurchaseItems(input.items, rows);
        const existingRows = await tx.query.cartItems.findMany({
          where: and(
            eq(cartItems.userId, ctx.user.userId),
            inArray(cartItems.productId, ids),
          ),
        });
        const results: Array<typeof cartItems.$inferSelect & { product: typeof products.$inferSelect }> = [];

        for (const item of resolved) {
          if (item.product.stock < item.quantity) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `《${item.product.name}》暫時售罄` });
          }
          const productRows = existingRows.filter((row) => row.productId === item.productId);
          const existing = productRows.find((row) => row.size === item.size);
          // 同一商品唔同尺寸都共用產品庫存；唔可以逐條尺寸行分開繞過上限。
          const existingProductQuantity = productRows.reduce((sum, row) => sum + row.quantity, 0);
          const nextQuantity = (existing?.quantity ?? 0) + item.quantity;
          if (existingProductQuantity + item.quantity > item.product.stock) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `《${item.product.name}》庫存只有 ${item.product.stock} 件，購物車已有 ${existingProductQuantity} 件，請先調整數量`,
            });
          }

          let cartItemId = existing?.id;
          if (existing) {
            await tx.update(cartItems).set({ quantity: nextQuantity }).where(eq(cartItems.id, existing.id));
          } else {
            const inserted = await tx
              .insert(cartItems)
              .values({
                userId: ctx.user.userId,
                productId: item.productId,
                size: item.size,
                quantity: item.quantity,
              })
              .returning({ id: cartItems.id });
            cartItemId = inserted[0]?.id;
          }
          if (!cartItemId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "加入購物車未完成，請再試" });
          const line = await tx.query.cartItems.findFirst({
            where: eq(cartItems.id, cartItemId),
            with: { product: true },
          });
          if (!line) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "購物車更新後未能讀取商品" });
          results.push(line);
        }
        return results;
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
