import { desc } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { auditLog } from "@db/schema";
import { createRouter, adminProcedure } from "./middleware";

/**
 * 操作日誌 —— admin only（最高管理員）
 * list：最新 200 條，新至舊（id desc 即時間 desc）
 */
export const auditRouter = createRouter({
  list: adminProcedure.query(async () => {
    const db = getDb();
    return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(200);
  }),
});
