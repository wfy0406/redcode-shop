/**
 * WMS → 官網「只改已批准商品內容」批次。
 *
 * 同 /api/wms/listing-batch 完全分開：呢度唔接受圖、價錢、庫存、分類、場次、
 * 上下架或定時下架欄，亦絕對唔會新建商品。每件只可以更新 description、aiTags、
 * contentUpdatedAt；SKU／品名／sourceContentUpdatedAt 對唔到、已有其他描述、
 * 或寫後讀回唔一致，一律拒絕。
 *
 * 審批仍用 WMS_CALLBACK_SECRET；reviewedBy 必須由真實審批流程提供，程式唔會代填。
 * action=dry-run 唯讀；execute 用 listingBatches/listingBatchItems 留批次及內容快照。
 */
import { and, eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { listingBatchItems, listingBatches, products } from "@db/schema";
import { getDb } from "./queries/connection";
import { logAudit } from "./audit";
import { secretEquals } from "./wmsSecret";
import {
  aiContentGateError,
  aiTagsToJson,
  parseAiTags,
  sanitizeAiDescription,
  sanitizeAiTag,
  validateAiDescription,
  validateAiTags,
} from "./productAiContent";

const BATCH_NO_PATTERN = /^LC\d{8}-[A-Z0-9-]{1,19}$/;
const STALE_PROCESSING_MS = 120_000;

export type ProductContentItemIn = {
  sku: string;
  name: string;
  sourceContentUpdatedAt: string;
  description: string;
  aiTags: string[];
  aiContentApproved?: boolean;
};

type ProductContentBatchIn = {
  batchNo: string;
  requestedBy: string;
  reviewedBy: string;
  reviewNote?: string;
  items: ProductContentItemIn[];
};

type ProductContentRow = typeof products.$inferSelect;
type ContentResultStatus = "updated" | "unchanged" | "failed";
type ContentResult = { sku: string; status: ContentResultStatus; error?: string };

type PreparedItem = ProductContentItemIn & {
  cleanDescription: string;
  cleanTags: string[];
  sourceDate: Date;
};

function checkContentSecret(c: Context, got: unknown): Response | null {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503);
  if (!secretEquals(got, secret)) return c.json({ ok: false, error: "secret 唔啱" }, 401);
  return null;
}

function exactIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}

function validateContentBatch(value: unknown): string | null {
  if (!value || typeof value !== "object") return "冇 batch";
  const b = value as Partial<ProductContentBatchIn>;
  if (typeof b.batchNo !== "string" || !BATCH_NO_PATTERN.test(b.batchNo)) {
    return "內容批次 batchNo 格式係 LCYYYYMMDD-流水號";
  }
  if (typeof b.requestedBy !== "string" || !b.requestedBy.trim()) return "冇 requestedBy";
  if (typeof b.reviewedBy !== "string" || !b.reviewedBy.trim()) return "冇真實 reviewedBy";
  if (b.reviewNote !== undefined && typeof b.reviewNote !== "string") return "reviewNote 要係字串";
  if (!Array.isArray(b.items) || b.items.length === 0) return "items 唔可以空";
  if (b.items.length > 100) return "一批最多 100 件";
  const seen = new Set<string>();
  for (const [index, item] of b.items.entries()) {
    const prefix = `第 ${index + 1} 件`;
    if (!item || typeof item !== "object") return `${prefix}唔係物件`;
    if (typeof item.sku !== "string" || !item.sku.trim() || item.sku.length > 64) {
      return `${prefix}貨號無效`;
    }
    const skuKey = item.sku.trim().toUpperCase();
    if (seen.has(skuKey)) return `一批入面貨號 ${item.sku} 重複`;
    seen.add(skuKey);
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 255) {
      return `${prefix}（${item.sku}）品名快照無效`;
    }
    if (!exactIsoDate(item.sourceContentUpdatedAt)) {
      return `${prefix}（${item.sku}）sourceContentUpdatedAt 要係精確 ISO 時間`;
    }
    const gate = aiContentGateError(item, b.reviewedBy);
    if (gate) return `${prefix}（${item.sku}）${gate}`;
    const descriptionError = validateAiDescription(item.description);
    if (descriptionError) return `${prefix}（${item.sku}）${descriptionError}`;
    if (!sanitizeAiDescription(item.description)) return `${prefix}（${item.sku}）描述唔可以空`;
    const tagsError = validateAiTags(item.aiTags);
    if (tagsError) return `${prefix}（${item.sku}）${tagsError}`;
    if (item.aiTags.length === 0) return `${prefix}（${item.sku}）至少要一個重點標籤`;
    const cleaned = item.aiTags.map((tag) => sanitizeAiTag(tag));
    if (new Set(cleaned).size !== cleaned.length) return `${prefix}（${item.sku}）重點標籤重複`;
    // 白名單欄位：多帶任何會影響商品其他資料嘅欄都拒絕，唔靠「冇用到」當安全。
    const allowed = new Set([
      "sku", "name", "sourceContentUpdatedAt", "description", "aiTags", "aiContentApproved",
    ]);
    const extra = Object.keys(item).filter((key) => !allowed.has(key));
    if (extra.length) return `${prefix}（${item.sku}）含非內容欄位：${extra.join(",")}`;
  }
  return null;
}

