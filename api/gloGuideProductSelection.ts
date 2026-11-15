/**
 * Glo Glo 精選指南——商品選擇模組（SPEC 第 3 輪凍結 contract）。
 *
 * 商品查詢 filter（admin products query／WMS products.list 共用）：
 * ─ { mode: "auto" }：由香港本週向過去逐週 fallback，只回傳最近一個有 ≥2 件
 *   合資格**從未用過**商品嘅週次；冇就空 array（唔會暗中改用其他週）。
 * ─ { mode: "week"; weekStart }：weekStart 係香港星期一（YYYY-MM-DD），回傳嗰週
 *   （週一至週日）直播商品，不符合條件嘅都照回（eligible=false＋ineligibleReason）。
 * ─ { mode: "session"; liveDate; liveSession }：liveDate YYYYMMDD＋真實場次。
 * ─ { mode: "date"; liveDate }（iteration 4 新增）：liveDate YYYYMMDD **成日**——
 *   嗰日所有場次＋冇場次（blank session）嘅直播商品都包（真 liveDate 範圍查詢，
 *   唔係齋靠場次 DTO）。
 * ─ { mode: "search"; query }：直接商品搜尋（名／SKU，1–60 字），普通商品及
 *   直播商品都搵到；week/session/date/auto 只針對直播商品。
 *
 * 生成 selection：
 * ─ auto／省略：由本週向過去逐週搵最近一個有 ≥2 件合資格且從未用過商品嘅星期，
 *   然後喺該週合資格池**隨機抽 2–3 件**（3 件優先、得 2 件就 2 件）——
 *   一路搵到最舊直播貨嗰週（週界由真歷史資料 derive，唔設人為上限）；
 *   全歷史都搵唔到 → 409 真錯誤。auto 唔准附 productIds（指定貨要用其他模式）。
 * ─ week/date/session 有 productIds：必須屬該來源，否則 400，**指定貨絕對唔隨機**；
 *   冇 productIds 就由該來源合資格池**隨機抽 2–3 件**，少於 2 件 → 409，
 *   **唔會跨來源 fallback**。
 * ─ products：直接指定商品（普通或直播商品皆可），絕對唔隨機。
 * ─ 舊 top-level productIds 等於 { mode: "products" }；同時傳兩種 → 400。
 * ─ 手動指定（products 或 week/date/session 附 productIds）：最少 2 件唔重複，
 *   **冇上限**（iteration 4 起唔再封頂 3 件）；隨機抽貨先係 2–3 件。
 * ─ SKU：product row／ref／selected 全部帶真實 products.sku（id 仍係內部 key）。
 *
 * 隨機：生成揀貨用可注入 rng（GloGuideQueryOptions.rng，預設 Math.random），
 * 測試可以 seed 出 deterministic 結果。**商品查詢（listGloGuideProducts）唔隨機**——
 * auto 一樣回該週完整 rows 俾 UI 顯示成個隨機池，preview 唔會每次刷新都變。
 *
 * 日期格式：wire（client filter／selection）weekStart 係 YYYY-MM-DD；
 * 經 parseProductFilter／normalizeGenerateSelection 解析後**內部統一 compact
 * YYYYMMDD**（products.liveDate 嘅儲存格式，lexicographic 可比）——
 * 淨係 DTO 邊界（productSources 輸出）先轉返 dash。
 *
 * 永久去重：gloGuideProductUsage（productId PK）。所有選擇 server 重查 DB
 * （商品存在、isActive、stock、delist、有圖、類別、場次歸屬、使用歷史）；
 * 生成及改貨喺 transaction 寫 usage，PK/unique 係並發最終閘（23505 → 可讀 409）。
 * 同一文章可以保留自身商品（excludeArticleId）；其他文章用過嘅永遠唔准再用。
 *
 * DB 存取經 GloGuideProductStore 介面——測試注入 in-memory store 實跑全部
 * 規則（fallback 鏈、去重、同一文章排除自身），唔使掂真 DB。
 */
import { and, desc, eq, gte, inArray, lte, min, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideProductUsage, products } from "@db/schema";
import { publicAiTags } from "./productAiContent";
import {
  GLO_GUIDE_CATEGORIES,
  GLO_GUIDE_PRODUCT_MAX,
  GLO_GUIDE_PRODUCT_MIN,
  GloGuideError,
  addDaysYmd,
  hkWeekRangeYmd,
  isUniqueViolation,
  validateProductSelection,
} from "./gloGuideValidation";

