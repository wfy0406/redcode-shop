-- Glo Glo 精選配搭指南（SPEC v1）：gloGuide 四表＋索引。
-- 同 api/boot-migrate.ts DDL 段逐字一致（boot-migrate 係主要執行機制，全部 idempotent）。
-- 執行：psql "$DATABASE_URL" -f db/migrations/0001_glo_guide.sql

-- ===== Glo Glo 精選配搭指南（SPEC v1）=====
CREATE TABLE IF NOT EXISTS "gloGuideArticles" (
  id serial PRIMARY KEY,
  "publicId" varchar(36) NOT NULL,
  slug varchar(180) NOT NULL,
  title varchar(255) NOT NULL,
  body text NOT NULL,
  theme varchar(255) NOT NULL,
  "themeKey" varchar(180) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  source varchar(8) NOT NULL DEFAULT 'manual',
  "generationStatus" varchar(16) NOT NULL DEFAULT 'idle',
  "generationError" text,
  "weatherSnapshot" jsonb,
  "modelImage" varchar(512),
  "createdById" integer,
  "createdByName" varchar(128),
  "reviewedById" integer,
  "reviewedByName" varchar(128),
  "reviewedAt" timestamp,
  "rejectionReason" text,
  "publishedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gloguidearticles_publicid ON "gloGuideArticles" ("publicId");
CREATE UNIQUE INDEX IF NOT EXISTS gloguidearticles_slug ON "gloGuideArticles" (slug);
CREATE INDEX IF NOT EXISTS gloguidearticles_status_published ON "gloGuideArticles" (status, "publishedAt");

CREATE TABLE IF NOT EXISTS "gloGuideArticleProducts" (
  id serial PRIMARY KEY,
  "articleId" integer NOT NULL REFERENCES "gloGuideArticles"(id),
  "productId" integer NOT NULL,
  position integer NOT NULL,
  "sourceImageSnapshot" varchar(512),
  "productNameSnapshot" varchar(255),
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gloguidearticleproducts_article_product ON "gloGuideArticleProducts" ("articleId", "productId");
CREATE UNIQUE INDEX IF NOT EXISTS gloguidearticleproducts_article_position ON "gloGuideArticleProducts" ("articleId", position);

CREATE TABLE IF NOT EXISTS "gloGuideImages" (
  id serial PRIMARY KEY,
  "publicId" varchar(36) NOT NULL,
  "articleId" integer NOT NULL REFERENCES "gloGuideArticles"(id),
  "productId" integer,
  path varchar(512),
  "sourceProductImage" varchar(512),
  "providerJobId" varchar(160),
  status varchar(16) NOT NULL DEFAULT 'queued',
  "reviewStatus" varchar(16) NOT NULL DEFAULT 'pending',
  error text,
  position integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  width integer,
  height integer,
  "reviewedById" integer,
  "reviewedByName" varchar(128),
  "reviewedAt" timestamp,
  "deletedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gloguideimages_publicid ON "gloGuideImages" ("publicId");
CREATE INDEX IF NOT EXISTS gloguideimages_article ON "gloGuideImages" ("articleId");

CREATE TABLE IF NOT EXISTS "gloGuideJobs" (
  id serial PRIMARY KEY,
  "publicId" varchar(36) NOT NULL,
  "articleId" integer NOT NULL REFERENCES "gloGuideArticles"(id),
  "imageId" integer,
  kind varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  "idempotencyKey" varchar(128) NOT NULL,
  "providerJobId" varchar(160),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  payload jsonb,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "completedAt" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS gloguidejobs_publicid ON "gloGuideJobs" ("publicId");
CREATE UNIQUE INDEX IF NOT EXISTS gloguidejobs_idempotency ON "gloGuideJobs" ("idempotencyKey");
CREATE INDEX IF NOT EXISTS gloguidejobs_article ON "gloGuideJobs" ("articleId");
