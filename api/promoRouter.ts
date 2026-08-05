import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, ne, and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, promoCodes, users, type PromoCode } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure } from "./middleware";
import { logAudit } from "./audit";
import { sendMarketingEmail as deliverMarketingEmail } from "./email";

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
  usageByUser?: number,
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
  // 每人限用：caller 先數好呢個帳號用過呢個碼幾多次
  // （口徑同 usedCount 一樣——計已建立嘅訂單，取消唔扣返）
  if (
    promo.perUserLimit !== null &&
    usageByUser !== undefined &&
    usageByUser >= promo.perUserLimit
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `每人限用 ${promo.perUserLimit} 次，你呢個帳號已經用晒`,
    });
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
  perUserLimit: z.number().int().positive().optional(),
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
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 每人限用檢查用：數呢個帳號之前用過呢個碼幾多次
      const [{ n: myUses }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.promoCode, normalizePromoCode(input.code)),
            eq(orders.userId, ctx.user.userId),
          ),
        );
      const { promo, discountAmount } = await resolvePromoDiscount(
        db,
        input.code,
        input.subtotal,
        myUses,
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
          perUserLimit: input.perUserLimit ?? null,
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
        perUserLimit: z.number().int().positive().nullable().optional(),
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
      if (fields.perUserLimit !== undefined) data.perUserLimit = fields.perUserLimit;
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

  /**
   * 促銷電郵收件人數（2026-08-05 Glo 要求）：註冊時剔咗「同意接收推廣」兼且有 email 嘅會員
   * 後台「促銷電郵」頁顯示「將會寄畀 X 位會員」用
   */
  marketingAudience: staffProcedure.query(async () => {
    const db = getDb();
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.role, "member"),
          eq(users.marketingOptIn, true),
          sql`${users.email} is not null`,
        ),
      );
    return { count: row?.n ?? 0 };
  }),

  /**
   * 寄出優惠促銷電郵（2026-08-05 Glo 要求）：
   * - 只寄畀 marketingOptIn=true 兼且有 email 嘅會員（註冊頁剔選先算同意，PDPO 第 6A 部）
   * - 款同官網其他電郵一樣（email.ts sendMarketingEmail → brandedEmail 模板）
   * - 可選加圖（最多 3 張，顯示喺內文下面；只接受本站 /uploads/ 路徑，即後台上傳嘅圖）
   * - 填咗優惠碼會先檢查佢存在兼啟用，先至會寄（避免寄錯碼出街）
   * - 逐位會員寄出（稱呼跟返佢個名）；失敗唔會阻後面嘅，最後回 sent/failed 統計
   * - 動作記落操作日誌（promo.marketingEmail）
   */
  sendMarketingEmail: staffProcedure
    .input(
      z.object({
        subject: z.string().trim().min(1, "主旨必填").max(80, "主旨最長 80 字"),
        body: z.string().trim().min(1, "內文必填").max(3000, "內文最長 3000 字"),
        promoCode: z.string().trim().max(32).optional(),
        // 圖片（2026-08-05 Glo 要求）：選填，最多 3 張；只准本站 /uploads/ 路徑
        imageUrls: z
          .array(z.string().trim().min(1).max(300))
          .max(3, "最多 3 張圖")
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 圖片路徑把關：只准本站 /uploads/（員工經後台上傳嘅圖），
      // 唔接受外站 URL（防死鏈／防人呢個 API 寄含惡意圖嘅信）
      const imageUrls = input.imageUrls ?? [];
      for (const u of imageUrls) {
        if (!u.startsWith("/uploads/") || u.includes("..")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "圖片要用後台上傳嘅圖（/uploads/ 路徑）",
          });
        }
      }
      // 優惠碼（選填）：存在兼啟用先寄得
      let code: string | undefined;
      if (input.promoCode) {
        code = normalizePromoCode(input.promoCode);
        const promo = await db.query.promoCodes.findFirst({
          where: eq(promoCodes.code, code),
        });
        if (!promo) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `優惠碼 ${code} 唔存在` });
        }
        if (!promo.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `優惠碼 ${code} 已停用` });
        }
      }
      const audience = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.role, "member"),
            eq(users.marketingOptIn, true),
            sql`${users.email} is not null`,
          ),
        );
      if (audience.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "暫時冇會員同意接收推廣資訊，冇人可以寄",
        });
      }
      let sent = 0;
      let failed = 0;
      let firstError: string | undefined;
      for (const m of audience) {
        const r = await deliverMarketingEmail({
          to: m.email as string,
          name: m.name,
          subject: input.subject,
          bodyText: input.body,
          promoCode: code,
          imageUrls: imageUrls.length ? imageUrls : undefined,
        });
        if (r.ok) {
          sent += 1;
        } else {
          failed += 1;
          firstError ??= r.error;
        }
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.marketingEmail",
        targetType: "promo",
        detail: `寄出促銷電郵「${input.subject}」：成功 ${sent} 位、失敗 ${failed} 位（受眾 ${audience.length} 位已同意推廣會員）${code ? `，附優惠碼 ${code}` : ""}${imageUrls.length ? `，附 ${imageUrls.length} 張圖` : ""}${firstError ? `；首個失敗原因：${firstError}` : ""}`,
      });
      return { ok: true, total: audience.length, sent, failed, error: firstError };
    }),
});
