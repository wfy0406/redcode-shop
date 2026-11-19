/**
 * WMS → 官網「只改已批准商品內容」批次。
 *
 * 同 /api/wms/listing-batch 完全分開：呢度唔接受圖、價錢、庫存、分類、場次、
 * 上下架或定時下架欄，亦絕對唔會新建商品。每件只可以更新 description、aiTags、
 * contentUpdatedAt；SKU／品名／sourceContentUpdatedAt 對唔到、已有其他描述、
 * 或寫後讀回唔一致，一律拒絕。
 *
 * 審批仍用 WMS_CALLBACK_SECRET；reviewedBy 必須由真實審批流程提供，程式唔會代填。
 * action=dry-run 唯讀；execute 用 listingBatches/listingBatchItems 留批次、新內容及逐件原值快照。
 * restore-dry-run／restore 只還原本批真正 updated 嘅商品：目前三欄必須仍同本批寫入結果
 * 完全一致；曾再編輯、商品重建、舊批冇原值快照，一律拒絕，唔會為還原而覆蓋新資料。
 */
import { and, eq, isNull, lt } from "drizzle-orm";
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

/** 失去批次控制權係成批中止，唔係單件 failed；絕唔可以再落逐件 log 或審計假成功。 */
class BatchClaimLostError extends Error {
  constructor() {
    super("批次控制權已轉移，呢個執行個體已即時停止");
    this.name = "BatchClaimLostError";
  }
}

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
type PreviousContentSnapshot = {
  description: string | null;
  aiTags: string | null;
  contentUpdatedAt: Date;
};

type PreparedItem = ProductContentItemIn & {
  cleanDescription: string;
  cleanTags: string[];
  sourceDate: Date;
};

