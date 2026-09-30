/**
 * v2.2.0 直播開播推送通知（合約 §8）：WMS → 官網直播推送三條 endpoint。
 * 模式照 api/wmsRefund.ts（WMS_CALLBACK_SECRET shared secret ＋ JSON body），
 * 註冊喺 api/boot.ts（tRPC mount 前）。
 *
 * ─ POST /api/wms/live-push/request
 *     {secret, liveDate, liveSession, url, message?, requestedByName, requesterRole}
 *     requesterRole∈{staff,supervisor,admin}；staff→pending 等批；
 *     supervisor/admin→直接發送（fire-and-forget，唔阻塞回應）。
 * ─ POST /api/wms/live-push/approve
 *     {secret, id, approve, reviewedByName, reviewNote?}（通過即發送）
 * ─ POST /api/wms/live-push/list {secret} → 近 50 筆全部紀錄欄位
 * ─ POST /api/wms/live-push/end {secret, byName} → 落播：顯示緊嘅直播寫 endedAt=now
 * ─ POST /api/wms/live-push/delete {secret, id, byName} → 刪除直播回顧
 *     （v2.2.5 老闆指令：WMS 官網中心同官網後台一樣可以落播＋刪回顧；
 *       顯示緊嘅直播要先落播先刪到；pending/sending 唔准刪）
 *
 * secret 永遠唔准落 log／audit；錯誤回應唔會帶出 secret 內容。
 */
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { pushCampaigns } from "@db/schema";
import { logAudit } from "./audit";
import { PUSH_TITLE, buildLivePushBody, sendLivePush } from "./livePush";

/** WMS 員工角色白名單（其他→400） */
const WMS_ROLES = ["staff", "supervisor", "admin"] as const;
type WmsRole = (typeof WMS_ROLES)[number];

/**
 * 攞 JSON body 並常數時間比對 shared secret（照 wmsRefund 嘅回錯款：
 * 未設 secret→503；body 唔係 JSON→400；secret 唔啱→401）。
 * 成功回 { b }；失敗回 { res }（已寫好嘅錯誤回應，handler 直接 return）。
 */
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

/** 直播推送內容校驗（同 pushRouter 嘅 zod 規則對齊）；唔啱回錯誤字串 */
function validateLivePushInput(b: Record<string, unknown>): string | null {
  const liveDate = typeof b.liveDate === "string" ? b.liveDate.trim() : "";
  const liveSession = typeof b.liveSession === "string" ? b.liveSession.trim() : "";
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!liveDate || liveDate.length > 32) return "liveDate 必填（最長 32 字）";
  if (!liveSession || liveSession.length > 32) return "liveSession 必填（最長 32 字）";
  if (!/^https?:\/\//i.test(url) || url.length > 500)
    return "url 必須以 http:// 或 https:// 開頭（最長 500 字）";
  if (message.length > 200) return "message 最長 200 字";
  return null;
}

/** 批次紀錄回傳欄位（list 同 request/approve 共用，全部紀錄欄位） */
function campaignRow(r: typeof pushCampaigns.$inferSelect) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    liveDate: r.liveDate,
    liveSession: r.liveSession,
    url: r.url,
    status: r.status,
    source: r.source,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName,
    reviewedBy: r.reviewedBy,
    reviewedByName: r.reviewedByName,
    reviewNote: r.reviewNote,
    sentAt: r.sentAt,
    sentCount: r.sentCount,
    failCount: r.failCount,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  };
}

/** 直播「進行中」窗口：sent 後 90 分鐘（同 pushRouter LIVE_WINDOW_MS 一致） */
const LIVE_WINDOW_MS = 90 * 60 * 1000;

