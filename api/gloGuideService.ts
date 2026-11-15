/**
 * Glo Glo 指南——DB 核心服務（內部 WMS actions 用）。
 *
 * 規矩（SPEC v1）：
 * ─ approve 只接受 pending_review，並喺**單一 transaction** 入面 FOR UPDATE 重讀＋
 *   重驗全部硬閘（gloGuideValidation.evaluateGloGuideGate）先設 published；
 * ─ 文章 edit／productIds 改動：status 重置 draft＋全部未刪圖 reviewStatus 重置 pending；
 * ─ 每個 mutating action 都 logAudit（actor、時間、target、結果／錯誤）；
 * ─ 失敗一律 throw GloGuideError（真錯誤訊息＋HTTP status），絕不假成功；
 * ─ 生成 job 用 idempotencyKey unique 擋重複；kick 由 gloGuideOrchestrator 背景執行。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import pathModule from "node:path";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import {
  gloGuideArticleProducts,
  gloGuideArticles,
  gloGuideImages,
  gloGuideJobs,
  gloGuideModelImages,
  products,
} from "@db/schema";
import { logAudit } from "./audit";
import { publicAiTags } from "./productAiContent";
import { saveGloGuideModelImage } from "./gloGuideMedia";
import {
  buildGloGuideSlug,
  evaluateGloGuideGate,
  GLO_GUIDE_CATEGORIES,
  GLO_GUIDE_IMAGE_MAX,
  GLO_GUIDE_MODEL_IMAGE_MAX,
  gloGuidePublishedMutationError,
  hkWeekRangeYmd,
  isGloGuideAction,
  isGloGuideImagePath,
  isGloGuideModelImagePath,
  GLO_GUIDE_MODEL_IMAGE_PREFIX,
  GLO_GUIDE_PATH_PREFIX,
  archiveArticleError,
  isUniqueViolation,
  modelImageDefaultAfterDelete,
  resolveGenerateJobParams,
  resolveModelImageDefault,
  normalizeThemeKey,
  sanitizeGloGuideBody,
  sanitizeGloGuideLine,
  themeKeyConflicts,
  validateGloGuideBody,
  validateGloGuideTheme,
  validateGloGuideTitle,
  validateProductSelection,
  type GloGuideActor,
} from "./gloGuideValidation";
import { hkTodayYmd } from "@contracts/livePublicSummary";
import type { GloGuideProviders } from "./gloGuideProviders";

// ──────────────────────────── 錯誤 ────────────────────────────

export class GloGuideError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.name = "GloGuideError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
const badRequest = (msg: string) => new GloGuideError(400, "BAD_REQUEST", msg);
const notFound = (msg = "搵唔到呢篇指南") => new GloGuideError(404, "NOT_FOUND", msg);
const conflict = (msg: string) => new GloGuideError(409, "CONFLICT", msg);

// ──────────────────────────── 環境 ────────────────────────────

/** 模特兒參考圖：GLO_GUIDE_MODEL_IMAGE_URLS（逗號分隔，https 或站內絕對路徑）第一個；預設 /gloglo-3.jpg */
export function gloGuideModelImage(): { ref: string; absoluteUrl: string } {
  const raw = process.env.GLO_GUIDE_MODEL_IMAGE_URLS?.trim();
  const first = raw ? raw.split(",")[0]?.trim() : "";
  const ref = first && (/^https:\/\//i.test(first) || first.startsWith("/")) ? first : "/gloglo-3.jpg";
  const base = (process.env.PUBLIC_BASE_URL || "https://redcode.red").replace(/\/+$/, "");
  return { ref, absoluteUrl: ref.startsWith("/") ? `${base}${ref}` : ref };
}

/**
 * 新文章 modelImage snapshot 來源（向後相容）：
 * ─ gloGuideModelImages 有未刪相 → DB 預設相嘅站內私密路徑（/uploads/glo-guide-models/...）；
 * ─ DB 未有任何記錄 → 沿用現有 ENV 第一項／內建 /gloglo-3.jpg（gloGuideModelImage()）。
 * 快照一旦寫入文章就唔會再變——之後刪相／換預設都唔會回寫舊文章。
 */
export async function resolveArticleModelImageRef(): Promise<{
  ref: string;
  source: "db" | "env";
  imageId: number | null;
}> {
  const db = getDb();
  const rows = await db
    .select({
      id: gloGuideModelImages.id,
      path: gloGuideModelImages.path,
      isDefault: gloGuideModelImages.isDefault,
      createdAt: gloGuideModelImages.createdAt,
    })
    .from(gloGuideModelImages)
    .where(isNull(gloGuideModelImages.deletedAt));
  return resolveModelImageDefault(rows, gloGuideModelImage().ref);
}

// ──────────────────────────── 本週可選商品 ────────────────────────────

export interface WeeklyProductDto {
  id: number;
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

/**
 * 本週可選商品：香港本週（週一至週日）liveDate、isActive、stock>0、有真商品圖、
 * 類別限服飾／飾品。自動及手動生成都只可以揀呢批。
 */
export async function listWeeklyProducts(now: Date = new Date()): Promise<WeeklyProductDto[]> {
  const db = getDb();
  const { start, end } = hkWeekRangeYmd(now);
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        // 同公開商品一致：排除已到期自動下架（delistEnabled=false 或 delistAt null 或 >now 先可見）
        or(
          eq(products.delistEnabled, false),
          isNull(products.delistAt),
          gt(products.delistAt, now),
        ),
        sql`${products.liveDate} >= ${start} AND ${products.liveDate} <= ${end}`,
        sql`${products.stock} > 0`,
        inArray(products.category, [...GLO_GUIDE_CATEGORIES]),
      ),
    )
    .orderBy(desc(products.listedDate));
  return rows
    .filter((p) => typeof p.image === "string" && p.image.trim().length > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      image: p.image,
      price: p.price,
      discountPrice: p.discountPrice,
      aiTags: publicAiTags(p.aiTags, p.aiTagsEnabled),
      liveDate: p.liveDate,
      liveSession: p.liveSession,
      category: p.category,
      stock: p.stock,
    }));
}

/** 自動揀貨：最新上架優先，3 件優先、得 2 件就 2 件；少過 2 件 → 錯（唔准生成） */
export function pickAutoProducts(weekly: readonly WeeklyProductDto[]): WeeklyProductDto[] {
  if (weekly.length < 2) return [];
  return weekly.slice(0, Math.min(3, weekly.length));
}

// ──────────────────────────── 主題去重資料 ────────────────────────────

export interface RecentTheme {
  themeKey: string;
  theme: string;
  /** 內容開頭（頭 60 code points；俾生成 prompt 避免換字重用） */
  intro: string;
}

/** 最近 8 篇非 archived 文章嘅主題＋開頭 */
export async function getRecentThemes(excludeArticleId?: number): Promise<RecentTheme[]> {
  const db = getDb();
  const rows = await db
    .select({ id: gloGuideArticles.id, theme: gloGuideArticles.theme, themeKey: gloGuideArticles.themeKey, body: gloGuideArticles.body })
    .from(gloGuideArticles)
    .where(
      and(
        ne(gloGuideArticles.status, "archived"),
        excludeArticleId ? ne(gloGuideArticles.id, excludeArticleId) : undefined,
      ),
    )
    .orderBy(desc(gloGuideArticles.createdAt))
    .limit(8);
  return rows.map((r) => ({
    themeKey: r.themeKey,
    theme: r.theme,
    intro: [...r.body].slice(0, 60).join(""),
  }));
}

