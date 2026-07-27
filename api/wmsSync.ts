/**
 * RedCode 官網 ↔ Red Code WMS 訂單接入（依 RED_CODE_WEBHOOK_API.md v1.0）
 *
 * 方向一（官網 → WMS）：客人上傳付款截圖之後，訂單逐件貨 call WMS `order.receiveWebhook`，
 *   WMS 管理員/主管喺「審批中心 → 官網訂單審批」見到（連截圖 base64），批准/拒絕。
 * 方向二（WMS → 官網）：WMS 審批完 POST 返我哋 `POST /api/wms/review-callback`（shared secret），
 *   官網訂單自動轉 approved/rejected（效果同後台人手審批一樣）。
 *
 * 防重複：一單一列 wmsSyncLog，webhookOrderIds 同 orderItems 對位；已成功嘅件 skip，
 *   因為 WMS 唔會 dedup sourceRef，重複 send 會重複出單。
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
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { orders, paymentProofs, wmsSyncLog } from "@db/schema";

const DEFAULT_WMS_BASE_URL = "https://red-code-wms.onrender.com";
const DEFAULT_PUBLIC_BASE_URL = "https://redcode.red";
const PER_CALL_TIMEOUT_MS = 20_000;
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
  const sourcePayload = JSON.stringify({
    orderNo: order.orderNo,
    orderDateHKT: hktDate(order.createdAt),
    status: order.status,
    total: order.total,
    discountAmount: order.discountAmount,
    promoCode: order.promoCode,
    address: order.address,
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
      item.size ? `尺寸：${item.size}` : null,
      order.promoCode ? `優惠碼 ${order.promoCode}（全單減 HK$${order.discountAmount}）` : null,
      order.note ? `客人備註：${order.note}` : null,
      !screenshot && proof ? `截圖：${publicBaseUrl()}${proof.imagePath}` : null,
    ]
      .filter(Boolean)
      .join("｜");
    const r = await callReceiveWebhook({
      customerName: order.user.name,
      customerPhone: order.user.phone,
      customerEmail: order.user.email ?? undefined,
      productCode: item.sku,
      color: item.size ?? undefined,
      amount: String(item.quantity),
      actualPrice: String(item.price),
      orderDate: hktDate(order.createdAt),
      sessionNo: "0",
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
 * WMS → 官網審批回調：`POST /api/wms/review-callback`
 * body: { secret, sourceRef, decision: "approved" | "rejected", note? }
 * 效果同後台人手審批一樣：訂單轉 approved/rejected + 最新 pending 截圖標記已審。
 * Idempotent：已審批過嘅訂單直接回 ok（WMS 重試唔會出事）。
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
  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: { proofs: true },
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }
  if (order.status === "approved" || order.status === "rejected") {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  if (order.status !== "payment_review" && order.status !== "pending_payment") {
    return c.json(
      { ok: false, error: `訂單狀態係 ${order.status}，唔可以審批`, status: order.status },
      409,
    );
  }
  await db
    .update(orders)
    .set({ status: decision, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
  const pendingProof = order.proofs.find((p) => p.status === "pending");
  if (pendingProof) {
    await db
      .update(paymentProofs)
      .set({
        status: decision,
        reviewNote:
          (typeof b.note === "string" && b.note) ||
          (decision === "approved" ? "WMS 審批通過" : "WMS 審批拒絕"),
        reviewedAt: new Date(),
      })
      .where(eq(paymentProofs.id, pendingProof.id));
  }
  console.log(`[wms] callback ${decision} for ${orderNo}`);
  return c.json({ ok: true, orderNo: order.orderNo, status: decision });
}
