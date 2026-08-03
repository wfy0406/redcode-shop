// 生產環境開機自動初始化數據庫：
// 1. 建 enum + 表（全部 idempotent —— CREATE ... IF NOT EXISTS）
// 2. 種子數據（admin 帳號 + 6 件商品，已存在就 skip）
// 咁樣 Render 全新 PostgreSQL 一開機就即用得，唔使人手跑 migration。
import { Pool } from "pg";
import { env } from "./lib/env";
import { getDb } from "./queries/connection";
import { users, products } from "@db/schema";
import { hashPassword } from "./auth";

const DDL = `
DO $$ BEGIN CREATE TYPE role AS ENUM ('member', 'staff', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM
  ('pending_payment', 'payment_review', 'approved', 'rejected', 'shipped', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_proof_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  phone varchar(32) NOT NULL UNIQUE,
  "passwordHash" varchar(255) NOT NULL,
  address text,
  age integer,
  role role NOT NULL DEFAULT 'member',
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  sku varchar(64) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  description text,
  image varchar(512) NOT NULL,
  price integer NOT NULL,
  "discountPrice" integer,
  sizes varchar(255),
  "listedDate" timestamp NOT NULL,
  stock integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "cartItems" (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL REFERENCES users(id),
  "productId" bigint NOT NULL REFERENCES products(id),
  size varchar(64),
  quantity integer NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cart_user_product_size
  ON "cartItems" ("userId", "productId", size);

CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  "orderNo" varchar(32) NOT NULL UNIQUE,
  "userId" bigint NOT NULL REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'pending_payment',
  total integer NOT NULL,
  address text,
  note text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "orderItems" (
  id serial PRIMARY KEY,
  "orderId" bigint NOT NULL REFERENCES orders(id),
  "productId" bigint NOT NULL REFERENCES products(id),
  "productName" varchar(255) NOT NULL,
  sku varchar(64) NOT NULL,
  size varchar(64),
  price integer NOT NULL,
  quantity integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "paymentProofs" (
  id serial PRIMARY KEY,
  "orderId" bigint NOT NULL REFERENCES orders(id),
  "imagePath" varchar(512) NOT NULL,
  status payment_proof_status NOT NULL DEFAULT 'pending',
  "reviewedBy" bigint REFERENCES users(id),
  "reviewNote" text,
  "reviewedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS category varchar(32) NOT NULL DEFAULT 'other';
ALTER TABLE products ADD COLUMN IF NOT EXISTS note varchar(512);
-- 尺寸選項總開關（冇尺寸嘅貨可以閂埋，商品頁唔會顯示尺寸揀選）
ALTER TABLE products ADD COLUMN IF NOT EXISTS "sizeEnabled" boolean NOT NULL DEFAULT true;

-- Google 登入：users.email（NULL 唔計重複，舊會員唔受影響）
ALTER TABLE users ADD COLUMN IF NOT EXISTS email varchar(255);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

-- Google 帳號連結（2026-08-04）：舊會員喺會員中心連結 Google 用；
-- unique 但 NULL 唔計（未連結嘅會員全部 NULL），一個 Google 帳號只可以綁一個會員
ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleSub" varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS users_googlesub_unique ON users ("googleSub");

-- Google 帳號資料快照（2026-08-04）：後台會員詳情顯示 Google email／名稱用；
-- 連結或 Google 登入嗰陣寫入，舊已連結會員會喺下次 Google 登入時補返
ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleEmail" varchar(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleName" varchar(255);

-- 2026-07-29：會員生日月份（選填，1–12；舊會員留空＝NULL）
ALTER TABLE users ADD COLUMN IF NOT EXISTS "birthMonth" integer;

CREATE TABLE IF NOT EXISTS "promoCodes" (
  id serial PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE,
  kind varchar(8) NOT NULL,
  value integer NOT NULL,
  "minSpend" integer NOT NULL DEFAULT 0,
  "usageLimit" integer,
  "usedCount" integer NOT NULL DEFAULT 0,
  "expiresAt" timestamp,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "promoCode" varchar(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "discountAmount" integer NOT NULL DEFAULT 0;

-- 優惠碼每人限用次數（每個帳號限用 N 次；NULL＝唔限）——2026-07-28
ALTER TABLE "promoCodes" ADD COLUMN IF NOT EXISTS "perUserLimit" integer;

-- 商品相簿（多張相；photos[0]＝封面）——2026-07-28
ALTER TABLE products ADD COLUMN IF NOT EXISTS "photos" text[];

-- 商品定時自動下架（開關＋時間；到時前台自動消失，唔使 cron）
ALTER TABLE products ADD COLUMN IF NOT EXISTS "delistEnabled" boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS "delistAt" timestamp;

-- 訂單取貨方式（順豐站／智能櫃自取，選填；預設 address 送到府上）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "deliveryMethod" varchar(16) NOT NULL DEFAULT 'address';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "pickupPoint" varchar(255);

CREATE TABLE IF NOT EXISTS "praiseWall" (
  id serial PRIMARY KEY,
  image varchar(512) NOT NULL,
  caption varchar(255),
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "siteSettings" (
  key varchar(64) PRIMARY KEY,
  value text NOT NULL,
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "wmsSyncLog" (
  id serial PRIMARY KEY,
  "orderId" bigint NOT NULL REFERENCES orders(id),
  "proofId" bigint,
  "lineCount" integer NOT NULL DEFAULT 0,
  "okCount" integer NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'pending',
  "webhookOrderIds" text,
  "lastError" text,
  attempts integer NOT NULL DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wmssync_order ON "wmsSyncLog" ("orderId");

CREATE TABLE IF NOT EXISTS "auditLog" (
  id serial PRIMARY KEY,
  "actorId" bigint,
  "actorName" varchar(255) NOT NULL,
  "actorRole" varchar(16) NOT NULL,
  action varchar(64) NOT NULL,
  "targetType" varchar(32),
  "targetId" varchar(64),
  detail text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auditlog_created ON "auditLog" ("createdAt" DESC);

-- 忘記密碼 email 驗證碼（2026-08-04）：6 位碼存 hash，10 分鐘有效，最多試 5 次
CREATE TABLE IF NOT EXISTS "passwordResetCodes" (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL,
  "codeHash" varchar(255) NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "usedAt" timestamp,
  attempts integer NOT NULL DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prc_email_created ON "passwordResetCodes" (email, "createdAt" DESC);
`;

