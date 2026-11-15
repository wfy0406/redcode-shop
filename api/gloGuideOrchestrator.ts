/**
 * Glo Glo 指南——生成 orchestrator（背景執行，所有狀態落 DB）。
 *
 * Job kind：
 * ─ scheduled／full：揀貨已在建文時完成；呢度行 文字生成 → 逐商品建圖 job（每件商品
 *   啱啱一張，N 件 → N 個 job；每張獨立）→ 全部圖完成 → article=pending_review
 *   （圖片仍 reviewStatus=pending，等主管逐張批）；
 *   任何一步失敗 → generationStatus=failed＋generationError／job.error，絕不假成功。
 * ─ article：淨重寫文字（regenerate）；完成 → pending_review（舊圖保留，review 已重置 pending）。
 * ─ image：單張圖生成（Fashn tryon-max；飾品／多品 agent experimental）。
 *
 * Job recovery（重開機後）：queued 超时重 kick；submitted/processing 有 providerJobId
 * 嘅 image job 憑 providerJobId resume poll；image job 冇 providerJobId 超時 → failed；
 * child image job 有結果後用 settleGloGuideArticleInDb 重結算 parent＋article（規則：
 * 仲有 active child → 唔郁；文字失敗／有 failed child／完成圖少過已選商品數 → failed；
 * 否則 pending_review）。full/scheduled parent 超時唔會直接判死成篇——由 child 結算帶動。
 * 失敗留 error，唔靜默重試。
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import {
  gloGuideArticleProducts,
  gloGuideArticles,
  gloGuideImages,
  gloGuideJobs,
  products,
} from "@db/schema";
import { productCategoryLabel } from "@contracts/types";
import { publicAiTags } from "./productAiContent";
import { logAudit } from "./audit";
import { randomUUID } from "node:crypto";
import {
  defaultGloGuideProviders,
  GloGuideProviderError,
  type GloGuideProviders,
} from "./gloGuideProviders";
import { assertThemeAvailable, getRecentThemes, gloGuideModelImage } from "./gloGuideService";
import { canClaimJobStatus, isGloGuideModelImagePath, shouldApplyGenerationToArticle } from "./gloGuideValidation";

/**
 * 文章 modelImage 快照 → provider 輸入：
 * ─ 後台模特兒原圖（/uploads/glo-guide-models/<uuid>.<ext>）係**私密**——原樣傳 path，
 *   由 Fashn resolver 讀 disk 轉 data URI；如果轉公開 URL，Fashn fetch 會 404（目錄唔公開）；
 * ─ 其他站內路徑（內建 /gloglo-3.jpg 等）照舊轉絕對 URL；https 原樣；冇快照用 ENV 預設。
 */
function modelImageForProvider(
  modelImage: string | null,
  base: string,
  fallbackAbsolute: string,
): string {
  if (modelImage && isGloGuideModelImagePath(modelImage)) return modelImage;
  if (modelImage?.startsWith("/")) return `${base}${modelImage}`;
  return modelImage ?? fallbackAbsolute;
}

/**
 * H2：條件式寫文章——只有 draft/pending_review/rejected 先俾背景生成套用；
 * published/archived 一律唔郁（舊 queued job recovery 重跑都冚唔到已發布文）。
 * 返 true＝已套用；false＝文章狀態已改變，caller 要留 note 兼停手。
 */
async function applyToEditableArticle(
  db: Db,
  articleId: number,
  patch: Partial<typeof gloGuideArticles.$inferInsert>,
): Promise<boolean> {
  const rows = await db
    .update(gloGuideArticles)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(gloGuideArticles.id, articleId),
        inArray(gloGuideArticles.status, ["draft", "pending_review", "rejected"]),
      ),
    )
    .returning({ id: gloGuideArticles.id });
  return rows.length > 0;
}

/**
 * M3：圖完成寫入係 conditional——只准 queued/processing → completed；
 * 新 path 寫入一律 reviewStatus=pending＋清 reviewer/time（要重新人工批）；
 * 第二個完成（recovery／舊 job）冚唔到已 completed/approved 嘅圖。返 true＝已套用。
 */
async function completeImageConditionally(
  db: Db,
  imageId: number,
  expectedVersion: number,
  result: { path: string; width: number; height: number; providerJobId: string },
): Promise<boolean> {
  const rows = await db
    .update(gloGuideImages)
    .set({
      path: result.path,
      width: result.width,
      height: result.height,
      providerJobId: result.providerJobId,
      status: "completed",
      reviewStatus: "pending",
      reviewedById: null,
      reviewedByName: null,
      reviewedAt: null,
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gloGuideImages.id, imageId),
        eq(gloGuideImages.version, expectedVersion),
        inArray(gloGuideImages.status, ["queued", "processing"]),
      ),
    )
    .returning({ id: gloGuideImages.id });
  return rows.length > 0;
}

