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

CREATE TABLE IF NOT EXISTS "praiseWall" (
  id serial PRIMARY KEY,
  image varchar(512) NOT NULL,
  caption varchar(255),
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
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
