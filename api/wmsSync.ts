/**
 * RedCode 官網 ↔ Red Code WMS 訂單接入（依 RED_CODE_WEBHOOK_API_v1.3.md v1.3，2026-07-27）
 * v1.1：截圖照舊純 base64 傳；錯誤碼用 error.json.message 解析；paymentMethod: "FPS"。
 * v1.2（§九）：WMS 審批完自動回調 /api/wms/review-callback —— 官網一早已實裝。
 * v1.3：webhook payload 調整 + 回調 rejectType 分流：
 *   ① productCode 送貨號 sku（有尺寸就 {sku}-{尺寸}，例如「B133-S」）；
 *     〔2026-07-28 跟 WMS《貨號欄位修正請求》由 v1.3 嘅名稱組裝改為 sku 組裝〕
 *   ② sourcePayload.items 每件加 listedDate（YYYY-MM-DD）——WMS v1.3.7 起
 *     訂單日期用貨品上架日期（對唔到貨號／冇欄位就繼續用落單日期，向後相容）；
 *   〔2026-08-06 跟 WMS《官網→WMS對接需求：貨品圖片+會員資料》：
 *     sourcePayload.items 每件加 imageUrls（完整 URL array，首張＝主圖；冇圖送 null）；
 *     customer 加 age（number|null）／registeredAt（會員註冊日，YYYY-MM-DD）〕
 *   ② actualPrice 改送扣完優惠碼嘅單件實收（按行金額比例攤分，最後一件食尾數）；
 *   ③ 停送 customerEmail／paymentMethod／sessionNo／color；remark 唔再包「尺寸」段；
 *   ④ 回調 decision=rejected 新增 rejectType：cancel＝訂單取消（終態）／reupload＝付款重傳
 *     （冇 rejectType 嘅舊格式 rejected 一律當 cancel，跟文檔向後兼容指引）；
 *   ⑤ 客人重傳截圖時 ordersRouter 會重置 wmsSyncLog，等重審件可以重新送落 WMS。
 * v1.4（2026-11-11 中獎單漏送修復）：起單同事務持久排隊、原子認領、逐件保存、
 *   成功必須有 webhookOrderId、退避自動重試；只有新排隊／主管確認補救嘅單會自動重播。
 *
 * 方向一（官網 → WMS）：客人上傳付款截圖之後，訂單逐件貨 call WMS `order.receiveWebhook`，
 *   WMS 管理員/主管喺「審批中心 → 官網訂單審批」見到（連截圖 base64），批准/拒絕。
 * 方向二（WMS → 官網）：WMS 審批完 POST 返我哋 `POST /api/wms/review-callback`（shared secret），
 *   官網訂單自動轉 approved（已確認＝終態）／cancelled（訂單取消）／rejected（待客人重傳截圖），
 *   兼寫入審計日誌（actorRole=system），後台「日誌」頁可以翻查 WMS 審批結果。
 *
 * 防重複：一單一列 wmsSyncLog，webhookOrderIds 同 orderItems 對位；已成功嘅件 skip；
 *   WMS 對相同 sourceRef＋貨品 key 嘅 pending／approved 行另有 dedup 並回現有 ID；
 *   客人重傳截圖時會先重置嗰列，否則重審件永遠送唔到（v1.3 §2.3）。
 *
 * Env：
 *   WMS_API_KEY          WMS 管理員提供嘅 apiKey（未設 → 同步記錄標 disabled，官網照行）
 *   WMS_BASE_URL         預設 https://red-code-wms.onrender.com
 *   WMS_CALLBACK_SECRET  官網自己出嘅 shared secret，WMS callback 要帶嚟
 *   WMS_SYNC_DISABLED    設 "1" 即停用 forward（唔使改 code redeploy）
 *   PUBLIC_BASE_URL      預設 https://redcode.red（screenshotUrl 用）
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, inArray, like, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { orders, paymentProofs, products, wmsSyncLog } from "@db/schema";
import { logAudit } from "./audit";
import { sendOrderApprovedEmail, orderVipEmailInfo } from "./email";
import { recomputeVipTierInBackground } from "./vip";
import { secretEquals } from "./wmsSecret";
import { isWebDesignOrderNo } from "./webDesignCore";

const DEFAULT_WMS_BASE_URL = "https://red-code-wms.onrender.com";
const DEFAULT_PUBLIC_BASE_URL = "https://redcode.red";
// Render 免費版冷啟動：WMS 瞓著後首個 request 要 60–130s 先醒（WMS 方 2026-07-28 實測 133s），
// 20s timeout 會斬纜 → 畀足 90s，冷啟動都接得住；溫熱時 <1s 唔受影響
const PER_CALL_TIMEOUT_MS = 90_000;
// 大過呢個 size 就唔附 base64（WMS 可經 sourcePayload.screenshotUrl 睇原圖）
const MAX_SCREENSHOT_BYTES = 1_800_000;

// 可靠投遞：沿用現有 wmsSyncLog，唔加 migration。lastError 開頭標記只代表「呢個版本新建立、
// 或主管明確批准補救」嘅單可以先自動重試；歷史失敗紀錄唔會因部署而被無差別重播。
export const WMS_AUTO_RETRY_PREFIX = "[wms-auto:v1]";
export const WMS_AUTO_QUEUE_MESSAGE = `${WMS_AUTO_RETRY_PREFIX} 等待送往 WMS`;
const WMS_SYNCING_PREFIX = "[wms-syncing:v1:";
const WMS_CLAIM_STALE_MS = 4 * 60_000;
const WMS_MAX_AUTO_ATTEMPTS = 6;
const WMS_RETRY_BATCH_LIMIT = 2;
const WMS_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export type SyncStatus = "pending" | "sent" | "partial" | "failed" | "disabled";

export function wmsConfigured(): boolean {
  return Boolean(process.env.WMS_API_KEY) && process.env.WMS_SYNC_DISABLED !== "1";
}

function wmsBaseUrl(): string {
  return (process.env.WMS_BASE_URL || DEFAULT_WMS_BASE_URL).replace(/\/$/, "");
}

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, "");
}

/** HKT（UTC+8）YYYY-MM-DD */
function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

