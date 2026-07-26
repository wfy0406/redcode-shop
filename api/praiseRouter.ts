import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { praiseWall } from "@db/schema";
import { createRouter, publicQuery, staffProcedure } from "./middleware";

/**
 * 客戶打卡牆（Star Girls）—— 首頁橫 scroll 相片牆
 * list：公開，只回上架中，按 sortOrder 升序再 id 升序
 * adminList / create / update / remove：員工後台用（staff/admin）
 */
export const praiseRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(praiseWall)
      .where(eq(praiseWall.isActive, true))
      .orderBy(asc(praiseWall.sortOrder), asc(praiseWall.id));
  }),

  adminList: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(praiseWall)
      .orderBy(asc(praiseWall.sortOrder), asc(praiseWall.id));
  }),

  create: staffProcedure
    .input(
      z.object({
        image: z.string().min(1).max(512),
        caption: z.string().max(255).optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(praiseWall)
        .values({
          image: input.image,
          caption: input.caption?.trim() || null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning({ id: praiseWall.id });
      return db.query.praiseWall.findFirst({ where: eq(praiseWall.id, id) });
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        caption: z.string().max(255).nullable().optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.praiseWall.findFirst({
        where: eq(praiseWall.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "打卡相不存在" });
      }
      await db
        .update(praiseWall)
        .set({
          ...(data.caption !== undefined
            ? { caption: data.caption?.trim() || null }
            : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        })
        .where(eq(praiseWall.id, id));
      return db.query.praiseWall.findFirst({ where: eq(praiseWall.id, id) });
    }),

  remove: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.praiseWall.findFirst({
        where: eq(praiseWall.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "打卡相不存在" });
      }
      await db.delete(praiseWall).where(eq(praiseWall.id, input.id));
      return { ok: true };
    }),
});
