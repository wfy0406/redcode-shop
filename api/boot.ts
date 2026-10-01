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
import { wmsReviewCallback, forwardOrderToWms } from "./wmsSync";
import { wmsRefundCallback } from "./wmsRefund";
import { listingImageUpload, wmsListingBatch } from "./wmsListing";
import { wmsLivePushApprove, wmsLivePushDelete, wmsLivePushEnd, wmsLivePushList, wmsLivePushMove, wmsLivePushPreview, wmsLivePushRequest } from "./wmsLivePush";
import { wmsMemberAdmin } from "./wmsMemberAdmin";
import { serveEmptyCartOverride, serveGlogloBannerOverride, siteAssetsStatus, uploadSiteAsset } from "./adminAssets";
import { resolveFbThumb } from "./fbVideo";
import { buildMerchantFeedXml } from "./merchantFeed";
import { env } from "./lib/env";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, productImageArchive, products, users } from "@db/schema";
import { getAirwallexConfig, retrievePaymentIntent, verifyWebhookSignature } from "./airwallex";
import { sendOrderPaidOnlineEmail, sendOrderReviewAlertEmail, orderVipEmailInfo } from "./email";
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

// WMS → 官網退款回調（2026-09 F7 原路退款；同樣 shared secret 驗證）
app.post("/api/wms/refund-callback", wmsRefundCallback);

// WMS → 官網批量上架（2026-09-29 F8 直播場次制；同樣 shared secret 驗證）：
// 手動上傳貨圖（multipart）＋ 批量推送（批准 execute／拒絕 reject）
app.post("/api/wms/listing-image", listingImageUpload);
app.post("/api/wms/listing-batch", wmsListingBatch);

// WMS → 官網直播開播推送（2026-09-30 v2.2.0 合約 §8；同樣 WMS_CALLBACK_SECRET 驗證）：
// 申請／直接發送、審批（通過即發送）、近 50 筆紀錄
app.post("/api/wms/live-push/request", wmsLivePushRequest);
app.post("/api/wms/live-push/approve", wmsLivePushApprove);
app.post("/api/wms/live-push/list", wmsLivePushList);
app.post("/api/wms/live-push/end", wmsLivePushEnd);
app.post("/api/wms/live-push/delete", wmsLivePushDelete);
app.post("/api/wms/live-push/move", wmsLivePushMove);
app.post("/api/wms/live-push/preview", wmsLivePushPreview);

// WMS → 官網會員管理（2026-09-30 v2.2.1 合約 §9；同樣 WMS_CALLBACK_SECRET 驗證）：
// 睇會員推送狀態／踢裝置／拒絕接收／設促銷同意／改 VIP 級別（升級寄證書信＋門檻快照）
app.post("/api/wms/member-admin", wmsMemberAdmin);

// Airwallex 網上付款（2026-09 F5）——兩條 route 都喺 tRPC mount 前註冊：
// ① HPP 回跳中轉：Airwallex 俾完錢會 GET 跳返呢度；因為前端係 HashRouter，
//    外層 query 到唔到 React，所以 server 302 轉去 #/payment?orderId=X&ap=done。
//    2026-09-29 三 bug hotfix：回跳同時背景向 Airwallex 主動查證 intent 狀態——
//    webhook 正常幾秒內到，但萬一遲到／漏咗（未開 webhook、設定錯、網絡抖下），
//    客人跳返嚟呢刻已經即時補狀態＋轉 WMS；唔阻跳轉，失敗淨係 log，webhook 照舊兜底。
app.get("/api/airwallex/return", (c) => {
  const orderId = c.req.query("orderId") ?? "";
  // 只收純數字 orderId，防 open redirect／query 注入
  if (!/^\d+$/.test(orderId)) {
    return c.redirect("/#/", 302);
  }
  void (async () => {
    try {
      const cfg = await getAirwallexConfig();
      if (!cfg) return;
      const db = getDb();
      const order = await db.query.orders.findFirst({
        where: eq(orders.id, Number(orderId)),
      });
      // webhook 先到（已轉態）／唔係待付款 → 唔使查
      if (!order || order.status !== "pending_payment") return;
      if (!order.airwallexIntentId) {
        console.log(`[airwallex] return 查證：訂單 ${order.orderNo} 未記 intent id，等 webhook 處理`);
        return;
      }
      const intent = await retrievePaymentIntent(cfg, order.airwallexIntentId);
      console.log(
        `[airwallex] return 查證：訂單 ${order.orderNo}，intent ${order.airwallexIntentId} 狀態 ${intent.status}`,
      );
      if (intent.status === "SUCCEEDED") {
        const handled = await handlePaidOnline(order.orderNo, intent.id, "return-verify");
        if (handled) {
          console.log(`[airwallex] return 查證確認收款：訂單 ${order.orderNo}（webhook 未到，主動補咗）`);
        }
      }
    } catch (e) {
      console.error("[airwallex] return 主動查證出錯:", e);
    }
  })().catch(() => {});
  return c.redirect(`/#/payment?orderId=${orderId}&ap=done`, 302);
});

