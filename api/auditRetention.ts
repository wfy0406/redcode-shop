import { logAudit } from "./audit";
import { getAuditRetentionDays, purgeAuditLogOlderThan } from "./auditRouter";

/**
 * 2026-10-10 老闆指示（Wave 4）：操作日誌自動清除
 * 開機即刻掃一次，之後每 24 個鐘掃一次；刪走舊過保留期（siteSettings["auditRetentionDays"]，
 * 預設 180 日）嘅日誌。有刪到嘢先落日誌（actor＝系統），冇就靜靜雞唔寫。
 * 任何失敗淨係 console.error，唔會冧 server（同 orderSweeper 同一套做法）。
 */

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runPurgeOnce(): Promise<void> {
  try {
    const days = await getAuditRetentionDays();
    const { deleted, cutoff } = await purgeAuditLogOlderThan(days);
    if (deleted > 0) {
      const pad = (n: number) => String(n).padStart(2, "0");
      const cut = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
      await logAudit({
        actorRole: "system",
        actorNameFallback: "系統",
        action: "audit.purge",
        targetType: "setting",
        targetId: "auditRetentionDays",
        detail: `自動清除舊日誌：刪咗 ${deleted} 條（保留 ${days} 日，cutoff ${cut}）`,
      });
    }
  } catch (e) {
    console.error("[auditRetention] purge failed:", e);
  }
}

export function startAuditRetention(): void {
  // 開機掃一次（唔 await 住啟動流程）
  void runPurgeOnce();
  setInterval(() => {
    void runPurgeOnce();
  }, PURGE_INTERVAL_MS).unref();
}