const badRequest = (msg: string) => new GloGuideError(400, "BAD_REQUEST", msg);
const conflict = (msg: string) => new GloGuideError(409, "CONFLICT", msg);

/** search 模式回傳上限 */
export const GLO_GUIDE_SEARCH_LIMIT = 50;

// ──────────────────────────── 凍結 contract 類型 ────────────────────────────

export type GloGuideProductFilter =
  | { mode: "auto" }
  | { mode: "week"; weekStart: string } // wire＝HK Monday YYYY-MM-DD；解析後內部＝compact YYYYMMDD
  | { mode: "session"; liveDate: string; liveSession: string } // YYYYMMDD + real session
  | { mode: "date"; liveDate: string } // YYYYMMDD 成日：所有場次＋blank-session 商品
  | { mode: "search"; query: string }; // direct product search, 1–60 chars

export type GloGuideGenerateSelection =
  | { mode: "auto" }
  | { mode: "week"; weekStart: string; productIds?: number[] } // wire＝YYYY-MM-DD；normalize 後 compact
  | { mode: "session"; liveDate: string; liveSession: string; productIds?: number[] }
  | { mode: "date"; liveDate: string; productIds?: number[] } // YYYYMMDD 成日
  | { mode: "products"; productIds: number[] };

export type GloGuideIneligibleReason =
  | "used"
  | "inactive"
  | "out_of_stock"
  | "delisted"
  | "no_image"
  | "category";

/** SPEC「GloGuideProductRef」：原 WeeklyProductDto 欄＋usedBefore/eligible/ineligibleReason */
export interface GloGuideProductRef {
  id: number;
  /** 真實 products.sku（貨號；id 仍係內部 key） */
  sku: string;
  name: string;
  image: string;
  price: number;
  discountPrice: number | null;
  aiTags: string[];
  liveDate: string | null;
  liveSession: string | null;
  category: string;
  stock: number;
  usedBefore: boolean;
  eligible: boolean;
  ineligibleReason: GloGuideIneligibleReason | null;
}

/** 生成實際揀中嘅商品（同舊 WeeklyProductDto 同形＋sku） */
export interface GloGuideSelectedProduct {
  id: number;
  /** 真實 products.sku */
  sku: string;
  name: string;
  image: string;
  price: number;
  discountPrice: number | null;
  aiTags: string[];
  liveDate: string | null;
  liveSession: string | null;
  category: string;
  stock: number;
}

export interface GloGuideProductSources {
  weeks: Array<{ weekStart: string; weekEnd: string; total: number; eligible: number }>;
  sessions: Array<{ liveDate: string; liveSession: string; total: number; eligible: number }>;
  /** iteration 4：按直播日分組（由真 product rows 計，包冇場次商品），liveDate 新→舊 */
  dates: Array<{ liveDate: string; total: number; eligible: number }>;
}

// ──────────────────────────── DB 存取介面（可注入）────────────────────────────

/** 選擇規則需要嘅最小商品事實（products 行嘅子集） */
export interface GloGuideProductRow {
  id: number;
  /** 真實 products.sku（貨號，WMS／後台顯示用；id 仍係內部 key） */
  sku: string;
  name: string;
  image: string;
  price: number;
  discountPrice: number | null;
  aiTagsRaw: string | null;
  aiTagsEnabled: boolean;
  liveDate: string | null;
  liveSession: string | null;
  category: string;
  stock: number;
  isActive: boolean;
  delistEnabled: boolean;
  delistAt: Date | null;
}

export interface GloGuideProductStore {
  /** 直播商品：liveDate ∈ [startYmd, endYmd]（YYYYMMDD，lexicographic 可比），listedDate 新→舊 */
  liveInRange(startYmd: string, endYmd: string): Promise<GloGuideProductRow[]>;
  /** 指定直播日期＋場次嘅商品，listedDate 新→舊 */
  liveInSession(liveDate: string, liveSession: string): Promise<GloGuideProductRow[]>;
  /** 按 id 攞商品（普通＋直播都得；已刪／唔存在嘅唔會出現） */
  byIds(ids: number[]): Promise<GloGuideProductRow[]>;
  /** 直接搜尋（名／SKU，普通＋直播商品），listedDate 新→舊 */
  search(query: string, limit: number): Promise<GloGuideProductRow[]>;
  /** 使用歷史：productId → firstArticleId（淨係用過嘅商品有行） */
  usageByProduct(ids: number[]): Promise<Map<number, number>>;
  /** 最舊直播商品日期（min liveDate，YYYYMMDD；全庫冇直播貨 → null）——auto fallback／來源概覽嘅真歷史下界 */
  earliestLiveDate(): Promise<string | null>;
}

