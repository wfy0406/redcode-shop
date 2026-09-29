/**
 * WMS → 官網批量上架（2026-09-29 F8 直播場次制）：
 *   `POST /api/wms/listing-image`（multipart：secret＋file）——員工手動上傳嘅貨圖，
 *     即上即存落官網 uploads（同 /api/upload 一個儲存模式），回本地 path；
 *   `POST /api/wms/listing-batch`（JSON：secret＋action＋batch）——主管批准/拒絕後
 *     成批推落官網：execute＝逐件建/更新商品（圖片落官網本地，唔准 hotlink），
 *     reject＝只記錄。
 *
 * 模式照 api/wmsRefund.ts 嘅 wmsRefundCallback（shared secret ＋ 冪等 ＋ logAudit）。
 * secret＝兩邊共用 WMS_CALLBACK_SECRET（只提 env 名，唔記值）。
 *
 * 契約（同 WMS api/listing-router.ts 逐字對齊）：
 *   batch: { batchNo, liveDate(YYYYMMDD), liveSession, delistAt?(ISO),
 *            requestedBy, reviewedBy?, reviewNote?, items[] }
 *   item:  { sku, name?, price?, discountPrice?, stock?, sizes?, category, imageUrl }
 *   - imageUrl 以 "/" 開頭＝官網本地 path（listing-image 預存）→ 直接用；
 *     否則當外連（貨圖搜尋 RCFD）→ server fetch 下載落 uploads 先用，失敗＝item failed。
 *   - 冪等：batchNo 已存在且 status='approved' → { ok:true, already:true }。
 *   - action='reject'：batch 記 'rejected'，items 全留 'pending' → { ok:true }。
 *
 * 金額＝整數港元，全鏈唔乘除 100。
 * 逐步日誌（F8 §7）：console 前綴 [listing]；業務日誌落 logAudit＋listingBatches/items 表。
 * 唔准記 secret／base64；圖片下載失敗記 URL＋HTTP 狀態。
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getDb } from "./queries/connection";
import { listingBatchItems, listingBatches, products } from "@db/schema";
import { PRODUCT_CATEGORY_VALUES } from "@contracts/types";
import { logAudit } from "./audit";
import { archiveProductImages } from "./productsRouter";

/* ---------- 上傳儲存（同 boot.ts /api/upload 一個模式） ---------- */
const UPLOAD_DIR = process.env.UPLOADS_DIR || "uploads";
const LISTING_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const MAX_LISTING_IMAGE_SIZE = 8 * 1024 * 1024; // 8MB（契約 §4.1）
const MAX_DOWNLOAD_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB（契約 §4.2 下載上限）

const CATEGORY_SET = new Set<string>(PRODUCT_CATEGORY_VALUES);

/* ---------- 型別（契約 §4.2，逐字對齊 WMS） ---------- */
type ListingItemIn = {
  sku: string;
  name?: string;
  price?: number;
  discountPrice?: number;
  stock?: number;
  sizes?: string;
  category?: string;
  imageUrl: string;
  // v2.2.2（老闆指示 2026-09-29）：上架日期 override（YYYY-MM-DD，選填）—
  // 有值＝product.listedDate 跟呢日，liveDate/liveSession 唔 set（唔入「直播日期→場次」分類，淨係按類別分）
  listedDate?: string;
};

type ListingBatchIn = {
  batchNo: string;
  liveDate: string;
  liveSession: string;
  delistAt?: string;
  requestedBy: string;
  reviewedBy?: string;
  reviewNote?: string;
  items: ListingItemIn[];
};

/** secret 把關（同 wmsRefundCallback）：未配置 503、唔啱 401；通過＝true */
function checkSecret(c: Context, got: unknown): Response | null {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503);
  }
  if (got !== secret) {
    return c.json({ ok: false, error: "secret 唔啱" }, 401);
  }
  return null;
}

/* ======================================================================
 * ① POST /api/wms/listing-image —— 手動上傳貨圖（multipart/form-data）
 * ==================================================================== */