/**
 * 網上收款確認嘅統一入口（2026-09-29 三 bug hotfix）——webhook 同 return 主動查證都用：
 * 冪等核心：conditional update 淨郁 status='pending_payment' 嘅單，郁到（第一次）先做後續
 * （審計日誌＋背景轉 WMS 官網中心＋背景寄 email）；Airwallex retry／兩路撞單郁 0 行 → 收檔。
 * source 淨係日誌標記來源。回傳 true＝今次係第一次確認（做咗嘢）。
 */
async function handlePaidOnline(
  merchantOrderId: string,
  intentId: string | null,
  source: "webhook" | "return-verify",
): Promise<boolean> {
  const db = getDb();
  const paidAt = new Date();
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
    return false;
  }
  const [paid] = updated;
  void logAudit({
    actorRole: "system",
    action: "order.paidOnline",
    targetType: "order",
    targetId: paid.orderNo,
    detail: `Airwallex 網上付款成功（訂單 ${paid.orderNo}${intentId ? `，intent ${intentId}` : ""}，來源：${source === "webhook" ? "webhook" : "return 主動查證"}），訂單轉待審批，已排程轉 WMS 官網中心`,
  });
  // 背景轉單去 WMS 官網中心（hotfix 主因：之前得截圖流程有轉，即時支付單漏咗，
  // WMS 審批中心永遠見唔到）。做法同截圖流程一致：唔阻回應；失敗淨係 log＋寫 wmsSyncLog，
  // 官網後台可以一掣重試。
  void forwardOrderToWms(paid.id)
    .then((r) =>
      console.log(
        `[airwallex] ${paid.orderNo} 轉 WMS：${r.status}（${r.okCount}/${r.lineCount}）${r.lastError ? `，${r.lastError}` : ""}`,
      ),
    )
    .catch((e) => console.error(`[airwallex] ${paid.orderNo} 轉 WMS 出錯:`, e));
  // 第一次確認先寄 email：客人「已收款」＋內部「待審批」；背景執行，失敗淨係 log，唔阻回應
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
          // v2.1.1（Wave 2）：單據顯示 VIP 級別＋VIP 折扣＋免運標示
          vip: orderVipEmailInfo(order),
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
      console.error("[airwallex] 收款後寄信出錯:", e);
    }
  })().catch((e) => console.error("[airwallex] 收款後寄信出錯:", e));
  return true;
}

// ② Webhook 收款確認：Airwallex 會 retry，所以全程冪等——conditional update
//    淨郁 status='pending_payment' 嘅單，郁到（第一次）先寄 email。
app.post("/api/airwallex/webhook", async (c) => {
  // 後台設定／env 未配置都照註冊：回 503 JSON，唔好冧 server
  const cfg = await getAirwallexConfig();
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
  // 收款確認（冪等轉態＋審計＋轉 WMS 官網中心＋寄信）統一走 handlePaidOnline，
  // 同 /api/airwallex/return 嘅主動查證匯合；Airwallex retry 撞單會郁 0 行 → alreadyHandled
  const handled = await handlePaidOnline(merchantOrderId, intentId, "webhook");
  if (!handled) {
    // 唔存在嘅單／已處理過嘅 retry：照回 200 收檔
    return c.json({ ok: true, alreadyHandled: true });
  }
  return c.json({ ok: true });
});

// 網站資產管理（staff/admin）—— 後台直接上傳 empty-cart.png / ops-template.xlsx / gloglo-3.jpg
app.get("/api/admin/site-assets", siteAssetsStatus);
app.post("/api/admin/upload-asset", uploadSiteAsset);

// 資產 runtime override：disk 有上傳版就 serve disk 版，冇就跌落 dist 靜態版
app.get("/empty-cart.png", serveEmptyCartOverride);
app.get("/gloglo-3.jpg", serveGlogloBannerOverride);