interface WmsCallResult {
  webhookOrderId: number | null;
  error: string | null;
}

/** 調 WMS order.receiveWebhook（tRPC HTTP：body 要包 { json: ... }；apiKey 擺 body，唔係 header）
 *  v2026.11.09：export 咗畀 api/webDesignWms.ts（網站設計服務單）重用——同一個 WMS endpoint／同一套 timeout。 */
export async function callReceiveWebhook(body: Record<string, unknown>): Promise<WmsCallResult> {
  const apiKey = process.env.WMS_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${wmsBaseUrl()}/api/trpc/order.receiveWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { apiKey, ...body } }),
      signal: ctrl.signal,
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: {
        data?: { json?: { success?: boolean; webhookOrderId?: number; message?: string } };
      };
      error?: { json?: { message?: string } };
    } | null;
    const errMsg = data?.error?.json?.message;
    if (errMsg) return { webhookOrderId: null, error: String(errMsg) };
    const ok = data?.result?.data?.json;
    if (ok?.success) return { webhookOrderId: ok.webhookOrderId ?? null, error: null };
    return { webhookOrderId: null, error: ok?.message ?? `HTTP ${resp.status}` };
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? `timeout ${PER_CALL_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : "network error";
    return { webhookOrderId: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export interface WmsProjectCallResult {
  projectNo: string | null;
  deduped: boolean;
  error: string | null;
}

/**
 * v2026.11.12（網頁設計獨立專案管理 SPEC）：調 WMS `webDesignProject.receiveWebsite` ——
 * 新網頁設計服務單付款確認後直入 WMS 專案庫，**唔再經 order.receiveWebhook**。
 * 同一套 90s transport／apiKey 擺 body／never-throw／錯誤解析（error.json.message 優先）。
 * WMS 冪等：同一 orderNo 重複送回 `{ success:true, deduped:true, projectNo }`——照樣當成功收。
 * 舊 `callReceiveWebhook` 原封保留畀商城商品，兩條路互不干擾。
 */
export async function callReceiveWebDesignProject(
  body: Record<string, unknown>,
): Promise<WmsProjectCallResult> {
  const apiKey = process.env.WMS_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${wmsBaseUrl()}/api/trpc/webDesignProject.receiveWebsite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { apiKey, ...body } }),
      signal: ctrl.signal,
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: {
        data?: { json?: { success?: boolean; deduped?: boolean; projectNo?: string; message?: string } };
      };
      error?: { json?: { message?: string } };
    } | null;
    const errMsg = data?.error?.json?.message;
    if (errMsg) return { projectNo: null, deduped: false, error: String(errMsg) };
    const ok = data?.result?.data?.json;
    if (ok?.success) {
      // 安全閘：success:true 必須帶非空 projectNo 先算成功——
      // 否則上層會寫「sent＋null」假成功（冇 projectNo 對唔返 WMS 專案，retry 又俾 sent 閘擋死）
      const projectNo = ok.projectNo != null ? String(ok.projectNo).trim() : "";
      if (!projectNo) {
        return { projectNo: null, deduped: false, error: "WMS 回應缺少專案編號" };
      }
      return {
        projectNo,
        deduped: ok.deduped === true,
        error: null,
      };
    }
    return { projectNo: null, deduped: false, error: ok?.message ?? `HTTP ${resp.status}` };
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? `timeout ${PER_CALL_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : "network error";
    return { projectNo: null, deduped: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

type ProofRow = { id: number; imagePath: string; status: string; createdAt: Date };

/**
 * v2.5.5 第10版（老闆指示 2026-10-11「點解購物金審批無推送？？」）：
 * 會員上傳充值截圖（轉 payment_review）後，即時打 WMS `order.receiveTopupAlert` ——
 * WMS 會推送落主管/管理員手機（同官網新訂單推播同款待遇，tag 冚舊唔會炸通知）。
 * never-throw：WMS 冇配置／call 唔通／WMS 彈錯都淨係 console.error，唔會阻到會員流程；
 * apiKey 永遠唔落 log（錯誤訊息淨係 WMS 回嘅字／HTTP 碼）。
 */
export async function notifyWmsTopupReview(args: {
  topupNo: string;
  memberName: string | null;
  label: string;
  price: number;
  channel?: string;
}): Promise<void> {
  if (!wmsConfigured()) return;
  const apiKey = process.env.WMS_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${wmsBaseUrl()}/api/trpc/order.receiveTopupAlert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: {
          apiKey,
          topupNo: args.topupNo,
          memberName: args.memberName ?? "會員",
          label: args.label,
          price: args.price,
          channel: args.channel,
        },
      }),
      signal: ctrl.signal,
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: { data?: { json?: { success?: boolean } } };
      error?: { json?: { message?: string } };
    } | null;
    const errMsg = data?.error?.json?.message;
    if (errMsg || !data?.result?.data?.json?.success) {
      console.error(`[wmsSync] 購物金待批推送失敗（${args.topupNo}）：${errMsg ?? `HTTP ${resp.status}`}`);
    }
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? `timeout ${PER_CALL_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : "network error";
    console.error(`[wmsSync] 購物金待批推送失敗（${args.topupNo}）：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * v2.5.5 第12版（老闆實測 2026-10-11「會員訂單同官網資訊唔同，我已經刪咗呢2張訂單」）：
 * 官網後台「永久刪除」訂單之後，fire-and-forget 通知 WMS 跟住刪（webhook 行＋正式訂單行），
 * 唔會再出現「官網冇咗、WMS 會員訂單仲見到」嘅兩邊唔夾。
 * 規矩照舊：失敗唔影響本地刪除結果（已經刪咗），但一定要 loud console.error（唔靜默）；
 * log 永遠唔准落 apiKey。
 */
