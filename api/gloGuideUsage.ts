/**
 * Glo Glo 精選文章——用量及估算成本模組（官網 /admin「精選文章」後台專用）。
 *
 * 設計合同：
 * ─ 成本單價存 siteSettings key="glo_guide_usage_rules"（JSON），由管理員**明確輸入**；
 *   預設 null＝未知。絕對唔會默認用 AI 試穿價錢或任何網上估價；壞資料一律當未知，
 *   唔會靜靜雞當免費。0 係合法值——代表管理員明確設定咗免費。
 * ─ 每個新 gloGuideJob 喺建立當刻將估算成本 snapshot 寫入 payload JSONB 內部欄
 *   （estimatedCostCents）；之後改單價絕對唔影響歷史 job，舊 job 冇 snapshot 就係未知，
 *   唔准用現時單價回填。payload 係內部欄，唔入公開 DTO。
 * ─ full／scheduled parent 算一次文字生成；article（重生）算一次文字；image child／
 *   standalone image 各算一張圖。recordFailedScheduledSlot 呢種未開始 provider 嘅失敗
 *   明確 snapshot 0＋costNotStarted，唔當有生成成本。
 * ─ 統計用 gloGuideJobs.createdAt 按香港時間（固定 UTC+8，唔依賴主機時區）分
 *   今日／今月／今年三桶彙總；圖「已生成」以 completed image jobs 計歷史生成量——
 *   圖之後刪除都照計（係「曾經生成過」嘅工作量，唔等於而家現存圖數）。
 * ─ 所有金額係**估算成本**（整數仙），唔係供應商實收；active 工作嘅估算成本單列
 *   reservedCostCents（預留中），已結束工作單列 finishedCostCents；冇 snapshot 嘅
 *   job 明確計入 unknownCostJobs。
 */
import { desc, eq, gte } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { gloGuideArticles, gloGuideJobs, siteSettings } from "@db/schema";

export const GLO_GUIDE_USAGE_SETTING_KEY = "glo_guide_usage_rules";

/** 單次工作估算成本上限（仙）＝ HK$1,000——zod 同 parse 共用嘅合理上限 */
export const GLO_GUIDE_USAGE_MAX_CENTS = 100_000;

export interface GloGuideUsageSettings {
  /** 每次配搭圖生成工作（image job）嘅估算成本（整數仙）；null＝管理員未設定（未知） */
  imageCostCents: number | null;
  /** 每次完整文章／文字生成工作（full／scheduled／article job）嘅估算成本（整數仙）；null＝未知 */
  textCostCents: number | null;
}

/** 預設：兩樣都未知——管理員未輸入前絕對唔准估價 */
export const DEFAULT_GLO_GUIDE_USAGE_SETTINGS: GloGuideUsageSettings = {
  imageCostCents: null,
  textCostCents: null,
};

/** 合法成本：非負整數仙，≤ 上限；0＝明確免費；其他一律視為未知（null） */
function sanitizeCents(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value) || value < 0 || value > GLO_GUIDE_USAGE_MAX_CENTS) return null;
  return value;
}

/**
 * 解析 siteSettings 入面嘅用量規則（容錯）：JSON 壞咗／欄位唔合法 → 對應項未知（null）。
 * 絕對唔會喺呢度填任何預估數字。
 */
export function parseGloGuideUsageSettings(raw: unknown): GloGuideUsageSettings {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_GLO_GUIDE_USAGE_SETTINGS };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...DEFAULT_GLO_GUIDE_USAGE_SETTINGS };
  }
  const o = obj as Record<string, unknown>;
  return {
    imageCostCents: sanitizeCents(o.imageCostCents),
    textCostCents: sanitizeCents(o.textCostCents),
  };
}

/** 讀用量規則；讀取失敗照抛真錯誤（callers 唔准靜默當免費） */
export async function getGloGuideUsageSettings(): Promise<GloGuideUsageSettings> {
  const db = getDb();
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, GLO_GUIDE_USAGE_SETTING_KEY))
    .limit(1);
  return parseGloGuideUsageSettings(row?.value);
}