/** 主題撞最近 8 篇 → GloGuideError（生成同人手編輯共用） */
export async function assertThemeAvailable(
  theme: string,
  excludeArticleId?: number,
): Promise<{ theme: string; themeKey: string }> {
  const clean = sanitizeGloGuideLine(theme);
  const err = validateGloGuideTheme(clean);
  if (err) throw badRequest(err);
  const themeKey = normalizeThemeKey(clean);
  if (!themeKey) throw badRequest("主題唔可以係空字串");
  const recent = await getRecentThemes(excludeArticleId);
  if (themeKeyConflicts(themeKey, recent.map((r) => r.themeKey))) {
    throw conflict("主題同最近 8 篇指南重複，請換一個角度");
  }
  return { theme: clean, themeKey };
}

// ──────────────────────────── Bundle／內部 DTO ────────────────────────────

type Db = ReturnType<typeof getDb>;

export interface ArticleBundle {
  article: typeof gloGuideArticles.$inferSelect;
  links: (typeof gloGuideArticleProducts.$inferSelect)[];
  /** 現行商品（productId → row；已刪商品唔會喺度） */
  currentProducts: Map<number, typeof products.$inferSelect>;
  images: (typeof gloGuideImages.$inferSelect)[];
  jobs: (typeof gloGuideJobs.$inferSelect)[];
}

async function loadBundle(db: Db, articleId: number): Promise<ArticleBundle | null> {
  const article = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, articleId),
  });
  if (!article) return null;
  const links = await db
    .select()
    .from(gloGuideArticleProducts)
    .where(eq(gloGuideArticleProducts.articleId, articleId))
    .orderBy(gloGuideArticleProducts.position);
  const productIds = links.map((l) => l.productId);
  const productRows = productIds.length
    ? await db.select().from(products).where(inArray(products.id, productIds))
    : [];
  const images = await db
    .select()
    .from(gloGuideImages)
    .where(eq(gloGuideImages.articleId, articleId))
    .orderBy(gloGuideImages.position, gloGuideImages.id);
  const jobs = await db
    .select()
    .from(gloGuideJobs)
    .where(eq(gloGuideJobs.articleId, articleId))
    .orderBy(desc(gloGuideJobs.createdAt))
    .limit(20);
  return { article, links, currentProducts: new Map(productRows.map((p) => [p.id, p])), images, jobs };
}

export async function getArticleBundle(articleId: number): Promise<ArticleBundle> {
  const bundle = await loadBundle(getDb(), articleId);
  if (!bundle) throw notFound();
  return bundle;
}

