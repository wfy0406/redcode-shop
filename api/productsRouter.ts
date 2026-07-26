import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, like, or, desc } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products } from "@db/schema";
import { PRODUCT_CATEGORY_VALUES } from "@contracts/types";
import { createRouter, publicQuery, staffProcedure } from "./middleware";

const categorySchema = z.enum(PRODUCT_CATEGORY_VALUES as [string, ...string[]]);

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
      const conditions = [eq(products.isActive, true)];
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

  byId: publicQuery
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const product = await db.query.products.findFirst({
        where: and(eq(products.id, input.id), eq(products.isActive, true)),
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
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
        note: z.string().max(512).optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ input }) => {
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
          note: input.note ?? null,
          category: input.category ?? "other",
          listedDate: input.listedDate ?? new Date(),
          stock: input.stock ?? 0,
        })
        .returning({ id: products.id });
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
        note: z.string().max(512).nullable().optional(),
        category: categorySchema.optional(),
        listedDate: z.coerce.date().optional(),
        stock: z.number().int().nonnegative().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.products.findFirst({
        where: eq(products.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      await db.update(products).set(data).where(eq(products.id, id));
      return db.query.products.findFirst({ where: eq(products.id, id) });
    }),

  remove: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.products.findFirst({
        where: eq(products.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "產品不存在" });
      }
      await db.delete(products).where(eq(products.id, input.id));
      return { ok: true };
    }),
});
