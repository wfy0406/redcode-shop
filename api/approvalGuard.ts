/**
 * 員工敏感操作審批攔截（2026-08-06 Glo 要求）：
 * staff（員工）call 敏感 mutation 時唔直接執行，改為開一張 approvalRequests pending 單，
 * 等主管/管理員喺審批中心批准（以審批人身份經 tRPC createCaller 重跑原 mutation）先生效；
 * 主管/管理員 call 就回 null，照舊直接執行。員工交單會記 audit（approval.request）。
 */
import { getDb } from "./queries/connection";
import { approvalRequests } from "@db/schema";
import { logAudit } from "./audit";

export interface PendingApproval {
  pendingApproval: true;
  requestId: number;
}

/**
 * 員工 → 開審批單＋記日誌＋回 { pendingApproval: true, requestId }；
 * 主管/管理員 → 回 null（call 方照舊執行原邏輯）。
 */
export async function requestApprovalIfStaff(opts: {
  user: { userId: number; role: string };
  action: string;
  payload: Record<string, unknown>;
  summary: string;
}): Promise<PendingApproval | null> {
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
  return { pendingApproval: true, requestId: req.id };
}