/** 內部 DTO：圖片逐張帶 drift 標記（sourceProductImage vs 商品現行圖）＋審批狀態 */
export function toInternalArticle(bundle: ArticleBundle) {
  const { article, links, currentProducts, images, jobs } = bundle;
  return {
    id: article.id,
    publicId: article.publicId,
    slug: article.slug,
    title: article.title,
    body: article.body,
    theme: article.theme,
    status: article.status,
    source: article.source,
    generationStatus: article.generationStatus,
    generationError: article.generationError,
    weatherSnapshot: article.weatherSnapshot,
    createdByName: article.createdByName,
    reviewedByName: article.reviewedByName,
    reviewedAt: article.reviewedAt?.toISOString() ?? null,
    rejectionReason: article.rejectionReason,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    products: links.map((l) => {
      const cur = currentProducts.get(l.productId) ?? null;
      return {
        productId: l.productId,
        position: l.position,
        productNameSnapshot: l.productNameSnapshot,
        sourceImageSnapshot: l.sourceImageSnapshot,
        current: cur
          ? {
              name: cur.name,
              image: cur.image,
              // WMS 原商品卡要原圖＋全部相＋已批標籤＋尺寸選項（驗收 v2 對照用）
              photos: cur.photos && cur.photos.length > 0 ? [...cur.photos] : [cur.image],
              aiTags: publicAiTags(cur.aiTags, cur.aiTagsEnabled),
              sizeEnabled: cur.sizeEnabled,
              sizes: (cur.sizes ?? "").split(",").map((s) => s.trim()).filter(Boolean),
              price: cur.price,
              discountPrice: cur.discountPrice,
              stock: cur.stock,
              isActive: cur.isActive,
              liveDate: cur.liveDate,
              liveSession: cur.liveSession,
              category: cur.category,
            }
          : null,
        /** 商品原圖 drift：改咗圖 → 對應生成圖要重生 */
        imageDrifted: cur ? l.sourceImageSnapshot !== cur.image : true,
      };
    }),
    images: images
      .filter((img) => !img.deletedAt)
      .map((img) => {
        const cur = img.productId !== null ? currentProducts.get(img.productId) : undefined;
        return {
          id: img.id,
          publicId: img.publicId,
          productId: img.productId,
          path: img.path,
          width: img.width,
          height: img.height,
          sourceProductImage: img.sourceProductImage,
          status: img.status,
          reviewStatus: img.reviewStatus,
          error: img.error,
          position: img.position,
          version: img.version,
          reviewedByName: img.reviewedByName,
          reviewedAt: img.reviewedAt?.toISOString() ?? null,
          imageDrifted: cur ? img.sourceProductImage !== cur.image : true,
        };
      }),
    jobs: jobs.map((j) => ({
      id: j.id,
      publicId: j.publicId,
      kind: j.kind,
      status: j.status,
      imageId: j.imageId,
      attempts: j.attempts,
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
  };
}

/** 內部列表：最近 100 篇＋images/products/jobs 摘要 */
export async function listArticleSummaries(input: { status?: string; limit?: number }) {
  const db = getDb();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const validStatus = ["draft", "pending_review", "published", "rejected", "archived"];
  const rows = await db
    .select()
    .from(gloGuideArticles)
    .where(
      input.status && validStatus.includes(input.status)
        ? eq(gloGuideArticles.status, input.status)
        : undefined,
    )
    .orderBy(desc(gloGuideArticles.createdAt))
    .limit(limit);
  const out = [];
  for (const article of rows) {
    const bundle = await loadBundle(db, article.id);
    if (!bundle) continue;
    const liveImages = bundle.images.filter((i) => !i.deletedAt);
    out.push({
      ...toInternalArticle({ ...bundle, images: liveImages }),
      summary: {
        products: bundle.links.length,
        images: liveImages.length,
        imagesApproved: liveImages.filter((i) => i.reviewStatus === "approved").length,
        jobsActive: bundle.jobs.filter((j) => ["queued", "submitted", "processing"].includes(j.status)).length,
        jobsFailed: bundle.jobs.filter((j) => j.status === "failed").length,
      },
    });
  }
  return out;
}

// ──────────────────────────── Job 建立（idempotent）────────────────────────────

/**
 * 建 job：idempotencyKey unique 撞咗 → 返已存在嘅 job（created=false），唔會重複生成。
 * 可傳 executor（transaction）令 job 同文章／links 同一交易落 DB（M4：唔會 orphan）。
 * L9：unique 撞用 code=23505＋constraint 名判定，唔齋靠 message。
 */
export async function createGloGuideJob(
  input: {
    articleId: number;
    imageId?: number | null;
    kind: "scheduled" | "full" | "article" | "image";
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  },
  executor?: Pick<Db, "insert">,
): Promise<{ job: typeof gloGuideJobs.$inferSelect; created: boolean }> {
  const db = getDb();
  try {
    const [job] = await (executor ?? db)
      .insert(gloGuideJobs)
      .values({
        publicId: randomUUID(),
        articleId: input.articleId,
        imageId: input.imageId ?? null,
        kind: input.kind,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? null,
      })
      .returning();
    return { job, created: true };
  } catch (e) {
    // 喺 transaction 入面：Postgres 一錯成個 tx 已 abort，唔可以喺度補救——照抛俾外層
    // rollback 後用 key 查返已存在 job（M4：冚唔到、唔會 orphan）。
    if (executor) throw e;
    // 非 transaction 調用：unique 撞 key → 攞返舊 job（idempotent；唔係 unique 錯就照抛）
    if (!isUniqueViolation(e, "gloguidejobs_idempotency")) throw e;
    const existing = await db.query.gloGuideJobs.findFirst({
      where: eq(gloGuideJobs.idempotencyKey, input.idempotencyKey),
    });
    if (!existing) throw e;
    return { job: existing, created: false };
  }
}

/** 背景 kick 生成（lazy import 避免循環依賴；失敗淨係 log，job 狀態會喺 orchestrator 落 DB） */
function kickJob(jobId: number): void {
  void import("./gloGuideOrchestrator")
    .then((m) => m.runGloGuideJob(jobId))
    .catch((e) => console.error(`[glo-guide] kick job ${jobId} 失敗:`, e));
}

/** 未刪圖 reviewStatus 全部重置 pending（文章／商品改動後要重新逐張人工審） */
async function resetImagesPending(
  executor: Pick<Db, "update">,
  articleId: number,
): Promise<void> {
  await executor
    .update(gloGuideImages)
    .set({ reviewStatus: "pending", reviewedById: null, reviewedByName: null, reviewedAt: null, updatedAt: new Date() })
    .where(and(eq(gloGuideImages.articleId, articleId), isNull(gloGuideImages.deletedAt)));
}

/** 由 DB 行組閘口輸入（submit／approve 喺 transaction 重讀後用呢個） */
function gateInputFrom(bundle: {
  article: typeof gloGuideArticles.$inferSelect;
  links: (typeof gloGuideArticleProducts.$inferSelect)[];
  currentProducts: Map<number, typeof products.$inferSelect>;
  images: (typeof gloGuideImages.$inferSelect)[];
}) {
  const now = new Date();
  return {
    title: bundle.article.title,
    body: bundle.article.body,
    theme: bundle.article.theme,
    status: bundle.article.status,
    // 關聯行數 vs 仲存在嘅商品數：刪貨會令 products 靜靜雞少咗，閘口要揚聲
    linkedCount: bundle.links.length,
    products: bundle.links
      .map((l) => bundle.currentProducts.get(l.productId))
      .filter((p): p is typeof products.$inferSelect => !!p)
      .map((p) => ({
        id: p.id,
        image: p.image,
        isActive: p.isActive,
        stock: p.stock,
        delisted: p.delistEnabled && p.delistAt !== null && p.delistAt <= now,
      })),
    images: bundle.images.map((img) => ({
      productId: img.productId,
      path: img.path,
      sourceProductImage: img.sourceProductImage,
      status: img.status,
      reviewStatus: img.reviewStatus,
      width: img.width,
      height: img.height,
      reviewedById: img.reviewedById,
      reviewedAt: img.reviewedAt,
      deletedAt: img.deletedAt,
    })),
  };
}

// ──────────────────────────── article.generate ────────────────────────────

/**
 * article.generate {productIds?, themeHint?}：
 * 揀貨（手動揀一定要係本週可選；冇俾就自動揀最新 2–3 件）→ 建 draft 文章（生成中）→
 * 建 full job（idempotent）→ 背景跑完整文章＋圖片生成。
 */
export async function generateArticle(
  actor: GloGuideActor,
  input: { productIds?: number[]; themeHint?: string },
  options?: { source?: "manual" | "auto"; jobKind?: "full" | "scheduled"; idempotencyKey?: string },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const weekly = await listWeeklyProducts();
  const weeklyById = new Map(weekly.map((p) => [p.id, p]));
  let chosen: WeeklyProductDto[];
  if (input.productIds && input.productIds.length > 0) {
    const selErr = validateProductSelection(input.productIds);
    if (selErr) throw badRequest(selErr);
    for (const id of input.productIds) {
      if (!weeklyById.has(id)) throw badRequest(`商品 ${id} 唔係本週可選貨（要本週直播、上架中、有貨、有圖嘅服飾／飾品）`);
    }
    chosen = input.productIds.map((id) => weeklyById.get(id)!);
  } else {
    chosen = pickAutoProducts(weekly);
    if (chosen.length === 0) throw conflict("本週冇足夠可選商品（最少 2 件本週直播、有貨、有圖嘅服飾／飾品）");
  }

  const publicId = randomUUID();
  // 模特兒原圖快照：DB 有預設用預設，未上傳過就沿用 ENV 第一項／內建 /gloglo-3.jpg。
  // snapshot 喺建文當刻寫死——之後後台刪相／換預設都唔會郁呢篇。
  const modelSnap = await resolveArticleModelImageRef();
  // source／jobKind／idempotencyKey 一定要跟 options（排程 slot unique key 靠呢度落 DB，
  // 唔係 scheduler 每 5 分鐘會搵唔到 slotKey 而重複開文）
  const jobParams = resolveGenerateJobParams(publicId, options);
  // M4：文章＋links＋job 同一個 transaction——job insert 撞 23505 會成個 rollback，
  // 唔會有 orphan 文章／重複 slot；slug 撞 unique 換 rand 重開新 tx 再試（最多 3 次）。
  let created:
    | {
        article: typeof gloGuideArticles.$inferSelect;
        job: typeof gloGuideJobs.$inferSelect;
      }
    | undefined;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const slug = buildGloGuideSlug(hkTodayYmd(), randomBytes(3).toString("hex"));
    try {
      created = await db.transaction(async (tx) => {
        const [article] = await tx
          .insert(gloGuideArticles)
          .values({
            publicId,
            slug,
            // 生成中 placeholder：過唔到發布閘（body 長度），生成完成會被真內容覆蓋
            title: "Glo Glo 指南生成中",
            body: "生成中",
            theme: "生成中",
            themeKey: `__generating__${publicId}`,
            status: "draft",
            source: jobParams.source,
            generationStatus: "queued",
            modelImage: modelSnap.ref,
            createdById: actor.id,
            createdByName: actor.name,
          })
          .returning();
        await tx.insert(gloGuideArticleProducts).values(
          chosen.map((p, i) => ({
            articleId: article.id,
            productId: p.id,
            position: i,
            sourceImageSnapshot: p.image,
            productNameSnapshot: p.name,
          })),
        );
        const createdJob = await createGloGuideJob(
          {
            articleId: article.id,
            kind: jobParams.jobKind,
            idempotencyKey: jobParams.idempotencyKey,
            payload: { themeHint: input.themeHint?.slice(0, 120) ?? null, requestedBy: actor.name },
          },
          tx,
        );
        return { article, job: createdJob.job };
      });
    } catch (e) {
      // idempotencyKey 撞（排程 slot 重入／double-click）→ tx 已 rollback，攞返已存在嘅就算
      if (isUniqueViolation(e, "gloguidejobs_idempotency")) {
        const existing = await db.query.gloGuideJobs.findFirst({
          where: eq(gloGuideJobs.idempotencyKey, jobParams.idempotencyKey),
        });
        if (existing) {
          return toInternalArticle(await getArticleBundle(existing.articleId));
        }
        throw e;
      }
      // slug 撞 → 換 rand 再試
      if (attempt === 2 || !isUniqueViolation(e, "gloguidearticles_slug")) throw e;
    }
  }
  if (!created) throw new GloGuideError(500, "INTERNAL", "建立指南失敗，請再試");
  const { article, job } = created;

  kickJob(job.id);
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleGenerate",
    targetType: "gloGuideArticle",
    targetId: article.id,
    detail: `建立指南 ${article.slug}，商品 ${chosen.map((p) => p.id).join("/")}，job ${job.publicId}`,
  });
  return toInternalArticle(await getArticleBundle(article.id));
}

