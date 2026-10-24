/**
 * 會員密碼重設共用 helper（M3 安全修復，2026-10-24 獨立覆核）：
 * staff 交審批單時明文新密碼**唔落地**——後端即場 hash，審批單淨係存
 * { id, passwordHash }；主管/管理員 approve 時用呢個 helper 驗證＋直接套用 hash，
 * 全程唔需要明文。主管/管理員直接重設（唔經審批）都行同一路徑。
 * 抽嚟呢度係避免 membersRouter ↔ approvalsRouter circular import。
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { logAudit } from "./audit";

/** auth.ts hashPassword 嘅 scrypt 格式："<saltHex32>:<hashHex128>" */
export const PASSWORD_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

/**
 * 套用已 hash 嘅新密碼落會員帳號＋記 audit。
 * 防禦性驗證：hash 格式唔啱（俾人改過 payload）／目標唔係會員 → 擋，唔會亂改員工帳號。
 */
export async function applyMemberPasswordReset(opts: {
  memberId: number;
  passwordHash: string;
  actorId: number;
  actorRole: string;
}): Promise<void> {
  if (!PASSWORD_HASH_RE.test(opts.passwordHash)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "審批資料唔完整或已被竄改，請拒絕呢張單，叫員工重新提交",
    });
  }
  const db = getDb();
  const [target] = await db
    .select({ id: users.id, role: users.role, name: users.name })
    .from(users)
    .where(eq(users.id, opts.memberId))
    .limit(1);
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
  }
  if (target.role !== "member") {
    throw new TRPCError({ code: "FORBIDDEN", message: "員工帳號請去「員工帳號」頁修改" });
  }
  await db
    .update(users)
    .set({ passwordHash: opts.passwordHash })
    .where(eq(users.id, target.id));
  void logAudit({
    actorId: opts.actorId,
    actorRole: opts.actorRole,
    action: "member.resetPassword",
    targetType: "member",
    targetId: target.id,
    detail: `重設會員「${target.name}」密碼`,
  });
}
