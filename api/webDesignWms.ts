/**
 * 網站設計服務 ↔ WMS（v2026.11.09）：
 * - forwardWebDesignOrderToWms：付款確認後將服務單送去 WMS `order.receiveWebhook`
 *   （一項「網頁設計（前台／前台＋後台）」；remark 包含要求／風格／全部功能／月費；
 *   sourcePayload.items 帶正式訂單圖絕對 URL；**淨送 URL，唔送 base64**——paymentScreenshot 有 500k 字限制）。
 *   sourcePayload.items[0].sku 同 productCode 完全一致（用訂單號，保證單單獨立）。
 * - webDesignReviewCallback／webDesignShipmentCallback：WMS callback 嘅 WD 前綴分流
 *   （由 api/wmsSync.ts／api/wmsShipment.ts 舊 handler 開頭 delegate 落嚟；普通商品路徑逐字不變）。
 *
 * WMS 未配置／失敗：訂單照保存，wmsStatus/wmsError 落 DB＋loud console.error，後台可 retryWms，唔靜默。
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { webDesignOrders, webDesignPaymentProofs } from "@db/schema";
import { logAudit } from "./audit";
import {
  buildWmsRemark,
  mapWmsReviewForWebDesign,
  mapWmsShipmentForWebDesign,
  wmsServiceItemName,
} from "./webDesignCore";
import { callReceiveWebhook, wmsConfigured } from "./wmsSync";

const DEFAULT_PUBLIC_BASE_URL = "https://redcode.red";

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, "");
}

/** HKT（UTC+8）YYYY-MM-DD */
function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export interface WdForwardResult {
  status: "sent" | "failed" | "disabled";
  wmsWebhookOrderId: string | null;
  error: string | null;
}

/**
 * 將一張網站設計單送去 WMS（never-throw；結果寫落 webDesignOrders.wms* 欄）。
 * 冪等：WMS 以 sourceRef（＝orderNo）對單；已成功（wmsStatus='sent' 且有 webhookOrderId）直接回。
 */
export async function forwardWebDesignOrderToWms(orderId: number): Promise<WdForwardResult> {
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: eq(webDesignOrders.id, orderId),
    with: { items: true },
  });
  if (!order) {
    return { status: "failed", wmsWebhookOrderId: null, error: "訂單不存在" };
  }
  if (order.wmsStatus === "sent" && order.wmsWebhookOrderId) {
    return { status: "sent", wmsWebhookOrderId: order.wmsWebhookOrderId, error: null };
  }
  // API retry 同內部呼叫都唔可以繞過付款閘：未付／已取消服務單唔准落入 WMS。
  if (order.status === "cancelled" || order.paymentStatus !== "paid") {
    const error = "訂單未確認付款或者已取消，唔會同步去 WMS";
    return { status: "failed", wmsWebhookOrderId: null, error };
  }

  const save = async (patch: Partial<typeof webDesignOrders.$inferInsert>) => {
    await db
      .update(webDesignOrders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(webDesignOrders.id, order.id));
  };

  if (!wmsConfigured()) {
    const error = "未設定 WMS_API_KEY（或者 WMS_SYNC_DISABLED=1）";
    await save({ wmsStatus: "disabled", wmsError: error });
    console.error(`[wms] 網站設計單 ${order.orderNo} 未能同步：${error}（訂單已保存，後台可 retry）`);
    return { status: "disabled", wmsWebhookOrderId: null, error };
  }

  const plan = order.plan === "full_stack" ? ("full_stack" as const) : ("front_only" as const);
  const itemName = wmsServiceItemName(plan);
  const featureNames = order.items
    .filter((i) => !i.itemKey.startsWith("plan_"))
    .map((i) => (i.billing === "monthly" ? `${i.name}（每月 HK$${i.price}）` : i.name));
  const orderImageUrl = order.orderImagePath ? `${publicBaseUrl()}${order.orderImagePath}` : null;
  const paymentNote =
    order.paymentChannel === "airwallex"
      ? `Airwallex 網上收款已確認${order.airwallexIntentId ? `（${order.airwallexIntentId}）` : ""}，無需付款截圖`
      : "手動過數，付款證明已喺官網後台核實";

  const sourcePayload = JSON.stringify({
    orderNo: order.orderNo,
    orderDateHKT: hktDate(order.createdAt),
    kind: "web_design",
    plan: order.plan,
    status: order.status,
    paymentStatus: order.paymentStatus,
    oneOffTotal: order.oneOffTotal,
    monthlyTotal: order.monthlyTotal,
    total: order.total,
    requirements: order.requirements,
    styleNotes: order.styleNotes,
    customer: { name: order.name, phone: order.phone, email: order.email ?? null },
    items: [
      {
        // 契約：sku 必須同上面 productCode 完全一致（用訂單號，單單獨立）
        sku: order.orderNo,
        name: itemName,
        quantity: 1,
        price: order.total,
        imageUrls: orderImageUrl ? [orderImageUrl] : null,
      },
    ],
    orderImageUrl,
  });

  const remark = buildWmsRemark({
    orderNo: order.orderNo,
    plan,
    itemNames: featureNames,
    requirements: order.requirements,
    styleNotes: order.styleNotes,
    monthlyTotal: order.monthlyTotal,
    paymentNote,
  });

  const r = await callReceiveWebhook({
    customerName: order.name,
    customerPhone: order.phone,
    productCode: order.orderNo,
    amount: "1",
    actualPrice: String(order.total),
    orderDate: hktDate(order.createdAt),
    remark,
    source: "website",
    sourceRef: order.orderNo,
    sourcePayload,
    // 服務單淨送 URL，唔送 base64（paymentScreenshot base64 有 500k 字限制）
  });

  if (r.error) {
    await save({ wmsStatus: "failed", wmsError: r.error });
    console.error(`[wms] 網站設計單 ${order.orderNo} 轉 WMS 失敗：${r.error}（訂單已保存，後台可 retry）`);
    return { status: "failed", wmsWebhookOrderId: null, error: r.error };
  }
  const webhookOrderId = r.webhookOrderId != null ? String(r.webhookOrderId) : null;
  await save({ wmsStatus: "sent", wmsError: null, wmsWebhookOrderId: webhookOrderId });
  console.log(`[wms] 網站設計單 ${order.orderNo} 已轉 WMS（webhookOrderId ${webhookOrderId ?? "?"}）`);
  return { status: "sent", wmsWebhookOrderId: webhookOrderId, error: null };
}