function prepareItems(batch: ProductContentBatchIn): PreparedItem[] {
  return batch.items.map((item) => ({
    ...item,
    sku: item.sku,
    name: item.name,
    cleanDescription: sanitizeAiDescription(item.description),
    cleanTags: item.aiTags.map((tag) => sanitizeAiTag(tag)),
    sourceDate: exactIsoDate(item.sourceContentUpdatedAt)!,
  }));
}

function rowContentMatches(row: ProductContentRow, item: PreparedItem): boolean {
  if (row.description !== item.cleanDescription) return false;
  const currentTags = parseAiTags(row.aiTags).map((tag) => sanitizeAiTag(tag));
  return JSON.stringify(currentTags) === JSON.stringify(item.cleanTags);
}

function assessRow(row: ProductContentRow | undefined, item: PreparedItem): ContentResult {
  if (!row) return { sku: item.sku, status: "failed", error: "搵唔到商品；內容批唔會新建商品" };
  if (row.name !== item.name) return { sku: item.sku, status: "failed", error: "品名同快照唔一致" };
  if (rowContentMatches(row, item)) return { sku: item.sku, status: "unchanged" };
  if (row.description !== null) {
    return { sku: item.sku, status: "failed", error: "商品已有描述，拒絕覆寫" };
  }
  const currentTime = row.contentUpdatedAt instanceof Date
    ? row.contentUpdatedAt
    : new Date(row.contentUpdatedAt);
  if (Number.isNaN(currentTime.getTime()) || currentTime.toISOString() !== item.sourceContentUpdatedAt) {
    return { sku: item.sku, status: "failed", error: "商品內容快照已過期，請重新檢視" };
  }
  return { sku: item.sku, status: "updated" };
}

function storedSnapshotMatches(
  rows: Array<{ sku: string; name: string | null; aiDescription: string | null; aiTags: string | null }>,
  items: PreparedItem[],
): boolean {
  if (rows.length !== items.length) return false;
  return items.every((item, index) => {
    const row = rows[index];
    return row.sku === item.sku
      && row.name === item.name
      && row.aiDescription === item.cleanDescription
      && row.aiTags === aiTagsToJson(item.cleanTags);
  });
}

