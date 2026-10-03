/**
 * v2.2.46 直播抽獎大輪盤（老闆 2026-10-03 指令，加註：即時取消／紀錄頁取消／煙花小精靈）
 * --------------------------------
 * 後台（supervisorProcedure＝主管＋管理員先用到，導覽列都係佢哋先睇到）：
 *   adminListPrizes／adminUpsertPrize（名／圖選填，按 sku 兜底）／adminDeletePrize（硬刪；有紀錄擋住）——獎品池（名／貨號／價錢／上傳圖／場次）
 *   adminPreviewParticipants——抽獎名單剔選來源（可複選）：
 *     本月消費／累積消費／消費滿$X／官網會員／買過指定產品／已綁定推送客人
 *   adminDraw——抽一件獎品：server 隨機揀中獎人（crypto randomInt），
 *     強制「當日一人最多中一件」（pending／confirmed 先鎖住；重抽/取消/客人唔要＝無接受，放返出嚟可以再抽）；
 *     抽中即寄 email（有 email 嘅話）＋即時推送（有綁定嘅話）。
 *     v2.2.55（老闆指令）：獎品有件數——同款 N 件可以抽 N 次；
 *     防超抽由舊 unique index 改做 pg_advisory_xact_lock＋同事務數件（adminDrawManual 一樣）
 *   adminRedraw——特別重抽：舊紀錄直接刪除（老闆指令「岩岩既抽獎紀錄唔算數」，
 *     中獎紀錄唔會留底），同一件獎品再抽，舊中獎人照舊踢出呢件獎品嘅重抽池
 *   adminCancelWin——即時取消／之後喺紀錄頁取消：客人唔會再見到中獎彈窗；
 *     已生成訂單會一併取消（WMS 嗰邊要人手拒絕，README 有寫）
 *   adminHistory——中獎紀錄按抽獎日分組（新→舊）
 *
 * 客人（authedProcedure）：
 *   myPendingWin——全域彈窗用：最新一筆 pending 中獎（＋獎品資料）
 *   respondWin——「多謝，請寄送」（preset 用會員預設順豐站／地址；station 揀新站點）
 *     → 生成 0 元訂單（場次 0／日期=抽獎日／備註官網訂單・包郵・中獎商品）→ 背景飛 WMS 等審批
 *     「唔要」→ declined，件獎品返返入池
 *
 * 保安鐵律：endpoint/keys/secret 永遠唔落 log；呢度冇接觸訂閱敏感欄位。
 */

import { randomInt } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import { createRouter, authedProcedure, supervisorProcedure, adminProcedure } from "./middleware";
import { getDb } from "./queries/connection";
import {
  luckyDrawLists,
  luckyDraws,
  luckyDrawSessions,
  luckyPrizes,
  orderItems,
  orders,
  paymentProofs,
  products,
  pushSubscriptions,
  sfStations,
  users,
  wmsSyncLog,
} from "@db/schema";
import { sendPrizeWinEmail } from "./email";
import { sendPrizeWinPush } from "./livePush";
import { forwardOrderToWms } from "./wmsSync";
import { logAudit } from "./audit";

/** 消費計數嘅訂單狀態：批咗／出咗貨／完成先算真消費（待審批／取消唔計） */
const PAID_STATUSES = ["approved", "shipped", "completed"] as const;

/** 香港時間今日 → YYYYMMDD（抽獎日；一人一日一件、紀錄分組都靠佢） */
function hktToday(): string {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" })
    .replaceAll("-", "");
}

/** 香港時間今個月 1 號 00:00 嘅 UTC Date（本月消費篩選用） */
function hktMonthStart(): Date {
  const ym = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" }).slice(0, 7);
  return new Date(`${ym}-01T00:00:00+08:00`);
}

/** YYYYMMDD → YYYY-MM-DD（顯示用） */
function fmtDrawDate(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** 中獎訂單單號（同 ordersRouter 同款 RC<ymd><4位隨機>；呢度唔 export 嗰個，自己砌） */
async function genOrderNo(): Promise<string> {
  const db = getDb();
  const hkt = new Date(Date.now() + 8 * 3600 * 1000);
  const ymd = hkt.toISOString().slice(0, 10).replaceAll("-", "");
  for (let i = 0; i < 8; i++) {
    const no = `RC${ymd}${String(randomInt(0, 10000)).padStart(4, "0")}`;
    const dup = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNo, no)).limit(1);
    if (dup.length === 0) return no;
  }
  return `RC${ymd}${String(randomInt(0, 1000000)).padStart(6, "0")}`;
}

const participantFilterInput = z.object({
  thisMonth: z.boolean().default(false),
  cumulative: z.boolean().default(false),
  /** 消費滿幾多錢（整數港元；null/未填＝唔用呢個條件） */
  minSpend: z.number().int().min(0).nullable().default(null),
  allMembers: z.boolean().default(false),
  /** 買過指定官網產品（products.id；null＝唔用呢個條件） */
  productId: z.number().int().positive().nullable().default(null),
  pushBound: z.boolean().default(false),
  /** 本月消費滿 $X（整數港元；null＝唔用） */
  thisMonthMinSpend: z.number().int().min(0).nullable().default(null),
  /** 本月新客戶（createdAt 喺今個月） */
  newThisMonth: z.boolean().default(false),
  /** 呢日之前註冊（YYYY-MM-DD；null＝唔用） */
  joinedBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** 呢日或之後註冊（YYYY-MM-DD；null＝唔用） */
  joinedAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

type ParticipantFilter = z.infer<typeof participantFilterInput>;

/** 按剔選來源攞合資格 user id set（union 去重）。
 *  三個消費來源各自獨立查詢再 union——本月消費／累積消費／累積滿$X 係三個獨立條件，
 *  唔可以 AND 埋一齊（齊剔「本月」＋「累積」唔應該只剩本月）。 */
async function collectParticipantIds(f: ParticipantFilter): Promise<Set<number>> {
  const db = getDb();
  const out = new Set<number>();
  const jobs: Promise<void>[] = [];

  if (f.thisMonth) {
    jobs.push(
      (async () => {
        const rows = await db
          .select({ userId: orders.userId })
          .from(orders)
          .where(and(inArray(orders.status, [...PAID_STATUSES]), gte(orders.createdAt, hktMonthStart())))
          .groupBy(orders.userId);
        for (const r of rows) out.add(r.userId);
      })(),
    );
  }
  if (f.cumulative || (f.minSpend ?? 0) > 0) {
    jobs.push(
      (async () => {
        const rows = await db
          .select({ userId: orders.userId, total: sql<number>`sum(${orders.total})` })
          .from(orders)
          .where(inArray(orders.status, [...PAID_STATUSES]))
          .groupBy(orders.userId);
        for (const r of rows) {
          // union 語義：剔「累積消費」→ 買過就入；剔「消費滿$X」→ 累積滿額先入；
          // 兩個都剔 → 累積已包晒滿額（⊂），照入
          if (f.cumulative) {
            out.add(r.userId);
          } else if ((f.minSpend ?? 0) > 0 && Number(r.total) >= (f.minSpend ?? 0)) {
            out.add(r.userId);
          }
        }
      })(),
    );
  }
  if (f.allMembers) {
    jobs.push(
      (async () => {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, "member"));
        for (const r of rows) out.add(r.id);
      })(),
    );
  }
  if (f.productId) {
    const pid = f.productId;
    jobs.push(
      (async () => {
        const rows = await db
          .select({ userId: orders.userId })
          .from(orderItems)
          .innerJoin(orders, eq(orderItems.orderId, orders.id))
          .where(and(eq(orderItems.productId, pid), inArray(orders.status, [...PAID_STATUSES])))
          .groupBy(orders.userId);
        for (const r of rows) out.add(r.userId);
      })(),
    );
  }
  if (f.pushBound) {
    jobs.push(
      (async () => {
        const rows = await db
          .select({ userId: pushSubscriptions.userId })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.active, true))
          .groupBy(pushSubscriptions.userId);
        for (const r of rows) out.add(r.userId);
      })(),
    );
  }
  // 本月消費滿 $X：paid orders 限今個月（香港時間），group by 後 sum(total) 夠數先入
  if ((f.thisMonthMinSpend ?? 0) > 0) {
    const minSpend = f.thisMonthMinSpend ?? 0;
    jobs.push(
      (async () => {
        const rows = await db
          .select({ userId: orders.userId, total: sql<number>`sum(${orders.total})` })
          .from(orders)
          .where(and(inArray(orders.status, [...PAID_STATUSES]), gte(orders.createdAt, hktMonthStart())))
          .groupBy(orders.userId);
        for (const r of rows) {
          if (Number(r.total) >= minSpend) out.add(r.userId);
        }
      })(),
    );
  }
  // 本月新客戶：官網會員 createdAt 喺今個月（香港時間）
  if (f.newThisMonth) {
    jobs.push(
      (async () => {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "member"), gte(users.createdAt, hktMonthStart())));
        for (const r of rows) out.add(r.id);
      })(),
    );
  }
  // 呢日之前註冊（YYYY-MM-DD 當香港時間 00:00 界線）
  if (f.joinedBefore) {
    const cutoff = new Date(`${f.joinedBefore}T00:00:00+08:00`);
    jobs.push(
      (async () => {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "member"), lt(users.createdAt, cutoff)));
        for (const r of rows) out.add(r.id);
      })(),
    );
  }
  // 呢日或之後註冊（YYYY-MM-DD 當香港時間 00:00 界線）
  if (f.joinedAfter) {
    const cutoff = new Date(`${f.joinedAfter}T00:00:00+08:00`);
    jobs.push(
      (async () => {
        const rows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "member"), gte(users.createdAt, cutoff)));
        for (const r of rows) out.add(r.id);
      })(),
    );
  }
  await Promise.all(jobs);
  // v2.2.48：影子帳號（自訂名單中獎人，phone="DRAW#…"）永遠唔入會員池——
  // 佢哋嘅 0 元中獎單批咗會變 approved，唔排除會混入消費池
  const shadows = await db.select({ id: users.id }).from(users).where(like(users.phone, "DRAW#%"));
  for (const s of shadows) out.delete(s.id);
  return out;
}