// ─── WMS → 官網 callback 分流（WD 前綴；secret 已喺舊 handler 驗完）──────────

/**
 * review-callback 專用分支：approved → in_production＋paid；rejected+reupload → payment rejected；
 * rejected（cancel／舊格式）→ cancelled。冪等：終態（completed／cancelled）或已係目標狀態回 already。
 */
export async function webDesignReviewCallback(
  c: Context,
  args: { orderNo: string; decision: "approved" | "rejected"; rejectType: "cancel" | "reupload"; note: string },
) {
  const { orderNo, decision, rejectType, note } = args;
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: eq(webDesignOrders.orderNo, orderNo),
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }
  if (order.status === "completed" || order.status === "cancelled") {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  const mapped = mapWmsReviewForWebDesign(decision, rejectType);
  const nextStatus = mapped.status ?? order.status;
  const nextPayment = mapped.paymentStatus ?? order.paymentStatus;
  if (nextStatus === order.status && nextPayment === order.paymentStatus) {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  const now = new Date();
  await db
    .update(webDesignOrders)
    .set({
      status: nextStatus,
      paymentStatus: nextPayment,
      // WMS 批准＝付款確認：paidAt 未寫先補（手動單 reviewProof 通常已寫）
      ...(nextPayment === "paid" && !order.paidAt ? { paidAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(webDesignOrders.id, order.id));
  // 最新 pending 截圖跟埋轉態（approved→approved；rejected→rejected 連原因）
  const proofs = await db.query.webDesignPaymentProofs.findMany({
    where: eq(webDesignPaymentProofs.orderId, order.id),
  });
  const target = proofs.find((p) => p.status === "pending");
  if (target) {
    await db
      .update(webDesignPaymentProofs)
      .set({
        status: decision === "approved" ? "approved" : "rejected",
        reviewNote: note || `WMS ${mapped.label}`,
        reviewedAt: now,
      })
      .where(eq(webDesignPaymentProofs.id, target.id));
  }
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: mapped.auditAction,
    targetType: "webDesignOrder",
    targetId: order.orderNo,
    detail: `WMS 回傳審批：${mapped.label}（網站設計單 ${order.orderNo} → status ${nextStatus}／payment ${nextPayment}）${note ? `，備註：${note}` : ""}`,
  });
  console.log(`[wms] webDesign callback ${decision}${decision === "rejected" ? ` (${rejectType})` : ""} for ${orderNo} → ${nextStatus}/${nextPayment}`);
  return c.json({ ok: true, orderNo: order.orderNo, status: nextStatus, paymentStatus: nextPayment });
}

/**
 * shipment-callback 專用分支（服務單：shipped＝網站交付完成）：
 *   shipped → completed＋completedAt；unshipped → in_production（清 completedAt）。
 *   其他 action（item_* 等）唔適用 → { ok:true, ignored:true }（唔畀 WMS 無限 retry）。
 */
export async function webDesignShipmentCallback(
  c: Context,
  args: { orderNo: string; action: string; actorName: string },
) {
  const { orderNo, action, actorName } = args;
  const mapped = mapWmsShipmentForWebDesign(action);
  if (!mapped) {
    return c.json({ ok: true, ignored: true, orderNo, note: `action ${action} 唔適用於網站設計單` });
  }
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: eq(webDesignOrders.orderNo, orderNo),
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }
  if (order.status === mapped.status) {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  if (order.status === "cancelled") {
    return c.json({ ok: true, already: true, orderNo: order.orderNo, status: order.status });
  }
  await db
    .update(webDesignOrders)
    .set({
      status: mapped.status,
      completedAt: mapped.setCompletedAt ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(webDesignOrders.id, order.id));
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: mapped.status === "completed" ? "webDesign.wmsCompleted" : "webDesign.wmsUnshipped",
    targetType: "webDesignOrder",
    targetId: order.orderNo,
    detail: `WMS ${action === "shipped" ? "交付完成" : "撤回交付"}（網站設計單 ${order.orderNo} → ${mapped.status}）${actorName ? `，經手：${actorName}` : ""}`,
  });
  console.log(`[wms] webDesign shipment ${action} for ${orderNo} → ${mapped.status}`);
  return c.json({ ok: true, orderNo: order.orderNo, status: mapped.status });
}
