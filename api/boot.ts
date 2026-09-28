import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appRouter } from "./router";
import { createContext } from "./context";
import { userFromAuthHeader } from "./auth";
import { exportDaily } from "./exportDaily";
import { wmsReviewCallback } from "./wmsSync";
import { serveEmptyCartOverride, serveGlogloBannerOverride, siteAssetsStatus, uploadSiteAsset } from "./adminAssets";
import { env } from "./lib/env";
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, productImageArchive, products, users } from "@db/schema";
import { getAirwallexConfig, verifyWebhookSignature } from "./airwallex";
import { sendOrderPaidOnlineEmail, sendOrderReviewAlertEmail } from "./email";
import { logAudit } from "./audit";

const app = new Hono<{ Bindings: HttpBindings }>();

// 上傳目錄：Render Persistent Disk 會 mount 去 /app/uploads（Docker WORKDIR 係 /app，
// 預設相對路徑 "uploads" 啱啱好對應；如需其他路徑用 UPLOADS_DIR 環境變數覆寫）
const UPLOAD_DIR = process.env.UPLOADS_DIR || "uploads";
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// 每日營運數據導出（xlsx 下載）——註冊喺 tRPC mount 前，確保唔會跌入 SPA fallback
app.get("/api/export/daily", exportDaily);

// WMS → 官網審批回調（shared secret 驗證；同樣喺 tRPC mount 前註冊）
app.post("/api/wms/review-callback", wmsReviewCallback);

// Airwallex 網上付款（2026-09 F5）——兩條 route 都喺 tRPC mount 前註冊：
// ① HPP 回跳中轉：Airwallex 俾完錢會 GET 跳返呢度；因為前端係 HashRouter，
//    外層 query 到唔到 React，所以 server 302 轉去 #/payment?orderId=X&ap=done。
app.get("/api/airwallex/return", (c) => {
  const orderId = c.req.query("orderId") ?? "";
  // 只收純數字 orderId，防 open redirect／query 注入
  if (!/^\d+$/.test(orderId)) {
    return c.redirect("/#/", 302);
  }
  return c.redirect(`/#/payment?orderId=${orderId}&ap=done`, 302);
});

// ② Webhook 收款確認：Airwallex 會 retry，所以全程冪等——conditional update
//    淨郁 status='pending_payment' 嘅單，郁到（第一次）先寄 email。
app.post("/api/airwallex/webhook", async (c) => {
  // env 未配置都照註冊：回 503 JSON，唔好冧 server
  const cfg = getAirwallexConfig();
  if (!cfg) {
    return c.json({ ok: false, error: "Airwallex 未配置" }, 503);
  }
  // 簽名驗證必須用**未經 parse** 嘅原始 body（官方文件：re-serialized JSON 會改 bytes 夾唔到簽名）
  const timestamp = c.req.header("x-timestamp") ?? "";
  const signature = c.req.header("x-signature") ?? "";
  const rawBody = await c.req.text();
  if (!verifyWebhookSignature(cfg.webhookSecret, timestamp, signature, rawBody)) {
    console.error("[airwallex] webhook 簽名驗證失敗");
    return c.json({ ok: false, error: "簽名驗證失敗" }, 401);
  }
  let event: { name?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  // 只處理收款成功；其他事件照回 200（唔理嘅事件唔應該畀 Airwallex 無限 retry）
  if (event?.name !== "payment_intent.succeeded") {
    return c.json({ ok: true, ignored: true });
  }
  const intent = event.data?.object ?? {};
  const merchantOrderId =
    typeof intent.merchant_order_id === "string" ? intent.merchant_order_id : "";
  const intentId = typeof intent.id === "string" ? intent.id : null;
  if (!merchantOrderId) {
    return c.json({ ok: true, ignored: true });
  }
  const db = getDb();
  const paidAt = new Date();
  // 冪等核心：where 埋 status='pending_payment'，retry／重複 event 會郁 0 行 → 唔會重複寄信
  const updated = await db
    .update(orders)
    .set({
      status: "payment_review",
      paymentChannel: "airwallex",
      airwallexIntentId: intentId,
      paidAt,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.orderNo, merchantOrderId), eq(orders.status, "pending_payment")))
    .returning({ id: orders.id, orderNo: orders.orderNo });
  if (updated.length === 0) {
    // 唔存在嘅單／已處理過嘅 retry：照回 200 收檔
    return c.json({ ok: true, alreadyHandled: true });
  }
  const [paid] = updated;
  void logAudit({
    actorRole: "system",
    action: "order.paidOnline",
    targetType: "order",
    targetId: paid.orderNo,
    detail: `Airwallex 網上付款成功（訂單 ${paid.orderNo}${intentId ? `，intent ${intentId}` : ""}），訂單轉待審批`,
  });
  // 第一次確認先寄 email：客人「已收款」＋內部「待審批」；背景執行，失敗淨係 log，唔阻 200
  void (async () => {
    try {
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, paid.id),
        with: { items: true },
      });
      if (!order) return;
      const user = await db.query.users.findFirst({
        where: eq(users.id, order.userId),
      });
      if (!user) return;
      const items = order.items.map((it) => ({
        productName: it.productName,
        size: it.size,
        price: it.price,
        quantity: it.quantity,
      }));
      const delivery = {
        method: order.deliveryMethod,
        pickupPoint: order.pickupPoint,
        address: order.address,
      };
      // 客人通知（有綁 email 先寄）
      if (user.email) {
        const r = await sendOrderPaidOnlineEmail({
          to: user.email,
          orderNo: order.orderNo,
          items,
          total: order.total,
          delivery,
          paidAt,
        });
        if (!r.ok) {
          console.error(`[email] 網上收款通知寄唔出（訂單 ${order.orderNo}）：`, r.error);
        }
      }
      // 內部待審批通知（同截圖流程匯合：同事照舊人手確認）
      const r2 = await sendOrderReviewAlertEmail({
        orderNo: order.orderNo,
        createdAt: order.createdAt,
        customerName: user.name,
        customerPhone: user.phone,
        customerEmail: user.email,
        delivery,
        note: order.note,
        promoCode: order.promoCode,
        items,
        total: order.total,
        discountAmount: order.discountAmount,
      });
      if (!r2.ok) {
        console.error(`[email] 待審批通知寄唔出（訂單 ${order.orderNo}）：`, r2.error);
      }
    } catch (e) {
      console.error("[airwallex] webhook 寄信出錯:", e);
    }
  })().catch((e) => console.error("[airwallex] webhook 寄信出錯:", e));
  return c.json({ ok: true });
});