/**
 * M4b：排程建文前失敗（例如本週可選貨 <2）都要落**可見失敗紀錄**兼消費 slot——
 * 唔係 scheduler 每 5 分鐘會洗版 retry 又冇跡可尋。撞 23505＝slot 已消費，靜音即可。
 */
export async function recordFailedScheduledSlot(slotKey: string, error: string): Promise<void> {
  const db = getDb();
  const publicId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      const [article] = await tx
        .insert(gloGuideArticles)
        .values({
          publicId,
          slug: buildGloGuideSlug(hkTodayYmd(), randomBytes(3).toString("hex")),
          title: "Glo Glo 自動生成失敗",
          body: "生成失敗",
          theme: "生成失敗",
          themeKey: `__failed__${slotKey}`,
          status: "draft",
          source: "auto",
          generationStatus: "failed",
          generationError: error.slice(0, 900),
          createdByName: "系統自動排程",
        })
        .returning();
      await tx.insert(gloGuideJobs).values({
        publicId: randomUUID(),
        articleId: article.id,
        kind: "scheduled",
        status: "failed",
        idempotencyKey: slotKey,
        error: error.slice(0, 900),
        completedAt: new Date(),
      });
    });
    void logAudit({
      actorRole: "system",
      action: "gloGuide.scheduledFailed",
      targetType: "gloGuideJob",
      targetId: slotKey,
      detail: `自動排程建文失敗（slot ${slotKey}）：${error.slice(0, 300)}`,
    });
  } catch (e) {
    // 撞 key＝slot 已消費（成功或失敗過）→ 靜音；其他錯 log 就算，唔阻 scheduler
    if (!isUniqueViolation(e, "gloguidejobs_idempotency")) {
      console.error("[glo-guide] 落排程失敗紀錄失敗:", e);
    }
  }
}

// ──────────────────────────── article.regenerate ────────────────────────────

/** article.regenerate {id, themeHint?}：重寫同一篇文字；status 重置 draft＋圖片 review 重置 pending */
export async function regenerateArticle(
  actor: GloGuideActor,
  input: { id: number; themeHint?: string },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const publicId = await db.transaction(async (tx) => {
    // 同 approve 共用文章行鎖；狀態一定要喺鎖內重讀，唔可以用 tx 外舊快照。
    const locked = await tx.execute(
      sql`SELECT id, status, "generationStatus", "publicId" FROM "gloGuideArticles" WHERE id = ${input.id} FOR UPDATE`,
    );
    const row = locked.rows[0] as
      | { id: number; status: string; generationStatus: string; publicId: string }
      | undefined;
    if (!row) throw notFound();
    if (row.status === "published") {
      throw conflict("已發布指南唔可以直接重生，請先落架");
    }
    if (["queued", "processing"].includes(row.generationStatus)) {
      throw conflict("呢篇指南生成緊，等完成先好重生");
    }
    await tx
      .update(gloGuideArticles)
      .set({
        status: "draft",
        generationStatus: "queued",
        generationError: null,
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(gloGuideArticles.id, input.id));
    await resetImagesPending(tx, input.id);
    return row.publicId;
  });
  const { job } = await createGloGuideJob({
    articleId: input.id,
    kind: "article",
    idempotencyKey: `regen:${publicId}:${randomBytes(4).toString("hex")}`,
    payload: { themeHint: input.themeHint?.slice(0, 120) ?? null, requestedBy: actor.name },
  });
  kickJob(job.id);
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleRegenerate",
    targetType: "gloGuideArticle",
    targetId: input.id,
    detail: `重生指南文字（job ${job.publicId}），圖片審批已重置`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── article.update ────────────────────────────

/**
 * article.update {id, title, body, theme, productIds?}：
 * 全欄位清理＋硬閘＋主題去重；商品改動要本週可選。
 * 任何改動：status → draft、全部未刪圖 reviewStatus → pending（同一 transaction）。
 */
export async function updateArticle(
  actor: GloGuideActor,
  input: { id: number; title: string; body: string; theme: string; productIds?: number[] },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const title = sanitizeGloGuideLine(typeof input.title === "string" ? input.title : "");
  const body = sanitizeGloGuideBody(typeof input.body === "string" ? input.body : "");
  const titleErr = validateGloGuideTitle(title);
  if (titleErr) throw badRequest(titleErr);
  const bodyErr = validateGloGuideBody(body);
  if (bodyErr) throw badRequest(bodyErr);
  const { theme, themeKey } = await assertThemeAvailable(input.theme ?? "", input.id);

  let newLinks: WeeklyProductDto[] | null = null;
  if (input.productIds !== undefined) {
    const selErr = validateProductSelection(input.productIds);
    if (selErr) throw badRequest(selErr);
    const weekly = await listWeeklyProducts();
    const weeklyById = new Map(weekly.map((p) => [p.id, p]));
    newLinks = input.productIds.map((id) => {
      const p = weeklyById.get(id);
      if (!p) throw badRequest(`商品 ${id} 唔係本週可選貨`);
      return p;
    });
  }

  await db.transaction(async (tx) => {
    // 鎖內重驗：approve 先 commit 嘅話，呢度會見到 published 而拒絕；反之 approve 會等鎖再見到 draft。
    const locked = await tx.execute(
      sql`SELECT id, status, "generationStatus" FROM "gloGuideArticles" WHERE id = ${input.id} FOR UPDATE`,
    );
    const existing = locked.rows[0] as
      | { id: number; status: string; generationStatus: string }
      | undefined;
    if (!existing) throw notFound();
    if (existing.status === "published") throw conflict("已發布指南請先落架先編輯（archive 後再改）");
    if (["queued", "processing"].includes(existing.generationStatus)) {
      throw conflict("呢篇指南生成緊，等完成先好編輯");
    }
    await tx
      .update(gloGuideArticles)
      .set({
        title,
        body,
        theme,
        themeKey,
        status: "draft",
        generationStatus: "idle",
        generationError: null,
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(gloGuideArticles.id, input.id));
    if (newLinks) {
      await tx.delete(gloGuideArticleProducts).where(eq(gloGuideArticleProducts.articleId, input.id));
      await tx.insert(gloGuideArticleProducts).values(
        newLinks.map((p, i) => ({
          articleId: input.id,
          productId: p.id,
          position: i,
          sourceImageSnapshot: p.image,
          productNameSnapshot: p.name,
        })),
      );
    }
    await resetImagesPending(tx, input.id);
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleUpdate",
    targetType: "gloGuideArticle",
    targetId: input.id,
    detail: `編輯指南「${title}」${newLinks ? `，商品改為 ${newLinks.map((p) => p.id).join("/")}` : ""}；已重置 draft＋圖片審批`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── article.submit ────────────────────────────

/**
 * article.submit {id}：draft/rejected → pending_review。
 * 喺 transaction 重讀＋重驗內容閘＋圖片數量／連結／source drift（唔使逐張 approved——
 * 嗰步係 approve 嘅事）；任何一項唔過 → 409，咩都唔寫。
 */
export async function submitArticle(
  actor: GloGuideActor,
  id: number,
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, status FROM "gloGuideArticles" WHERE id = ${id} FOR UPDATE`,
    );
    const row = locked.rows[0] as { id: number; status: string } | undefined;
    if (!row) throw notFound();
    if (row.status !== "draft" && row.status !== "rejected") {
      throw conflict("只有草稿或被拒絕嘅指南可以提交審批");
    }
    const bundle = await loadBundle(tx as unknown as Db, id);
    if (!bundle) throw notFound();
    const errors = evaluateGloGuideGate(gateInputFrom(bundle), { requireImageApproval: false });
    if (errors.length > 0) throw conflict(`未過審批閘：${errors.join("；")}`);
    await tx
      .update(gloGuideArticles)
      .set({ status: "pending_review", rejectionReason: null, updatedAt: new Date() })
      .where(eq(gloGuideArticles.id, id));
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleSubmit",
    targetType: "gloGuideArticle",
    targetId: id,
    detail: "提交指南審批（pending_review）",
  });
  return toInternalArticle(await getArticleBundle(id));
}

// ──────────────────────────── article.approve ────────────────────────────

/**
 * article.approve {id}（只 supervisor/admin——role 閘喺 WMS handler 層）：
 * 只接受 pending_review；喺**單一 transaction** FOR UPDATE 重讀，重驗 SPEC 全部硬閘
 * （title/body/theme、2–3 貨、3–5 圖、每貨有圖、逐張 approved＋reviewer/time、
 * source snapshot drift、圖片路徑白名單），全過先設 published＋publishedAt。
 */
export async function approveArticle(
  actor: GloGuideActor,
  id: number,
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, status FROM "gloGuideArticles" WHERE id = ${id} FOR UPDATE`,
    );
    const row = locked.rows[0] as { id: number; status: string } | undefined;
    if (!row) throw notFound();
    if (row.status !== "pending_review") {
      throw conflict("只有待審批（pending_review）嘅指南可以批准");
    }
    const bundle = await loadBundle(tx as unknown as Db, id);
    if (!bundle) throw notFound();
    const errors = evaluateGloGuideGate(gateInputFrom(bundle), { requireImageApproval: true });
    if (errors.length > 0) {
      throw conflict(`未過發布閘：${errors.join("；")}`);
    }
    await tx
      .update(gloGuideArticles)
      .set({
        status: "published",
        publishedAt: bundle.article.publishedAt ?? new Date(),
        reviewedById: actor.id,
        reviewedByName: actor.name,
        reviewedAt: new Date(),
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(gloGuideArticles.id, id));
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleApprove",
    targetType: "gloGuideArticle",
    targetId: id,
    detail: "批准並發布指南",
  });
  return toInternalArticle(await getArticleBundle(id));
}

// ──────────────────────────── article.reject ────────────────────────────

/** article.reject {id, reason}（只 supervisor/admin）：pending_review → rejected，原因必填留底 */
export async function rejectArticle(
  actor: GloGuideActor,
  input: { id: number; reason: string },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const reason = sanitizeGloGuideBody(typeof input.reason === "string" ? input.reason : "");
  if (!reason || [...reason].length > 300) throw badRequest("拒絕原因必填（最長 300 字）");
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, status FROM "gloGuideArticles" WHERE id = ${input.id} FOR UPDATE`,
    );
    const row = locked.rows[0] as { id: number; status: string } | undefined;
    if (!row) throw notFound();
    if (row.status !== "pending_review") throw conflict("只有待審批嘅指南可以拒絕");
    await tx
      .update(gloGuideArticles)
      .set({
        status: "rejected",
        rejectionReason: reason,
        reviewedById: actor.id,
        reviewedByName: actor.name,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(gloGuideArticles.id, input.id));
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleReject",
    targetType: "gloGuideArticle",
    targetId: input.id,
    detail: `拒絕指南：${reason}`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── article.archive ────────────────────────────

/**
 * article.archive {id}（只 supervisor/admin——role 閘喺 WMS handler 層）：
 * published → archived（transaction FOR UPDATE 重讀狀態）。一落架即時生效：
 * 公開 DTO list/bySlug 只出 published → 即時 404；公開 media 閘同 sitemap 亦只認
 * published（media 回應係 no-cache，下一個 request 即刻擋）。其他狀態回清楚 conflict。
 */
export async function archiveArticle(
  actor: GloGuideActor,
  id: number,
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, status FROM "gloGuideArticles" WHERE id = ${id} FOR UPDATE`,
    );
    const row = locked.rows[0] as { id: number; status: string } | undefined;
    if (!row) throw notFound();
    const err = archiveArticleError(row.status);
    if (err) throw conflict(err);
    await tx
      .update(gloGuideArticles)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(gloGuideArticles.id, id));
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.articleArchive",
    targetType: "gloGuideArticle",
    targetId: id,
    detail: "落架指南（published → archived，公開即時停）",
  });
  return toInternalArticle(await getArticleBundle(id));
}

