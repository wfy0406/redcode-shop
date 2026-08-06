/**
 * 審批中心（2026-08-06 Glo 要求：員工敏感操作要主管/管理員審批，全程記日誌）
 * pendingList / history：主管＋管理員用；myRequests：員工睇自己啲單（最近 20 條）。
 * approve：以審批人身份經 tRPC createCaller 重跑原 mutation（原 mutation 嘅 audit 照記，
 *   actor＝審批人）；執行失敗（例如撞 email／目標已被刪）→ error 彈返畀審批人，單保持 pending。
 * reject：必須填原因。審批動作記 audit（approval.approve / approval.reject）；
 *   員工交單嗰下（approval.request）喺 approvalGuard.ts 記。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { approvalRequests, users } from "@db/schema";
import { createRouter, staffProcedure, supervisorProcedure } from "./middleware";
import { logAudit } from "./audit";

/** 一次過攞晒相關用戶嘅名（requester／reviewer 顯示用） */
async function nameMap(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const approvalsRouter = createRouter({
  // 待審批（舊嘅排先，等主管先處理等最耐嘅單）
  pendingList: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, "pending"))
      .orderBy(approvalRequests.createdAt, approvalRequests.id);
    const names = await nameMap(rows.map((r) => r.requesterId));
    return rows.map((r) => ({
      ...r,
      requesterName: names.get(r.requesterId) ?? `#${r.requesterId}`,
    }));
  }),

  // 處理紀錄（最近 50 條已處理）
  // 處理紀錄（2026-08-06 Glo 要求：每 50 條一頁，新嘅排先；回 total/pageCount 俾前端出頁碼掣）
  history: supervisorProcedure
    .input(z.object({ page: z.number().int().min(1).default(1) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const page = input?.page ?? 1;
      const PAGE_SIZE = 50;
      const filter = ne(approvalRequests.status, "pending");
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(approvalRequests)
          .where(filter)
          .orderBy(desc(approvalRequests.reviewedAt), desc(approvalRequests.id))
          .limit(PAGE_SIZE)
          .offset((page - 1) * PAGE_SIZE),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(approvalRequests)
          .where(filter),
      ]);
      const total = totalRows[0]?.total ?? 0;
      const ids = new Set<number>();
      for (const r of rows) {
        ids.add(r.requesterId);
        if (r.reviewerId) ids.add(r.reviewerId);
      }
      const names = await nameMap([...ids]);
      return {
        rows: rows.map((r) => ({
          ...r,
          requesterName: names.get(r.requesterId) ?? `#${r.requesterId}`,
          reviewerName: r.reviewerId
            ? (names.get(r.reviewerId) ?? `#${r.reviewerId}`)
            : null,
        })),
        total,
        page,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      };
    }),

  // 員工睇自己交嘅單（最近 20 條）
  myRequests: staffProcedure.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, ctx.user.userId))
      .orderBy(desc(approvalRequests.id))
      .limit(20);
  }),

  approve: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const req = await db.query.approvalRequests.findFirst({
        where: eq(approvalRequests.id, input.id),
      });
      if (!req) {
        throw new TRPCError({ code: "NOT_FOUND", message: "審批單唔存在" });
      }
      if (req.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已經處理咗" });
      }

      // 以審批人身份重跑原 mutation：ctx 帶同一 JWT，內層 requireStaff 會攞到審批人
      // （supervisor/admin）身份，所以唔會再觸發員工攔截，直接執行；
      // 原 mutation 嘅 audit 照記（actor＝審批人）。
      // lazy import 避免 circular（router.ts 會 import 呢個檔）。
      const { appRouter } = await import("./router");
      const caller = appRouter.createCaller(ctx);
      const p = req.payload as { input: never; before?: unknown };
      // 執行失敗（撞 email／目標已被刪等）→ 唔 update 單據，error 彈返出嚟，單保持 pending
      switch (req.action) {
        case "member.update":
          await caller.members.update(p.input);
          break;
        case "promo.sendMarketingEmail":
          await caller.promo.sendMarketingEmail(p.input);
          break;
        case "praise.create":
          await caller.praise.create(p.input);
          break;
        case "praise.update":
          await caller.praise.update(p.input);
          break;
        case "praise.remove":
          await caller.praise.remove(p.input);
          break;
        case "product.create":
          await caller.products.create(p.input);
          break;
        case "product.update":
          await caller.products.update(p.input);
          break;
        case "product.remove":
          await caller.products.remove(p.input);
          break;
        case "promoCode.create":
          await caller.promo.create(p.input);
          break;
        case "promoCode.update":
          await caller.promo.update(p.input);
          break;
        default:
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `未知操作 ${req.action}`,
          });
      }

      await db
        .update(approvalRequests)
        .set({
          status: "approved",
          reviewerId: ctx.user.userId,
          reviewNote: input.note ?? null,
          reviewedAt: new Date(),
        })
        .where(eq(approvalRequests.id, req.id));
      const [requester] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, req.requesterId))
        .limit(1);
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "approval.approve",
        targetType: "approval",
        targetId: req.id,
        detail: `批准審批請求 #${req.id}（${requester?.name ?? `#${req.requesterId}`}：${req.summary}）${input.note ? `，備註：${input.note}` : ""}`,
      });
      return { ok: true };
    }),

  reject: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        note: z.string().trim().min(1, "拒絕要填原因").max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const req = await db.query.approvalRequests.findFirst({
        where: eq(approvalRequests.id, input.id),
      });
      if (!req) {
        throw new TRPCError({ code: "NOT_FOUND", message: "審批單唔存在" });
      }
      if (req.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已經處理咗" });
      }
      await db
        .update(approvalRequests)
        .set({
          status: "rejected",
          reviewerId: ctx.user.userId,
          reviewNote: input.note,
          reviewedAt: new Date(),
        })
        .where(eq(approvalRequests.id, req.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "approval.reject",
        targetType: "approval",
        targetId: req.id,
        detail: `拒絕審批請求 #${req.id}（${req.summary}），原因：${input.note}`,
      });
      return { ok: true };
    }),
});
