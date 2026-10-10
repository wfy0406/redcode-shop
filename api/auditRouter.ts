import { desc, lt, sql, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { auditLog, siteSettings } from "@db/schema";
import { createRouter, adminProcedure } from "./middleware";
import { z } from "zod";
import { logAudit } from "./audit";

/**
 * 操作日誌 —— admin only（最高管理員）
 * list：最新 200 條，新至舊（id desc 即時間 desc）
 *
 * 2026-10-10 老闆指示（Wave 4）：日誌保留期＋清除
 * - retention 日數存 siteSettings["auditRetentionDays"]（預設 180 日）
 * - stats：總數／最舊／最新／而家保留期，俾 admin 喺「日誌」頁睇到幾大舊
 * - setRetention：改保留期（30–3650 日），落日誌
 * - purge：即時刪走舊過保留期嘅日誌，落日誌（actor＝撳掣嘅 admin）
 * - 自動清除喺 api/auditRetention.ts（開機一次＋每日一次），唔喺呢度
 */

export const AUDIT_RETENTION_KEY = "auditRetentionDays";
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

export async function getAuditRetentionDays(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, AUDIT_RETENTION_KEY))
    .limit(1);
  const n = row ? parseInt(row.value, 10) : NaN;
  // 唔合法／未設過 → 預設 180；夾返喺 30–3650 之內防有人手多多改 DB
  if (!Number.isFinite(n)) return DEFAULT_AUDIT_RETENTION_DAYS;
  return Math.min(3650, Math.max(30, n));
}

/** 真正刪除邏輯（purge procedure 同自動清除共用）；回傳刪咗幾多條＋cutoff */
export async function purgeAuditLogOlderThan(retentionDays: number, now = new Date()): Promise<{ deleted: number; cutoff: Date }> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await db.delete(auditLog).where(lt(auditLog.createdAt, cutoff));
  const deleted = (res as unknown as { rowCount?: number }).rowCount ?? 0;
  return { deleted, cutoff };
}

export const auditRouter = createRouter({
  list: adminProcedure.query(async () => {
    const db = getDb();
    return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(200);
  }),

  // 2026-10-10（Wave 4）：日誌統計 — 總數／最舊／最新／保留期
  stats: adminProcedure.query(async () => {
    const db = getDb();
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        oldest: sql<string | null>`min(${auditLog.createdAt})`,
        newest: sql<string | null>`max(${auditLog.createdAt})`,
      })
      .from(auditLog);
    const retentionDays = await getAuditRetentionDays();
    return {
      total: row?.total ?? 0,
      oldest: row?.oldest ?? null,
      newest: row?.newest ?? null,
      retentionDays,
    };
  }),

  // 2026-10-10（Wave 4）：改保留期（30–3650 日）
  setRetention: adminProcedure
    .input(z.object({ days: z.number().int().min(30).max(3650) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db
        .insert(siteSettings)
        .values({ key: AUDIT_RETENTION_KEY, value: String(input.days), updatedAt: new Date() })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: String(input.days), updatedAt: new Date() },
        });
      await logAudit({
        actorId: ctx.user.userId,
        actorRole: "admin",
        action: "audit.retention",
        targetType: "setting",
        targetId: AUDIT_RETENTION_KEY,
        detail: `日誌保留期改做 ${input.days} 日`,
      });
      return { ok: true as const, days: input.days, retentionDays: input.days };
    }),

  // 2026-10-10（Wave 4）：立即清除舊過保留期嘅日誌
  purge: adminProcedure.mutation(async ({ ctx }) => {
    const days = await getAuditRetentionDays();
    const { deleted, cutoff } = await purgeAuditLogOlderThan(days);
    const pad = (n: number) => String(n).padStart(2, "0");
    const cut = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
    await logAudit({
      actorId: ctx.user.userId,
      actorRole: "admin",
      action: "audit.purge",
      targetType: "setting",
      targetId: AUDIT_RETENTION_KEY,
      detail: `人手清除舊日誌：刪咗 ${deleted} 條（保留 ${days} 日，cutoff ${cut}）`,
    });
    return { ok: true as const, deleted, retentionDays: days, cutoff: cut };
  }),
});