/** 某日（香港時間 YYYYMMDD，預設今日）鎖住咗嘅中獎人（一日一人一個）。
 *  新規矩（老闆實測回饋）：只有 pending（等待接受）同 confirmed（接受咗）先鎖住；
 *  cancelled／declined＝無接受獎品 → 放返出嚟可以再抽。
 *  特別重抽用舊紀錄嘅抽獎日計，跨日重抽都唔會違反當日規矩。 */
async function winnersOfDate(date?: string): Promise<Set<number>> {
  const db = getDb();
  const rows = await db
    .select({ winnerUserId: luckyDraws.winnerUserId })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.drawDate, date ?? hktToday()), inArray(luckyDraws.status, ["pending", "confirmed"])));
  return new Set(rows.map((r) => r.winnerUserId));
}

/** 後台操作人名稱（ctx.user 淨得 userId/role） */
async function actorName(userId: number): Promise<string | null> {
  const db = getDb();
  const [r] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return r?.name ?? null;
}

/** 由池入面 server 隨機揀中獎人（crypto randomInt）；攞唔到會員行就 null */
async function pickWinner(pool: number[]) {
  if (pool.length === 0) return null;
  const db = getDb();
  const winnerId = pool[randomInt(0, pool.length)];
  const [winner] = await db
    .select({ id: users.id, name: users.name, phone: users.phone, email: users.email })
    .from(users)
    .where(eq(users.id, winnerId))
    .limit(1);
  return winner ?? null;
}

/** 自訂名單中獎人嘅影子帳號（唔係官網會員都要起 0 元單飛 WMS；orders.userId 唔可以 null）。
 *  phone="DRAW#名"（unique、32 字截斷）做 key；同名重用；永遠登入唔到（passwordHash "!"）。 */
async function getOrCreateShadowUser(name: string): Promise<{ id: number; name: string }> {
  const phone = `DRAW#${name}`.slice(0, 32);
  const db = getDb();
  const [hit] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phone, phone)).limit(1);
  if (hit) return hit;
  try {
    const [u] = await db.insert(users).values({ name: name.slice(0, 255), phone, passwordHash: "!" }).returning({ id: users.id, name: users.name });
    return u;
  } catch (e) {
    if (String((e as { code?: string })?.code) === "23505") {
      const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phone, phone)).limit(1);
      if (u) return u;
    }
    throw e;
  }
}

/** 名單名正規化（trim＋toLowerCase）：「一日一個名中一次」同去重比較都用佢；
 *  顯示／winnerName 快照保留原串 */
function normalizeListName(n: string): string {
  return n.trim().toLowerCase();
}

/** 某日（香港時間 YYYYMMDD，預設今日）自訂名單鎖住咗嘅中獎名（一日一個名一次）。
 *  同 winnersOfDate 一樣：只計 pending／confirmed；cancelled／declined 唔再阻人再中。
 *  回 normalized set。 */
async function winnerNamesOfDate(date?: string): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ winnerName: luckyDraws.winnerName })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.drawDate, date ?? hktToday()), inArray(luckyDraws.status, ["pending", "confirmed"])));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.winnerName != null) out.add(normalizeListName(r.winnerName));
  }
  return out;
}

/** 自訂名單混合池 entry：手打名（'name'，抽中起影子帳號、唔通知）｜
 *  官網會員（'member'，抽中照常彈窗＋email＋推送，自己揀地址寄送） */
type MixedPoolEntry =
  | { kind: "name"; name: string }
  | { kind: "member"; id: number; name: string; email: string | null };

/** 砌名單混合池：手打名踢走嗰日中過嘅名（normalize 比）；會員（select 返嚟先算，
 *  已刪會員自動唔出現）踢走嗰日中過嘅 id；extraExclude 顯式踢舊中獎名/id（重抽保險） */
async function collectMixedPool(
  list: { names: string[]; memberIds: number[] },
  drawDate?: string,
  extraExclude?: { name?: string | null; userId?: number },
): Promise<MixedPoolEntry[]> {
  const db = getDb();
  const wonNames = await winnerNamesOfDate(drawDate);
  const wonIds = await winnersOfDate(drawDate);
  if (extraExclude?.name != null) wonNames.add(normalizeListName(extraExclude.name));
  if (extraExclude?.userId != null) wonIds.add(extraExclude.userId);
  const pool: MixedPoolEntry[] = [];
  for (const n of list.names) {
    if (!wonNames.has(normalizeListName(n))) pool.push({ kind: "name", name: n });
  }
  if (list.memberIds.length > 0) {
    const memberRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(inArray(users.id, list.memberIds), eq(users.role, "member")));
    for (const m of memberRows) {
      if (!wonIds.has(m.id)) pool.push({ kind: "member", id: m.id, name: m.name, email: m.email });
    }
  }
  return pool;
}

/** 中獎商品行：同 SKU 有就重用（WMS 存貨對到）；冇先起隱藏商品（場次 0／日期=抽獎日）。
 *  respondWin 同 adminConfirmManual 兩邊共用。 */