export async function forwardOrderDeleteToWms(orderNo: string, deletedBy: string): Promise<void> {
  if (!wmsConfigured()) return;
  const apiKey = process.env.WMS_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${wmsBaseUrl()}/api/trpc/order.receiveOrderDelete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: { apiKey, sourceRef: orderNo, deletedBy },
      }),
      signal: ctrl.signal,
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: { data?: { json?: { ok?: boolean } } };
      error?: { json?: { message?: string } };
    } | null;
    const errMsg = data?.error?.json?.message;
    if (errMsg || !data?.result?.data?.json?.ok) {
      console.error(`[wmsSync] 刪單同步失敗（${orderNo}）：${errMsg ?? `HTTP ${resp.status}`} — WMS 嗰邊要人手跟（官網中心訂單詳細資料刪多一次）`);
    }
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? `timeout ${PER_CALL_TIMEOUT_MS / 1000}s`
        : e instanceof Error
          ? e.message
          : "network error";
    console.error(`[wmsSync] 刪單同步失敗（${orderNo}）：${msg} — WMS 嗰邊要人手跟（官網中心訂單詳細資料刪多一次）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 最新嗰張 pending 截圖（冇 pending 就攞最新一張） */
function pickProof(proofs: ProofRow[]): ProofRow | null {
  const sorted = [...proofs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return sorted.find((p) => p.status === "pending") ?? sorted[0] ?? null;
}

/** 讀上傳目錄嘅截圖做 base64；webp / 太大 / 讀唔到 → null（WMS 用 screenshotUrl 睇） */
async function loadScreenshot(
  imagePath: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const file = path.basename(imagePath); // 擋 path traversal
  const ext = path.extname(file).toLowerCase();
  // WMS doc 淨係列 jpeg/png：webp 唔附 base64
  if (ext !== ".jpg" && ext !== ".jpeg" && ext !== ".png") return null;
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  try {
    const buf = await readFile(path.join(process.env.UPLOADS_DIR || "uploads", file));
    if (buf.byteLength > MAX_SCREENSHOT_BYTES) return null;
    return { base64: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

export interface ForwardResult {
  status: SyncStatus;
  lineCount: number;
  okCount: number;
  lastError: string | null;
}

function validWebhookOrderId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 舊紀錄 JSON 有可能缺件／格式壞；只承認正整數 ID，null 會保留做未成功件。 */
export function parseWebhookOrderIds(raw: string | null): (number | null)[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => (validWebhookOrderId(value) ? value : null));
  } catch {
    return [];
  }
}

function hasAutoRetryMarker(lastError: string | null): boolean {
  return Boolean(lastError?.startsWith(WMS_AUTO_RETRY_PREFIX));
}

function syncingMarker(autoRetry: boolean, token: string): string {
  return `${autoRetry ? WMS_AUTO_RETRY_PREFIX : ""}${WMS_SYNCING_PREFIX}${token}]`;
}

function isSyncingMessage(lastError: string | null): boolean {
  return Boolean(lastError?.includes(WMS_SYNCING_PREFIX));
}

function withAutoRetryMarker(autoRetry: boolean, message: string): string {
  return `${autoRetry ? `${WMS_AUTO_RETRY_PREFIX} ` : ""}${message}`;
}

/** attempts=0 係從未嘗試嘅新排隊；其後按上次嘗試次數退避。 */
export function wmsRetryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return WMS_RETRY_DELAYS_MS[Math.min(attempts - 1, WMS_RETRY_DELAYS_MS.length - 1)];
}

export function isWmsAutoRetryDue(
  row: { status: string; attempts: number; updatedAt: Date; lastError: string | null },
  now = new Date(),
): boolean {
  if (!["pending", "partial", "failed", "disabled"].includes(row.status)) return false;
  if (!hasAutoRetryMarker(row.lastError) || row.attempts >= WMS_MAX_AUTO_ATTEMPTS) return false;
  const age = now.getTime() - row.updatedAt.getTime();
  if (isSyncingMessage(row.lastError)) return age >= WMS_CLAIM_STALE_MS;
  return age >= wmsRetryDelayMs(row.attempts);
}

interface OrderItemRow {
  productName: string;
  size: string | null;
  price: number;
  quantity: number;
}

/**
 * v1.3 §1.2 — 逐件計「扣完優惠碼嘅單件實收金額」：
 * 按行項目金額比例攤分全單折扣，四捨五入 2 位，最後一件食尾數（令逐件加返埋＝實收總額）。
 * 冇優惠碼 → 逐件照原價。
 */
function allocateActualPrices(
  items: OrderItemRow[],
  discountAmount: number,
  orderTotal: number,
): number[] {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (discountAmount <= 0 || subtotal <= 0) {
    return items.map((i) => i.price);
  }
  const result: number[] = [];
  let allocated = 0;
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const lineTotal = item.price * item.quantity;
    let unitActual: number;
    if (idx === items.length - 1) {
      // 最後一件食尾數：實收總額減晒之前已攤嘅
      unitActual = (orderTotal - allocated) / item.quantity;
    } else {
      const lineDiscount = discountAmount * (lineTotal / subtotal);
      unitActual = (lineTotal - lineDiscount) / item.quantity;
    }
    unitActual = Math.round(unitActual * 100) / 100;
    allocated += unitActual * item.quantity;
    result.push(unitActual);
  }
  return result;
}

/**
 * 將一張官網訂單逐件貨送去 WMS（每 call 一件，sourceRef 全部都係官網單號）。
 * 永遠唔 throw：結果寫落 wmsSyncLog，官網落單流程唔受 WMS 狀態影響。
 */
export async function forwardOrderToWms(
  orderId: number,
  options: { autoRetry?: boolean } = {},
): Promise<ForwardResult> {
  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: { items: true, proofs: true, user: true },
  });
  if (!order) {
    return { status: "failed", lineCount: 0, okCount: 0, lastError: "訂單不存在" };
  }

  const proof = pickProof(order.proofs);
  const lineCount = order.items.length;

  // 未送網絡之前先落持久排隊；onConflict 解決同一張單雙擊／開機重試同時插入。
  let prev = await db.query.wmsSyncLog.findFirst({
    where: eq(wmsSyncLog.orderId, orderId),
  });
  let autoRetry = options.autoRetry === true || !prev || hasAutoRetryMarker(prev.lastError);
  if (!prev) {
    await db.insert(wmsSyncLog).values({
      orderId,
      proofId: proof?.id ?? null,
      status: "pending",
      lineCount,
      okCount: 0,
      attempts: 0,
      lastError: autoRetry ? WMS_AUTO_QUEUE_MESSAGE : "等待送往 WMS",
    }).onConflictDoNothing({ target: wmsSyncLog.orderId });
    prev = await db.query.wmsSyncLog.findFirst({
      where: eq(wmsSyncLog.orderId, orderId),
    });
    autoRetry = autoRetry || hasAutoRetryMarker(prev?.lastError ?? null);
  }
  if (!prev) {
    return { status: "failed", lineCount, okCount: 0, lastError: "未能建立 WMS 同步排隊" };
  }

  const prevIds = parseWebhookOrderIds(prev.webhookOrderIds);
  const prevOkCount = prevIds.filter(validWebhookOrderId).length;
  if (prev.status === "sent" && lineCount > 0 && prevIds.slice(0, lineCount).every(validWebhookOrderId) && prevOkCount >= lineCount) {
    return { status: "sent", lineCount, okCount: lineCount, lastError: null };
  }

  // 已批准／拒絕／取消嘅單唔可以靠人手重試或舊工作者再次開單。
  if (order.status !== "payment_review") {
    return {
      status: "failed",
      lineCount,
      okCount: prevOkCount,
      lastError: `訂單狀態係 ${order.status}，唔再送往 WMS`,
    };
  }

  // 進行中嘅工作者每件貨都會 heartbeat；只有超過 stale 時限先俾另一工作者接手。
  if (isSyncingMessage(prev.lastError) && Date.now() - prev.updatedAt.getTime() < WMS_CLAIM_STALE_MS) {
    return { status: "pending", lineCount, okCount: prevOkCount, lastError: "WMS 同步進行中，唔會重複推送" };
  }

  if (!wmsConfigured()) {
    const lastError = withAutoRetryMarker(autoRetry, "未設定 WMS_API_KEY（或者 WMS_SYNC_DISABLED=1）");
    const updated = await db
      .update(wmsSyncLog)
      .set({
        status: "disabled",
        lineCount,
        okCount: prevOkCount,
        proofId: proof?.id ?? null,
        lastError,
        attempts: prev.attempts + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(wmsSyncLog.id, prev.id),
        sql`${wmsSyncLog.lastError} IS NOT DISTINCT FROM ${prev.lastError}`,
      ))
      .returning({ id: wmsSyncLog.id });
    if (updated.length !== 1) {
      return { status: "pending", lineCount, okCount: prevOkCount, lastError: "WMS 同步狀態啱啱更新咗，請稍後再試" };
    }
    return { status: "disabled", lineCount, okCount: prevOkCount, lastError };
  }

  if (lineCount === 0) {
    const lastError = withAutoRetryMarker(autoRetry, "訂單冇貨品，未能送往 WMS");
    await db
      .update(wmsSyncLog)
      .set({ status: "failed", lineCount: 0, okCount: 0, lastError, updatedAt: new Date() })
      .where(and(
        eq(wmsSyncLog.id, prev.id),
        sql`${wmsSyncLog.lastError} IS NOT DISTINCT FROM ${prev.lastError}`,
      ));
    return { status: "failed", lineCount: 0, okCount: 0, lastError };
  }

  // 樂觀鎖原子認領：最後訊息係狀態版本，舊值一變，第二個工作者就認領失敗；
  // 唔單靠毫秒級 updatedAt。DB transaction 唔包住 HTTP call。
  const claimToken = randomUUID();
  const claimMessage = syncingMarker(autoRetry, claimToken);
  const claimedAt = new Date();
  const claimed = await db
    .update(wmsSyncLog)
    .set({
      status: "pending",
      lineCount,
      proofId: proof?.id ?? null,
      lastError: claimMessage,
      attempts: prev.attempts + 1,
      updatedAt: claimedAt,
    })
    .where(and(
      eq(wmsSyncLog.id, prev.id),
      sql`${wmsSyncLog.lastError} IS NOT DISTINCT FROM ${prev.lastError}`,
    ))
    .returning({ id: wmsSyncLog.id });
  if (claimed.length !== 1) {
    return { status: "pending", lineCount, okCount: prevOkCount, lastError: "另一個 WMS 同步工作者已接手，唔會重複推送" };
  }

  const ids: (number | null)[] = Array.from({ length: lineCount }, (_, i) => prevIds[i] ?? null);
  const errors: string[] = [];
  const updateOwned = async (patch: Partial<typeof wmsSyncLog.$inferInsert>) => {
    const rows = await db
      .update(wmsSyncLog)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(wmsSyncLog.id, prev.id), eq(wmsSyncLog.lastError, claimMessage)))
      .returning({ id: wmsSyncLog.id });
    if (rows.length !== 1) throw new Error("WMS 同步認領已轉手，停止覆寫進度");
  };

  try {

  const screenshot = proof ? await loadScreenshot(proof.imagePath) : null;
  const actualPrices = allocateActualPrices(
    order.items,
    order.discountAmount ?? 0,
    order.total,
  );
  // 2026-07-28 WMS 更新：sourcePayload items 每件加 listedDate（YYYY-MM-DD），
  // WMS 用貨品上架日期做訂單日期，等倉管對返邊批貨
  const productIds = [...new Set(order.items.map((i) => i.productId))];
  const productRows = await db
    .select({ id: products.id, listedDate: products.listedDate, image: products.image, photos: products.photos })
    .from(products)
    .where(inArray(products.id, productIds));
  const listedDateMap = new Map(productRows.map((p) => [p.id, hktDate(p.listedDate)]));
  const productImageMap = new Map(productRows.map((p) => [p.id, { image: p.image, photos: p.photos }]));

  const sourcePayload = JSON.stringify({
    orderNo: order.orderNo,
    orderDateHKT: hktDate(order.createdAt),
    status: order.status,
    total: order.total,
    discountAmount: order.discountAmount,
    promoCode: order.promoCode,
    address: order.address,
    // v1.3+：順豐站／智能櫃（選填）；普通送貨就 method=address、pickupPoint=null
    delivery: {
      method: order.deliveryMethod ?? "address",
      pickupPoint: order.pickupPoint ?? null,
      // v2.1.0（VIP+免運）：站點 ID＋地區，WMS 詳情頁／出貨對照用（WMS 唔識嘅欄會忽略）
      stationId: order.stationId ?? null,
      region: order.region ?? "HK",
    },
    note: order.note,
    // v2.1.0（VIP+免運）：系統備註（澳門單／免運／到付等，落單時寫定）；
    // WMS order.receiveWebhook 有現成 remark 欄（v1.3 schema 已有），唔使改 WMS
    remark: order.remark ?? null,
    shippingFree: order.shippingFree ?? false,
    vipTierAtPurchase: order.vipTierAtPurchase ?? null,
    customer: order.user
      ? {
          name: order.user.name,
          phone: order.user.phone,
          email: order.user.email ?? null,
          age: order.user.age ?? null,
          registeredAt: hktDate(order.user.createdAt),
        }
      : // 2026-10-09 訪客單：冇會員物件，客戶資料由 guest* 快照出（WMS 唔使改）
        {
          name: order.guestName ?? "訪客",
          phone: order.guestPhone ?? "",
          email: order.guestEmail ?? null,
          age: null,
          registeredAt: null,
          // 訪客旗標：WMS 批准落訂單管理時備註要寫明【官網訂單】【訪客單】（老闆指示）
          isGuest: true,
        },
    items: order.items.map((i) => {
      const p = productImageMap.get(i.productId);
      const paths = p ? (p.photos && p.photos.length ? p.photos : [p.image]) : [];
      return {
        // v2.5.1（Wave 2 出貨同步）：WMS 出貨回調用 orderItemId 對返官網貨品行
        // （舊單冇呢個欄，WMS 嗰邊會當 legacy 單跳過自動回調，人手跟）
        orderItemId: i.id,
        sku: i.sku,
        name: i.productName,
        size: i.size,
        quantity: i.quantity,
        price: i.price,
        listedDate: listedDateMap.get(i.productId) ?? null,
        imageUrls: paths.length ? paths.map((u) => `${publicBaseUrl()}${u}`) : null,
      };
    }),
    screenshotUrl: proof ? `${publicBaseUrl()}${proof.imagePath}` : null,
  });

  for (let i = 0; i < order.items.length; i++) {
    // WMS 對相同 sourceRef＋貨品 key 嘅 pending／approved 行有 dedup；
    // 已保存成功 ID 嘅件仍然直接 skip，唔依賴網絡重送去對數。
    if (validWebhookOrderId(ids[i])) continue;

    // 審批回調可能喺上一 call 之後先到；一離開 payment_review 就停止，唔再開新一輪。
    const current = await db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { status: true },
    });
    if (current?.status !== "payment_review") {
      errors.push(`訂單狀態已轉做 ${current?.status ?? "不存在"}，停止後續 WMS 推送`);
      break;
    }

    const item = order.items[i];
    const remark = [
      `官網訂單 ${order.orderNo}${lineCount > 1 ? `（共 ${lineCount} 件，第 ${i + 1} 件）` : ""}`,
      // 2026-10-09 訪客單（老闆指示）：訪客單備註要寫明【訪客單】＋訪客電話，
      // WMS 批准入訂單管理時會變「【官網訂單】官網訂單 RC…｜【訪客單】…｜訪客電話：…」——官網＋訪客＋電話齊晒
      order.userId == null
        ? `【訪客單】訪客購買（無會員帳號，即時網上付款）｜訪客電話：${order.guestPhone ?? "未填"}`
        : null,
      // 2026-09-29 三 bug hotfix：Airwallex 網上收款嘅單冇付款截圖——寫明收款已確認＋intent 單號，
      // 同事審批時唔使等截圖，直接去 Airwallex 後台對 merchant_order_id（＝官網單號）
      order.paymentChannel === "airwallex"
        ? `Airwallex 網上收款已確認${order.airwallexIntentId ? `（${order.airwallexIntentId}）` : ""}，無需付款截圖`
        : null,
      // v2.1.0：discountAmount 而家包括 VIP 折扣＋優惠碼折扣；呢度拆返優惠碼嗰部分出嚟寫
      order.promoCode
        ? `優惠碼 ${order.promoCode}（全單減 HK$${Math.max(0, order.discountAmount - (order.vipDiscountCents ?? 0) / 100)}）`
        : null,
      // v2.1.0（VIP+免運）：VIP 折扣同免運／地區備註都要寫明，等 WMS 同事寄件知收唔收運費
      (order.vipDiscountCents ?? 0) > 0
        ? `VIP${order.vipTierAtPurchase === "GOLD" ? "金" : "銀"}會員折扣（全單已減 HK$${(order.vipDiscountCents ?? 0) / 100}）`
        : null,
      order.remark ? `系統備註：${order.remark}` : null,
      order.note ? `客人備註：${order.note}` : null,
      !screenshot && proof ? `截圖：${publicBaseUrl()}${proof.imagePath}` : null,
    ]
      .filter(Boolean)
      .join("｜");
    const raw = await callReceiveWebhook({
      customerName: order.user ? order.user.name : `【訪客】${order.guestName ?? "客人"}`,
      customerPhone: order.user ? order.user.phone : (order.guestPhone ?? ""),
      // 2026-07-28 WMS《貨號欄位修正請求》：productCode 改送貨號 sku，
      // 有尺寸就「貨號-尺寸」（例如 B133-S）；舊單萬一冇 sku 就跟返產品名稱
      productCode: item.size
        ? `${item.sku || item.productName}-${item.size}`
        : item.sku || item.productName,
      amount: String(item.quantity),
      // v1.3 §1.2：actualPrice 改送扣完優惠碼嘅單件實收
      actualPrice: String(actualPrices[i]),
      orderDate: hktDate(order.createdAt),
      remark,
      source: "website",
      sourceRef: order.orderNo,
      sourcePayload,
      paymentScreenshot: screenshot?.base64,
      paymentScreenshotMimeType: screenshot?.mimeType,
    });
    const r: WmsCallResult = !raw.error && !validWebhookOrderId(raw.webhookOrderId)
      ? { webhookOrderId: null, error: "WMS 回覆成功但欠 webhookOrderId，未能確認收單編號" }
      : raw;
    if (r.error) {
      errors.push(r.error);
    } else {
      ids[i] = r.webhookOrderId;
    }

    // 每一件完成即刻保存 ID＋heartbeat；Render 重啟都唔會丢低已確認嘅進度。
    await updateOwned({
      lineCount,
      okCount: ids.filter(validWebhookOrderId).length,
      webhookOrderIds: JSON.stringify(ids),
    });
  }

  const okCount = ids.filter(validWebhookOrderId).length;
  const status: SyncStatus = okCount === lineCount ? "sent" : okCount === 0 ? "failed" : "partial";
  const lastError = errors.length > 0 ? withAutoRetryMarker(autoRetry, errors[0]) : null;
  await updateOwned({
    status,
    lineCount,
    okCount,
    webhookOrderIds: JSON.stringify(ids),
    lastError,
  });
  console.log(`[wms] forward ${order.orderNo}: ${status} (${okCount}/${lineCount})`);
  return { status, lineCount, okCount, lastError };
  } catch (e) {
    const message = e instanceof Error ? e.message : "WMS 同步例外";
    const okCount = ids.filter(validWebhookOrderId).length;
    const status: SyncStatus = okCount > 0 ? "partial" : "failed";
    const lastError = withAutoRetryMarker(autoRetry, message.slice(0, 1000));
    // 認領已轉手／DB 暫時寫唔到都唔可以再 throw 返去落單流程；保留 loud log。
    await db
      .update(wmsSyncLog)
      .set({
        status,
        lineCount,
        okCount,
        webhookOrderIds: JSON.stringify(ids),
        lastError,
        updatedAt: new Date(),
      })
      .where(and(eq(wmsSyncLog.id, prev.id), eq(wmsSyncLog.lastError, claimMessage)))
      .catch(() => undefined);
    console.error(`[wms] forward order #${orderId} 例外：${message}`);
    return { status, lineCount, okCount, lastError };
  }
}

