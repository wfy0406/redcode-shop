/**
 * 網站設計服務 ↔ WMS（v2026.11.12，網頁設計獨立專案管理 SPEC）：
 * - forwardWebDesignOrderToWms：付款確認後將服務單送去 WMS `webDesignProject.receiveWebsite`
 *   （**唔再經 order.receiveWebhook**——WMS 直接建立獨立專案，唔寫 orders/shipments/webhookOrders；
 *   payload 傳齊 orderNo、客戶、方案、功能、款項、要求、風格、orderDate、paidAt、
 *   orderImageUrl、paymentNote、sourcePayload；圖淨送絕對 URL，唔送 base64）。
 *   WMS 冪等：同一 orderNo 重複送回 { success:true, deduped:true, projectNo }，照樣記 sent。
 *   現有 varchar `wmsWebhookOrderId` 沿用儲存新 projectNo（唔改 schema），後台顯示「WMS 專案編號」。
 * - webDesignReviewCallback／webDesignShipmentCallback：WMS callback 嘅 WD 前綴分流**保留畀歷史舊單**
 *   （由 api/wmsSync.ts／api/wmsShipment.ts 舊 handler 開頭 delegate 落嚟；普通商品路徑逐字不變）。
 *
 * WMS 未配置／失敗：訂單照保存，wmsStatus/wmsError 落 DB＋loud console.error，後台可 retryWms，唔靜默。
 * 部署順序 WMS 先官網後：若 WMS 未有 receiveWebsite，會如實 failed（唔會寫假 sent），retryWms 可補送。
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { webDesignOrders, webDesignPaymentProofs } from "@db/schema";
import { logAudit } from "./audit";
import { planLabel } from "@contracts/webDesign";
import {
  mapWmsReviewForWebDesign,
  mapWmsShipmentForWebDesign,
  wmsServiceItemName,
} from "./webDesignCore";
import { callReceiveWebDesignProject, wmsConfigured } from "./wmsSync";

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
 * 冪等：WMS 以 orderNo 對專案（重複回 deduped）；已成功（wmsStatus='sent' 且有 webhookOrderId）直接回。
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
  const orderImageUrl = order.orderImagePath ? `${publicBaseUrl()}${order.orderImagePath}` : null;
  const paymentNote =
    order.paymentChannel === "airwallex"
      ? `Airwallex 網上收款已確認${order.airwallexIntentId ? `（${order.airwallexIntentId}）` : ""}，無需付款截圖`
      : "手動過數，付款證明已喺官網後台核實";
  // 落單快照嘅全部行（方案基本價行＋功能行）：WMS 專案 serviceItems 直接用呢份，
  // 款項 oneOffTotal＋monthlyTotal 可以逐行對返
  const serviceItems = order.items.map((i) => ({
    name: i.name,
    billing: i.billing === "monthly" ? ("monthly" as const) : ("one_off" as const),
    price: i.price,
  }));
  const paidAt = order.paidAt ? order.paidAt.toISOString() : null;

  // sourcePayload：完整落單快照（同舊 receiveWebhook 時期同形），WMS 原封存入專案做 audit trail
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
        // 契約：sku 用訂單號（單單獨立），同舊 receiveWebhook 時期一致
        sku: order.orderNo,
        name: itemName,
        quantity: 1,
        price: order.total,
        imageUrls: orderImageUrl ? [orderImageUrl] : null,
      },
    ],
    orderImageUrl,
  });

  const r = await callReceiveWebDesignProject({
    orderNo: order.orderNo,
    title: `官網服務單 ${order.orderNo}（${order.name}）`,
    clientName: order.name,
    phone: order.phone,
    email: order.email ?? null,
    plan,
    planLabel: planLabel(plan),
    serviceItems,
    oneOffTotal: order.oneOffTotal,
    monthlyTotal: order.monthlyTotal,
    total: order.total,
    requirements: order.requirements,
    styleNotes: order.styleNotes,
    orderDate: hktDate(order.createdAt),
    paidAt,
    orderImageUrl,
    paymentNote,
    sourcePayload,
    // 服務單淨送 URL，唔送 base64（paymentScreenshot base64 有 500k 字限制）
  });

  if (r.error) {
    await save({ wmsStatus: "failed", wmsError: r.error });
    console.error(`[wms] 網站設計單 ${order.orderNo} 轉 WMS 專案失敗：${r.error}（訂單已保存，後台可 retry）`);
    return { status: "failed", wmsWebhookOrderId: null, error: r.error };
  }
  // 安全閘：transport 已擋 success 缺 projectNo，呢度再守一次——
  // 無論點都唔准寫「sent＋null」假成功（冇 projectNo 對唔返 WMS 專案，sent 閘又會擋死 retry）
  const projectNo = r.projectNo != null ? String(r.projectNo).trim() : "";
  if (!projectNo) {
    const error = "WMS 回應缺少專案編號";
    await save({ wmsStatus: "failed", wmsError: error });
    console.error(`[wms] 網站設計單 ${order.orderNo} 轉 WMS 專案失敗：${error}（訂單已保存，後台可 retry）`);
    return { status: "failed", wmsWebhookOrderId: null, error };
  }
  // 成功（包括 WMS deduped 重複回）：wmsWebhookOrderId 沿用存 projectNo（唔改 schema）
  await save({ wmsStatus: "sent", wmsError: null, wmsWebhookOrderId: projectNo });
  console.log(
    `[wms] 網站設計單 ${order.orderNo} 已轉 WMS 專案（projectNo ${projectNo}${r.deduped ? "，deduped" : ""}）`,
  );
  return { status: "sent", wmsWebhookOrderId: projectNo, error: null };
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