/** 寫用量規則（upsert；admin router 負責權限閘＋audit） */
export async function saveGloGuideUsageSettings(settings: GloGuideUsageSettings): Promise<void> {
  const db = getDb();
  const value = JSON.stringify({
    imageCostCents: sanitizeCents(settings.imageCostCents),
    textCostCents: sanitizeCents(settings.textCostCents),
  });
  await db
    .insert(siteSettings)
    .values({ key: GLO_GUIDE_USAGE_SETTING_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

// ──────────────────────────── Job 成本 snapshot ────────────────────────────

/** 用量統計嘅工作分類：完整文章（full/scheduled parent）／文字重生（article）／配搭圖（image） */
export type GloGuideUsageCategory = "article" | "regenerate" | "image";

export function gloGuideJobUsageCategory(kind: string): GloGuideUsageCategory | null {
  if (kind === "full" || kind === "scheduled") return "article";
  if (kind === "article") return "regenerate";
  if (kind === "image") return "image";
  return null;
}

/** 按 job kind 攞對應單價：文字類用 textCostCents；圖用 imageCostCents；未知 kind → null */
export function estimatedCostForKind(kind: string, settings: GloGuideUsageSettings): number | null {
  const category = gloGuideJobUsageCategory(kind);
  if (category === "image") return settings.imageCostCents;
  if (category) return settings.textCostCents;
  return null;
}

/** 建立 job 當刻嘅成本快照（寫入 payload 內部欄；唔入公開 DTO） */
export interface GloGuideJobCostSnapshot {
  /** 整數仙；null＝單價未知（舊 job／管理員未設定都會係 null） */
  estimatedCostCents: number | null;
  /** true＝未開始 provider 嘅失敗（排程 slot 消費），明確冇生成成本 */
  notStarted?: boolean;
}

/** 由現行單價砌快照（kind 唔識 → 成本未知 null，唔會估） */
export function gloGuideJobCostSnapshot(
  kind: string,
  settings: GloGuideUsageSettings,
): GloGuideJobCostSnapshot {
  return { estimatedCostCents: estimatedCostForKind(kind, settings) };
}

/** 讀現行單價＋砌快照；settings 讀取失敗照抛（唔准當免費建立 job） */
export async function snapshotGloGuideJobCost(kind: string): Promise<GloGuideJobCostSnapshot> {
  return gloGuideJobCostSnapshot(kind, await getGloGuideUsageSettings());
}

/** 未開始 provider 嘅排程失敗 slot 專用快照：明確 0＋notStarted，唔使讀單價 */
export function notStartedCostSnapshot(): GloGuideJobCostSnapshot {
  return { estimatedCostCents: 0, notStarted: true };
}

/** 將快照 merge 入 job payload（保留原有欄位；estimatedCostCents 永遠寫，null 都寫） */
export function mergeCostSnapshotPayload(
  payload: Record<string, unknown> | null | undefined,
  snapshot: GloGuideJobCostSnapshot,
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    estimatedCostCents: snapshot.estimatedCostCents,
    ...(snapshot.notStarted ? { costNotStarted: true } : {}),
  };
}

/** 由 job payload 抽成本快照：冇 snapshot／唔合法 → null（成本未知，唔准回填現價） */
export function extractEstimatedCostCents(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return sanitizeCents((payload as Record<string, unknown>).estimatedCostCents);
}

// ──────────────────────────── 香港時間週期（UTC+8，唔依賴主機時區）────────────────────────────

export interface HkPeriods {
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  year: string; // YYYY
  /** 香港今年 1 月 1 日 00:00 對應嘅 UTC 時間（DB 查詢今年區間下限用） */
  yearStartUtc: Date;
}

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 某刻嘅香港日期／月／年（固定 UTC+8） */
export function hkYmdFor(d: Date): { date: string; month: string; year: string } {
  const hk = new Date(d.getTime() + HK_OFFSET_MS).toISOString();
  return { date: hk.slice(0, 10), month: hk.slice(0, 7), year: hk.slice(0, 4) };
}

/** 而家嘅香港週期＋今年起點（UTC） */
export function hkPeriodsFor(now: Date = new Date()): HkPeriods {
  const ymd = hkYmdFor(now);
  const yearStartUtc = new Date(Date.UTC(Number(ymd.year), 0, 1) - HK_OFFSET_MS);
  return { ...ymd, yearStartUtc };
}

// ──────────────────────────── 彙總（純函數，可驗證）────────────────────────────

export interface GloGuideUsageKindBucket {
  total: number;
  completed: number;
  failed: number;
  /** queued／submitted／processing */
  active: number;
  /** 已結束工作（completed＋failed）嘅估算成本總和（仙；只計有 snapshot 嘅 job） */
  finishedCostCents: number;
  /** 生成中工作嘅預留估算成本（仙；只計有 snapshot 嘅 job） */
  reservedCostCents: number;
  /** 冇成本 snapshot 嘅 job 數（舊 job／單價未設定）——成本未知，明確列出 */
  unknownCostJobs: number;
}

export interface GloGuideUsagePeriodBucket {
  article: GloGuideUsageKindBucket;
  regenerate: GloGuideUsageKindBucket;
  image: GloGuideUsageKindBucket;
}

function emptyKindBucket(): GloGuideUsageKindBucket {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    active: 0,
    finishedCostCents: 0,
    reservedCostCents: 0,
    unknownCostJobs: 0,
  };
}

export function emptyUsagePeriodBucket(): GloGuideUsagePeriodBucket {
  return { article: emptyKindBucket(), regenerate: emptyKindBucket(), image: emptyKindBucket() };
}

/** 彙總輸入行（由 gloGuideJobs 抽取；純資料，唔掂 DB） */
export interface GloGuideUsageJobRow {
  kind: string;
  status: string;
  createdAt: Date;
  /** 建立當刻 snapshot（extractEstimatedCostCents）；null＝成本未知 */
  estimatedCostCents: number | null;
}

const ACTIVE_STATUSES = new Set(["queued", "submitted", "processing"]);

/**
 * 將 job 行按香港時間歸入今日／今月／今年三桶彙總（純函數）：
 * ─ 每行用自己建立當刻嘅 snapshot 成本；冇 snapshot → unknownCostJobs++，成本唔計；
 * ─ active 工作成本入 reservedCostCents，已結束入 finishedCostCents，兩者單列唔撈埋；
 * ─ 圖生成量以 completed image jobs 計（歷史工作量；圖之後刪唔刪都唔影響——
 *   彙總根本唔讀 gloGuideImages）。
 */
export function aggregateGloGuideUsage(
  rows: readonly GloGuideUsageJobRow[],
  now: Date = new Date(),
): { periods: HkPeriods; today: GloGuideUsagePeriodBucket; month: GloGuideUsagePeriodBucket; year: GloGuideUsagePeriodBucket } {
  const periods = hkPeriodsFor(now);
  const today = emptyUsagePeriodBucket();
  const month = emptyUsagePeriodBucket();
  const year = emptyUsagePeriodBucket();
  for (const row of rows) {
    const category = gloGuideJobUsageCategory(row.kind);
    if (!category) continue; // 未知 kind 唔入統計（防將來新 kind 被錯誤歸類）
    const ymd = hkYmdFor(row.createdAt);
    const targets: GloGuideUsagePeriodBucket[] = [];
    if (ymd.year === periods.year) targets.push(year);
    if (ymd.month === periods.month) targets.push(month);
    if (ymd.date === periods.date) targets.push(today);
    for (const period of targets) {
      const bucket = period[category];
      bucket.total++;
      const active = ACTIVE_STATUSES.has(row.status);
      if (active) bucket.active++;
      else if (row.status === "completed") bucket.completed++;
      else if (row.status === "failed") bucket.failed++;
      if (row.estimatedCostCents === null) {
        bucket.unknownCostJobs++;
      } else if (active) {
        bucket.reservedCostCents += row.estimatedCostCents;
      } else {
        bucket.finishedCostCents += row.estimatedCostCents;
      }
    }
  }
  return { periods, today, month, year };
}

// ──────────────────────────── DB 統計＋最近工作 ────────────────────────────

/** 最近工作 DTO：淨係顯示用欄位——絕對唔回 payload、secret、原圖路徑或 provider 內部細節 */
export interface GloGuideRecentJobDto {
  publicId: string;
  kind: string;
  status: string;
  articleTitle: string | null;
  error: string | null;
  estimatedCostCents: number | null;
  createdAt: string;
}

/**
 * 管理員用量統計：今年（香港時間）以內嘅 job 彙總三桶＋最近 20 個 job。
 * 兩條查詢都淨係讀 gloGuideJobs（recent 再 join 文章攞標題）；成本全部嚟自
 * job 建立當刻嘅 payload snapshot，唔受而家嘅單價設定影響。
 */
export async function getGloGuideUsageStats(now: Date = new Date()): Promise<{
  periods: HkPeriods;
  today: GloGuideUsagePeriodBucket;
  month: GloGuideUsagePeriodBucket;
  year: GloGuideUsagePeriodBucket;
  recentJobs: GloGuideRecentJobDto[];
}> {
  const db = getDb();
  const periods = hkPeriodsFor(now);
  const rows = await db
    .select({
      kind: gloGuideJobs.kind,
      status: gloGuideJobs.status,
      createdAt: gloGuideJobs.createdAt,
      payload: gloGuideJobs.payload,
    })
    .from(gloGuideJobs)
    .where(gte(gloGuideJobs.createdAt, periods.yearStartUtc));
  const buckets = aggregateGloGuideUsage(
    rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      estimatedCostCents: extractEstimatedCostCents(r.payload),
    })),
    now,
  );
  const recent = await db
    .select({
      publicId: gloGuideJobs.publicId,
      kind: gloGuideJobs.kind,
      status: gloGuideJobs.status,
      error: gloGuideJobs.error,
      payload: gloGuideJobs.payload,
      createdAt: gloGuideJobs.createdAt,
      articleTitle: gloGuideArticles.title,
    })
    .from(gloGuideJobs)
    .leftJoin(gloGuideArticles, eq(gloGuideJobs.articleId, gloGuideArticles.id))
    .orderBy(desc(gloGuideJobs.createdAt), desc(gloGuideJobs.id))
    .limit(20);
  return {
    ...buckets,
    recentJobs: recent.map((r) => ({
      publicId: r.publicId,
      kind: r.kind,
      status: r.status,
      articleTitle: r.articleTitle ?? null,
      error: r.error ?? null,
      estimatedCostCents: extractEstimatedCostCents(r.payload),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
