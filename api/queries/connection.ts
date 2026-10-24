import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: NodePgDatabase<typeof fullSchema> | undefined;

export function getDb(): NodePgDatabase<typeof fullSchema> {
  if (!instance) {
    const pool = new Pool({
      connectionString: env.databaseUrl,
      // Render 對外連線要 SSL；local dev/test 唔使
      ssl: env.databaseUrl.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
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
