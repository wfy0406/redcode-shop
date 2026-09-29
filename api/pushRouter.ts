/**
 * v2.2.0 直播開播推送通知（老闆 2026-09-30 指令，合約 §8）：shop tRPC pushRouter。
 *
 * ─ getVapidKey（公開）：回 VAPID public key 俾前端 subscribe 用
 * ─ subscribe（登入）：綁定呢部裝置（upsert by endpoint）＋livePushOptIn=true
 * ─ unsubscribe（登入）：註銷裝置（冇 endpoint＝全撤）；冇 active 裝置就 optIn=false
 * ─ myPushStatus（登入）：{ optIn, activeDevices }
 * ─ listMyDevices（登入）：裝置清單 {id,userAgent,createdAt,lastSentAt,isCurrent}（endpoint 唔回前端）
 * ─ removeMyDevice（登入）：逐部踢走（只准自己嘅 row）；冇 active 裝置就 optIn=false
 * ─ currentLive（公開）：最新一筆 90 分鐘內 sent 嘅直播（embedUrl 只限 facebook.com）
 * ─ requestLivePush（員工級）：staff→pending 等批；supervisor/admin→直接發送（fire-and-forget）
 * ─ approveLivePush（主管級）：{id, approve, reviewNote?}→通過即發送
 * ─ listLivePush（員工級）：近 50 筆批次紀錄
 * 發送引擎喺 api/livePush.ts（never-throw）；endpoint/keys/secret 永遠唔准落 log／audit。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "./queries/connection";
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
      where: and(eq(pushCampaigns.status, "sent"), gte(pushCampaigns.sentAt, since)),
      orderBy: [desc(pushCampaigns.sentAt)],
    });
    if (!live || !live.sentAt) {
      return { live: null };
    }
    // FB embed 預覽：只喺 url 含 facebook.com 先砌 plugins/video.php，否則 null
    const embedUrl = live.url.includes("facebook.com")
      ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(live.url)}&show_text=false`
      : null;
    return {
      live: {
        liveDate: live.liveDate,
        liveSession: live.liveSession,
        url: live.url,
        sentAt: live.sentAt,
        embedUrl,
      },
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
      })),
    };
  }),
});
