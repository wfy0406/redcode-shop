/**
 * v2.2.1（合約 §9）：WMS → 官網會員管理 endpoint。
 * 模式照 api/wmsLivePush.ts（WMS_CALLBACK_SECRET shared secret ＋ JSON body），
 * 註冊喺 api/boot.ts（tRPC mount 前）。
 *
 * ─ POST /api/wms/member-admin
 *     共用欄：{secret, action, phone, requesterName?, requesterRole?}
 *     action：
 *     ─ get（全部角色可）：睇會員資料＋VIP 級別/到期＋促銷同意＋直播推送狀態/裝置清單
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
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { pushSubscriptions, users } from "@db/schema";
import { logAudit } from "./audit";
import { getMemberPushStatus } from "./membersRouter";
import { forwardMemberToWms } from "./wmsMemberSync";
import { getVipRules } from "./vip";
import { sendVipUpgradeEmail, siteUrl } from "./email";
import { buildVipVerifyUrl } from "./vipCert";

const ACTIONS = ["get", "removePushDevice", "unsubscribePush", "setMarketing", "setVipTier"] as const;
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
    return c.json({ ok: false, error: "action 唔啱（get/removePushDevice/unsubscribePush/setMarketing/setVipTier）" }, 400);
  }
  const actor = wmsActor(b);
  if (MUTATE_ACTIONS.includes(action) && actor.role !== "supervisor" && actor.role !== "admin") {
    return c.json({ ok: false, error: "呢個動作要主管或管理員" }, 403);
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