export async function wmsProductContentBatch(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  const raw = (body ?? {}) as Record<string, unknown>;
  const denied = checkContentSecret(c, raw.secret);
  if (denied) return denied;
  const action = raw.action;
  if (action !== "dry-run" && action !== "execute") {
    return c.json({ ok: false, error: "action 要係 dry-run 或 execute" }, 400);
  }
  const invalid = validateContentBatch(raw.batch);
  if (invalid) return c.json({ ok: false, error: `batch 欄位問題：${invalid}` }, 400);
  const batch = raw.batch as ProductContentBatchIn;
  const items = prepareItems(batch);
  const db = getDb();

  // dry-run 絕對唔寫批次、商品或審計表；execute 會再逐件鎖行核對，唔信任乾跑結果。
  if (action === "dry-run") {
    const results: ContentResult[] = [];
    for (const item of items) {
      const row = await db.query.products.findFirst({ where: eq(products.sku, item.sku) });
      results.push(assessRow(row, item));
    }
    return c.json({
      ok: results.every((result) => result.status !== "failed"),
      dryRun: true,
      results,
    });
  }

  const existing = await db.query.listingBatches.findFirst({
    where: eq(listingBatches.batchNo, batch.batchNo),
  });
  if (existing && (existing.liveDate !== null || existing.liveSession !== null)) {
    return c.json({ ok: false, error: "batchNo 已由一般上架批使用" }, 409);
  }

  const readStoredItems = async (batchId: number) => db
    .select({
      sku: listingBatchItems.sku,
      name: listingBatchItems.name,
      aiDescription: listingBatchItems.aiDescription,
      aiTags: listingBatchItems.aiTags,
      status: listingBatchItems.status,
      error: listingBatchItems.error,
    })
    .from(listingBatchItems)
    .where(eq(listingBatchItems.batchId, batchId))
    .orderBy(listingBatchItems.id);

  if (existing) {
    const stored = await readStoredItems(existing.id);
    if (!storedSnapshotMatches(stored, items)) {
      return c.json({ ok: false, error: "相同 batchNo 嘅內容唔一致；請改用新批次" }, 409);
    }
    if (existing.status === "approved" && stored.length > 0
      && stored.every((row) => row.status === "updated" || row.status === "unchanged")) {
      return c.json({
        ok: true,
        already: true,
        results: stored.map((row) => ({
          sku: row.sku,
          status: row.status as ContentResultStatus,
        })),
      });
    }
    if (existing.status === "rejected") {
      return c.json({ ok: false, error: "批次已拒絕；請改用新批次" }, 409);
    }
  }

  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const staleProcessing = existing?.status === "processing"
    && new Date(existing.updatedAt).getTime() < staleBefore.getTime();
  if (existing?.status === "processing" && !staleProcessing) {
    return c.json({ ok: false, error: "內容批次正在處理，請稍後再試" }, 409);
  }

  let batchId: number;
  if (existing) {
    const claimed = await db
      .update(listingBatches)
      .set({
        status: "processing",
        liveDate: null,
        liveSession: null,
        itemCount: items.length,
        requestedBy: batch.requestedBy,
        reviewedBy: batch.reviewedBy,
        reviewNote: batch.reviewNote ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(listingBatches.id, existing.id),
        eq(listingBatches.status, existing.status),
        ...(staleProcessing ? [lt(listingBatches.updatedAt, staleBefore)] : []),
      ))
      .returning({ id: listingBatches.id });
    if (claimed.length === 0) {
      return c.json({ ok: false, error: "批次狀態啱啱更新咗，請稍後再試" }, 409);
    }
    batchId = existing.id;
    await db.delete(listingBatchItems).where(eq(listingBatchItems.batchId, batchId));
  } else {
    const inserted = await db
      .insert(listingBatches)
      .values({
        batchNo: batch.batchNo,
        liveDate: null,
        liveSession: null,
        status: "processing",
        itemCount: items.length,
        requestedBy: batch.requestedBy,
        reviewedBy: batch.reviewedBy,
        reviewNote: batch.reviewNote ?? null,
      })
      .onConflictDoNothing({ target: listingBatches.batchNo })
      .returning({ id: listingBatches.id });
    if (inserted.length === 0) {
      return c.json({ ok: false, error: "相同批次啱啱送入，請稍後再試" }, 409);
    }
    batchId = inserted[0].id;
  }

  const results: ContentResult[] = [];
  for (const item of items) {
    let result: ContentResult;
    let productId: number | null = null;
    try {
      result = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(products)
          .where(eq(products.sku, item.sku))
          .for("update");
        productId = rows[0]?.id ?? null;
        const assessed = assessRow(rows[0], item);
        if (assessed.status === "failed") return assessed;
        if (assessed.status === "unchanged") return assessed;

        // 只可改呢三欄；row lock＋transaction 防止檢查後被另一寫入插隊。
        await tx.update(products).set({
          description: item.cleanDescription,
          aiTags: aiTagsToJson(item.cleanTags),
          contentUpdatedAt: new Date(),
        }).where(eq(products.id, rows[0].id));
        const readBack = await tx
          .select({
            description: products.description,
            aiTags: products.aiTags,
          })
          .from(products)
          .where(eq(products.id, rows[0].id));
        if (!readBack[0] || !rowContentMatches({ ...rows[0], ...readBack[0] }, item)) {
          throw new Error("寫後讀回不一致；呢件已回滾");
        }
        return assessed;
      });
    } catch (error) {
      result = {
        sku: item.sku,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    results.push(result);
    await db.insert(listingBatchItems).values({
      batchId,
      sku: item.sku,
      name: item.name,
      imageUrl: null,
      aiDescription: item.cleanDescription,
      aiTags: aiTagsToJson(item.cleanTags),
      productId,
      status: result.status,
      error: result.error ?? null,
    });
    await db.update(listingBatches).set({ updatedAt: new Date() }).where(eq(listingBatches.id, batchId));
  }

  await db.update(listingBatches).set({ status: "approved", updatedAt: new Date() })
    .where(eq(listingBatches.id, batchId));
  const okCount = results.filter((result) => result.status !== "failed").length;
  const failCount = results.length - okCount;
  await logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "product.contentBatch",
    targetType: "listing",
    targetId: batch.batchNo,
    detail: `商品內容專用批已執行：${batch.batchNo}（成功 ${okCount} 件／失敗 ${failCount} 件；申請：${batch.requestedBy}；審批：${batch.reviewedBy}）`,
  });
  return c.json({ ok: failCount === 0, results });
}
