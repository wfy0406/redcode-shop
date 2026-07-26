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
    });
    instance = drizzle(pool, { schema: fullSchema });
  }
  return instance;
}
