// 生產環境開機自動初始化數據庫：
// 1. 建 enum + 表（全部 idempotent —— CREATE ... IF NOT EXISTS）
// 2. 種子數據（admin 帳號 + 6 件商品，已存在就 skip）
// 咁樣 Render 全新 PostgreSQL 一開機就即用得，唔使人手跑 migration。
import { Pool } from "pg";
import { env } from "./lib/env";
import { getDb } from "./queries/connection";
import { users, products, sfStations } from "@db/schema";
import { hashPassword } from "./auth";
import { SF_STATIONS } from "./data/sfStations";
// v2.1.0：全量官方清單（HK 1654／MO 51，2026-09-29 抽取）；表空時 seed 全量，樣例清單留作 fallback 參考
import { SF_STATIONS_FULL } from "./data/sfStationsFull";
// v2.2.2：順豐官方坐標快照（2026-09-30 抓取）——boot 時回填 lat IS NULL 嘅行，
// 新部署唔使等每日 sfSync 先用到 GPS 最近站點（老闆投訴「按 GPS 完全搵唔到」）
import { SF_STATION_COORDS } from "./data/sfStationCoords";
import { nameVariants } from "./sfSync";

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
  -- 2026-10-09（訪客購買）：userId nullable——訪客單＝NULL（FK 保留，有值必對到 users.id）
  "userId" bigint REFERENCES users(id),
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

-- 直接促銷同意（2026-08-05 Glo 要求，PDPO 第 6A 部）：註冊頁剔選先算同意，
-- 預設 false（沉默唔當同意）；舊會員一律 false/NULL＝未同意，唔會收到促銷電郵
ALTER TABLE users ADD COLUMN IF NOT EXISTS "marketingOptIn" boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "marketingOptInAt" timestamp;

-- 推廣同意「已表態」時間（2026-08-06 Glo 要求，三態制）：NULL＝未表態；
-- 舊會員（2026-08-05 或之前註冊）未表態登入會彈一次窗逼揀，揀完寫入時間唔再彈
ALTER TABLE users ADD COLUMN IF NOT EXISTS "marketingPromptedAt" timestamp;

-- 會員預設取貨方式（2026-08-08 Glo 要求）：送貨上門／順豐站／智能櫃＋站點（選填）；
-- 註冊同會員中心可設，結帳自動帶入。舊會員預設 address＝送貨上門，唔使 backfill
ALTER TABLE users ADD COLUMN IF NOT EXISTS "deliveryMethod" varchar(16) NOT NULL DEFAULT 'address';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "pickupPoint" varchar(255);

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

-- Airwallex 網上付款（2026-09）：付款渠道（manual＝手動過數，舊單自動落入；
-- airwallex＝網上已付款）＋ PaymentIntent ID＋收款時間（webhook 確認後寫入）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paymentChannel" varchar(16) NOT NULL DEFAULT 'manual';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "airwallexIntentId" varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "paidAt" timestamp;

-- WMS↔官網原路退款（2026-09 F7）：退款狀態機（none＝冇退款，舊單自動落入；
-- pending 審批中／refunded Airwallex 已退／manual 人手退款／rejected／failed）＋
-- 退款金額（整數港元，同 total 一個單位）＋退款時間＋Airwallex Refund ID＋原因／失敗訊息
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "refundStatus" varchar(16) NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "refundAmount" integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "refundedAt" timestamp;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "airwallexRefundId" varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "refundNote" text;

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

-- 直播場次商品（2026-09-29 F8）：liveDate＝YYYYMMDD、liveSession＝'1','2'…
ALTER TABLE products ADD COLUMN IF NOT EXISTS "liveDate" varchar(8);
ALTER TABLE products ADD COLUMN IF NOT EXISTS "liveSession" varchar(16);

