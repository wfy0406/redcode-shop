/**
 * v2.2.0 直播開播推送通知（老闆 2026-09-30 指令）：Web Push 發送引擎。
 *
 * 技術路線：Web Push（service worker + VAPID，web-push npm），唔經第三方。
 * VAPID env：VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT（mailto:，
 *   未設就落預設 mailto:redcode@redcode.red）。
 *
 * sendLivePush(campaignId) 流程（never-throw）：
 *   ① 攞 campaign＋全部 active subscriptions；
 *   ② VAPID 未設 → status='failed'＋reviewNote 記錯誤訊息；
 *   ③ status 轉 'sending'，逐個 subscription sendNotification；
 *      - 成功 → sentCount++、subscription.lastSentAt=now()；
 *      - 404/410（訂閱已失效）→ 即 deactivate（active=false）＋failCount++；
 *      - 其他錯 → failCount++（淨記 statusCode，**endpoint/keys/secret 永遠唔准落 log**）；
 *   ④ 寫返 campaign：sentCount/failCount、sentAt=now()；
 *      有成功 → 'sent'；全敗（或冇 active 裝置）→ 'failed'＋reviewNote 記原因；
 *   ⑤ audit log（push.sendLivePush，detail 只落 campaign id／計數，唔落 endpoint）。
 */
import webpush from "web-push";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { pushCampaigns, pushDeliveries, pushSubscriptions } from "@db/schema";
import { logAudit } from "./audit";
import { siteUrl } from "./email";
import { resolveFbCanonical } from "./fbVideo";

/** 通知標題（合約 §8 寫死模板） */
export const PUSH_TITLE = "🔴 RedCode 直播開始啦！";

/**
 * 通知 body（合約 §8 寫死模板）：
 * 「快啲入嚟睇啦！\n📅 {liveDate} {liveSession}\n🕒 發送時間 {HKT HH:mm}」；
 * message 有填就取代第一句「快啲入嚟睇啦！」。
 */
export function buildLivePushBody(
  liveDate: string,
  liveSession: string,
  message?: string | null,
): string {
  const firstLine = message?.trim() || "快啲入嚟睇啦！";
  return `${firstLine}\n📅 ${liveDate} ${liveSession}\n🕒 發送時間 ${hktHHmm()}`;
}