export async function ensureDatabase(): Promise<void> {
  const pool = new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseUrl.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
  });
  try {
    console.log("[boot-migrate] ensuring tables...");
    await pool.query(DDL);
    console.log("[boot-migrate] tables ok");
  } finally {
    await pool.end();
  }

  // 種子數據（同 db/seed.ts 一樣，但唔會 process.exit）
  const db = getDb();

  const existingAdmin = await db.query.users.findFirst({
    where: (t, { eq }) => eq(t.phone, "00000000"),
  });
  if (!existingAdmin) {
    await db.insert(users).values({
      name: "管理員",
      phone: "00000000",
      passwordHash: hashPassword("admin123"),
      role: "admin",
    });
    console.log("[boot-migrate] created admin account (phone 00000000)");
  }

  const existingProducts = await db.query.products.findMany();
  if (existingProducts.length === 0) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await db.insert(products).values([
      { sku: "RC-KNIT-001", name: "粉色針織開衫外套", description: "柔軟針織面料，百搭開衫剪裁，春秋必備單品。", image: "/product-1.jpg", price: 268, discountPrice: 228, sizes: "S,M,L", category: "top", listedDate: new Date(now - 1 * day), stock: 30 },
      { sku: "RC-TOP-002", name: "白色雪紡荷葉邊恤衫", description: "輕盈雪紡配荷葉邊細節，斯文又顯氣質。", image: "/product-2.jpg", price: 198, sizes: "S,M,L", category: "top", listedDate: new Date(now - 2 * day), stock: 25 },
      { sku: "RC-DRESS-003", name: "黑色顯瘦連身裙", description: "修身剪裁黑色連身裙，顯瘦百搭，返工出街都得。", image: "/product-3.jpg", price: 328, discountPrice: 288, sizes: "S,M,L,XL", category: "dress", listedDate: new Date(now - 3 * day), stock: 18 },
      { sku: "RC-PANTS-004", name: "高腰闊腳長褲", description: "高腰剪裁拉長比例，闊腳設計舒適有型。", image: "/product-4.jpg", price: 238, sizes: "S,M,L", category: "pants", listedDate: new Date(now - 5 * day), stock: 20 },
      { sku: "RC-SKIRT-005", name: "紫色碎花半身裙", description: "浪漫紫色碎花，A字裙擺，夏日小清新之選。", image: "/product-5.jpg", price: 188, sizes: "S,M,L", category: "dress", listedDate: new Date(now - 7 * day), stock: 22 },
      { sku: "RC-SWEAT-006", name: "奶油白 oversize 衛衣", description: "奶油白寬鬆版型衛衣，舒適保暖，慵懶風必備。", image: "/product-6.jpg", price: 228, category: "top", listedDate: new Date(now - 10 * day), stock: 35 },
    ]);
    console.log("[boot-migrate] created 6 products");
  }
  console.log("[boot-migrate] done");
}