async function getOrCreatePrizeProduct(
  prize: typeof luckyPrizes.$inferSelect,
  drawDate: string,
): Promise<typeof products.$inferSelect> {
  const db = getDb();
  let [product] = await db.select().from(products).where(eq(products.sku, prize.sku)).limit(1);
  if (!product) {
    const listedAt = new Date(`${fmtDrawDate(drawDate)}T12:00:00+08:00`);
    [product] = await db
      .insert(products)
      .values({
        sku: prize.sku,
        name: prize.name,
        image: prize.imagePath ?? "", // imagePath 選填：冇圖就空字串（products.image 唔准 null）
        photos: prize.imagePath ? [prize.imagePath] : [],
        price: prize.price,
        sizeEnabled: false,
        liveDate: drawDate, // 日期＝抽獎日
        liveSession: "0", // 場次 0＝抽獎（老闆指定）
        category: "other",
        listedDate: listedAt,
        stock: 0,
        isActive: false, // 隱藏：唔會喺商店出現
      })
      .returning();
  }
  return product;
}

/** 中獎即通知：email（有 email 先寄）＋推送（有綁定先送）；never-throw */
function notifyWinner(winner: { id: number; name: string; email: string | null }, prize: typeof luckyPrizes.$inferSelect, drawDate: string) {
  if (winner.email) {
    void sendPrizeWinEmail({
      to: winner.email, name: winner.name, prizeName: prize.name,
      prizePrice: prize.price, prizeImagePath: prize.imagePath ?? "", drawDate,
    });
  }
  void sendPrizeWinPush(winner.id, prize.name);
}

