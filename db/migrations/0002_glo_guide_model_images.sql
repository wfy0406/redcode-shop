-- Glo Glo 指南「模特兒原圖」後台管理：gloGuideModelImages 表＋索引。
-- 同 api/boot-migrate.ts DDL 段逐字一致（boot-migrate 係主要執行機制，全部 idempotent；
-- 呢個檔俾人手/CI 對照用）。向前相容：舊庫重跑安全，唔郁任何現有表。
-- 執行：psql "$DATABASE_URL" -f db/migrations/0002_glo_guide_model_images.sql

-- ===== Glo Glo 指南模特兒原圖庫（2026-11 後台管理）=====
-- 員工上傳嘅真實授權模特兒相；path 只准 /uploads/glo-guide-models/<uuid>.<ext>（唔公開），
-- Fashn 每次用 isDefault 嗰一張，其餘備用；文章 modelImage 係快照，呢度改動唔回寫舊文章。
CREATE TABLE IF NOT EXISTS "gloGuideModelImages" (
  id serial PRIMARY KEY,
  "publicId" varchar(36) NOT NULL,
  path varchar(512) NOT NULL,
  "originalFilename" varchar(200),
  width integer NOT NULL,
  height integer NOT NULL,
  "isDefault" boolean NOT NULL DEFAULT false,
  "createdById" integer,
  "createdByName" varchar(128),
  "deletedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gloguidemodelimages_publicid ON "gloGuideModelImages" ("publicId");
-- 未刪行入面最多一張預設（partial unique；DB 層硬保證）
CREATE UNIQUE INDEX IF NOT EXISTS gloguidemodelimages_default_live ON "gloGuideModelImages" ("isDefault") WHERE "deletedAt" IS NULL AND "isDefault" = true;
CREATE INDEX IF NOT EXISTS gloguidemodelimages_live ON "gloGuideModelImages" ("deletedAt");