// SEO（v2.2.20）：動態 sitemap——首頁＋全部公開可見產品頁（上架中＋未自動下架）。
// 一定要註冊喺 serveStaticFiles(app) 之前，唔係會俾 SPA notFound fallback 派 HTML。
// 鐵律：任何錯誤都唔准 500——DB 讀唔到就照出淨首頁嘅 urlset；error log 遮罩網址。
app.get("/sitemap.xml", async (c) => {
  const xmlEscape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const maskForLog = (msg: string) =>
    msg.replace(/https?:\/\/[^\s)】]+/gi, "〈網址已遮罩〉").slice(0, 300);
  const homeUrl = `<url><loc>https://redcode.red/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  // v2.2.21（項目 F1）：公開靜態頁——weekly 0.6；首頁＋產品頁現有邏輯唔郁
  const staticUrls = ["/products", "/live", "/about", "/vip", "/sf-stations", "/privacy", "/terms"].map(
    (path) =>
      `<url><loc>https://redcode.red${path}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
  );
  let urls = [homeUrl, ...staticUrls].join("\n  ");
  try {
    const db = getDb();
    // 產品表冇 updatedAt 欄，lastmod 用 listedDate（上架日期，YYYY-MM-DD）
    const rows = await db
      .select({ id: products.id, listedDate: products.listedDate })
      .from(products)
      .where(
        and(
          eq(products.isActive, true),
          or(
            eq(products.delistEnabled, false),
            isNull(products.delistAt),
            gt(products.delistAt, new Date()),
          )!,
        ),
      );
    const productUrls = rows.map((p) => {
      const d = p.listedDate instanceof Date ? p.listedDate : new Date(p.listedDate);
      const lastmod = Number.isNaN(d.getTime()) ? "" : `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>`;
      return `<url><loc>${xmlEscape(`https://redcode.red/products/${p.id}`)}</loc>${lastmod}<priority>0.8</priority></url>`;
    });
    urls = [homeUrl, ...staticUrls, ...productUrls].join("\n  ");
  } catch (e) {
    console.error(
      "[sitemap] 讀產品出錯（照出淨首頁＋靜態頁版）:",
      maskForLog(e instanceof Error ? e.message : String(e)),
    );
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls}\n</urlset>`;
  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

// Google Merchant Center 產品 feed（v2.2.21 項目 F1）：RSS 2.0＋g namespace。
// 同 sitemap 一樣註冊喺 serveStaticFiles(app) 之前，唔係會俾 SPA fallback 派 HTML。
// 鐵律：壞咗回 500，但 error log 要遮罩 URL／明文。
app.get("/merchant-feed.xml", async (c) => {
  const maskForLog = (msg: string) =>
    msg.replace(/https?:\/\/[^\s)】]+/gi, "〈網址已遮罩〉").slice(0, 300);
  try {
    const xml = await buildMerchantFeedXml();
    return c.body(xml, 200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  } catch (e) {
    console.error(
      "[merchant-feed] 出 feed 失敗:",
      maskForLog(e instanceof Error ? e.message : String(e)),
    );
    return c.json({ error: "Feed temporarily unavailable" }, 500);
  }
});

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

// v2.2.21（老闆實測：直播重溫縮圖全部跌落聚光燈 poster）：按需縮圖 proxy。
// 舊做法係 server 摷 scontent CDN URL 畀客人部機直載——URL 有時效（oe/oh 參數）
// 兼 FB 對 server IP 時好時壞 → 成日 404/灰圖。而家客人部機載我哋自己域名：
// server 代摷（resolveFbThumb：oEmbed 先行，HTML og:image 兜底）→ 代載 bytes →
// in-memory cache，唔會過期。任何失敗一律 404，前端 onError 跌落 poster，
// 同舊行為一致，唔會更差。註冊一定要喺 app.all("/api/*") 同 serveStaticFiles 之前。
// 鐵律：URL／明文唔准落 log——錯誤 log 淨落原因類別＋id 長度。
const LIVE_THUMB_CACHE_CAP = 200;
const LIVE_THUMB_MAX_BYTES = 2 * 1024 * 1024; // 2MB 上限，超過即棄（防大檔拖冧 memory）
const liveThumbCache = new Map<string, { bytes: Buffer; contentType: string; at: number }>();
app.get("/api/live-thumb/:id", async (c) => {
  const id = c.req.param("id");
  // 只准數字影片 ID（5–30 位）——擋 open proxy，唔畀任咩字串變成上游摷圖目標
  if (!/^\d{5,30}$/.test(id)) {
    return c.json({ error: "Not Found" }, 404);
  }
  const hit = liveThumbCache.get(id);
  if (hit) {
    // LRU：中咗就 delete+set 搬去尾（最近用），等逐出時淨係趕最耐冇用嗰啲
    liveThumbCache.delete(id);
    liveThumbCache.set(id, hit);
    return c.body(hit.bytes, 200, {
      "Content-Type": hit.contentType,
      "Cache-Control": "public, max-age=86400",
    });
  }
  const fail = (reason: string) => {
    console.error(`[live-thumb] 摷唔到（${reason}，id 長度 ${id.length}）`);
    return c.json({ error: "Not Found" }, 404);
  };
  const url = await resolveFbThumb(id).catch(() => null);
  if (!url) return fail("no_thumb");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // 同 fbVideo 一款：扮普通瀏覽器
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return fail("upstream_http");
    // 上游 content-type 要 image/* 開頭先收，唔係就當摷唔到（防 FB 回 HTML 錯誤頁）
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return fail("bad_type");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > LIVE_THUMB_MAX_BYTES) return fail("too_big");
    // in-memory LRU：滿咗逐出最耐冇用嗰條（Map 迭代序＝插入序，第一個 key 係最舊）
    if (liveThumbCache.size >= LIVE_THUMB_CACHE_CAP) {
      const oldest = liveThumbCache.keys().next().value;
      if (oldest !== undefined) liveThumbCache.delete(oldest);
    }
    liveThumbCache.set(id, { bytes, contentType, at: Date.now() });
    return c.body(bytes, 200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    });
  } catch {
    return fail("fetch_error");
  }
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

  // v2.1.1（Wave 2）：順豐站點每日自動同步官網全量清單（boot 後 30 秒檢查，之後每 24 小時；
  // 全程 never-throw，失敗淨係 log，站點清單維持現狀）
  const { startSfSync } = await import("./sfSync");
  startSfSync();
}
