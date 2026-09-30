/**
 * v2.2.0 直播開播推送通知（老闆 2026-09-30 指令，合約 §8）：shop tRPC pushRouter。
 *
 * ─ getVapidKey（公開）：回 VAPID public key 俾前端 subscribe 用
 * ─ subscribe（登入）：綁定呢部裝置（upsert by endpoint）＋livePushOptIn=true
 * ─ unsubscribe（登入）：註銷裝置（冇 endpoint＝全撤）；冇 active 裝置就 optIn=false
 * ─ myPushStatus（登入）：{ optIn, activeDevices }
 * ─ listMyDevices（登入）：裝置清單 {id,userAgent,createdAt,lastSentAt,isCurrent}（endpoint 唔回前端）
 * ─ removeMyDevice（登入）：逐部踢走（只准自己嘅 row）；冇 active 裝置就 optIn=false
 * ─ currentLive（公開）：最新一筆 90 分鐘內 sent 嘅直播（embedUrl 經 resolveFbEmbedUrl 解鏈）
 * ─ previewLiveUrl（員工級）：推送前檢查連結官網播唔播到（回 embeddable＋正式連結）
 * ─ liveHistory（公開）：直播回顧——已落畫場次最新 10 筆（日期＋場次＋連結＋已解嵌入 URL）
 * ─ requestLivePush（員工級）：staff→pending 等批；supervisor/admin→直接發送（fire-and-forget）
 * ─ approveLivePush（主管級）：{id, approve, reviewNote?}→通過即發送
 * ─ listLivePush（員工級）：近 50 筆批次紀錄
 * ─ endLiveNow（員工級）：一掣落直播畫（寫 endedAt）
 * ─ deleteLiveCampaign（員工級）：刪除直播回顧（顯示緊／pending 唔准刪）
 * 發送引擎喺 api/livePush.ts（never-throw）；endpoint/keys/secret 永遠唔准落 log／audit。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { canonicalForId, embedForId, probeFbThumb, resolveFbThumb, resolveFbVideoId } from "./fbVideo";
import { pushCampaigns, pushSubscriptions, users } from "@db/schema";
import {
  authedProcedure,
  createRouter,
  publicQuery,
  staffProcedure,
  supervisorProcedure,
} from "./middleware";
import { logAudit } from "./audit";
import { PUSH_TITLE, buildLivePushBody, sendLivePush } from "./livePush";
import { forwardMemberToWms } from "./wmsMemberSync";

/** v2.2.1（合約 §9）：直播推送同意狀態有變 → 即推最新狀態去 WMS（fire-and-forget，失敗淨 log） */
function syncPushStateToWms(userId: number): void {
  void forwardMemberToWms(userId).catch((e) => console.error("[wms] member sync error:", e));
}

/** 直播推送「進行中」窗口：sent 後 90 分鐘內前台展示 */
const LIVE_WINDOW_MS = 90 * 60 * 1000;

/** requestLivePush 入參（合約 §8）：liveDate/liveSession 非空（max 32）、
 *  url 必須 https?://（max 500）、message 選填 max 200（有就取代 body 第一句） */
const livePushInputSchema = z.object({
  liveDate: z.string().trim().min(1, "請填直播日期").max(32),
  liveSession: z.string().trim().min(1, "請填直播場次").max(32),
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\//i, "網址必須以 http:// 或 https:// 開頭"),
  message: z.string().trim().max(200).optional(),
});

/** 建立推送批次（status='pending'，由調用方決定跟手發唔發）；回新批次 id */
async function insertCampaign(
  input: z.infer<typeof livePushInputSchema>,
  requestedBy: number | null,
  requestedByName: string | null,
): Promise<number> {
  const db = getDb();
  const [{ id }] = await db
    .insert(pushCampaigns)
    .values({
      title: PUSH_TITLE,
      body: buildLivePushBody(input.liveDate, input.liveSession, input.message),
      liveDate: input.liveDate,
      liveSession: input.liveSession,
      url: input.url,
      status: "pending",
      source: "SHOP",
      requestedBy,
      requestedByName,
    })
    .returning({ id: pushCampaigns.id });
  return id;
}

/** 由 userId 攞顯示名（審批人／申請人留底用；搵唔到就 null） */
async function userNameOf(userId: number): Promise<string | null> {
  const db = getDb();
  const [u] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.name ?? null;
}

