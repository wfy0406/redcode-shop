/**
 * WMS → 官網退款回調（2026-09 F7 WMS↔官網原路退款）：`POST /api/wms/refund-callback`
 * 模式照 api/wmsSync.ts 嘅 wmsReviewCallback（shared secret ＋ JSON body ＋ 冪等）。
 *
 * body: { secret, orderNo, action: "request" | "approve" | "reject",
 *         amount?, reason?, requestedBy?, reviewedBy?, note? }
 * （secret 兩邊共用 WMS_CALLBACK_SECRET；amount＝整數港元，同 orders.total 一個單位，
 *   全鏈唔乘除 100，例如 HK$79＝79）
 *
 * 流程（Glo 原話落實）：
 *   ① request（員工喺 WMS 申請）：已付款單（payment_review/approved/shipped/completed）
 *      先受理 → refundStatus='pending'，等主管批；未付款／已取消 → 409。
 *   ② approve（主管批咗＝即刻執行退款）：
 *      - Airwallex 網上付款單 → createAirwallexRefund 原路退款（request_id 用
 *        `refund-order-${order.id}`，deterministic → Airwallex 去重，retry 唔會退兩次），
 *        成功 → 訂單轉 cancelled＋refundStatus='refunded'，補返庫存，寄退款 email 畀客人；
 *        失敗 → refundStatus='failed'（錯誤訊息截 200 字落 refundNote），之後可以 retry。
 *      - 手動過數單 → 唔經 Airwallex，標記 refundStatus='manual'（同事用原付款方式
 *        人手退回），訂單照樣轉 cancelled＋補庫存＋寄 email。
 *   ③ reject（主管拒絕）：refundStatus='rejected'，note 記低拒絕原因。
 * 冪等：已 refunded／manual 嘅 approve 直接回 { ok:true, already:true }，唔會退兩次；
 *   補庫存放喺 status 轉 cancelled 嘅同一個 transaction（冪等檢查已擋重複，唔會加兩次）。
 * 每次狀態改動都寫審計日誌（order.refundRequest / order.refundApproved /
 *   order.refundFailed / order.refundRejected，actorRole=system）；寄信失敗淨係 log 唔 throw。
 */
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { orders, products } from "@db/schema";
import { logAudit } from "./audit";
import { createAirwallexRefund } from "./airwallex";
import { sendOrderRefundedEmail, orderVipEmailInfo } from "./email";

/** 已過咗付款階段嘅訂單狀態——淨係呢啲單先可以申請退款 */
const REFUNDABLE_STATUSES: readonly string[] = [
  "payment_review",
  "approved",
  "shipped",
  "completed",
];

