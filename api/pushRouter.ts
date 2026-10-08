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
 * ─ setLiveCampaignThumb（員工級）：手動上傳回顧縮圖（/uploads/...）；null＝還原自動摷圖
 * 發送引擎喺 api/livePush.ts（never-throw）；endpoint/keys/secret 永遠唔准落 log／audit。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
// v2.2.21：resolveFbThumb 唔再喺度用——縮圖搬咗去按需 endpoint /api/live-thumb/:id
// （boot.ts），摷圖／cache 喺嗰邊做；呢度淨係出相對路徑畀前端。
import { canonicalForId, embedForId, probeFbThumb, resolveFbVideoId } from "./fbVideo";
import { pushCampaigns, pushDeliveries, pushSubscriptions, users } from "@db/schema";
import {
  authedProcedure,
  createRouter,
  publicQuery,
  staffProcedure,
  supervisorProcedure,
} from "./middleware";
import { logAudit } from "./audit";
import {
  MAX_EXTEND_MINUTES,
  PUSH_TITLE,
  REPLAY_ORDER_BY,
  buildLivePushBody,
  effectiveLiveWindowMs,
  moveLiveReplay,
  sendLivePush,
} from "./livePush";
import { forwardMemberToWms } from "./wmsMemberSync";

/** v2.2.1（合約 §9）：直播推送同意狀態有變 → 即推最新狀態去 WMS（fire-and-forget，失敗淨 log） */
function syncPushStateToWms(userId: number): void {
  void forwardMemberToWms(userId).catch((e) => console.error("[wms] member sync error:", e));
}

/** v2.2.37（老闆指令）：「仲顯示緊」條件——sent 後未過實際窗口（90 分鐘＋後台延長，
 * 每掣 +60 上限 240，逐行計）。配合 status='sent'＋endedAt IS NULL 用。 */
const liveStillOnSql = sql`${pushCampaigns.sentAt} >= now() - (interval '90 minutes' + ${pushCampaigns.extendedMinutes} * interval '1 minute')`;

/** v2.2.37：「可以入回顧」條件——已落畫，或者已過實際窗口（延長緊嘅唔會提早跌入） */
const replayReadySql = sql`(${pushCampaigns.endedAt} IS NOT NULL OR ${pushCampaigns.sentAt} < now() - (interval '90 minutes' + ${pushCampaigns.extendedMinutes} * interval '1 minute'))`;

/** requestLivePush 入參（合約 §8）：liveDate/liveSession 非空（max 32）、
 *  url 必須 https?://（max 500）、message 選填 max 200（有就取代 body 第一句）；
 *  v2.2.37 加兩個剔選：skipNotify（唔送通知，照出現直播中）／
 *  directReplay（唔送通知兼唔出現直播中，直接落入直播回顧） */