type Db = ReturnType<typeof getDb>;

function mapProductRow(p: typeof products.$inferSelect): GloGuideProductRow {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    image: p.image,
    price: p.price,
    discountPrice: p.discountPrice,
    aiTagsRaw: p.aiTags,
    aiTagsEnabled: p.aiTagsEnabled,
    liveDate: p.liveDate,
    liveSession: p.liveSession,
    category: p.category,
    stock: p.stock,
    isActive: p.isActive,
    delistEnabled: p.delistEnabled,
    delistAt: p.delistAt,
  };
}

/** 真 DB store（預設）；update 嗰陣傳 transaction executor 入嚟等讀寫同一 tx */
export function defaultProductStore(db?: Db): GloGuideProductStore {
  const d = db ?? getDb();
  return {
    liveInRange: async (startYmd, endYmd) => {
      const rows = await d
        .select()
        .from(products)
        .where(and(gte(products.liveDate, startYmd), lte(products.liveDate, endYmd)))
        .orderBy(desc(products.listedDate), desc(products.id));
      return rows.map(mapProductRow);
    },
    liveInSession: async (liveDate, liveSession) => {
      const rows = await d
        .select()
        .from(products)
        .where(and(eq(products.liveDate, liveDate), eq(products.liveSession, liveSession)))
        .orderBy(desc(products.listedDate), desc(products.id));
      return rows.map(mapProductRow);
    },
    byIds: async (ids) => {
      if (ids.length === 0) return [];
      const rows = await d.select().from(products).where(inArray(products.id, ids));
      return rows.map(mapProductRow);
    },
    search: async (query, limit) => {
      // ILIKE pattern：用戶輸入嘅 %／_／\ 全部 escape，唔會變萬用字元
      const pattern = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const rows = await d
        .select()
        .from(products)
        .where(
          sql`(${products.name} ILIKE ${pattern} ESCAPE '\\' OR ${products.sku} ILIKE ${pattern} ESCAPE '\\')`,
        )
        .orderBy(desc(products.listedDate), desc(products.id))
        .limit(limit);
      return rows.map(mapProductRow);
    },
    usageByProduct: async (ids) => {
      if (ids.length === 0) return new Map();
      const rows = await d
        .select({
          productId: gloGuideProductUsage.productId,
          firstArticleId: gloGuideProductUsage.firstArticleId,
        })
        .from(gloGuideProductUsage)
        .where(inArray(gloGuideProductUsage.productId, ids));
      return new Map(rows.map((r) => [r.productId, r.firstArticleId]));
    },
    earliestLiveDate: async () => {
      const rows = await d.select({ minLiveDate: min(products.liveDate) }).from(products);
      return rows[0]?.minLiveDate ?? null;
    },
  };
}

// ──────────────────────────── 純函數：日期／星期 ────────────────────────────