export interface WmsRetrySweepResult {
  scanned: number;
  attempted: number;
  sent: number;
  failed: number;
}

/**
 * 開機／每 5 分鐘掃描：只處理有 auto:v1 標記、官網仍係 payment_review、未到重試上限嘅單。
 * 歷史紀錄同 sent 單唔會無差別重播；已拒絕但回調正常到達嘅單亦會畀 orders.status 擋住。
 */
export async function retryPendingWmsSync(now = new Date()): Promise<WmsRetrySweepResult> {
  if (!wmsConfigured()) return { scanned: 0, attempted: 0, sent: 0, failed: 0 };
  const db = getDb();
  const rows = await db
    .select({
      orderId: wmsSyncLog.orderId,
      status: wmsSyncLog.status,
      attempts: wmsSyncLog.attempts,
      updatedAt: wmsSyncLog.updatedAt,
      lastError: wmsSyncLog.lastError,
    })
    .from(wmsSyncLog)
    .innerJoin(orders, eq(orders.id, wmsSyncLog.orderId))
    .where(and(
      eq(orders.status, "payment_review"),
      inArray(wmsSyncLog.status, ["pending", "partial", "failed", "disabled"]),
      like(wmsSyncLog.lastError, `${WMS_AUTO_RETRY_PREFIX}%`),
      lt(wmsSyncLog.attempts, WMS_MAX_AUTO_ATTEMPTS),
    ))
    .orderBy(asc(wmsSyncLog.updatedAt))
    .limit(50);

  const due = rows.filter((row) => isWmsAutoRetryDue(row, now)).slice(0, WMS_RETRY_BATCH_LIMIT);
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const result = await forwardOrderToWms(row.orderId, { autoRetry: true });
      if (result.status === "sent") {
        sent += 1;
        void logAudit({
          actorId: null,
          actorRole: "system",
          actorNameFallback: "WMS 同步排程",
          action: "order.wmsAutoResync",
          targetType: "order",
          targetId: row.orderId,
          detail: `WMS 同步自動重試成功（${result.okCount}/${result.lineCount} 件，第 ${row.attempts + 1} 次嘗試）`,
        });
      } else if (result.status !== "pending") {
        failed += 1;
      }
    } catch (e) {
      failed += 1;
      console.error(`[wms] 自動重試訂單 #${row.orderId} 失敗:`, e);
    }
  }
  return { scanned: rows.length, attempted: due.length, sent, failed };
}

