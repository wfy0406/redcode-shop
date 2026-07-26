import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { siteSettings } from "@db/schema";
import { createRouter, publicQuery, staffProcedure } from "./middleware";

/**
 * 全站文案設定（key-value）——
 * get：公開讀，但只准白名單 key（避免內部設定外洩）
 * upsert：staff/admin 寫，同白名單，value ≤ 200 字
 */
const ALLOWED_KEYS = ["products_intro_title", "products_intro_sub"] as const;
const keySchema = z.enum(ALLOWED_KEYS);

export const settingsRouter = createRouter({
  get: publicQuery
    .input(z.object({ key: keySchema }))
    .query(async ({ input }) => {
      const db = getDb();
      const row = await db.query.siteSettings.findFirst({
        where: eq(siteSettings.key, input.key),
      });
      return row ? { key: row.key, value: row.value } : null;
    }),

  upsert: staffProcedure
    .input(z.object({ key: keySchema, value: z.string().max(200, "內容最長 200 字") }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .insert(siteSettings)
        .values({ key: input.key, value: input.value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: input.value, updatedAt: new Date() },
        });
      return { ok: true as const };
    }),
});