type StoredContentItem = {
  id: number;
  sku: string;
  name: string | null;
  aiDescription: string | null;
  aiTags: string | null;
  productId: number | null;
  status: string;
  error: string | null;
  previousDescription: string | null;
  previousAiTags: string | null;
  previousContentUpdatedAt: Date | null;
  contentAppliedAt: Date | null;
  contentRestoredAt: Date | null;
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

type StoredSnapshotRow = {
  sku: string;
  name: string | null;
  aiDescription: string | null;
  aiTags: string | null;
};

function storedSnapshotRowMatches(row: StoredSnapshotRow, item: PreparedItem): boolean {
  return row.sku === item.sku
    && row.name === item.name
    && row.aiDescription === item.cleanDescription
    && row.aiTags === aiTagsToJson(item.cleanTags);
}

function storedSnapshotMatches(rows: StoredSnapshotRow[], items: PreparedItem[]): boolean {
  return rows.length === items.length
    && rows.every((row, index) => storedSnapshotRowMatches(row, items[index]));
}

/** processing 崩潰重試只接受已寫 log 係本批嘅完整前綴；唔准刪走成功商品嘅原值快照。 */
function storedSnapshotPrefixMatches(rows: StoredSnapshotRow[], items: PreparedItem[]): boolean {
  return rows.length <= items.length
    && rows.every((row, index) => storedSnapshotRowMatches(row, items[index]));
}

function sameInstant(value: Date | string | null | undefined, expected: Date | string | null): boolean {
  if (!value || !expected) return false;
  const left = value instanceof Date ? value : new Date(value);
  const right = expected instanceof Date ? expected : new Date(expected);
  return !Number.isNaN(left.getTime()) && !Number.isNaN(right.getTime())
    && left.getTime() === right.getTime();
}

/** 還原判斷只用精確原值；唔用標籤正規化當相同，避免掩蓋寫入後嘅人工改動。 */
function assessRestoreRow(
  row: ProductContentRow | undefined,
  item: PreparedItem,
  stored: StoredContentItem,
): ContentResult {
  if (stored.status !== "updated") return { sku: item.sku, status: "unchanged" };
  if (!stored.productId || !stored.contentAppliedAt || !stored.previousContentUpdatedAt) {
    return { sku: item.sku, status: "failed", error: "原批冇完整寫入前快照，拒絕估計還原" };
  }
  if (!row) return { sku: item.sku, status: "failed", error: "搵唔到原商品，拒絕還原" };
  if (row.id !== stored.productId || row.sku !== item.sku || row.name !== item.name) {
    return { sku: item.sku, status: "failed", error: "商品身份或品名同原批唔一致，拒絕還原" };
  }

  const atOriginalValues = row.description === stored.previousDescription
    && row.aiTags === stored.previousAiTags
    && sameInstant(row.contentUpdatedAt, stored.previousContentUpdatedAt);
  if (atOriginalValues) return { sku: item.sku, status: "unchanged" };
  if (stored.contentRestoredAt) {
    return { sku: item.sku, status: "failed", error: "呢件已還原，但其後再有改動；唔會再次覆寫" };
  }

  const stillThisBatch = row.description === item.cleanDescription
    && row.aiTags === aiTagsToJson(item.cleanTags)
    && sameInstant(row.contentUpdatedAt, stored.contentAppliedAt);
  if (!stillThisBatch) {
    return { sku: item.sku, status: "failed", error: "商品喺本批寫入後曾有改動，拒絕覆蓋" };
  }
  return { sku: item.sku, status: "updated" };
}

function restoredReadBackMatches(
  row: { description: string | null; aiTags: string | null; contentUpdatedAt: Date } | undefined,
  stored: StoredContentItem,
): boolean {
  return !!row
    && row.description === stored.previousDescription
    && row.aiTags === stored.previousAiTags
    && sameInstant(row.contentUpdatedAt, stored.previousContentUpdatedAt);
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
  if (action !== "dry-run" && action !== "execute"
    && action !== "restore-dry-run" && action !== "restore") {
    return c.json({ ok: false, error: "action 要係 dry-run、execute、restore-dry-run 或 restore" }, 400);
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
      id: listingBatchItems.id,
      sku: listingBatchItems.sku,
      name: listingBatchItems.name,
      aiDescription: listingBatchItems.aiDescription,
      aiTags: listingBatchItems.aiTags,
      productId: listingBatchItems.productId,
      status: listingBatchItems.status,
      error: listingBatchItems.error,
      previousDescription: listingBatchItems.previousDescription,
      previousAiTags: listingBatchItems.previousAiTags,
      previousContentUpdatedAt: listingBatchItems.previousContentUpdatedAt,
      contentAppliedAt: listingBatchItems.contentAppliedAt,
      contentRestoredAt: listingBatchItems.contentRestoredAt,
    })
    .from(listingBatchItems)
    .where(eq(listingBatchItems.batchId, batchId))
    .orderBy(listingBatchItems.id);

  if (action === "restore-dry-run" || action === "restore") {
    if (!existing) return c.json({ ok: false, error: "搵唔到原商品內容批，唔會估計還原" }, 409);
    if (existing.status !== "approved") {
      return c.json({ ok: false, error: "原內容批未完成執行，唔可以還原" }, 409);
    }
    const stored = await readStoredItems(existing.id);
    if (stored.some((row) => row.status !== "updated" && row.status !== "unchanged" && row.status !== "failed")) {
      return c.json({ ok: false, error: "原批有無法辨認嘅逐件狀態；請人工核對，唔會還原或重寫" }, 409);
    }
    if (!storedSnapshotMatches(stored, items)) {
      return c.json({ ok: false, error: "還原請求同原批內容快照唔一致" }, 409);
    }

    const results: ContentResult[] = [];
    for (const [index, item] of items.entries()) {
      const storedItem = stored[index];
      // unchanged／failed 本來就冇被呢批改過，連商品查詢都唔需要，更唔會借還原寫入。
      if (storedItem.status !== "updated") {
        results.push({ sku: item.sku, status: "unchanged" });
        continue;
      }

      if (action === "restore-dry-run") {
        const row = await db.query.products.findFirst({ where: eq(products.sku, item.sku) });
        results.push(assessRestoreRow(row, item, storedItem));
        continue;
      }

      let result: ContentResult;
      try {
        result = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(products)
            .where(eq(products.sku, item.sku))
            .for("update");
          const assessed = assessRestoreRow(rows[0], item, storedItem);
          if (assessed.status === "failed") return assessed;
          // 成功還原後重送：商品同紀錄都唔再寫，真正幂等。
          if (storedItem.contentRestoredAt) return assessed;

          if (assessed.status === "updated") {
            // compare-and-restore：只改返呢三件原值；其他商品欄完全唔掂。
            await tx.update(products).set({
              description: storedItem.previousDescription,
              aiTags: storedItem.previousAiTags,
              contentUpdatedAt: storedItem.previousContentUpdatedAt!,
            }).where(eq(products.id, rows[0].id));
            const readBack = await tx
              .select({
                description: products.description,
                aiTags: products.aiTags,
                contentUpdatedAt: products.contentUpdatedAt,
              })
              .from(products)
              .where(eq(products.id, rows[0].id));
            if (!restoredReadBackMatches(readBack[0], storedItem)) {
              throw new Error("還原後讀回不一致；呢件已回滾");
            }
          }

          // 商品本來已係原值都會留還原標記；只准標記一次，並同商品更新同事務。
          const marked = await tx.update(listingBatchItems).set({
            contentRestoredAt: new Date(),
            contentRestoredBy: batch.reviewedBy,
            error: null,
          }).where(and(
            eq(listingBatchItems.id, storedItem.id),
            isNull(listingBatchItems.contentRestoredAt),
          )).returning({ id: listingBatchItems.id });
          if (marked.length === 0) {
            // 另一還原已搶先落標記；若我哋啱啱改咗商品，必須回滾，唔准無標記成功。
            if (assessed.status === "updated") {
              throw new Error("還原標記已被另一操作更新；呢件商品還原已回滾");
            }
            return assessed;
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
    }

    if (action === "restore-dry-run") {
      return c.json({
        ok: results.every((result) => result.status !== "failed"),
        dryRun: true,
        restore: true,
        results,
      });
    }
    const restoredCount = results.filter((result) => result.status === "updated").length;
    const unchangedCount = results.filter((result) => result.status === "unchanged").length;
    const failCount = results.filter((result) => result.status === "failed").length;
    await logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "product.contentBatchRestore",
      targetType: "listing",
      targetId: batch.batchNo,
      detail: `商品內容專用批安全還原：${batch.batchNo}（還原 ${restoredCount} 件／原本已係原值或冇改過 ${unchangedCount} 件／拒絕 ${failCount} 件；操作審批：${batch.reviewedBy}）`,
    });
    return c.json({ ok: failCount === 0, restore: true, results });
  }

  const storedExisting = existing ? await readStoredItems(existing.id) : [];
  if (existing) {
    if (existing.status === "approved" && storedExisting.length === 0) {
      return c.json({ ok: false, error: "批次已批准但冇逐件快照；拒絕重跑，請人工核對" }, 409);
    }
    // processing 崩潰重試可以係未完成前綴；其他狀態必須同整批快照完全一致。
    const snapshotMatches = existing.status === "processing"
      ? storedSnapshotPrefixMatches(storedExisting, items)
      : storedSnapshotMatches(storedExisting, items);
    if (!snapshotMatches) {
      return c.json({ ok: false, error: "相同 batchNo 嘅內容唔一致；請改用新批次" }, 409);
    }
    if (storedExisting.some((row) => row.status !== "updated" && row.status !== "unchanged" && row.status !== "failed")) {
      return c.json({ ok: false, error: "原批有無法辨認嘅逐件狀態；請人工核對，唔會當成功或重寫" }, 409);
    }
    if (existing.status === "approved" && storedExisting.length > 0
      && storedExisting.every((row) => row.status === "updated" || row.status === "unchanged")) {
      return c.json({
        ok: true,
        already: true,
        results: storedExisting.map((row) => ({
          sku: row.sku,
          status: row.status as ContentResultStatus,
        })),
      });
    }
    if (existing.status === "approved" && storedExisting.length > 0) {
      // 唔刪走舊 item log 再跑：咁做會抹去已成功商品嘅原值快照，令佢哋無法安全還原。
      return c.json({
        ok: false,
        error: "批次已有執行紀錄兼失敗；為保留還原快照，請核對後改用新批次",
      }, 409);
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
  let claimUpdatedAt: Date;
  const claimedAt = new Date();
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
        updatedAt: claimedAt,
      })
      .where(and(
        eq(listingBatches.id, existing.id),
        eq(listingBatches.status, existing.status),
        ...(staleProcessing ? [lt(listingBatches.updatedAt, staleBefore)] : []),
      ))
      .returning({ id: listingBatches.id, updatedAt: listingBatches.updatedAt });
    if (claimed.length === 0) {
      return c.json({ ok: false, error: "批次狀態啱啱更新咗，請稍後再試" }, 409);
    }
    batchId = existing.id;
    claimUpdatedAt = claimed[0].updatedAt;
    // 崩潰重試保留逐件 log；已 updated 嘅商品靠原快照還原，絕唔可以 delete 後當 unchanged。
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
        updatedAt: claimedAt,
      })
      .onConflictDoNothing({ target: listingBatches.batchNo })
      .returning({ id: listingBatches.id, updatedAt: listingBatches.updatedAt });
    if (inserted.length === 0) {
      return c.json({ ok: false, error: "相同批次啱啱送入，請稍後再試" }, 409);
    }
    batchId = inserted[0].id;
    claimUpdatedAt = inserted[0].updatedAt;
  }

  const results: ContentResult[] = [];
  for (const [index, item] of items.entries()) {
    const resumed = storedExisting[index];
    if (resumed) {
      // 已 commit 嘅逐件結果同原值快照原樣保留；崩潰重試只補跑未留 log 嘅 item。
      results.push({
        sku: resumed.sku,
        status: resumed.status as ContentResultStatus,
        ...(resumed.error ? { error: resumed.error } : {}),
      });
      continue;
    }

    let result: ContentResult;
    let productId: number | null = null;
    try {
      result = await db.transaction(async (tx) => {
        // 鎖批次行再核對 claim token：舊 zombie 失去 CAS 後，唔可以繼續寫商品或逐件 log。
        const claimRows = await tx
          .select({ status: listingBatches.status, updatedAt: listingBatches.updatedAt })
          .from(listingBatches)
          .where(eq(listingBatches.id, batchId))
          .for("update");
        if (!claimRows[0] || claimRows[0].status !== "processing"
          || !sameInstant(claimRows[0].updatedAt, claimUpdatedAt)) {
          throw new BatchClaimLostError();
        }
        const rows = await tx
          .select()
          .from(products)
          .where(eq(products.sku, item.sku))
          .for("update");
        productId = rows[0]?.id ?? null;
        let assessed = assessRow(rows[0], item);
        if (staleProcessing && assessed.status === "unchanged") {
          // 舊版可能曾將商品同快照分開寫；冇本批 log 就無法分辨原本已一樣定係遺失快照。
          assessed = {
            sku: item.sku,
            status: "failed",
            error: "商品內容已相同但本批冇快照，無法確認原值；請人工對賬，唔會當 unchanged",
          };
        }
        if (assessed.status !== "updated") {
          // unchanged／failed 都必須喺同一個已驗證 claim 嘅 transaction 留 log；
          // 唔可以先喺交易外寫 log、之後 heartbeat 先發現已失去控制權。
          await tx.insert(listingBatchItems).values({
            batchId,
            sku: item.sku,
            name: item.name,
            imageUrl: null,
            aiDescription: item.cleanDescription,
            aiTags: aiTagsToJson(item.cleanTags),
            previousDescription: null,
            previousAiTags: null,
            previousContentUpdatedAt: null,
            contentAppliedAt: null,
            productId,
            status: assessed.status,
            error: assessed.error ?? null,
          });
          return assessed;
        }

        // 真正寫入前先鎖行留原值；還原唔會假設舊描述／標籤一定係 null。
        const previousSnapshot: PreviousContentSnapshot = {
          description: rows[0].description,
          aiTags: rows[0].aiTags,
          contentUpdatedAt: rows[0].contentUpdatedAt,
        };
        const appliedAt = new Date();
        // 只可改呢三欄；row lock＋transaction 防止檢查後被另一寫入插隊。
        await tx.update(products).set({
          description: item.cleanDescription,
          aiTags: aiTagsToJson(item.cleanTags),
          contentUpdatedAt: appliedAt,
        }).where(eq(products.id, rows[0].id));
        const readBack = await tx
          .select({
            description: products.description,
            aiTags: products.aiTags,
            contentUpdatedAt: products.contentUpdatedAt,
          })
          .from(products)
          .where(eq(products.id, rows[0].id));
        if (!readBack[0]
          || !rowContentMatches({ ...rows[0], ...readBack[0] }, item)
          || !sameInstant(readBack[0].contentUpdatedAt, appliedAt)) {
          throw new Error("寫後讀回不一致；呢件已回滾");
        }

        // 商品更新、寫後讀回同原值快照必須同一 transaction 一齊 commit／rollback。
        await tx.insert(listingBatchItems).values({
          batchId,
          sku: item.sku,
          name: item.name,
          imageUrl: null,
          aiDescription: item.cleanDescription,
          aiTags: aiTagsToJson(item.cleanTags),
          previousDescription: previousSnapshot.description,
          previousAiTags: previousSnapshot.aiTags,
          previousContentUpdatedAt: previousSnapshot.contentUpdatedAt,
          contentAppliedAt: appliedAt,
          productId,
          status: assessed.status,
          error: null,
        });
        return assessed;
      });
    } catch (error) {
      if (error instanceof BatchClaimLostError) {
        return c.json({ ok: false, error: error.message }, 409);
      }
      result = {
        sku: item.sku,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      try {
        // 原交易已因錯誤回滾；補記 failed log 都要重新鎖批次及核對 claim，
        // 唔准 zombie 喺 heartbeat 之前留下過時日誌。
        const failureLogWritten = await db.transaction(async (tx) => {
          const claimRows = await tx
            .select({ status: listingBatches.status, updatedAt: listingBatches.updatedAt })
            .from(listingBatches)
            .where(eq(listingBatches.id, batchId))
            .for("update");
          if (!claimRows[0] || claimRows[0].status !== "processing"
            || !sameInstant(claimRows[0].updatedAt, claimUpdatedAt)) {
            throw new BatchClaimLostError();
          }
          // COMMIT 成功但 client 收到連線錯誤時，原交易可能已有 updated／unchanged log。
          // 批次行鎖保證同一批唔會平行補寫；已有紀錄就停手對賬，唔好再加矛盾嘅 failed row。
          const existingItemLogs = await tx
            .select({ id: listingBatchItems.id })
            .from(listingBatchItems)
            .where(and(eq(listingBatchItems.batchId, batchId), eq(listingBatchItems.sku, item.sku)))
            .limit(1);
          if (existingItemLogs.length > 0) return false;
          await tx.insert(listingBatchItems).values({
            batchId,
            sku: item.sku,
            name: item.name,
            imageUrl: null,
            aiDescription: item.cleanDescription,
            aiTags: aiTagsToJson(item.cleanTags),
            previousDescription: null,
            previousAiTags: null,
            previousContentUpdatedAt: null,
            contentAppliedAt: null,
            productId,
            status: result.status,
            error: result.error ?? null,
          });
          return true;
        });
        if (!failureLogWritten) {
          return c.json({ ok: false, error: "原交易結果不明，但本批呢件已有逐件紀錄；請重送相同批次對賬，唔會重複寫入" }, 409);
        }
      } catch (logError) {
        if (logError instanceof BatchClaimLostError) {
          return c.json({ ok: false, error: logError.message }, 409);
        }
        throw logError;
      }
    }

    results.push(result);
    const heartbeatAt = new Date();
    const heartbeat = await db.update(listingBatches).set({ updatedAt: heartbeatAt })
      .where(and(
        eq(listingBatches.id, batchId),
        eq(listingBatches.status, "processing"),
        eq(listingBatches.updatedAt, claimUpdatedAt),
      ))
      .returning({ updatedAt: listingBatches.updatedAt });
    if (heartbeat.length === 0) {
      return c.json({ ok: false, error: "批次控制權已轉移，呢個執行個體已即時停止" }, 409);
    }
    claimUpdatedAt = heartbeat[0].updatedAt;
  }

  const approved = await db.update(listingBatches).set({ status: "approved", updatedAt: new Date() })
    .where(and(
      eq(listingBatches.id, batchId),
      eq(listingBatches.status, "processing"),
      eq(listingBatches.updatedAt, claimUpdatedAt),
    ))
    .returning({ id: listingBatches.id });
  if (approved.length === 0) {
    return c.json({ ok: false, error: "批次控制權已轉移，唔會標記完成或寫審計" }, 409);
  }
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