/** YYYY-MM-DD → YYYYMMDD；格式錯或非真實日期 → null（UTC 純日期運算，香港冇 DST） */
export function dashYmdToCompact(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d, 12));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}${m[2]}${m[3]}`;
}

/** YYYYMMDD → YYYY-MM-DD（唔驗真實性；內部由合法日期砌出嚟） */
export function compactToDashYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** YYYYMMDD 係咪真實日期 */
export function isRealCompactYmd(ymd: string): boolean {
  return dashYmdToCompact(compactToDashYmd(ymd)) === ymd && /^\d{8}$/.test(ymd);
}

/** YYYYMMDD 嗰日嘅香港週一（本週起點，YYYYMMDD） */
export function weekStartOfYmd(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=日 … 6=六
  return addDaysYmd(ymd, -((dow + 6) % 7));
}

/** weekStart 校驗：YYYY-MM-DD＋真實日期＋香港星期一；合格返 compact YYYYMMDD */
export function parseWeekStart(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  const compact = dashYmdToCompact(s);
  if (!compact) throw badRequest("weekStart 要係 YYYY-MM-DD 真實日期（香港星期一）");
  if (weekStartOfYmd(compact) !== compact) {
    throw badRequest("weekStart 要係香港星期一（YYYY-MM-DD）");
  }
  return compact;
}

/** liveDate 校驗：YYYYMMDD＋真實日期 */
export function parseLiveDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{8}$/.test(s) || !isRealCompactYmd(s)) {
    throw badRequest("liveDate 要係 YYYYMMDD 真實日期");
  }
  return s;
}

/** liveSession 校驗：1–16 字非空字串 */
export function parseLiveSession(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || [...s].length > 16) throw badRequest("liveSession 必填（1–16 字）");
  return s;
}

/**
 * 直播商品按香港週（週一起）分組，週次新→舊排；週內保持傳入順序（listedDate 新→舊）。
 * auto fallback＝逐組搵第一個有 ≥2 件合資格未用嘅；冇人為週數上限（由真歷史下界框住）。
 */
export function groupLiveRowsByWeek(
  rows: readonly GloGuideProductRow[],
): Array<{ weekStart: string; rows: GloGuideProductRow[] }> {
  const byWeek = new Map<string, GloGuideProductRow[]>();
  for (const r of rows) {
    if (!r.liveDate) continue;
    const ws = weekStartOfYmd(r.liveDate);
    const list = byWeek.get(ws);
    if (list) list.push(r);
    else byWeek.set(ws, [r]);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([weekStart, weekRows]) => ({ weekStart, rows: weekRows }));
}

// ──────────────────────────── 純函數：合資格判定 ────────────────────────────

export const GLO_GUIDE_INELIGIBLE_LABEL: Record<GloGuideIneligibleReason, string> = {
  used: "曾經用喺其他指南",
  inactive: "已下架",
  out_of_stock: "已缺貨",
  delisted: "已到自動下架時間",
  no_image: "冇商品圖",
  category: "類別唔係服飾／飾品",
};

/** 商品到期自動下架咗未（同公開商品一致：delistEnabled && delistAt <= now） */
export function isDelistedNow(
  p: Pick<GloGuideProductRow, "delistEnabled" | "delistAt">,
  now: Date,
): boolean {
  return p.delistEnabled && p.delistAt !== null && p.delistAt.getTime() <= now.getTime();
}

/**
 * 單件商品嘅唔合資格原因（冇＝null）。優先次序跟 SPEC：used > inactive >
 * out_of_stock > delisted > no_image > category。blockedByUsage 由 caller 計
 * （用過兼唔係同一文章先算數——同一文章可以保留自身商品）。
 */
export function ineligibleReason(
  p: Pick<GloGuideProductRow, "isActive" | "stock" | "image" | "category" | "delistEnabled" | "delistAt">,
  blockedByUsage: boolean,
  now: Date,
): GloGuideIneligibleReason | null {
  if (blockedByUsage) return "used";
  if (!p.isActive) return "inactive";
  if (p.stock <= 0) return "out_of_stock";
  if (isDelistedNow(p, now)) return "delisted";
  if (typeof p.image !== "string" || p.image.trim().length === 0) return "no_image";
  if (!(GLO_GUIDE_CATEGORIES as readonly string[]).includes(p.category)) return "category";
  return null;
}

/**
 * 隨機抽貨：合資格池入面**隨機**抽 2–3 件（3 件優先、得 2 件就 2 件；少於 2 件返空，
 * caller 決定點報錯）。用戶明確規則：「無選或自動產生就隨機選商品」——唔再固定 newest。
 * partial Fisher–Yates 洗牌；rng 可注入（預設 Math.random）俾測試 seed 出 deterministic 結果。
 */
export function pickRandomTwoThree<T>(rows: readonly T[], rng: () => number = Math.random): T[] {
  if (rows.length < GLO_GUIDE_PRODUCT_MIN) return [];
  const take = Math.min(GLO_GUIDE_PRODUCT_MAX, rows.length);
  const pool = [...rows];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = a;
  }
  return pool.slice(0, take);
}

// ──────────────────────────── 純函數：輸入解析 ────────────────────────────

/** 商品查詢 filter 解析（raw 來自 client；壞形狀 → 400）。省略 → auto。輸出內部形式：week weekStart＝compact YYYYMMDD。 */
export function parseProductFilter(raw: unknown): GloGuideProductFilter {
  if (raw === undefined || raw === null) return { mode: "auto" };
  if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest("filter 格式無效");
  const f = raw as Record<string, unknown>;
  switch (f.mode) {
    case "auto":
      return { mode: "auto" };
    case "week":
      return { mode: "week", weekStart: parseWeekStart(f.weekStart) };
    case "session":
      return {
        mode: "session",
        liveDate: parseLiveDate(f.liveDate),
        liveSession: parseLiveSession(f.liveSession),
      };
    case "date":
      return { mode: "date", liveDate: parseLiveDate(f.liveDate) };
    case "search": {
      const query = typeof f.query === "string" ? f.query.trim() : "";
      const len = [...query].length;
      if (len < 1 || len > 60) throw badRequest("搜尋字要 1–60 字");
      return { mode: "search", query };
    }
    default:
      throw badRequest("未知商品來源模式（auto／week／session／date／search）");
  }
}

function optionalPickedIds(raw: unknown): number[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "number")) {
    throw badRequest("productIds 要係數字 array");
  }
  if (raw.length === 0) return undefined;
  const err = validateProductSelection(raw as number[]);
  if (err) throw badRequest(err);
  return raw as number[];
}

/**
 * 生成輸入規範化（SPEC 凍結）：
 * ─ 舊 top-level productIds 等於 { mode: "products", productIds }；
 * ─ selection 同 productIds 同時提供 → 400；
 * ─ 兩樣都冇 → auto。
 */
export function normalizeGenerateSelection(input: {
  selection?: unknown;
  productIds?: number[];
}): GloGuideGenerateSelection {
  const legacy =
    input.productIds !== undefined && input.productIds !== null && input.productIds.length > 0
      ? input.productIds
      : undefined;
  const hasSelection = input.selection !== undefined && input.selection !== null;
  if (hasSelection && legacy) {
    throw badRequest("selection 同 productIds 唔可以同時提供（舊版 productIds 即係 products 模式）");
  }
  if (legacy) {
    const err = validateProductSelection(legacy);
    if (err) throw badRequest(err);
    return { mode: "products", productIds: legacy };
  }
  if (!hasSelection) return { mode: "auto" };
  const s = input.selection as Record<string, unknown>;
  if (typeof s !== "object" || Array.isArray(s)) throw badRequest("selection 格式無效");
  switch (s.mode) {
    case "auto": {
      // auto 永遠隨機抽 2–3 件：附 productIds 即 400（指定貨要用 week/date/session/products 模式）
      const ids = optionalPickedIds(s.productIds);
      if (ids) throw badRequest("auto 模式唔准指定商品（自動生成會隨機抽 2–3 件）");
      return { mode: "auto" };
    }
    case "week": {
      const sel: GloGuideGenerateSelection = {
        mode: "week",
        weekStart: parseWeekStart(s.weekStart), // 內部 compact YYYYMMDD
      };
      const ids = optionalPickedIds(s.productIds);
      if (ids) sel.productIds = ids;
      return sel;
    }
    case "session": {
      const sel: GloGuideGenerateSelection = {
        mode: "session",
        liveDate: parseLiveDate(s.liveDate),
        liveSession: parseLiveSession(s.liveSession),
      };
      const ids = optionalPickedIds(s.productIds);
      if (ids) sel.productIds = ids;
      return sel;
    }
    case "date": {
      const sel: GloGuideGenerateSelection = {
        mode: "date",
        liveDate: parseLiveDate(s.liveDate),
      };
      const ids = optionalPickedIds(s.productIds);
      if (ids) sel.productIds = ids;
      return sel;
    }
    case "products": {
      const ids = optionalPickedIds(s.productIds);
      if (!ids) throw badRequest("products 模式要直接指定最少 2 件商品");
      return { mode: "products", productIds: ids };
    }
    default:
      throw badRequest("未知生成模式（auto／week／session／date／products）");
  }
}

// ──────────────────────────── 查詢：商品 refs／來源概覽 ────────────────────────────

function toRef(
  row: GloGuideProductRow,
  usage: Map<number, number>,
  now: Date,
): GloGuideProductRef {
  const usedBefore = usage.has(row.id);
  const reason = ineligibleReason(row, usedBefore, now);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    image: row.image,
    price: row.price,
    discountPrice: row.discountPrice,
    aiTags: publicAiTags(row.aiTagsRaw, row.aiTagsEnabled),
    liveDate: row.liveDate,
    liveSession: row.liveSession,
    category: row.category,
    stock: row.stock,
    usedBefore,
    eligible: reason === null,
    ineligibleReason: reason,
  };
}

function toSelected(row: GloGuideProductRow): GloGuideSelectedProduct {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    image: row.image,
    price: row.price,
    discountPrice: row.discountPrice,
    aiTags: publicAiTags(row.aiTagsRaw, row.aiTagsEnabled),
    liveDate: row.liveDate,
    liveSession: row.liveSession,
    category: row.category,
    stock: row.stock,
  };
}

export interface GloGuideQueryOptions {
  now?: Date;
  store?: GloGuideProductStore;
  /** 隨機抽貨用嘅 RNG（[0,1)）；預設 Math.random。測試注入 seed RNG 得 deterministic 結果 */
  rng?: () => number;
}

/**
 * 商品查詢（SPEC 商品查詢段）：
 * ─ auto：只回傳最近一個有 ≥2 件合資格未用商品嘅週次；冇 → 空 array；
 *   **回嘅係該週完整 rows（唔隨機）**——UI 用佢顯示成個隨機池，preview 唔會每次刷新變；
 *   真正隨機抽 2–3 件只發生喺生成（resolveGenerateProducts）。
 * ─ week/session/date/search：可回傳不符合條件商品（eligible=false＋原因）作 disabled 解釋；
 *   server 生成時仍會重新驗證（resolveGenerateProducts）。
 * ─ date：真 liveDate 範圍 [liveDate, liveDate] 查詢——嗰日**所有場次**＋冇場次
 *   （liveSession 空）嘅直播商品都包，唔係齋靠場次 DTO。
 */
export async function listGloGuideProducts(
  rawFilter: unknown,
  options: GloGuideQueryOptions = {},
): Promise<GloGuideProductRef[]> {
  const filter = parseProductFilter(rawFilter);
  const store = options.store ?? defaultProductStore();
  const now = options.now ?? new Date();

  if (filter.mode === "auto") {
    // 由本週向過去逐週（週界由最舊直播貨 derive，唔設上限）；一次查晒範圍再喺記憶體逐週行
    const earliest = await store.earliestLiveDate();
    if (!earliest) return [];
    const { end } = hkWeekRangeYmd(now);
    const rows = await store.liveInRange(weekStartOfYmd(earliest), end);
    const usage = await store.usageByProduct(rows.map((r) => r.id));
    for (const week of groupLiveRowsByWeek(rows)) {
      const eligibleCount = week.rows.filter(
        (r) => ineligibleReason(r, usage.has(r.id), now) === null,
      ).length;
      if (eligibleCount >= GLO_GUIDE_PRODUCT_MIN) {
        return week.rows.map((r) => toRef(r, usage, now));
      }
    }
    return [];
  }

  const rows =
    filter.mode === "week"
      ? await store.liveInRange(filter.weekStart, addDaysYmd(filter.weekStart, 6))
      : filter.mode === "session"
        ? await store.liveInSession(filter.liveDate, filter.liveSession)
        : filter.mode === "date"
          ? await store.liveInRange(filter.liveDate, filter.liveDate)
          : await store.search(filter.query, GLO_GUIDE_SEARCH_LIMIT);
  const usage = await store.usageByProduct(rows.map((r) => r.id));
  return rows.map((r) => toRef(r, usage, now));
}

/**
 * 來源概覽（SPEC productSources；staff 可查）：由最舊直播貨至本週嘅全部星期＋
 * 場次＋直播日（iteration 4）真實選項（唔設週窗上限，舊場次一樣揀到），
 * 每個選項附 total／eligible 數。dates 由真 product rows 按 liveDate 分組——
 * 冇場次（blank session）嘅商品一樣計入嗰日。
 */
export async function listGloGuideProductSources(
  options: GloGuideQueryOptions = {},
): Promise<GloGuideProductSources> {
  const store = options.store ?? defaultProductStore();
  const now = options.now ?? new Date();
  const earliest = await store.earliestLiveDate();
  if (!earliest) return { weeks: [], sessions: [], dates: [] };
  const current = hkWeekRangeYmd(now);
  const rows = await store.liveInRange(weekStartOfYmd(earliest), current.end);
  const usage = await store.usageByProduct(rows.map((r) => r.id));

  const weekMap = new Map<string, { total: number; eligible: number }>();
  const sessionMap = new Map<
    string,
    { liveDate: string; liveSession: string; total: number; eligible: number }
  >();
  const dateMap = new Map<string, { total: number; eligible: number }>();
  for (const row of rows) {
    if (!row.liveDate) continue;
    const ok = ineligibleReason(row, usage.has(row.id), now) === null;
    const ws = weekStartOfYmd(row.liveDate);
    const w = weekMap.get(ws) ?? { total: 0, eligible: 0 };
    w.total += 1;
    if (ok) w.eligible += 1;
    weekMap.set(ws, w);
    // 日期分組唔理場次（blank session 都計）
    const d = dateMap.get(row.liveDate) ?? { total: 0, eligible: 0 };
    d.total += 1;
    if (ok) d.eligible += 1;
    dateMap.set(row.liveDate, d);
    const session = row.liveSession?.trim();
    if (session) {
      const key = `${row.liveDate} ${session}`;
      const s =
        sessionMap.get(key) ?? { liveDate: row.liveDate, liveSession: session, total: 0, eligible: 0 };
      s.total += 1;
      if (ok) s.eligible += 1;
      sessionMap.set(key, s);
    }
  }
  const weeks = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([start, v]) => ({
      weekStart: compactToDashYmd(start),
      weekEnd: compactToDashYmd(addDaysYmd(start, 6)),
      total: v.total,
      eligible: v.eligible,
    }));
  const sessions = [...sessionMap.values()].sort(
    (a, b) =>
      (a.liveDate < b.liveDate ? 1 : a.liveDate > b.liveDate ? -1 : 0) ||
      (a.liveSession < b.liveSession ? 1 : -1),
  );
  const dates = [...dateMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([liveDate, v]) => ({ liveDate, total: v.total, eligible: v.eligible }));
  return { weeks, sessions, dates };
}

// ──────────────────────────── 生成揀貨（server 重查＋歷史閘）────────────────────────────

export interface ResolvedGloGuideProducts {
  /** 實際揀中嘅商品（隨機抽 2–3 件；手動指定 ≥2 件，順序跟輸入） */
  products: GloGuideSelectedProduct[];
  /** 已喺 usage 表且 firstArticleId == excludeArticleId（同一文章保留自身商品；update 唔使再 claim） */
  selfClaimedIds: number[];
}

/**
 * 逐件重查合資格＋歷史（week/date/session 指定貨同 products 模式共用）：
 * ─ 其他文章用過 → 409（永久去重，並發最終閘係 DB PK）；
 * ─ inactive／缺貨／到期下架／無圖／類別唔啱 → 400 真錯誤；
 * ─ 同一文章（excludeArticleId）自身用過嘅 → 放行兼記入 selfClaimedIds。
 */
function assertEligibleRows(
  rows: GloGuideProductRow[],
  usage: Map<number, number>,
  now: Date,
  excludeArticleId?: number,
): { products: GloGuideSelectedProduct[]; selfClaimedIds: number[] } {
  const selfClaimedIds: number[] = [];
  const out: GloGuideSelectedProduct[] = [];
  for (const row of rows) {
    const usedBy = usage.get(row.id);
    if (usedBy !== undefined && usedBy !== excludeArticleId) {
      throw conflict(`商品 ${row.id}「${row.name}」曾用於其他指南（#${usedBy}），唔可以重用`);
    }
    const reason = ineligibleReason(row, false, now);
    if (reason) throw badRequest(`商品 ${row.id}「${row.name}」${GLO_GUIDE_INELIGIBLE_LABEL[reason]}，唔可以揀`);
    if (usedBy === excludeArticleId && excludeArticleId !== undefined) selfClaimedIds.push(row.id);
    out.push(toSelected(row));
  }
  return { products: out, selfClaimedIds };
}

