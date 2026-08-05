import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  bigint,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["member", "staff", "admin"]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending_payment",
  "payment_review",
  "approved",
  "rejected",
  "shipped",
  "completed",
  "cancelled",
]);

export const paymentProofStatusEnum = pgEnum("payment_proof_status", [
  "pending",
  "approved",
  "rejected",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull().unique(),
  // Google 登入用：唯一但可 NULL（電話註冊嘅舊會員冇 email）
  email: varchar("email", { length: 255 }).unique(),
  // Google 帳號連結（2026-08-04）：Google 嘅永久唯一 ID（sub claim）。
  // 舊會員喺會員中心連結 Google 後寫入；Google 登入優先用佢搵帳號（改 email 都唔會斷連結）。
  googleSub: varchar("googleSub", { length: 64 }).unique(),
  // Google 帳號資料快照（2026-08-04）：連結／登入嗰陣順手記低 Google 嘅 email 同顯示名，
  // 後台會員詳情用嚟顯示；會員喺 Google 嗰邊改咗名，下次 Google 登入會自動更新。
  googleEmail: varchar("googleEmail", { length: 255 }),
  googleName: varchar("googleName", { length: 255 }),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  address: text("address"),
  age: integer("age"),
  // 生日月份（1–12，選填；2026-07-29 加。舊會員留空＝NULL，之後可以補填）
  birthMonth: integer("birthMonth"),
  // 直接促銷同意（2026-08-05 Glo 要求，PDPO 第 6A 部）：註冊時會員主動剔選先算同意，
  // 預設 false（沉默唔當同意）；同意嗰刻記落 marketingOptInAt。
  // 舊會員全部 false/NULL＝未同意，後台促銷電郵唔會寄畀佢哋。
  marketingOptIn: boolean("marketingOptIn").notNull().default(false),
  marketingOptInAt: timestamp("marketingOptInAt"),
  // 推廣同意「已表態」時間（2026-08-06 Glo 要求，三態制）：
  // NULL＋optIn=false＋2026-08-05 或之前註冊＝「未選」，登入會彈一次窗逼揀；
  // 有值＝已表態（無論接受定唔接受），唔會再彈。唔使 backfill，舊會員自動落入未選。
  marketingPromptedAt: timestamp("marketingPromptedAt"),
  role: roleEnum("role").notNull().default("member"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  image: varchar("image", { length: 512 }).notNull(),
  // 商品相簿（多張相）：photos[0]＝封面（同 image 欄同步）；NULL/空＝得 image 一張（2026-07-28）
  photos: text("photos").array(),
  price: integer("price").notNull(),
  discountPrice: integer("discountPrice"),
  sizes: varchar("sizes", { length: 255 }),
  // 尺寸選項總開關：false = 商品頁唔顯示尺寸、落單唔使揀（袋/飾物呢類冇尺寸嘅貨用）
  sizeEnabled: boolean("sizeEnabled").notNull().default(true),
  // 定時自動下架（開關＋時間）：delistEnabled=true 兼 delistAt 到咗 → 前台自動消失（唔使 cron，查詢時判斷）
  delistEnabled: boolean("delistEnabled").notNull().default(false),
  delistAt: timestamp("delistAt"),
  note: varchar("note", { length: 512 }),
  category: varchar("category", { length: 32 }).notNull().default("other"),
  listedDate: timestamp("listedDate").notNull(),
  stock: integer("stock").notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const cartItems = pgTable(
  "cartItems",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number" })
      .notNull()
      .references(() => users.id),
    productId: bigint("productId", { mode: "number" })
      .notNull()
      .references(() => products.id),
    size: varchar("size", { length: 64 }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cart_user_product_size").on(t.userId, t.productId, t.size)],
);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNo: varchar("orderNo", { length: 32 }).notNull().unique(),
  userId: bigint("userId", { mode: "number" })
    .notNull()
    .references(() => users.id),
  status: orderStatusEnum("status").notNull().default("pending_payment"),
  total: integer("total").notNull(),
  address: text("address"),
  note: text("note"),
  promoCode: varchar("promoCode", { length: 32 }),
  discountAmount: integer("discountAmount").notNull().default(0),
  // 取貨方式：address（送貨，預設）／sf_station（順豐站）／sf_locker（智能櫃）；自取時 pickupPoint 填站點名稱/編號（選填）
  deliveryMethod: varchar("deliveryMethod", { length: 16 }).notNull().default("address"),
  pickupPoint: varchar("pickupPoint", { length: 255 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  // PostgreSQL 冇 ON UPDATE CURRENT_TIMESTAMP，updatedAt 由應用層更新時一併 set
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const orderItems = pgTable("orderItems", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number" })
    .notNull()
    .references(() => orders.id),
  productId: bigint("productId", { mode: "number" })
    .notNull()
    .references(() => products.id),
  productName: varchar("productName", { length: 255 }).notNull(),
  sku: varchar("sku", { length: 64 }).notNull(),
  size: varchar("size", { length: 64 }),
  price: integer("price").notNull(),
  quantity: integer("quantity").notNull(),
});

export const paymentProofs = pgTable("paymentProofs", {
  id: serial("id").primaryKey(),
  orderId: bigint("orderId", { mode: "number" })
    .notNull()
    .references(() => orders.id),
  imagePath: varchar("imagePath", { length: 512 }).notNull(),
  status: paymentProofStatusEnum("status").notNull().default("pending"),
  reviewedBy: bigint("reviewedBy", { mode: "number" }).references(() => users.id),
  reviewNote: text("reviewNote"),
  reviewedAt: timestamp("reviewedAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const promoCodes = pgTable("promoCodes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  kind: varchar("kind", { length: 8 }).notNull(), // 'percent' | 'fixed'
  value: integer("value").notNull(),
  minSpend: integer("minSpend").notNull().default(0),
  usageLimit: integer("usageLimit"),
  // 每人限用次數（每個帳號限用 N 次；NULL＝唔限）——2026-07-28 新增
  perUserLimit: integer("perUserLimit"),
  usedCount: integer("usedCount").notNull().default(0),
  expiresAt: timestamp("expiresAt"),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const praiseWall = pgTable("praiseWall", {
  id: serial("id").primaryKey(),
  image: varchar("image", { length: 512 }).notNull(),
  caption: varchar("caption", { length: 255 }),
  sortOrder: integer("sortOrder").notNull().default(0),
  isActive: boolean("isActive").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// 全站 key-value 文案設定（白名單 key 由 api/settingsRouter.ts 把關）
export const siteSettings = pgTable("siteSettings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// 官網 → WMS 訂單同步記錄（一單一列；webhookOrderIds 係 JSON array，同 orderItems 對位，
// null 元素代表嗰件未成功——重試只補未成功嘅件，WMS 唔會重複出單）
export const wmsSyncLog = pgTable(
  "wmsSyncLog",
  {
    id: serial("id").primaryKey(),
    orderId: bigint("orderId", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    proofId: bigint("proofId", { mode: "number" }),
    lineCount: integer("lineCount").notNull().default(0),
    okCount: integer("okCount").notNull().default(0),
    // pending / sent / partial / failed / disabled（未設 WMS_API_KEY）
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    webhookOrderIds: text("webhookOrderIds"),
    lastError: text("lastError"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wmssync_order").on(t.orderId)],
);

// 忘記密碼 email 驗證碼（2026-08-04）：6 位碼只存 hash，10 分鐘有效，最多試 5 次。
// 同一 email 可有多列（重新索取會作廢舊碼），用嗰陣攞最新未用嘅一列。
export const passwordResetCodes = pgTable("passwordResetCodes", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  codeHash: varchar("codeHash", { length: 255 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// 全站操作日誌（admin 後台「日誌」頁用）：記低管理員／員工／會員嘅關鍵改動。
// actorId 刻意唔設 FK——人刪咗帳號，條 log 都要留底先可以追查。
export const auditLog = pgTable("auditLog", {
  id: serial("id").primaryKey(),
  actorId: bigint("actorId", { mode: "number" }),
  actorName: varchar("actorName", { length: 255 }).notNull(),
  actorRole: varchar("actorRole", { length: 16 }).notNull(), // admin / staff / member / system
  action: varchar("action", { length: 64 }).notNull(), // 例如 order.create / member.remove
  targetType: varchar("targetType", { length: 32 }),
  targetId: varchar("targetId", { length: 64 }),
  detail: text("detail"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;export type Product = typeof products.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type PaymentProof = typeof paymentProofs.$inferSelect;
export type PromoCode = typeof promoCodes.$inferSelect;
export type PraiseWallEntry = typeof praiseWall.$inferSelect;
export type SiteSetting = typeof siteSettings.$inferSelect;
export type WmsSyncLog = typeof wmsSyncLog.$inferSelect;
export type PasswordResetCode = typeof passwordResetCodes.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