type Db = ReturnType<typeof getDb>;
type Job = typeof gloGuideJobs.$inferSelect;

function errText(e: unknown): string {
  if (e instanceof GloGuideProviderError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

async function setJob(
  db: Db,
  jobId: number,
  patch: Partial<typeof gloGuideJobs.$inferInsert>,
): Promise<void> {
  await db
    .update(gloGuideJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(gloGuideJobs.id, jobId));
}

// H2：文章寫入一律行 applyToEditableArticle（conditional）；唔再提供無條件寫文章嘅 helper。

// ──────────────────────────── 文字生成 ────────────────────────────

/**
 * 文字生成：HKO 天氣（快照落 DB）→ provider 嚴格 JSON 生成（內部有限重試）→
 * 我哋再驗主題去重（撞咗帶住衝突提示再試一次，仍撞即 failed）。
 */
async function runTextGeneration(
  db: Db,
  job: Job,
  providers: GloGuideProviders,
): Promise<void> {
  const article = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, job.articleId),
  });
  if (!article) throw new Error(`article ${job.articleId} 唔存在`);
  // H2：published/archived 文章唔准俾背景生成冚（舊 queued job recovery 都一樣）——job 留 note
  if (!shouldApplyGenerationToArticle(article.status)) {
    throw new Error(`文章狀態係 ${article.status}（已發布／落架），生成結果唔套用`);
  }
  const links = await db
    .select()
    .from(gloGuideArticleProducts)
    .where(eq(gloGuideArticleProducts.articleId, job.articleId))
    .orderBy(gloGuideArticleProducts.position);
  if (links.length < 2) throw new Error("指南未夠 2 件商品");
  const productRows = await db
    .select()
    .from(products)
    .where(inArray(products.id, links.map((l) => l.productId)));
  const byId = new Map(productRows.map((p) => [p.id, p]));
  const ordered = links.map((l) => byId.get(l.productId)).filter((p): p is NonNullable<typeof p> => !!p);
  if (ordered.length !== links.length) throw new Error("有商品已刪除，請先更新指南商品");

  const weather = await providers.getWeather();
  // 天氣快照都係生成結果一部分：條件式寫入，唔冚 published
  if (
    !(await applyToEditableArticle(db, article.id, {
      weatherSnapshot: weather as unknown as Record<string, unknown>,
    }))
  ) {
    throw new Error("文章狀態已改變（published/archived），生成中止");
  }

  const recent = await getRecentThemes(article.id);
  const themeHint =
    typeof (job.payload as Record<string, unknown> | null)?.themeHint === "string"
      ? ((job.payload as Record<string, unknown>).themeHint as string)
      : undefined;

  const input = {
    products: ordered.map((p) => ({
      name: p.name,
      category: p.category,
      categoryLabel: productCategoryLabel(p.category),
      aiTags: publicAiTags(p.aiTags, p.aiTagsEnabled),
      price: p.price,
      discountPrice: p.discountPrice,
      liveDate: p.liveDate,
      liveSession: p.liveSession,
    })),
    recentThemes: recent.map((r) => r.theme),
    recentIntros: recent.map((r) => r.intro),
    weatherLines: weather.lines,
    themeHint,
  };

  // 主題去重喺我哋層再閘一次：撞近 8 篇 → 帶衝突提示俾 provider 再試一次；仍撞即 failed
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await providers.generateText(
      attempt === 0
        ? input
        : { ...input, themeHint: `${input.themeHint ?? ""}（注意：主題唔可以同近期指南重複）`.trim() },
    );
    try {
      const { theme, themeKey } = await assertThemeAvailable(text.theme, article.id);
      // H2：條件式套用——寫入嗰刻文章已 published/archived 就唔套用（job 層記 note）
      const applied = await applyToEditableArticle(db, article.id, {
        title: text.title,
        body: text.body,
        theme,
        themeKey,
        generationError: null,
      });
      if (!applied) throw new Error("文章狀態已改變（published/archived），生成結果唔套用");
      return;
    } catch (e) {
      lastError = e;
      // 狀態改變唔值得重試（冇用），即停
      if (e instanceof Error && e.message.includes("生成結果唔套用")) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ──────────────────────────── 單張圖生成 ────────────────────────────

const EXPERIMENTAL_CATEGORIES = new Set(["accessory", "lifestyle", "skincare", "other"]);

export type GloGuideClaimConflictState = "completed" | "failed" | "active";

/** 另一 runner 已認領時，只可按圖嘅即時狀態結算；active 絕對唔准假裝 completed。 */
export function classifyGloGuideClaimConflict(
  image: { status: string; deletedAt?: Date | null } | null | undefined,
): GloGuideClaimConflictState {
  if (!image || image.deletedAt || image.status === "failed") return "failed";
  if (image.status === "completed") return "completed";
  return "active";
}

async function runImageJob(
  db: Db,
  job: Job,
  providers: GloGuideProviders,
): Promise<boolean> {
  if (!job.imageId) throw new Error("image job 缺 imageId");
  // iteration 4 修復：preflight（image／article／product 讀取）失敗**唔准抛出**——
  // 抛出會直落 runGloGuideJob 外層 catch，淨係標 job failed；圖永遠卡 queued，
  // full job 篇文章就永遠卡 processing。呢度將圖（仲 queued/processing 先郁）標 failed
  // 兼 return false，等 runFullJob 可以照規則結算篇文章 failed。
  const failPreflight = async (msg: string, imageId: number | null): Promise<false> => {
    if (imageId !== null) {
      // conditional：只標仲 queued/processing 嘅圖，唔冚已完成／重生緊嘅新狀態
      await db
        .update(gloGuideImages)
        .set({ status: "failed", error: msg, updatedAt: new Date() })
        .where(
          and(eq(gloGuideImages.id, imageId), inArray(gloGuideImages.status, ["queued", "processing"])),
        );
    }
    await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
    return false;
  };

  const image = await db.query.gloGuideImages.findFirst({
    where: eq(gloGuideImages.id, job.imageId),
  });
  if (!image || image.deletedAt) return failPreflight(`image ${job.imageId} 唔存在或已刪除`, null);
  const article = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, image.articleId),
  });
  if (!article) return failPreflight("article 唔存在", image.id);
  const product = image.productId
    ? await db.query.products.findFirst({ where: eq(products.id, image.productId) })
    : null;
  if (!product) return failPreflight("圖片對應商品已刪除", image.id);

  // M3：圖都係 conditional 認領（queued → processing）；撞咗第二個 runner 就留 note 收工
  const claimedImage = await db
    .update(gloGuideImages)
    .set({ status: "processing", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(gloGuideImages.id, image.id),
        eq(gloGuideImages.version, image.version),
        eq(gloGuideImages.status, "queued"),
      ),
    )
    .returning({ id: gloGuideImages.id });
  if (claimedImage.length === 0) {
    // 唔可以一見認領衝突就當成功：recovery 可能仲生成緊。重讀即時圖狀態，
    // active 時唔郁 job，由最後一個 child／recovery 按全篇圖狀態結算。
    const latestImage = await db.query.gloGuideImages.findFirst({
      where: eq(gloGuideImages.id, image.id),
      columns: { status: true, deletedAt: true },
    });
    const conflict = classifyGloGuideClaimConflict(latestImage);
    if (conflict === "completed") {
      await setJob(db, job.id, {
        status: "completed",
        completedAt: new Date(),
        error: "note: 圖片已由另一 runner 完成，唔重複執行",
      });
      return true;
    }
    if (conflict === "failed") {
      await setJob(db, job.id, {
        status: "failed",
        completedAt: new Date(),
        error: "圖片已刪除或生成失敗，請重生",
      });
    }
    return false;
  }
  await setJob(db, job.id, { status: "processing" });

  try {
    // model/base 計算都擺喺 try 入面：呢段抛都要行「圖標 failed」嗰條路，唔准留圖卡 processing
    const model = gloGuideModelImage();
    const base = (process.env.PUBLIC_BASE_URL || "https://redcode.red").replace(/\/+$/, "");
    const productImage = product.image.startsWith("/") ? `${base}${product.image}` : product.image;
    const result = await providers.generateImage({
      articleId: article.id,
      imageId: image.id,
      productId: product.id,
      category: product.category,
      modelImage: modelImageForProvider(article.modelImage, base, model.absoluteUrl),
      productImage,
      experimental: EXPERIMENTAL_CATEGORIES.has(product.category),
      // 場景 context：full job 先寫好文字先生成圖，呢度 article.theme/body 係真內容；
      // variation 用圖嘅 position——同一篇每張 pose／構圖唔同。生成仍每次一張。
      articleTheme: article.theme,
      articleBody: article.body,
      productName: product.name,
      variation: image.position,
      onProviderJobId: async (providerJobId) => {
        // submit 一成功即刻落 DB；poll 中途重啟，recovery 先可以憑 id 補收同一個 prediction。
        await setJob(db, job.id, { status: "processing", providerJobId });
      },
    });
    // M3：conditional 完成寫入——狀態＋version 雙閘，舊 runner 冚唔到重生後嘅新圖。
    const applied = await completeImageConditionally(db, image.id, image.version, result);
    await setJob(db, job.id, {
      status: "completed",
      providerJobId: result.providerJobId,
      completedAt: new Date(),
      error: applied ? null : "note: 圖片狀態已改變，結果未套用（防重複完成覆蓋）",
    });
    return applied;
  } catch (e) {
    const msg = errText(e).slice(0, 900);
    await db
      .update(gloGuideImages)
      .set({ status: "failed", error: msg, updatedAt: new Date() })
      .where(
        and(
          eq(gloGuideImages.id, image.id),
          eq(gloGuideImages.version, image.version),
          eq(gloGuideImages.status, "processing"),
        ),
      );
    await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
    return false;
  }
}