// ──────────────────────────── image.review ────────────────────────────

/**
 * M5 共用：圖片 mutation 之前喺 transaction 內 FOR UPDATE 鎖文章＋驗可編輯
 * （published 唔准郁——防同 approve 賽跑：approve 都係 FOR UPDATE 鎖同一行，兩者互斥）。
 */
async function lockArticleForImageMutation(
  tx: Db,
  articleId: number,
  actionLabel: string,
): Promise<void> {
  const locked = await tx.execute(
    sql`SELECT id, status FROM "gloGuideArticles" WHERE id = ${articleId} FOR UPDATE`,
  );
  const row = locked.rows[0] as { id: number; status: string } | undefined;
  if (!row) throw notFound();
  const err = gloGuidePublishedMutationError(actionLabel, row.status);
  if (err) throw conflict(err);
}

/** image.review {id, imageId, decision, note?}：逐張人工一致性審批（approved/rejected＋reviewer/time）。
 *  M5：published check 同寫入要原子——transaction FOR UPDATE 鎖文章再驗再改，防同 approve 賽跑。 */
export async function reviewImage(
  actor: GloGuideActor,
  input: { id: number; imageId: number; decision: "approved" | "rejected"; note?: string },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  if (input.decision !== "approved" && input.decision !== "rejected") {
    throw badRequest("decision 只可以係 approved 或 rejected");
  }
  const note = input.note ? sanitizeGloGuideBody(input.note).slice(0, 300) : null;
  if (input.decision === "rejected" && !note) throw badRequest("拒絕圖片要填原因（note）");
  await db.transaction(async (tx) => {
    await lockArticleForImageMutation(tx as unknown as Db, input.id, "改圖片審批");
    const [updated] = await tx
      .update(gloGuideImages)
      .set({
        reviewStatus: input.decision,
        reviewedById: actor.id,
        reviewedByName: actor.name,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gloGuideImages.id, input.imageId),
          eq(gloGuideImages.articleId, input.id),
          isNull(gloGuideImages.deletedAt),
          eq(gloGuideImages.status, "completed"),
        ),
      )
      .returning({ id: gloGuideImages.id });
    if (!updated) throw notFound("搵唔到呢張圖（或圖片未完成生成）");
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.imageReview",
    targetType: "gloGuideImage",
    targetId: input.imageId,
    detail: `指南 ${input.id} 圖片 ${input.imageId} ${input.decision}${note ? `：${note}` : ""}`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── image.delete ────────────────────────────

/** image.delete {id, imageId}：軟刪（deletedAt），歷史審批留底。
 *  M5：transaction FOR UPDATE 鎖文章再驗再刪，防同 approve 賽跑。 */
export async function deleteImage(
  actor: GloGuideActor,
  input: { id: number; imageId: number },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockArticleForImageMutation(tx as unknown as Db, input.id, "刪圖");
    const [updated] = await tx
      .update(gloGuideImages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(gloGuideImages.id, input.imageId),
          eq(gloGuideImages.articleId, input.id),
          isNull(gloGuideImages.deletedAt),
        ),
      )
      .returning({ id: gloGuideImages.id });
    if (!updated) throw notFound("搵唔到呢張圖");
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.imageDelete",
    targetType: "gloGuideImage",
    targetId: input.imageId,
    detail: `刪除指南 ${input.id} 圖片 ${input.imageId}`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── image.upload ────────────────────────────

const GLO_GUIDE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * image.upload {id, productId, filename, mime, dataBase64}：
 * base64 → 10MB 上限 → provider sharp 驗真圖（JPEG/PNG/WebP）＋re-encode 持久化 →
 * 建 completed 圖（reviewStatus pending，等人手批）；sourceProductImage 記低商品現行圖。
 */
export async function uploadImage(
  actor: GloGuideActor,
  input: { id: number; productId: number; filename: string; mime: string; dataBase64: string },
  providers: GloGuideProviders,
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const bundle = await getArticleBundle(input.id);
  if (bundle.article.status === "published") throw conflict("已發布指南唔可以加圖，請先落架");
  const link = bundle.links.find((l) => l.productId === input.productId);
  if (!link) throw badRequest("呢件商品唔喺指南入面");
  if (typeof input.dataBase64 !== "string" || input.dataBase64.length === 0) {
    throw badRequest("缺圖片資料（dataBase64）");
  }
  // base64 長度估算原檔大小（未 decode 先擋大件）
  if (Math.floor(input.dataBase64.length * 0.75) > GLO_GUIDE_UPLOAD_MAX_BYTES) {
    throw badRequest("圖片超過 10MB 上限");
  }
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0 || data.length > GLO_GUIDE_UPLOAD_MAX_BYTES) {
    throw badRequest("圖片資料無效或超過 10MB");
  }
  const current = bundle.currentProducts.get(input.productId);
  if (!current) throw badRequest("商品已刪除，請先更新指南商品");
  let stored: { path: string; width: number; height: number };
  try {
    stored = await providers.saveUpload({
      filename: String(input.filename ?? "").slice(0, 120),
      mime: String(input.mime ?? "").slice(0, 64),
      data,
    });
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "圖片驗證失敗");
  }
  // M5：寫入前喺 transaction FOR UPDATE 鎖文章再驗再插（防 saveUpload 期間篇文章被 approve/published；
  // 若撞 published，檔案會留低做 orphan——冇 DB 行公開閘 404，唔影響安全）
  await db.transaction(async (tx) => {
    await lockArticleForImageMutation(tx as unknown as Db, input.id, "加圖");
    const liveRows = await tx
      .select({ id: gloGuideImages.id, position: gloGuideImages.position })
      .from(gloGuideImages)
      .where(and(eq(gloGuideImages.articleId, input.id), isNull(gloGuideImages.deletedAt)));
    if (liveRows.length >= GLO_GUIDE_IMAGE_MAX) throw conflict(`最多 ${GLO_GUIDE_IMAGE_MAX} 張圖`);
    const nextPosition = liveRows.reduce((m, i) => Math.max(m, i.position), -1) + 1;
    await tx.insert(gloGuideImages).values({
      publicId: randomUUID(),
      articleId: input.id,
      productId: input.productId,
      path: stored.path,
      sourceProductImage: current.image,
      status: "completed",
      reviewStatus: "pending",
      position: nextPosition,
      width: stored.width,
      height: stored.height,
    });
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.imageUpload",
    targetType: "gloGuideArticle",
    targetId: input.id,
    detail: `上傳圖片（商品 ${input.productId} → ${stored.path}）`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── image.generate ────────────────────────────

/**
 * image.generate {id, imageId?, productId?}：
 * ─ 有 imageId：重生該張（version+1，conditional update 只准 completed/failed→queued，
 *   review→pending＋清 reviewer/time，建 image job）；
 * ─ 否則按已選商品補齊：每件商品最少一張，總數補到 min(3, 商品數)…上限 5。
 * H1/M5：整個檢查＋圖/job 更新喺**同一個 transaction** 做，FOR UPDATE 鎖文章、
 * 鎖內重讀 links/images（唔用舊快照），published 即 409；**唔再寫文章 status**
 * （圖生成唔應該郁審批狀態；之前用 stale bundle.status 寫會冚 published/rejected）。
 * 每張獨立 job（idempotencyKey 擋重複點擊）。
 */
export async function generateImages(
  actor: GloGuideActor,
  input: { id: number; imageId?: number; productId?: number },
): Promise<ReturnType<typeof toInternalArticle>> {
  const db = getDb();
  const kicked: number[] = [];

  try {
    await db.transaction(async (tx) => {
    const txx = tx as unknown as Db;
    await lockArticleForImageMutation(txx, input.id, "重生圖");
    // 鎖內重讀（H1：唔用 tx 外嘅舊快照）
    const links = await tx
      .select()
      .from(gloGuideArticleProducts)
      .where(eq(gloGuideArticleProducts.articleId, input.id))
      .orderBy(gloGuideArticleProducts.position);
    if (links.length === 0) throw conflict("指南未揀商品");
    const images = await tx
      .select()
      .from(gloGuideImages)
      .where(eq(gloGuideImages.articleId, input.id));

    if (input.imageId !== undefined) {
      const img = images.find((i) => i.id === input.imageId && !i.deletedAt);
      if (!img) throw notFound("搵唔到呢張圖");
      const version = img.version + 1;
      // conditional update：只准 completed/failed → queued（第二個 request／recovery 撞唔到）
      const [upd] = await tx
        .update(gloGuideImages)
        .set({
          status: "queued",
          reviewStatus: "pending",
          reviewedById: null,
          reviewedByName: null,
          reviewedAt: null,
          error: null,
          version,
          updatedAt: new Date(),
        })
        .where(
          and(eq(gloGuideImages.id, img.id), inArray(gloGuideImages.status, ["completed", "failed"])),
        )
        .returning({ id: gloGuideImages.id });
      if (!upd) throw conflict("呢張圖生成緊或狀態已改變，請刷新再試");
      const { job, created } = await createGloGuideJob(
        {
          articleId: input.id,
          imageId: img.id,
          kind: "image",
          idempotencyKey: `img:${img.publicId}:v${version}`,
          payload: { requestedBy: actor.name },
        },
        tx,
      );
      if (created) kicked.push(job.id);
      return;
    }

    // 補齊：先逐件冇圖商品補一張，再補到最少 3 張（round-robin 已選商品）
    const live = images.filter((i) => !i.deletedAt);
    if (live.length >= GLO_GUIDE_IMAGE_MAX) throw conflict(`最多 ${GLO_GUIDE_IMAGE_MAX} 張圖`);
    const activeByProduct = new Map<number, number>();
    for (const i of live) {
      if (i.productId !== null && i.status !== "failed") {
        activeByProduct.set(i.productId, (activeByProduct.get(i.productId) ?? 0) + 1);
      }
    }
    const target = Math.min(GLO_GUIDE_IMAGE_MAX, Math.max(3, links.length, live.length));
    let nextPosition = images.reduce((m, i) => Math.max(m, i.position), -1) + 1;
    const order = [...links].sort(
      (a, b) => (activeByProduct.get(a.productId) ?? 0) - (activeByProduct.get(b.productId) ?? 0),
    );
    const filterPid = input.productId;
    if (filterPid !== undefined && !links.some((l) => l.productId === filterPid)) {
      throw badRequest("呢件商品唔喺指南入面");
    }
    const productRows = await tx
      .select()
      .from(products)
      .where(inArray(products.id, links.map((l) => l.productId)));
    const prodById = new Map(productRows.map((p) => [p.id, p]));
    let created = live.length;
    let guard = 0;
    while (created < target && guard++ < 10) {
      for (const link of order) {
        if (created >= target) break;
        if (filterPid !== undefined && link.productId !== filterPid && (activeByProduct.get(filterPid) ?? 0) > 0) {
          continue;
        }
        const product = prodById.get(link.productId);
        if (!product) continue;
        const [img] = await tx
          .insert(gloGuideImages)
          .values({
            publicId: randomUUID(),
            articleId: input.id,
            productId: link.productId,
            path: null,
            sourceProductImage: product.image,
            status: "queued",
            reviewStatus: "pending",
            position: nextPosition++,
          })
          .returning();
        const { job, created: jobCreated } = await createGloGuideJob(
          {
            articleId: input.id,
            imageId: img.id,
            kind: "image",
            idempotencyKey: `img:${img.publicId}:v1`,
            payload: { requestedBy: actor.name },
          },
          tx,
        );
        if (jobCreated) kicked.push(job.id);
        activeByProduct.set(link.productId, (activeByProduct.get(link.productId) ?? 0) + 1);
        created++;
      }
    }
    if (kicked.length === 0) throw conflict("冇需要生成嘅圖（已達數量上限或全部生成緊）");
    });
  } catch (e) {
    // idempotency 撞 key（double-click／重試）→ tx 已 rollback，當 idempotent no-op 處理
    if (!isUniqueViolation(e, "gloguidejobs_idempotency")) throw e;
  }

  for (const jobId of kicked) kickJob(jobId);
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.imageGenerate",
    targetType: "gloGuideArticle",
    targetId: input.id,
    detail: `觸發圖片生成 ${kicked.length} 個 job${input.imageId ? `（重生圖 ${input.imageId}）` : ""}`,
  });
  return toInternalArticle(await getArticleBundle(input.id));
}

// ──────────────────────────── image.read（WMS 內部預覽）────────────────────────────

const GLO_GUIDE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * image.read {id, imageId}（三級員工皆可）：核對圖片屬該 article 且未刪，
 * 由 server 讀本地檔回 {filename, mime, dataBase64}——
 * 唔回絕對 disk path、唔回任何秘密；公開直讀係另一條線（gloGuidePublicMedia，
 * 只放行已發布）。呢度係審批預覽用，所以未批圖都讀到（經 WMS secret 閘）。
 */
export async function readImageForPreview(
  actor: GloGuideActor,
  input: { id: number; imageId: number },
): Promise<{ filename: string; mime: string; dataBase64: string }> {
  const db = getDb();
  const image = await db.query.gloGuideImages.findFirst({
    where: and(eq(gloGuideImages.id, input.imageId), eq(gloGuideImages.articleId, input.id)),
  });
  if (!image || image.deletedAt) throw notFound("搵唔到呢張圖");
  if (!image.path || !isGloGuideImagePath(image.path)) throw notFound("圖片未有可讀檔案");
  const filename = image.path.slice(GLO_GUIDE_PATH_PREFIX.length);
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mime = GLO_GUIDE_MIME_BY_EXT[ext];
  if (!mime) throw notFound("圖片格式無效");
  const dir = process.env.UPLOADS_DIR || "uploads";
  let data: Buffer;
  try {
    data = await readFile(pathModule.join(dir, "glo-guide", filename));
  } catch {
    throw notFound("圖片檔案唔存在（可能已搬遷）");
  }
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.imageRead",
    targetType: "gloGuideImage",
    targetId: input.imageId,
    detail: `WMS 預覽指南 ${input.id} 圖片 ${input.imageId}`,
  });
  return { filename, mime, dataBase64: data.toString("base64") };
}