/**
 * 客人重傳付款截圖（attachPaymentProof，訂單由 rejected 再入 payment_review）之前必做：
 * 重置而非刪除同步列，等 forwardOrderToWms 唔會 skip 舊成功件（v1.3 §2.3）。
 * lastError 一變，舊工作者嘅 owner guard 會即時失效，唔可以覆寫新一輪進度。
 * WMS 端保證舊 rejected 紀錄唔會觸發 dedup 阻擋，重送會開新一輪 pending。
 */
export async function resetWmsSyncLogForReupload(orderId: number): Promise<void> {
  const db = getDb();
  await db.insert(wmsSyncLog).values({
    orderId,
    proofId: null,
    status: "pending",
    lineCount: 0,
    okCount: 0,
    webhookOrderIds: null,
    lastError: WMS_AUTO_QUEUE_MESSAGE,
    attempts: 0,
  }).onConflictDoUpdate({
    target: wmsSyncLog.orderId,
    set: {
      proofId: null,
      status: "pending",
      lineCount: 0,
      okCount: 0,
      webhookOrderIds: null,
      lastError: WMS_AUTO_QUEUE_MESSAGE,
      attempts: 0,
      updatedAt: new Date(),
    },
  });
}

/**
 * WMS → 官網審批回調：`POST /api/wms/review-callback`（規格跟 RED_CODE_WEBHOOK_API_v1.3.md §二）
 * body: { secret, sourceRef, decision: "approved" | "rejected", rejectType?: "cancel" | "reupload", note? }
 *
 * v1.3 分流：
 *   approved                       → 訂單轉 approved（已確認＝終態），最新 pending 截圖標記 approved
 *   rejected + rejectType=cancel   → 訂單轉 cancelled（訂單取消，終態），note 記入 reviewNote
 *   rejected + rejectType=reupload → 訂單轉 rejected（待客人重傳截圖），note 顯示比客人知點解
 *   rejected（冇 rejectType 舊格式）→ 一律當 cancel 處理（文檔向後兼容指引）
 * Idempotent：已係終態（approved／cancelled）或 rejected 嘅訂單直接回 { ok: true, already: true }。
 * 每次成功轉態都寫入審計日誌（action: order.wmsApprove / order.wmsReupload / order.wmsCancel）。
 */
