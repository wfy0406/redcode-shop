/**
 * Glo Glo orchestrator 測試（唔掂 DB）：
 * ─ settleGloGuideArticle 結算規則實跑（parent/child 一致性）；
 * ─ withGloGuideLock source guard：必須用 transaction 級 pg_try_advisory_xact_lock
 *   （session 級 advisory lock 喺 pool 下 lock/unlock 會落唔同 connection 而甩鎖）；
 * ─ recovery source guard：child image 結算後必須重結算 parent/article。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settleFromImages, settleGloGuideArticle } from "./gloGuideOrchestrator";

describe("settleGloGuideArticle（recovery 結算規則）", () => {
  it("仲有 active image job → active（乜都唔郁，細 job 主導）", () => {
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 1, failedImageJobs: 0, completedImages: 2 }),
    ).toBe("active");
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 2, failedImageJobs: 1, completedImages: 1 }),
    ).toBe("active");
  });
  it("全部 child 完成＋≥3 圖＋文字冇失敗 → ready（pending_review）", () => {
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 0, failedImageJobs: 0, completedImages: 3 }),
    ).toBe("ready");
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 0, failedImageJobs: 0, completedImages: 5 }),
    ).toBe("ready");
  });
  it("文字失敗／有 failed child／完成圖少過 3 → failed", () => {
    expect(
      settleGloGuideArticle({ textFailed: true, activeImageJobs: 0, failedImageJobs: 0, completedImages: 3 }),
    ).toBe("failed");
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 0, failedImageJobs: 1, completedImages: 3 }),
    ).toBe("failed");
    expect(
      settleGloGuideArticle({ textFailed: false, activeImageJobs: 0, failedImageJobs: 0, completedImages: 2 }),
    ).toBe("failed");
  });
});

describe("settleFromImages（以現行未刪圖為準，歷史 job 唔污染）", () => {
  it("舊失敗→重生成功→可 ready：圖而家全部 completed 就 ready，唔理舊 failed job", () => {
    // 情境：v1 生成失敗（job failed），v2 重生成功——image.status 而家係 completed
    const images = [{ status: "completed" }, { status: "completed" }, { status: "completed" }];
    expect(settleFromImages(false, images)).toBe("ready");
  });
  it("重生緊（queued/processing）→ active，唔會誤判 failed", () => {
    const images = [{ status: "completed" }, { status: "completed" }, { status: "processing" }];
    expect(settleFromImages(false, images)).toBe("active");
  });
  it("現行圖有 failed → failed；文字失敗 → failed", () => {
    expect(settleFromImages(false, [{ status: "completed" }, { status: "completed" }, { status: "failed" }])).toBe("failed");
    expect(settleFromImages(true, [{ status: "completed" }, { status: "completed" }, { status: "completed" }])).toBe("failed");
    expect(settleFromImages(false, [{ status: "completed" }, { status: "completed" }])).toBe("failed"); // 少過 3 張
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
    const loop = full.slice(full.indexOf("for (let i = 0; i < target"), full.indexOf("let allOk"));
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
