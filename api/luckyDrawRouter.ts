/**
 * v2.2.46 直播抽獎大輪盤（老闆 2026-10-03 指令，加註：即時取消／紀錄頁取消／煙花小精靈）
 * --------------------------------
 * 後台（supervisorProcedure＝主管＋管理員先用到，導覽列都係佢哋先睇到）：
 *   adminListPrizes／adminUpsertPrize（名／圖選填，按 sku 兜底）／adminDeletePrize（硬刪；有紀錄擋住）——獎品池（名／貨號／價錢／上傳圖／場次）
 *   adminPreviewParticipants——抽獎名單剔選來源（可複選）：
 *     本月消費／累積消費／消費滿$X／官網會員／買過指定產品／已綁定推送客人
 *   adminDraw——抽一件獎品：server 隨機揀中獎人（crypto randomInt），
 *     強制「當日一人最多中一件」（pending／confirmed 先鎖住；重抽/取消/客人唔要＝無接受，放返出嚟可以再抽）；
 *     v2.2.57（老闆指令）：抽中唔再即時通知——紀錄先落 pending（霸住件獎品），
 *     管理員/主管喺結果卡撳「✓ 好，繼續」經 adminNotifyWin 先正式寄 email＋推送；重抽/取消唔會發。
 *     v2.2.55（老闆指令）：獎品有件數——同款 N 件可以抽 N 次；
 *     防超抽由舊 unique index 改做 pg_advisory_xact_lock＋同事務數件（adminDrawManual 一樣）
 *   adminRedraw——特別重抽：舊紀錄直接刪除（老闆指令「岩岩既抽獎紀錄唔算數」，
 *     中獎紀錄唔會留底），同一件獎品再抽，舊中獎人照舊踢出呢件獎品嘅重抽池
 *   adminCancelWin——即時取消／之後喺紀錄頁取消：客人唔會再見到中獎彈窗；
 *     已生成訂單會一併取消（WMS 嗰邊要人手拒絕，README 有寫）
 *   adminNotifyWin（v2.2.57）——正式發送中獎通知（email＋推送）：結果卡「好，繼續」／
 *     紀錄頁「補發通知」用呢個；notifiedAt 原子認領，重複撳唔會重複發
 *   adminHistory——中獎紀錄按抽獎日分組（新→舊；v2.2.57 帶埋 notifiedAt 顯示未通知；
 *     v2.5.6 帶埋 eventId／eventName／eventEntryId 追溯劵活動）
 *
 * v2.5.6（老闆指令：名單每日限中 N 次＋抽獎劵活動＋Excel 匯入）：
 *   名單模式——luckyDrawLists.maxWinsPerPerson（1–100，預設 1）：「每人每個香港抽獎日限中 N 次」，
 *     winnerNameCountsOfDate／winnerIdCountsOfDate 用 count >= N 踢人；N=1 ≡ 舊 Set 全日全域 guard，
 *     adminDrawManual／名單重抽都行呢度，唔會靜默放寬舊行為。member pool adminDraw 維持一日一次。
 *   劵活動——adminCreateEvent／adminListEvents／adminSetEventArchived（歸檔/取消歸檔都喺 transaction 內
 *     攞 EVENT_LOCK_NS event 雙 key 鎖＋鎖內重讀，同抽獎/匯入互斥）／adminListEventEntries（睇每人劵數＋已中次數）／
 *     adminDeleteEventEntry（有紀錄 FK 擋）；adminDrawEvent 每張劵等權（ticketCount 加權，
 *     randomInt(0,totalTickets)＋累計權重，唔展開巨型 array）；全活動累計限中（pending+confirmed），
 *     transaction 內先 prize lock 後 event lock（EVENT_LOCK_NS 雙 key），重數件數＋重數限中，
 *     並發改變 → 可見 CONFLICT；adminRedraw 支援 eventId 分支（舊中獎人永遠踢出重抽池）。
 *   Excel——adminDownloadTemplate（真 .xlsx base64，header only）／adminImportExcel
 *     （preview 預設零 DB 寫；commit 有逐行錯誤全部唔寫；list 開新名單、ticket 寫入未歸檔活動，
 *     duplicatePolicy=skip|merge；2MB／500 行／PK magic／只支援本系統範本格式）。
 *
 * 客人（authedProcedure）：
 *   myPendingWin——全域彈窗用：最新一筆 pending 中獎（＋獎品資料）
 *   respondWin——「多謝，請寄送」（preset 用會員預設順豐站／地址；station 揀新站點）
 *     → 生成 0 元訂單（場次 0／日期=抽獎日／備註官網訂單・包郵・中獎商品）→ 背景飛 WMS 等審批
 *     「唔要」→ declined，件獎品返返入池
 *
 * 交易安全 hardening（抽獎 router）：
 *   鎖次序全檔統一——prize 單 key advisory lock → 第二道鎖（event 雙 key EVENT_LOCK_NS 或
 *   香港抽獎日全域雙 key DRAW_DATE_LOCK_NS，每日限中係全日全域規矩，唔准用 per-list 鎖冒充）。
 *   event redraw／名單 redraw：鎖後重新檢查舊紀錄狀態（delete affected 必須啱啱 1，否則 CONFLICT
 *   唔插新 winner）、刪舊後先數獎品件數（避免假爆滿）、鎖內重數新中獎人限中。
 *   adminDraw／adminDrawManual：prize→日期鎖內重數件數＋當日已中次數（唔只靠 transaction 外 pre-check）。
 *   Excel commit：list 最終 names 空 → 拒絕；ticket 喺 event 鎖內重讀 entries 先寫，
 *   每人 ≤10000／全活動 ≤10,000,000（並發 merge＋跨批累加都計），unique 撞 → CONFLICT。
 *   adminSetEventArchived：歸檔／取消歸檔都喺 event 雙 key 鎖內重讀後 update（同抽獎/匯入互鎖）。
 *
 * 保安鐵律：endpoint/keys/secret 永遠唔落 log；呢度冇接觸訂閱敏感欄位。
 */

import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, like, lt, sql } from "drizzle-orm";
import { createRouter, authedProcedure, supervisorProcedure, adminProcedure } from "./middleware";
import { getDb } from "./queries/connection";
import {
  luckyDrawEventEntries,
  luckyDrawEvents,
  luckyDrawExclusions,
  luckyDrawLists,
  luckyDraws,
  luckyDrawSessions,
  luckyPrizes,
  orderItems,
  orderShipments,
  orders,
  paymentProofs,
  products,
  pushSubscriptions,
  sfStations,
  users,
  wmsSyncLog,
} from "@db/schema";
import {
  filterEligibleEntries,
  normalizeListName,
  pickWeightedEntry,
  underWinLimit,
} from "./luckyDrawCore";
import {
  IMPORT_MAX_BYTES,
  MAX_TICKETS_PER_PERSON,
  MAX_TOTAL_TICKETS,
  buildTemplateXlsx,
  hasPkMagic,
  parseXlsxRows,
  planImport,
  validateImportRows,
  type ExistingEntry,
} from "./luckyDrawXlsx";
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
        // 訪客單 userId 係 null——抽獎淨係計會員，null 直接跳過
        for (const r of rows) { if (r.userId != null) out.add(r.userId); }
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
          if (r.userId == null) {
            // 訪客單唔計入抽獎
          } else if (f.cumulative) {
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
        for (const r of rows) { if (r.userId != null) out.add(r.userId); } // 訪客單跳過
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
          if (r.userId != null && Number(r.total) >= minSpend) out.add(r.userId); // 訪客單跳過
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
  // v2.5.5 第12版（老闆指令「抽獎名單想剔除某啲人」）：後台剔除咗嘅個別人選永遠唔入池，
  // 預覽／抽獎／特別重抽都行呢度，一處隔離全網生效（恢復即返返嚟）
  const excluded = await db.select({ userId: luckyDrawExclusions.userId }).from(luckyDrawExclusions);
  for (const e of excluded) out.delete(e.userId);
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

/** v2.5.6（劵模式）：活動 advisory lock namespace（pg_advisory_xact_lock 雙 key 版，
 *  同單 key 嘅 prize lock 係兩個獨立 key space，唔會互撞）。
 *  鎖次序全檔統一：先 prize（單 key）→ 後 event（雙 key），避免交叉死鎖。 */
const EVENT_LOCK_NS = 845120;

/** 香港抽獎日全域鎖 namespace（pg_advisory_xact_lock 雙 key；第二 key＝YYYYMMDD 整數，int4 放得晒）。
 *  「每人每個香港抽獎日限中 N 次」係全日全域規矩（唔分邊份名單／邊個模式），所以鎖都一定要係
 *  全域日期鎖——唔准用 per-list 鎖冒充（唔同名單並發會繞過彼此）。 */
const DRAW_DATE_LOCK_NS = 845121;

/** transaction callback 收到嘅 tx 型別（同 db 同接口，推斷自 getDb） */
type DrawTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** drizzle DrizzleQueryError 將 PG error 收喺 cause（「Failed query: …」嗰隻）——兩處都睇，穩陣攞 SQLSTATE */
function pgErrorCode(e: unknown): string {
  return String((e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? "");
}

/** lucky draw insert transaction 嘅 FK 23503（獎品／中獎會員／劵俾人並發刪咗）→ 可見 CONFLICT，唔好 raw 500。
 *  只包住抽獎寫入 transaction，唔擴大到其他 router。 */
async function drawTxWithFkGuard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (pgErrorCode(e) === "23503") {
      throw new TRPCError({ code: "CONFLICT", message: "關聯資料啱啱俾人改咗（並發），請刷新再試" });
    }
    throw e;
  }
}