export async function listingImageUpload(c: Context) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ ok: false, error: "body 要係 multipart/form-data" }, 400);
  }
  const denied = checkSecret(c, form.get("secret"));
  if (denied) return denied;

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: "冇 file 欄位" }, 400);
  }
  const ext = LISTING_IMAGE_TYPES[file.type];
  if (!ext) {
    return c.json({ ok: false, error: "淨係收 jpg/png/webp" }, 400);
  }
  if (file.size > MAX_LISTING_IMAGE_SIZE) {
    return c.json({ ok: false, error: "圖片大過 8MB" }, 400);
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `listing-${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(`${UPLOAD_DIR}/${filename}`, buffer);
  console.log(`[listing] 圖片上傳 ${filename} ${file.size} bytes`);
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "product.listingImage",
    targetType: "listing",
    targetId: filename,
    detail: `WMS 上架圖片上傳：${filename}（${Math.round(file.size / 1024)}KB）`,
  });
  return c.json({ ok: true, path: `/uploads/${filename}` });
}

/* ======================================================================
 * ② POST /api/wms/listing-batch —— 批量推送（execute / reject）
 * ==================================================================== */

/** 下載外連貨圖落官網 uploads（唔准 hotlink 做商品圖）；失敗 throw 畀上層逐件 catch */
async function downloadListingImage(url: string, sku: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = LISTING_IMAGE_TYPES[mime];
  if (!ext) {
    throw new Error(`唔係圖片（content-type: ${mime || "未知"}）`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error("空檔案");
  }
  if (buf.length > MAX_DOWNLOAD_IMAGE_SIZE) {
    throw new Error("圖片大過 10MB");
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `listing-${randomUUID()}${ext}`;
  await writeFile(`${UPLOAD_DIR}/${filename}`, buf);
  console.log(`[listing] 圖片下載 ${sku} 成功（${url} → /uploads/${filename}，${Math.round(buf.length / 1024)}KB）`);
  return `/uploads/${filename}`;
}

/** 逐字校驗 batch 欄位；唔啱返錯誤字串，啱返 null */
function validateBatch(b: Partial<ListingBatchIn>): string | null {
  if (!b.batchNo || typeof b.batchNo !== "string") return "冇 batchNo";
  if (!b.liveDate || !/^\d{8}$/.test(b.liveDate)) return "liveDate 格式係 YYYYMMDD";
  if (!b.liveSession || typeof b.liveSession !== "string") return "冇 liveSession";
  if (!b.requestedBy || typeof b.requestedBy !== "string") return "冇 requestedBy";
  if (!Array.isArray(b.items) || b.items.length === 0) return "items 唔可以空";
  if (b.items.length > 100) return "一批最多 100 件";
  for (const [i, it] of b.items.entries()) {
    if (!it || typeof it !== "object") return `第 ${i + 1} 件唔係物件`;
    if (!it.sku || typeof it.sku !== "string") return `第 ${i + 1} 件冇貨號`;
    if (!it.imageUrl || typeof it.imageUrl !== "string") return `第 ${i + 1} 件（${it.sku}）冇圖`;
    if (it.category && !CATEGORY_SET.has(it.category)) return `第 ${i + 1} 件（${it.sku}）類別唔啱`;
    // v2.2.2：上架日期 override 格式檢查（選填；有就一定要係 YYYY-MM-DD）
    if (it.listedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(it.listedDate)) {
      return `第 ${i + 1} 件（${it.sku}）上架日期格式係 YYYY-MM-DD`;
    }
    for (const k of ["price", "discountPrice", "stock"] as const) {
      const v = it[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        return `第 ${i + 1} 件（${it.sku}）${k} 要係非負整數`;
      }
    }
  }
  if (b.delistAt !== undefined && Number.isNaN(new Date(b.delistAt).getTime())) {
    return "delistAt 日期格式唔啱";
  }
  return null;
}

export async function wmsListingBatch(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const denied = checkSecret(c, raw.secret);
  if (denied) return denied;

  const action = raw.action;
  if (action !== "execute" && action !== "reject") {
    return c.json({ ok: false, error: "action 要係 execute 或 reject" }, 400);
  }
  const batch = (raw.batch ?? {}) as Partial<ListingBatchIn>;
  const invalid = validateBatch(batch);
  if (invalid) {
    return c.json({ ok: false, error: `batch 欄位問題：${invalid}` }, 400);
  }
  const b = batch as ListingBatchIn;
  const db = getDb();
  console.log(`[listing] 收到批次 ${b.batchNo} action=${action} ${b.items.length} 件（${b.liveDate} 第${b.liveSession}場，申請：${b.requestedBy}${b.reviewedBy ? `，審批：${b.reviewedBy}` : ""}）`);

  // 冪等：batchNo 已存在
  const existingBatch = await db.query.listingBatches.findFirst({
    where: eq(listingBatches.batchNo, b.batchNo),
  });
  if (existingBatch && existingBatch.status === "approved") {
    console.log(`[listing] 批次 ${b.batchNo} 已批准過，冪等跳過`);
    return c.json({ ok: true, already: true });
  }

  // ---------- action=reject：只記錄 ----------
  if (action === "reject") {
    if (existingBatch) {
      await db
        .update(listingBatches)
        .set({
          status: "rejected",
          reviewedBy: b.reviewedBy ?? null,
          reviewNote: b.reviewNote ?? null,
          updatedAt: new Date(),
        })
        .where(eq(listingBatches.id, existingBatch.id));
    } else {
      const [nb] = await db
        .insert(listingBatches)
        .values({
          batchNo: b.batchNo,
          liveDate: b.liveDate,
          liveSession: b.liveSession,
          status: "rejected",
          itemCount: b.items.length,
          requestedBy: b.requestedBy,
          reviewedBy: b.reviewedBy ?? null,
          reviewNote: b.reviewNote ?? null,
        })
        .returning({ id: listingBatches.id });
      await db.insert(listingBatchItems).values(
        b.items.map((it) => ({
          batchId: nb.id,
          sku: it.sku,
          name: it.name ?? null,
          price: it.price ?? null,
          discountPrice: it.discountPrice ?? null,
          stock: it.stock ?? null,
          sizes: it.sizes ?? null,
          category: it.category ?? null,
          imageUrl: it.imageUrl.slice(0, 512),
          status: "pending",
        })),
      );
    }
    console.log(`[listing] 批次 ${b.batchNo} 已記錄為拒絕（${b.items.length} 件留 pending）`);
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "product.listingBatch",
      targetType: "listing",
      targetId: b.batchNo,
      detail: `WMS 上架批次被拒絕：${b.batchNo}（${b.liveDate} 第${b.liveSession}場，${b.items.length} 件；申請：${b.requestedBy}；審批：${b.reviewedBy ?? "-"}；原因：${b.reviewNote ?? "-"}）`,
    });
    return c.json({ ok: true });
  }

  // ---------- action=execute：建/更新批次 → 逐件 upsert ----------
  let batchId: number;
  if (existingBatch) {
    batchId = existingBatch.id;
    await db
      .update(listingBatches)
      .set({
        status: "approved",
        liveDate: b.liveDate,
        liveSession: b.liveSession,
        itemCount: b.items.length,
        requestedBy: b.requestedBy,
        reviewedBy: b.reviewedBy ?? null,
        reviewNote: null,
        updatedAt: new Date(),
      })
      .where(eq(listingBatches.id, batchId));
    await db.delete(listingBatchItems).where(eq(listingBatchItems.batchId, batchId));
  } else {
    const [nb] = await db
      .insert(listingBatches)
      .values({
        batchNo: b.batchNo,
        liveDate: b.liveDate,
        liveSession: b.liveSession,
        status: "approved",
        itemCount: b.items.length,
        requestedBy: b.requestedBy,
        reviewedBy: b.reviewedBy ?? null,
      })
      .returning({ id: listingBatches.id });
    batchId = nb.id;
  }

  const delistAt = b.delistAt ? new Date(b.delistAt) : null;
  const results: { sku: string; status: string; error?: string }[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const it of b.items) {
    let itemStatus = "pending";
    let itemError: string | null = null;
    let productId: number | null = null;
    let finalImageUrl = it.imageUrl.slice(0, 512);
    try {
      // ① 圖片：本地 path 直接用；外連 → 下載落官網（失敗＝呢件 failed，唔阻成批）
      let localImage: string;
      if (it.imageUrl.startsWith("/")) {
        localImage = it.imageUrl;
      } else {
        try {
          localImage = await downloadListingImage(it.imageUrl, it.sku);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[listing] 圖片下載 ${it.sku} 失敗（${it.imageUrl}）：${msg}`);
          throw new Error(`圖片下載失敗：${msg}`);
        }
      }
      finalImageUrl = localImage.slice(0, 512);

      // ② 商品 upsert（by sku）
      // v2.2.2（老闆指示 2026-09-29）：件貨有自訂上架日期 →
      //   listedDate 跟嗰日（訂單/出貨表嘅「上架日期」就跟呢日，唔再跟直播日期）；
      //   liveDate/liveSession ＝ NULL → 唔入「商品→直播日期→場次」分類，淨係按類別分。
      // 冇自訂 → 照舊跟批次直播日期場次；新貨 listedDate＝而家。
      const overrideDate = typeof it.listedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.listedDate) ? it.listedDate : null;
      const liveFields = overrideDate
        ? { liveDate: null, liveSession: null }
        : { liveDate: b.liveDate, liveSession: b.liveSession };
      const overrideListedDate = overrideDate ? new Date(`${overrideDate}T00:00:00.000Z`) : null;
      const existing = await db.query.products.findFirst({
        where: eq(products.sku, it.sku),
      });
      if (existing) {
        // 更新：image/photos[0]/category/場次/delist 照批；name/price 等有提供先郁；isActive 重新上架
        const set: Partial<typeof products.$inferInsert> = {
          image: localImage,
          photos: [localImage],
          category: it.category ?? existing.category,
          ...liveFields,
          isActive: true,
        };
        if (overrideListedDate) set.listedDate = overrideListedDate; // v2.2.2：改咗上架日期就跟上架日期
        if (delistAt) {
          set.delistEnabled = true;
          set.delistAt = delistAt;
        }
        if (it.name !== undefined) set.name = it.name;
        if (it.price !== undefined) set.price = it.price;
        if (it.discountPrice !== undefined) set.discountPrice = it.discountPrice;
        if (it.stock !== undefined) set.stock = it.stock;
        if (it.sizes !== undefined) {
          set.sizes = it.sizes;
          set.sizeEnabled = Boolean(it.sizes);
        }
        await db.update(products).set(set).where(eq(products.id, existing.id));
        productId = existing.id;
        itemStatus = "updated";
      } else {
        // 新貨號：品名同原價必填
        if (!it.name || it.price === undefined) {
          throw new Error("新貨號需要品名同原價");
        }
        const [np] = await db
          .insert(products)
          .values({
            sku: it.sku,
            name: it.name,
            image: localImage,
            photos: [localImage],
            price: it.price,
            discountPrice: it.discountPrice ?? null,
            stock: it.stock ?? 0,
            sizes: it.sizes ?? null,
            sizeEnabled: Boolean(it.sizes),
            category: it.category ?? "other",
            ...liveFields,
            delistEnabled: Boolean(delistAt),
            delistAt,
            listedDate: overrideListedDate ?? new Date(), // v2.2.2：有自訂就跟自訂
            isActive: true,
          })
          .returning({ id: products.id });
        productId = np.id;
        itemStatus = "created";
      }
      console.log(`[listing] 商品 upsert ${it.sku} ${itemStatus} productId=${productId}`);
      // ③ 圖片歸檔（WMS 補舊單圖保險，同 productsRouter 建/改商品一樣要入 archive）
      await archiveProductImages(it.sku, it.name ?? existing?.name ?? null, localImage, [localImage]);
      okCount += 1;
    } catch (e) {
      itemStatus = "failed";
      itemError = e instanceof Error ? e.message : String(e);
      failCount += 1;
      console.error(`[listing] 商品 upsert ${it.sku} 失敗：${itemError}`);
    }
    await db.insert(listingBatchItems).values({
      batchId,
      sku: it.sku,
      name: it.name ?? null,
      price: it.price ?? null,
      discountPrice: it.discountPrice ?? null,
      stock: it.stock ?? null,
      sizes: it.sizes ?? null,
      category: it.category ?? null,
      imageUrl: finalImageUrl,
      productId,
      status: itemStatus,
      error: itemError,
    });
    results.push({ sku: it.sku, status: itemStatus, ...(itemError ? { error: itemError } : {}) });
  }

  console.log(`[listing] 批次完成 ${b.batchNo} 成功${okCount} 失敗${failCount}`);
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "product.listingBatch",
    targetType: "listing",
    targetId: b.batchNo,
    detail: `WMS 上架批次已執行：${b.batchNo}（${b.liveDate} 第${b.liveSession}場；成功 ${okCount} 件／失敗 ${failCount} 件；申請：${b.requestedBy}；審批：${b.reviewedBy ?? "-"}${delistAt ? `；定時下架：${delistAt.toISOString()}` : ""}）`,
  });
  return c.json({ ok: true, results });
}