// 網站資產管理（staff/admin）—— 後台直接上傳 empty-cart.png / ops-template.xlsx / gloglo-3.jpg
app.get("/api/admin/site-assets", siteAssetsStatus);
app.post("/api/admin/upload-asset", uploadSiteAsset);

// 資產 runtime override：disk 有上傳版就 serve disk 版，冇就跌落 dist 靜態版
app.get("/empty-cart.png", serveEmptyCartOverride);
app.get("/gloglo-3.jpg", serveGlogloBannerOverride);

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});

// Image upload (payment screenshots etc.) — requires Bearer JWT
app.post("/api/upload", async (c) => {
  const user = await userFromAuthHeader(c.req.header("authorization"));
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  const ext = ALLOWED_IMAGE_TYPES[file.type];
  if (!ext) {
    return c.json({ error: "Only jpg/png/webp images are allowed" }, 400);
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json({ error: "File too large (max 10MB)" }, 400);
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(`${UPLOAD_DIR}/${filename}`, buffer);
  return c.json({ path: `/uploads/${filename}` });
});

// Serve uploaded files（自訂 route，支援絕對路徑 UPLOAD_DIR，兼擋 path traversal）
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
app.get("/uploads/:file", async (c) => {
  const file = c.req.param("file");
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return c.json({ error: "Not Found" }, 404);
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = UPLOAD_CONTENT_TYPES[ext];
  if (!contentType) {
    return c.json({ error: "Not Found" }, 404);
  }
  try {
    const data = await readFile(path.join(UPLOAD_DIR, file));
    return c.body(data, 200, { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" });
  } catch {
    return c.json({ error: "Not Found" }, 404);
  }
});

// A-2（2026-08-06 WMS《官網→WMS對接需求》）：公開查圖 API——WMS 按貨號 SKU 拎貨品圖片完整 URL。
// 唯讀、唔使 key；photos[0]＝主圖（同封面 image 同步），冇 photos 就淨係封面一張。
app.get("/api/products/:sku/images", async (c) => {
  const sku = c.req.param("sku");
  const db = getDb();
  const base = process.env.PUBLIC_BASE_URL || "https://redcode.red";
  const [p] = await db
    .select({ image: products.image, photos: products.photos })
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  if (p) {
    const paths = p.photos && p.photos.length ? p.photos : [p.image];
    return c.json({ imageUrls: paths.map((u) => `${base}${u}`) });
  }
  // 商品已刪除（例如管理員連訂單一併清走先刪到）：去圖片檔案庫搵最後紀錄，
  // WMS 補舊訂單嘅圖唔會因為商品刪除而斷（2026-08-06 Glo 要求）
  const [a] = await db
    .select({ imageUrls: productImageArchive.imageUrls })
    .from(productImageArchive)
    .where(eq(productImageArchive.sku, sku))
    .limit(1);
  const archived = Array.isArray(a?.imageUrls) ? (a.imageUrls as string[]) : [];
  if (archived.length === 0) return c.json({ imageUrls: null }, 404);
  return c.json({ imageUrls: archived.map((u) => `${base}${u}`) });
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  const { ensureDatabase } = await import("./boot-migrate");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // 開機自動建表 + 種子數據（失敗唔會冧 server，淨係 log）
  ensureDatabase().catch((e) => console.error("[boot-migrate] failed:", e));

  // B-2 初次接駁（2026-08-06 WMS 建議）：一次性回填現有會員落 WMS；
  // siteSettings 旗標記低做過，之後開機自動 skip（lazy import 同其他模組一致）
  const { backfillMembersToWmsOnce } = await import("./wmsMemberSync");
  backfillMembersToWmsOnce().catch((e) => console.error("[wms] member backfill failed:", e));

  // 待付款訂單 48 小時未傳付款截圖 → 自動取消（開機掃一次，之後每 30 分鐘掃；失敗淨係 log）
  const { startOrderSweeper } = await import("./orderSweeper");
  startOrderSweeper();
}