export const pushRouter = createRouter({
  // ─── getVapidKey（公開）：前端 subscribe 要用 VAPID public key ───────────
  getVapidKey: publicQuery.query(() => {
    return { key: process.env.VAPID_PUBLIC_KEY ?? null };
  }),

  // ─── subscribe（登入）：綁定呢部裝置＋開啟直播推送同意 ────────────────────
  subscribe: authedProcedure
    .input(
      z.object({
        endpoint: z.string().trim().min(1).max(1000),
        p256dh: z.string().trim().min(1).max(255),
        auth: z.string().trim().min(1).max(255),
        userAgent: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // upsert by endpoint：同一部裝置重複訂閱就刷新 keys 兼 reactivate
      const [sub] = await db
        .insert(pushSubscriptions)
        .values({
          userId: ctx.user.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
          active: true,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: ctx.user.userId,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent ?? null,
            active: true,
          },
        })
        .returning({ id: pushSubscriptions.id });
      await db
        .update(users)
        .set({ livePushOptIn: true, livePushOptInAt: new Date() })
        .where(eq(users.id, ctx.user.userId));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.subscribe",
        targetType: "pushSubscription",
        targetId: sub.id,
        detail: `綁定直播開播推送裝置（訂閱 #${sub.id}）`,
      });
      syncPushStateToWms(ctx.user.userId);
      return { ok: true, id: sub.id };
    }),

  // ─── unsubscribe（登入）：註銷裝置；冇 endpoint＝全撤 ────────────────────
  unsubscribe: authedProcedure
    .input(z.object({ endpoint: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const conds = [eq(pushSubscriptions.userId, ctx.user.userId)];
      if (input.endpoint) {
        conds.push(eq(pushSubscriptions.endpoint, input.endpoint));
      }
      await db
        .update(pushSubscriptions)
        .set({ active: false })
        .where(and(...conds));
      // 冇 active 裝置就 optIn=false（同意狀態跟實際綁定走）
      const remaining = await db.query.pushSubscriptions.findMany({
        where: and(
          eq(pushSubscriptions.userId, ctx.user.userId),
          eq(pushSubscriptions.active, true),
        ),
        columns: { id: true },
      });
      if (remaining.length === 0) {
        await db
          .update(users)
          .set({ livePushOptIn: false })
          .where(eq(users.id, ctx.user.userId));
      }
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.unsubscribe",
        targetType: "pushSubscription",
        detail: input.endpoint
          ? `取消綁定 1 部直播推送裝置；剩餘有效裝置 ${remaining.length} 部`
          : `取消全部直播推送裝置綁定；剩餘有效裝置 0 部`,
      });
      syncPushStateToWms(ctx.user.userId);
      return { ok: true, activeDevices: remaining.length };
    }),

  // ─── myPushStatus（登入）：我嘅推送狀態 ─────────────────────────────────
  myPushStatus: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const [me] = await db
      .select({ livePushOptIn: users.livePushOptIn })
      .from(users)
      .where(eq(users.id, ctx.user.userId))
      .limit(1);
    const devices = await db.query.pushSubscriptions.findMany({
      where: and(
        eq(pushSubscriptions.userId, ctx.user.userId),
        eq(pushSubscriptions.active, true),
      ),
      columns: { id: true },
    });
    return { optIn: me?.livePushOptIn ?? false, activeDevices: devices.length };
  }),

  // ─── listMyDevices（登入）：我綁定咗嘅裝置清單（active，createdAt 新→舊） ──
  // 安全：endpoint 永遠唔回前端；「呢部裝置」標記由 server 對比 currentEndpoint 計。
  listMyDevices: authedProcedure
    .input(z.object({ currentEndpoint: z.string().trim().min(1).max(1000).optional() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.query.pushSubscriptions.findMany({
        where: and(
          eq(pushSubscriptions.userId, ctx.user.userId),
          eq(pushSubscriptions.active, true),
        ),
        columns: {
          id: true,
          userAgent: true,
          endpoint: true, // 只作 server 端對比，唔會落回應
          createdAt: true,
          lastSentAt: true,
        },
        orderBy: [desc(pushSubscriptions.createdAt)],
      });
      return {
        devices: rows.map((r) => ({
          id: r.id,
          userAgent: r.userAgent,
          createdAt: r.createdAt,
          lastSentAt: r.lastSentAt,
          isCurrent: !!input.currentEndpoint && r.endpoint === input.currentEndpoint,
        })),
      };
    }),

  // ─── removeMyDevice（登入）：逐部踢走；只准 deactivate 屬於自己嘅 row ─────
  removeMyDevice: authedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // where id + userId + active：唔係自己嘅（或已撤）一律 ok:false，唔洩露存在性
      const updated = await db
        .update(pushSubscriptions)
        .set({ active: false })
        .where(
          and(
            eq(pushSubscriptions.id, input.id),
            eq(pushSubscriptions.userId, ctx.user.userId),
            eq(pushSubscriptions.active, true),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      if (updated.length === 0) {
        return { ok: false as const };
      }
      // 冇 active 裝置就 optIn=false（同意狀態跟實際綁定走）
      const remaining = await db.query.pushSubscriptions.findMany({
        where: and(
          eq(pushSubscriptions.userId, ctx.user.userId),
          eq(pushSubscriptions.active, true),
        ),
        columns: { id: true },
      });
      if (remaining.length === 0) {
        await db
          .update(users)
          .set({ livePushOptIn: false })
          .where(eq(users.id, ctx.user.userId));
      }
      // audit：只落 id＋userId，endpoint 明文永遠唔准落 log
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.removeMyDevice",
        targetType: "pushSubscription",
        targetId: input.id,
        detail: `推送裝置移除（訂閱 #${input.id}，用戶 #${ctx.user.userId}）；剩餘有效裝置 ${remaining.length} 部`,
      });
      syncPushStateToWms(ctx.user.userId);
      return { ok: true as const };
    }),

  // ─── currentLive（公開）：最新一筆 90 分鐘內 sent 嘅直播 ────────────────
  currentLive: publicQuery.query(async () => {
    const db = getDb();
    const since = new Date(Date.now() - LIVE_WINDOW_MS);
    const live = await db.query.pushCampaigns.findFirst({
      // v2.2.2（老闆指令）：endedAt 有值＝後台已落畫，即時唔再顯示
      where: and(
        eq(pushCampaigns.status, "sent"),
        gte(pushCampaigns.sentAt, since),
        isNull(pushCampaigns.endedAt),
      ),
      orderBy: [desc(pushCampaigns.sentAt)],
    });
    if (!live || !live.sentAt) {
      return { live: null };
    }
    // v2.2.8（老闆指令「直播都要預覽到條片」）：同回顧一樣經 resolveFbVideoId——
    // 認到影片 ID（短鏈都解）→ 官網原位播；解唔到 → null，前端跌落「撳咗彈 FB app」。
    // v2.2.14（老闆指令「要有真預覽圖」）：thumbUrl 改用 resolveFbThumb——
    // graph /picture 對影片 ID 回通用灰圖等於冇；而家 server 摷播放器 HTML 嘅
    // og:image，回 scontent CDN 真縮圖畀客人部機直載；摷唔到 → null 跌落 poster。
    const vid = await resolveFbVideoId(live.url).catch(() => null);
    const thumb = vid ? await resolveFbThumb(vid).catch(() => null) : null;
    return {
      live: {
        liveDate: live.liveDate,
        liveSession: live.liveSession,
        url: live.url,
        sentAt: live.sentAt,
        embedUrl: vid ? embedForId(vid) : null,
        thumbUrl: thumb,
      },
    };
  }),

  // ─── previewLiveUrl（員工級）：推送前即檢查條 FB 連結官網播唔播到（v2.2.8 老闆問「邊款連結得」）──
  previewLiveUrl: staffProcedure
    .input(z.object({ url: z.string().trim().url().max(500) }))
    .query(async ({ input }) => {
      const id = await resolveFbVideoId(input.url).catch(() => null);
      // v2.2.15（老闆指令「回顧要有真預覽圖」）：預覽連埋縮圖診斷（唔經 cache 即場摷），
      // 等老闆喺後台一撳就知伺服器摷唔摷到真縮圖、摷唔到係咩原因，唔使估。
      const probe = id ? await probeFbThumb(id).catch(() => null) : null;
      return {
        embeddable: !!id,
        canonicalUrl: id ? canonicalForId(id) : input.url,
        changed: id ? canonicalForId(id) !== input.url : false,
        thumbUrl: probe?.url ?? null,
        thumbNote: !id ? null : (probe?.reason ?? "fetch_fail"),
      };
    }),

  // ─── liveHistory（公開）：直播回顧——已落畫嘅場次，最新 10 筆（v2.2.5 老闆指令）────
  // 「已落畫」＝後台按咗落播（endedAt 有值）或者 90 分鐘窗口已過；
  // 進行中嗰筆唔會出現喺度（佢喺 currentLive）。直播頁用嚟列「日期＋場次」畀客人重溫。
  liveHistory: publicQuery.query(async () => {
    const db = getDb();
    const since = new Date(Date.now() - LIVE_WINDOW_MS);
    const rows = await db.query.pushCampaigns.findMany({
      where: and(
        eq(pushCampaigns.status, "sent"),
        or(isNotNull(pushCampaigns.endedAt), lt(pushCampaigns.sentAt, since)),
      ),
      orderBy: [desc(pushCampaigns.sentAt)],
      limit: 10,
    });
    // v2.2.7：逐場解埋 FB 嵌入連結（share/v/、fb.watch 短鏈 server 幫手解鏈）；
    // 解唔到就 null，前端撳 ▶ 會直接彈去 FB app，唔會再出「影片不存在」。
    // v2.2.14：縮圖改用 resolveFbThumb（server 摷 og:image 真縮圖）——
    // 舊版 graph /picture 對影片 ID 回通用灰圖，十場都一個樣，老闆指令要真預覽。
    const vids = await Promise.all(
      rows.map((r) => resolveFbVideoId(r.url).catch(() => null)),
    );
    const thumbs = await Promise.all(
      vids.map((v) => (v ? resolveFbThumb(v).catch(() => null) : null)),
    );
    return {
      items: rows.map((r, i) => ({
        id: r.id,
        liveDate: r.liveDate,
        liveSession: r.liveSession,
        url: r.url,
        sentAt: r.sentAt,
        embedUrl: vids[i] ? embedForId(vids[i] as string) : null,
        thumbUrl: thumbs[i],
      })),
    };
  }),

  // ─── requestLivePush（員工級）：staff→pending 等批；supervisor/admin→直接發送 ─
  requestLivePush: staffProcedure
    .input(livePushInputSchema)
    .mutation(async ({ ctx, input }) => {
      const requestedByName = await userNameOf(ctx.user.userId);
      const id = await insertCampaign(input, ctx.user.userId, requestedByName);
      if (ctx.user.role === "staff") {
        // 員工申請 → pending，等主管/管理員喺 approveLivePush 批
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "push.requestLivePush",
          targetType: "pushCampaign",
          targetId: id,
          detail: `申請發送直播開播推送（批次 #${id}，${input.liveDate} ${input.liveSession}），等待主管審批`,
        });
        return { ok: true, id, status: "pending" as const };
      }
      // 主管／管理員 → 直接發送（fire-and-forget，唔阻塞回應；狀態機 pending→sending→sent/failed）
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.requestLivePush",
        targetType: "pushCampaign",
        targetId: id,
        detail: `直接發送直播開播推送（批次 #${id}，${input.liveDate} ${input.liveSession}，${ctx.user.role === "admin" ? "管理員" : "主管"}免審批）`,
      });
      void sendLivePush(id).catch((e) => console.error(`[push] 批次 #${id} 發送出錯:`, e));
      return { ok: true, id, status: "sending" as const };
    }),

  // ─── approveLivePush（主管級）：通過即發送；拒絕→rejected ────────────────
  approveLivePush: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        approve: z.boolean(),
        reviewNote: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const campaign = await db.query.pushCampaigns.findFirst({
        where: eq(pushCampaigns.id, input.id),
      });
      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "推送批次唔存在" });
      }
      if (campaign.status !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `批次狀態係 ${campaign.status}，唔可以再審批`,
        });
      }
      const reviewedByName = await userNameOf(ctx.user.userId);
      if (input.approve) {
        // 通過：記低審批人，批次維持 pending 交俾 sendLivePush 轉態發送（fire-and-forget）
        await db
          .update(pushCampaigns)
          .set({
            reviewedBy: ctx.user.userId,
            reviewedByName,
            reviewNote: input.reviewNote ?? null,
          })
          .where(eq(pushCampaigns.id, input.id));
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "push.approveLivePush",
          targetType: "pushCampaign",
          targetId: input.id,
          detail: `批准直播開播推送（批次 #${input.id}，${campaign.liveDate} ${campaign.liveSession}），即時發送${input.reviewNote ? `；備註：${input.reviewNote}` : ""}`,
        });
        void sendLivePush(input.id).catch((e) =>
          console.error(`[push] 批次 #${input.id} 發送出錯:`, e),
        );
        return { ok: true, id: input.id, status: "sending" as const };
      }
      await db
        .update(pushCampaigns)
        .set({
          status: "rejected",
          reviewedBy: ctx.user.userId,
          reviewedByName,
          reviewNote: input.reviewNote ?? null,
        })
        .where(eq(pushCampaigns.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.rejectLivePush",
        targetType: "pushCampaign",
        targetId: input.id,
        detail: `拒絕直播開播推送（批次 #${input.id}，${campaign.liveDate} ${campaign.liveSession}）${input.reviewNote ? `；原因：${input.reviewNote}` : ""}`,
      });
      return { ok: true, id: input.id, status: "rejected" as const };
    }),

  // ─── listLivePush（員工級）：近 50 筆批次紀錄 ───────────────────────────
  listLivePush: staffProcedure.query(async () => {
    const db = getDb();
    const rows = await db.query.pushCampaigns.findMany({
      orderBy: [desc(pushCampaigns.createdAt)],
      limit: 50,
    });
    return {
      items: rows.map((r) => ({
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
      })),
    };
  }),

  // ─── endLiveNow（員工級）：一掣落直播畫（v2.2.2 老闆指令）─────────────
  // 推播一出，首頁／直播頁會顯示 90 分鐘；老闆要可以即時取消顯示。
  // 做法：最新一筆顯示緊嘅批次（sent＋90 分鐘內＋未落畫）寫 endedAt=now()，
  // 批次紀錄保留（歷史清單照見「已發送」），唔影響已發出嘅通知本身。
  endLiveNow: staffProcedure.mutation(async ({ ctx }) => {
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
      return { ok: false as const, message: "而家冇顯示緊嘅直播" };
    }
    await db
      .update(pushCampaigns)
      .set({ endedAt: new Date() })
      .where(eq(pushCampaigns.id, live.id));
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "push.endLiveNow",
      targetType: "pushCampaign",
      targetId: live.id,
      detail: `落直播畫（批次 #${live.id}，${live.liveDate} ${live.liveSession}）：首頁／直播頁即時停止顯示`,
    });
    return { ok: true as const, id: live.id, liveDate: live.liveDate, liveSession: live.liveSession };
  }),

  // ─── deleteLiveCampaign（員工級）：刪除直播回顧（v2.2.5 老闆指令）─────────────
  // 官網後台＋WMS 官網中心共用條規則：
  // · 顯示緊嘅直播（sent＋90 分鐘內＋未落畫）唔准刪——要先落播
  // · pending 批次唔准刪——請用審批拒絕
  // · 其餘（已落畫回顧／發送失敗／已拒絕）成筆刪走，寫 audit
  deleteLiveCampaign: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const campaign = await db.query.pushCampaigns.findFirst({
        where: eq(pushCampaigns.id, input.id),
      });
      if (!campaign) {
        return { ok: false as const, message: "推送批次唔存在（可能已經刪咗）" };
      }
      if (campaign.status === "pending" || campaign.status === "sending") {
        return { ok: false as const, message: "批次仲喺審批／發送流程，唔可以刪" };
      }
      const stillLive =
        campaign.status === "sent" &&
        !campaign.endedAt &&
        campaign.sentAt != null &&
        Date.now() - campaign.sentAt.getTime() < LIVE_WINDOW_MS;
      if (stillLive) {
        return { ok: false as const, message: "呢場直播仲顯示緊，請先按「落播」再刪" };
      }
      await db.delete(pushCampaigns).where(eq(pushCampaigns.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.deleteLiveCampaign",
        targetType: "pushCampaign",
        targetId: input.id,
        detail: `刪除直播回顧（批次 #${input.id}，${campaign.liveDate} ${campaign.liveSession}，狀態 ${campaign.status}）`,
      });
      return { ok: true as const, id: input.id };
    }),
});
