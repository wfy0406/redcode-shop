import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, like, or, desc } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products } from "@db/schema";
import { PRODUCT_CATEGORY_VALUES } from "@contracts/types";
import { createRouter, publicQuery, staffProcedure } from "./middleware";
import { logAudit } from "./audit";

const categorySchema = z.enum(PRODUCT_CATEGORY_VALUES as [string, ...string[]]);

/**
 * 「未下架」條件：冇開定時下架，或者開咗但時間未到。
 * 人手下架（isActive=false）另外喺查詢度擋。
 */
function notAutoDelisted() {
  return or(
    eq(products.delistEnabled, false),
    isNull(products.delistAt),
    gt(products.delistAt, new Date()),
  )!;
}

export const productsRouter = createRouter({
  list: publicQuery
    .input(
      z
        .object({
          keyword: z.string().optional(),
          category: categorySchema.optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const keyword = input?.keyword?.trim();
      const conditions = [eq(products.isActive, true), notAutoDelisted()];
      if (keyword) {
        const pattern = `%${keyword}%`;
        conditions.push(
          or(like(products.name, pattern), like(products.description, pattern))!,
        );
      }
      if (input?.category) {
        conditions.push(eq(products.category, input.category));
      }
      return db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(desc(products.listedDate));
    }),

  // staff 專用：全部商品（包括下架），俾管理後台用
  adminList: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(products)
      .orderBy(desc(products.listedDate));
  }),

  byId: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const product = await db.query.products.findFirst({
        where: and(eq(products.id, input.id), eq(products.isActive, true), notAutoDelisted()),
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在或已下架" });
      }
      return product;
    }),

  create: staffProcedure
    .input(
      z.object({
        sku: z.string().min(1).max(64),
        name: z.string().min(1),
        description: z.string().optional(),
        image: z.string().min(1),
        price: z.number().int().nonnegative(),
        discountPrice: z.number().int().nonnegative().optional(),
        sizes: z.string().optional(),
        sizeEnabled: z.boolean().optional(),
        note: z.string().max(512).optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
        // 定時自動下架：開關 + 時間（選填；開關開咗冇時間＝唔會自動落）
        delistEnabled: z.boolean().optional(),
        delistAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const dup = await db.query.products.findFirst({
        where: eq(products.sku, input.sku),
      });
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: "貨號已存在" });
      }
      const [{ id }] = await db
        .insert(products)
        .values({
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          image: input.image,
          price: input.price,
          discountPrice: input.discountPrice ?? null,
          sizes: input.sizes ?? null,
          sizeEnabled: input.sizeEnabled ?? true,
          note: input.note ?? null,
          category: input.category ?? "other",
          listedDate: input.listedDate ?? new Date(),
          stock: input.stock ?? 0,
          delistEnabled: input.delistEnabled ?? false,
          delistAt: input.delistAt ?? null,
        })
        .returning({ id: products.id });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.create",
        targetType: "product",
        targetId: input.sku,
        detail: `新增商品「${input.name}」（${input.sku}，HK$${input.discountPrice ?? input.price}）`,
      });
      return db.query.products.findFirst({ where: eq(products.id, id) });
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        sku: z.string().min(1).max(64).optional(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        image: z.string().min(1).optional(),
        price: z.number().int().nonnegative().optional(),
        discountPrice: z.number().int().nonnegative().nullable().optional(),
        sizes: z.string().nullable().optional(),
        sizeEnabled: z.boolean().optional(),
        note: z.string().max(512).nullable().optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
        isActive: z.boolean().optional(),
        delistEnabled: z.boolean().optional(),
        delistAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.products.findFirst({
        where: eq(products.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      await db.update(products).set(data).where(eq(products.id, id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.update",
        targetType: "product",
        targetId: existing.sku,
        detail: `更新商品「${data.name ?? existing.name}」（${existing.sku}）：${Object.keys(data).join("、")}`,
      });
      return db.query.products.findFirst({ where: eq(products.id, id) });
    }),

  remove: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.products.findFirst({
        where: eq(products.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      // 有訂單／購物車紀錄嘅商品會被外鍵擋住，畀個友善提示（仿 usersRouter.remove）
      try {
        await db.delete(products).where(eq(products.id, input.id));
      } catch {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "呢件商品有訂單或購物車紀錄，唔可以刪除（可以下架代替）",
        });
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "product.remove",
        targetType: "product",
        targetId: existing.sku,
        detail: `刪除商品「${existing.name}」（${existing.sku}）`,
      });
      return { ok: true };
    }),
});