// ──────────────────────────── 完整生成（full / scheduled）────────────────────────────

async function runFullJob(db: Db, job: Job, providers: GloGuideProviders): Promise<void> {
  // H2：文章已 published/archived → 生成結果唔套用，job 留 note 收工
  const current = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, job.articleId),
    columns: { status: true },
  });
  if (!current || !shouldApplyGenerationToArticle(current.status)) {
    await setJob(db, job.id, {
      status: "completed",
      completedAt: new Date(),
      error: `note: 文章狀態係 ${current?.status ?? "唔存在"}，生成結果唔套用`,
    });
    return;
  }
  await applyToEditableArticle(db, job.articleId, { generationStatus: "processing", generationError: null });
  try {
    await runTextGeneration(db, job, providers);
  } catch (e) {
    const msg = `文字生成失敗：${errText(e)}`.slice(0, 900);
    await applyToEditableArticle(db, job.articleId, { generationStatus: "failed", generationError: msg });
    await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
    return;
  }

  // iteration 4 新用戶規則：初始生成**每件已選商品啱啱一張圖**（N 件 → N 個 image job），
  // 唔再輪住補到 3–5 張；員工事後可按商品加生成（service generateImages productId）。
  const links = await db
    .select()
    .from(gloGuideArticleProducts)
    .where(eq(gloGuideArticleProducts.articleId, job.articleId))
    .orderBy(gloGuideArticleProducts.position);
  if (links.length < 2) {
    const msg = "圖片生成未完成：指南未夠 2 件商品";
    await applyToEditableArticle(db, job.articleId, { generationStatus: "failed", generationError: msg });
    await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
    return;
  }
  const article = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, job.articleId),
  });
  if (!article) throw new Error("article 唔存在");

  const imageJobIds: number[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    const product = await db.query.products.findFirst({ where: eq(products.id, link.productId) });
    if (!product) continue;
    // 每張圖同佢嘅 job 必須同生同死；否則中途重啟會留低冇 job 可 recovery 嘅 queued 圖。
    const imgJob = await db.transaction(async (tx) => {
      const [img] = await tx
        .insert(gloGuideImages)
        .values({
          publicId: randomUUID(),
          articleId: article.id,
          productId: link.productId,
          path: null,
          sourceProductImage: product.image,
          status: "queued",
          reviewStatus: "pending",
          position: i,
        })
        .returning();
      const [createdJob] = await tx
        .insert(gloGuideJobs)
        .values({
          publicId: randomUUID(),
          articleId: article.id,
          imageId: img.id,
          kind: "image",
          status: "queued",
          idempotencyKey: `full-img:${article.publicId}:${img.publicId}`,
          payload: { parentJob: job.publicId },
        })
        .returning();
      return createdJob;
    });
    imageJobIds.push(imgJob.id);
  }

  // 全部商品都起咗圖 job（N 件 → N 張）先算成功路徑；商品中途被刪而開唔到圖 → failed
  let allOk = imageJobIds.length >= links.length;
  const errors: string[] = [];
  for (const imageJobId of imageJobIds) {
    const imgJob = await db.query.gloGuideJobs.findFirst({ where: eq(gloGuideJobs.id, imageJobId) });
    if (!imgJob) continue;
    const ok = await runImageJob(db, imgJob, providers);
    if (!ok) {
      allOk = false;
      const failedJob = await db.query.gloGuideJobs.findFirst({ where: eq(gloGuideJobs.id, imageJobId) });
      if (failedJob?.error) errors.push(failedJob.error);
    }
  }

  // 最終以 DB 現行未刪圖結算，唔相信舊 job snapshot。若 recovery 仲有圖 active，
  // parent 保持 processing 並交畀最後一個 child 結算，絕唔准提早 pending_review。
  const settlement = await settleInputFromDb(db, article.id);
  if (settlement === "active") return;
  if (settlement === "failed") {
    allOk = false;
    if (errors.length === 0) errors.push("有失敗圖／完成圖少過已選商品數");
  } else {
    allOk = true;
  }

  if (allOk) {
    // 完整生成後 pending_review；圖片仍 reviewStatus=pending，主管逐張批咗先 approve
    // H2：條件式套用——文章中途被 published/archived 就唔郁佢，job 留 note
    const applied = await applyToEditableArticle(db, article.id, {
      generationStatus: "completed",
      generationError: null,
      status: "pending_review",
    });
    await setJob(db, job.id, {
      status: "completed",
      completedAt: new Date(),
      error: applied ? null : "note: 文章狀態已改變（published/archived），結果未套用",
    });
    if (applied) {
      void logAudit({
        actorRole: "system",
        action: "gloGuide.generationCompleted",
        targetType: "gloGuideArticle",
        targetId: article.id,
        detail: `指南「${article.title}」完整生成完成（${imageJobIds.length} 張圖），待審批`,
      });
    }
  } else {
    const msg = `圖片生成未完成：${errors.join("；") || "未知原因"}`.slice(0, 900);
    await applyToEditableArticle(db, article.id, { generationStatus: "failed", generationError: msg });
    await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
  }
}

