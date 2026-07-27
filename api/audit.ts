import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { auditLog, users } from "@db/schema";

/**
 * 審計日誌（fire-and-forget）：全站關鍵改動都記低，俾 admin 喺後台「日誌」頁翻查。
 * 寫唔入都唔會影響主流程（淨係 console.error）。
 * actorName 按 actorId 即時查 users 表；查唔到（例如帳號之後畀人刪咗）就用 fallback。
 */

type AuditEntry = {
  actorId?: number | null;
  actorRole: string; // admin / staff / member / system
  actorNameFallback?: string;
  action: string; // 例如 order.create / member.remove / product.update
  targetType?: string; // order / product / member / promo / praise / setting / staff
  targetId?: string | number;
  detail?: string;
};

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = getDb();
    let actorName = entry.actorNameFallback ?? "系統";
    if (entry.actorId != null) {
      const [u] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, entry.actorId))
        .limit(1);
      if (u) actorName = u.name;
    }
    await db.insert(auditLog).values({
      actorId: entry.actorId ?? null,
      actorName,
      actorRole: entry.actorRole,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      detail: entry.detail ?? null,
    });
  } catch (e) {
    console.error("[audit] log failed:", e);
  }
}