/** POST /api/wms/live-push/request：WMS 員工申請／主管直接發送 */
export async function wmsLivePushRequest(c: Context) {
  const r = await readJsonWithSecret(c);
  if ("res" in r) return r.res;
  const b = r.b;

  const err = validateLivePushInput(b);
  if (err) return c.json({ ok: false, error: err }, 400);
  const requestedByName = typeof b.requestedByName === "string" ? b.requestedByName.trim() : "";
  if (!requestedByName) {
    return c.json({ ok: false, error: "requestedByName 必填（WMS 員工名）" }, 400);
  }
  const requesterRole = typeof b.requesterRole === "string" ? b.requesterRole : "";
  if (!WMS_ROLES.includes(requesterRole as WmsRole)) {
    return c.json(
      { ok: false, error: "requesterRole 必須係 staff／supervisor／admin" },
      400,
    );
  }

  const liveDate = (b.liveDate as string).trim();
  const liveSession = (b.liveSession as string).trim();
  const url = (b.url as string).trim();
  const message = typeof b.message === "string" ? b.message.trim() : "";

  const db = getDb();
  const [{ id }] = await db
    .insert(pushCampaigns)
    .values({
      title: PUSH_TITLE,
      body: buildLivePushBody(liveDate, liveSession, message || null),
      liveDate,
      liveSession,
      url,
      status: "pending",
      source: "WMS",
      requestedBy: null,
      requestedByName,
    })
    .returning({ id: pushCampaigns.id });

  const direct = requesterRole === "supervisor" || requesterRole === "admin";
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "push.requestLivePush",
    targetType: "pushCampaign",
    targetId: id,
    detail: direct
      ? `WMS 直播推送直接發送（批次 #${id}，${liveDate} ${liveSession}，${requesterRole === "admin" ? "管理員" : "主管"}：${requestedByName}）`
      : `WMS 直播推送申請（批次 #${id}，${liveDate} ${liveSession}，員工：${requestedByName}），等待主管審批`,
  });
  if (direct) {
    // 主管／管理員 → 直接發送（fire-and-forget，唔阻塞回應）
    void sendLivePush(id).catch((e) => console.error(`[push] 批次 #${id} 發送出錯:`, e));
  }
  console.log(
    `[wms] live-push request #${id}（${liveDate} ${liveSession}）→ ${direct ? "sending" : "pending"}`,
  );
  return c.json({ ok: true, id, status: direct ? "sending" : "pending" });
}

/** POST /api/wms/live-push/approve：WMS 主管審批（通過即發送） */
export async function wmsLivePushApprove(c: Context) {
  const r = await readJsonWithSecret(c);
  if ("res" in r) return r.res;
  const b = r.b;

  const id = typeof b.id === "number" && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
  const approve = b.approve === true;
  const reviewedByName = typeof b.reviewedByName === "string" ? b.reviewedByName.trim() : "";
  const reviewNote = typeof b.reviewNote === "string" ? b.reviewNote.trim() : "";
  if (!id) return c.json({ ok: false, error: "id 必填（正整數）" }, 400);
  if (typeof b.approve !== "boolean")
    return c.json({ ok: false, error: "approve 必填（boolean）" }, 400);
  if (!reviewedByName) {
    return c.json({ ok: false, error: "reviewedByName 必填（WMS 審批人名）" }, 400);
  }

  const db = getDb();
  const campaign = await db.query.pushCampaigns.findFirst({
    where: eq(pushCampaigns.id, id),
  });
  if (!campaign) {
    return c.json({ ok: false, error: `搵唔到推送批次 #${id}` }, 404);
  }
  if (campaign.status !== "pending") {
    return c.json(
      { ok: false, error: `批次狀態係 ${campaign.status}，唔可以再審批` },
      409,
    );
  }

  if (approve) {
    // 通過：記低審批人，批次維持 pending 交俾 sendLivePush 轉態發送（fire-and-forget）
    await db
      .update(pushCampaigns)
      .set({ reviewedBy: null, reviewedByName, reviewNote: reviewNote || null })
      .where(eq(pushCampaigns.id, id));
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "push.approveLivePush",
      targetType: "pushCampaign",
      targetId: id,
      detail: `WMS 批准直播推送（批次 #${id}，${campaign.liveDate} ${campaign.liveSession}，審批人：${reviewedByName}），即時發送${reviewNote ? `；備註：${reviewNote}` : ""}`,
    });
    void sendLivePush(id).catch((e) => console.error(`[push] 批次 #${id} 發送出錯:`, e));
    console.log(`[wms] live-push approve #${id} → sending`);
    return c.json({ ok: true, id, status: "sending" });
  }

  await db
    .update(pushCampaigns)
    .set({ status: "rejected", reviewedBy: null, reviewedByName, reviewNote: reviewNote || null })
    .where(eq(pushCampaigns.id, id));
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "push.rejectLivePush",
    targetType: "pushCampaign",
    targetId: id,
    detail: `WMS 拒絕直播推送（批次 #${id}，${campaign.liveDate} ${campaign.liveSession}，審批人：${reviewedByName}）${reviewNote ? `；原因：${reviewNote}` : ""}`,
  });
  console.log(`[wms] live-push approve #${id} → rejected`);
  return c.json({ ok: true, id, status: "rejected" });
}