/** 鎖次序全檔統一：第一道永遠係 prize 單 key advisory lock（同 adminDraw/adminDrawManual 互鎖） */
async function lockPrizeTx(tx: DrawTx, prizeId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${prizeId})`);
}

/** 第二道鎖（劵活動路徑）：event 雙 key lock——永遠喺 prize lock 之後 */
async function lockEventTx(tx: DrawTx, eventId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_LOCK_NS}, ${eventId})`);
}

/** 第二道鎖（名單／會員池路徑）：香港抽獎日全域雙 key lock——永遠喺 prize lock 之後。
 *  跨日重抽用舊紀錄嘅抽獎日計，鎖都鎖嗰日（同重數口径一致）。 */
async function lockDrawDateTx(tx: DrawTx, drawDate: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${DRAW_DATE_LOCK_NS}, ${Number(drawDate)})`);
}

/** 鎖內數件：該獎品 pending+confirmed 數（redraw 要先刪舊 pending 先數，先唔會假爆滿） */
async function prizeTakenTx(tx: DrawTx, prizeId: number): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.prizeId, prizeId), inArray(luckyDraws.status, ["pending", "confirmed"])));
  return Number(n);
}

/** 鎖內重數：某張劵全活動已中次數（只計 pending/confirmed；eventEntryId 全域唯一，唔使再限 eventId） */
async function entryWinCountTx(tx: DrawTx, entryId: number): Promise<number> {
  const [{ c }] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.eventEntryId, entryId), inArray(luckyDraws.status, ["pending", "confirmed"])));
  return Number(c);
}

/** 鎖內重數：某會員嗰個香港抽獎日已中次數（只計 pending/confirmed；全日全域） */
async function memberWinCountTx(tx: DrawTx, drawDate: string, userId: number): Promise<number> {
  const [{ c }] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(luckyDraws)
    .where(
      and(
        eq(luckyDraws.drawDate, drawDate),
        eq(luckyDraws.winnerUserId, userId),
        inArray(luckyDraws.status, ["pending", "confirmed"]),
      ),
    );
  return Number(c);
}

/** 鎖內重數：某手打名（normalized）嗰個香港抽獎日已中次數（只計 pending/confirmed；全日全域；
 *  normalize 口径同 winnerNameCountsOfDate 一致——SQL 做 lower(trim())，JS 唔再逐行砌） */
async function nameWinCountTx(tx: DrawTx, drawDate: string, normalizedName: string): Promise<number> {
  const [{ c }] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(luckyDraws)
    .where(
      and(
        eq(luckyDraws.drawDate, drawDate),
        inArray(luckyDraws.status, ["pending", "confirmed"]),
        sql`lower(trim(${luckyDraws.winnerName})) = ${normalizedName}`,
      ),
    );
  return Number(c);
}

/** v2.5.6（劵模式）：活動內每個 entry 已中次數（全活動累計；pending／confirmed 先計，
 *  cancelled／declined 唔計——同現行一日規則口径一致）。抽獎前篩池用；
 *  鎖內重檢單個 entry 係直接 count query（見 adminDrawEvent transaction 入面） */
async function eventWinCounts(eventId: number): Promise<Map<number, number>> {
  const db = getDb();
  const rows = await db
    .select({ eventEntryId: luckyDraws.eventEntryId, n: sql<number>`count(*)::int` })
    .from(luckyDraws)
    .where(
      and(
        eq(luckyDraws.eventId, eventId),
        inArray(luckyDraws.status, ["pending", "confirmed"]),
      ),
    )
    .groupBy(luckyDraws.eventEntryId);
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.eventEntryId != null) out.set(r.eventEntryId, Number(r.n));
  }
  return out;
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

/** 影子帳號 phone key（users.phone varchar(32) unique——上限 32 個字元，呢度用 Unicode code points 計）。
 *  向後相容：完整 key 唔超 32 個 code points → 原樣 `DRAW#名`（同舊 `.slice(0,32)` 對短名結果一致，舊資料照重用）。
 *  完整 key 超長先改用「安全 prefix（按 code point 切，唔會切斷 surrogate pair）＋#＋sha256(全名) 後綴」：
 *  同名一定砌出同一 key（createHash 穩定、冇秘密/隨機 salt）；唔同長名唔會再因共同 prefix 碰撞
 *  （12 hex chars hash 碰撞只係理論風險，DB unique index 做最後防線）。 */
const SHADOW_PHONE_MAX = 32;
const SHADOW_HASH_LEN = 12;
function shadowPhoneKey(name: string): string {
  const full = `DRAW#${name}`;
  if ([...full].length <= SHADOW_PHONE_MAX) return full;
  const hash = createHash("sha256").update(full, "utf8").digest("hex").slice(0, SHADOW_HASH_LEN);
  const prefix = [...full].slice(0, SHADOW_PHONE_MAX - 1 - SHADOW_HASH_LEN).join("");
  return `${prefix}#${hash}`;
}

/** 自訂名單中獎人嘅影子帳號（唔係官網會員都要起 0 元單飛 WMS；orders.userId 唔可以 null）。
 *  phone 用 shadowPhoneKey（向後相容短名原樣、長名 prefix＋穩定 hash）；同名重用；永遠登入唔到（passwordHash "!"）。 */
async function getOrCreateShadowUser(name: string): Promise<{ id: number; name: string }> {
  const phone = shadowPhoneKey(name);
  const db = getDb();
  const [hit] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phone, phone)).limit(1);
  if (hit) return hit;
  try {
    const [u] = await db.insert(users).values({ name: name.slice(0, 255), phone, passwordHash: "!" }).returning({ id: users.id, name: users.name });
    return u;
  } catch (e) {
    // 23505 unique 撞（並发起同名影子帳號）→ 重讀現有嗰個；drizzle 會將 PG code 收喺 cause，兩處都認
    if (pgErrorCode(e) === "23505") {
      const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phone, phone)).limit(1);
      if (u) return u;
    }
    throw e;
  }
}

/** 名單名正規化喺 ./luckyDrawCore（純函數，測試共用）——trim＋toLowerCase；
 *  顯示／winnerName 快照保留原串 */

/** v2.5.6：某日已中次數（按 normalized winnerName；全日全域，唔分邊份名單／邊個模式）。
 *  同舊 winnerNamesOfDate Set 版口径一致：只計 pending／confirmed；cancelled／declined 唔計。
 *  名單模式「每人每日限中 N 次」用 count >= N 踢人；N=1 時 ≡ 舊 Set 行為，唔會靜默放寬。 */
async function winnerNameCountsOfDate(date?: string): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db
    .select({ winnerName: luckyDraws.winnerName })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.drawDate, date ?? hktToday()), inArray(luckyDraws.status, ["pending", "confirmed"])));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.winnerName != null) {
      const k = normalizeListName(r.winnerName);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

/** v2.5.6：同上，但按 winnerUserId 計（名單入面嘅官網會員嗰半池用） */
async function winnerIdCountsOfDate(date?: string): Promise<Map<number, number>> {
  const db = getDb();
  const rows = await db
    .select({ winnerUserId: luckyDraws.winnerUserId })
    .from(luckyDraws)
    .where(and(eq(luckyDraws.drawDate, date ?? hktToday()), inArray(luckyDraws.status, ["pending", "confirmed"])));
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.winnerUserId, (out.get(r.winnerUserId) ?? 0) + 1);
  return out;
}

/** 自訂名單混合池 entry：手打名（'name'，抽中起影子帳號、唔通知）｜
 *  官網會員（'member'，抽中照常彈窗＋email＋推送，自己揀地址寄送） */
type MixedPoolEntry =
  | { kind: "name"; name: string }
  | { kind: "member"; id: number; name: string; email: string | null };

/** 砌名單混合池：手打名踢走嗰日中夠 N 次嘅名（normalize 比 count）；會員（select 返嚟先算，
 *  已刪會員自動唔出現）踢走嗰日中夠 N 次嘅 id；extraExclude 顯式踢舊中獎名/id（重抽保險，
 *  唔理中咗幾多次都照踢）。
 *  maxWinsPerPerson（v2.5.6，名單自訂 1–100）：預設 1 ≡ 舊 Set guard 行為（count>=1 即踢）。 */
