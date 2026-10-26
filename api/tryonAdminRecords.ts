import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { products, tryOnJobs, users } from "@db/schema";

/**
 * 後台 AI 試穿紀錄查詢（supervisor / admin 專用，2026-10-26）
 * ────────────────────────────────────────────────────────
 * 目的：後台睇到真實試穿紀錄——邊個會員試穿過邊件商品、第幾件、狀態、時間。
 * 資料全部來自 tryOnJobs 真實工作列（leftJoin users／products），冇示範假數據。
 *
 * 私隱紅線（同 serializeTryOnJob 一致原則，最小必要）：
 * - 絕對唔回傳 inputImagePath／outputImagePath／productImagePath、任何圖片 URL、
 *   storage key、signed URL、provider／providerJobId、generationMode／resolution、
 *   prompt、credits／成本、idempotencyKey／requestHash、failureMessage 等內部技術欄位
 * - mediaDeletedAt 只轉 boolean（媒體已刪／過期），時間戳唔外傳
 * - 會員識別只回 id＋名＋電話（同 membersRouter 後台列表一致嘅最少欄位）
 *
 * 商品品名／貨號：tryOnJobs.productName／productSku 係建立嗰刻嘅 snapshot（NOT NULL），
 * 一律優先顯示 snapshot；另附商品而家仲存唔存在（exists）同名/貨號有冇改過（changed），
 * 已刪商品照樣睇到當時試咗邊件。
 */

export const TRYON_ADMIN_RECORD_STATUSES = ["queued", "processing", "completed", "failed"] as const;
export type TryOnAdminRecordStatus = (typeof TRYON_ADMIN_RECORD_STATUSES)[number];

export const TRYON_ADMIN_RECORDS_MAX_PAGE_SIZE = 50;

export interface ListTryOnAdminRecordsInput {
  page: number;
  pageSize: number;
  status?: TryOnAdminRecordStatus | undefined;
  /** 會員搜尋：姓名或電話模糊對照（% _ \ 會 escape） */
  member?: string | undefined;
  /** 商品搜尋：生成時 snapshot 品名或貨號模糊對照（% _ \ 會 escape） */
  product?: string | undefined;
}

export interface TryOnAdminRecordItem {
  /** 內部 job id（serial） */
  jobId: number;
  /** 對外 job uuid */
  publicId: string;
  /** 同一套造型嘅 look id */
  lookId: string;
  /** 呢套造型入面第幾件（1 起計） */
  stepNumber: number;
  status: string;
  /** 失敗原因類別（自家代碼，例如 JOB_TIMEOUT）；唔包含供應商原文 */
  failureCode: string | null;
  /** 會員識別；null＝會員帳號已唔存在（FK 保護下理論上唔會發生，防禦性保留） */
  member: { id: number; name: string; phone: string } | null;
  product: {
    id: number;
    /** 生成時品名 snapshot */
    name: string;
    /** 生成時貨號 snapshot */
    sku: string;
    category: string;
    tryOnKind: string;
    /** 商品而家仲喺唔喺 products 表（false＝已刪除，顯示 snapshot 資料） */
    exists: boolean;
    /** 現行品名／貨號同 snapshot 唔同（商品仍存在先可能 true） */
    changed: boolean;
    currentName: string | null;
    currentSku: string | null;
  };
  /** 私人媒體已刪除或過保留期（只出 boolean，絕唔出路徑／URL／時間戳） */
  mediaDeleted: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface TryOnAdminRecordsPage {
  items: TryOnAdminRecordItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 用家輸入嘅 % / _ / \ 先 escape，唔畀佢哋變 ilike 通配符（同 membersRouter 一致） */
function escapeLike(keyword: string): string {
  return keyword.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export async function listTryOnAdminRecords(
  input: ListTryOnAdminRecordsInput,
): Promise<TryOnAdminRecordsPage> {
  // 防禦性夾返範圍（router 層 zod 已驗證；直接俾內部呼叫都唔會出事）
  const pageSize = Math.min(
    TRYON_ADMIN_RECORDS_MAX_PAGE_SIZE,
    Math.max(1, Math.floor(input.pageSize) || 20),
  );
  const page = Math.max(1, Math.floor(input.page) || 1);
  const memberKw = input.member?.trim() ?? "";
  const productKw = input.product?.trim() ?? "";

  const conditions: SQL[] = [];
  if (input.status) {
    conditions.push(eq(tryOnJobs.status, input.status));
  }
  if (memberKw) {
    const term = `%${escapeLike(memberKw)}%`;
    conditions.push(
      sql`(${users.name} ilike ${term} escape '\\' or ${users.phone} ilike ${term} escape '\\')`,
    );
  }
  if (productKw) {
    const term = `%${escapeLike(productKw)}%`;
    conditions.push(
      sql`(${tryOnJobs.productName} ilike ${term} escape '\\' or ${tryOnJobs.productSku} ilike ${term} escape '\\')`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const db = getDb();
  // 先數總數（member 篩選用到 users，所以 count 都要 join），再攞當頁。
  const [totalRow] = await db
    .select({ value: count() })
    .from(tryOnJobs)
    .leftJoin(users, eq(users.id, tryOnJobs.userId))
    .where(where);

  const rows = await db
    .select({
      jobId: tryOnJobs.id,
      publicId: tryOnJobs.publicId,
      lookId: tryOnJobs.lookId,
      stepNumber: tryOnJobs.stepNumber,
      status: tryOnJobs.status,
      failureCode: tryOnJobs.failureCode,
      mediaDeletedAt: tryOnJobs.mediaDeletedAt,
      createdAt: tryOnJobs.createdAt,
      startedAt: tryOnJobs.startedAt,
      completedAt: tryOnJobs.completedAt,
      memberId: users.id,
      memberName: users.name,
      memberPhone: users.phone,
      productId: tryOnJobs.productId,
      productName: tryOnJobs.productName,
      productSku: tryOnJobs.productSku,
      productCategory: tryOnJobs.productCategory,
      tryOnKind: tryOnJobs.tryOnKind,
      currentProductName: products.name,
      currentProductSku: products.sku,
    })
    .from(tryOnJobs)
    .leftJoin(users, eq(users.id, tryOnJobs.userId))
    .leftJoin(products, eq(products.id, tryOnJobs.productId))
    .where(where)
    // id desc 即建立時間 desc（同 auditRouter 列表慣例一致）
    .orderBy(desc(tryOnJobs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const total = Number(totalRow?.value ?? 0);
  const items: TryOnAdminRecordItem[] = rows.map((row) => ({
    jobId: row.jobId,
    publicId: row.publicId,
    lookId: row.lookId,
    stepNumber: row.stepNumber,
    status: row.status,
    failureCode: row.failureCode,
    member:
      row.memberId === null
        ? null
        : { id: row.memberId, name: row.memberName ?? "", phone: row.memberPhone ?? "" },
    product: {
      id: row.productId,
      name: row.productName,
      sku: row.productSku,
      category: row.productCategory,
      tryOnKind: row.tryOnKind,
      exists: row.currentProductName !== null,
      changed:
        row.currentProductName !== null &&
        (row.currentProductName !== row.productName || row.currentProductSku !== row.productSku),
      currentName: row.currentProductName,
      currentSku: row.currentProductSku,
    },
    mediaDeleted: Boolean(row.mediaDeletedAt),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