/** 香港時間 HH:mm（hourCycle h23 保證午夜係 00 唔係 24） */
function hktHHmm(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

export type SendLivePushResult = {
  ok: boolean;
  sentCount: number;
  failCount: number;
  error?: string;
};

/** v2.2.37（老闆指令）：直播「進行中」基本窗口＝sent 後 90 分鐘 */
export const LIVE_WINDOW_BASE_MS = 90 * 60 * 1000;

/** v2.2.37（老闆指令）：直播中可自己延長，每掣 +60 分鐘，累計上限 240 分鐘 */
export const MAX_EXTEND_MINUTES = 240;

/** 實際顯示窗口＝90 分鐘＋已延長分鐘數（夾返 0–240，防手滑寫壞 DB） */
export function effectiveLiveWindowMs(extendedMinutes: number | null | undefined): number {
  const ext = Math.max(0, Math.min(MAX_EXTEND_MINUTES, extendedMinutes ?? 0));
  return LIVE_WINDOW_BASE_MS + ext * 60 * 1000;
}

/**
 * 發送一張推送批次（never-throw）。fire-and-forget 都得（void 調用唔阻塞回應）。
 * 只處理 status='pending' 嘅批次；其他狀態直接收檔（冪等，唔會重複發）。
 */
export async function sendLivePush(campaignId: number): Promise<SendLivePushResult> {
  try {
    const db = getDb();
    const campaign = await db.query.pushCampaigns.findFirst({
      where: eq(pushCampaigns.id, campaignId),
    });
    if (!campaign) {
      console.error(`[push] 批次 #${campaignId} 唔存在，收檔`);
      return { ok: false, sentCount: 0, failCount: 0, error: "批次唔存在" };
    }
    if (campaign.status !== "pending") {
      console.log(`[push] 批次 #${campaignId} 狀態係 ${campaign.status}，唔重複發送`);
      return { ok: false, sentCount: 0, failCount: 0, error: `批次狀態係 ${campaign.status}` };
    }

    // v2.2.37（老闆指令）：剔咗「不發送直播通知」／「直接放入直播回顧」→ 唔經 VAPID、
    // 一個通知都唔送，直接落帳做 sent（directReplay 連 endedAt 都即刻寫＝唔會出現直播中）。
    // 照行 pending→sending→sent 轉態，等狀態機紀錄保持一致。
    if (campaign.skipNotify || campaign.directReplay) {
      const claimedNoPush = await db
        .update(pushCampaigns)
        .set({ status: "sending" })
        .where(and(eq(pushCampaigns.id, campaignId), eq(pushCampaigns.status, "pending")))
        .returning({ id: pushCampaigns.id });
      if (claimedNoPush.length === 0) {
        return { ok: false, sentCount: 0, failCount: 0, error: "批次已被其他流程處理" };
      }
      const nowNoPush = new Date();
      const noPushNote = campaign.directReplay
        ? "已剔「直接放入直播回顧」：無發送直播通知，唔會出現直播中"
        : "已剔「不發送直播通知」：無發送直播通知";
      await db
        .update(pushCampaigns)
        .set({
          status: "sent",
          sentCount: 0,
          failCount: 0,
          sentAt: nowNoPush,
          ...(campaign.directReplay ? { endedAt: nowNoPush } : {}),
          reviewNote: appendNote(campaign.reviewNote, noPushNote),
        })
        .where(eq(pushCampaigns.id, campaignId));
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "push.sendLivePush",
        targetType: "pushCampaign",
        targetId: campaignId,
        detail: `直播推送批次 #${campaignId}（${campaign.liveDate} ${campaign.liveSession}）：${noPushNote}，狀態 sent`,
      });
      console.log(`[push] 批次 #${campaignId} ${noPushNote} → sent（0 通知）`);
      return { ok: true, sentCount: 0, failCount: 0 };
    }

    // VAPID 未設 → 即敗（唔使逐個試），錯誤訊息落 reviewNote
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublicKey || !vapidPrivateKey) {
      const errMsg = "未設定 VAPID_PUBLIC_KEY／VAPID_PRIVATE_KEY，未能發送推送";
      await db
        .update(pushCampaigns)
        .set({ status: "failed", reviewNote: appendNote(campaign.reviewNote, errMsg) })
        .where(eq(pushCampaigns.id, campaignId));
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "push.sendLivePush",
        targetType: "pushCampaign",
        targetId: campaignId,
        detail: `直播推送批次 #${campaignId} 發送失敗：${errMsg}`,
      });
      console.error(`[push] 批次 #${campaignId} 失敗：${errMsg}`);
      return { ok: false, sentCount: 0, failCount: 0, error: errMsg };
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:redcode@redcode.red",
      vapidPublicKey,
      vapidPrivateKey,
    );

    // 轉態 sending（conditional update 擋重複併發：郁到 0 行即有人做緊，收檔）
    const claimed = await db
      .update(pushCampaigns)
      .set({ status: "sending" })
      .where(and(eq(pushCampaigns.id, campaignId), eq(pushCampaigns.status, "pending")))
      .returning({ id: pushCampaigns.id });
    if (claimed.length === 0) {
      return { ok: false, sentCount: 0, failCount: 0, error: "批次已被其他流程處理" };
    }

    const subs = await db.query.pushSubscriptions.findMany({
      where: eq(pushSubscriptions.active, true),
    });
    // v2.2.2（老闆指令）：推播撳入去要直接開 Facebook app。
    // SW 開唔到 fb:// scheme，所以 FB 連結先指去跳板頁，
    // 入面再試 fb:// 深鏈；開唔到（冇裝 app）先落返網頁版。非 FB 連結維持原樣。
    // v2.2.8（老闆回報「跳完都係無開 app」）：短鏈（share/v/、fb.watch）
    // 未必中 FB app 嘅 intent filter，所以推送前先解鏈做正式 /watch?v=ID
    // 連結——app filter 一定認得；解唔到就用返原本條，唔阻發送。
    // v2.2.16（老闆拍板「先 APP，唔去先自動落網頁版」）：跳板頁換新檔名——
    // public/ 檔冇 hash，客人瀏覽器可能 cache 住舊版，
    // 新檔名保證攞到最新邏輯（blur 殺 timer，唔再扯埋 Samsung「開啟 app」窗）；
    // 舊 live-go*.html 全部係轉址殼兜住舊推播。
    // v2.2.19（老闆拍板「iPhone唔轉跳APP跳去網頁版；Android唔洗郁」）：搬去 live-go-v6.html——
    // iPhone 自動路線完全唔碰 App：4 秒直落網頁版條片（FB iOS App 接到連結都
    // 唔去條片，淨係落首頁——佢哋嘅 App 行為，任何網站控制唔到）；
    // 金掣「用 Facebook App 睇直播」＝真 https 連結（universal link 畀客自己撳）。
    // Android 同 v2.2.18 一字唔改：一槍 https-intent，唔連發（防踩走 Samsung 窗）。
    let pushTarget = campaign.url;
    if (isFacebookUrl(campaign.url)) {
      pushTarget = await resolveFbCanonical(campaign.url).catch(() => campaign.url);
    }
    const clickUrl = isFacebookUrl(pushTarget)
      ? `${siteUrl()}/live-go-v6.html?u=${encodeURIComponent(pushTarget)}`
      : pushTarget;
    const payload = JSON.stringify({
      title: campaign.title,
      body: campaign.body,
      data: { url: clickUrl },
    });

    let sentCount = 0;
    let failCount = 0;
    const now = new Date();
    for (const sub of subs) {
      try {
        // v2.2.5（老闆指令「推播有時無彈出，要較最緊急」）：
        // urgency:'high' → FCM/APNs 即刻派件（慳電模式都照彈）；
        // TTL 90 分鐘 → 同直播顯示窗口對齊，過咗期嘅通知唔好再彈（避免直播完先彈舊通知）。
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 90 * 60, urgency: "high" },
        );
        sentCount++;
        await db
          .update(pushSubscriptions)
          .set({ lastSentAt: now })
          .where(eq(pushSubscriptions.id, sub.id));
        // v2.2.44（老闆指令）：逐機推送紀錄——寫低成功；紀錄寫唔入都唔好阻發送主流程
        await db
          .insert(pushDeliveries)
          .values({ subscriptionId: sub.id, campaignId, ok: true })
          .catch(() => undefined);
      } catch (e) {
        failCount++;
        // 推送服務回 404/410＝訂閱已失效 → 即 deactivate（留底唔刪行）。
        // 日誌淨落 subscription id＋statusCode；endpoint/keys/secret 永遠唔准落 log。
        const statusCode =
          typeof (e as { statusCode?: unknown })?.statusCode === "number"
            ? (e as { statusCode: number }).statusCode
            : null;
        // v2.2.44（老闆指令）：逐機推送紀錄——寫低失敗＋原因類別（淨類別，唔落原文）
        await db
          .insert(pushDeliveries)
          .values({
            subscriptionId: sub.id,
            campaignId,
            ok: false,
            reason:
              statusCode === 404 || statusCode === 410
                ? "gone"
                : statusCode
                  ? `http_${statusCode}`
                  : "unknown",
          })
          .catch(() => undefined);
        if (statusCode === 404 || statusCode === 410) {
          await db
            .update(pushSubscriptions)
            .set({ active: false })
            .where(eq(pushSubscriptions.id, sub.id));
          console.log(`[push] 訂閱 #${sub.id} 已失效（HTTP ${statusCode}），已停用`);
        } else {
          console.error(`[push] 訂閱 #${sub.id} 發送失敗（HTTP ${statusCode ?? "未知"}）`);
        }
      }
    }

    const finalStatus = sentCount > 0 ? "sent" : "failed";
    const failNote =
      finalStatus === "failed"
        ? subs.length === 0
          ? "冇任何有效訂閱裝置"
          : `全部 ${failCount} 部裝置發送失敗`
        : null;
    await db
      .update(pushCampaigns)
      .set({
        status: finalStatus,
        sentCount,
        failCount,
        sentAt: now,
        ...(failNote ? { reviewNote: appendNote(campaign.reviewNote, failNote) } : {}),
      })
      .where(eq(pushCampaigns.id, campaignId));

    void logAudit({
      actorId: null,
      actorRole: "system",
      action: "push.sendLivePush",
      targetType: "pushCampaign",
      targetId: campaignId,
      detail: `直播推送批次 #${campaignId}（${campaign.liveDate} ${campaign.liveSession}）發送完成：成功 ${sentCount}、失敗 ${failCount}，狀態 ${finalStatus}`,
    });
    console.log(
      `[push] 批次 #${campaignId} 完成：成功 ${sentCount}、失敗 ${failCount} → ${finalStatus}`,
    );
    return { ok: finalStatus === "sent", sentCount, failCount };
  } catch (e) {
    // never-throw 兜底：任何意外都淨係 log，唔好冧主流程
    console.error(`[push] 批次 #${campaignId} 發送出錯:`, e);
    return { ok: false, sentCount: 0, failCount: 0, error: "發送流程出錯" };
  }
}

