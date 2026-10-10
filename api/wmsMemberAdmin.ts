/**
 * v2.2.1（合約 §9）：WMS → 官網會員管理 endpoint。
 * 模式照 api/wmsLivePush.ts（WMS_CALLBACK_SECRET shared secret ＋ JSON body），
 * 註冊喺 api/boot.ts（tRPC mount 前）。
 *
 * ─ POST /api/wms/member-admin
 *     共用欄：{secret, action, phone, requesterName?, requesterRole?}
 *     action：
 *     ─ get（全部角色可）：睇會員資料＋VIP 級別/到期＋促銷同意＋直播推送狀態/裝置清單
 *     ─ walletGet（全部角色可，唯讀）：購物金結餘＋流水賬（存入/使用/返還）
 *       ＋充值單（包括已取消）＋訂單一覽 —— WMS 官網中心會員頁用（2026-10-09 老闆指令）
 *     ─ walletTopupList（全部員工可，唯讀）：待批核充值單＋最近已處理紀錄
 *       —— WMS 官網中心「購物金批核」tab 用（v2.5.5 第9版，2026-10-11 老闆指令：批核搬去 WMS 官網中心）
 *     ─ walletTopupReview（全部員工可，同官網後台 reviewTopup 嘅 staff 級）：批准入帳／拒絕
 *       {topupNo, approve, note?}；同 wmsWallet.ts 回調共用 approveTopupCore（conditional update 冪等）
 *     ─ removePushDevice（supervisor/admin）：踢走一部裝置 {deviceId}
 *     ─ unsubscribePush（supervisor/admin）：拒絕接收直播推送＋註銷全部裝置
 *     ─ setMarketing（supervisor/admin）：直接促銷 設為接受/唔接受 {optIn}
 *     ─ setVipTier（supervisor/admin）：改 VIP 級別 {tier, expiresAt?}；
 *       升級會寄 VIP 證書 email＋寫門檻快照（同官網後台 setVipTier 同款行為）
 *
 * 安全：
 * ─ secret 用 timingSafeEqual 常數時間比對；永遠唔准落 log／audit；
 * ─ 裝置 endpoint／p256dh／auth 永遠唔回應、唔落 log（getMemberPushStatus 已保證）；
 * ─ 會員用 phone 搵（WMS 嗰邊用電話做 key）；員工帳號唔准俾 WMS 郁。
 */
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { pushSubscriptions, users, walletLedger, walletTopups, orders } from "@db/schema";
import { logAudit } from "./audit";
import { getMemberPushStatus } from "./membersRouter";
import { forwardMemberToWms } from "./wmsMemberSync";
import { getVipRules } from "./vip";
import { sendVipUpgradeEmail, sendWalletTopupApprovedEmail, sendWalletTopupRejectedEmail, siteUrl } from "./email";
import { buildVipVerifyUrl } from "./vipCert";
// v2.5.5 第9版：WMS 官網中心購物金批核（同 wmsWallet.ts 回調共用入帳核心，冪等）
import { approveTopupCore } from "./walletRouter";
import { TOPUP_CHANNEL_LABEL } from "./wallet";

const ACTIONS = ["get", "walletGet", "walletTopupList", "walletTopupReview", "removePushDevice", "unsubscribePush", "setMarketing", "setVipTier"] as const;
type Action = (typeof ACTIONS)[number];

/** 變更類 action 淨准主管／管理員（WMS 後端已按員工名查 DB 驗咗 role 先傳嚟；呢度再擋一層） */
const MUTATE_ACTIONS: Action[] = ["removePushDevice", "unsubscribePush", "setMarketing", "setVipTier"];

/** 攞 JSON body ＋ 常數時間比對 shared secret（同 wmsLivePush 一致嘅回錯款） */
async function readJsonWithSecret(
  c: Context,
): Promise<{ b: Record<string, unknown> } | { res: Response }> {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return { res: c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503) };
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { res: c.json({ ok: false, error: "body 要係 JSON" }, 400) };
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const given = typeof b.secret === "string" ? b.secret : "";
  const a = Buffer.from(given);
  const e = Buffer.from(secret);
  if (a.length !== e.length || !timingSafeEqual(a, e)) {
    return { res: c.json({ ok: false, error: "secret 唔啱" }, 401) };
  }
  return { b };
}