/** POST /api/wms/live-push/list：近 50 筆批次紀錄（全部欄位） */
export async function wmsLivePushList(c: Context) {
  const r = await readJsonWithSecret(c);
  if ("res" in r) return r.res;

  const db = getDb();
  const rows = await db.query.pushCampaigns.findMany({
    orderBy: [desc(pushCampaigns.createdAt)],
    limit: 50,
  });
  return c.json({ ok: true, items: rows.map(campaignRow) });
}

/** POST /api/wms/live-push/end：落播——顯示緊嘅直播即時停止顯示（v2.2.5） */
export async function wmsLivePushEnd(c: Context) {
  const r = await readJsonWithSecret(c);
  if ("res" in r) return r.res;
  const b = r.b;
  const byName = typeof b.byName === "string" ? b.byName.trim() : "";
  if (!byName) return c.json({ ok: false, error: "byName 必填（WMS 員工名）" }, 400);

  const db = getDb();
  const since = new Date(Date.now() - LIVE_WINDOW_MS);
  const live = await db.query.pushCampaigns.findFirst({
    where: and(
      eq(pushCampaigns.status, "sent"),
      gte(pushCampaigns.sentAt, since),
      isNull(pushCampaigns.endedAt),
    ),
    orderBy: [desc(pushCampaigns.sentAt)],
  });
  if (!live) {
    return c.json({ ok: false, error: "而家冇顯示緊嘅直播" }, 404);
  }
  await db
    .update(pushCampaigns)
    .set({ endedAt: new Date() })
    .where(eq(pushCampaigns.id, live.id));
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "push.endLiveNow",
    targetType: "pushCampaign",
    targetId: live.id,
    detail: `WMS 落直播畫（批次 #${live.id}，${live.liveDate} ${live.liveSession}，操作：${byName}）：首頁／直播頁即時停止顯示`,
  });
  console.log(`[wms] live-push end #${live.id}`);
  return c.json({ ok: true, id: live.id, liveDate: live.liveDate, liveSession: live.liveSession });
}

/** POST /api/wms/live-push/delete：刪除直播回顧（v2.2.5） */
export async function wmsLivePushDelete(c: Context) {
  const r = await readJsonWithSecret(c);
  if ("res" in r) return r.res;
  const b = r.b;
  const id = typeof b.id === "number" && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
  const byName = typeof b.byName === "string" ? b.byName.trim() : "";
  if (!id) return c.json({ ok: false, error: "id 必填（正整數）" }, 400);
  if (!byName) return c.json({ ok: false, error: "byName 必填（WMS 員工名）" }, 400);

  const db = getDb();
  const campaign = await db.query.pushCampaigns.findFirst({
    where: eq(pushCampaigns.id, id),
  });
  if (!campaign) {
    return c.json({ ok: false, error: `推送批次 #${id} 唔存在（可能已經刪咗）` }, 404);
  }
  if (campaign.status === "pending" || campaign.status === "sending") {
    return c.json({ ok: false, error: "批次仲喺審批／發送流程，唔可以刪" }, 409);
  }
  const stillLive =
    campaign.status === "sent" &&
    !campaign.endedAt &&
    campaign.sentAt != null &&
    Date.now() - campaign.sentAt.getTime() < LIVE_WINDOW_MS;
  if (stillLive) {
    return c.json({ ok: false, error: "呢場直播仲顯示緊，請先落播再刪" }, 409);
  }
  await db.delete(pushCampaigns).where(eq(pushCampaigns.id, id));
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "push.deleteLiveCampaign",
    targetType: "pushCampaign",
    targetId: id,
    detail: `WMS 刪除直播回顧（批次 #${id}，${campaign.liveDate} ${campaign.liveSession}，狀態 ${campaign.status}，操作：${byName}）`,
  });
  console.log(`[wms] live-push delete #${id}`);
  return c.json({ ok: true, id });
}