// ──────────────────────────── 入口 ────────────────────────────

const runningJobs = new Set<number>();

/**
 * 跑單一 job（背景）。
 * M3：DB 原子認領——`UPDATE ... WHERE status='queued' RETURNING` 只准 queued→working，
 * 多 worker／重複 kick 撞唔到；in-memory set 只係額外保險。
 * submitted/processing 嘅 image job 唔喺度重跑——由 recovery 憑 providerJobId resume。
 */
export async function runGloGuideJob(
  jobId: number,
  providers: GloGuideProviders = defaultGloGuideProviders(),
): Promise<void> {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  const db = getDb();
  try {
    const jobMeta = await db.query.gloGuideJobs.findFirst({ where: eq(gloGuideJobs.id, jobId) });
    if (!jobMeta) return;
    if (!canClaimJobStatus(jobMeta.status)) return; // idempotent：完成／進行中唔再跑
    const claimed = await db
      .update(gloGuideJobs)
      .set({
        status: jobMeta.kind === "image" ? "submitted" : "processing",
        attempts: sql`${gloGuideJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(gloGuideJobs.id, jobId), eq(gloGuideJobs.status, "queued")))
      .returning();
    const job = claimed[0];
    if (!job) return; // 已被其他 worker 認領
    if (job.kind === "image") {
      await runImageJob(db, job, providers);
    } else if (job.kind === "article") {
      // H2：published/archived 唔俾重寫結果冚；job 留 note
      const cur = await db.query.gloGuideArticles.findFirst({
        where: eq(gloGuideArticles.id, job.articleId),
        columns: { status: true },
      });
      if (!cur || !shouldApplyGenerationToArticle(cur.status)) {
        await setJob(db, job.id, {
          status: "completed",
          completedAt: new Date(),
          error: `note: 文章狀態係 ${cur?.status ?? "唔存在"}，重寫結果唔套用`,
        });
      } else {
        await applyToEditableArticle(db, job.articleId, { generationStatus: "processing", generationError: null });
        try {
          await runTextGeneration(db, job, providers);
          const applied = await applyToEditableArticle(db, job.articleId, {
            generationStatus: "completed",
            status: "pending_review",
          });
          await setJob(db, job.id, {
            status: "completed",
            completedAt: new Date(),
            error: applied ? null : "note: 文章狀態已改變（published/archived），結果未套用",
          });
        } catch (e) {
          const msg = `文字生成失敗：${errText(e)}`.slice(0, 900);
          await applyToEditableArticle(db, job.articleId, { generationStatus: "failed", generationError: msg });
          await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
        }
      }
    } else {
      await runFullJob(db, job, providers);
    }
  } catch (e) {
    // 最後防線：job 級意外都要落 DB，唔准靜默
    const msg = `job 執行失敗：${errText(e)}`.slice(0, 900);
    console.error(`[glo-guide] job ${jobId} 意外失敗:`, e);
    await setJob(db, jobId, { status: "failed", error: msg, completedAt: new Date() }).catch(() => {});
  } finally {
    runningJobs.delete(jobId);
  }
}

/**
 * Job recovery（boot＋scheduler tick 都會叫）：
 * ─ queued 超過 5 分鐘（重開機前未 kick）→ 重新 kick；
 * ─ submitted/processing 超過 10 分鐘：image job 有 providerJobId → 憑 id resume poll＋轉存；
 *   其他（文字生成中途死）→ 標 failed 留 error（唔靜默重試）。
 */
export async function recoverGloGuideJobs(
  providers: GloGuideProviders = defaultGloGuideProviders(),
): Promise<{ requeued: number; resumed: number; failed: number }> {
  const db = getDb();
  const now = Date.now();
  const result = { requeued: 0, resumed: 0, failed: 0 };
  const stuck = await db
    .select()
    .from(gloGuideJobs)
    .where(
      and(
        inArray(gloGuideJobs.status, ["queued", "submitted", "processing"]),
        lt(gloGuideJobs.updatedAt, new Date(now - 5 * 60 * 1000)),
      ),
    )
    .limit(20);
  for (const job of stuck) {
    try {
      if (job.status === "queued") {
        result.requeued++;
        void runGloGuideJob(job.id, providers);
        continue;
      }
      // submitted / processing
      if (job.kind === "image" && job.imageId) {
        // iteration 4 修復：淨係 full/scheduled 嘅 child（payload.parentJob）先准結算文章——
        // 手動 image.generate 嘅 standalone job（payload 只有 requestedBy）recovery 只郁圖同 job，
        // 絕對唔准郁文章 status（唔係 draft 會跳過 article.submit 直接被搬去 pending_review）。
        const isFullChild =
          typeof (job.payload as Record<string, unknown> | null)?.parentJob === "string";
        if (job.providerJobId) {
          const image = await db.query.gloGuideImages.findFirst({
            where: eq(gloGuideImages.id, job.imageId),
          });
          const article = image
            ? await db.query.gloGuideArticles.findFirst({ where: eq(gloGuideArticles.id, image.articleId) })
            : null;
          const product = image?.productId
            ? await db.query.products.findFirst({ where: eq(products.id, image.productId) })
            : null;
          if (!image || !article || !product) throw new Error("recovery：關聯資料唔齊");
          const model = gloGuideModelImage();
          const base = (process.env.PUBLIC_BASE_URL || "https://redcode.red").replace(/\/+$/, "");
          const resumed = await providers.resumeImage(job.providerJobId, {
            articleId: article.id,
            imageId: image.id,
            productId: product.id,
            category: product.category,
            modelImage: modelImageForProvider(article.modelImage, base, model.absoluteUrl),
            productImage: product.image.startsWith("/") ? `${base}${product.image}` : product.image,
            experimental: EXPERIMENTAL_CATEGORIES.has(product.category),
            // recovery input 補返同一文章 context（同 runImageJob 一致）
            articleTheme: article.theme,
            articleBody: article.body,
            productName: product.name,
            variation: image.position,
          });
          if (resumed === null) continue; // provider 仲行緊，下個 tick 再睇
          // M3：recovery resume 都係 conditional 寫入——冚唔到已 completed/approved 圖
          const applied = await completeImageConditionally(db, image.id, image.version, resumed);
          await setJob(db, job.id, {
            status: "completed",
            completedAt: new Date(),
            error: applied ? null : "note: 圖片狀態已改變，recovery 結果未套用",
          });
          // full/scheduled child 成功後一定要重結算 parent/article（唔係 parent 會永遠卡住）；
          // standalone 手動圖 job 唔結算——文章狀態係員工嘅事（submit/approve 先郁得）
          if (isFullChild) await settleGloGuideArticleInDb(db, job.articleId);
          result.resumed++;
          continue;
        }
        // image job 冇 providerJobId（未提交到 Fashn 就死）：超過 10 分鐘 → 標 failed；
        // 結算文章同樣僅限 full/scheduled child（standalone 手動圖失敗唔郁文章）
        //（conditional：只標仲 queued/processing 嘅圖，唔冚已完成）
        if (job.updatedAt.getTime() < now - 10 * 60 * 1000) {
          const msg = "圖片 job 中斷且冇 provider job id，已標記失敗（請重生呢張圖）";
          await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
          await db
            .update(gloGuideImages)
            .set({ status: "failed", error: msg, updatedAt: new Date() })
            .where(
              and(eq(gloGuideImages.id, job.imageId), inArray(gloGuideImages.status, ["queued", "processing"])),
            );
          if (isFullChild) await settleGloGuideArticleInDb(db, job.articleId);
          result.failed++;
        }
        continue;
      }
      if (job.kind === "article") {
        // 純文字 job 同步執行，冇得 resume：超時即 failed（H2：published/archived 唔郁）
        if (job.updatedAt.getTime() < now - 10 * 60 * 1000) {
          const msg = "服務重啟時文字生成未完成，已標記失敗（請重新生成）";
          await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() });
          await applyToEditableArticle(db, job.articleId, { generationStatus: "failed", generationError: msg }).catch(() => {});
          result.failed++;
        }
        continue;
      }
      // full／scheduled parent 超時：唔好直接判死成篇——由 child image job 狀態結算
      // （仲有 active child 就乜都唔郁；child 齊咗就按規則 pending_review／failed，parent 跟住一致）
      if (job.updatedAt.getTime() < now - 10 * 60 * 1000) {
        await settleGloGuideArticleInDb(db, job.articleId);
      }
    } catch (e) {
      const msg = `recovery 失敗：${errText(e)}`.slice(0, 900);
      await setJob(db, job.id, { status: "failed", error: msg, completedAt: new Date() }).catch(() => {});
      if (job.kind === "image") {
        await db
          .update(gloGuideImages)
          .set({ status: "failed", error: msg, updatedAt: new Date() })
          .where(
            and(eq(gloGuideImages.id, job.imageId ?? -1), inArray(gloGuideImages.status, ["queued", "processing"])),
          )
          .catch(() => {});
        // 同上：standalone 手動圖 job（冇 payload.parentJob）recovery 失敗唔准郁文章狀態
        const isFullChild =
          typeof (job.payload as Record<string, unknown> | null)?.parentJob === "string";
        if (isFullChild) await settleGloGuideArticleInDb(db, job.articleId).catch(() => {});
      }
      result.failed++;
    }
  }
  return result;
}

/** scheduler 用：advisory lock 包裝。
 *  用 **transaction 級** pg_try_advisory_xact_lock：lock 同 callback 一定同一條
 *  connection／同一個 transaction（pg pool 逐次 execute 拎唔同 connection 嘅
 *  session lock/unlock 會甩鎖）；transaction 完結（commit/rollback）自動放鎖，
 *  唔使靜默 unlock。撞鎖（另一 instance 揸緊）→ 返 null，唔等唔阻塞。 */
export async function withGloGuideLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const got = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS got`);
    if ((got.rows[0] as { got: boolean } | undefined)?.got !== true) return null;
    return await fn();
  });
}