/** reviewNote 追加（保留舊內容，分號分隔） */
function appendNote(existing: string | null, note: string): string {
  return existing ? `${existing}；${note}` : note;
}

/** 係咪 Facebook 系連結（facebook.com／fb.watch／fb.me）——用嚟決定使唔使經 live-go 跳板 */
function isFacebookUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return (
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "fb.watch" ||
      host === "fb.me" ||
      host.endsWith(".fb.me")
    );
  } catch {
    return false;
  }
}


// ─── v2.2.16（老闆指令）：直播回顧顯示順序 ───────────────────────────────
// pushCampaigns.replayOrder：細數排前；NULL＝未設定（跟 sentAt 新→舊排尾）。
// 官網後台（tRPC moveLiveReplay）同 WMS 官網中心（/api/wms/live-push/move）共用。

/** 回顧清單統一排序：設咗 replayOrder 嘅排先（細→大），未設嘅跟 sentAt 新→舊 */
export const REPLAY_ORDER_BY = [
  asc(sql`("replayOrder" IS NULL)`),
  asc(pushCampaigns.replayOrder),
  desc(pushCampaigns.sentAt),
] as const;

/** v2.2.37（老闆指令）：「可以入回顧」條件——已落畫，或者過咗實際顯示窗口
 * （90 分鐘＋extendedMinutes 延長，逐行計；延長緊嘅場次唔會提早跌入回顧） */
