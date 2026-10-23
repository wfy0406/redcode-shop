/**
 * WMS → 官網貨圖庫資料 feed（2026-10-23 老闆指令：貨圖庫「官網貨圖」區用）：
 *   `POST /api/wms/photo-feed`（JSON：{secret}）—— 唯讀。
 *   回三件事：
 *     ① products：全量商品（上架中＋人手下架＋定時下架已到），連相簿 photos[]、類別、
 *        上架日期（listedDate，香港時間 YYYYMMDD）、直播場次、下架狀態；
 *     ② prizes：直播抽獎獎品池（luckyPrizes，連圖、場次標籤、件數、上架中/下架）；
 *     ③ archive：已刪商品嘅圖片檔案庫（productImageArchive）——商品刪咗圖都仲搵得返。
 * 模式照 api/wmsListing.ts：shared secret（WMS_CALLBACK_SECRET，只提 env 名，唔記值）。
 * 唯讀唔郁任何資料；金額＝整數港元，唔乘除 100；日期一律香港時間（UTC+8）。
 */
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { luckyPrizes, productImageArchive, products } from "@db/schema";

const HK_OFFSET_MS = 8 * 3600 * 1000;

/** Date → 香港時間 YYYYMMDD（貨圖庫日期 chip 用）；壞日期/空 → null */
function hkDate8(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + HK_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Date → 香港時間 ISO 顯示（下架時間用）；壞日期/空 → null */
function hkIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + HK_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

export async function wmsPhotoFeed(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  // secret 把關（同 wmsListing 嘅 checkSecret 一模一樣）
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503);
  }
  if (raw.secret !== secret) {
    return c.json({ ok: false, error: "secret 唔啱" }, 401);
  }

  const db = getDb();
  const nowMs = Date.now();

  // ① 全量商品（唔篩 isActive／定時下架——貨圖庫要睇晒舊貨）
  const prows = await db.select().from(products);
  const feedProducts = prows.map((p) => {
    const autoDelisted = Boolean(
      p.delistEnabled && p.delistAt && p.delistAt.getTime() <= nowMs,
    );
    const gallery = p.photos && p.photos.length > 0 ? p.photos : [p.image];
    return {
      sku: p.sku,
      name: p.name,
      price: p.price,
      discountPrice: p.discountPrice,
      category: p.category,
      photos: gallery,
      // 上架日期（老闆 2026-10-23：落咗架嘅圖跟返上架日期歸類）
      listedDate: hkDate8(p.listedDate),
      liveDate: p.liveDate ?? null,
      liveSession: p.liveSession ?? null,
      isActive: p.isActive,
      autoDelisted,
      delistAt: hkIso(p.delistAt),
      stock: p.stock,
    };
  });

  // ② 抽獎獎品池（連下架獎品——貨圖庫要睇返歷史獎品圖）
  const prrows = await db.select().from(luckyPrizes);
  const feedPrizes = prrows.map((pr) => ({
    id: pr.id,
    name: pr.name,
    sku: pr.sku,
    price: pr.price,
    imagePath: pr.imagePath ?? null, // null → WMS 用同 sku 商品圖頂上
    session: pr.session || null, // 場次標籤（""＝未分場）
    quantity: pr.quantity,
    active: pr.active,
    createdDate: hkDate8(pr.createdAt),
  }));

  // ③ 已刪商品圖片檔案庫（商品硬刪後最後嘅圖）
  const arows = await db.select().from(productImageArchive);
  const feedArchive = arows.map((a) => ({
    sku: a.sku,
    productName: a.productName ?? null,
    imageUrls: Array.isArray(a.imageUrls) ? (a.imageUrls as string[]) : [],
    updatedDate: hkDate8(a.updatedAt),
  }));

  console.log(
    `[photo-feed] 輸出：商品 ${feedProducts.length}｜獎品 ${feedPrizes.length}｜檔案庫 ${feedArchive.length}`,
  );
  return c.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    products: feedProducts,
    prizes: feedPrizes,
    archive: feedArchive,
  });
}
