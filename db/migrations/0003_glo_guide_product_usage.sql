-- Glo Glo 指南商品永久使用歷史（SPEC 第 3 輪「永久去重」）：gloGuideProductUsage 表＋回填。
-- 同 api/boot-migrate.ts DDL 段逐字一致（boot-migrate 係主要執行機制，全部 idempotent；
-- 呢個檔俾人手/CI 對照用）。向前相容：舊庫重跑安全，唔郁任何現有表。
-- 執行：psql "$DATABASE_URL" -f db/migrations/0003_glo_guide_product_usage.sql

-- ===== Glo Glo 指南商品永久使用歷史（SPEC 第 3 輪）=====
-- 曾屬任何指南文章嘅商品唔可以再用；productId PK 係並發重用嘅最終閘；
-- 文章改貨／刪 link／落架都唔會刪呢度嘅歷史。
CREATE TABLE IF NOT EXISTS "gloGuideProductUsage" (
  "productId" integer PRIMARY KEY,
  "firstArticleId" integer NOT NULL REFERENCES "gloGuideArticles"(id),
  "createdAt" timestamp NOT NULL DEFAULT now()
);

-- 一次性回填（idempotent）：現有指南關聯嘅商品全部補返歷史，
-- firstArticleId 取最舊嗰篇（articleId 最細）；重跑 ON CONFLICT 唔炸。
INSERT INTO "gloGuideProductUsage" ("productId", "firstArticleId", "createdAt")
SELECT DISTINCT ON ("productId") "productId", "articleId", "createdAt"
FROM "gloGuideArticleProducts"
ORDER BY "productId", "articleId"
ON CONFLICT ("productId") DO NOTHING;
