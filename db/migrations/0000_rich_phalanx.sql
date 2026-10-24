CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'payment_review', 'approved', 'rejected', 'shipped', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_proof_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('member', 'staff', 'supervisor', 'admin');--> statement-breakpoint
CREATE TABLE "approvalRequests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requesterId" integer NOT NULL,
	"action" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reviewerId" integer,
	"reviewNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"reviewedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "auditLog" (
	"id" serial PRIMARY KEY NOT NULL,
	"actorId" bigint,
	"actorName" varchar(255) NOT NULL,
	"actorRole" varchar(16) NOT NULL,
	"action" varchar(64) NOT NULL,
	"targetType" varchar(32),
	"targetId" varchar(64),
	"detail" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cartItems" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"productId" bigint NOT NULL,
	"size" varchar(64),
	"quantity" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listingBatchItems" (
	"id" serial PRIMARY KEY NOT NULL,
	"batchId" integer NOT NULL,
	"sku" varchar(64) NOT NULL,
	"name" varchar(255),
	"price" integer,
	"discountPrice" integer,
	"stock" integer,
	"sizes" varchar(255),
	"category" varchar(32),
	"imageUrl" varchar(512),
	"productId" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listingBatches" (
	"id" serial PRIMARY KEY NOT NULL,
	"batchNo" varchar(32) NOT NULL,
	"liveDate" varchar(8),
	"liveSession" varchar(16),
	"status" varchar(16) NOT NULL,
	"itemCount" integer DEFAULT 0 NOT NULL,
	"requestedBy" varchar(255),
	"reviewedBy" varchar(255),
	"reviewNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "listingBatches_batchNo_unique" UNIQUE("batchNo")
);
--> statement-breakpoint
CREATE TABLE "luckyDrawLists" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"names" jsonb NOT NULL,
	"memberIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdBy" bigint,
	"createdByName" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "luckyDrawSessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"createdBy" integer,
	"createdByName" varchar(128),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"archivedAt" timestamp,
	"archivedByName" varchar(128),
	CONSTRAINT "luckyDrawSessions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "luckyDraws" (
	"id" serial PRIMARY KEY NOT NULL,
	"prizeId" integer NOT NULL,
	"winnerUserId" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"drawDate" varchar(8) NOT NULL,
	"orderId" bigint,
	"redrawOfId" integer,
	"winnerName" varchar(255),
	"listId" integer,
	"drawnBy" bigint,
	"drawnByName" varchar(255),
	"cancelledBy" bigint,
	"cancelNote" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"respondedAt" timestamp,
	"notifiedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "luckyPrizes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"sku" varchar(64) NOT NULL,
	"price" integer NOT NULL,
	"imagePath" varchar(512),
	"session" varchar(64) DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orderItems" (
	"id" serial PRIMARY KEY NOT NULL,
	"orderId" bigint NOT NULL,
	"productId" bigint NOT NULL,
	"productName" varchar(255) NOT NULL,
	"sku" varchar(64) NOT NULL,
	"size" varchar(64),
	"price" integer NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"orderNo" varchar(32) NOT NULL,
	"userId" bigint,
	"guestName" varchar(64),
	"guestPhone" varchar(32),
	"guestEmail" varchar(255),
	"guestToken" varchar(64),
	"expiresAt" timestamp,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"total" integer NOT NULL,
	"address" text,
	"note" text,
	"promoCode" varchar(32),
	"discountAmount" integer DEFAULT 0 NOT NULL,
	"deliveryMethod" varchar(16) DEFAULT 'address' NOT NULL,
	"pickupPoint" varchar(255),
	"paymentChannel" varchar(16) DEFAULT 'manual' NOT NULL,
	"airwallexIntentId" varchar(64),
	"paidAt" timestamp,
	"refundStatus" varchar(16) DEFAULT 'none' NOT NULL,
	"refundAmount" integer,
	"refundedAt" timestamp,
	"airwallexRefundId" varchar(64),
	"refundNote" text,
	"region" varchar(8) DEFAULT 'HK' NOT NULL,
	"stationId" varchar(64),
	"stationName" varchar(255),
	"shippingFree" boolean DEFAULT false NOT NULL,
	"vipTierAtPurchase" varchar(8),
	"vipDiscountCents" integer DEFAULT 0 NOT NULL,
	"remark" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "orders_orderNo_unique" UNIQUE("orderNo")
);
--> statement-breakpoint
CREATE TABLE "passwordResetCodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"codeHash" varchar(255) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"usedAt" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paymentProofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"orderId" bigint NOT NULL,
	"imagePath" varchar(512) NOT NULL,
	"status" "payment_proof_status" DEFAULT 'pending' NOT NULL,
	"reviewedBy" bigint,
	"reviewNote" text,
	"reviewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "praiseWall" (
	"id" serial PRIMARY KEY NOT NULL,
	"image" varchar(512) NOT NULL,
	"caption" varchar(255),
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "productImageArchive" (
	"sku" varchar(64) PRIMARY KEY NOT NULL,
	"imageUrls" jsonb NOT NULL,
	"productName" varchar(255),
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"image" varchar(512) NOT NULL,
	"photos" text[],
	"price" integer NOT NULL,
	"discountPrice" integer,
	"sizes" varchar(255),
	"sizeEnabled" boolean DEFAULT true NOT NULL,
	"delistEnabled" boolean DEFAULT false NOT NULL,
	"delistAt" timestamp,
	"liveDate" varchar(8),
	"liveSession" varchar(16),
	"note" varchar(512),
	"category" varchar(32) DEFAULT 'other' NOT NULL,
	"listedDate" timestamp NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "promoCodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"value" integer NOT NULL,
	"minSpend" integer DEFAULT 0 NOT NULL,
	"usageLimit" integer,
	"perUserLimit" integer,
	"usedCount" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp,
	"isActive" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "promoCodes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pushCampaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(128) NOT NULL,
	"body" text NOT NULL,
	"liveDate" varchar(32) NOT NULL,
	"liveSession" varchar(32) NOT NULL,
	"url" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"source" varchar(8) DEFAULT 'SHOP' NOT NULL,
	"requestedBy" integer,
	"requestedByName" varchar(128),
	"reviewedBy" integer,
	"reviewedByName" varchar(128),
	"reviewNote" text,
	"sentAt" timestamp,
	"sentCount" integer,
	"failCount" integer,
	"endedAt" timestamp,
	"replayOrder" integer,
	"thumbUrl" varchar(512),
	"skipNotify" boolean DEFAULT false NOT NULL,
	"directReplay" boolean DEFAULT false NOT NULL,
	"extendedMinutes" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pushDeliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriptionId" integer NOT NULL,
	"campaignId" integer,
	"ok" boolean NOT NULL,
	"reason" varchar(32),
	"sentAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pushSubscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"userAgent" varchar(255),
	"deviceModel" varchar(128),
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastSentAt" timestamp,
	CONSTRAINT "pushSubscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "sfStations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"region" varchar(8) NOT NULL,
	"type" varchar(16) NOT NULL,
	"name" varchar(255) NOT NULL,
	"district" varchar(64),
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"officialCode" text,
	"lat" double precision,
	"lng" double precision,
	"phone" varchar(32),
	"serviceTime" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "siteSettings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(255),
	"googleSub" varchar(64),
	"googleEmail" varchar(255),
	"googleName" varchar(255),
	"passwordHash" varchar(255) NOT NULL,
	"address" text,
	"deliveryMethod" varchar(16) DEFAULT 'address' NOT NULL,
	"pickupPoint" varchar(255),
	"age" integer,
	"birthMonth" integer,
	"marketingOptIn" boolean DEFAULT false NOT NULL,
	"marketingOptInAt" timestamp,
	"marketingPromptedAt" timestamp,
	"role" "role" DEFAULT 'member' NOT NULL,
	"vipTier" varchar(8) DEFAULT 'NONE' NOT NULL,
	"vipEffectiveAt" timestamp,
	"vipExpiresAt" timestamp,
	"vipThresholdCents" integer,
	"livePushOptIn" boolean DEFAULT false NOT NULL,
	"livePushOptInAt" timestamp,
	"defaultRegion" varchar(8) DEFAULT 'HK' NOT NULL,
	"defaultStationId" varchar(64),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_googleSub_unique" UNIQUE("googleSub")
);
--> statement-breakpoint
CREATE TABLE "wmsSyncLog" (
	"id" serial PRIMARY KEY NOT NULL,
	"orderId" bigint NOT NULL,
	"proofId" bigint,
	"lineCount" integer DEFAULT 0 NOT NULL,
	"okCount" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"webhookOrderIds" text,
	"lastError" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cartItems" ADD CONSTRAINT "cartItems_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cartItems" ADD CONSTRAINT "cartItems_productId_products_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listingBatchItems" ADD CONSTRAINT "listingBatchItems_batchId_listingBatches_id_fk" FOREIGN KEY ("batchId") REFERENCES "public"."listingBatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luckyDraws" ADD CONSTRAINT "luckyDraws_prizeId_luckyPrizes_id_fk" FOREIGN KEY ("prizeId") REFERENCES "public"."luckyPrizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luckyDraws" ADD CONSTRAINT "luckyDraws_winnerUserId_users_id_fk" FOREIGN KEY ("winnerUserId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luckyDraws" ADD CONSTRAINT "luckyDraws_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luckyDraws" ADD CONSTRAINT "luckyDraws_listId_luckyDrawLists_id_fk" FOREIGN KEY ("listId") REFERENCES "public"."luckyDrawLists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderItems" ADD CONSTRAINT "orderItems_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderItems" ADD CONSTRAINT "orderItems_productId_products_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paymentProofs" ADD CONSTRAINT "paymentProofs_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paymentProofs" ADD CONSTRAINT "paymentProofs_reviewedBy_users_id_fk" FOREIGN KEY ("reviewedBy") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pushDeliveries" ADD CONSTRAINT "pushDeliveries_subscriptionId_pushSubscriptions_id_fk" FOREIGN KEY ("subscriptionId") REFERENCES "public"."pushSubscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pushDeliveries" ADD CONSTRAINT "pushDeliveries_campaignId_pushCampaigns_id_fk" FOREIGN KEY ("campaignId") REFERENCES "public"."pushCampaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pushSubscriptions" ADD CONSTRAINT "pushSubscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wmsSyncLog" ADD CONSTRAINT "wmsSyncLog_orderId_orders_id_fk" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_user_product_size" ON "cartItems" USING btree ("userId","productId","size");--> statement-breakpoint
CREATE UNIQUE INDEX "wmssync_order" ON "wmsSyncLog" USING btree ("orderId");