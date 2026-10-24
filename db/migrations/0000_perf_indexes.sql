-- perf-fix（P2-3）：公開查詢＋orderSweeper 熱點補 secondary index
-- 全部 CREATE INDEX IF NOT EXISTS（冚得多次、唔會 DROP 任何嘢）；
-- 對應 db/schema.ts 嘅 index() 定義。執行：psql "$DATABASE_URL" -f db/migrations/0000_perf_indexes.sql

-- products.list / products.latest：isActive 篩＋listedDate desc 排序
CREATE INDEX IF NOT EXISTS "products_active_listed_idx" ON "products" ("isActive", "listedDate");
-- 直播場次篩選（liveDate = YYYYMMDD）
CREATE INDEX IF NOT EXISTS "products_live_date_idx" ON "products" ("liveDate");
-- orderSweeper 每 5 分鐘掃 status = pending_payment AND expiresAt < now
CREATE INDEX IF NOT EXISTS "orders_status_expires_idx" ON "orders" ("status", "expiresAt");
-- 會員「我的訂單」：userId 篩＋createdAt 新→舊
CREATE INDEX IF NOT EXISTS "orders_user_created_idx" ON "orders" ("userId", "createdAt");
