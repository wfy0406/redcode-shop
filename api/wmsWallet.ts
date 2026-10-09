/**
 * WMS → 官網購物金充值批核回調（v2.5.0 購物金）：`POST /api/wms/wallet-topup-review`
 * 模式照 api/wmsRefund.ts（shared secret ＋ JSON body ＋ 冪等）。
 *
 * 老闆指令：「購物金要官網後台或WMS批准，批准後購物金先會入帳」——
 * 官網後台行 walletRouter.reviewTopup；WMS 嗰邊批核就打呢個 endpoint，
 * 兩邊共用 approveTopupCore 入帳（conditional update 冪等，唔會入兩次）。
 *
 * body: { secret, topupNo, approve: boolean, note?, reviewedBy? }
 *   （secret 兩邊共用 WMS_CALLBACK_SECRET；approve=true 入帳、false 拒絕）
 *
 * 流程：
 *   ① approve：approveTopupCore（payment_review→approved 同事務加餘額＋記賬）
 *      → 寄入帳信畀會員（never-throw）→ audit wallet.topupApprove（actorRole=system）。
 *   ② reject：conditional update payment_review→rejected（購物金唔會郁）
 *      → 寄拒絕信（附原因）→ audit wallet.topupReject。
 * 冪等：已 approved／rejected 嘅單直接回 { ok:true, already:true }；
 *   其他狀態（pending_payment／cancelled）回 409——未付款／已逾時嘅單唔批得。
 * 寄信失敗淨係寫落日誌 detail，唔阻回應（同其他 callback 一致）。
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { users, walletTopups } from "@db/schema";
import { logAudit } from "./audit";
import { sendWalletTopupApprovedEmail, sendWalletTopupRejectedEmail } from "./email";
import { approveTopupCore } from "./walletRouter";
import { TOPUP_CHANNEL_LABEL } from "./wallet";

export async function wmsWalletTopupReview(c: Context) {
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
  const topupNo = typeof b.topupNo === "string" ? b.topupNo.trim() : "";
  const approve = b.approve;
  if (!topupNo || typeof approve !== "boolean") {
    return c.json(
      { ok: false, error: "需要 topupNo + approve（true 批准｜false 拒絕）" },
      400,
    );
  }
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  const reviewedBy =
    typeof b.reviewedBy === "string" && b.reviewedBy.trim() ? b.reviewedBy.trim().slice(0, 64) : "WMS";

  const db = getDb();
  const topup = await db.query.walletTopups.findFirst({
    where: eq(walletTopups.topupNo, topupNo),
  });
  if (!topup) {
    return c.json({ ok: false, error: `搵唔到充值單 ${topupNo}` }, 404);
  }
  // 冪等：已處理過直接回成功
  if (topup.status === "approved" || topup.status === "rejected") {
    return c.json({ ok: true, already: true, status: topup.status });
  }
  if (topup.status !== "payment_review") {
    return c.json(
      { ok: false, error: `充值單狀態係 ${topup.status}，未有待批核嘅付款` },
      409,
    );
  }

  const member = await db.query.users.findFirst({
    where: eq(users.id, topup.userId),
    columns: { name: true, email: true },
  });

  // ─── 拒絕 ──────────────────────────────────────────────────────────────
  if (!approve) {
    const [rejected] = await db
      .update(walletTopups)
      .set({ status: "rejected", reviewNote: note, updatedAt: new Date() })
      .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "payment_review")))
      .returning();
    if (!rejected) {
      return c.json({ ok: true, already: true, status: "rejected" });
    }
    let emailNote = "";
    if (member?.email) {
      const r = await sendWalletTopupRejectedEmail({
        to: member.email,
        name: member.name,
        topupNo: topup.topupNo,
        label: topup.label,
        price: topup.price,
        note,
      });
      emailNote = r.ok ? `，拒絕信已寄出至 ${member.email}` : `，拒絕信寄出失敗（${r.error ?? "未知原因"}）`;
    } else {
      emailNote = "，會員冇綁 Email，冇寄拒絕信";
    }
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "wallet.topupReject",
      targetType: "walletTopup",
      targetId: topup.topupNo,
      detail: `WMS 拒絕充值單 ${topup.topupNo}（${topup.label}，HK$${topup.price}）${note ? `，原因：${note}` : ""}，批核人：${reviewedBy}${emailNote}`,
    });
    console.log(`[wms] wallet topup ${topup.topupNo} → rejected by ${reviewedBy}`);
    return c.json({ ok: true, status: "rejected" });
  }

  // ─── 批准：入帳 core（冪等）────────────────────────────────────────────
  const result = await approveTopupCore(topup.id, reviewedBy, note);
  if (!result) {
    return c.json({ ok: true, already: true, status: "approved" });
  }
  let emailNote = "";
  if (member?.email) {
    const r = await sendWalletTopupApprovedEmail({
      to: member.email,
      name: member.name,
      topupNo: topup.topupNo,
      label: topup.label,
      creditAmount: topup.creditAmount,
      balanceAfter: result.balanceAfter,
      channel: TOPUP_CHANNEL_LABEL[topup.paymentChannel] ?? topup.paymentChannel,
    });
    emailNote = r.ok ? `，入帳信已寄出至 ${member.email}` : `，入帳信寄出失敗（${r.error ?? "未知原因"}）`;
  } else {
    emailNote = "，會員冇綁 Email，冇寄入帳信";
  }
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "wallet.topupApprove",
    targetType: "walletTopup",
    targetId: topup.topupNo,
    detail: `WMS 批准充值單 ${topup.topupNo}：入帳 HK$${topup.creditAmount}，會員最新餘額 HK$${result.balanceAfter}，批核人：${reviewedBy}${emailNote}`,
  });
  console.log(
    `[wms] wallet topup ${topup.topupNo} → approved by ${reviewedBy}, balance HK$${result.balanceAfter}`,
  );
  return c.json({ ok: true, status: "approved", balanceAfter: result.balanceAfter });
}