const livePushInputSchema = z.object({
  liveDate: z.string().trim().min(1, "請填直播日期").max(32),
  liveSession: z.string().trim().min(1, "請填直播場次").max(32),
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\//i, "網址必須以 http:// 或 https:// 開頭"),
  message: z.string().trim().max(200).optional(),
  skipNotify: z.boolean().optional(),
  directReplay: z.boolean().optional(),
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
      // v2.2.37：兩個剔選跟批次存（審批通過後 sendLivePush 會照旗號行事）
      skipNotify: input.skipNotify === true,
      directReplay: input.directReplay === true,
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
      // v2.2.44（老闆指令：Android 要讀到廠牌）：Chrome 凍結咗 UA 型號，
      // 真型號喺 sec-ch-ua-model header（boot.ts Accept-CH 協商後瀏覽器先會自帶）；
      // 冇帶（Safari／舊瀏覽器）就 null，parser 跌返 UA 規則。
      // 保安：header 截 128 字落 DB，唔落 log。
      const deviceModel = (ctx.req.headers.get("sec-ch-ua-model") ?? "").trim().slice(0, 128) || null;
      // upsert by endpoint：同一部裝置重複訂閱就刷新 keys 兼 reactivate
      const [sub] = await db
        .insert(pushSubscriptions)
        .values({
          userId: ctx.user.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
          deviceModel,
          active: true,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: ctx.user.userId,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent ?? null,
            // 今次冇帶 CH 就唔好冚走舊值（例如某次 request 未協商到）
            ...(deviceModel ? { deviceModel } : {}),
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

  // ─── currentLive（公開）：最新一筆仲喺顯示窗口內 sent 嘅直播 ────────────────
  // v2.2.37：窗口＝90 分鐘＋後台延長（每掣 +60，上限 240），逐行計
  currentLive: publicQuery.query(async () => {
    const db = getDb();
    const live = await db.query.pushCampaigns.findFirst({
      // v2.2.2（老闆指令）：endedAt 有值＝後台已落畫，即時唔再顯示
      where: and(
        eq(pushCampaigns.status, "sent"),
        liveStillOnSql,
        isNull(pushCampaigns.endedAt),
      ),
      orderBy: [desc(pushCampaigns.sentAt)],
    });
    if (!live || !live.sentAt) {
      return { live: null };
    }
    // v2.2.8（老闆指令「直播都要預覽到條片」）：同回顧一樣經 resolveFbVideoId——
    // 認到影片 ID（短鏈都解）→ 官網原位播；解唔到 → null，前端跌落「撳咗彈 FB app」。
    // v2.2.14：thumbUrl 曾改用 resolveFbThumb 回 scontent CDN URL 畀客人部機直載——
    // v2.2.21（老闆實測：縮圖全部跌落 poster）根治：scontent URL 有時效（oe/oh 參數）
    // 兼 FB 對 server IP 時好時壞，直載成日 404/灰圖；所以縮圖搬去按需 endpoint
    // /api/live-thumb/:id——客人部機載我哋自己域名，server 代摷代 cache，唔會過期；
    // 任何失敗 endpoint 回 404，前端 onError 照跌落 poster（同而家行為一致，唔會更差）。
    const vid = await resolveFbVideoId(live.url).catch(() => null);
    return {
      live: {
        liveDate: live.liveDate,
        liveSession: live.liveSession,
        url: live.url,
        sentAt: live.sentAt,
        embedUrl: vid ? embedForId(vid) : null,
        // v2.2.23：手動上傳縮圖優先（FB 摷圖喺 Render 長期失敗嘅根治路線）；冇先落自動 endpoint
        thumbUrl: live.thumbUrl ?? (vid ? `/api/live-thumb/${vid}` : null),
        // v2.2.37：後台「而家顯示緊」卡要話俾老闆知延長咗幾多（延長掣上限判斷用）
        extendedMinutes: live.extendedMinutes,
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
        // v2.2.23 修正映射：任何 ok_* 來源（ok_oembed／ok_html／ok_mwatch）統一映射做 'ok'，
        // 前端 LivePushPanel 只認 'ok'／fetch_fail／no_match 三態
        thumbNote: !id
          ? null
          : probe?.reason
            ? probe.reason.startsWith("ok_")
              ? "ok"
              : probe.reason
            : "fetch_fail",
      };
    }),

  // ─── liveHistory（公開）：直播回顧——已落畫嘅場次，最新 10 筆（v2.2.5 老闆指令）────
  // 「已落畫」＝後台按咗落播（endedAt 有值）或者 90 分鐘窗口已過；
  // 進行中嗰筆唔會出現喺度（佢喺 currentLive）。直播頁用嚟列「日期＋場次」畀客人重溫。
  liveHistory: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db.query.pushCampaigns.findMany({
      // v2.2.37：已落畫／過咗實際窗口（90 分鐘＋延長）先入回顧
      where: and(eq(pushCampaigns.status, "sent"), replayReadySql),
      // v2.2.16（老闆指令）：回顧順序後台/WMS 改得——設咗 replayOrder 嘅排先
      orderBy: [...REPLAY_ORDER_BY],
      limit: 10,
    });
    // v2.2.7：逐場解埋 FB 嵌入連結（share/v/、fb.watch 短鏈 server 幫手解鏈）；
    // 解唔到就 null，前端撳 ▶ 會直接彈去 FB app，唔會再出「影片不存在」。
    // v2.2.14：縮圖曾用 resolveFbThumb 逐場摷 scontent CDN URL——
    // v2.2.21（老闆實測：縮圖全部跌落 poster）根治：scontent URL 會過期
    // （oe/oh 參數）兼逐場摷又慢又易俾 FB 封，所以唔再喺度摷——
    // thumbUrl 直接出相對路徑 /api/live-thumb/:id，客人部機載我哋自己域名，
    // 圖由按需 endpoint 代摷＋in-memory cache，唔會過期；前端 img src 照用到。
    const vids = await Promise.all(
      rows.map((r) => resolveFbVideoId(r.url).catch(() => null)),
    );
    return {
      items: rows.map((r, i) => ({
        id: r.id,
        liveDate: r.liveDate,
        liveSession: r.liveSession,
        url: r.url,
        sentAt: r.sentAt,
        embedUrl: vids[i] ? embedForId(vids[i] as string) : null,
        // v2.2.23：手動上傳縮圖優先；冇先出 /api/live-thumb 自動摷圖路徑
        thumbUrl: r.thumbUrl ?? (vids[i] ? `/api/live-thumb/${vids[i]}` : null),
      })),
    };
  }),

  // ─── requestLivePush（員工級）：staff→pending 等批；supervisor/admin→直接發送 ─
  requestLivePush: staffProcedure
    .input(livePushInputSchema)
    .mutation(async ({ ctx, input }) => {
      const requestedByName = await userNameOf(ctx.user.userId);
      const id = await insertCampaign(input, ctx.user.userId, requestedByName);
      // v2.2.37：審計留低兩個剔選狀態（直入回顧其實都唔會送通知）
      const flagNote = input.directReplay
        ? "；已剔「直接放入直播回顧」"
        : input.skipNotify
          ? "；已剔「不發送直播通知」"
          : "";
      if (ctx.user.role === "staff") {
        // 員工申請 → pending，等主管/管理員喺 approveLivePush 批
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "push.requestLivePush",
          targetType: "pushCampaign",
          targetId: id,
          detail: `申請發送直播開播推送（批次 #${id}，${input.liveDate} ${input.liveSession}），等待主管審批${flagNote}`,
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
        detail: `直接發送直播開播推送（批次 #${id}，${input.liveDate} ${input.liveSession}，${ctx.user.role === "admin" ? "管理員" : "主管"}免審批）${flagNote}`,
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
        // v2.2.16：回顧排序欄（後台 ↑↓ 調順序用）
        replayOrder: r.replayOrder,
        // v2.2.23：手動上傳縮圖（/uploads/... 或 null＝自動摷圖；後台上傳／還原用）
        thumbUrl: r.thumbUrl,
        // v2.2.37：三功能欄位——唔送通知／直入回顧／已延長分鐘數（後台徽章＋延長掣用）
        skipNotify: r.skipNotify,
        directReplay: r.directReplay,
        extendedMinutes: r.extendedMinutes,
      })),
    };
  }),

  // ─── moveLiveReplay（員工級）：直播回顧上移／下移一級（v2.2.16 老闆指令）───
  moveLiveReplay: staffProcedure
    .input(z.object({ id: z.number().int().positive(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ ctx, input }) => {
      const res = await moveLiveReplay(input.id, input.direction);
      if (res.ok) {
        void logAudit({
          actorId: ctx.user.userId,
          actorRole: ctx.user.role,
          action: "push.moveLiveReplay",
          targetType: "pushCampaign",
          targetId: input.id,
          detail: `直播回顧${input.direction === "up" ? "上移" : "下移"}一級（批次 #${input.id}）`,
        });
      }
      return res;
    }),

  // ─── setLiveCampaignThumb（員工級）：手動上傳直播回顧縮圖（v2.2.23 老闆實測：FB 摷圖長期失敗根治）───
  // thumbUrl 只准 "/uploads/" 開頭（即係經 /api/upload 上傳嘅本地檔）；null＝還原自動摷圖。
  setLiveCampaignThumb: staffProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        thumbUrl: z
          .string()
          .trim()
          .max(512)
          .regex(/^\/uploads\//, "縮圖路徑必須以 /uploads/ 開頭")
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const campaign = await db.query.pushCampaigns.findFirst({
        where: eq(pushCampaigns.id, input.id),
      });
      if (!campaign) {
        return { ok: false as const, message: "推送批次唔存在（可能已經刪咗）" };
      }
      await db
        .update(pushCampaigns)
        .set({ thumbUrl: input.thumbUrl })
        .where(eq(pushCampaigns.id, input.id));
      void logAudit({
        actorId: ctx.user.userId,
        actorRole: ctx.user.role,
        action: "push.setLiveCampaignThumb",
        targetType: "pushCampaign",
        targetId: input.id,
        detail: input.thumbUrl
          ? `手動設定直播回顧縮圖（批次 #${input.id}，${campaign.liveDate} ${campaign.liveSession}）`
          : `還原直播回顧自動摷圖（批次 #${input.id}，${campaign.liveDate} ${campaign.liveSession}）`,
      });
      return { ok: true as const, id: input.id };
    }),

  // ─── endLiveNow（員工級）：一掣落直播畫（v2.2.2 老闆指令）─────────────
  // 推播一出，首頁／直播頁會顯示 90 分鐘；老闆要可以即時取消顯示。
  // 做法：最新一筆顯示緊嘅批次（sent＋90 分鐘內＋未落畫）寫 endedAt=now()，
  // 批次紀錄保留（歷史清單照見「已發送」），唔影響已發出嘅通知本身。
  endLiveNow: staffProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const live = await db.query.pushCampaigns.findFirst({
      where: and(
        eq(pushCampaigns.status, "sent"),
        liveStillOnSql,
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

  // ─── extendLiveNow（員工級）：直播中延長 60 分鐘（v2.2.37 老闆指令）─────
  // 90 分鐘窗口到咗可以自己延——每撳一掣 extendedMinutes +60（累計上限 240，
  // 即最長 90+240＝330 分鐘）。currentLive／liveHistory／endLiveNow／刪除守衛
  // 全部跟 extendedMinutes 逐行計窗口，所以延長即時生效，唔使郁其他嘢。
  extendLiveNow: staffProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const live = await db.query.pushCampaigns.findFirst({
      where: and(
        eq(pushCampaigns.status, "sent"),
        liveStillOnSql,
        isNull(pushCampaigns.endedAt),
      ),
      orderBy: [desc(pushCampaigns.sentAt)],
    });
    if (!live) {
      return { ok: false as const, message: "而家冇顯示緊嘅直播可以延長" };
    }
    const current = Math.max(0, live.extendedMinutes ?? 0);
    if (current >= MAX_EXTEND_MINUTES) {
      return {
        ok: false as const,
        message: `已達延長上限（額外 ${MAX_EXTEND_MINUTES} 分鐘）`,
        id: live.id,
        extendedMinutes: current,
      };
    }
    const next = Math.min(MAX_EXTEND_MINUTES, current + 60);
    await db
      .update(pushCampaigns)
      .set({ extendedMinutes: next })
      .where(eq(pushCampaigns.id, live.id));
    void logAudit({
      actorId: ctx.user.userId,
      actorRole: ctx.user.role,
      action: "push.extendLiveNow",
      targetType: "pushCampaign",
      targetId: live.id,
      detail: `延長直播顯示 60 分鐘（批次 #${live.id}，${live.liveDate} ${live.liveSession}，累計延長 ${next} 分鐘）`,
    });
    return {
      ok: true as const,
      id: live.id,
      liveDate: live.liveDate,
      liveSession: live.liveSession,
      extendedMinutes: next,
    };
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
      // v2.2.37：窗口要跟延長——延長緊嘅場次一樣唔准刪
      const stillLive =
        campaign.status === "sent" &&
        !campaign.endedAt &&
        campaign.sentAt != null &&
        Date.now() - campaign.sentAt.getTime() < effectiveLiveWindowMs(campaign.extendedMinutes);
      if (stillLive) {
        return { ok: false as const, message: "呢場直播仲顯示緊，請先按「落播」再刪" };
      }
      // 2026-10-08 修正（老闆報告：刪除直播回顧 HTTP 500）：pushDeliveries.campaignId
      // 外鍵冇 onDelete cascade——批次只要發過通知，就有逐部裝置發送紀錄指住佢，
      // 直接刪批次 DB 會拒絕兼炒 500。所以先刪晒呢個批次嘅發送紀錄，再刪批次本身。
      // 同 Facebook 嗰邊刪唔刪條片完全無關（官網淨係儲咗條 URL 做文字）。
      await db.delete(pushDeliveries).where(eq(pushDeliveries.campaignId, input.id));
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
