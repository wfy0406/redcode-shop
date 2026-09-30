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
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { pushCampaigns, pushSubscriptions } from "@db/schema";
import { logAudit } from "./audit";
import { siteUrl } from "./email";

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
    // SW 開唔到 fb:// scheme，所以 FB 連結先指去 /live-go.html 跳板頁，
    // 入面再試 fb:// 深鏈；開唔到（冇裝 app）先落返網頁版。非 FB 連結維持原樣。
    const clickUrl = isFacebookUrl(campaign.url)
      ? `${siteUrl()}/live-go.html?u=${encodeURIComponent(campaign.url)}`
      : campaign.url;
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
      } catch (e) {
        failCount++;
        // 推送服務回 404/410＝訂閱已失效 → 即 deactivate（留底唔刪行）。
        // 日誌淨落 subscription id＋statusCode；endpoint/keys/secret 永遠唔准落 log。
        const statusCode =
          typeof (e as { statusCode?: unknown })?.statusCode === "number"
            ? (e as { statusCode: number }).statusCode
            : null;
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
