import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, promoCodes, users } from "@db/schema";
import { createRouter, authedProcedure, staffProcedure, adminProcedure } from "./middleware";
import { logAudit } from "./audit";
import { openApprovalRequest } from "./approvalsRouter";
import { env } from "./lib/env";
import { sendEmail, buildMarketingEmail } from "./lib/email";

/**
 * 優惠碼
 * validate：結帳時用（authed），檢查碼有效＋未過期＋未爆額＋夠最低消費，回折扣額
 * adminList / create / update / remove：員工後台用（staff/admin）
 *   create/update/remove 全部記落操作日誌（「日誌」頁睇返邊個改過）
 */
export const promoRouter = createRouter({
  validate: authedProcedure
    .input(
      z.object({
        code: z.string().trim().min(1).max(32),
        subtotal: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const code = input.code.toUpperCase();
      const promo = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.code, code),
      });
      if (!promo || !promo.isActive) {
        throw new TRPCError({ code: "NOT_FOUND", message: "優惠碼唔存在或已停用" });
      }
      if (promo.expiresAt && promo.expiresAt < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已過期" });
      }
      if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "優惠碼已用晒" });
      }
      // 每人限用次數：數呢個會員用過呢個碼幾多張已成立訂單（取消/拒絕唔計）
      if (promo.perUserLimit !== null) {
        const [{ usedByMe }] = await db
          .select({ usedByMe: sql<number>`count(*)::int` })
          .from(orders)
          .where(
            and(
              eq(orders.userId, ctx.user.userId),
              eq(orders.promoCode, code),
              sql`${orders.status} not in ('cancelled', 'rejected')`,
            ),
          );
        if (usedByMe >= promo.perUserLimit) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `呢個優惠碼每個帳號限用 ${promo.perUserLimit} 次，你已經用晒`,
          });
        }
      }
      if (input.subtotal < promo.minSpend) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `未夠最低消費 $${(promo.minSpend / 100).toFixed(0)}`,
        });
      }
      const discount =
        promo.kind === "percent"
          ? Math.floor((input.subtotal * promo.value) / 100)
          : Math.min(promo.value, input.subtotal);
      return { code, kind: promo.kind, value: promo.value, discount };
    }),

  adminList: staffProcedure.query(async () => {
    const db = getDb();
    return db.select().from(promoCodes).orderBy(desc(promoCodes.id));
  }),

  create: staffProcedure
    .input(
      z.object({
        code: z.string().trim().min(2).max(32),
        kind: z.enum(["percent", "fixed"]),
        value: z.number().int().min(1),
        minSpend: z.number().int().min(0).optional(),
        usageLimit: z.number().int().min(1).nullable().optional(),
        perUserLimit: z.number().int().min(1).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const code = input.code.toUpperCase();
      const dup = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.code, code),
      });
      if (dup) {
        throw new TRPCError({ code: "CONFLICT", message: `優惠碼「${code}」已存在` });
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准
      const reqId = await openApprovalRequest({
        user: ctx.user,
        action: "promoCode.create",
        payload: { input: { ...input, code } },
        summary: `新增優惠碼「${code}」（${input.kind === "percent" ? `${input.value}% off` : `減 $${(input.value / 100).toFixed(0)}`}）`,
      });
      if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
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
        detail: `新增優惠碼「${code}」（${input.kind === "percent" ? `${input.value}% off` : `減 $${(input.value / 100).toFixed(0)}`}）`,
      });
      return { id, code };
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        kind: z.enum(["percent", "fixed"]).optional(),
        value: z.number().int().min(1).optional(),
        minSpend: z.number().int().min(0).optional(),
        usageLimit: z.number().int().min(1).nullable().optional(),
        perUserLimit: z.number().int().min(1).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      const existing = await db.query.promoCodes.findFirst({
        where: eq(promoCodes.id, id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "優惠碼唔存在" });
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准；
      // before 快照記低現狀，審批中心用嚟做改前 vs 改後對照
      const reqId = await openApprovalRequest({
        user: ctx.user,
        action: "promoCode.update",
        payload: { input, before: existing },
        summary: `修改優惠碼「${existing.code}」`,
      });
      if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
      await db
        .update(promoCodes)
        .set({
          ...(data.kind !== undefined ? { kind: data.kind } : {}),
          ...(data.value !== undefined ? { value: data.value } : {}),
          ...(data.minSpend !== undefined ? { minSpend: data.minSpend } : {}),
          ...(data.usageLimit !== undefined ? { usageLimit: data.usageLimit } : {}),
          ...(data.perUserLimit !== undefined ? { perUserLimit: data.perUserLimit } : {}),
          ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        })
        .where(eq(promoCodes.id, id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.update",
        targetType: "promo",
        targetId: existing.code,
        detail: `更新優惠碼「${existing.code}」：${Object.keys(data).join("、")}${data.isActive !== undefined ? `（${data.isActive ? "啟用" : "停用"}）` : ""}`,
      });
      return { ok: true };
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
      await db.delete(promoCodes).where(eq(promoCodes.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.remove",
        targetType: "promo",
        targetId: existing.code,
        detail: `刪除優惠碼「${existing.code}」`,
      });
      return { ok: true };
    }),

  /**
   * 促銷電郵（2026-08-05 Glo 要求）：寄畀已同意接收推廣嘅會員（marketingOptIn=true 兼有 email）。
   * PDPO 第 6A 部：只用已同意名單，每封附退訂方法（覆 email 話唔收）；寄件紀錄記落操作日誌。
   * 預覽模式（dryRun=true）：唔寄，淨係回番收件人數＋頭 20 個收件人畀管理員確認。
   * 冇設 RESEND_API_KEY 就 FORBIDDEN（測試環境唔會誤寄）。
   */
  sendMarketingEmail: adminProcedure
    .input(
      z.object({
        subject: z.string().trim().min(1, "主旨必填").max(120),
        body: z.string().trim().min(1, "內容必填").max(5000),
        dryRun: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const recipients = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.marketingOptIn, true),
            sql`${users.email} is not null`,
          ),
        );
      if (input.dryRun) {
        return {
          dryRun: true as const,
          recipientCount: recipients.length,
          sample: recipients.slice(0, 20).map((r) => ({ name: r.name, email: r.email })),
        };
      }
      if (!env.resendApiKey) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "未設 RESEND_API_KEY，唔可以寄促銷電郵",
        });
      }
      if (recipients.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "冇已同意接收推廣嘅會員（會員要喺註冊或會員中心剔選接收推廣）",
        });
      }
      // 員工操作需審批（2026-08-06 Glo 要求）：staff 唔直接執行，開審批單等主管/管理員批准
      const reqId = await openApprovalRequest({
        user: ctx.user,
        action: "promo.sendMarketingEmail",
        payload: { input, before: { recipientCount: recipients.length } },
        summary: `寄促銷電郵「${input.subject}」畀 ${recipients.length} 個已同意會員`,
      });
      if (reqId !== null) return { pendingApproval: true as const, requestId: reqId };
      let sent = 0;
      const failures: string[] = [];
      // 逐個寄（量少，唔使 batch；一個 fail 唔阻其他）
      for (const r of recipients) {
        try {
          await sendEmail({
            to: r.email!,
            subject: input.subject,
            html: buildMarketingEmail(r.name, input.body),
          });
          sent++;
        } catch (err) {
          console.error(`[promo] send marketing email to ${r.email} failed:`, err);
          failures.push(r.email!);
        }
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "promo.sendMarketingEmail",
        targetType: "promo",
        detail: `寄促銷電郵「${input.subject}」：成功 ${sent}/${recipients.length}${failures.length > 0 ? `，失敗：${failures.join("、")}` : ""}`,
      });
      return {
        dryRun: false as const,
        recipientCount: recipients.length,
        sent,
        failed: failures.length,
        failures,
      };
    }),
});