// ──────────────────────────── 模特兒原圖管理（官網 /admin 後台）────────────────────────────
//
// 規矩：
// ─ 原圖係真實授權相，**絕不公開**：path 只准 /uploads/glo-guide-models/<uuid>.<ext>
//   （冇公開路由放行呢個目錄），員工預覽淨係行 JWT tRPC base64（modelImageRead）；
// ─ Fashn 每次淨係用一張＝isDefault 嗰張；其他係備用。新文章 generateArticle 喺建文當刻
//   將預設相 path 寫死落 article.modelImage（快照）——呢度刪相／換預設絕對唔會回寫舊文章；
// ─ delete 係軟刪（deletedAt）留審計；預設相被刪會自動升最早建立嘅備用相做預設；
//   冇晒未刪相 → 新文章回落 ENV 第一項／內建 /gloglo-3.jpg（list 會清晰標示 fallback）；
// ─ 審計 actor 用 actor.name（唔加 WMS 後綴——呢條係官網後台線）。

export interface ModelImageDto {
  id: number;
  publicId: string;
  path: string;
  originalFilename: string | null;
  width: number;
  height: number;
  isDefault: boolean;
  createdByName: string | null;
  createdAt: string;
}

function toModelImageDto(row: typeof gloGuideModelImages.$inferSelect): ModelImageDto {
  return {
    id: row.id,
    publicId: row.publicId,
    path: row.path,
    originalFilename: row.originalFilename,
    width: row.width,
    height: row.height,
    isDefault: row.isDefault,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 後台模特兒原圖列表＋而家生效嘅預設（DB 預設；冇 DB 相就清晰標示 ENV／內建 fallback） */
export async function listModelImages(): Promise<{
  items: ModelImageDto[];
  maxCount: number;
  /** DB 冇相嗰陣新文章會用嘅 fallback（ENV 第一項或內建 /gloglo-3.jpg） */
  fallback: { ref: string };
  /** 而家新建文章實際會用嘅 ref 同來源 */
  effective: { ref: string; source: "db" | "env" };
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gloGuideModelImages)
    .where(isNull(gloGuideModelImages.deletedAt))
    .orderBy(gloGuideModelImages.createdAt, gloGuideModelImages.id);
  const env = gloGuideModelImage();
  const effective = resolveModelImageDefault(rows, env.ref);
  return {
    items: rows.map(toModelImageDto),
    maxCount: GLO_GUIDE_MODEL_IMAGE_MAX,
    fallback: { ref: env.ref },
    effective: { ref: effective.ref, source: effective.source },
  };
}

/**
 * modelImage.upload {filename, mime, dataBase64}：
 * base64 → 10MB 上限 → sharp 驗真圖（JPEG/PNG/WebP，SVG 拒收）＋同格式 re-encode →
 * 落 /uploads/glo-guide-models/<uuid>.<ext> → 建 DB 行。
 * 第一張自動做預設；上限 GLO_GUIDE_MODEL_IMAGE_MAX（8）張未刪相。
 */
export async function uploadModelImage(
  actor: GloGuideActor,
  input: { filename: string; mime: string; dataBase64: string },
  saveImage: typeof saveGloGuideModelImage = saveGloGuideModelImage,
): Promise<ReturnType<typeof listModelImages>> {
  const db = getDb();
  if (typeof input.dataBase64 !== "string" || input.dataBase64.length === 0) {
    throw badRequest("缺圖片資料（dataBase64）");
  }
  // base64 長度估算原檔大小（未 decode 先擋大件）
  if (Math.floor(input.dataBase64.length * 0.75) > GLO_GUIDE_UPLOAD_MAX_BYTES) {
    throw badRequest("圖片超過 10MB 上限");
  }
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0 || data.length > GLO_GUIDE_UPLOAD_MAX_BYTES) {
    throw badRequest("圖片資料無效或超過 10MB");
  }
  const filename = String(input.filename ?? "").slice(0, 200);
  let stored: { path: string; width: number; height: number };
  try {
    stored = await saveImage({
      filename,
      mime: String(input.mime ?? "").slice(0, 64),
      data,
    });
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "圖片驗證失敗");
  }
  if (!isGloGuideModelImagePath(stored.path)) {
    throw new GloGuideError(500, "INTERNAL", "模特兒原圖存放路徑無效");
  }
  // 第一張自動做預設；併發撞 partial unique（另一張同時做咗預設）→ 成個 tx 重試做備用
  // （Postgres 一錯成個 tx abort，所以重試一定要喺 transaction 外圍，唔可以喺 tx 入面補救）。
  const insertRow = async (allowDefault: boolean) =>
    db.transaction(async (tx) => {
      const live = await tx
        .select({ id: gloGuideModelImages.id })
        .from(gloGuideModelImages)
        .where(isNull(gloGuideModelImages.deletedAt));
      if (live.length >= GLO_GUIDE_MODEL_IMAGE_MAX) {
        throw conflict(`最多 ${GLO_GUIDE_MODEL_IMAGE_MAX} 張模特兒原圖，請先刪除舊相`);
      }
      const [inserted] = await tx
        .insert(gloGuideModelImages)
        .values({
          publicId: randomUUID(),
          path: stored.path,
          originalFilename: filename || null,
          width: stored.width,
          height: stored.height,
          isDefault: allowDefault && live.length === 0,
          createdById: actor.id,
          createdByName: actor.name,
        })
        .returning();
      return inserted;
    });
  let row: typeof gloGuideModelImages.$inferSelect | undefined;
  try {
    try {
      row = await insertRow(true);
    } catch (e) {
      if (!isUniqueViolation(e, "gloguidemodelimages_default_live")) throw e;
      row = await insertRow(false);
    }
  } catch (e) {
    // DB 寫入失敗 → 清理啱啱落盤嘅檔案（best-effort；清理失敗淨係 log）。
    // 錯誤照樣抛出——絕對唔會留低冇 DB 行嘅「成功」假象。
    const fname = stored.path.slice(GLO_GUIDE_MODEL_IMAGE_PREFIX.length);
    await rm(pathModule.join(process.env.UPLOADS_DIR || "uploads", "glo-guide-models", fname), {
      force: true,
    }).catch((rmErr) => console.error("[glo-guide] 清理上傳失敗嘅模特兒原圖檔案失敗:", rmErr));
    throw e;
  }
  if (!row) throw new GloGuideError(500, "INTERNAL", "上傳模特兒原圖失敗，請再試");
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.modelImageUpload",
    targetType: "gloGuideModelImage",
    targetId: row.id,
    detail: `上傳模特兒原圖 ${row.path}（${row.width}×${row.height}${row.isDefault ? "，自動設為預設" : ""}）`,
  });
  return listModelImages();
}

