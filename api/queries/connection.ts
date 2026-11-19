import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

// ── R14（2026-11-19 安全修復）：非 localhost PostgreSQL 連線 TLS 策略 ─────────
// 舊做法：非 localhost 一律 { rejectUnauthorized: false }——TLS 有開但唔驗證證書，
// 中間人可以自簽證書攔截。而家按部署語意分層（唔好猜，由 env 話事）：
// ─ DATABASE_SSL=disable           → ssl:false（Render internal 私網等明文場景，明確 opt-out）
// ─ DATABASE_CA_CERT（PEM 內容）或 DATABASE_CA_FILE（PEM 檔案路徑）
//                                  → { rejectUnauthorized:true, ca }，錯 CA／被攔截必敗
// ─ localhost／127.0.0.1／::1      → ssl:false（本地 dev/test）
// ─ 以上都冇（非 localhost 又冇 CA）→ 保留舊行為 { rejectUnauthorized:false }＋開機警告
//    講明信任邊界（未核實部署實際加密前，唔可以靜默改做強制驗證——會整冧現有連線）。
export type DbSslConfig = false | { rejectUnauthorized: boolean; ca?: string };

export function resolveDbSslConfig(
  databaseUrl: string,
  envLike: NodeJS.ProcessEnv = process.env,
): { ssl: DbSslConfig; warning: string | null } {
  const url = databaseUrl.toLowerCase();
  if (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("[::1]")) {
    return { ssl: false, warning: null };
  }
  if (envLike.DATABASE_SSL?.trim().toLowerCase() === "disable") {
    return { ssl: false, warning: null };
  }
  const caInline = envLike.DATABASE_CA_CERT?.trim();
  if (caInline) {
    return { ssl: { rejectUnauthorized: true, ca: caInline }, warning: null };
  }
  const caFile = envLike.DATABASE_CA_FILE?.trim();
  if (caFile) {
    const ca = readFileSync(caFile, "utf8");
    return { ssl: { rejectUnauthorized: true, ca }, warning: null };
  }
  return {
    ssl: { rejectUnauthorized: false },
    warning:
      "[db] DATABASE_URL 非 localhost 但未提供 DATABASE_CA_CERT／DATABASE_CA_FILE：" +
      "TLS 未驗證證書（rejectUnauthorized:false）。如用 Render 內網明文連線，請明確設 DATABASE_SSL=disable；" +
      "否則請提供 CA 證書以開啟完整驗證。",
  };
}

let instance: NodePgDatabase<typeof fullSchema> | undefined;
let sslWarningPrinted = false;

export function getDb(): NodePgDatabase<typeof fullSchema> {
  if (!instance) {
    const { ssl, warning } = resolveDbSslConfig(env.databaseUrl);
    if (warning && !sslWarningPrinted) {
      sslWarningPrinted = true;
      console.warn(warning);
    }
    const pool = new Pool({
      connectionString: env.databaseUrl,
      ssl,
      // perf-fix（P2-2）：明示連線池——pg 預設 max:10 但冇 idle/連線超時；
      // 閒置 30s 收回、連線 10s 等唔到就 fail fast，冷啟動 spike 唔會排隊塞死
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    instance = drizzle(pool, { schema: fullSchema });
  }
  return instance;
}