async function collectMixedPool(
  list: { names: string[]; memberIds: number[] },
  drawDate?: string,
  extraExclude?: { name?: string | null; userId?: number },
  maxWinsPerPerson = 1,
): Promise<MixedPoolEntry[]> {
  const db = getDb();
  const nameCounts = await winnerNameCountsOfDate(drawDate);
  const idCounts = await winnerIdCountsOfDate(drawDate);
  const pool: MixedPoolEntry[] = [];
  for (const n of list.names) {
    const forceOut = extraExclude?.name != null && normalizeListName(extraExclude.name) === normalizeListName(n);
    if (underWinLimit(nameCounts.get(normalizeListName(n)), maxWinsPerPerson, forceOut)) {
      pool.push({ kind: "name", name: n });
    }
  }
  if (list.memberIds.length > 0) {
    const memberRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(inArray(users.id, list.memberIds), eq(users.role, "member")));
    for (const m of memberRows) {
      const forceOut = extraExclude?.userId === m.id;
      if (underWinLimit(idCounts.get(m.id), maxWinsPerPerson, forceOut)) {
        pool.push({ kind: "member", id: m.id, name: m.name, email: m.email });
      }
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

/** 中獎通知：email（有 email 先寄）＋推送（有綁定先送）；never-throw。
 *  v2.2.57（老闆指令）：抽中嗰刻唔准call——淨係 adminNotifyWin（撳「好，繼續」）先用得 */
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
        // drizzle DrizzleQueryError 將 PG error 收喺 cause（「Failed query: …」嗰隻）——pgErrorCode 兩處都睇，穩陣捉 23503
        if (pgErrorCode(e) === "23503") {
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

  // ===== v2.5.5 第12版（老闆指令 2026-10-11「抽獎名單想剔除某啲人」）：剔除個別人選 =====
  // 被剔除嘅會員唔入會員條件名單池（collectParticipantIds 一處隔離，預覽／抽獎／重抽全生效），
  // 直到後台「恢復」。剔除／恢復都寫審計留底。
  /** 已剔除名單（連會員名／電話／邊個剔／幾時剔） */
  adminListExclusions: supervisorProcedure.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        userId: luckyDrawExclusions.userId,
        name: users.name,
        phone: users.phone,
        createdByName: luckyDrawExclusions.createdByName,
        createdAt: luckyDrawExclusions.createdAt,
      })
      .from(luckyDrawExclusions)
      .innerJoin(users, eq(luckyDrawExclusions.userId, users.id))
      .orderBy(desc(luckyDrawExclusions.createdAt));
    return { rows };
  }),

  /** 剔除一個會員（冪等：已剔除就當成功，onConflictDoNothing） */
  adminExcludeParticipant: supervisorProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [u] = await db
        .select({ id: users.id, name: users.name, phone: users.phone })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "會員唔存在" });
      const operator = await actorName(ctx.user.userId);
      await db
        .insert(luckyDrawExclusions)
        .values({ userId: u.id, createdBy: ctx.user.userId, createdByName: operator })
        .onConflictDoNothing();
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.exclude",
        targetType: "member", targetId: String(u.id),
        detail: `抽獎剔除人選：${u.name}（${u.phone}）——之後嘅會員條件名單抽獎唔會再抽中佢（直到恢復）`,
      });
      return { ok: true };
    }),

  /** 恢復一個被剔除嘅會員（即返返入池） */
  adminRemoveExclusion: supervisorProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [u] = await db
        .select({ id: users.id, name: users.name, phone: users.phone })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      await db.delete(luckyDrawExclusions).where(eq(luckyDrawExclusions.userId, input.userId));
      if (u) {
        void logAudit({
          actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.excludeRemove",
          targetType: "member", targetId: String(u.id),
          detail: `抽獎恢復人選：${u.name}（${u.phone}）——即時返返入抽獎池`,
        });
      }
      return { ok: true };
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
      // hardening：加埋香港抽獎日全域鎖（prize → date，次序統一），鎖內重檢「一日一人一件」——
      // 唔可以只靠 transaction 外嘅 winnersOfDate pre-check（並發另一抽會穿）。
      // FK 23503（獎品/會員並發被刪）→ CONFLICT（drawTxWithFkGuard）
      const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
        await lockPrizeTx(tx, prize.id);
        await lockDrawDateTx(tx, drawDate);
        const n = await prizeTakenTx(tx, prize.id);
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        // 鎖內重檢一日一件：中獎人啱啱喺今日中過（並發改變）→ 誠實 CONFLICT，可重試再抽
        const wins = await memberWinCountTx(tx, drawDate, winner.id);
        if (wins >= 1) {
          throw new TRPCError({ code: "CONFLICT", message: `「${winner.name}」啱啱喺今日中咗獎（並發改變），請再抽一次` });
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
      }));

      // v2.2.57（老闆指令）：抽中唔即時通知——留 pending 等結果卡撳「好，繼續」先發（adminNotifyWin）

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.draw",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `抽獎日 ${drawDate}：${prize.name} → ${winner.name}（池 ${pool.length} 人；未通知，待確認先發）`,
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
        // 池＝混合池踢走嗰日中夠 N 次嘅名/id（N＝名單 maxWinsPerPerson，預設 1＝舊行為），
        // 顯式加埋舊中獎名/id 保險（唔理中幾多次都踢）；空就乜都唔郁（舊中獎保留）
        const maxWins = list.maxWinsPerPerson ?? 1;
        const pool = await collectMixedPool(list, old.drawDate, { name: old.winnerName, userId: old.winnerUserId }, maxWins);
        if (pool.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得（名單空或嗰日全部中過）；舊中獎保留" });
        }
        const entry = pool[randomInt(0, pool.length)];
        const winnerName = entry.name;
        const winnerUserId = entry.kind === "member" ? entry.id : (await getOrCreateShadowUser(entry.name)).id;
        const operator = await actorName(ctx.user.userId);

        const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
          // 鎖次序統一：先 prize（單 key）→ 後香港抽獎日全域鎖（用舊紀錄嘅抽獎日，跨日重抽都鎖嗰日）
          await lockPrizeTx(tx, prize.id);
          await lockDrawDateTx(tx, old.drawDate);
          // v2.2.54（老闆指令「岩岩既抽獎紀錄唔算數」）：舊 pending 紀錄直接刪除，
          // 唔留 cancelled 底——中獎紀錄淨係見到新抽嗰筆；審計線索喺 audit log（#舊 → #新）。
          // hardening：delete 即係鎖後狀態重檢——affected 必須啱啱 1；0＝狀態已俾人改（確認/取消/另一重抽）
          // → CONFLICT，成個 transaction rollback（唔准插入新 winner，舊紀錄保留）。
          const deleted = await tx
            .delete(luckyDraws)
            .where(and(eq(luckyDraws.id, old.id), eq(luckyDraws.status, "pending")))
            .returning({ id: luckyDraws.id });
          if (deleted.length !== 1) {
            throw new TRPCError({ code: "CONFLICT", message: "呢筆紀錄狀態啱啱改變咗，重抽唔成功——請刷新再試" });
          }
          // 舊 pending 本來佔住一件獎品：刪咗先數件，先唔會假爆滿（唔存在繞過——件數上限照舊 enforce）
          const n = await prizeTakenTx(tx, prize.id);
          if (n >= (prize.quantity ?? 1)) {
            throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
          }
          // 鎖內重數新中獎人嗰日已中次數（全域、只計 pending/confirmed）：並發改變 → CONFLICT 可重試。
          // 舊 pending 屬舊中獎人（已被 forceExclude），唔會影響新中獎人嘅 count。
          const wins = entry.kind === "member"
            ? await memberWinCountTx(tx, old.drawDate, winnerUserId)
            : await nameWinCountTx(tx, old.drawDate, normalizeListName(entry.name));
          if (wins >= maxWins) {
            throw new TRPCError({ code: "CONFLICT", message: `「${winnerName}」啱啱中夠 ${maxWins} 次（並發改變），請再抽一次` });
          }
          const [d] = await tx
            .insert(luckyDraws)
            .values({
              prizeId: prize.id, winnerUserId, winnerName, listId: list.id,
              status: "pending", drawDate: old.drawDate, redrawOfId: old.id,
              drawnBy: ctx.user.userId, drawnByName: operator,
            })
            .returning();
          return d;
        }));

        // v2.2.57（老闆指令）：重抽出新結果都唔即時通知——等新結果卡撳「好，繼續」先發
        // （手打名本來就唔通知，admin 之後撳「確定」起單）

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

      // ── v2.5.6：劵活動抽獎重抽（用返活動合資格池：舊中獎人永遠踢出重抽池）──
      if (old.eventId != null) {
        const [event] = await db.select().from(luckyDrawEvents).where(eq(luckyDrawEvents.id, old.eventId)).limit(1);
        if (!event) throw new TRPCError({ code: "BAD_REQUEST", message: "活動已刪除" });
        const entries = await db
          .select()
          .from(luckyDrawEventEntries)
          .where(eq(luckyDrawEventEntries.eventId, event.id));
        const counts = await eventWinCounts(event.id);
        // 舊 pending 紀錄仲計緊舊中獎人一次——forceExclude 直接踢走佢（現行重抽規矩），
        // 其餘人按全活動累計上限過濾；空就乜都唔郁（舊中獎保留）
        const eligible = filterEligibleEntries(entries, counts, event.maxWinsPerPerson, old.eventEntryId ?? undefined);
        if (eligible.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得（活動名單空或全部中夠上限）；舊中獎保留" });
        }
        const total = eligible.reduce((s, e) => s + e.ticketCount, 0);
        const entry = pickWeightedEntry(eligible, randomInt(0, total));
        if (!entry) throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得；舊中獎保留" });
        const winnerUserId = (await getOrCreateShadowUser(entry.holderName)).id;
        const operator = await actorName(ctx.user.userId);

        const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
          // 鎖次序統一：先 prize（單 key）→ 後 event（雙 key），同 adminDrawEvent 一致
          await lockPrizeTx(tx, prize.id);
          await lockEventTx(tx, event.id);
          // hardening：UI 已禁止歸檔活動再抽，server 都喺 event 鎖內重讀 archivedAt——
          // 防止用 transaction 外嘅舊快照補抽（抽獎途中俾人歸檔）→ CONFLICT；
          // 只擋新抽，歷史中獎紀錄追溯（adminHistory）唔受影響
          const [evNow] = await tx
            .select({ archivedAt: luckyDrawEvents.archivedAt })
            .from(luckyDrawEvents)
            .where(eq(luckyDrawEvents.id, event.id))
            .limit(1);
          if (!evNow) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
          if (evNow.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "活動已歸檔，唔可以再抽" });
          // 同名單重抽（v2.2.54 老闆指令「岩岩既抽獎紀錄唔算數」）：舊 pending 直接刪除唔留底，
          // 獎品件數同時釋放（舊佔一件、新佔一件，淨數不變），審計線索喺 audit log（#舊 → #新）。
          // hardening：delete 即係鎖後狀態重檢——affected 必須啱啱 1；0＝狀態已俾人改
          // → CONFLICT，成個 transaction rollback（唔准插入新 winner，舊紀錄保留）。
          const deleted = await tx
            .delete(luckyDraws)
            .where(and(eq(luckyDraws.id, old.id), eq(luckyDraws.status, "pending")))
            .returning({ id: luckyDraws.id });
          if (deleted.length !== 1) {
            throw new TRPCError({ code: "CONFLICT", message: "呢筆紀錄狀態啱啱改變咗，重抽唔成功——請刷新再試" });
          }
          // 舊 pending 本來佔住一件獎品：刪咗先數件，先唔會假爆滿（quantity=1 嘅自家重抽都過到）
          const n = await prizeTakenTx(tx, prize.id);
          if (n >= (prize.quantity ?? 1)) {
            throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
          }
          // 鎖內重數新中獎劵全活動已中次數（只計 pending/confirmed）：並發改變 → CONFLICT 可重試。
          // 舊 pending 屬舊劵（已 forceExclude），唔會影響新劵嘅 count。
          const c = await entryWinCountTx(tx, entry.id);
          if (c >= event.maxWinsPerPerson) {
            throw new TRPCError({ code: "CONFLICT", message: `「${entry.holderName}」啱啱中夠 ${event.maxWinsPerPerson} 次（並發改變），請再抽一次` });
          }
          const [d] = await tx
            .insert(luckyDraws)
            .values({
              prizeId: prize.id, winnerUserId, winnerName: entry.holderName,
              eventId: event.id, eventEntryId: entry.id,
              status: "pending", drawDate: old.drawDate, redrawOfId: old.id,
              drawnBy: ctx.user.userId, drawnByName: operator,
            })
            .returning();
          return d;
        }));

        // 劵中獎人係影子帳號：唔通知——admin 之後撳「確定」起單（同手打名一樣）

        void logAudit({
          actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.redrawEvent",
          targetType: "luckyDraw", targetId: String(draw.id),
          detail: `特別重抽（劵活動《${event.name}》）#${old.id} → #${draw.id}：${prize.name} → ${entry.holderName}（券 #${entry.id}，合資格池 ${eligible.length} 人）`,
        });
        return {
          draw,
          winner: { id: winnerUserId, name: entry.holderName, kind: "manual" as const },
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

      const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
        // hardening（同名單/劵重抽補齊）：鎖次序統一——先 prize（單 key）→ 後香港抽獎日全域鎖
        // （用舊紀錄嘅抽獎日，跨日重抽都鎖嗰日，同 winnersOfDate(old.drawDate) 口径一致）
        await lockPrizeTx(tx, prize.id);
        await lockDrawDateTx(tx, old.drawDate);
        // 會員池重抽保留現有語義：舊紀錄留 cancelled 底（唔係名單/劵嗰種「刪除唔留數」）。
        // 舊 pending 嘅取消即係鎖後狀態認領——returning affected 必須啱啱 1；0＝狀態已俾人改
        // （確認/取消/另一重抽）→ CONFLICT，成個 transaction rollback（唔准插入新 winner，舊紀錄保留）。
        const claimed = await tx
          .update(luckyDraws)
          .set({ status: "cancelled", cancelledBy: ctx.user.userId, cancelNote: input.note ?? "特別重抽" })
          .where(and(eq(luckyDraws.id, old.id), eq(luckyDraws.status, "pending")))
          .returning({ id: luckyDraws.id });
        if (claimed.length !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "呢筆紀錄狀態啱啱改變咗，重抽唔成功——請刷新再試" });
        }
        // 舊 pending 本來佔住一件獎品：取消咗先數件，先唔會假爆滿（件數上限照舊 enforce）
        const n = await prizeTakenTx(tx, prize.id);
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        // 鎖內重數新中獎人嗰日已中次數（會員池維持一日一次，同 adminDraw 口径）：
        // 唔可以只靠 transaction 外嘅 winnersOfDate pre-check；並發改變 → CONFLICT 可重試
        const wins = await memberWinCountTx(tx, old.drawDate, winner.id);
        if (wins >= 1) {
          throw new TRPCError({ code: "CONFLICT", message: `「${winner.name}」啱啱喺嗰日中咗獎（並發改變），請再抽一次` });
        }
        const [d] = await tx
          .insert(luckyDraws)
          .values({
            prizeId: prize.id, winnerUserId: winner.id, winnerName: winner.name, status: "pending",
            drawDate: old.drawDate, redrawOfId: old.id,
            drawnBy: ctx.user.userId, drawnByName: operator,
          })
          .returning();
        return d;
      }));

      // v2.2.57（老闆指令）：唔即時通知——等新結果卡撳「好，繼續」先發（adminNotifyWin）

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

      // compare-and-swap 狀態認領＋官網單取消入同一個 transaction：
      // CAS 比對 id＋讀取時 status＋讀取時 orderId（null 用 isNull）——期間俾 respondWin／
      // adminConfirmManual 搶先確認咗（status/orderId 變咗）→ affected=0 → CONFLICT，
      // 唔會取消人哋新綁嘅單；我哋先認領成功的話，confirm 嗰邊鎖內 claim 見到 status 已改
      // → CONFLICT 兼 DB rollback，唔會留低 cancelled draw＋live 0 元單。
      // 保留現有功能：confirmed 且有 0 元單照可取消，按訂單狀態決定郁唔郁張單。
      const { orderCancelled, orderUntouchedWarn } = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(luckyDraws)
          .set({ status: "cancelled", cancelledBy: ctx.user.userId, cancelNote: input.note ?? null })
          .where(
            and(
              eq(luckyDraws.id, old.id),
              eq(luckyDraws.status, old.status),
              old.orderId == null ? isNull(luckyDraws.orderId) : eq(luckyDraws.orderId, old.orderId),
            ),
          )
          .returning({ id: luckyDraws.id });
        if (claimed.length !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "呢筆紀錄狀態啱啱改變咗，取消唔成功——請刷新再試" });
        }
        let orderCancelled = false;
        let orderUntouchedWarn: string | null = null;
        if (old.orderId != null) {
          const [ord] = await tx
            .select({ id: orders.id, status: orders.status, orderNo: orders.orderNo })
            .from(orders)
            .where(eq(orders.id, old.orderId))
            .limit(1);
          if (ord && ["pending_payment", "payment_review"].includes(ord.status)) {
            // 原子條件取消：WHERE 埋可取消狀態——select 到 update 之間俾人並發批咗/出咗貨，
            // affected=0 就唔會覆寫返 cancelled（唔會抺走人哋已批/出貨嘅單）；
            // 0 行唔當成功取消，走警告分支（draw 照取消，唔回滾 CAS）。
            const cancelledOrders = await tx
              .update(orders)
              .set({ status: "cancelled", updatedAt: new Date() })
              .where(and(eq(orders.id, ord.id), inArray(orders.status, ["pending_payment", "payment_review"])))
              .returning({ id: orders.id });
            if (cancelledOrders.length === 1) {
              // 未批嘅官網訂單：寫返「已取消」（老闆指定動作）
              orderCancelled = true;
            } else {
              orderUntouchedWarn = `警告：訂單 ${ord.orderNo} 啱啱俾人改咗狀態（並發），官網張單唔郁得，WMS 要人手跟`;
            }
          } else if (ord) {
            // 已批／出咗貨：唔郁張單 status，照取消中獎，log 警告（WMS 嗰邊人手跟）
            orderUntouchedWarn = `警告：訂單 ${ord.orderNo} 已經 ${ord.status}，官網張單唔郁得，WMS 要人手跟`;
          } else {
            // 張單已被 hard-delete（例如並發 adminDeleteDraw）：唔當成功取消，走警告分支
            orderUntouchedWarn = `警告：官網訂單 #${old.orderId} 已經唔存在（可能啱啱俾人刪除），唔郁得`;
          }
        }
        return { orderCancelled, orderUntouchedWarn };
      });
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.cancelWin",
        targetType: "luckyDraw", targetId: String(old.id),
        detail: `取消中獎 #${old.id}${orderCancelled ? "（官網訂單一併寫返已取消）" : ""}${orderUntouchedWarn ? `（${orderUntouchedWarn}）` : ""}${input.note ? `：${input.note}` : ""}`,
      });
      return { ok: true, orderCancelled };
    }),

  /** v2.2.57（老闆指令）：正式發送中獎通知——抽中嗰刻唔發，管理員/主管喺結果卡撳
   *  「✓ 好，繼續」（或紀錄頁「補發通知」）先經呢度寄 email＋推送，等客人入官網確認。
   *  防重複發：UPDATE ... WHERE notifiedAt IS NULL 原子認領——雙擊／兩人同撳都係得嗰個發，
   *  其餘回 already:true 唔再發。重抽／取消咗嘅紀錄會被 guard 擋（唔發得）。 */
  adminNotifyWin: supervisorProcedure
    .input(z.object({ drawId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [draw] = await db.select().from(luckyDraws).where(eq(luckyDraws.id, input.drawId)).limit(1);
      if (!draw) throw new TRPCError({ code: "NOT_FOUND", message: "中獎紀錄唔存在" });
      // 狀態分流講清楚：客人可能喺未收到通知前已經入官網撳咗確認——嗰種唔使再發
      if (draw.status === "confirmed") {
        throw new TRPCError({ code: "CONFLICT", message: "客人已經喺官網確認咗寄送，唔使再發通知" });
      }
      if (draw.status !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已取消/客人唔要，唔會發通知" });
      }
      const [winner] = await db
        .select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
        .from(users)
        .where(eq(users.id, draw.winnerUserId))
        .limit(1);
      if (!winner) throw new TRPCError({ code: "NOT_FOUND", message: "中獎帳號唔存在" });
      // 手打名影子帳號（phone 係 "DRAW#" 開頭）冇得通知——佢哋行「確定中獎」起單路線
      if (winner.phone.startsWith("DRAW#")) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "手打名中獎冇 email/推送可發——用「確定中獎」起單" });
      }
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, draw.prizeId)).limit(1);
      if (!prize) throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在" });

      // 原子認領：只有第一個 request 攞到（status='pending'＋notifiedAt null → 有值）；
      // WHERE 加埋 status='pending'——讀完快照後俾人取消/確認/客人唔要咗，claim 會落空，
      // 唔好喺 cancelled/declined/confirmed 紀錄上發通知。
      const claim = await db
        .update(luckyDraws)
        .set({ notifiedAt: new Date() })
        .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending"), isNull(luckyDraws.notifiedAt)))
        .returning({ id: luckyDraws.id });
      if (claim.length === 0) {
        // 唔可以一概 already:true——重讀目前狀態分流：
        // 仍 pending 且 notifiedAt 已有值＝真係發過（重複撳）→ already:true；
        // cancelled/declined/confirmed＝並發改變 → CONFLICT，唔准發通知
        const [cur] = await db
          .select({ status: luckyDraws.status, notifiedAt: luckyDraws.notifiedAt })
          .from(luckyDraws)
          .where(eq(luckyDraws.id, draw.id))
          .limit(1);
        if (cur && cur.status === "pending" && cur.notifiedAt != null) {
          return { ok: true as const, already: true as const };
        }
        throw new TRPCError({ code: "CONFLICT", message: "呢個中獎狀態啱啱改變咗（已取消/已處理），唔會發通知——請刷新再試" });
      }

      notifyWinner(winner, prize, draw.drawDate);

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.notifyWin",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `發送中獎通知 #${draw.id}：${prize.name} → ${winner.name}（email${winner.email ? "＋推送" : "冇email淨推送"}）`,
      });
      return { ok: true as const, already: false as const };
    }),

  /** 刪除抽獎紀錄（老闆指明：管理員先用到，唔係 supervisor）：硬刪除該場抽獎紀錄，
   *  有生成訂單嘅話官網張單連仔行（orderShipments／orderItems／paymentProofs／wmsSyncLog）一併 HARD DELETE——
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

      // 訂單刪除唔靠 transaction 外嘅 orderId 快照：tx 內 DELETE luckyDraws ... RETURNING orderId
      // 先係刪行嗰刻（行鎖內）嘅真實綁單——並發 respondWin／adminConfirmManual 先 commit 咗，
      // 都係刪真實關聯嗰張單，唔會留孤兒 0 元單；反轉頭我哋先攞到行鎖，對方 claim/綁單
      // affected=0 → CONFLICT 兼 rollback，唔會綁去已刪嘅紀錄。
      let orderNo: string | null = null;
      let orderDeleted = false;
      await db.transaction(async (tx) => {
        // 順序（FK 全部指去 orders——luckyDraws.orderId 都係，所以 luckyDraws 一定要喺 orders 之前刪）：
        // luckyDraws 本行（RETURNING orderId 攞行鎖內真實綁單）→ 訂單仔行（orderShipments／orderItems／paymentProofs／wmsSyncLog）→ orders 本行
        const deleted = await tx
          .delete(luckyDraws)
          .where(eq(luckyDraws.id, old.draw.id))
          .returning({ orderId: luckyDraws.orderId });
        const orderId = deleted[0]?.orderId ?? null;
        if (orderId != null) {
          // 攞單號做 audit（張單可能已經唔存在——重複刪除；咁仔行照樣清、orders delete 0 行）
          const [ord] = await tx
            .select({ orderNo: orders.orderNo })
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);
          orderNo = ord?.orderNo ?? null;
          // orderShipments（WMS 出貨批次）都有 FK 指住 orders（冇 cascade）——唔刪佢先會 23503
          // （同 orderDelete.hardDeleteOrder 嘅仔行清單對齊）
          await tx.delete(orderShipments).where(eq(orderShipments.orderId, orderId));
          await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
          await tx.delete(paymentProofs).where(eq(paymentProofs.orderId, orderId));
          await tx.delete(wmsSyncLog).where(eq(wmsSyncLog.orderId, orderId));
          const delOrders = await tx.delete(orders).where(eq(orders.id, orderId)).returning({ id: orders.id });
          orderDeleted = delOrders.length > 0;
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
   *  （luckyDraws → 仔行 orderShipments／orderItems／paymentProofs／wmsSyncLog → orders，同一個 transaction；
   *   luckyDraws.orderId 有 FK 指住 orders，所以 luckyDraws 一定要先刪；
   *   orderShipments（WMS 出貨批次）都有 FK 指住 orders，漏刪會 23503）。
   *  老闆原話「wms佢地自己會刪除，你要比我刪除」——冇「已批/出貨唔准刪」嘅 guard，
   *  官網呢邊要刪得就一定刪得；WMS 嗰邊嘅單由佢哋自己處理。 */
  adminDeleteDrawsByDate: adminProcedure
    .input(z.object({ drawDate: z.string().regex(/^\d{8}$/) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // 唔再靠 transaction 外嘅 leftJoin 快照決定刪邊啲單：tx 內 DELETE luckyDraws ... RETURNING orderId，
      // 以實際刪到嘅行（行鎖內）嘅 orderId 集合作準——快照之後先綁嘅單都刪到真實關聯單，
      // 亦唔會誤刪唔屬於今次實際刪除 draw 嘅訂單（例如快照後紀錄俾人改咗/刪咗）。
      const result = await db.transaction(async (tx) => {
        // luckyDraws 先（orderId FK 指住 orders，唔調轉會 23503）→ 訂單仔行（orderShipments 同有 FK 指 orders）→ orders 本行
        const delDraws = await tx
          .delete(luckyDraws)
          .where(eq(luckyDraws.drawDate, input.drawDate))
          .returning({ orderId: luckyDraws.orderId });
        // 淨係實際刪除咗嘅紀錄真係綁住嘅官網訂單 id（orderId null → 自動跳過）
        const orderIds = [...new Set(delDraws.map((d) => d.orderId).filter((id): id is number => id != null))];
        let ordersDeleted = 0;
        if (orderIds.length > 0) {
          await tx.delete(orderShipments).where(inArray(orderShipments.orderId, orderIds));
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
        // v2.5.6：名單每日限中 N 次（舊名單冇呢個欄都會因 default 1 同舊行為一致）
        maxWinsPerPerson: luckyDrawLists.maxWinsPerPerson,
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
          // v2.5.6（老闆指令）：名單模式每人每個香港抽獎日限中 N 次；預設 1＝舊行為
          maxWinsPerPerson: z.number().int().min(1).max(100).default(1),
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
        .values({ name: input.name, names, memberIds, maxWinsPerPerson: input.maxWinsPerPerson, createdBy: ctx.user.userId, createdByName: operator })
        .returning();
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.createList",
        targetType: "luckyDrawList", targetId: String(list.id),
        detail: `開自訂名單《${list.name}》（手打 ${names.length} 人＋會員 ${memberIds.length} 人，每人每日限中 ${input.maxWinsPerPerson} 次）`,
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

      // 混合池：手打名踢嗰日中夠 N 次嘅名（normalize count 比）；會員踢中夠 N 次嘅 id
      // （N＝名單 maxWinsPerPerson，預設 1＝舊一日一次行為）
      const maxWins = list.maxWinsPerPerson ?? 1;
      const pool = await collectMixedPool(list, undefined, undefined, maxWins);
      if (pool.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `名單係空，或者名單入面嘅人今日都中夠 ${maxWins} 次` });
      }
      const entry = pool[randomInt(0, pool.length)];
      const winnerName = entry.name;
      // 手打名先起/重用影子帳號；會員直接用真 user id
      const winnerUserId = entry.kind === "member" ? entry.id : (await getOrCreateShadowUser(entry.name)).id;

      const drawDate = hktToday();
      const operator = await actorName(ctx.user.userId);
      // v2.2.55（老闆指令）：獎品有件數 — 防超抽邏輯同 adminDraw 一樣（advisory lock 鎖件獎品再數）。
      // hardening：名單「每人每日限中 N 次」係全日全域規矩 → prize → 香港抽獎日全域鎖之後，
      // 鎖內重數中獎人當日已中次數（名按 normalized winnerName、會員按 id，同池篩選口径一致），
      // 唔可以只靠 transaction 外嘅 collectMixedPool pre-check；並發超限 → CONFLICT 可重試。
      const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
        await lockPrizeTx(tx, prize.id);
        await lockDrawDateTx(tx, drawDate);
        const n = await prizeTakenTx(tx, prize.id);
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        const wins = entry.kind === "member"
          ? await memberWinCountTx(tx, drawDate, winnerUserId)
          : await nameWinCountTx(tx, drawDate, normalizeListName(entry.name));
        if (wins >= maxWins) {
          throw new TRPCError({ code: "CONFLICT", message: `「${winnerName}」啱啱中夠 ${maxWins} 次（並發改變），請再抽一次` });
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
      }));

      // v2.2.57（老闆指令）：抽中官網會員都唔即時通知——等結果卡撳「好，繼續」先發；
      // 手打名：唔通知（彈窗靠 myPendingWin 自動生效，唔受通知與否影響）

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

      const orderNo = await genOrderNo();
      const remark = `官網訂單・包郵・直播抽獎中獎商品（${prize.name}，抽獎日 ${fmtDrawDate(draw.drawDate)}）`;
      // 認領（pending→confirmed）＋起單＋行項目＋綁 orderId 全部入同一個 DB transaction：
      // claim 用 update...where status='pending'，affected=1 先郁手，否則 CONFLICT——
      // 唔再喺 transaction 外先認領（cancel 唔可以喺認領同起單之間穿入）；
      // 綁 orderId 有狀態守衛（status=confirmed＋orderId IS NULL）＋ affected 檢查，0 → CONFLICT，
      // 唔會綁到已取消/被改動嘅紀錄；任何一步失敗由 DB rollback（唔再依賴外部補償 update），
      // 唔會留低冇 item／冇綁定嘅孤兒 0 元單。
      const order = await db.transaction(async (tx) => {
        const claim = await tx
          .update(luckyDraws)
          .set({ status: "confirmed", respondedAt: new Date() })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending")))
          .returning({ id: luckyDraws.id });
        if (claim.length !== 1) throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });
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
        const bound = await tx
          .update(luckyDraws)
          .set({ orderId: inserted.id })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "confirmed"), isNull(luckyDraws.orderId)))
          .returning({ id: luckyDraws.id });
        if (bound.length !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "中獎紀錄啱啱俾人改咗，綁單唔成功——請刷新再試" });
        }
        return inserted;
      });

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
        // v2.2.57（老闆指令）：通知狀態——null＝抽咗但未發 email/推送（等撳「好，繼續」）
        notifiedAt: luckyDraws.notifiedAt,
        // v2.2.48：中獎名快照（自訂名單中獎＝名單原串；前端 prefer snapshot）＋邊份名單
        winnerNameSnap: luckyDraws.winnerName,
        listId: luckyDraws.listId,
        // v2.5.6：劵活動追溯——邊個活動（名）＋邊張劵（同名影子帳號跨活動重用都追到）
        eventId: luckyDraws.eventId,
        eventEntryId: luckyDraws.eventEntryId,
        eventName: luckyDrawEvents.name,
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
      .leftJoin(luckyDrawEvents, eq(luckyDraws.eventId, luckyDrawEvents.id))
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

  // ───────────────────────── 後台：抽獎劵活動（v2.5.6）─────────────────────────

  /** 開活動：名＋每人全活動限中次數（1–100）。活動只歸檔唔硬刪（中獎紀錄追溯） */
  adminCreateEvent: supervisorProcedure
    .input(
      z.object({
        name: z.string().trim().min(1, "活動名唔准空").max(128),
        maxWinsPerPerson: z.number().int().min(1).max(100).default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const operator = await actorName(ctx.user.userId);
      const [event] = await db
        .insert(luckyDrawEvents)
        .values({ name: input.name, maxWinsPerPerson: input.maxWinsPerPerson, createdBy: ctx.user.userId, createdByName: operator })
        .returning();
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.createEvent",
        targetType: "luckyDrawEvent", targetId: String(event.id),
        detail: `開抽獎劵活動《${event.name}》（每人限中 ${input.maxWinsPerPerson} 次）`,
      });
      return event;
    }),

  /** 活動一覽（新→舊）：連 entry 數／總劵數／已抽出件數（pending+confirmed） */
  adminListEvents: supervisorProcedure.query(async () => {
    const db = getDb();
    const events = await db.select().from(luckyDrawEvents).orderBy(desc(luckyDrawEvents.id));
    const entryStats = await db
      .select({
        eventId: luckyDrawEventEntries.eventId,
        entries: sql<number>`count(*)::int`,
        tickets: sql<number>`coalesce(sum(${luckyDrawEventEntries.ticketCount}),0)::int`,
      })
      .from(luckyDrawEventEntries)
      .groupBy(luckyDrawEventEntries.eventId);
    const drawStats = await db
      .select({ eventId: luckyDraws.eventId, n: sql<number>`count(*)::int` })
      .from(luckyDraws)
      .where(inArray(luckyDraws.status, ["pending", "confirmed"]))
      .groupBy(luckyDraws.eventId);
    const entryBy = new Map(entryStats.map((r) => [r.eventId, r]));
    const drawBy = new Map(drawStats.map((r) => [r.eventId, Number(r.n)]));
    return events.map((e) => ({
      ...e,
      entryCount: Number(entryBy.get(e.id)?.entries ?? 0),
      totalTickets: Number(entryBy.get(e.id)?.tickets ?? 0),
      drawnCount: drawBy.get(e.id) ?? 0,
    }));
  }),

  /** 歸檔／取消歸檔活動：歸檔後唔再匯入、唔再抽得；中獎紀錄照舊睇到。
   *  hardening：歸檔／取消歸檔都喺 DB transaction 內攞 EVENT_LOCK_NS 雙 key 鎖
   *  （同 adminDrawEvent／event redraw／Excel ticket commit 同一把），鎖內重讀活動先 update——
   *  歸檔同抽獎／匯入互斥、可線性化，唔會出現「抽獎鎖內重讀仲未歸檔 → 插中獎」同歸檔並發穿插。 */
  adminSetEventArchived: supervisorProcedure
    .input(z.object({ eventId: z.number().int().positive(), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [event] = await db.select().from(luckyDrawEvents).where(eq(luckyDrawEvents.id, input.eventId)).limit(1);
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
      const operator = await actorName(ctx.user.userId);
      await db.transaction(async (tx) => {
        // 鎖次序統一：冇 prize 參與，第一道就係 event 雙 key lock（同抽獎／匯入路徑互鎖）
        await lockEventTx(tx, input.eventId);
        // 鎖內重讀活動（唔信 transaction 外快照）：活動俾人刪咗 → NOT_FOUND
        const [evNow] = await tx
          .select({ id: luckyDrawEvents.id })
          .from(luckyDrawEvents)
          .where(eq(luckyDrawEvents.id, input.eventId))
          .limit(1);
        if (!evNow) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
        await tx
          .update(luckyDrawEvents)
          .set(input.archived ? { archivedAt: new Date(), archivedByName: operator } : { archivedAt: null, archivedByName: null })
          .where(eq(luckyDrawEvents.id, input.eventId));
      });
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: input.archived ? "luckyDraw.archiveEvent" : "luckyDraw.unarchiveEvent",
        targetType: "luckyDrawEvent", targetId: String(input.eventId),
        detail: input.archived ? `活動《${event.name}》歸檔` : `活動《${event.name}》放返未歸檔`,
      });
      return { ok: true as const };
    }),

  /** 活動劵名單：每人幾多張劵＋全活動已中次數（pending+confirmed） */
  adminListEventEntries: supervisorProcedure
    .input(z.object({ eventId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const entries = await db
        .select()
        .from(luckyDrawEventEntries)
        .where(eq(luckyDrawEventEntries.eventId, input.eventId))
        .orderBy(luckyDrawEventEntries.id);
      const counts = await eventWinCounts(input.eventId);
      return {
        entries: entries.map((e) => ({ ...e, winCount: counts.get(e.id) ?? 0 })),
        totalTickets: entries.reduce((s, e) => s + e.ticketCount, 0),
      };
    }),

  /** 刪劵持有人：有中獎紀錄參照會被 FK 擋（CONFLICT）——紀錄要留底追溯 */
  adminDeleteEventEntry: supervisorProcedure
    .input(z.object({ entryId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      let row: typeof luckyDrawEventEntries.$inferSelect | undefined;
      try {
        [row] = await db.delete(luckyDrawEventEntries).where(eq(luckyDrawEventEntries.id, input.entryId)).returning();
      } catch (e) {
        if (pgErrorCode(e) === "23503") {
          throw new TRPCError({ code: "CONFLICT", message: "呢個人有中獎紀錄，刪唔到（紀錄要留底）" });
        }
        throw e;
      }
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "劵持有人唔存在" });
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.deleteEventEntry",
        targetType: "luckyDrawEventEntry", targetId: String(input.entryId),
        detail: `刪劵持有人：${row.holderName}（${row.ticketCount} 張，活動 #${row.eventId}）`,
      });
      return { ok: true };
    }),

  /** 劵活動抽獎：每張劵等權（人用 ticketCount 加權，randomInt(0,total)＋累計權重，唔展開巨型 array）。
   *  池＝全活動限中未夠 N 嘅人；transaction 內先 prize lock 後 event lock，
   *  重數獎品件數＋重數中獎人限中——並發改變會見到 CONFLICT，唔會靜默超抽。
   *  中獎人係劵持有人（影子帳號），唔通知——admin 撳「確定」起 0 元單（adminConfirmManual 現有流程）。 */
  adminDrawEvent: supervisorProcedure
    .input(
      z.object({
        prizeId: z.number().int().positive(),
        eventId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [prize] = await db.select().from(luckyPrizes).where(eq(luckyPrizes.id, input.prizeId)).limit(1);
      if (!prize || !prize.active) {
        throw new TRPCError({ code: "NOT_FOUND", message: "獎品唔存在或已下架" });
      }
      const [event] = await db.select().from(luckyDrawEvents).where(eq(luckyDrawEvents.id, input.eventId)).limit(1);
      if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
      if (event.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "活動已歸檔，唔可以再抽" });

      const entries = await db
        .select()
        .from(luckyDrawEventEntries)
        .where(eq(luckyDrawEventEntries.eventId, event.id));
      const counts = await eventWinCounts(event.id);
      const eligible = filterEligibleEntries(entries, counts, event.maxWinsPerPerson);
      if (eligible.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `活動名單係空，或者全部人都中夠 ${event.maxWinsPerPerson} 次` });
      }
      const total = eligible.reduce((s, e) => s + e.ticketCount, 0);
      const entry = pickWeightedEntry(eligible, randomInt(0, total));
      if (!entry) throw new TRPCError({ code: "BAD_REQUEST", message: "冇人抽得" });
      // 劵持有人 → 影子帳號（phone="DRAW#名"；同名跨活動重用，所以紀錄一定要留 eventEntryId）
      const winnerUserId = (await getOrCreateShadowUser(entry.holderName)).id;

      const drawDate = hktToday();
      const operator = await actorName(ctx.user.userId);
      const draw = await drawTxWithFkGuard(db.transaction(async (tx) => {
        // 鎖次序統一：先 prize（單 key，同 adminDraw/adminDrawManual 互鎖）→ 後 event（雙 key）
        // （同 event redraw 共用 helper，避免口径分叉）
        await lockPrizeTx(tx, prize.id);
        await lockEventTx(tx, event.id);
        // 鎖內重讀活動歸檔狀態（同 event redraw／ticket commit 一致）：唔信 transaction 外舊快照——
        // 抽獎途中俾人歸檔 → CONFLICT；活動俾人刪咗 → NOT_FOUND；通過先准插中獎。
        const [evNow] = await tx
          .select({ archivedAt: luckyDrawEvents.archivedAt })
          .from(luckyDrawEvents)
          .where(eq(luckyDrawEvents.id, event.id))
          .limit(1);
        if (!evNow) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
        if (evNow.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "活動已歸檔，唔可以再抽" });
        const n = await prizeTakenTx(tx, prize.id);
        if (n >= (prize.quantity ?? 1)) {
          throw new TRPCError({ code: "CONFLICT", message: `《${prize.name}》共 ${prize.quantity ?? 1} 件已經抽晒` });
        }
        // 鎖內重檢中獎人限中（並發狀態改變 → 可見 CONFLICT，唔靜默超抽）
        const c = await entryWinCountTx(tx, entry.id);
        if (c >= event.maxWinsPerPerson) {
          throw new TRPCError({ code: "CONFLICT", message: `「${entry.holderName}」啱啱中夠 ${event.maxWinsPerPerson} 次（並發改變），請再抽一次` });
        }
        const [d] = await tx
          .insert(luckyDraws)
          .values({
            prizeId: prize.id,
            winnerUserId,
            winnerName: entry.holderName, // 快照（同現行口径）
            eventId: event.id,
            eventEntryId: entry.id,
            status: "pending",
            drawDate,
            drawnBy: ctx.user.userId,
            drawnByName: operator,
          })
          .returning();
        return d;
      }));

      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.drawEvent",
        targetType: "luckyDraw", targetId: String(draw.id),
        detail: `抽獎日 ${drawDate}：${prize.name} → ${entry.holderName}（劵活動《${event.name}》券 #${entry.id}，合資格池 ${eligible.length} 人／${total} 張劵；未通知，待確定起單）`,
      });
      return {
        draw,
        winner: { id: winnerUserId, name: entry.holderName, kind: "manual" as const },
        prize,
      };
    }),

  // ───────────────────────── 後台：Excel 範本／匯入（v2.5.6）─────────────────────────

  /** 下載 .xlsx 範本（真 xlsx 嘅 base64；header only，冇示例人名）：
   *  list 欄「姓名」；ticket 欄「姓名、抽獎劵數」。UI 落 base64 起 Blob 下載 */
  adminDownloadTemplate: supervisorProcedure
    .input(z.object({ kind: z.enum(["list", "ticket"]) }))
    .query(({ input }) => {
      const buf = buildTemplateXlsx(input.kind);
      return {
        filename: input.kind === "list" ? "抽獎名單範本.xlsx" : "抽獎劵範本.xlsx",
        base64: buf.toString("base64"),
      };
    }),

  /** Excel 匯入（preview 預設完全唔寫 DB；commit=true 但有逐行錯誤就全部唔寫）。
   *  UI FileReader 讀 base64 傳上嚟（行 tRPC，唔使新 auth 路由）；server 限原始 2MB、
   *  500 數據行、PK magic、只支援本系統範本格式。
   *  list commit＝開新名單（名＋maxWinsPerPerson）；ticket commit＝寫入指定未歸檔活動
   *  （duplicatePolicy=skip|merge，merge 加劵數）。回 rows/errors/duplicates/summary。 */
  adminImportExcel: supervisorProcedure
    .input(
      z.object({
        kind: z.enum(["list", "ticket"]),
        /** FileReader readAsDataURL 嘅 base64（可以帶 data:...;base64, 前綴） */
        fileBase64: z.string().max(4_000_000, "檔案太大（上限 2MB）"),
        commit: z.boolean().default(false),
        duplicatePolicy: z.enum(["skip", "merge"]).default("skip"),
        // list commit 用
        listName: z.string().trim().max(64).default(""),
        maxWinsPerPerson: z.number().int().min(1).max(100).default(1),
        // ticket preview/commit 用（重複檢查要對住活動現有名單）
        eventId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // data URL 前綴剝離；base64 解碼後先計真 size
      const b64 = input.fileBase64.replace(/^data:[^,]*;base64,/, "");
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "檔案係空或者唔係有效 base64" });
      }
      if (buf.length > IMPORT_MAX_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `檔案太大（上限 ${IMPORT_MAX_BYTES / 1024 / 1024}MB）` });
      }
      if (!hasPkMagic(buf)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "唔係有效嘅 .xlsx 檔案（要 PK 開頭嘅 zip 格式）" });
      }
      let parsed;
      try {
        parsed = parseXlsxRows(buf);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `xlsx 解析失敗：${e instanceof Error ? e.message : "格式唔啱"}——請用系統範本`,
        });
      }
      const { rows, errors: rowErrors } = validateImportRows(input.kind, parsed);

      // ticket：對住指定活動做重複檢查（preview 都要，保證 preview≡commit）
      let existing = new Map<string, ExistingEntry>();
      let event: typeof luckyDrawEvents.$inferSelect | undefined;
      if (input.kind === "ticket") {
        if (!input.eventId) throw new TRPCError({ code: "BAD_REQUEST", message: "劵模式匯入要指定活動" });
        const [ev] = await db.select().from(luckyDrawEvents).where(eq(luckyDrawEvents.id, input.eventId)).limit(1);
        if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
        if (ev.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "活動已歸檔，唔可以再匯入" });
        event = ev;
        const entryRows = await db
          .select()
          .from(luckyDrawEventEntries)
          .where(eq(luckyDrawEventEntries.eventId, ev.id));
        existing = new Map(entryRows.map((e) => [e.normalizedName, { id: e.id, holderName: e.holderName, ticketCount: e.ticketCount }]));
      }

      const plan = planImport(input.kind, rows, existing, input.duplicatePolicy);
      const errors = [...rowErrors, ...plan.errors];
      const summary = {
        kind: input.kind,
        dataRows: rows.length + errors.filter((e) => e.field !== "header" && e.field !== "rows").length,
        validRows: rows.length,
        inserts: plan.inserts.length,
        merges: plan.merges.length,
        duplicates: plan.duplicates.length,
        errors: errors.length,
        totalTickets: input.kind === "ticket"
          ? plan.inserts.reduce((s, r) => s + r.ticketCount, 0) + plan.merges.reduce((s, m) => s + m.addTickets, 0)
          : 0,
      };

      // preview（預設）或者有逐行錯誤：全部唔寫
      if (!input.commit || errors.length > 0) {
        return { committed: false as const, rows, errors, duplicates: plan.duplicates, summary };
      }

      if (input.kind === "list") {
        if (!input.listName) throw new TRPCError({ code: "BAD_REQUEST", message: "名單名唔准空" });
        // hardening：最終 names 為空（檔案得 header／有效行去重晒）→ 拒絕，唔准開空名單
        if (plan.inserts.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "名單係空——冇有效姓名可匯入，唔會開空名單" });
        }
        const operator = await actorName(ctx.user.userId);
        const [list] = await db
          .insert(luckyDrawLists)
          .values({
            name: input.listName,
            names: plan.inserts.map((r) => r.name),
            memberIds: [],
            maxWinsPerPerson: input.maxWinsPerPerson,
            createdBy: ctx.user.userId,
            createdByName: operator,
          })
          .returning();
        void logAudit({
          actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.importList",
          targetType: "luckyDrawList", targetId: String(list.id),
          detail: `Excel 匯入開名單《${list.name}》：${plan.inserts.length} 人（去重 ${plan.duplicates.length}，每人每日限中 ${input.maxWinsPerPerson} 次）`,
        });
        return { committed: true as const, rows, errors, duplicates: plan.duplicates, summary, listId: list.id };
      }

      // ticket commit：inserts＋merges 入同一個 transaction。
      // hardening：唔好只信 preview 嘅舊快照——event 雙 key 鎖內重新讀取現有 entries，
      // 以鎖內最新 ticketCount 驗每人 ≤10000／全活動總劵 ≤10,000,000（並發 merge＋跨批累加都計在內）；
      // 唯一索引撞（並發匯入同名）→ CONFLICT。任何一步出錯全批 rollback。
      const eventId = event!.id;
      const operator = await actorName(ctx.user.userId);
      try {
        await db.transaction(async (tx) => {
          // 鎖次序統一：冇 prize 參與，第一道就係 event 雙 key lock（同抽獎路徑互鎖）
          await lockEventTx(tx, eventId);
          const [evNow] = await tx
            .select({ archivedAt: luckyDrawEvents.archivedAt })
            .from(luckyDrawEvents)
            .where(eq(luckyDrawEvents.id, eventId))
            .limit(1);
          if (!evNow) throw new TRPCError({ code: "NOT_FOUND", message: "活動唔存在" });
          if (evNow.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "活動已歸檔，唔可以再匯入" });
          const curEntries = await tx
            .select({
              id: luckyDrawEventEntries.id,
              holderName: luckyDrawEventEntries.holderName,
              normalizedName: luckyDrawEventEntries.normalizedName,
              ticketCount: luckyDrawEventEntries.ticketCount,
            })
            .from(luckyDrawEventEntries)
            .where(eq(luckyDrawEventEntries.eventId, eventId));
          const byId = new Map(curEntries.map((e) => [e.id, e]));
          const byName = new Map(curEntries.map((e) => [e.normalizedName, e]));
          let totalAfter = curEntries.reduce((s, e) => s + e.ticketCount, 0);
          // merge：以鎖內最新 ticketCount 驗每人上限（並發另一批 merge 加過會即時見到）
          for (const m of plan.merges) {
            const cur = byId.get(m.entryId);
            if (!cur) {
              throw new TRPCError({ code: "CONFLICT", message: `「${m.holderName}」嘅劵紀錄啱啱俾人改咗（並發），請重新預覽再匯入` });
            }
            const after = cur.ticketCount + m.addTickets;
            if (after > MAX_TICKETS_PER_PERSON) {
              throw new TRPCError({ code: "CONFLICT", message: `合併後「${cur.holderName}」共 ${after} 張，超過每人上限 ${MAX_TICKETS_PER_PERSON}（並發/跨批累加），請重新預覽再匯入` });
            }
            totalAfter += m.addTickets;
          }
          // insert：鎖內再驗同名（preview 之後俾人插咗同名 → CONFLICT；DB unique index 做最後防線）
          for (const r of plan.inserts) {
            if (byName.has(r.normalizedName)) {
              throw new TRPCError({ code: "CONFLICT", message: `「${r.name}」啱啱俾人匯入咗（並發），請重新預覽再匯入` });
            }
            totalAfter += r.ticketCount;
          }
          if (totalAfter > MAX_TOTAL_TICKETS) {
            throw new TRPCError({ code: "CONFLICT", message: `全活動總劵數會超過上限 ${MAX_TOTAL_TICKETS}（並發/跨批累加），請重新預覽再匯入` });
          }
          for (const m of plan.merges) {
            const merged = await tx
              .update(luckyDrawEventEntries)
              .set({ ticketCount: sql`${luckyDrawEventEntries.ticketCount} + ${m.addTickets}` })
              .where(and(eq(luckyDrawEventEntries.id, m.entryId), eq(luckyDrawEventEntries.eventId, eventId)))
              .returning({ id: luckyDrawEventEntries.id });
            if (merged.length !== 1) {
              throw new TRPCError({ code: "CONFLICT", message: `「${m.holderName}」嘅劵紀錄啱啱俾人改咗（並發），請重新預覽再匯入` });
            }
          }
          if (plan.inserts.length > 0) {
            await tx.insert(luckyDrawEventEntries).values(
              plan.inserts.map((r) => ({
                eventId,
                holderName: r.name,
                normalizedName: r.normalizedName,
                ticketCount: r.ticketCount,
                createdBy: ctx.user.userId,
                createdByName: operator,
              })),
            );
          }
        });
      } catch (e) {
        if (pgErrorCode(e) === "23505") {
          throw new TRPCError({ code: "CONFLICT", message: "有同名持有人啱啱俾人匯入咗（並發），請重新預覽再匯入" });
        }
        throw e;
      }
      void logAudit({
        actorId: ctx.user.userId, actorRole: ctx.user.role, action: "luckyDraw.importTickets",
        targetType: "luckyDrawEvent", targetId: String(eventId),
        detail: `Excel 匯入劵活動《${event!.name}》：新增 ${plan.inserts.length} 人、加劵 ${plan.merges.length} 人（skip/merge 重複 ${plan.duplicates.length} 行）`,
      });
      return { committed: true as const, rows, errors, duplicates: plan.duplicates, summary };
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
      const orderNo = await genOrderNo();
      const remark = `官網訂單・包郵・直播抽獎中獎商品（${prize.name}，抽獎日 ${fmtDrawDate(draw.drawDate)}）`;
      // 認領（pending→confirmed）＋起單＋行項目＋綁 orderId 全部入同一個 DB transaction：
      // claim 用 update...where status='pending'（防客人雙擊出兩張單），affected=1 先郁手；
      // 唔再喺 transaction 外先認領——adminCancelWin 唔可以喺認領同起單之間穿入；
      // 綁 orderId 有狀態守衛（status=confirmed＋orderId IS NULL）＋ affected 檢查，0 → CONFLICT；
      // 任何一步失敗由 DB rollback（唔再依賴外部補償 update），唔會留低孤兒 0 元單。
      const order = await db.transaction(async (tx) => {
        const claim = await tx
          .update(luckyDraws)
          .set({ status: "confirmed", respondedAt: new Date() })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "pending")))
          .returning({ id: luckyDraws.id });
        if (claim.length !== 1) throw new TRPCError({ code: "CONFLICT", message: "呢個中獎已經處理咗" });
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
        const bound = await tx
          .update(luckyDraws)
          .set({ orderId: inserted.id })
          .where(and(eq(luckyDraws.id, draw.id), eq(luckyDraws.status, "confirmed"), isNull(luckyDraws.orderId)))
          .returning({ id: luckyDraws.id });
        if (bound.length !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "中獎紀錄啱啱俾人改咗，綁單唔成功——請刷新再試" });
        }
        return inserted;
      });

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