// ──────────────────────────── Recovery 結算規則（可驗證）────────────────────────────

/**
 * 圖片 job 有結果之後，成篇文章點結算（純函數，recovery 同實跑測試共用）：
 * ─ 仲有 active image job（queued/submitted/processing）→ "active"：乜都唔郁，細 job 主導；
 * ─ 文字失敗／有 failed image job／完成圖少過已選商品數（iteration 4：每件商品一張，
 *   唔再係固定 3 張）→ "failed"（落 generationError）；
 * ─ **逐件商品覆蓋**：完成圖淨計張數唔夠——員工可以為同一商品加多張圖，
 *   所以一定要「每件已連結商品都有一張完成圖」（coveredProducts < productCount → failed），
 *   唔係嘅話 N 張圖堆喺少過 N 件貨度都會誤判 ready；
 * ─ 否則 "ready"：article → pending_review（圖片仍等人手批）、parent job → completed。
 */
export type GloGuideSettleInput = {
  /** 文字生成已失敗（generationStatus='failed'） */
  textFailed: boolean;
  activeImageJobs: number;
  failedImageJobs: number;
  /** 未刪 completed 圖數 */
  completedImages: number;
  /** 已選商品數（gloGuideArticleProducts 行數；初始生成＝每件一張，所以完成圖要 ≥ 呢個數） */
  productCount: number;
  /** 有最少一張未刪 completed 圖嘅**已連結商品**數（要 == productCount 先算齊） */
  coveredProducts: number;
};
export type GloGuideSettleResult = "active" | "ready" | "failed";

