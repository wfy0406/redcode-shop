import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, ne, and } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { promoCodes, type PromoCode } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure } from "./middleware";
import { logAudit } from "./audit";

export const PROMO_KIND_VALUES = ["percent", "fixed"] as const;
const kindSchema = z.enum(PROMO_KIND_VALUES);

export function normalizePromoCode(code: string): string {
  return code.toUpperCase().trim();
}

// 可以係主 connection 又可以係 transaction（tx.query.promoCodes 同形）
type PromoDb = {
  query: {
    promoCodes: {
      findFirst: (args: { where?: SQL }) => Promise<PromoCode | undefined>;
    };
  };
};

/**
 * 優惠碼共用驗證＋折扣計算（promo.validate 同 orders.create 都用佢）。
 * 成功回傳 { promo, discountAmount }；失敗逐項 throw BAD_REQUEST。
 */
export async function resolvePromoDiscount(
  db: PromoDb,
  rawCode: string,
  subtotal: number,
): Promise<{ promo: PromoCode; discountAmount: number }> {
  const code = normalizePromoCode(rawCode);
  const promo = await db.query.promoCodes.findFirst({
    where: eq(promoCodes.code, code),
  });
  if (!promo) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼唔存在" });
  }
  if (!promo.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已停用" });
  }
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已過期" });
  }
  if (subtotal < promo.minSpend) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `未夠最低消費 HK$${promo.minSpend}`,
    });
  }
  if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已用完" });
  }
  const discountAmount =
    promo.kind === "percent"
      ? Math.floor((subtotal * promo.value) / 100)
      : Math.min(promo.value, subtotal);
  return { promo, discountAmount: Math.min(discountAmount, subtotal) };
}

const promoFieldsSchema = z.object({
  code: z.string().min(1).max(32),
  kind: kindSchema,
  value: z.number().int().positive(),
  minSpend: z.number().int().nonnegative().optional(),
  usageLimit: z.number().int().positive().optional(),
  expiresAt: z.coerce.date().optional(),
});

function assertKindValue(kind: "percent" | "fixed", value: number) {
  if (kind === "percent" && (value < 1 || value > 90)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "百分比優惠碼嘅折扣要喺 1 至 90 之間",
    });
  }
}

export const promoRouter = createRouter({
  validate: authedProcedure
    .input(
      z.object({
        code: z.string().min(1),
        subtotal: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { promo, discountAmount } = await resolvePromoDiscount(
        db,
        input.code,
        input.subtotal,
      );
      return {
        code: promo.code,
        kind: promo.kind as "percent" | "fixed",
        value: promo.value,
        discountAmount,
        finalTotal: input.subtotal - discountAmount,
      };
    }),

  list: staffProcedure.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(promoCodes)
      .orderBy(desc(promoCodes.createdAt));
  }),

  create: staffProcedure
    .input(promoFieldsSchema)
    .mutation(async ({ ctx, input }) => {
      assertKindValue(input.kind, input.value);
      const db = getDb();
      const code = normalizePromoCode(input.code);
      const dup = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.code, code),
      });
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: "優惠碼已存在" });
      }
      const [{ id }] = await db
        .insert(promoCodes)
        .values({
          code,
          kind: input.kind,
          value: input.value,
          minSpend: input.minSpend ?? 0,
          usageLimit: input.usageLimit ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: promoCodes.id });
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.create",
        targetType: "promo",
        targetId: code,
        detail: `新增優惠碼 ${code}（${input.kind === "percent" ? `${input.value}% 折扣` : `減 HK$${input.value}`}）`,
      });
      return db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) });
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        code: z.string().min(1).max(32).optional(),
        kind: kindSchema.optional(),
        value: z.number().int().positive().optional(),
        minSpend: z.number().int().nonnegative().optional(),
        usageLimit: z.number().int().positive().nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const existing = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "優惠碼唔存在" });
      }
      const data: Partial<typeof promoCodes.$inferInsert> = {};
      if (fields.code !== undefined) data.code = normalizePromoCode(fields.code);
      if (fields.kind !== undefined) data.kind = fields.kind;
      if (fields.value !== undefined) data.value = fields.value;
      if (fields.minSpend !== undefined) data.minSpend = fields.minSpend;
      if (fields.usageLimit !== undefined) data.usageLimit = fields.usageLimit;
      if (fields.expiresAt !== undefined) data.expiresAt = fields.expiresAt;
      if (fields.isActive !== undefined) data.isActive = fields.isActive;
      const kind = (data.kind ?? existing.kind) as "percent" | "fixed";
      const value = data.value ?? existing.value;
      assertKindValue(kind, value);
      if (data.code && data.code !== existing.code) {
        const dup = await db.query.promoCodes.findFirst({
          where: and(eq(promoCodes.code, data.code), ne(promoCodes.id, id)),
        });
        if (dup) {
          throw new TRPCError({ code: "CONFLICT", message: "優惠碼已存在" });
        }
      }
      await db.update(promoCodes).set(data).where(eq(promoCodes.id, id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.update",
        targetType: "promo",
        targetId: existing.code,
        detail: `更新優惠碼 ${existing.code}：${Object.keys(data).join("、")}${fields.isActive !== undefined ? `（${fields.isActive ? "啟用" : "停用"}）` : ""}`,
      });
      return db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) });
    }),

  remove: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const existing = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "優惠碼唔存在" });
      }
      // orders.promoCode 係 varchar 快照（唔係 FK），硬刪安全
      await db.delete(promoCodes).where(eq(promoCodes.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.remove",
        targetType: "promo",
        targetId: existing.code,
        detail: `刪除優惠碼 ${existing.code}`,
      });
      return { ok: true };
    }),
});