/**
 * modelImage.setDefault {id}：同一 transaction 先清晒未刪行嘅預設，再標目標做預設
 * （DB partial unique index 硬保證最多一張）。**唔會郁任何舊文章嘅 modelImage 快照。**
 */
export async function setDefaultModelImage(
  actor: GloGuideActor,
  input: { id: number },
): Promise<ReturnType<typeof listModelImages>> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // 行數上限 8 張，select 全部未刪行再喺 JS 搵目標（同 delete 一致，避免半寫狀態）
    const live = await tx
      .select({ id: gloGuideModelImages.id })
      .from(gloGuideModelImages)
      .where(isNull(gloGuideModelImages.deletedAt));
    if (!live.some((r) => r.id === input.id)) throw notFound("搵唔到呢張模特兒原圖");
    await tx
      .update(gloGuideModelImages)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(isNull(gloGuideModelImages.deletedAt), eq(gloGuideModelImages.isDefault, true)));
    await tx
      .update(gloGuideModelImages)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(gloGuideModelImages.id, input.id));
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.modelImageSetDefault",
    targetType: "gloGuideModelImage",
    targetId: input.id,
    detail: `設定模特兒原圖 ${input.id} 為預設（之後新建文章先用；舊文章保留當初快照）`,
  });
  return listModelImages();
}

