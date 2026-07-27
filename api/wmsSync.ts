/**
 * RedCode 官網 ↔ Red Code WMS 訂單接入（依 RED_CODE_WEBHOOK_API_v1.3.md v1.3，2026-07-27）
 * v1.1：截圖照舊純 base64 傳；錯誤碼用 error.json.message 解析；paymentMethod: "FPS"。
 * v1.2（§九）：WMS 審批完自動回調 /api/wms/review-callback —— 官網一早已實裝。
 * v1.3：webhook payload 調整 + 回調 rejectType 分流：
 *   ① productCode 改送「產品名稱」（有尺寸就 {名稱}-{尺寸}，例如「針織上衣-S」），唔再送 SKU；
 *   ② actualPrice 改送扣完優惠碼嘅單件實收（按行金額比例攤分，最後一件食尾數）；
 *   ③ 停送 customerEmail／paymentMethod／sessionNo／color；remark 唔再包「尺寸」段；
 *   ④ 回調 decision=rejected 新增 rejectType：cancel＝訂單取消（終態）／reupload＝付款重傳
 *     （冇 rejectType 嘅舊格式 rejected 一律當 cancel，跟文檔向後兼容指引）；
 *   ⑤ 客人重傳截圖時 ordersRouter 會先清走 wmsSyncLog，等重審件可以重新送落 WMS。
 *
 * 方向一（官網 → WMS）：客人上傳付款截圖之後，訂單逐件貨 call WMS `order.receiveWebhook`，
 *   WMS 管理員/主管喺「審批中心 → 官網訂單審批」見到（連截圖 base64），批准/拒絕。
 * 方向二（WMS → 官網）：WMS 審批完 POST 返我哋 `POST /api/wms/review-callback`（shared secret），
 *   官網訂單自動轉 approved（已確認＝終態）／cancelled（訂單取消）／rejected（待客人重傳截圖）。
 *
 * 防重複：一單一列 wmsSyncLog，webhookOrderIds 同 orderItems 對位；已成功嘅件 skip；
 *   客人重傳截圖時會先清走嗰列，否則重審件永遠送唔到（v1.3 §2.3）。
 *
 * Env：
 *   WMS_API_KEY          WMS 管理員提供嘅 apiKey（未設 → 同步記錄標 disabled，官網照行）
 *   WMS_BASE_URL         預設 https://red-code-wms.onrender.com
 *   WMS_CALLBACK_SECRET  官網自己出嘅 shared secret，WMS callback 要帶嚟
 *   WMS_SYNC_DISABLED    設 "1" 即停用 forward（唔使改 code redeploy）
 *   PUBLIC_BASE_URL      預設 https://redcode.red（screenshotUrl 用）
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { orders, paymentProofs, products, wmsSyncLog } from "@db/schema";

const DEFAULT_WMS_BASE_URL = "https://red-code-wms.onrender.com";
const DEFAULT_PUBLIC_BASE_URL = "https://redcode.red";
// Render 免費版冷啟動：WMS 瞓著後首個 request 要 60–130s 先醒（WMS 方 2026-07-28 實測 133s），
// 20s timeout 會斬纜 → 畀足 90s，冷啟動都接得住；溫熱時 <1s 唔受影響
const PER_CALL_TIMEOUT_MS = 90_000;
// 大過呢個 size 就唔附 base64（WMS 可經 sourcePayload.screenshotUrl 睇原圖）
const MAX_SCREENSHOT_BYTES = 1_800_000;

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

/** 調 WMS order.receiveWebhook（tRPC HTTP：body 要包 { json: ... }；apiKey 擺 body，唔係 header） */
async function callReceiveWebhook(body: Record<string, unknown>): Promise<WmsCallResult> {
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

type ProofRow = { id: number; imagePath: string; status: string; createdAt: Date };

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
export async function forwardOrderToWms(orderId: number): Promise<ForwardResult> {
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

  // 之前嘅同步記錄（一單一列）
  const prev = await db.query.wmsSyncLog.findFirst({
    where: eq(wmsSyncLog.orderId, orderId),
  });
  const prevIds: (number | null)[] = prev?.webhookOrderIds
    ? (JSON.parse(prev.webhookOrderIds) as (number | null)[])
    : [];

  const upsertSync = async (patch: Partial<typeof wmsSyncLog.$inferInsert>) => {
    if (prev) {
      await db
        .update(wmsSyncLog)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(wmsSyncLog.id, prev.id));
    } else {
      await db.insert(wmsSyncLog).values({
        orderId,
        proofId: proof?.id ?? null,
        ...patch,
      });
    }
  };

  if (!wmsConfigured()) {
    const lastError = "未設定 WMS_API_KEY（或者 WMS_SYNC_DISABLED=1）";
    await upsertSync({
      status: "disabled",
      lineCount,
      okCount: 0,
      lastError,
      attempts: (prev?.attempts ?? 0) + 1,
    });
    return { status: "disabled", lineCount, okCount: 0, lastError };
  }

  const screenshot = proof ? await loadScreenshot(proof.imagePath) : null;
  const actualPrices = allocateActualPrices(
    order.items,
    order.discountAmount ?? 0,
    order.total,
  );
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
    },
    note: order.note,
    customer: {
      name: order.user.name,
      phone: order.user.phone,
      email: order.user.email ?? null,
    },
    items: order.items.map((i) => ({
      sku: i.sku,
      name: i.productName,
      size: i.size,
      quantity: i.quantity,
      price: i.price,
    })),
    screenshotUrl: proof ? `${publicBaseUrl()}${proof.imagePath}` : null,
  });

  const results: WmsCallResult[] = [];
  for (let i = 0; i < order.items.length; i++) {
    // 已成功嘅件 skip——WMS 唔 dedup sourceRef，重複 send 會重複出單
    if (prevIds[i]) {
      results.push({ webhookOrderId: prevIds[i], error: null });
      continue;
    }
    const item = order.items[i];
    const remark = [
      `官網訂單 ${order.orderNo}${lineCount > 1 ? `（共 ${lineCount} 件，第 ${i + 1} 件）` : ""}`,
      order.promoCode ? `優惠碼 ${order.promoCode}（全單減 HK$${order.discountAmount}）` : null,
      order.note ? `客人備註：${order.note}` : null,
      !screenshot && proof ? `截圖：${publicBaseUrl()}${proof.imagePath}` : null,
    ]
      .filter(Boolean)
      .join("｜");
    const r = await callReceiveWebhook({
      customerName: order.user.name,
      customerPhone: order.user.phone,
      // v1.3 §1.1：productCode 改送產品名稱，有尺寸就「名稱-尺寸」
      productCode: item.size ? `${item.productName}-${item.size}` : item.productName,
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
    results.push(r);
  }

  const okCount = results.filter((r) => !r.error).length;
  const status: SyncStatus =
    okCount === lineCount ? "sent" : okCount === 0 ? "failed" : "partial";
  const lastError = results.find((r) => r.error)?.error ?? null;
  await upsertSync({
    status,
    lineCount,
    okCount,
    webhookOrderIds: JSON.stringify(results.map((r) => r.webhookOrderId)),
    lastError,
    attempts: (prev?.attempts ?? 0) + 1,
  });
  console.log(`[wms] forward ${order.orderNo}: ${status} (${okCount}/${lineCount})`);
  return { status, lineCount, okCount, lastError };
}

/**
 * 客人重傳付款截圖（attachPaymentProof，訂單由 rejected 再入 payment_review）之前必做：
 * 清走嗰單嘅 wmsSyncLog，等 forwardOrderToWms 唔會 skip 舊成功件（v1.3 §2.3）。
 * WMS 端保證舊 rejected 紀錄唔會觸發 dedup 阻擋，重送會開新一輪 pending。
 */
export async function resetWmsSyncLogForReupload(orderId: number): Promise<void> {
  const db = getDb();
  await db.delete(wmsSyncLog).where(eq(wmsSyncLog.orderId, orderId));
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
  if (b.secret !== secret) {
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

  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: { proofs: true, items: true },
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
  console.log(
    `[wms] callback ${decision}${decision === "rejected" ? ` (${rejectType})` : ""} for ${orderNo} → ${nextStatus}`,
  );
  return c.json({ ok: true, orderNo: order.orderNo, status: nextStatus });
}