export async function wmsRefundCallback(c: Context) {
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
  const orderNo = typeof b.orderNo === "string" ? b.orderNo.trim() : "";
  const action = b.action;
  if (!orderNo || (action !== "request" && action !== "approve" && action !== "reject")) {
    return c.json(
      { ok: false, error: "需要 orderNo + action（request|approve|reject）" },
      400,
    );
  }
  const amount =
    typeof b.amount === "number" && Number.isFinite(b.amount) && b.amount > 0
      ? Math.round(b.amount)
      : null;
  const reason = typeof b.reason === "string" ? b.reason : "";
  const requestedBy = typeof b.requestedBy === "string" ? b.requestedBy : "";
  const reviewedBy = typeof b.reviewedBy === "string" ? b.reviewedBy : "";
  const noteText = typeof b.note === "string" ? b.note : "";

  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: {
      items: true,
      user: { columns: { name: true, email: true, phone: true } },
    },
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }

  // ─── action=request：員工申請退款（等主管批）───────────────────────────
  if (action === "request") {
    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      return c.json({ ok: false, error: "訂單未付款或已取消，唔可以申請退款" }, 409);
    }
    if (order.refundStatus !== "none" && order.refundStatus !== "rejected") {
      return c.json(
        { ok: false, error: `退款狀態係 ${order.refundStatus}，唔可以重複申請` },
        409,
      );
    }
    // WMS 冇填金額就當全單退款（整數港元，同 orders.total 一個單位，直接儲）
    const refundAmount = amount ?? order.total;
    await db
      .update(orders)
      .set({
        refundStatus: "pending",
        refundAmount,
        refundNote: reason || null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.refundRequest",
      targetType: "order",
      targetId: order.orderNo,
      detail: `WMS 退款申請（訂單 ${order.orderNo}，HK$${refundAmount}）${requestedBy ? `，申請人：${requestedBy}` : ""}${reason ? `，原因：${reason}` : ""}`,
    });
    console.log(`[wms] refund request for ${orderNo} → pending`);
    return c.json({ ok: true });
  }

  // ─── action=approve：主管批咗＝即刻執行退款 ────────────────────────────
  if (action === "approve") {
    // 冪等：已退過（無論原路定人手）直接回成功，唔會退兩次
    if (order.refundStatus === "refunded" || order.refundStatus === "manual") {
      return c.json({ ok: true, already: true, result: order.refundStatus });
    }
    // failed 准 retry（例如 Airwallex 頭先斷線）；其他狀態（none/rejected）唔批得
    if (order.refundStatus !== "pending" && order.refundStatus !== "failed") {
      return c.json(
        { ok: false, error: `退款狀態係 ${order.refundStatus}，未有待執行嘅退款` },
        409,
      );
    }
    const refundAmount = order.refundAmount ?? order.total;
    const refundedAt = new Date();
    let channel: "airwallex" | "manual";
    let refundId: string | null = null;

    if (order.paymentChannel === "airwallex" && order.airwallexIntentId) {
      // Airwallex 網上付款單 → 原路退款
      try {
        const r = await createAirwallexRefund({
          paymentIntentId: order.airwallexIntentId,
          amount: refundAmount,
          requestId: `refund-order-${order.id}`,
          reason: order.refundNote ?? undefined,
        });
        refundId = r.id;
        channel = "airwallex";
      } catch (e) {
        const errMsg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        await db
          .update(orders)
          .set({ refundStatus: "failed", refundNote: errMsg, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        void logAudit({
          actorId: null,
          actorRole: "system",
          actorNameFallback: "WMS",
          action: "order.refundFailed",
          targetType: "order",
          targetId: order.orderNo,
          detail: `Airwallex 原路退款失敗（訂單 ${order.orderNo}）：${errMsg}${reviewedBy ? `（批准人：${reviewedBy}）` : ""}`,
        });
        console.error(`[wms] refund approve for ${orderNo} → failed: ${errMsg}`);
        return c.json({ ok: false, error: errMsg });
      }
    } else {
      // 手動過數單 → 唔經 Airwallex，標記人手退款（同事用原付款方式退回）
      channel = "manual";
    }

    // 退款成立：訂單轉 cancelled＋每個 item 嘅庫存加返（同一個 transaction，
    // 做法照 wmsReviewCallback cancel；上面冪等檢查已擋重複 approve，唔會補兩次）
    await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({
          refundStatus: channel === "airwallex" ? "refunded" : "manual",
          airwallexRefundId: refundId,
          refundedAt,
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
      for (const item of order.items) {
        await tx
          .update(products)
          .set({ stock: sql`${products.stock} + ${item.quantity}` })
          .where(eq(products.id, item.productId));
      }
    });

    // 退款通知 email 畀客人（never-throw；失敗淨係寫落日誌 detail，唔阻回應）
    // 訪客單（userId null）用落單時留低嘅 guest 快照；會員單用 user relation
    let emailNote = "";
    const custEmail = order.user?.email ?? order.guestEmail ?? null;
    const custName = order.user?.name ?? order.guestName ?? "客人";
    if (custEmail) {
      const result = await sendOrderRefundedEmail({
        to: custEmail,
        name: custName,
        orderNo: order.orderNo,
        items: order.items.map((it) => ({
          productName: it.productName,
          size: it.size,
          price: it.price,
          quantity: it.quantity,
        })),
        total: order.total,
        refundAmount,
        channel,
        refundedAt,
        // v2.1.1（Wave 2）：退款信一樣顯示 VIP 級別＋折扣（全網單據統一）
        vip: orderVipEmailInfo(order),
      });
      emailNote = result.ok
        ? `；退款通知信已寄出至 ${custEmail}`
        : `；退款通知信寄出失敗（${result.error ?? "未知原因"}）`;
    } else {
      emailNote = order.userId == null
        ? "；訪客單冇留 Email，冇寄退款通知信"
        : "；會員冇綁 Email，冇寄退款通知信";
    }
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.refundApproved",
      targetType: "order",
      targetId: order.orderNo,
      detail: `WMS 退款已批准（訂單 ${order.orderNo}，HK$${refundAmount}，${channel === "airwallex" ? `Airwallex 原路退款${refundId ? `，refund ${refundId}` : ""}` : "人手退款"}）${reviewedBy ? `，批准人：${reviewedBy}` : ""}；訂單轉已取消，庫存已補返${emailNote}`,
    });
    console.log(
      `[wms] refund approve for ${orderNo} → ${channel === "airwallex" ? "refunded" : "manual"}${refundId ? ` (${refundId})` : ""}`,
    );
    return c.json({
      ok: true,
      result: channel === "airwallex" ? "refunded" : "manual",
      ...(refundId ? { refundId } : {}),
    });
  }

  // ─── action=reject：主管拒絕 ───────────────────────────────────────────
  if (order.refundStatus === "refunded" || order.refundStatus === "manual") {
    return c.json({ ok: true, already: true });
  }
  if (order.refundStatus !== "pending") {
    return c.json(
      { ok: false, error: `退款狀態係 ${order.refundStatus}，冇待審批嘅退款申請` },
      409,
    );
  }
  await db
    .update(orders)
    .set({ refundStatus: "rejected", refundNote: noteText || null, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "order.refundRejected",
    targetType: "order",
    targetId: order.orderNo,
    detail: `WMS 退款已拒絕（訂單 ${order.orderNo}）${reviewedBy ? `，拒絕人：${reviewedBy}` : ""}${noteText ? `，原因：${noteText}` : ""}`,
  });
  console.log(`[wms] refund reject for ${orderNo} → rejected`);
  return c.json({ ok: true });
}