/** WMS 操作者（audit 用）：名＋角色，齋 log 顯示，永遠唔包含 secret */
function wmsActor(b: Record<string, unknown>): { name: string; role: string } {
  const name = typeof b.requesterName === "string" && b.requesterName.trim() ? b.requesterName.trim() : "WMS";
  const role = typeof b.requesterRole === "string" ? b.requesterRole : "staff";
  return { name, role };
}

function auditFromWms(
  actor: { name: string; role: string },
  entry: { action: string; targetId: string | number; detail: string },
): void {
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: `WMS:${actor.name}`,
    action: entry.action,
    targetType: "member",
    targetId: entry.targetId,
    detail: entry.detail,
  });
}

export async function wmsMemberAdmin(c: Context): Promise<Response> {
  const parsed = await readJsonWithSecret(c);
  if ("res" in parsed) return parsed.res;
  const { b } = parsed;

  const action = typeof b.action === "string" ? (b.action as Action) : ("" as Action);
  if (!ACTIONS.includes(action)) {
    return c.json({ ok: false, error: "action 唔啱（get/walletGet/walletTopupList/walletTopupReview/removePushDevice/unsubscribePush/setMarketing/setVipTier）" }, 400);
  }
  const actor = wmsActor(b);
  if (MUTATE_ACTIONS.includes(action) && actor.role !== "supervisor" && actor.role !== "admin") {
    return c.json({ ok: false, error: "呢個動作要主管或管理員" }, 403);
  }

  // ─── walletTopupList（v2.5.5 第9版；全部員工可，唯讀）：待批核充值單＋最近已處理紀錄 ───
  // 唔使會員電話（係全站待批清單）；截圖回絕對 URL（WMS 直接 <img> 用）
  if (action === "walletTopupList") {
    const db = getDb();
    const memberCols = { user: { columns: { name: true, phone: true, email: true } } } as const;
    const [pendingRows, recentRows] = await Promise.all([
      db.query.walletTopups.findMany({
        where: eq(walletTopups.status, "payment_review"),
        orderBy: [desc(walletTopups.createdAt), desc(walletTopups.id)],
        limit: 100,
        with: memberCols,
      }),
      db.query.walletTopups.findMany({
        where: or(eq(walletTopups.status, "approved"), eq(walletTopups.status, "rejected")),
        orderBy: [desc(walletTopups.updatedAt), desc(walletTopups.id)],
        limit: 30,
        with: memberCols,
      }),
    ]);
    const mapRow = (t: (typeof pendingRows)[number]) => ({
      topupNo: t.topupNo,
      label: t.label,
      creditAmount: t.creditAmount,
      price: t.price,
      status: t.status,
      paymentChannel: t.paymentChannel,
      proofUrl: t.proofImagePath
        ? `${siteUrl()}${t.proofImagePath.startsWith("/") ? "" : "/"}${t.proofImagePath}`
        : null,
      approvedBy: t.approvedBy,
      reviewNote: t.reviewNote,
      createdAt: t.createdAt.toISOString(),
      paidAt: t.paidAt ? t.paidAt.toISOString() : null,
      memberName: t.user?.name ?? "—",
      memberPhone: t.user?.phone ?? "—",
      memberEmail: t.user?.email ?? null,
    });
    return c.json({ ok: true, pending: pendingRows.map(mapRow), recent: recentRows.map(mapRow) });
  }

  // ─── walletTopupReview（v2.5.5 第9版；員工級，同官網後台 reviewTopup 一個級數）───
  // 批准＝approveTopupCore 入帳（冪等）＋寄入帳信；拒絕＝conditional update＋寄拒絕信。兩邊都記 audit。
  if (action === "walletTopupReview") {
    const topupNo = typeof b.topupNo === "string" ? b.topupNo.trim() : "";
    const approve = b.approve;
    if (!topupNo || typeof approve !== "boolean") {
      return c.json({ ok: false, error: "需要 topupNo + approve（true 批准｜false 拒絕）" }, 400);
    }
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    const db = getDb();
    const topup = await db.query.walletTopups.findFirst({
      where: eq(walletTopups.topupNo, topupNo),
    });
    if (!topup) {
      return c.json({ ok: false, error: `搵唔到充值單 ${topupNo}` }, 404);
    }
    // 冪等：已處理過直接回成功（WMS 嗰邊會 refresh 清單）
    if (topup.status === "approved" || topup.status === "rejected") {
      return c.json({ ok: true, already: true, status: topup.status });
    }
    if (topup.status !== "payment_review") {
      return c.json({ ok: false, error: `充值單狀態係 ${topup.status}，未有待批核嘅付款` }, 409);
    }
    const member = await db.query.users.findFirst({
      where: eq(users.id, topup.userId),
      columns: { name: true, email: true },
    });

    // ─ 拒絕 ─
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
        actorNameFallback: `WMS:${actor.name}`,
        action: "wallet.topupReject",
        targetType: "walletTopup",
        targetId: topup.topupNo,
        detail: `WMS 官網中心拒絕充值單 ${topup.topupNo}（${topup.label}，HK$${topup.price}）${note ? `，原因：${note}` : ""}，批核人：${actor.name}${emailNote}`,
      });
      return c.json({ ok: true, status: "rejected" });
    }

    // ─ 批准：入帳 core（冪等）─
    const result = await approveTopupCore(topup.id, actor.name, note);
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
      actorNameFallback: `WMS:${actor.name}`,
      action: "wallet.topupApprove",
      targetType: "walletTopup",
      targetId: topup.topupNo,
      detail: `WMS 官網中心批准充值單 ${topup.topupNo}：入帳 HK$${topup.creditAmount}，會員最新餘額 HK$${result.balanceAfter}，批核人：${actor.name}${emailNote}`,
    });
    return c.json({ ok: true, status: "approved", balanceAfter: result.balanceAfter });
  }

  const phone = typeof b.phone === "string" ? b.phone.trim() : "";
  if (!phone) {
    return c.json({ ok: false, error: "要填會員電話" }, 400);
  }

  const db = getDb();
  const [target] = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      phone: users.phone,
      email: users.email,
      storeCredit: users.storeCredit,
      vipTier: users.vipTier,
      vipEffectiveAt: users.vipEffectiveAt,
      vipExpiresAt: users.vipExpiresAt,
      marketingOptIn: users.marketingOptIn,
      livePushOptIn: users.livePushOptIn,
      livePushOptInAt: users.livePushOptInAt,
    })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  if (!target || target.role !== "member") {
    return c.json({ ok: false, error: "會員唔存在" }, 404);
  }

  // ─── get：會員資料＋直播推送狀態（裝置清單齊 label，唔齊 endpoint）───
  if (action === "get") {
    const push = await getMemberPushStatus(target.id);
    return c.json({
      ok: true,
      member: {
        id: target.id,
        name: target.name,
        phone: target.phone,
        email: target.email,
        vipTier: target.vipTier,
        vipEffectiveAt: target.vipEffectiveAt ? target.vipEffectiveAt.toISOString() : null,
        vipExpiresAt: target.vipExpiresAt ? target.vipExpiresAt.toISOString() : null,
        marketingOptIn: target.marketingOptIn ?? false,
        livePushOptIn: target.livePushOptIn ?? false,
        livePushOptInAt: target.livePushOptInAt ? target.livePushOptInAt.toISOString() : null,
      },
      push,
    });
  }

  // ─── walletGet（唯讀，全部員工可）：購物金結餘＋流水賬（存入/使用/返還）＋充值單（包括已取消）＋訂單一覽 ───
  // 2026-10-09 老闆指令：WMS 官網中心撳會員要睇到佢有幾多購物金、佢嘅訂單、購物金紀錄
  if (action === "walletGet") {
    const [topupRows, ledgerRows, orderRows] = await Promise.all([
      db.query.walletTopups.findMany({
        where: eq(walletTopups.userId, target.id),
        orderBy: [desc(walletTopups.createdAt), desc(walletTopups.id)],
        limit: 100,
      }),
      db.query.walletLedger.findMany({
        where: eq(walletLedger.userId, target.id),
        orderBy: [desc(walletLedger.createdAt), desc(walletLedger.id)],
        limit: 200,
      }),
      db.query.orders.findMany({
        where: eq(orders.userId, target.id),
        orderBy: [desc(orders.createdAt), desc(orders.id)],
        limit: 50,
        columns: { id: true, orderNo: true, status: true, total: true, createdAt: true },
        with: { items: { columns: { productName: true, size: true, quantity: true } } },
      }),
    ]);
    const channelByNo = Object.fromEntries(topupRows.map((t) => [t.topupNo, t.paymentChannel]));
    return c.json({
      ok: true,
      wallet: { balance: target.storeCredit ?? 0 },
      ledger: ledgerRows.map((l) => ({
        id: l.id,
        type: l.type, // topup=存入｜spend=使用｜refund=返還（WMS 側譯返中文）
        amount: l.amount,
        balanceAfter: l.balanceAfter,
        refType: l.refType, // 'topup'→充值單號｜'order'→訂單號
        refId: l.refId,
        note: l.note,
        channel: l.refType === "topup" ? (channelByNo[l.refId] ?? null) : null,
        createdAt: l.createdAt.toISOString(),
      })),
      topups: topupRows.map((t) => ({
        topupNo: t.topupNo,
        label: t.label,
        creditAmount: t.creditAmount,
        price: t.price,
        status: t.status, // pending_payment｜payment_review｜approved｜cancelled（取消=「取消」紀錄）
        paymentChannel: t.paymentChannel,
        approvedBy: t.approvedBy,
        reviewNote: t.reviewNote,
        createdAt: t.createdAt.toISOString(),
        paidAt: t.paidAt ? t.paidAt.toISOString() : null,
        approvedAt: t.approvedAt ? t.approvedAt.toISOString() : null,
      })),
      orders: orderRows.map((o) => {
        const names = o.items.map((it) => `${it.productName}${it.size ? `（${it.size}）` : ""} ×${it.quantity}`);
        return {
          id: o.id,
          orderNo: o.orderNo,
          status: o.status,
          total: o.total,
          itemCount: o.items.reduce((s, it) => s + it.quantity, 0),
          summary: names.length <= 2 ? names.join("、") : `${names.slice(0, 2).join("、")} 等 ${names.length} 件`,
          createdAt: o.createdAt.toISOString(),
        };
      }),
    });
  }

  // ─── removePushDevice：踢走一部裝置；踢晒就 optIn=false ───
  if (action === "removePushDevice") {
    const deviceId = typeof b.deviceId === "number" ? b.deviceId : Number(b.deviceId);
    if (!Number.isInteger(deviceId) || deviceId <= 0) {
      return c.json({ ok: false, error: "deviceId 唔啱" }, 400);
    }
    const updated = await db
      .update(pushSubscriptions)
      .set({ active: false })
      .where(
        and(
          eq(pushSubscriptions.id, deviceId),
          eq(pushSubscriptions.userId, target.id),
          eq(pushSubscriptions.active, true),
        ),
      )
      .returning({ id: pushSubscriptions.id });
    if (updated.length === 0) {
      return c.json({ ok: false, error: "裝置唔存在或已移除" }, 404);
    }
    const remaining = await db.query.pushSubscriptions.findMany({
      where: and(eq(pushSubscriptions.userId, target.id), eq(pushSubscriptions.active, true)),
      columns: { id: true },
    });
    if (remaining.length === 0) {
      await db.update(users).set({ livePushOptIn: false }).where(eq(users.id, target.id));
    }
    auditFromWms(actor, {
      action: "member.wmsRemovePushDevice",
      targetId: target.id,
      detail: `WMS ${actor.role === "admin" ? "管理員" : "主管"} ${actor.name} 移除會員「${target.name}」嘅直播推送裝置（訂閱 #${deviceId}）；剩餘有效裝置 ${remaining.length} 部`,
    });
    void forwardMemberToWms(target.id).catch((e) => console.error("[wms] member sync error:", e));
    return c.json({ ok: true, remainingDevices: remaining.length });
  }

  // ─── unsubscribePush：拒絕接收＋註銷全部裝置 ───
  if (action === "unsubscribePush") {
    await db
      .update(users)
      .set({ livePushOptIn: false, livePushOptInAt: new Date() })
      .where(eq(users.id, target.id));
    const deactivated = await db
      .update(pushSubscriptions)
      .set({ active: false })
      .where(and(eq(pushSubscriptions.userId, target.id), eq(pushSubscriptions.active, true)))
      .returning({ id: pushSubscriptions.id });
    auditFromWms(actor, {
      action: "member.wmsUnsubscribePush",
      targetId: target.id,
      detail: `WMS ${actor.role === "admin" ? "管理員" : "主管"} ${actor.name} 幫會員「${target.name}」拒絕接收直播推送；註銷咗 ${deactivated.length} 部裝置`,
    });
    void forwardMemberToWms(target.id).catch((e) => console.error("[wms] member sync error:", e));
    return c.json({ ok: true, removedDevices: deactivated.length });
  }

  // ─── setMarketing：直接促銷 設為接受／唔接受（同官網後台 update 同款：寫表態時間）───
  if (action === "setMarketing") {
    if (typeof b.optIn !== "boolean") {
      return c.json({ ok: false, error: "optIn 要係 true/false" }, 400);
    }
    const optIn = b.optIn;
    await db
      .update(users)
      .set({
        marketingOptIn: optIn,
        ...(optIn ? { marketingOptInAt: new Date() } : {}),
        marketingPromptedAt: new Date(),
      })
      .where(eq(users.id, target.id));
    auditFromWms(actor, {
      action: "member.wmsSetMarketing",
      targetId: target.id,
      detail: `WMS ${actor.role === "admin" ? "管理員" : "主管"} ${actor.name} 將會員「${target.name}」直接促銷設為${optIn ? "接受" : "唔接受"}`,
    });
    void forwardMemberToWms(target.id).catch((e) => console.error("[wms] member sync error:", e));
    return c.json({ ok: true, marketingOptIn: optIn });
  }

  // ─── setVipTier：改 VIP 級別（行為對齊官網後台 membersRouter.setVipTier）───
  const tier = typeof b.tier === "string" ? b.tier : "";
  if (tier !== "NONE" && tier !== "SILVER" && tier !== "GOLD") {
    return c.json({ ok: false, error: "tier 要係 NONE/SILVER/GOLD" }, 400);
  }
  let expiresAt: Date | null = null;
  if (tier !== "NONE") {
    const raw = typeof b.expiresAt === "string" ? b.expiresAt : "";
    expiresAt = raw ? new Date(raw) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
      return c.json({ ok: false, error: "設定 VIP 級別要填到期日（ISO 日期字串）" }, 400);
    }
    if (expiresAt.getTime() <= Date.now()) {
      return c.json({ ok: false, error: "到期日要係將來嘅時間" }, 400);
    }
  }
  const rankOf = (t: string) => (t === "GOLD" ? 2 : t === "SILVER" ? 1 : 0);
  const isUpgrade = rankOf(tier) > rankOf(target.vipTier);
  // 門檻凍結：升級先寫「升級嗰刻嘅門檻」快照；降級／清級／同級改期唔郁舊快照
  const upgradeRules = isUpgrade ? await getVipRules() : null;
  await db
    .update(users)
    .set(
      tier === "NONE"
        ? { vipTier: "NONE", vipEffectiveAt: null, vipExpiresAt: null }
        : {
            vipTier: tier,
            vipEffectiveAt: new Date(),
            vipExpiresAt: expiresAt!,
            ...(upgradeRules
              ? {
                  vipThresholdCents:
                    tier === "GOLD" ? upgradeRules.goldThresholdCents : upgradeRules.silverThresholdCents,
                }
              : {}),
          },
    )
    .where(eq(users.id, target.id));
  // 升級＋有 email → 寄 VIP 晉升恭賀信（附證書；DB commit 完先寄，失敗唔影響操作）
  if (isUpgrade && target.email) {
    const rules = await getVipRules();
    const memberNo = `RC-${String(target.id).padStart(6, "0")}`;
    void sendVipUpgradeEmail({
      to: target.email,
      name: target.name,
      tier: tier as "SILVER" | "GOLD",
      effectiveAt: new Date(),
      expiresAt: expiresAt!,
      memberNo,
      phone: target.phone ?? null,
      thresholdCents: tier === "GOLD" ? rules.goldThresholdCents : rules.silverThresholdCents,
      durationMonths: rules.durationMonths,
      verifyUrl: buildVipVerifyUrl(siteUrl(), memberNo),
    })
      .then((r) => {
        if (!r.ok) console.error(`[vip] WMS 手動升級恭賀信寄唔出（會員 #${target.id} → ${tier}）：`, r.error);
      })
      .catch((e) => console.error("[vip] WMS 手動升級恭賀信寄送錯誤:", e));
  }
  const tierLabel = tier === "GOLD" ? "金會員" : tier === "SILVER" ? "銀會員" : "普通會員";
  auditFromWms(actor, {
    action: "member.wmsSetVipTier",
    targetId: target.id,
    detail: `WMS ${actor.role === "admin" ? "管理員" : "主管"} ${actor.name} 設定會員「${target.name}」VIP 級別：${target.vipTier} → ${tier}（${tierLabel}${tier === "NONE" ? "" : `，到期 ${expiresAt!.toISOString().slice(0, 10)}`}）`,
  });
  void forwardMemberToWms(target.id).catch((e) => console.error("[wms] member sync error:", e));
  return c.json({ ok: true, vipTier: tier, vipExpiresAt: expiresAt ? expiresAt.toISOString() : null });
}