const replayReadySql = sql`(${pushCampaigns.endedAt} IS NOT NULL OR ${pushCampaigns.sentAt} < now() - (interval '90 minutes' + ${pushCampaigns.extendedMinutes} * interval '1 minute'))`;

/** 回顧清單操作範圍：已落畫／過窗嘅 sent 批次，最新 20 筆（前台回顧顯示頭 10 筆） */
const REPLAY_MANAGE_LIMIT = 20;

/**
 * 回顧上移／下移一級：
 * ① 按而家顯示順序攞出成條回顧清單（頭 20 筆）；
 * ② 搵到目標同佢隔籬嗰筆，對調位置；
 * ③ 成條清單重寫 replayOrder＝(i+1)*10（正規化，之後對調就永遠齊整）。
 * 唔喺清單／已排最盡 → { ok:false, error }（UI 顯示返句原因）。
 */
export async function moveLiveReplay(
  id: number,
  direction: "up" | "down",
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const rows = await db.query.pushCampaigns.findMany({
    where: and(eq(pushCampaigns.status, "sent"), replayReadySql),
    orderBy: [...REPLAY_ORDER_BY],
    limit: REPLAY_MANAGE_LIMIT,
  });
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) {
    return { ok: false, error: "呢場唔喺直播回顧清單（可能仲顯示緊／未夠 90 分鐘）" };
  }
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= rows.length) {
    return { ok: false, error: direction === "up" ? "已經排最前" : "已經排最尾" };
  }
  const order = rows.map((r) => r.id);
  [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
  for (let i = 0; i < order.length; i++) {
    await db
      .update(pushCampaigns)
      .set({ replayOrder: (i + 1) * 10 })
      .where(eq(pushCampaigns.id, order[i]));
  }
  return { ok: true };
}

/**
 * v2.2.46（直播抽獎，老闆指令）：中獎即時推送畀中獎人（佢全部 active 裝置）。
 * 同直播推送共用 VAPID；never-throw——抽獎流程唔會因推送失敗而彈錯。
 * 保安：日誌淨落 userId／計數／statusCode；endpoint/keys 永遠唔落 log。
 * 中獎推送唔係直播 campaign，唔寫 pushDeliveries（嗰張表係逐 campaign 對位用）。
 */
export async function sendPrizeWinPush(
  userId: number,
  prizeName: string,
): Promise<{ sent: number; failed: number }> {
  try {
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublicKey || !vapidPrivateKey) return { sent: 0, failed: 0 };
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:redcode@redcode.red",
      vapidPublicKey,
      vapidPrivateKey,
    );
    const db = getDb();
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.active, true)));
    const payload = JSON.stringify({
      title: "🎉 RedCode 恭喜寶寶中獎！",
      body: `你中咗「${prizeName}」！登入官網揀順豐站點，我哋包郵寄畀你 ♥`,
      data: { url: `${siteUrl()}/#/orders` },
    });
    let sent = 0;
    let failed = 0;
    const now = new Date();
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          // TTL 7 日：中獎通知冇時效窗，遲派好過唔派
          { TTL: 7 * 24 * 60 * 60, urgency: "high" },
        );
        sent++;
        await db
          .update(pushSubscriptions)
          .set({ lastSentAt: now })
          .where(eq(pushSubscriptions.id, sub.id));
      } catch (e) {
        failed++;
        const statusCode =
          typeof (e as { statusCode?: unknown })?.statusCode === "number"
            ? (e as { statusCode: number }).statusCode
            : null;
        if (statusCode === 404 || statusCode === 410) {
          await db
            .update(pushSubscriptions)
            .set({ active: false })
            .where(eq(pushSubscriptions.id, sub.id));
        }
      }
    }
    console.log(`[push] 中獎通知 → user #${userId}：${sent} 成功 / ${failed} 失敗`);
    return { sent, failed };
  } catch (e) {
    console.error(`[push] 中獎通知出錯（user #${userId}）：`, e instanceof Error ? e.message : e);
    return { sent: 0, failed: 0 };
  }
}