-- WMS 批量上架批次（2026-09-29 F8）：一次過上架成批直播貨，全程留底
-- （欄位同 db/schema.ts 逐字對齊：liveDate/liveSession nullable——rejected 批都照記日期場次；
--   定時下架落 products，batch 表唔留 delistAt）
CREATE TABLE IF NOT EXISTS "listingBatches" (
  id serial PRIMARY KEY,
  "batchNo" varchar(32) NOT NULL UNIQUE,
  "liveDate" varchar(8),
  "liveSession" varchar(16),
  status varchar(16) NOT NULL,
  "itemCount" integer NOT NULL DEFAULT 0,
  "requestedBy" varchar(255),
  "reviewedBy" varchar(255),
  "reviewNote" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "listingBatchItems" (
  id serial PRIMARY KEY,
  "batchId" integer NOT NULL REFERENCES "listingBatches"(id),
  sku varchar(64) NOT NULL,
  name varchar(255),
  price integer,
  "discountPrice" integer,
  stock integer,
  sizes varchar(255),
  category varchar(32),
  "imageUrl" varchar(512),
  "productId" integer,
  status varchar(16) NOT NULL DEFAULT 'pending',
  error text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listingbatchitems_batch ON "listingBatchItems" ("batchId");

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

-- 員工敏感操作審批請求（2026-08-06 Glo 要求）：見 schema.ts approvalRequests 註解
CREATE TABLE IF NOT EXISTS "approvalRequests" (
  id serial PRIMARY KEY,
  "requesterId" integer NOT NULL,
  action varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  summary text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  "reviewerId" integer,
  "reviewNote" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "reviewedAt" timestamp
);
CREATE INDEX IF NOT EXISTS approvalrequests_status_idx ON "approvalRequests" (status);
CREATE INDEX IF NOT EXISTS approvalrequests_requester_idx ON "approvalRequests" ("requesterId");

-- 商品圖片檔案庫（2026-08-06 Glo 要求：WMS 補舊訂單圖用——商品刪咗都仲要查到圖）：
-- 見 schema.ts productImageArchive 註解；由 products create/update/remove 歸檔維護
CREATE TABLE IF NOT EXISTS "productImageArchive" (
  sku varchar(64) PRIMARY KEY,
  "imageUrls" jsonb NOT NULL,
  "productName" varchar(255),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

-- 2026-08-04（Glo 要求）：迎新優惠碼 WELLCOMEYOU——全單 92 折（percent 8 ＝ 減 8%）、
-- 無最低消費門檻、每個帳號限用一次；ON CONFLICT 唔郁後台之後嘅任何改動（停用/改規則都唔會被覆蓋）
INSERT INTO "promoCodes" ("code", "kind", "value", "minSpend", "perUserLimit", "usedCount", "isActive")
VALUES ('WELLCOMEYOU', 'percent', 8, 0, 1, 0, true)
ON CONFLICT ("code") DO NOTHING;

-- ===== v2.1.0（VIP+免運，2026-09-29）=====
-- users：VIP 級別＋期限＋預設收件地區／預設順豐站點（舊會員自動落入 NONE／HK，唔使 backfill）
ALTER TABLE users ADD COLUMN IF NOT EXISTS "vipTier" varchar(8) NOT NULL DEFAULT 'NONE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "vipEffectiveAt" timestamp;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "vipExpiresAt" timestamp;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "defaultRegion" varchar(8) NOT NULL DEFAULT 'HK';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "defaultStationId" varchar(64);

-- orders：收件地區（舊單自動 HK）＋順豐站點快照＋免運標記＋VIP 快照＋系統備註
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "region" varchar(8) NOT NULL DEFAULT 'HK';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "stationId" varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "stationName" varchar(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "shippingFree" boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "vipTierAtPurchase" varchar(8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "vipDiscountCents" integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "remark" text;

-- 順豐站點清單（後台可改；預設樣例喺 api/data/sfStations.ts，開機時表空就自動倒入）
CREATE TABLE IF NOT EXISTS "sfStations" (
  id varchar(64) PRIMARY KEY,
  region varchar(8) NOT NULL,
  type varchar(16) NOT NULL,
  name varchar(255) NOT NULL,
  district varchar(64),
  address text,
  active boolean NOT NULL DEFAULT true,
  "sortOrder" integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sfstations_region ON "sfStations" (region, active, "sortOrder");

-- v2.1.1（Wave 2，2026-09-30）：順豐官方網點 code——每日自動同步（api/sfSync.ts）嘅穩定鍵
ALTER TABLE "sfStations" ADD COLUMN IF NOT EXISTS "officialCode" text;
CREATE INDEX IF NOT EXISTS sfstations_officialcode ON "sfStations" ("officialCode");

-- v2.2.0（順豐站點查詢頁 /#/sf-stations）：經緯度（搵最近站點用）＋電話＋營業時間；
-- 全部 nullable，舊行留 NULL，由每日同步（api/sfSync.ts）補寫
ALTER TABLE "sfStations" ADD COLUMN IF NOT EXISTS "lat" double precision;
ALTER TABLE "sfStations" ADD COLUMN IF NOT EXISTS "lng" double precision;
ALTER TABLE "sfStations" ADD COLUMN IF NOT EXISTS "phone" varchar(32);
ALTER TABLE "sfStations" ADD COLUMN IF NOT EXISTS "serviceTime" varchar(255);

-- v2.2.0（門檻凍結＋金會員 $8000，老闆 2026-09-30 指令）：
-- users 加「升級嗰刻嘅消費門檻快照」欄（證書凍結用；nullable，降級／過期唔清）
ALTER TABLE users ADD COLUMN IF NOT EXISTS "vipThresholdCents" integer;
-- 注意：backfill UPDATE 同 vip_rules $5000→$8000 一次性更新已搬落 ensureDatabase() 逐條獨立跑
-- （2026-09-30 hotfix：呢度原本有條 UPDATE siteSettings 表名漏引號＋jsonb 全表 cast，
--   pg 多語句＝implicit transaction，一句炸成批 rollback，v2.2.0 全部新欄位建唔到 → 會員登入 500）

-- v2.2.0（直播開播推送通知，老闆 2026-09-30 指令）：
-- users 加「接收直播開播通知」同意欄（預設 false，沉默唔當同意；舊會員自動落入未同意）
ALTER TABLE users ADD COLUMN IF NOT EXISTS "livePushOptIn" boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "livePushOptInAt" timestamp;

-- Web Push 訂閱裝置表（endpoint unique；active=false＝已註銷／推送服務回 404/410 失效）
CREATE TABLE IF NOT EXISTS "pushSubscriptions" (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  "userAgent" varchar(255),
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "lastSentAt" timestamp
);
CREATE INDEX IF NOT EXISTS pushsubscriptions_user ON "pushSubscriptions" ("userId", active);

-- 直播開播推送批次表（狀態機 pending → sending → sent／failed；rejected＝主管拒絕；
-- source 'SHOP'｜'WMS'；發送失敗原因落 reviewNote）
CREATE TABLE IF NOT EXISTS "pushCampaigns" (
  id serial PRIMARY KEY,
  title varchar(128) NOT NULL,
  body text NOT NULL,
  "liveDate" varchar(32) NOT NULL,
  "liveSession" varchar(32) NOT NULL,
  url text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  source varchar(8) NOT NULL DEFAULT 'SHOP',
  "requestedBy" integer,
  "requestedByName" varchar(128),
  "reviewedBy" integer,
  "reviewedByName" varchar(128),
  "reviewNote" text,
  "sentAt" timestamp,
  "sentCount" integer,
  "failCount" integer,
  -- v2.2.2（老闆指令）：後台一掣落直播畫——endedAt 有值即唔再喺首頁/直播頁顯示
  "endedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pushcampaigns_status_sent ON "pushCampaigns" (status, "sentAt" DESC);
-- v2.2.2：舊庫補欄（CREATE TABLE IF NOT EXISTS 唔會幫現有表加欄）
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "endedAt" timestamp;
-- v2.2.16（老闆指令）：直播回顧顯示順序——細數排前；NULL＝跟 sentAt 新→舊排尾
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "replayOrder" integer;
-- v2.2.23（老闆實測：FB 縮圖喺 Render 長期摷唔到）：管理員手動上傳縮圖 path；有值優先用，冇先 /api/live-thumb 自動摷
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "thumbUrl" varchar(512);
-- v2.2.37（老闆指令）：直播推送三功能——唔送通知／直接進回顧／延長分鐘數
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "skipNotify" boolean NOT NULL DEFAULT false;
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "directReplay" boolean NOT NULL DEFAULT false;
ALTER TABLE "pushCampaigns" ADD COLUMN IF NOT EXISTS "extendedMinutes" integer NOT NULL DEFAULT 0;
-- v2.2.44（老闆指令）：Android 廠牌（sec-ch-ua-model）＋逐機推送紀錄表
ALTER TABLE "pushSubscriptions" ADD COLUMN IF NOT EXISTS "deviceModel" varchar(128);
CREATE TABLE IF NOT EXISTS "pushDeliveries" (
  id serial PRIMARY KEY,
  "subscriptionId" integer NOT NULL REFERENCES "pushSubscriptions"("id"),
  "campaignId" integer REFERENCES "pushCampaigns"("id"),
  ok boolean NOT NULL,
  reason varchar(32),
  "sentAt" timestamp NOT NULL DEFAULT now()
);
-- 中獎通知等非直播推送都落 pushDeliveries：campaignId 放 null 代表非直播推送
ALTER TABLE "pushDeliveries" ALTER COLUMN "campaignId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS pushdeliveries_subscription_sent ON "pushDeliveries" ("subscriptionId", "sentAt" DESC);
-- v2.2.46（老闆指令）：直播抽獎大輪盤——獎品池＋中獎紀錄
CREATE TABLE IF NOT EXISTS "luckyPrizes" (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  sku varchar(64) NOT NULL,
  price integer NOT NULL,
  "imagePath" varchar(512),
  "session" varchar(64) NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
-- 獎品名／圖改選填（老闆實測回饋）：imagePath 可以放 null；新增 session 分場次欄
ALTER TABLE "luckyPrizes" ALTER COLUMN "imagePath" DROP NOT NULL;
ALTER TABLE "luckyPrizes" ADD COLUMN IF NOT EXISTS "session" varchar(64) NOT NULL DEFAULT '';
-- v2.2.55（老闆指令）：獎品件數——同款 N 件可以抽 N 次；
-- 舊「一獎一單」partial unique index 已唔啱用（會擋第 2/3/4 件），drop 佢；
-- 併發防超抽改喺 adminDraw/adminDrawManual 用 pg_advisory_xact_lock 同事務數件
ALTER TABLE "luckyPrizes" ADD COLUMN IF NOT EXISTS "quantity" integer NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS luckydraws_one_active_win;
-- v2.2.53（老闆指令）：場次名持久化——空場次都留住，同事接力加獎品
CREATE TABLE IF NOT EXISTS "luckyDrawSessions" (
  id serial PRIMARY KEY,
  name varchar(64) NOT NULL UNIQUE,
  "createdBy" integer,
  "createdByName" varchar(128),
  "createdAt" timestamp NOT NULL DEFAULT now()
);
-- 舊獎品已用緊嘅場次名 backfill 入表（重複跑 ON CONFLICT 唔炸）
INSERT INTO "luckyDrawSessions" (name)
SELECT DISTINCT session FROM "luckyPrizes" WHERE session <> ''
ON CONFLICT (name) DO NOTHING;
-- v2.2.56（老闆指令）：場次手動歸檔——管理員可以將未抽晒嘅場次放入「歷史場次」
ALTER TABLE "luckyDrawSessions" ADD COLUMN IF NOT EXISTS "archivedAt" timestamp;
ALTER TABLE "luckyDrawSessions" ADD COLUMN IF NOT EXISTS "archivedByName" varchar(128);
-- v2.2.57（老闆指令）：抽中唔即時通知客人——撳「好，繼續」先發 email＋推播；null＝未通知。
-- DO block 包住：淨係「第一次加欄」嗰刻先將舊紀錄 backfill 做已通知（舊系統抽中即發）——
-- 重開再跑 column 已存在 → 唔會郁到新抽未通知嘅 pending 單
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'luckyDraws' AND column_name = 'notifiedAt'
  ) THEN
    ALTER TABLE "luckyDraws" ADD COLUMN "notifiedAt" timestamp;
    UPDATE "luckyDraws" SET "notifiedAt" = "createdAt";
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "luckyDraws" (
  id serial PRIMARY KEY,
  "prizeId" integer NOT NULL REFERENCES "luckyPrizes"("id"),
  "winnerUserId" bigint NOT NULL REFERENCES "users"("id"),
  status varchar(16) NOT NULL DEFAULT 'pending',
  "drawDate" varchar(8) NOT NULL,
  "orderId" bigint REFERENCES "orders"("id"),
  "redrawOfId" integer,
  "drawnBy" bigint,
  "drawnByName" varchar(255),
  "cancelledBy" bigint,
  "cancelNote" varchar(255),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "respondedAt" timestamp
);
CREATE INDEX IF NOT EXISTS luckydraws_date_status ON "luckyDraws" ("drawDate", status);
CREATE INDEX IF NOT EXISTS luckydraws_winner ON "luckyDraws" ("winnerUserId", status);
-- v2.2.55：luckydraws_one_active_win（一獎一單 unique）已廢——獎品有件數，同款可以抽多次；
-- 防超抽喺 router 用 advisory lock 做（見 adminDraw／adminDrawManual）
-- v2.2.48（老闆指令）：直播抽獎「自訂名單」——主管/管理員自輸客人名成名單，抽非官網會員；
-- 呢種中獎唔彈窗唔通知，admin 撳「確定」即刻起 0 元單飛 WMS 審批
CREATE TABLE IF NOT EXISTS "luckyDrawLists" (
  id serial PRIMARY KEY,
  name varchar(64) NOT NULL,
  names jsonb NOT NULL,
  "memberIds" jsonb NOT NULL DEFAULT '[]',
  "createdBy" bigint,
  "createdByName" varchar(255),
  "createdAt" timestamp NOT NULL DEFAULT now()
);
ALTER TABLE "luckyDraws" ADD COLUMN IF NOT EXISTS "winnerName" varchar(255);
ALTER TABLE "luckyDraws" ADD COLUMN IF NOT EXISTS "listId" integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'luckydraws_list_fk') THEN
    ALTER TABLE "luckyDraws" ADD CONSTRAINT luckydraws_list_fk FOREIGN KEY ("listId") REFERENCES "luckyDrawLists"(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS luckydraws_list ON "luckyDraws" ("listId");

-- ===== 訪客購買 Guest Checkout（2026-10-09）=====
-- orders.userId 放寬做 nullable：會員單照舊有值；訪客單＝NULL，客戶資料落 guest* 快照欄。
-- 全新部署上面 CREATE TABLE 已經 nullable；呢句 ALTER 專放寬現有 DB 嘅舊 NOT NULL。
ALTER TABLE orders ALTER COLUMN "userId" DROP NOT NULL;
-- 訪客快照欄（會員單全部 NULL）：落單嗰刻嘅名／電話（server normalize 純 8 位）／
-- Email（必填，寄確認信用）＋查單／付款核實 token（uuid，唔落 log）＋30 分鐘付款死線
-- （訪客單＝createdAt+30min；會員單 NULL 照行 48 小時規則）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "guestName" varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "guestPhone" varchar(32);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "guestEmail" varchar(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "guestToken" varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "expiresAt" timestamp;
-- orderSweeper 每 5 分鐘掃過期訪客單用（partial index：淨係訪客單先入）
CREATE INDEX IF NOT EXISTS orders_guest_expiry ON orders ("expiresAt") WHERE "userId" IS NULL;

-- ===== Wave 2 出貨雙向同步（2026-10-09）=====
-- 訂單全寄出時間（status 轉 'shipped' 嗰刻；取消出貨清返 NULL）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "shippedAt" timestamp;
-- orderItems 逐件出貨狀態＋取消原因＋員工更改痕跡
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "shipStatus" varchar(16) NOT NULL DEFAULT 'pending';
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "shipmentId" bigint;
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "cancelReason" text;
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "cancelledAt" timestamp;
-- v2.5.4（老闆指示 2026-10-10）：同款多件部分取消 — cancelledQty = 已取消件數（0 = 冇取消；
-- < quantity = 部分取消；= quantity 且 shipStatus=cancelled = 全取消）。WMS 回調帶 remainQty 絕對值，冪等。
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "cancelledQty" integer NOT NULL DEFAULT 0;
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "staffChangedAt" timestamp;
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "staffChangeNote" text;
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "staffChangedBy" varchar(64);
-- v2.5.5 第9版（老闆指令 2026-10-11）：「全網都要寫翻原價同優惠價」——
-- 落單嗰刻快照貨品原價（products.price；price 欄先有折扣實收價）。舊單 NULL → 顯示時當無折扣。
ALTER TABLE "orderItems" ADD COLUMN IF NOT EXISTS "originalPrice" integer;
-- 出貨批次表：一單可以分幾次出貨；emailedAt＝出貨信 debounce 10 分鐘批次寄出記錄
CREATE TABLE IF NOT EXISTS "orderShipments" (
  id serial PRIMARY KEY,
  "orderId" bigint NOT NULL REFERENCES orders(id),
  "shipMethod" varchar(16) NOT NULL,
  "sfNo" varchar(64),
  "itemIds" text NOT NULL DEFAULT '[]',
  "shippedAt" timestamp NOT NULL,
  "actorName" varchar(64),
  "emailedAt" timestamp,
  "reversedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
-- 掃單器搵未寄信批次用
CREATE INDEX IF NOT EXISTS ordershipments_email ON "orderShipments" ("orderId") WHERE "emailedAt" IS NULL;

-- ===== v2.5.0 會員購物金（2026-10-09 老闆指令）=====
-- 會員購物金餘額（整數港元；舊會員自動 0）
ALTER TABLE users ADD COLUMN IF NOT EXISTS "storeCredit" integer NOT NULL DEFAULT 0;
-- 訂單用咗幾多購物金＋返還冪等鎖（NULL＝未返還）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "walletUsed" integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS "walletReturnedAt" timestamp;
-- 購物金套票（後台上架：面額／售價／排序／上下架）
CREATE TABLE IF NOT EXISTS "walletPackages" (
  id serial PRIMARY KEY,
  label varchar(64) NOT NULL,
  "creditAmount" integer NOT NULL,
  price integer NOT NULL,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
-- 充值單（30 分鐘付款期；批核先入帳）
CREATE TABLE IF NOT EXISTS "walletTopups" (
  id serial PRIMARY KEY,
  "topupNo" varchar(32) NOT NULL UNIQUE,
  "userId" bigint NOT NULL REFERENCES users(id),
  "packageId" integer,
  label varchar(64) NOT NULL,
  "creditAmount" integer NOT NULL,
  price integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending_payment',
  "paymentChannel" varchar(16) NOT NULL DEFAULT 'manual',
  "airwallexIntentId" varchar(64),
  "paidAt" timestamp,
  "proofImagePath" varchar(512),
  "approvedBy" varchar(64),
  "approvedAt" timestamp,
  "reviewNote" text,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallettopups_user ON "walletTopups" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS wallettopups_status ON "walletTopups" (status) WHERE status = 'payment_review';
-- 購物金流水賬（永久保留）：入帳／扣帳／返還每樣一列，balanceAfter 對帳用
CREATE TABLE IF NOT EXISTS "walletLedger" (
  id serial PRIMARY KEY,
  "userId" bigint NOT NULL REFERENCES users(id),
  type varchar(16) NOT NULL,
  amount integer NOT NULL,
  "balanceAfter" integer NOT NULL,
  "refType" varchar(16) NOT NULL,
  "refId" varchar(32) NOT NULL,
  note text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS walletledger_user ON "walletLedger" ("userId", "createdAt");
`;

// 將 DDL 拆成獨立語句（DO $$ ... $$ 區塊入面嘅分號唔切）：
// 2026-09-30 hotfix 教訓——pg 一個 query 行多句 SQL＝implicit transaction，
// 任何一句炸會令**成批 rollback**（當日一條 UPDATE 表名漏引號 → v2.2.0 全部新欄位建唔到）。
// 逐條獨立跑＋各自 try/catch：一句失敗唔會拖冧其他，失敗語句會喺 log 大聲列出。
function splitStatements(sqlText: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inDollar = false;
  for (let i = 0; i < sqlText.length; i++) {
    const two = sqlText.slice(i, i + 2);
    if (two === "$$") {
      inDollar = !inDollar;
      buf += two;
      i++;
      continue;
    }
    if (sqlText[i] === ";" && !inDollar) {
      stmts.push(buf);
      buf = "";
      continue;
    }
    buf += sqlText[i];
  }
  if (buf.trim()) stmts.push(buf);
  // 過濾純註解／空白「語句」（empty query 會令 pg 報錯）
  return stmts.filter((s) =>
    s.split("\n").some((l) => l.replace(/--.*$/, "").trim().length > 0),
  );
}

export async function ensureDatabase(): Promise<void> {
  const pool = new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseUrl.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
  });
  try {
    console.log("[boot-migrate] ensuring tables...");
    // 三級員工制（2026-08-06 Glo 要求）：role enum 加 supervisor。
    // ADD VALUE 唔可以同其他 SQL 夾埋一個 query（implicit transaction 會炸），要獨立跑。
    await pool.query(`ALTER TYPE role ADD VALUE IF NOT EXISTS 'supervisor';`);
    const statements = splitStatements(DDL);
    let failed = 0;
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (e) {
        failed++;
        console.error(
          `[boot-migrate] ⚠️ 語句失敗（已跳過，唔會拖冧其他語句）: ${(e as Error).message}\n----- 失敗語句 -----\n${stmt.trim().slice(0, 400)}\n-------------------`,
        );
      }
    }
    if (failed > 0) {
      console.error(`[boot-migrate] ⚠️ 共 ${failed} 條語句失敗，請即檢查以上 log`);
    } else {
      console.log("[boot-migrate] tables ok");
    }

    // ===== 數據修補（全部獨立 try/catch，失敗淨係 log，絕唔拖冧結構 migration）=====
    // v2.2.0 門檻凍結 backfill：v2.2.0 前只有銀 $3000／金 $5000 呢個歷史門檻，舊 VIP 會員補返快照
    try {
      await pool.query(`UPDATE users SET "vipThresholdCents" = 300000 WHERE "vipTier" = 'SILVER' AND "vipThresholdCents" IS NULL;`);
      await pool.query(`UPDATE users SET "vipThresholdCents" = 500000 WHERE "vipTier" = 'GOLD' AND "vipThresholdCents" IS NULL;`);
    } catch (e) {
      console.error("[boot-migrate] vipThresholdCents backfill 失敗（唔影響開機）:", (e as Error).message);
    }

    // 一次性金門檻 $5000 → $8000（老闆 2026-09-30 指令）：喺 JS 做，唔用 SQL jsonb cast——
    // siteSettings 其他行可能係純文字，SQL 全表 value::jsonb 會炸（當日第二個隱藏炸彈）。
    // 只郁仲係預設值嘅設定（老闆自己改過其他數就唔郁）。
    try {
      const r = await pool.query(`SELECT value FROM "siteSettings" WHERE key = 'vip_rules' LIMIT 1;`);
      const raw = r.rows[0]?.value;
      if (typeof raw === "string") {
        const rules = JSON.parse(raw) as Record<string, unknown>;
        if (rules && rules.goldThresholdCents === 500000) {
          rules.goldThresholdCents = 800000;
          await pool.query(
            `UPDATE "siteSettings" SET value = $1, "updatedAt" = now() WHERE key = 'vip_rules';`,
            [JSON.stringify(rules)],
          );
          console.log("[boot-migrate] 金會員門檻已由 $5000 一次性更新為 $8000");
        }
      }
    } catch (e) {
      console.error("[boot-migrate] vip_rules 門檻更新失敗（唔影響開機）:", (e as Error).message);
    }

    // ===== v2.2.2：順豐站點坐標快照回填（老闆指令「我按 GPS 佢完全搵唔到」）=====
    // 種子清單本身冇坐標，以往要等每日 sfSync 先補；新部署／同步未到時 GPS 會搵唔到任何站。
    // 做法：快照 (region,type,name) VALUES join 回填 lat/lng（順手補 phone/serviceTime），
    // 淨係填 NULL 位——sfSync 每日更新嘅 live 值永遠唔會被快照覆蓋。分 chunk 跑，一句炸唔拖冧其他。
    try {
      const CHUNK = 200;
      let filled = 0;
      for (let i = 0; i < SF_STATION_COORDS.length; i += CHUNK) {
        const slice = SF_STATION_COORDS.slice(i, i + CHUNK);
        const values: string[] = [];
        const params: unknown[] = [];
        slice.forEach((row, idx) => {
          const b = idx * 7;
          values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
          params.push(row[0], row[1], row[2], row[3], row[4], row[5] || null, row[6] || null);
        });
        const r = await pool.query(
          `UPDATE "sfStations" s
             SET lat = v.lat2::double precision, lng = v.lng2::double precision,
                 phone = COALESCE(NULLIF(s.phone, ''), v.phone),
                 "serviceTime" = COALESCE(NULLIF(s."serviceTime", ''), v.st)
            FROM (VALUES ${values.join(",")}) AS v(region, type, name, lng2, lat2, phone, st)
           WHERE s.region = v.region AND s.type = v.type AND s.name = v.name
             AND s.lat IS NULL;`,
          params,
        );
        filled += r.rowCount ?? 0;
      }
      console.log(`[boot-migrate] 順豐坐標快照回填完成：補咗 ${filled} 個站點`);
    } catch (e) {
      console.error("[boot-migrate] 順豐坐標回填失敗（唔影響開機）:", (e as Error).message);
    }

    // ===== v2.2.5：修復「預設站點指住已停用行」（老闆指令「結帳頁無用預設」）=====
    // 成因：v2.2.2 清重停用咗異體字雙胞胎種子行；會員嘅 defaultStationId 如果指住嗰啲行，
    // 結帳站點清單（只回 active）搵唔到 → 自我修復清走，睇落似「預設唔見咗」。
    // 做法：逐個 dangling 指針搵同區同類同名（含異體變體）嘅 active 行改指過去；
    // 搵唔到就唔郁（會員下次結帳揀過）。跑一次夠——siteSettings 旗標擋重複。
    try {
      const flag = await pool.query(
        `SELECT value FROM "siteSettings" WHERE key = 'defaultStationHealV2At' LIMIT 1;`,
      );
      if (flag.rowCount === 0) {
        const dangling = await pool.query(
          `SELECT u.id AS "userId", u."defaultStationId" AS sid, s.region, s.type, s.name
             FROM users u LEFT JOIN "sfStations" s ON s.id = u."defaultStationId"
            WHERE u."defaultStationId" IS NOT NULL
              AND (s.id IS NULL OR s.active = false);`,
        );
        let healed = 0;
        for (const row of dangling.rows as { userId: number; sid: string; region: string | null; type: string | null; name: string | null }[]) {
          if (!row.region || !row.type || !row.name) continue;
          // 候選唔限類型（v2.2.7）：服務點都係合法預設站；同名（含異體）就指過去
          const cands = await pool.query(
            `SELECT id, name FROM "sfStations" WHERE region = $1 AND active = true;`,
            [row.region],
          );
          const variants = new Set([row.name, ...nameVariants(row.name)]);
          const hit = (cands.rows as { id: string; name: string }[]).find(
            (cd) => variants.has(cd.name) || nameVariants(cd.name).some((v) => variants.has(v)),
          );
          if (hit) {
            await pool.query(`UPDATE users SET "defaultStationId" = $1 WHERE id = $2;`, [
              hit.id,
              row.userId,
            ]);
            healed += 1;
          }
        }
        await pool.query(
          `INSERT INTO "siteSettings" (key, value) VALUES ('defaultStationHealV2At', $1)
           ON CONFLICT (key) DO NOTHING;`,
          [new Date().toISOString()],
        );
        console.log(
          `[boot-migrate] 預設站點修復完成：${dangling.rows.length} 個斷指針，改指 ${healed} 個`,
        );
      }
    } catch (e) {
      console.error("[boot-migrate] 預設站點修復失敗（唔影響開機）:", (e as Error).message);
    }

    // 開機自檢：users 核心欄位齊唔齊，缺就喺 log 大聲叫（Render logs 一眼睇到，唔使等客人報）
    try {
      const chk = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users';`,
      );
      const cols = new Set(chk.rows.map((x: { column_name: string }) => x.column_name));
      const required = [
        "vipTier",
        "vipEffectiveAt",
        "vipExpiresAt",
        "vipThresholdCents",
        "livePushOptIn",
        "livePushOptInAt",
        "defaultRegion",
        "defaultStationId",
      ];
      const missing = required.filter((c) => !cols.has(c));
      if (missing.length > 0) {
        console.error(`[boot-migrate] ⚠️ users 表缺欄位：${missing.join(", ")}`);
      } else {
        console.log("[boot-migrate] users 核心欄位齊全");
      }
    } catch (e) {
      console.error("[boot-migrate] 自檢失敗:", (e as Error).message);
    }
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

  // v2.1.0（VIP+免運）：順豐站點表空就自動倒入預設樣例清單（api/data/sfStations.ts）。
  // 只喺「成張表空」嘅情況下 seed——後台之後嘅任何改動（改名／停用／刪除）都唔會被覆蓋；
  // 想重新導入預設清單用後台 vip.reseedDefaultStations（逐個 upsert，唔會清走自加嘅站）。
  const existingStations = await db.query.sfStations.findMany({ limit: 1 });
  if (existingStations.length === 0) {
    // v2.1.0：seed 全量官方清單（SF_STATIONS_FULL 已帶穩定 id 同 sortOrder）；失敗先落樣例清單保底
    const seedRows = (SF_STATIONS_FULL.length > 0 ? SF_STATIONS_FULL : SF_STATIONS.map((s, i) => ({ ...s, sortOrder: i })));
    await db.insert(sfStations).values(seedRows);
    console.log(`[boot-migrate] seeded ${seedRows.length} sf stations（${SF_STATIONS_FULL.length > 0 ? "全量官方清單" : "樣例清單"}）`);
  }
  console.log("[boot-migrate] done");
}