/**
 * modelImage.delete {id}：軟刪（deletedAt）留審計；**唔會郁任何舊文章嘅 modelImage 快照**。
 * 刪嘅係預設 → 最早建立嘅備用相自動升做預設；冇晒未刪相 → 新文章回落 ENV／內建
 * /gloglo-3.jpg（list.effective 會標示 source=env，UI 清晰顯示 fallback）。
 */
export async function deleteModelImage(
  actor: GloGuideActor,
  input: { id: number },
): Promise<ReturnType<typeof listModelImages>> {
  const db = getDb();
  let promotedId: number | null = null;
  await db.transaction(async (tx) => {
    const live = await tx
      .select({
        id: gloGuideModelImages.id,
        path: gloGuideModelImages.path,
        isDefault: gloGuideModelImages.isDefault,
        createdAt: gloGuideModelImages.createdAt,
      })
      .from(gloGuideModelImages)
      .where(isNull(gloGuideModelImages.deletedAt));
    const target = live.find((r) => r.id === input.id);
    if (!target) throw notFound("搵唔到呢張模特兒原圖");
    promotedId = modelImageDefaultAfterDelete(live, input.id);
    // 次序攸關：partial unique index 唔准兩張 live default——一定要喺**同一 tx**
    // 先 soft-delete 舊預設（順手清 isDefault），先至可以 promote 備用相。
    await tx
      .update(gloGuideModelImages)
      .set({ isDefault: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(gloGuideModelImages.id, input.id));
    if (promotedId !== null) {
      await tx
        .update(gloGuideModelImages)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(gloGuideModelImages.id, promotedId));
    }
  });
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.modelImageDelete",
    targetType: "gloGuideModelImage",
    targetId: input.id,
    detail: `刪除模特兒原圖 ${input.id}${promotedId !== null ? `，預設自動轉俾 ${promotedId}` : ""}（舊文章保留當初快照）`,
  });
  return listModelImages();
}

/**
 * modelImage.read {id}：員工預覽用——server 由 UPLOADS_DIR 讀本地檔回 base64。
 * 呢個目錄冇公開路由；未刪行先讀到（軟刪後預覽都擋，防「刪咗仲睇得」錯覺）。
 */
export async function readModelImageForPreview(
  actor: GloGuideActor,
  input: { id: number },
): Promise<{ filename: string; mime: string; dataBase64: string }> {
  const db = getDb();
  const row = await db.query.gloGuideModelImages.findFirst({
    where: and(eq(gloGuideModelImages.id, input.id), isNull(gloGuideModelImages.deletedAt)),
  });
  if (!row) throw notFound("搵唔到呢張模特兒原圖");
  if (!isGloGuideModelImagePath(row.path)) throw notFound("原圖路徑無效");
  const filename = row.path.slice(GLO_GUIDE_MODEL_IMAGE_PREFIX.length);
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const mime = GLO_GUIDE_MIME_BY_EXT[ext];
  if (!mime) throw notFound("原圖格式無效");
  const dir = process.env.UPLOADS_DIR || "uploads";
  let data: Buffer;
  try {
    data = await readFile(pathModule.join(dir, "glo-guide-models", filename));
  } catch {
    throw notFound("原圖檔案唔存在（可能已搬遷）");
  }
  void logAudit({
    actorId: actor.id,
    actorRole: actor.role,
    actorNameFallback: actor.name,
    action: "gloGuide.modelImageRead",
    targetType: "gloGuideModelImage",
    targetId: input.id,
    detail: `後台預覽模特兒原圖 ${input.id}`,
  });
  return { filename, mime, dataBase64: data.toString("base64") };
}

// re-export 方便 handler 用
export { isGloGuideAction };