export const luckyDrawRouter = createRouter({
  // ───────────────────────── 後台：獎品池 ─────────────────────────

  adminListPrizes: supervisorProcedure.query(async () => {
    const db = getDb();
    const prizeRows = await db.select().from(luckyPrizes).orderBy(desc(luckyPrizes.id));
    const drawRows = await db
      .select({
        id: luckyDraws.id,
        prizeId: luckyDraws.prizeId,
        status: luckyDraws.status,
        drawDate: luckyDraws.drawDate,
        winnerName: users.name,
      })
      .from(luckyDraws)
      .innerJoin(users, eq(luckyDraws.winnerUserId, users.id))
      .orderBy(desc(luckyDraws.id))
      .limit(2000);
    const byPrize = new Map<number, typeof drawRows>();
    for (const d of drawRows) {
      const arr = byPrize.get(d.prizeId) ?? [];
      arr.push(d);
      byPrize.set(d.prizeId, arr);
    }
    return prizeRows.map((p) => {
      const ds = byPrize.get(p.id) ?? [];
      //  pending/confirmed＝已抽出（食住一件）；declined/cancelled＝件貨返返入池
      // v2.2.55（老闆指令）：獎品有件數 — takenCount 夠 quantity 先算抽晒
      const takenRows = ds.filter((d) => d.status === "pending" || d.status === "confirmed");
      const taken = takenRows[0] ?? null; // rows 已按 id desc，第一個係最近嗰單
      return {
        ...p,
        drawCount: ds.length,
        takenCount: takenRows.length,
        takenBy: taken ? { name: taken.winnerName, status: taken.status, drawDate: taken.drawDate } : null,
      };
    });
  }),

  /** v2.2.53（老闆指令）：場次名一覽——持久化表 ∪ 獎品實際用緊（舊資料雙保險）；
   *  唔包 ""（未分場由前端自己加）。開咗場次未上傳獎品都會喺度。
   *  v2.2.56（老闆指令）：帶埋 archived 旗——管理員手動放入「歷史場次」嘅場次（未抽晒都得） */
  adminListSessions: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ name: luckyDrawSessions.name, archivedAt: luckyDrawSessions.archivedAt })
      .from(luckyDrawSessions)
      .orderBy(luckyDrawSessions.id);
    const archived = new Set(rows.filter((r) => r.archivedAt != null).map((r) => r.name));
    const set = new Set<string>(rows.map((r) => r.name));
    const prizeRows = await db
      .select({ session: luckyPrizes.session })
      .from(luckyPrizes)
      .groupBy(luckyPrizes.session);
    for (const r of prizeRows) if (r.session) set.add(r.session);
    // 淨係掛喺獎品度嘅舊場次（未入持久表）一定係未歸檔
    return [...set].map((name) => ({ name, archived: archived.has(name) }));
  }),

  /** v2.2.56（老闆指令「未抽晒管理員都要可以手動變歷史場次」）：管理員歸檔／取消歸檔場次。
   *  歸檔淨係改分組顯示（獎品照舊抽得、照舊加得）；場次未入持久表（舊資料淨掛獎品度）會先補行 */
  adminSetSessionArchived: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1, "場次名唔准空").max(64),
      archived: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const operator = await actorName(ctx.user.userId);
      await db
        .insert(luckyDrawSessions)
        .values({ name: input.name, createdBy: ctx.user.userId, createdByName: operator })
        .onConflictDoNothing();
      await db
        .update(luckyDrawSessions)
        .set(input.archived
          ? { archivedAt: new Date(), archivedByName: operator }
          : { archivedAt: null, archivedByName: null })
        .where(eq(luckyDrawSessions.name, input.name));
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: input.archived ? "luckyDraw.archiveSession" : "luckyDraw.unarchiveSession",
        targetType: "luckyDrawSession", targetId: input.name,
        detail: input.archived ? `場次《${input.name}》手動放入歷史場次` : `場次《${input.name}》放返未抽場次`,
      });
      return { ok: true as const };
    }),

  /** v2.2.53（老闆指令）：開場次（持久化）——未上傳獎品都留住，第二個同事接力加嘢；
   *  同名唔會炸（onConflictDoNothing），兩個同事前後開同名都安全 */
  adminCreateSession: supervisorProcedure
    .input(z.object({ name: z.string().trim().min(1, "場次名唔准空").max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const operator = await actorName(ctx.user.userId);
      await db
        .insert(luckyDrawSessions)
        .values({ name: input.name, createdBy: ctx.user.userId, createdByName: operator })
        .onConflictDoNothing();
      return { ok: true as const };
    }),

  adminUpsertPrize: supervisorProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        // 獎品名選填：留空 → 按 sku 查 products 用 product.name 頂上；冇 product → 用 sku 做名
        name: z.string().trim().max(255).default(""),
        sku: z.string().trim().min(1, "貨號唔准空").max(64),
        price: z.number().int().min(0, "價錢唔准負數"),
        // 獎品圖選填：留空 → 按 sku 用 product.image（冇就 null）
        imagePath: z.string().trim().max(512).default(""),
        // 獎品分場次（""＝未分場）
        session: z.string().trim().max(64).default(""),
        // v2.2.55（老闆指令）：同款獎品件數 — N 件可以抽 N 次（預設 1 件，同舊行為一致）
        quantity: z.number().int().min(1, "件數最少 1").max(999).default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 名／圖兜底：淨係有留空先查 products（按 sku）
      let name = input.name;
      let imagePath: string | null = input.imagePath || null;
      if (!name || !imagePath) {
        const [product] = await db
          .select({ name: products.name, image: products.image })
          .from(products)
          .where(eq(products.sku, input.sku))
          .limit(1);
        if (!name) name = product?.name || input.sku;
        if (!imagePath) imagePath = product?.image || null;
      }
      // v2.2.53（老闆指令）：場次名持久化——獎品有填場次就確保入表；
      // 之後就算刪晒嗰場獎品，場次都留得住
      if (input.session) {
        await db.insert(luckyDrawSessions).values({ name: input.session }).onConflictDoNothing();
      }
      if (input.id) {
        const [row] = await db
          .update(luckyPrizes)
          .set({ name, sku: input.sku, price: input.price, imagePath, session: input.session, quantity: input.quantity })
          .where(eq(luckyPrizes.id, input.id))
          .returning();
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });
        void logAudit({
          actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.updatePrize",
          targetType: "luckyPrize", targetId: String(input.id),
          detail: `改獎品 #${input.id}：${name}（${input.sku}）`,
        });
        return row;
      }
      const [row] = await db
        .insert(luckyPrizes)
        .values({ name, sku: input.sku, price: input.price, imagePath, session: input.session, quantity: input.quantity })
        .returning();
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.createPrize",
        targetType: "luckyPrize", targetId: String(row.id),
        detail: `新獎品 #${row.id}：${name}（${input.sku}，HK$${input.price}）`,
      });
      return row;
    }),

  /** 刪獎品＝硬刪（老闆指明要真 del）；active=false 嗰個係「下架」，唔係刪除。
   *  有抽獎紀錄參照（FK 23503）就刪唔到——提示先刪晒嗰日嘅紀錄先刪得件獎品 */
  adminDeletePrize: supervisorProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      let row: typeof luckyPrizes.$inferSelect | undefined;
      try {
        [row] = await db.delete(luckyPrizes).where(eq(luckyPrizes.id, input.id)).returning();
      } catch (e) {
        // drizzle DrizzleQueryError 將 PG error 收喺 cause（「Failed query: …」嗰隻）——兩處都睇，穩陣捉 23503
        const pgCode =
          (e as { code?: string })?.code ??
          (e as { cause?: { code?: string } })?.cause?.code;
        if (String(pgCode) === "23503") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "呢件獎品有抽獎紀錄，刪唔到——可以先把嗰日嘅紀錄刪除，獎品就刪得",
          });
        }
        throw e;
      }
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.deletePrize",
        targetType: "luckyPrize", targetId: String(input.id), detail: `刪除獎品：${row.name}（${row.sku}）`,
      });
      return { ok: true };
    }),

  // ───────────────────────── 後台：抽獎 ─────────────────────────

  /** 名單預覽：按剔選來源攞人，踢走今日中過嘅；回 count＋名單（cap 500） */
  adminPreviewParticipants: supervisorProcedure
    .input(participantFilterInput)
    .query(async ({ input }) => {
      const ids = await collectParticipantIds(input);
      const won = await winnersOfDate();
      for (const id of won) ids.delete(id);
      if (ids.size === 0) return { total: 0, rows: [] };
      const db = getDb();
      const idArr = [...ids];
      const rows = await db
        .select({ id: users.id, name: users.name, phone: users.phone })
        .from(users)
        .where(inArray(users.id, idArr))
        .orderBy(users.id)
        .limit(500);
      return { total: idArr.length, rows };
    }),

  /** 抽一件獎品：server 按剔選條件即場攞全池隨機（唔經 client 名單——
   *  預覽顯示 cap 500，但抽獎一定係全池，直播公平性靠呢度把關）＋強制一日一人一件；
   *  v2.2.55：件數制 — pg_advisory_xact_lock 鎖件獎品同事務數已抽件數，雙人同撳都唔會超抽 */
  adminDraw: supervisorProcedure
    .input(
      z.object({
        prizeId: z.number().int().positive(),
        filter: participantFilterInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, input.prizeId)).limit(1);
      if (!prize || !prize.active) {
        throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在或已下架" });
      }

      const ids = await collectParticipantIds(input.filter);
      const won = await winnersOfDate();
      for (const id of won) ids.delete(id);
      const pool = [...ids];
      if (pool.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "名單係空，或者名單入面嘅人今日都中過獎" });
      }
      const winner = await pickWinner(pool);
      if (!winner) throw new TRPCError({ code: "BAD_REQUEST", message: "中獎帳號唔存在" });

      const drawDate = hktToday();
      const operator = await actorName(ctx.user.userId);
      // v2.2.55（老闆指令）：獎品有件數 — 同款 N 件可以抽 N 次。
      // 舊「一獎一單」partial unique index 已 drop（boot-migrate）；防超抽改喺度做：
      // pg_advisory_xact_lock(prizeId) 鎖住件獎品，同事務數 pending+confirmed 夠未 —
      // 兩個人同時撳抽最後一件都唔會穿（第二個會見到 count 已滿）。
      const draw = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${prize.id})`);
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(luckyDraws)
          .where(and(eq(luckyDraws.prizeId, prize.id), inArray(luckyDraws.status, ["pending", "confirmed"])));
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        const [d] = await tx
          .insert(luckyDraws)
          .values({
            prizeId: prize.id,
            winnerUserId: winner.id,
            winnerName: winner.name, // v2.2.48：snapshot（會員改名唔影響紀錄顯示）
            status: "pending",
            drawDate,
            drawnBy: ctx.user.userId,
            drawnByName: operator,
          })
          .returning();
        return d;
      });

      notifyWinner(winner, prize, drawDate);

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.draw",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `抽獎日 ${drawDate}：${prize.name} → ${winner.name}（池 ${pool.length} 人）`,
      });
      return { draw, winner, prize };
    }),

  /** 特別重抽：先驗證新池有人抽得先郁手（唔會刪咗舊嘅先發現冇人抽）；
   *  刪舊＋新抽放同一個 transaction；一日一件用舊紀錄嘅抽獎日計（跨日重抽都唔會穿）；
   *  舊紀錄直接刪除唔留底（v2.2.54 老闆指令「岩岩既抽獎紀錄唔算數」）；
   *  舊中獎人（唔啱嗰個）永遠踢出呢件獎品嘅重抽池 */
  adminRedraw: supervisorProcedure
    .input(
      z.object({
        drawId: z.number().int().positive(),
        // v2.2.48：自訂名單抽獎重抽唔使 filter（用返名單做池）；會員池重抽先要
        filter: participantFilterInput.optional(),
        listId: z.number().int().positive().nullable().optional(),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [old] = await db.select().from(luckyDraws).where(eq(luckyDraws.id, input.drawId)).limit(1);
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "紀錄唔存在" });
      if (old.status === "confirmed") {
        throw new TRPCError({ code: "CONFLICT", message: "客人已確認寄送（訂單已生成）——請先用「取消中獎」" });
      }
      if (old.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢筆紀錄唔係待回應，唔駛重抽" });
      }
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, old.prizeId)).limit(1);
      if (!prize) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });

      // ── v2.2.48：自訂名單抽獎重抽（用返份名單做混合池：手打名＋官網會員）──
      if (old.listId != null) {
        const [list] = await db.select().from(luckyDrawLists).where(eq(luckyDrawLists.id, old.listId)).limit(1);
        if (!list) throw new TRPCError({ code: "BAD_REQUEST", message: "名單已刪除" });
        // 池＝混合池踢走嗰日中過嘅名/id，顯式加埋舊中獎名/id 保險；空就乜都唔郁（舊中獎保留）
        const pool = await collectMixedPool(list, old.drawDate, { name: old.winnerName, userId: old.winnerUserId });
        if (pool.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得（名單空或嗰日全部中過）；舊中獎保留" });
        }
        const entry = pool[randomInt(0, pool.length)];
        const winnerName = entry.name;
        const winnerUserId = entry.kind === "member" ? entry.id : (await getOrCreateShadowUser(entry.name)).id;
        const operator = await actorName(ctx.user.userId);

        const draw = await db.transaction(async (tx) => {
          // v2.2.54（老闆指令「岩岩既抽獎紀錄唔算數」）：舊 pending 紀錄直接刪除，
          // 唔留 cancelled 底——中獎紀錄淨係見到新抽嗰筆；審計線索喺 audit log（#舊 → #新）
          await tx
            .delete(luckyDraws)
            .where(and(eq(luckyDraws.id, old.id), eq(luckyDraws.status, "pending")));
          const [d] = await tx
            .insert(luckyDraws)
            .values({
              prizeId: prize.id, winnerUserId, winnerName, listId: list.id,
              status: "pending", drawDate: old.drawDate, redrawOfId: old.id,
              drawnBy: ctx.user.userId, drawnByName: operator,
            })
            .returning();
          return d;
        });

        // 抽中官網會員：照常通知（彈窗＋email＋推送）；手打名：唔通知，admin 之後撳「確定」起單
        if (entry.kind === "member") notifyWinner(entry, prize, old.drawDate);

        void logAudit({
          actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.redrawManual",
          targetType: "luckyDraw", targetId: String(draw.id),
          detail: `特別重抽（自訂名單《${list.name}》）#${old.id} → #${draw.id}：${prize.name} → ${winnerName}（${entry.kind === "member" ? "官網會員" : "手打名"}，池 ${pool.length} 人）`,
        });
        return {
          draw,
          winner: { id: winnerUserId, name: winnerName, kind: entry.kind === "member" ? ("member" as const) : ("manual" as const) },
          prize,
          cancelledDrawId: old.id,
        };
      }

      // ── 會員池重抽（現有邏輯）：filter 必填 ──
      if (!input.filter) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "會員池重抽要提供剔選條件（filter）" });
      }

      // 先攞池先決定——冇人抽得就乜都唔郁（舊中獎保留）
      const ids = await collectParticipantIds(input.filter);
      const won = await winnersOfDate(old.drawDate);
      won.add(old.winnerUserId);
      for (const id of won) ids.delete(id);
      const pool = [...ids];
      if (pool.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得（名單空或嗰日全部中過）；舊中獎保留" });
      }
      const winner = await pickWinner(pool);
      if (!winner) throw new TRPCError({ code: "BAD_REQUEST", message: "中獎帳號唔存在" });
      const operator = await actorName(ctx.user.userId);

      const draw = await db.transaction(async (tx) => {
        await tx
          .update(luckyDraws)
          .set({ status: "cancelled", cancelledBy: ctx.user.userId, cancelNote: input.note ?? "特別重抽" })
          .where(and(eq(luckyDraws.id, old.id), eq(luckyDraws.status, "pending")));
        const [d] = await tx
          .insert(luckyDraws)
          .values({
            prizeId: prize.id, winnerUserId: winner.id, winnerName: winner.name, status: "pending",
            drawDate: old.drawDate, redrawOfId: old.id,
            drawnBy: ctx.user.userId, drawnByName: operator,
          })
          .returning();
        return d;
      });

      notifyWinner(winner, prize, old.drawDate);

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.redraw",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `特別重抽 #${old.id} → #${draw.id}：${prize.name} → ${winner.name}（池 ${pool.length} 人）`,
      });
      return { draw, winner, prize, cancelledDrawId: old.id };
    }),

  /** 取消中獎（抽完即場取消，或之後紀錄頁取消）：客人唔會再見到中獎彈窗；
   *  老闆指令：取消中獎後官網訂單都要寫返「已取消」——張單仲係 pending_payment/payment_review
   *  就一併 set status='cancelled'；已批／出咗貨嘅極端情況唔郁佢 status（貨已出，WMS 人手跟），
   *  但都照取消中獎紀錄，audit log 一句警告 */
  adminCancelWin: supervisorProcedure
    .input(
      z.object({
        drawId: z.number().int().positive(),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [old] = await db.select().from(luckyDraws).where(eq(luckyDraws.id, input.drawId)).limit(1);
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "紀錄唔存在" });
      if (old.status === "cancelled") throw new TRPCError({ code: "CONFLICT", message: "已經取消咗" });

      let orderCancelled = false;
      let orderUntouchedWarn: string | null = null;
      if (old.orderId) {
        const [ord] = await db
          .select({ id: orders.id, status: orders.status, orderNo: orders.orderNo })
          .from(orders)
          .where(eq(orders.id, old.orderId))
          .limit(1);
        if (ord && ["pending_payment", "payment_review"].includes(ord.status)) {
          // 未批嘅官網訂單：寫返「已取消」（老闆指定動作）
          await db
            .update(orders)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(orders.id, ord.id));
          orderCancelled = true;
        } else if (ord) {
          // 已批／出咗貨：唔郁張單 status，照取消中獎，log 警告（WMS 嗰邊人手跟）
          orderUntouchedWarn = `警告：訂單 ${ord.orderNo} 已經 ${ord.status}，官網張單唔郁得，WMS 要人手跟`;
        }
      }
      await db
        .update(luckyDraws)
        .set({ status: "cancelled", cancelledBy: ctx.user.userId, cancelNote: input.note ?? null })
        .where(eq(luckyDraws.id, old.id));
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.cancelWin",
        targetType: "luckyDraw", targetId: String(old.id),
        detail: `取消中獎 #${old.id}${orderCancelled ? "（官網訂單一併寫返已取消）" : ""}${orderUntouchedWarn ? `（${orderUntouchedWarn}）` : ""}${input.note ? `：${input.note}` : ""}`,
      });
      return { ok: true, orderCancelled };
    }),

  /** 刪除抽獎紀錄（老闆指明：管理員先用到，唔係 supervisor）：硬刪除該場抽獎紀錄，
   *  有生成訂單嘅話官網張單連仔行（orderItems／paymentProofs／wmsSyncLog）一併 HARD DELETE——
   *  老闆原話「你要比我刪除，刪除時官網張單都要一併刪除」；WMS 嗰邊佢哋自己刪，
   *  所以冇「已批/出貨唔准刪」嘅 guard。張單已唔存在（重複刪除）就跳過訂單照刪 draw row。
   *  redrawOfId 冇 FK，刪除後該獎品嘅 takenBy 自然消失，獎品返返嚟抽得——預期行為。
   *  audit detail 淨係單號／獎品名／中獎人，永遠唔落 endpoint/keys/secret/URL。 */
  adminDeleteDraw: adminProcedure
    .input(z.object({ drawId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [old] = await db
        .select({
          draw: luckyDraws,
          winnerUserName: users.name,
          prizeName: luckyPrizes.name,
        })
        .from(luckyDraws)
        .innerJoin(users, eq(luckyDraws.winnerUserId, users.id))
        .innerJoin(luckyPrizes, eq(luckyDraws.prizeId, luckyPrizes.id))
        .where(eq(luckyDraws.id, input.drawId))
        .limit(1);
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "紀錄唔存在" });

      // 先攞單號做 audit（張單可能已經唔存在——重複刪除；咁就跳過訂單刪除，唔報錯）
      let orderNo: string | null = null;
      if (old.draw.orderId != null) {
        const [ord] = await db
          .select({ orderNo: orders.orderNo })
          .from(orders)
          .where(eq(orders.id, old.draw.orderId))
          .limit(1);
        orderNo = ord?.orderNo ?? null;
      }

      let orderDeleted = false;
      const orderId = old.draw.orderId;
      await db.transaction(async (tx) => {
        // 順序（FK 全部指去 orders——luckyDraws.orderId 都係，所以 luckyDraws 一定要喺 orders 之前刪）：
        // luckyDraws 本行 → 訂單仔行（orderItems／paymentProofs／wmsSyncLog）→ orders 本行
        await tx.delete(luckyDraws).where(eq(luckyDraws.id, old.draw.id));
        if (orderId != null && orderNo != null) {
          await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
          await tx.delete(paymentProofs).where(eq(paymentProofs.orderId, orderId));
          await tx.delete(wmsSyncLog).where(eq(wmsSyncLog.orderId, orderId));
          await tx.delete(orders).where(eq(orders.id, orderId));
          orderDeleted = true;
        }
      });

      const winnerLabel = old.draw.winnerName ?? old.winnerUserName;
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.deleteDraw",
        targetType: "luckyDraw", targetId: String(old.draw.id),
        detail: `刪除抽獎紀錄 #${old.draw.id}：抽獎日 ${old.draw.drawDate}，獎品 ${old.prizeName}，中獎人 ${winnerLabel}${orderNo ? `，官網訂單 ${orderNo}（一併刪除）` : ""}`,
      });
      return { ok: true, orderDeleted };
    }),

  /** 成日刪（管理員專用）：一次過刪晒某抽獎日嘅全部紀錄，有單嘅連官網張單一併 HARD DELETE
   *  （luckyDraws → 仔行 orderItems／paymentProofs／wmsSyncLog → orders，同一個 transaction；
   *   luckyDraws.orderId 有 FK 指住 orders，所以 luckyDraws 一定要先刪）。
   *  老闆原話「wms佢地自己會刪除，你要比我刪除」——冇「已批/出貨唔准刪」嘅 guard，
   *  官網呢邊要刪得就一定刪得；WMS 嗰邊嘅單由佢哋自己處理。 */
  adminDeleteDrawsByDate: adminProcedure
    .input(z.object({ drawDate: z.string().regex(/^\d{8}$/) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .select({
          id: luckyDraws.id,
          linkedOrderId: orders.id,
        })
        .from(luckyDraws)
        .leftJoin(orders, eq(luckyDraws.orderId, orders.id))
        .where(eq(luckyDraws.drawDate, input.drawDate));

      // 淨係攞真係存在嘅官網訂單 id（orderId 指咗但張單已唔存在 → leftJoin null，自動跳過）
      const orderIds = [...new Set(rows.map((r) => r.linkedOrderId).filter((id): id is number => id != null))];
      const result = await db.transaction(async (tx) => {
        // luckyDraws 先（orderId FK 指住 orders，唔調轉會 23503）→ 訂單仔行 → orders 本行
        const delDraws = await tx
          .delete(luckyDraws)
          .where(eq(luckyDraws.drawDate, input.drawDate))
          .returning({ id: luckyDraws.id });
        let ordersDeleted = 0;
        if (orderIds.length > 0) {
          await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
          await tx.delete(paymentProofs).where(inArray(paymentProofs.orderId, orderIds));
          await tx.delete(wmsSyncLog).where(inArray(wmsSyncLog.orderId, orderIds));
          const delOrders = await tx.delete(orders).where(inArray(orders.id, orderIds)).returning({ id: orders.id });
          ordersDeleted = delOrders.length;
        }
        return { ordersDeleted, drawsDeleted: delDraws.length };
      });

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.deleteDrawsByDate",
        targetType: "luckyDraw", targetId: input.drawDate,
        detail: `成日刪抽獎紀錄：抽獎日 ${input.drawDate}，刪咗 ${result.drawsDeleted} 筆，官網訂單一併刪咗 ${result.ordersDeleted} 張（WMS 嗰邊由佢哋自己處理）`,
      });
      return { ok: true as const, deleted: result.drawsDeleted, ordersDeleted: result.ordersDeleted };
    }),

  // ───────────────────────── 後台：自訂名單（v2.2.48）─────────────────────────

  /** 全部自訂名單（新→舊）：id／名／手打名＋會員 id／會員 {id,name}（已刪會員唔出現）／建立者／時間 */
  adminListLists: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: luckyDrawLists.id,
        name: luckyDrawLists.name,
        names: luckyDrawLists.names,
        memberIds: luckyDrawLists.memberIds,
        createdByName: luckyDrawLists.createdByName,
        createdAt: luckyDrawLists.createdAt,
      })
      .from(luckyDrawLists)
      .orderBy(desc(luckyDrawLists.id));
    // 一次過 collect 晒所有 memberIds 查 users（已刪會員唔會喺 map 出現）
    const allIds = [...new Set(rows.flatMap((r) => r.memberIds))];
    const memberRows = allIds.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, allIds))
      : [];
    const memberById = new Map(memberRows.map((m) => [m.id, m]));
    return rows.map((r) => ({
      ...r,
      count: r.names.length,
      members: r.memberIds
        .map((id) => memberById.get(id))
        .filter((m): m is { id: number; name: string } => m != null),
    }));
  }),

  /** 開名單：逐個＋批量輸入客人名＋揀官網會員；server 再 trim、drop 空、去重
   *  （去重用 trim＋toLowerCase 做 key，但保留第一個出現嘅原串）；
   *  memberIds 淨留真正存在嘅官網會員（唔存在/唔係 member 嘅 id 靜靜哋踢走） */
  adminCreateList: supervisorProcedure
    .input(
      z
        .object({
          name: z.string().trim().min(1, "名單名唔准空").max(64),
          names: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
          memberIds: z.array(z.number().int().positive()).max(500).default([]),
        })
        .refine((v) => v.names.length > 0 || v.memberIds.length > 0, {
          message: "名單起碼一個名或一位官網會員",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const seen = new Set<string>();
      const names: string[] = [];
      for (const raw of input.names) {
        const n = raw.trim();
        if (!n) continue;
        const key = normalizeListName(n);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(n);
      }
      // 會員 id 過濾：淨留真會員（role='member'；唔存在嘅 id 踢走）
      const wantIds = [...new Set(input.memberIds)];
      let memberIds: number[] = [];
      if (wantIds.length > 0) {
        const memberRows = await db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, wantIds), eq(users.role, "member")));
        memberIds = memberRows.map((r) => r.id);
      }
      // refine 擋咗 input 全空；呢度再擋「手打名 trim 晒變空＋memberIds 全部唔係真會員」
      if (names.length === 0 && memberIds.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "名單起碼一個名或一位官網會員" });
      }
      const operator = await actorName(ctx.user.userId);
      const [list] = await db
        .insert(luckyDrawLists)
        .values({ name: input.name, names, memberIds, createdBy: ctx.user.userId, createdByName: operator })
        .returning();
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.createList",
        targetType: "luckyDrawList", targetId: String(list.id),
        detail: `開自訂名單《${list.name}》（手打 ${names.length} 人＋會員 ${memberIds.length} 人）`,
      });
      return list;
    }),

  /** 刪名單：抽出嚟嘅中獎紀錄 listId 會 ON DELETE SET NULL（紀錄留底） */
  adminDeleteList: supervisorProcedure
    .input(z.object({ listId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db.delete(luckyDrawLists).where(eq(luckyDrawLists.id, input.listId)).returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "名單唔存在" });
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.deleteList",
        targetType: "luckyDrawList", targetId: String(input.listId),
        detail: `刪自訂名單《${row.name}》（${row.names.length} 人）`,
      });
      return { ok: true };
    }),

  /** 自訂名單抽獎：混合池（手打名＋官網會員）；
   *  抽中會員 → 照常彈窗＋email＋推送，由佢自己揀地址寄送（respondWin 現有流程）；
   *  抽中手打名 → 影子帳號，唔彈窗唔通知——admin 睇結果撳「確定」先起單 */
  adminDrawManual: supervisorProcedure
    .input(
      z.object({
        prizeId: z.number().int().positive(),
        listId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, input.prizeId)).limit(1);
      if (!prize || !prize.active) {
        throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在或已下架" });
      }
      const [list] = await db.select().from(luckyDrawLists).where(eq(luckyDrawLists.id, input.listId)).limit(1);
      if (!list) throw new TRPCError({ code: "NOT_FOUND", message: "名單唔存在" });

      // 混合池：手打名踢今日中過嘅名（normalize 比）；會員踢今日中過嘅 id（一日一個一次）
      const pool = await collectMixedPool(list);
      if (pool.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "名單係空，或者名單入面嘅人今日都中過獎" });
      }
      const entry = pool[randomInt(0, pool.length)];
      const winnerName = entry.name;
      // 手打名先起/重用影子帳號；會員直接用真 user id
      const winnerUserId = entry.kind === "member" ? entry.id : (await getOrCreateShadowUser(entry.name)).id;

      const drawDate = hktToday();
      const operator = await actorName(ctx.user.userId);
      // v2.2.55（老闆指令）：獎品有件數 — 防超抽邏輯同 adminDraw 一樣（advisory lock 鎖件獎品再數）
      const draw = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${prize.id})`);
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(luckyDraws)
          .where(and(eq(luckyDraws.prizeId, prize.id), inArray(luckyDraws.status, ["pending", "confirmed"])));
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        const [d] = await tx
          .insert(luckyDraws)
          .values({
            prizeId: prize.id,
            winnerUserId,
            winnerName,
            listId: list.id,
            status: "pending",
            drawDate,
            drawnBy: ctx.user.userId,
            drawnByName: operator,
          })
          .returning();
        return d;
      });

      // 抽中官網會員：照常通知（彈窗靠 myPendingWin 自動生效）；手打名：唔通知
      if (entry.kind === "member") notifyWinner(entry, prize, drawDate);

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.drawManual",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `抽獎日 ${drawDate}：${prize.name} → ${winnerName}（自訂名單《${list.name}》，${entry.kind === "member" ? "官網會員" : "手打名"}，池 ${pool.length} 人）`,
      });
      return {
        draw,
        winner: { id: winnerUserId, name: winnerName, kind: entry.kind === "member" ? ("member" as const) : ("manual" as const) },
        prize,
      };
    }),

  /** 自訂名單中獎「確定」：即刻起 0 元單飛 WMS 審批（唔經客人彈窗）；
   *  起單寫法同 respondWin 一致；失敗會 rollback claim 返 pending */
  adminConfirmManual: supervisorProcedure
    .input(z.object({ drawId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [draw] = await db.select().from(luckyDraws).where(eq(luckyDraws.id, input.drawId)).limit(1);
      if (!draw) throw new TRPCError({ code: "NOT_FOUND", message: "中獎紀錄唔存在" });
      if (draw.winnerName == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "呢個唔係自訂名單中獎——會員中獎要等客人自己確認寄送" });
      }
      if (draw.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });
      }
      // 兜底守衛：名單抽獎都可以抽中官網會員——會員中獎要由佢自己喺網站確認寄送
      // （前端會收埋確定掣；影子帳號 phone 一定係 "DRAW#" 開頭）
      const [winnerUser] = await db
        .select({ phone: users.phone })
        .from(users)
        .where(eq(users.id, draw.winnerUserId))
        .limit(1);
      if (winnerUser && !winnerUser.phone.startsWith("DRAW#")) {
        throw new TRPCError({ code: "CONFLICT", message: "呢個中獎人係官網會員，等佢自己喺網站確認寄送" });
      }
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, draw.prizeId)).limit(1);
      if (!prize) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });

      // 商品行：同 SKU 有就重用，冇先起隱藏商品（同 respondWin 共用 helper）
      const product = await getOrCreatePrizeProduct(prize, draw.drawDate);

      // 用 update...where status='pending' 搶先認領，防 admin 雙擊出兩張單
      const claim = await db
        .update(luckyDraws)
        .set({ status: "confirmed", respondedAt: new Date() })
        .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending")))
        .returning({ id: luckyDraws.id });
      if (claim.length === 0) throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });

      const orderNo = await genOrderNo();
      const remark = `官網訂單・包郵・直播抽獎中獎商品（${prize.name}，抽獎日 ${fmtDrawDate(draw.drawDate)}）`;
      let order: typeof orders.$inferSelect;
      try {
        // 起單＋行項目＋綁 orderId 三句入同一個 transaction：任何一步失敗全部 rollback，
        // 唔會留低冇 item 嘅孤兒 0 元單（同 respondWin 一樣）
        order = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(orders)
            .values({
              orderNo,
              userId: draw.winnerUserId, // 影子帳號（orders.userId 唔可以 null）
              status: "payment_review", // 飛 WMS 等審批，同客人買嘢一樣流程
              total: 0,
              discountAmount: 0,
              address: null,
              note: "直播抽獎中獎・包郵",
              deliveryMethod: "address",
              pickupPoint: null,
              stationId: null,
              stationName: null,
              paymentChannel: "manual",
              region: "HK",
              shippingFree: true, // 中獎包郵
              vipDiscountCents: 0,
              remark,
              createdAt: draw.createdAt, // 訂單日期＝抽獎日（老闆指定）
              updatedAt: new Date(),
            })
            .returning();
          await tx.insert(orderItems).values({
            orderId: inserted.id,
            productId: product.id,
            productName: prize.name,
            sku: prize.sku,
            size: null,
            price: 0, // 中獎商品入 0 元（老闆指定）
            quantity: 1,
          });
          await tx.update(luckyDraws).set({ orderId: inserted.id }).where(eq(luckyDraws.id, draw.id));
          return inserted;
        });
      } catch (e) {
        // 起單中途失敗 → 回復 pending，等 admin 可以再撳一次（唔會卡住冇單又認領咗）
        // 只覆核 status='confirmed' 先郁手：若期間已取消中獎，唔會將 cancelled 復活做 pending
        await db
          .update(luckyDraws)
          .set({ status: "pending", respondedAt: null })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "confirmed")))
          .catch(() => undefined);
        throw e;
      }

      // 背景飛 WMS（唔阻回應；失敗淨係寫 wmsSyncLog，後台可重試）
      void forwardOrderToWms(order.id).catch(() => undefined);

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.confirmManual",
        targetType: "order", targetId: order.orderNo,
        detail: `自訂名單中獎確定：${prize.name} → ${draw.winnerName} → 訂單 ${order.orderNo}（0 元包郵）`,
      });
      return { ok: true as const, orderId: order.id, orderNo: order.orderNo };
    }),

  /** 中獎紀錄：按抽獎日分組（新→舊），撳某日展開睇邊個中咗咩 */
  adminHistory: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: luckyDraws.id,
        status: luckyDraws.status,
        drawDate: luckyDraws.drawDate,
        createdAt: luckyDraws.createdAt,
        redrawOfId: luckyDraws.redrawOfId,
        cancelNote: luckyDraws.cancelNote,
        drawnByName: luckyDraws.drawnByName,
        orderId: luckyDraws.orderId,
        // v2.2.48：中獎名快照（自訂名單中獎＝名單原串；前端 prefer snapshot）＋邊份名單
        winnerNameSnap: luckyDraws.winnerName,
        listId: luckyDraws.listId,
        winnerName: users.name,
        winnerPhone: users.phone,
        // v2.2.48：已確認綠燈用衍生顯示——leftJoin orders 攞狀態/單號，唔改 luckyDraws.status 語義
        orderStatus: orders.status,
        orderNo: orders.orderNo,
        prizeId: luckyPrizes.id,
        prizeName: luckyPrizes.name,
        prizeSku: luckyPrizes.sku,
        prizePrice: luckyPrizes.price,
        prizeImagePath: luckyPrizes.imagePath,
      })
      .from(luckyDraws)
      .innerJoin(luckyPrizes, eq(luckyDraws.prizeId, luckyPrizes.id))
      .innerJoin(users, eq(luckyDraws.winnerUserId, users.id))
      .leftJoin(orders, eq(luckyDraws.orderId, orders.id))
      .orderBy(desc(luckyDraws.id))
      .limit(1000);
    const days = new Map<string, { date: string; rows: typeof rows }>();
    for (const r of rows) {
      const d = days.get(r.drawDate) ?? { date: r.drawDate, rows: [] as typeof rows };
      d.rows.push(r);
      days.set(r.drawDate, d);
    }
    return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }),

  // ───────────────────────── 客人：中獎彈窗 ─────────────────────────

  /** 全域彈窗用：最新一筆 pending 中獎（冇就 null） */
  myPendingWin: authedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        drawId: luckyDraws.id,
        drawDate: luckyDraws.drawDate,
        createdAt: luckyDraws.createdAt,
        prizeName: luckyPrizes.name,
        prizeSku: luckyPrizes.sku,
        prizePrice: luckyPrizes.price,
        prizeImagePath: luckyPrizes.imagePath,
      })
      .from(luckyDraws)
      .innerJoin(luckyPrizes, eq(luckyDraws.prizeId, luckyPrizes.id))
      .where(and(eq(luckyDraws.winnerUserId, ctx.user.userId), eq(luckyDraws.status, "pending")))
      .orderBy(desc(luckyDraws.id))
      .limit(1);
    return rows[0] ?? null;
  }),

  /** 回應中獎：decline＝唔要（獎品返池）；ship＝揀地址出 0 元訂單飛 WMS */
  respondWin: authedProcedure
    .input(
      z.object({
        drawId: z.number().int().positive(),
        action: z.enum(["ship", "decline"]),
        /** ship 用：'preset'＝用會員預設順豐站／地址；'station'＝揀新站點（stationId 必填） */
        choice: z.enum(["preset", "station"]).optional(),
        stationId: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [draw] = await db
        .select()
        .from(luckyDraws)
        .where(and(eq(luckyDraws.id, input.drawId), eq(luckyDraws.winnerUserId, ctx.user.userId)))
        .limit(1);
      if (!draw) throw new TRPCError({ code: "NOT_FOUND", message: "中獎紀錄唔存在" });
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, draw.prizeId)).limit(1);
      if (!prize) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });

      if (input.action === "decline") {
        const claimed = await db
          .update(luckyDraws)
          .set({ status: "declined", respondedAt: new Date() })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending")))
          .returning({ id: luckyDraws.id });
        if (claimed.length === 0) throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });
        void logAudit({
          actorId: ctx.user.userId, actorRole: "member", action: "luckyDraw.decline",
          targetType: "luckyDraw", targetId: String(draw.id), detail: `客人唔要：${prize.name}`,
        });
        return { ok: true as const, declined: true as const };
      }

      // ── ship：揀地址 ──
      const [me] = await db.select().from(users).where(eq(users.id, ctx.user.userId)).limit(1);
      if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });

      let deliveryMethod = "address";
      let address: string | null = null;
      let pickupPoint: string | null = null;
      let stationId: string | null = null;
      let stationName: string | null = null;

      let region = "HK";
      if (input.action === "ship" && !input.choice) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "請揀取貨方式" });
      }
      if (input.choice === "station") {
        if (!input.stationId) throw new TRPCError({ code: "BAD_REQUEST", message: "請揀順豐站點" });
        const [st] = await db.select().from(sfStations).where(eq(sfStations.id, input.stationId)).limit(1);
        if (!st || !st.active) throw new TRPCError({ code: "BAD_REQUEST", message: "站點唔存在或已停用" });
        deliveryMethod = st.type === "SF_LOCKER" ? "sf_locker" : "sf_station";
        stationId = st.id;
        stationName = st.name;
        pickupPoint = st.name;
        region = st.region === "MO" ? "MO" : "HK"; // 澳門站唔可以落 HK 單
      } else {
        // preset：用會員預設（同結帳自動帶入一樣）
        deliveryMethod = me.deliveryMethod ?? "address";
        if (deliveryMethod === "sf_station" || deliveryMethod === "sf_locker") {
          if (!me.pickupPoint?.trim()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "你未有預設站點，請揀返個站" });
          }
          pickupPoint = me.pickupPoint.trim();
        } else {
          if (!me.address?.trim()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "你未有預設地址，請揀順豐站點" });
          }
          deliveryMethod = "address";
          address = me.address.trim();
        }
      }

      // ── 商品行：同 SKU 有就重用（WMS 存貨對到）；冇先起隱藏商品 ──
      const product = await getOrCreatePrizeProduct(prize, draw.drawDate);

      // ── 0 元訂單（場次 0／日期=抽獎日／備註官網訂單・包郵・中獎商品）──
      // 用 update...where status='pending' 搶先認領，防客人雙擊出兩張單
      const claim = await db
        .update(luckyDraws)
        .set({ status: "confirmed", respondedAt: new Date() })
        .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending")))
        .returning({ id: luckyDraws.id });
      if (claim.length === 0) throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });

      const orderNo = await genOrderNo();
      const remark = `官網訂單・包郵・直播抽獎中獎商品（${prize.name}，抽獎日 ${fmtDrawDate(draw.drawDate)}）`;
      let order: typeof orders.$inferSelect;
      try {
        // 起單＋行項目＋綁 orderId 三句入同一個 transaction：任何一步失敗全部 rollback，
        // 唔會留低冇 item 嘅孤兒 0 元單
        order = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(orders)
            .values({
              orderNo,
              userId: me.id,
              status: "payment_review", // 飛 WMS 等審批，同客人買嘢一樣流程
              total: 0,
              discountAmount: 0,
              address,
              note: "直播抽獎中獎・包郵",
              deliveryMethod,
              pickupPoint,
              stationId,
              stationName,
              paymentChannel: "manual",
              region, // v2.2.48 修 bug：澳門站要帶 "MO"（之前寫死 "HK"）
              shippingFree: true, // 中獎包郵
              vipDiscountCents: 0,
              remark,
              createdAt: draw.createdAt, // 訂單日期＝抽獎日（老闆指定）
              updatedAt: new Date(),
            })
            .returning();
          await tx.insert(orderItems).values({
            orderId: inserted.id,
            productId: product.id,
            productName: prize.name,
            sku: prize.sku,
            size: null,
            price: 0, // 中獎商品入 0 元（老闆指定）
            quantity: 1,
          });
          await tx.update(luckyDraws).set({ orderId: inserted.id }).where(eq(luckyDraws.id, draw.id));
          return inserted;
        });
      } catch (e) {
        // 起單中途失敗 → 回復 pending，等客人可以再揀一次（唔會卡住冇單又認領咗）
        // 只覆核 status='confirmed' 先郁手：若 admin 期間已取消中獎，唔會將 cancelled 復活做 pending
        await db
          .update(luckyDraws)
          .set({ status: "pending", respondedAt: null })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "confirmed")))
          .catch(() => undefined);
        throw e;
      }

      // 背景飛 WMS（唔阻回應；失敗淨係寫 wmsSyncLog，後台可重試）
      void forwardOrderToWms(order.id).catch(() => undefined);

      void logAudit({
        actorId: ctx.user.userId, actorRole: "member", action: "luckyDraw.claimShip",
        targetType: "order", targetId: order.orderNo,
        detail: `中獎確認寄送：${prize.name} → 訂單 ${order.orderNo}（0 元包郵）`,
      });
      return { ok: true as const, declined: false as const, orderId: order.id, orderNo: order.orderNo };
    }),
});
