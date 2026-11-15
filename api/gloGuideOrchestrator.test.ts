/**
 * Glo Glo orchestrator 測試（唔掂 DB）：
 * ─ settleGloGuideArticle 結算規則實跑（parent/child 一致性；iteration 4：完成圖門檻＝
 *   已選商品數，唔再係固定 3 張）；
 * ─ withGloGuideLock source guard：必須用 transaction 級 pg_try_advisory_xact_lock
 *   （session 級 advisory lock 喺 pool 下 lock/unlock 會落唔同 connection 而甩鎖）；
 * ─ recovery source guard：child image 結算後必須重結算 parent/article；
 * ─ 初始生成 source guard：每件已選商品啱啱一個 image job（N 件 → N 個），唔再補到 3–5 張。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyGloGuideClaimConflict, settleFromImages, settleGloGuideArticle } from "./gloGuideOrchestrator";

describe("settleGloGuideArticle（recovery 結算規則）", () => {
  const ok = (over: Partial<Parameters<typeof settleGloGuideArticle>[0]> = {}) => ({
    textFailed: false,
    activeImageJobs: 0,
    failedImageJobs: 0,
    completedImages: 3,
    productCount: 3,
    coveredProducts: 3,
    ...over,
  });

  it("仲有 active image job → active（乜都唔郁，細 job 主導）", () => {
    expect(settleGloGuideArticle(ok({ activeImageJobs: 1, completedImages: 2, coveredProducts: 2 }))).toBe("active");
    expect(settleGloGuideArticle(ok({ activeImageJobs: 2, failedImageJobs: 1, completedImages: 1, coveredProducts: 1 }))).toBe("active");
  });
  it("全部 child 完成＋完成圖夠已選商品數＋逐件蓋齊＋文字冇失敗 → ready（pending_review）", () => {
    // 2 件貨 → 2 張完成圖就 ready（iteration 4：唔再要夠 3 張）
    expect(settleGloGuideArticle(ok({ completedImages: 2, productCount: 2, coveredProducts: 2 }))).toBe("ready");
    // 5 件貨 → 5 張完成圖 ready
    expect(settleGloGuideArticle(ok({ completedImages: 5, productCount: 5, coveredProducts: 5 }))).toBe("ready");
    // 員工加咗圖（完成圖多過商品數）一樣 ready——只要逐件貨都蓋到
    expect(settleGloGuideArticle(ok({ completedImages: 6, productCount: 4, coveredProducts: 4 }))).toBe("ready");
  });
  it("文字失敗／有 failed child／完成圖少過已選商品數 → failed", () => {
    expect(settleGloGuideArticle(ok({ textFailed: true }))).toBe("failed");
    expect(settleGloGuideArticle(ok({ failedImageJobs: 1 }))).toBe("failed");
    // 3 件貨得 2 張完成圖 → failed（舊規則 <3 先 failed；新規則係 < 商品數）
    expect(settleGloGuideArticle(ok({ completedImages: 2, coveredProducts: 2 }))).toBe("failed");
    // 5 件貨得 4 張 → failed
    expect(settleGloGuideArticle(ok({ completedImages: 4, productCount: 5, coveredProducts: 4 }))).toBe("failed");
  });
  it("回歸：N 張完成圖堆喺少過 N 件貨度（coveredProducts < productCount）→ failed，唔准假 ready", () => {
    // 情境：商品 C 張圖失敗被刪，員工為商品 A 加多咗圖——3 件貨得 2 件有圖
    expect(settleGloGuideArticle(ok({ completedImages: 3, productCount: 3, coveredProducts: 2 }))).toBe("failed");
    expect(settleGloGuideArticle(ok({ completedImages: 6, productCount: 4, coveredProducts: 3 }))).toBe("failed");
  });
});

describe("settleFromImages（以現行未刪圖為準，歷史 job 唔污染）", () => {
  it("舊失敗→重生成功→可 ready：圖而家全部 completed 兼逐件貨蓋齊就 ready，唔理舊 failed job", () => {
    // 情境：v1 生成失敗（job failed），v2 重生成功——image.status 而家係 completed
    const images = [
      { status: "completed", productId: 1 },
      { status: "completed", productId: 2 },
      { status: "completed", productId: 3 },
    ];
    expect(settleFromImages(false, images, [1, 2, 3])).toBe("ready");
  });
  it("重生緊（queued/processing）→ active，唔會誤判 failed", () => {
    const images = [
      { status: "completed", productId: 1 },
      { status: "completed", productId: 2 },
      { status: "processing", productId: 3 },
    ];
    expect(settleFromImages(false, images, [1, 2, 3])).toBe("active");
  });
  it("現行圖有 failed → failed；文字失敗 → failed；完成圖少過商品數 → failed", () => {
    expect(
      settleFromImages(false, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
        { status: "failed", productId: 3 },
      ], [1, 2, 3]),
    ).toBe("failed");
    expect(
      settleFromImages(true, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
        { status: "completed", productId: 3 },
      ], [1, 2, 3]),
    ).toBe("failed");
    // 2 件貨 2 張完成圖 → ready（舊規則會因 <3 張誤判 failed）
    expect(
      settleFromImages(false, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
      ], [1, 2]),
    ).toBe("ready");
    // 4 件貨得 2 張 → failed
    expect(
      settleFromImages(false, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
      ], [1, 2, 3, 4]),
    ).toBe("failed");
  });
  it("回歸：完成圖數夠但集中喺部分商品（某件貨冇圖）→ failed，唔會誤判 ready", () => {
    // 3 件已連結商品；3 張完成圖全部掛喺商品 1／2（商品 3 張圖失敗後被刪，之後加圖加錯咗落商品 1）
    const images = [
      { status: "completed", productId: 1 },
      { status: "completed", productId: 1 },
      { status: "completed", productId: 2 },
    ];
    expect(settleFromImages(false, images, [1, 2, 3])).toBe("failed");
    // 冇 productId 嘅完成圖（唔應該存在，但防禦性）唔計入覆蓋
    expect(
      settleFromImages(false, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
        { status: "completed", productId: null },
      ], [1, 2, 3]),
    ).toBe("failed");
    // 已刪商品嘅舊圖（productId 唔再喺 links）唔當覆蓋
    expect(
      settleFromImages(false, [
        { status: "completed", productId: 1 },
        { status: "completed", productId: 2 },
        { status: "completed", productId: 99 },
      ], [1, 2, 3]),
    ).toBe("failed");
  });
});

describe("recovery 認領衝突（唔准將進行中圖假裝完成）", () => {
  it("只有真 completed 先算完成；failed／刪除算失敗；queued／processing 保持 active", () => {
    expect(classifyGloGuideClaimConflict({ status: "completed" })).toBe("completed");
    expect(classifyGloGuideClaimConflict({ status: "failed" })).toBe("failed");
    expect(classifyGloGuideClaimConflict({ status: "completed", deletedAt: new Date() })).toBe("failed");
    expect(classifyGloGuideClaimConflict(null)).toBe("failed");
    expect(classifyGloGuideClaimConflict({ status: "queued" })).toBe("active");
    expect(classifyGloGuideClaimConflict({ status: "processing" })).toBe("active");
  });

  it("runFullJob 最終按 DB 現行圖結算；active 時直接交畀 recovery，唔落 pending_review", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
    const full = src.slice(src.indexOf("async function runFullJob"), src.indexOf("const runningJobs"));
    expect(full).toContain("const settlement = await settleInputFromDb(db, article.id)");
    expect(full).toContain('if (settlement === "active") return;');
    expect(full.indexOf('if (settlement === "active") return;')).toBeLessThan(full.indexOf('status: "pending_review"'));
    const image = src.slice(src.indexOf("async function runImageJob"), src.indexOf("async function runFullJob"));
    expect(image).toContain("classifyGloGuideClaimConflict(latestImage)");
    expect(image).toContain('if (conflict === "completed")');
    expect(image).toContain('if (conflict === "failed")');
    expect(image).not.toContain("圖片唔係 queued（已被另一 runner 認領或已完結）");
  });
});

describe("初始生成＝每件商品一個 image job（iteration 4 source guard）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  const full = src.slice(src.indexOf("async function runFullJob"), src.indexOf("const runningJobs"));
  it("逐已選商品起一張圖（loop 跟 links.length），唔再 Math.min(5, …) 補夠 3–5 張", () => {
    expect(full).toContain("for (let i = 0; i < links.length; i++)");
    expect(full).not.toContain("Math.min(5");
    expect(full).not.toContain("i % links.length"); // 唔再 round-robin 補圖
    // 全部商品都起咗圖 job 先係成功路徑（N 件 → N 張）
    expect(full).toContain("imageJobIds.length >= links.length");
  });
  it("初始生成**冇任何圖數上限**：N>24 件商品照樣起 N 個 job（SPEC 冇全局 cap）", () => {
    // 舊 Math.min(5,…) 同任何 GLO_GUIDE_IMAGE_MAX 式上限都唔准入 runFullJob
    expect(full).not.toContain("GLO_GUIDE_IMAGE_MAX");
    expect(full).not.toContain("IMAGE_MAX");
  });
});

describe("runImageJob preflight 韌性（iteration 4 修復 source guard）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function runImageJob"), src.indexOf("async function runFullJob"));
  it("商品／文章／圖 preflight 缺失唔再抛出：標圖 failed＋return false，畀 runFullJob 結算文章 failed", () => {
    // 舊版 throw 會直落 runGloGuideJob 外層 catch：淨係 job failed，圖永遠卡 queued、
    // full job 篇文章永遠卡 processing。所以 preflight 唔准再 throw。
    expect(fn).not.toContain('throw new Error("圖片對應商品已刪除")');
    expect(fn).not.toContain('throw new Error("article 唔存在")');
    expect(fn).not.toContain("throw new Error(`image ");
    // preflight 失敗路徑（failPreflight）要將仲 queued/processing 嘅圖標 failed（conditional，唔冚已完成）
    const failPath = fn.slice(fn.indexOf("failPreflight = async"), fn.indexOf("const image = await"));
    expect(failPath).toContain('inArray(gloGuideImages.status, ["queued", "processing"])');
    expect(failPath).toContain("setJob(db, job.id, { status: \"failed\"");
    expect(failPath).toContain("return false");
    // 三個 preflight 缺失都行 failPreflight
    expect(fn).toContain("return failPreflight(`image ${job.imageId} 唔存在或已刪除`, null)");
    expect(fn).toContain('return failPreflight("article 唔存在", image.id)');
    expect(fn).toContain('return failPreflight("圖片對應商品已刪除", image.id)');
  });
  it("model/base 計算＋provider 調用都喺 try 入面：呢段抛都會行「圖標 failed」路", () => {
    const tryAt = fn.indexOf("try {");
    expect(fn.indexOf("gloGuideModelImage()")).toBeGreaterThan(tryAt);
    expect(fn.indexOf("providers.generateImage")).toBeGreaterThan(tryAt);
  });
});

describe("recovery 結算範圍（iteration 4 修復 source guard）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  const rec = src.slice(src.indexOf("export async function recoverGloGuideJobs"), src.indexOf("export async function withGloGuideLock"));
  it("standalone 手動圖 job（payload 冇 parentJob）recovery 只郁圖同 job，唔 settle 文章", () => {
    // isFullChild＝payload.parentJob（full/scheduled child 標記）
    expect(rec).toContain("(job.payload as Record<string, unknown> | null)?.parentJob");
    // 4 處 settleGloGuideArticleInDb：resume 成功、無 providerJobId 超時、catch 補救（呢 3 個係 image job，
    // 全部要 isFullChild 閘住）＋ full/scheduled parent 超時（parent 本身就要結算，唔閘）
    const total = rec.split("settleGloGuideArticleInDb").length - 1;
    const gated = (rec.match(/if \(isFullChild\) await settleGloGuideArticleInDb/g) ?? []).length;
    expect(total).toBe(4);
    expect(gated).toBe(3);
    // parent 超時嗰個維持唔閘
    expect(rec).toContain("await settleGloGuideArticleInDb(db, job.articleId);\n      }\n    } catch");
  });
  it("runFullJob 建嘅 child image job payload 一定帶 parentJob（recovery 結算靠佢識別）", () => {
    const full = src.slice(src.indexOf("async function runFullJob"), src.indexOf("const runningJobs"));
    expect(full).toContain("payload: { parentJob: job.publicId }");
  });
});

describe("settle scope source guard", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  it("settleInputFromDb 只讀未刪圖，唔再掃歷史 image jobs", () => {
    const start = src.indexOf("async function settleInputFromDb");
    const end = src.indexOf("async function settleGloGuideArticleInDb");
    const fn = src.slice(start, end);
    expect(fn).toContain("isNull(gloGuideImages.deletedAt)");
    expect(fn).not.toContain("gloGuideJobs");
  });
});

describe("H2/M3 source guard（published 保護＋原子認領）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  it("job 認領係 DB 原子（queued→working RETURNING），唔係齋靠 in-memory set", () => {
    const claim = src.slice(src.indexOf("export async function runGloGuideJob"), src.indexOf("export async function runGloGuideJob") + 2500);
    expect(claim).toContain("canClaimJobStatus");
    expect(claim).toContain('eq(gloGuideJobs.status, "queued")');
    expect(claim).toContain(".returning()");
  });
  it("生成結果寫入係 conditional（published/archived 唔套用＋job 留 note）", () => {
    // applyToEditableArticle 用 status IN (draft/pending_review/rejected)
    const apply = src.slice(src.indexOf("async function applyToEditableArticle"), src.indexOf("async function applyToEditableArticle") + 900);
    expect(apply).toContain('"draft", "pending_review", "rejected"');
    // runFullJob 開頭檢查文章狀態；唔套用要留 note
    expect(src).toContain("shouldApplyGenerationToArticle");
    expect(src).toContain("note: 文章狀態已改變");
  });
  it("圖完成寫入 conditional＋新 path 重置 reviewStatus=pending 清 reviewer/time", () => {
    const complete = src.slice(src.indexOf("async function completeImageConditionally"), src.indexOf("async function completeImageConditionally") + 1200);
    expect(complete).toContain('"queued", "processing"');
    expect(complete).toContain("eq(gloGuideImages.version, expectedVersion)");
    expect(complete).toContain('reviewStatus: "pending"');
    expect(complete).toContain("reviewedById: null");
    expect(complete).toContain("reviewedAt: null");
  });
  it("runTextGeneration 唔會無條件換 title/body/theme（經 applyToEditableArticle）", () => {
    const text = src.slice(src.indexOf("async function runTextGeneration"), src.indexOf("async function runImageJob"));
    expect(text).toContain("applyToEditableArticle");
    expect(text).not.toContain("setArticleGen(db, article.id, {");
  });
  it("Fashn provider id 喺 generateImage callback 即刻落 job，唔等成張圖完成", () => {
    const image = src.slice(src.indexOf("async function runImageJob"), src.indexOf("async function runFullJob"));
    expect(image).toContain("onProviderJobId: async (providerJobId)");
    expect(image).toContain('setJob(db, job.id, { status: "processing", providerJobId })');
  });
  it("舊 runner 唔可以完成或標失敗重生後嘅新版本", () => {
    const image = src.slice(src.indexOf("async function runImageJob"), src.indexOf("async function runFullJob"));
    expect(image).toContain("completeImageConditionally(db, image.id, image.version, result)");
    expect(image).toContain("eq(gloGuideImages.version, image.version)");
    expect(image).toContain('eq(gloGuideImages.status, "processing")');
  });
  it("full job 每張 image＋image job 喺同一 transaction 建立", () => {
    const full = src.slice(src.indexOf("async function runFullJob"), src.indexOf("const runningJobs"));
    const loop = full.slice(full.indexOf("for (let i = 0; i < links.length"), full.indexOf("let allOk"));
    expect(loop).toContain("db.transaction(async (tx)");
    expect(loop).toContain("tx\n        .insert(gloGuideImages)");
    expect(loop).toContain("tx\n        .insert(gloGuideJobs)");
  });
});

describe("withGloGuideLock source guard（pool 安全）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  const lockFn = src.slice(src.indexOf("export async function withGloGuideLock"));
  it("用 transaction 級 advisory lock（同一 connection＋transaction 自動放鎖）", () => {
    expect(lockFn).toContain("db.transaction");
    expect(lockFn).toContain("pg_try_advisory_xact_lock");
    // 唔准用 session 級（pool 下會甩鎖）
    expect(lockFn).not.toContain("pg_advisory_unlock");
    expect(lockFn).not.toContain("pg_try_advisory_lock(");
  });
});

describe("recovery source guard（parent/child 一致結算）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  it("child image resume 成功後重結算 article", () => {
    // resume 成功分支（result.resumed++ 之前）一定要有 settleGloGuideArticleInDb
    const resumeIdx = src.indexOf("result.resumed++");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, resumeIdx - 600), resumeIdx)).toContain("settleGloGuideArticleInDb");
  });
  it("full/scheduled parent 超時唔直接判死成篇，而係由 child 結算", () => {
    const recovery = src.slice(src.indexOf("export async function recoverGloGuideJobs"));
    expect(recovery).toContain("settleGloGuideArticleInDb");
    expect(recovery).not.toContain("服務重啟時 job 未完成，已標記失敗（請重新生成）");
  });
  it("rejected 文章 recovery ready 只完成生成，唔自動推返 pending_review", () => {
    const settle = src.slice(src.indexOf("async function settleGloGuideArticleInDb"));
    expect(settle).toContain("CASE WHEN ${gloGuideArticles.status} = 'rejected' THEN 'rejected' ELSE 'pending_review' END");
  });
});

describe("scene context 接線 source guard（生成＋recovery 都帶文章 context）", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
  it("runImageJob generateImage 傳 articleTheme/articleBody/productName/variation", () => {
    const image = src.slice(src.indexOf("async function runImageJob"), src.indexOf("async function runFullJob"));
    expect(image).toContain("articleTheme: article.theme");
    expect(image).toContain("articleBody: article.body");
    expect(image).toContain("productName: product.name");
    expect(image).toContain("variation: image.position");
  });
  it("recovery resumeImage 補返同一文章 context（同 runImageJob 一致）", () => {
    const recovery = src.slice(src.indexOf("export async function recoverGloGuideJobs"));
    expect(recovery).toContain("articleTheme: article.theme");
    expect(recovery).toContain("articleBody: article.body");
    expect(recovery).toContain("productName: product.name");
    expect(recovery).toContain("variation: image.position");
  });
});