export async function wmsReviewCallback(c: Context) {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!secretEquals(b.secret, secret)) {
    return c.json({ ok: false, error: "secret 唔啱" }, 401);
  }
  const orderNo = typeof b.sourceRef === "string" ? b.sourceRef.trim() : "";
  const decision = b.decision;
  if (!orderNo || (decision !== "approved" && decision !== "rejected")) {
    return c.json(
      { ok: false, error: "需要 sourceRef + decision（approved|rejected）" },
      400,
    );
  }
  // v1.3：rejectType 淨係認 "reupload"，其餘（包括冇呢個欄位嘅舊格式）一律當 cancel
  const rejectType = b.rejectType === "reupload" ? "reupload" : "cancel";
  const noteText = typeof b.note === "string" ? b.note : "";

  // v2026.11.09（網站設計服務）：WD 前綴單分流去專用 handler（api/webDesignWms.ts）；
  // 普通商品路徑（下面）逐字保持，唔受影響。
  if (isWebDesignOrderNo(orderNo)) {
    const { webDesignReviewCallback } = await import("./webDesignWms");
    return webDesignReviewCallback(c, { orderNo, decision, rejectType, note: noteText });
  }

  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: {
      proofs: true,
      items: true,
      user: { columns: { name: true, email: true, phone: true } },
    },
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }
  if (order.status === "approved" || order.status === "cancelled" || order.status === "rejected") {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  if (order.status !== "payment_review" && order.status !== "pending_payment") {
    return c.json(
      { ok: false, error: `訂單狀態係 ${order.status}，唔可以審批`, status: order.status },
      409,
    );
  }

  // 官網訂單新狀態：approved＝已確認；cancel＝已取消；reupload＝rejected（待重傳）
  const nextStatus =
    decision === "approved" ? "approved" : rejectType === "reupload" ? "rejected" : "cancelled";
  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    // WMS 取消訂單＝貨唔會出，落單時扣咗嘅庫存要加返
    // （上面 idempotent 檢查已擋住重複取消，唔會加兩次）
    if (nextStatus === "cancelled") {
      for (const item of order.items) {
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${item.quantity}` })
          .where(eq(products.id, item.productId));
      }
    }
  });
  const pendingProof = order.proofs.find((p) => p.status === "pending");
  if (pendingProof) {
    await db
      .update(paymentProofs)
      .set({
        status: decision === "approved" ? "approved" : "rejected",
        reviewNote:
          noteText ||
          (decision === "approved"
            ? "WMS 審批通過"
            : rejectType === "reupload"
              ? "WMS 要求重新上傳付款截圖"
              : "WMS 取消訂單"),
        reviewedAt: new Date(),
      })
      .where(eq(paymentProofs.id, pendingProof.id));
  }
  // 已確認通知 email（2026-08-04）：WMS 批准＝訂單確認，同後台人手批准一樣要寄確認信＋單據；
  // 之前呢段漏咗，WMS 自動批嘅單全部冇寄到確認信（客人收唔到嘅根因）
  let emailNote = "";
  if (decision === "approved") {
    // 2026-10-09 訪客單：冇會員物件就用 guest* 快照（訪客單 guestEmail 必填）
    const member = order.user ?? (order.guestEmail
      ? { email: order.guestEmail, name: order.guestName ?? "客人", phone: order.guestPhone ?? "" }
      : null);
    if (member?.email) {
      // v2.5.5 第8版（購物金）：確認信＋PDF 單據要列購物金扣減＋餘額（截至扣減時間）
      const { getOrderWalletSpend } = await import("./wallet");
      const walletSpend =
        (order.walletUsed ?? 0) > 0 ? await getOrderWalletSpend(order.orderNo) : null;
      const result = await sendOrderApprovedEmail({
        to: member.email,
        name: member.name,
        phone: member.phone,
        orderNo: order.orderNo,
        createdAt: order.createdAt,
        items: order.items.map((it) => ({
          productName: it.productName,
          size: it.size,
          price: it.price,
          originalPrice: it.originalPrice,
          quantity: it.quantity,
        })),
        total: order.total,
        discountAmount: order.discountAmount,
        vip: orderVipEmailInfo(order),
        delivery: {
          method: order.deliveryMethod,
          pickupPoint: order.pickupPoint,
          address: order.address,
        },
        wallet: walletSpend ?? ((order.walletUsed ?? 0) > 0 ? { used: order.walletUsed ?? 0 } : null),
      });
      emailNote = result.ok
        ? `；確認信＋單據已寄出至 ${member.email}`
        : `；確認信寄出失敗（${result.error ?? "未知原因"}）`;
    } else {
      emailNote = "；會員冇綁 Email，冇寄確認信";
    }
  }
  // 審計日誌：WMS 回傳嘅審批結果（批准／要求重傳／取消）落後台「日誌」頁翻查
  // v2.1.0（VIP+免運）：WMS 批准＝訂單確認收款，背景重算會員 VIP 級別（同後台人手批准一致）
  if (decision === "approved") {
    if (order.userId != null) recomputeVipTierInBackground(order.userId, order.orderNo); // 訪客單冇 VIP 可計
  }
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action:
      decision === "approved"
        ? "order.wmsApprove"
        : rejectType === "reupload"
          ? "order.wmsReupload"
          : "order.wmsCancel",
    targetType: "order",
    targetId: order.orderNo,
    detail: `WMS 回傳審批：${decision === "approved" ? "批准" : rejectType === "reupload" ? "要求重傳付款截圖" : "取消訂單"}（訂單 ${order.orderNo} → ${nextStatus}）${noteText ? `，備註：${noteText}` : ""}${emailNote}`,
  });
  console.log(
    `[wms] callback ${decision}${decision === "rejected" ? ` (${rejectType})` : ""} for ${orderNo} → ${nextStatus}`,
  );
  return c.json({ ok: true, orderNo: order.orderNo, status: nextStatus });
}
