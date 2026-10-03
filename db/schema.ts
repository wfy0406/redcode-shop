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
  jsonb,
  doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 2026-08-06：enum 加咗 supervisor（主管）；DB 已 ALTER TYPE，schema 要跟返
export const roleEnum = pgEnum("role", ["member", "staff", "supervisor", "admin"]);

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
  // 預設取貨方式（2026-08-08 Glo 要求）：address 送貨上門（用上面 address 欄）／
  // sf_station 順豐站／sf_locker 智能櫃（站點名稱/編號落 pickupPoint，選填）。
  // 註冊同會員中心可設，結帳自動帶入（客人照樣可以改）；舊會員預設 address＝送貨上門。
  deliveryMethod: varchar("deliveryMethod", { length: 16 }).notNull().default("address"),
  pickupPoint: varchar("pickupPoint", { length: 255 }),
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
  // ===== v2.1.0（VIP+免運）=====
  // VIP 級別：'NONE'（普通會員）｜'SILVER'（銀）｜'GOLD'（金）。
  // 由 api/vip.ts recomputeVipTier 按「本年度已付款訂單總額」自動升級；
  // 期限＝生效日起 vip.durationMonths 個月（預設 12）；過期後按當年消費重判。
  // 後台亦可以 adminSetVipTier 手動改級（審計留底）。
  vipTier: varchar("vipTier", { length: 8 }).notNull().default("NONE"),
  vipEffectiveAt: timestamp("vipEffectiveAt"),
  vipExpiresAt: timestamp("vipExpiresAt"),
  // v2.2.0 門檻凍結（老闆 2026-09-30 指令）：升級嗰刻嘅年度消費門檻快照（整數仙），
  // 證書成就行用呢個——之後後台改門檻，已升級會員嘅證書唔郁；
  // 降級／過期落 NONE 唔清（歷史留念）；舊會員由 boot-migrate backfill。
  vipThresholdCents: integer("vipThresholdCents"),
  // ===== v2.2.0（直播開播推送通知，老闆 2026-09-30 指令）=====
  // 會員主動剔選「接收直播開播通知」先算 true（沉默唔當同意，跟 marketingOptIn 同款做法）；
  // 同意嗰刻記落 livePushOptInAt；會員中心／註銷訂閱後冇 active 裝置會落返 false。
  livePushOptIn: boolean("livePushOptIn").notNull().default(false),
  livePushOptInAt: timestamp("livePushOptInAt"),
  // 預設收件地區（2026-09-29 v2.1.0）：'HK' 香港｜'MO' 澳門｜'OVERSEAS' 國外；
  // 結帳自動帶入（客人照樣可以改）；舊會員預設 HK。
  defaultRegion: varchar("defaultRegion", { length: 8 }).notNull().default("HK"),
  // 預設順豐站點 ID（對 sfStations.id；揀咗自取先有意思，送貨上門留 NULL）
  defaultStationId: varchar("defaultStationId", { length: 64 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// 員工敏感操作審批請求（2026-08-06 Glo 要求）：
// 員工（staff）喺後台做五類敏感操作（會員修改／促銷電郵／打卡牆／商品增改刪／優惠碼增停）時
// 唔會即時執行，會喺度開一張 pending 單；主管/管理員喺審批中心 approve 先真正執行
// （以審批人身份經 tRPC createCaller call 返原 mutation），reject 就唔執行。
// payload 入面 input＝要執行嘅入參，before＝現狀快照（修改/刪除類先有，審批預覽對照用）。
export const approvalRequests = pgTable("approvalRequests", {
  id: serial("id").primaryKey(),
  requesterId: integer("requesterId").notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  summary: text("summary").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  reviewerId: integer("reviewerId"),
  reviewNote: text("reviewNote"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  reviewedAt: timestamp("reviewedAt"),
});

// 商品圖片檔案庫（2026-08-06 Glo 要求：WMS 補舊訂單圖用——商品就算日後刪咗，
// /api/products/:sku/images 都要繼續返到佢最後嘅圖；products 表唔夠，因為 remove 會刪 row。
// 商品 create/update/remove 時歸檔 SKU → 圖；圖片檔案本身從來唔會喺 disk 刪除）
export const productImageArchive = pgTable("productImageArchive", {
  sku: varchar("sku", { length: 64 }).primaryKey(),
  imageUrls: jsonb("imageUrls").notNull(),
  productName: varchar("productName", { length: 255 }),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// ===== WMS 批量上架（2026-09-29 F8）：WMS 主管批准後成批推落官網嘅紀錄 =====
// 一批＝一個直播日期＋場次；逐件記 created/updated/failed（rejected 批全部留 'pending'）。
// 邊個申請、邊個批、批語，全部留底——後台「上架紀錄」卡同呢度對。
export const listingBatches = pgTable("listingBatches", {
  id: serial("id").primaryKey(),
  batchNo: varchar("batchNo", { length: 32 }).notNull().unique(), // LB20260929-483
  liveDate: varchar("liveDate", { length: 8 }), // YYYYMMDD
  liveSession: varchar("liveSession", { length: 16 }), // '1','2'…
  status: varchar("status", { length: 16 }).notNull(), // 'approved' | 'rejected'
  itemCount: integer("itemCount").notNull().default(0),
  requestedBy: varchar("requestedBy", { length: 255 }),
  reviewedBy: varchar("reviewedBy", { length: 255 }),
  reviewNote: text("reviewNote"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const listingBatchItems = pgTable("listingBatchItems", {
  id: serial("id").primaryKey(),
  batchId: integer("batchId")
    .notNull()
    .references(() => listingBatches.id),
  sku: varchar("sku", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }),
  price: integer("price"),
  discountPrice: integer("discountPrice"),
  stock: integer("stock"),
  sizes: varchar("sizes", { length: 255 }),
  category: varchar("category", { length: 32 }),
  imageUrl: varchar("imageUrl", { length: 512 }), // 最終落咗官網嘅本地 path（下載失敗就係原 URL）
  productId: integer("productId"), // upsert 成功後寫返
  status: varchar("status", { length: 16 }).notNull().default("pending"), // 'created'|'updated'|'failed'（rejected 批留 'pending'）
  error: text("error"),
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
  // 直播場次商品（2026-09-29 F8）：liveDate＝YYYYMMDD、liveSession＝'1','2'…（顯示「第N場」）；
  // 兩個都 NULL＝普通商品（非直播場次）。liveSession 唔會單獨存在——一定要配 liveDate。
  liveDate: varchar("liveDate", { length: 8 }),
  liveSession: varchar("liveSession", { length: 16 }),
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
  // 付款渠道（2026-09 Airwallex 網上付款）：'manual'＝手動過數上傳截圖（舊有全部訂單自動係呢個）；
  // 'airwallex'＝經 Airwallex Hosted Payment Page 網上已付款（webhook 確認後寫入）
  paymentChannel: varchar("paymentChannel", { length: 16 }).notNull().default("manual"),
  // Airwallex PaymentIntent ID（同內部系統對單／查數用；淨係 airwallex 單先有值）
  airwallexIntentId: varchar("airwallexIntentId", { length: 64 }),
  // 網上付款收款時間（Airwallex webhook payment_intent.succeeded 確認嗰刻寫入；手動過數單留空＝NULL）
  paidAt: timestamp("paidAt"),
  // 退款欄（2026-09 F7 WMS↔官網原路退款）：舊單 refundStatus 自動落入 'none'；
  // refundAmount 係整數港元（同 orders.total 一個單位，全鏈唔乘除 100）
  refundStatus: varchar("refundStatus", { length: 16 }).notNull().default("none"),
  // 'none'|'pending'（審批中）|'refunded'（Airwallex 已退）|'manual'（人手退款）|'rejected'|'failed'
  refundAmount: integer("refundAmount"),
  refundedAt: timestamp("refundedAt"),
  airwallexRefundId: varchar("airwallexRefundId", { length: 64 }),
  refundNote: text("refundNote"),
  // ===== v2.1.0（VIP+免運，2026-09-29）=====
  // 收件地區：'HK' 香港（預設；舊單自動落入）｜'MO' 澳門｜'OVERSEAS' 國外。
  // 澳門／國外單一律不包郵（順豐到付），備註會寫落 remark 並隨 WMS webhook 送出。
  region: varchar("region", { length: 8 }).notNull().default("HK"),
  // 順豐站點（自取單）：stationId 對 sfStations.id；stationName 係落單嗰刻嘅名稱快照
  // （站點清單日後改名都唔會影響歷史訂單顯示）
  stationId: varchar("stationId", { length: 64 }),
  stationName: varchar("stationName", { length: 255 }),
  // 呢張單係咪免運（server 按落單嗰刻嘅免運規則判定；true＝免運，false＝到付/不包郵）
  shippingFree: boolean("shippingFree").notNull().default(false),
  // 落單嗰刻嘅 VIP 級別快照（'NONE'|'SILVER'|'GOLD'）＋ VIP 折扣金額（整數仙）；
  // 之後會員升級／降級都唔會影響歷史訂單
  vipTierAtPurchase: varchar("vipTierAtPurchase", { length: 8 }),
  vipDiscountCents: integer("vipDiscountCents").notNull().default(0),
  // 系統備註（v2.1.0）：免運／到付／澳門單等規則備註，分號分隔；
  // 會隨 WMS order.receiveWebhook 嘅 remark 欄送出（WMS 已有現成 remark 欄，唔使改 WMS）
  remark: text("remark"),
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

// ===== v2.1.0（VIP+免運，2026-09-29）：順豐站點清單 =====
// 結帳／註冊／會員中心嘅站點下拉由呢張表出（先揀地區再揀站）；
// 站點不時有變 → 後台可以 upsert/delete；預設樣例清單喺 api/data/sfStations.ts
// （正式清單整合時倒入；admin 可以一掣重新導入預設清單）。
export const sfStations = pgTable("sfStations", {
  id: varchar("id", { length: 64 }).primaryKey(), // 例如 'HK-KLM-001'
  region: varchar("region", { length: 8 }).notNull(), // 'HK' | 'MO'
  type: varchar("type", { length: 16 }).notNull(), // 'SF_STATION' 順豐站 | 'SF_LOCKER' 智能櫃 | 'SERVICE_POINT' 服務點
  name: varchar("name", { length: 255 }).notNull(),
  district: varchar("district", { length: 64 }), // 地區分組（下拉 grouping 用）
  address: text("address"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sortOrder").notNull().default(0),
  // v2.1.1（Wave 2，2026-09-30）：順豐官方網點 code（每日自動同步嘅穩定鍵，見 api/sfSync.ts）。
  // null＝後台手加／未認親嘅種子行，同步永遠唔會郁呢啲行。
  officialCode: text("officialCode"),
  // v2.2.0（順豐站點查詢頁 /#/sf-stations）：經緯度（「打地址搵最近」Haversine 用）＋
  // 電話＋營業時間（站點 row 顯示用）；每日同步 api/sfSync.ts 寫入，舊行／後台手加行留 NULL。
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  phone: varchar("phone", { length: 32 }),
  serviceTime: varchar("serviceTime", { length: 255 }),
});

// ===== v2.2.0（直播開播推送通知，老闆 2026-09-30 指令，跨官網＋WMS）=====
// Web Push 訂閱裝置：一個會員可以綁多部裝置（每部一個 endpoint）。
// endpoint 係瀏覽器推送服務嘅私密地址——unique，**永遠唔准落 log／audit**（淨落 subscription id）。
// active=false＝已註銷／推送服務回 404/410 失效（留底唔刪行）。
export const pushSubscriptions = pgTable("pushSubscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("userId")
    .notNull()
    .references(() => users.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: varchar("userAgent", { length: 255 }),
  // v2.2.44（老闆指令：Android 要讀到廠牌）：UA Client Hints 嘅 sec-ch-ua-model。
  // Chrome 107+ 凍結咗 UA 入面嘅手機型號（得返 "K"），真型號淨係呢個 header 有；
  // server 回應加 Accept-CH 之後，同 origin request 自帶。舊綁定冇存 → null（跌返 UA 規則）。
  deviceModel: varchar("deviceModel", { length: 128 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  lastSentAt: timestamp("lastSentAt"),
});

// 直播開播推送批次：staff 申請（pending）→ 主管/管理員批准即發送；
// supervisor/admin 可以直接發送（唔經審批）。source：'SHOP'（官網後台）｜'WMS'（WMS 官網中心）。
// 狀態機：pending → sending → sent／failed；rejected＝主管拒絕。
// sentCount/failCount 係發送結果計數；失敗原因（例如未設 VAPID）落 reviewNote。
export const pushCampaigns = pgTable("pushCampaigns", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 128 }).notNull(),
  body: text("body").notNull(),
  liveDate: varchar("liveDate", { length: 32 }).notNull(),
  liveSession: varchar("liveSession", { length: 32 }).notNull(),
  url: text("url").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  source: varchar("source", { length: 8 }).notNull().default("SHOP"),
  requestedBy: integer("requestedBy"),
  requestedByName: varchar("requestedByName", { length: 128 }),
  reviewedBy: integer("reviewedBy"),
  reviewedByName: varchar("reviewedByName", { length: 128 }),
  reviewNote: text("reviewNote"),
  sentAt: timestamp("sentAt"),
  sentCount: integer("sentCount"),
  failCount: integer("failCount"),
  // v2.2.2（老闆指令）：後台「立即落畫」——有值即停止喺首頁／直播頁顯示（批次紀錄保留）
  endedAt: timestamp("endedAt"),
  // v2.2.16（老闆指令）：直播回顧顯示順序——細數排前；NULL＝未設定（跟 sentAt 新→舊排尾）
  replayOrder: integer("replayOrder"),
  // v2.2.23（老闆實測：FB 縮圖喺 Render 長期摷唔到）：管理員手動上傳嘅縮圖 path（/uploads/...）；
  // 有值就用佢，冇先落 /api/live-thumb 自動摷圖
  thumbUrl: varchar("thumbUrl", { length: 512 }),
  // v2.2.37（老闆指令）：剔選「不發送直播通知」——照樣出現直播中，但唔送 web push
  skipNotify: boolean("skipNotify").notNull().default(false),
  // v2.2.37（老闆指令）：剔選「直接放入直播回顧」——唔送 push、唔出現直播中，直接落入回顧
  directReplay: boolean("directReplay").notNull().default(false),
  // v2.2.37（老闆指令）：直播中可自行延長，每掣 +60 分鐘（累計，上限 240）
  extendedMinutes: integer("extendedMinutes").notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// v2.2.44（老闆指令：綁定手機清單撳落去要睇到每部機嘅推送紀錄）：
// 逐部裝置逐次推送一行——成功／失敗＋原因類別，後台彈窗 50 筆一頁。
// 安全鐵律照舊：endpoint／keys 唔落呢度，淨係 subscriptionId 參照。
export const pushDeliveries = pgTable("pushDeliveries", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscriptionId")
    .notNull()
    .references(() => pushSubscriptions.id),
  campaignId: integer("campaignId")
    .notNull()
    .references(() => pushCampaigns.id),
  ok: boolean("ok").notNull(),
  // 失敗原因類別：gone（404/410 訂閱失效）／http_<code>／unknown——淨類別，唔落原文
  reason: varchar("reason", { length: 32 }),
  sentAt: timestamp("sentAt").notNull().defaultNow(),
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

export type User = typeof users.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type Product = typeof products.$inferSelect;
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
export type ProductImageArchive = typeof productImageArchive.$inferSelect;
export type ListingBatch = typeof listingBatches.$inferSelect;
export type ListingBatchItem = typeof listingBatchItems.$inferSelect;
export type SfStation = typeof sfStations.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type PushCampaign = typeof pushCampaigns.$inferSelect;