export function settleGloGuideArticle(input: GloGuideSettleInput): GloGuideSettleResult {
  if (input.activeImageJobs > 0) return "active";
  if (
    input.textFailed ||
    input.failedImageJobs > 0 ||
    input.completedImages < Math.max(2, input.productCount) ||
    input.coveredProducts < input.productCount
  ) {
    return "failed";
  }
  return "ready";
}

/**
 * 由現行未刪圖嘅 image.status/productId 計結算（純函數）：歷史 failed job 唔計——
 * 同一張圖重生（version+1）後舊 failed job 唔會再令成篇永遠 failed；
 * 圖軟刪後亦唔再影響結算。linkedProductIds＝已選商品 id（完成圖要逐件蓋到）。
 */
export function settleFromImages(
  textFailed: boolean,
  images: readonly { status: string; productId?: number | null }[],
  linkedProductIds: readonly number[],
): GloGuideSettleResult {
  const completedWithProduct = new Set(
    images
      .filter((i) => i.status === "completed")
      .map((i) => i.productId)
      .filter((id): id is number => typeof id === "number"),
  );
  return settleGloGuideArticle({
    textFailed,
    activeImageJobs: images.filter((i) => i.status === "queued" || i.status === "processing").length,
    failedImageJobs: images.filter((i) => i.status === "failed").length,
    completedImages: images.filter((i) => i.status === "completed").length,
    productCount: linkedProductIds.length,
    coveredProducts: linkedProductIds.filter((id) => completedWithProduct.has(id)).length,
  });
}