/**
 * 生成揀貨（SPEC 生成段）——server 對所有選擇重查商品、庫存、active/delist/image/
 * category、場次歸屬及歷史：
 * ─ auto：由香港本週向過去逐週 fallback 到最近一個有 ≥2 件合資格未用貨嘅星期，
 *   然後喺該週合資格池**隨機抽 2–3 件**（rng 可注入，預設 Math.random）；
 * ─ week/date/session 有 productIds：必須屬該來源，**指定貨絕對唔隨機**（≥2 件，冇上限）；
 *   冇就由該來源合資格池**隨機抽 2–3 件**，少於 2 件 → 409，唔跨來源 fallback；
 *   date 來源＝嗰日 liveDate 範圍（所有場次＋blank-session 商品都屬該來源）；
 * ─ products：直接指定 ≥2 件（冇上限；普通或直播商品皆可），絕對唔隨機；
 * ─ excludeArticleId：update 用——同一文章可以保留自身商品。
 */
export async function resolveGenerateProducts(
  selection: GloGuideGenerateSelection,
  options: GloGuideQueryOptions & { excludeArticleId?: number } = {},
): Promise<ResolvedGloGuideProducts> {
  const store = options.store ?? defaultProductStore();
  const now = options.now ?? new Date();
  const exclude = options.excludeArticleId;
  const rng = options.rng ?? Math.random;

  switch (selection.mode) {
    case "auto": {
      // 由香港本週向過去逐週 fallback，一路搵到最舊直播貨嗰週（週界由真歷史 derive，唔設上限）
      const earliest = await store.earliestLiveDate();
      if (earliest) {
        const { end } = hkWeekRangeYmd(now);
        const rows = await store.liveInRange(weekStartOfYmd(earliest), end);
        const usage = await store.usageByProduct(rows.map((r) => r.id));
        for (const week of groupLiveRowsByWeek(rows)) {
          const eligible = week.rows.filter(
            (r) => ineligibleReason(r, usage.has(r.id), now) === null,
          );
          const picked = pickRandomTwoThree(eligible, rng);
          if (picked.length >= GLO_GUIDE_PRODUCT_MIN) {
            return { products: picked.map(toSelected), selfClaimedIds: [] };
          }
        }
      }
      throw conflict(
        `由本週搵到最舊直播貨都冇至少 ${GLO_GUIDE_PRODUCT_MIN} 件從未用過嘅合資格直播商品（上架中、有貨、有圖嘅服飾／飾品）`,
      );
    }
    case "week":
    case "session":
    case "date": {
      const rows =
        selection.mode === "week"
          ? await store.liveInRange(selection.weekStart, addDaysYmd(selection.weekStart, 6))
          : selection.mode === "session"
            ? await store.liveInSession(selection.liveDate, selection.liveSession)
            : await store.liveInRange(selection.liveDate, selection.liveDate);
      const usage = await store.usageByProduct(rows.map((r) => r.id));
      const label =
        selection.mode === "week"
          ? `指定星期（${compactToDashYmd(selection.weekStart)} 嗰週）`
          : selection.mode === "session"
            ? `指定場次（${selection.liveDate} 第 ${selection.liveSession} 場）`
            : `指定日期（${selection.liveDate}）`;
      if (selection.productIds && selection.productIds.length > 0) {
        const byId = new Map(rows.map((r) => [r.id, r]));
        const chosen = selection.productIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw badRequest(`商品 ${id} 唔屬於${label}，唔可以跨來源揀貨`);
          return row;
        });
        return assertEligibleRows(chosen, usage, now, exclude);
      }
      const eligible = rows.filter((r) => ineligibleReason(r, usage.has(r.id), now) === null);
      // 未指定 productIds：由該來源合資格池隨機抽（指定咗嘅上面行 assertEligibleRows，絕唔隨機）
      const picked = pickRandomTwoThree(eligible, rng);
      if (picked.length < GLO_GUIDE_PRODUCT_MIN) {
        throw conflict(`${label}唔夠 ${GLO_GUIDE_PRODUCT_MIN} 件從未用過嘅合資格商品（唔會跨來源揀貨）`);
      }
      return { products: picked.map(toSelected), selfClaimedIds: [] };
    }
    case "products": {
      const err = validateProductSelection(selection.productIds);
      if (err) throw badRequest(err);
      const rows = await store.byIds(selection.productIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const chosen = selection.productIds.map((id) => {
        const row = byId.get(id);
        if (!row) throw badRequest(`商品 ${id} 唔存在或已刪除`);
        return row;
      });
      const usage = await store.usageByProduct(selection.productIds);
      return assertEligibleRows(chosen, usage, now, exclude);
    }
  }
}

// ──────────────────────────── 永久使用歷史寫入 ────────────────────────────

/** usage PK/unique violation 判定（PK 名由 Postgres 生成，大小寫兩種都試） */
export function isProductUsageViolation(e: unknown): boolean {
  return (
    isUniqueViolation(e, "gloGuideProductUsage") || isUniqueViolation(e, "gloguideproductusage")
  );
}

/**
 * 同一 transaction 寫使用歷史（永久留底，文章改貨唔會刪）。
 * 撞 PK＝並發重用（另一篇指南啱啱搶先）→ 轉可讀 409 conflict；其他錯照抛。
 * 同一文章保留自身商品嗰啲唔會傳入嚟（caller 已過濾 selfClaimedIds）。
 */
export async function claimProductUsage(
  executor: Pick<Db, "insert">,
  articleId: number,
  productIds: readonly number[],
): Promise<void> {
  if (productIds.length === 0) return;
  try {
    await executor.insert(gloGuideProductUsage).values(
      productIds.map((productId) => ({ productId, firstArticleId: articleId })),
    );
  } catch (e) {
    if (isProductUsageViolation(e)) {
      throw conflict("有商品啱啱被其他指南搶先使用，請重新揀貨");
    }
    throw e;
  }
}
