import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { approvalRequests, users } from "@db/schema";
import { createRouter, staffProcedure, supervisorProcedure, type AuthUser } from "./middleware";
import { logAudit } from "./audit";

/**
 * 員工敏感操作審批（2026-08-06 Glo 要求，三級員工制）
 * - 員工（staff）call 五類敏感 mutation 時，原 mutation 會先叫 openApprovalRequest 開一張
 *   pending 單（唔執行），前端收到 { pendingApproval: true, requestId } 就話「已提交審批」；
 * - 主管／管理員喺審批中心 approve：用 createCaller 以審批人身份 call 返原 mutation 執行
 *   （零邏輯重複，原 mutation 嘅 audit 照記，actor＝審批人）；
 * - 成個流程（交單／批准／拒絕）都記落操作日誌 approval.request / approve / reject。
 */

/**
 * 敏感 mutation 共用攔截（喺 input 驗證＋存在/衝突檢查之後、核心邏輯之前 call）：
 * 叫嘅人唔使判 role——staff 先會開單，其他 role 回 null（照舊直接執行）。
 * 開單成功回 requestId；payload 記低 input（要執行嘅入參）＋ before（現狀快照，審批預覽對照用）。
 */
export async function openApprovalRequest(opts: {
  user: AuthUser;
  action: string;
  payload: unknown;
  summary: string;
}): Promise<number | null> {
  if (opts.user.role !== "staff") return null;
  const db = getDb();
  const [req] = await db
    .insert(approvalRequests)
    .values({
      requesterId: opts.user.userId,
      action: opts.action,
      payload: opts.payload,
      summary: opts.summary,
    })
    .returning();
  void logAudit({
    actorId: opts.user.userId,
    actorRole: opts.user.role,
    action: "approval.request",
    targetType: "approval",
    targetId: req.id,
    detail: `員工提交審批請求 #${req.id}：${opts.summary}`,
  });
  return req.id;
}

/** 補返請求人／審批人名（一次過 inArray 查，唔 N+1） */
async function attachNames<T extends { requesterId: number; reviewerId: number | null }>(
  rows: T[],
): Promise<(T & { requesterName: string; reviewerName: string | null })[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.requesterId, ...(r.reviewerId != null ? [r.reviewerId] : [])])),
  );
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    ...r,
    requesterName: nameOf.get(r.requesterId) ?? `#${r.requesterId}`,
    reviewerName: r.reviewerId != null ? (nameOf.get(r.reviewerId) ?? `#${r.reviewerId}`) : null,
  }));
}

export const approvalsRouter = createRouter({
  /** 待審批列表（舊單優先，FIFO）——主管／管理員 */
  pendingList: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, "pending"))
      .orderBy(asc(approvalRequests.createdAt));
    return attachNames(rows);
  }),

  /** 處理紀錄（最近 50 條已批准／已拒絕，新嘅排先）——主管／管理員 */
  history: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(ne(approvalRequests.status, "pending"))
      .orderBy(desc(approvalRequests.reviewedAt))
      .limit(50);
    return attachNames(rows);
  }),

  /** 我嘅審批請求（員工睇自己最近 20 條單嘅狀態） */
  myRequests: staffProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, ctx.user.userId))
      .orderBy(desc(approvalRequests.id))
      .limit(20);
    return attachNames(rows);
  }),

  /**
   * 批准：以審批人身份用 createCaller call 返原 mutation 真正執行。
   * 執行 throw（例如撞 email／優惠碼失效）→ 唔 update 單據，error 彈返出嚟，單保持 pending。
   */
  approve: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [req] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, input.id))
        .limit(1);
      if (!req) {
        throw new TRPCError({ code: "NOT_FOUND", message: "審批請求唔存在" });
      }
      if (req.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已處理" });
      }
      // lazy import 避免 circular（router.ts 會 import 呢個檔）
      const { appRouter } = await import("./router");
      // ctx 帶住 req（Authorization header＝審批人），原 mutation 嘅 staff 攔截唔會觸發
      const caller = appRouter.createCaller(ctx);
      const p = req.payload as { input: any; before?: unknown };
      switch (req.action) {
        case "member.update": await caller.members.update(p.input); break;
        case "promo.sendMarketingEmail": await caller.promo.sendMarketingEmail(p.input); break;
        case "praise.create": await caller.praise.create(p.input); break;
        case "praise.update": await caller.praise.update(p.input); break;
        case "praise.remove": await caller.praise.remove(p.input); break;
        case "product.create": await caller.products.create(p.input); break;
        case "product.update": await caller.products.update(p.input); break;
        case "product.remove": await caller.products.remove(p.input); break;
        case "promoCode.create": await caller.promo.create(p.input); break;
        case "promoCode.update": await caller.promo.update(p.input); break;
        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: `未知操作 ${req.action}` });
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

  /** 拒絕：唔執行，必填原因話返俾員工知 */
  reject: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        note: z.string().trim().min(1, "拒絕要填原因").max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [req] = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, input.id))
        .limit(1);
      if (!req) {
        throw new TRPCError({ code: "NOT_FOUND", message: "審批請求唔存在" });
      }
      if (req.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢張單已處理" });
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