/** 由 DB 攞現行未刪圖＋已選商品 id＋文章狀態，交畀 settleFromImages 結算（唔再數歷史 job） */
async function settleInputFromDb(db: Db, articleId: number): Promise<GloGuideSettleResult> {
  const article = await db.query.gloGuideArticles.findFirst({
    where: eq(gloGuideArticles.id, articleId),
  });
  const images = await db
    .select({ status: gloGuideImages.status, productId: gloGuideImages.productId })
    .from(gloGuideImages)
    .where(and(eq(gloGuideImages.articleId, articleId), isNull(gloGuideImages.deletedAt)));
  const links = await db
    .select({ productId: gloGuideArticleProducts.productId })
    .from(gloGuideArticleProducts)
    .where(eq(gloGuideArticleProducts.articleId, articleId));
  return settleFromImages(
    article?.generationStatus === "failed",
    images,
    links.map((l) => l.productId),
  );
}

/**
 * 結算一篇文章（child image job 有結果後／parent 超時後都叫呢個）：
 * 按 settleGloGuideArticle 規則更新 article；仲 active 就乜都唔郁。
 * 同時把冇郁嘅 parent（scheduled/full）job 一併結算，保證 parent 同 article 一致。
 */
async function settleGloGuideArticleInDb(db: Db, articleId: number): Promise<GloGuideSettleResult> {
  const result = await settleInputFromDb(db, articleId);
  if (result === "active") return result;
  if (result === "ready") {
    // 單一 conditional UPDATE：rejected 只補回生成完成狀態，唔會未經員工再提交就自動重返 pending_review。
    const settled = await db
      .update(gloGuideArticles)
      .set({
        generationStatus: "completed",
        generationError: null,
        status: sql`CASE WHEN ${gloGuideArticles.status} = 'rejected' THEN 'rejected' ELSE 'pending_review' END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gloGuideArticles.id, articleId),
          inArray(gloGuideArticles.status, ["draft", "pending_review", "rejected"]),
        ),
      )
      .returning({ id: gloGuideArticles.id });
    const applied = settled.length > 0;
    await db
      .update(gloGuideJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
        error: applied ? null : "note: 文章狀態已改變（published/archived），結算結果未套用",
      })
      .where(
        and(
          eq(gloGuideJobs.articleId, articleId),
          inArray(gloGuideJobs.kind, ["scheduled", "full"]),
          inArray(gloGuideJobs.status, ["queued", "submitted", "processing"]),
        ),
      );
  } else {
    const msg = "圖片生成未完成（有失敗圖／完成圖少過已選商品數），請重生或刪除失敗圖後再試";
    // H2：published/archived 文章唔郁
    await applyToEditableArticle(db, articleId, { generationStatus: "failed", generationError: msg });
    await db
      .update(gloGuideJobs)
           .set({ status: "failed", error: msg, completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(gloGuideJobs.articleId, articleId),
          inArray(gloGuideJobs.kind, ["scheduled", "full"]),
          inArray(gloGuideJobs.status, ["queued", "submitted", "processing"]),
        ),
      );
  }
  return result;
}
