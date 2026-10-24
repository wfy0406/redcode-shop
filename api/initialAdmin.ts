/**
 * P0-1（2026-10 安全修復）：首次開機自動建 admin——**絕對唔准再有寫死密碼**。
 *
 * 舊做法將預設密碼寫死喺 public repo（詳情見安全審計 P0-1），任何人睇到都可以直接登入
 * 最高管理員。而家規則：
 * ─ 條件：DB 入面**冇任何 admin 帳號**先會建（唔再係「冇呢個 phone」，
 *   避免管理員後台刪咗之後下次開機又重生）；
 * ─ phone 用 `ADMIN_PHONE` env 覆寫，預設維持 "00000000"（方便現有部署遷移）；
 * ─ 密碼用 `ADMIN_INITIAL_PASSWORD` env；未設 → 32-byte 隨機密碼，
 *   **一次性打印落啟動 log**（附「請即刻登入修改」提示），唔會再印第二次。
 * boot-migrate 同 db/seed.ts 共用呢度，保證兩條路行為一致。
 * never-throw：失敗淨係 log，唔好拖冧開機。
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { hashPassword } from "./auth";

/** 預設管理員電話（可用 ADMIN_PHONE env 覆寫） */
export const DEFAULT_ADMIN_PHONE = "00000000";

export async function ensureInitialAdmin(): Promise<void> {
  try {
    const db = getDb();
    const anyAdmin = await db.query.users.findFirst({
      where: eq(users.role, "admin"),
      columns: { id: true },
    });
    if (anyAdmin) return;

    const phone = (process.env.ADMIN_PHONE ?? "").trim() || DEFAULT_ADMIN_PHONE;
    const fromEnv = (process.env.ADMIN_INITIAL_PASSWORD ?? "").trim();
    const password = fromEnv || randomBytes(32).toString("hex");
    await db.insert(users).values({
      name: "管理員",
      phone,
      passwordHash: hashPassword(password),
      role: "admin",
    });
    if (fromEnv) {
      console.log(
        `[boot] 已建立首個管理員帳號（phone ${phone}），密碼來自 ADMIN_INITIAL_PASSWORD env——請即刻登入修改密碼`,
      );
    } else {
      // 一次性打印：呢三行只會喺「首次開機建 admin」嗰次出現
      console.log(`[boot] ⚠️ 已建立首個管理員帳號（phone ${phone}）`);
      console.log(`[boot] ⚠️ 一次性初始密碼：${password}`);
      console.log(`[boot] ⚠️ 請即刻登入修改密碼；呢組密碼唔會再喺 log 出現第二次`);
    }
  } catch (e) {
    console.error("[boot] 建立首個管理員帳號失敗（唔影響開機）:", (e as Error).message);
  }
}
