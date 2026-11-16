import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const orchestrator = readFileSync(path.join(__dirname, "gloGuideOrchestrator.ts"), "utf8");
const service = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
const sender = readFileSync(path.join(__dirname, "gloGuideReviewPush.ts"), "utf8");

describe("Glo Guide 待審批推播只綁真正 transition", () => {
  it("完整生成同文字重生成功後，以穩定 job publicId 通知", () => {
    const full = orchestrator.slice(orchestrator.indexOf("async function runFullJob"), orchestrator.indexOf("const runningJobs"));
    expect(full).toContain("if (applied && transitioned) {");
    expect(full).toContain("completeJobIfActive(");
    expect(full).toContain('void notifyGloGuideReviewers(article.id, `job:${job.publicId}`)');

    const article = orchestrator.slice(
      orchestrator.indexOf('} else if (job.kind === "article")'),
      orchestrator.indexOf("    } else {\n      await runFullJob"),
    );
    expect(article).toContain("completeJobIfActive(");
    expect(article).toContain("if (applied && transitioned) void notifyGloGuideReviewers(job.articleId, `job:${job.publicId}`)");
  });

  it("recovery 只有 active parent 真係轉 completed 先通知；重複結算唔會再推", () => {
    const settle = orchestrator.slice(orchestrator.indexOf("async function settleGloGuideArticleInDb"));
    expect(settle).toContain("const completedParents = await db");
    expect(settle).toContain('inArray(gloGuideJobs.status, ["queued", "submitted", "processing"])');
    expect(settle).toContain(".returning({ publicId: gloGuideJobs.publicId })");
    expect(settle).toContain("for (const parent of completedParents)");
    expect(settle).toContain('void notifyGloGuideReviewers(articleId, `job:${parent.publicId}`)');

    const recovery = orchestrator.slice(
      orchestrator.indexOf("export async function recoverGloGuideJobs"),
      orchestrator.indexOf("export async function withGloGuideLock"),
    );
    expect(recovery).not.toContain("notifyGloGuideReviewers");
  });

  it("人工 submit 只在 draft/rejected 過閘並完成 transaction 後通知，key 綁定提交版本", () => {
    const submit = service.slice(service.indexOf("export async function submitArticle"), service.indexOf("export async function approveArticle"));
    expect(submit).toContain('row.status !== "draft" && row.status !== "rejected"');
    expect(submit).toContain("evaluateGloGuideGate");
    expect(submit).toContain(".returning({ publicId: gloGuideArticles.publicId, updatedAt: gloGuideArticles.updatedAt })");
    expect(submit).toContain('void notifyGloGuideReviewers(id, `submit:${submitted.publicId}:${submitted.updatedAt.toISOString()}`)');
    expect(submit.indexOf("void logAudit")).toBeLessThan(submit.indexOf("void notifyGloGuideReviewers"));
  });

  it("send 前重查 DB：只有當刻仍 pending_review 先推，並用最新標題／商品連結數", () => {
    expect(sender).toContain('article.status !== "pending_review"');
    expect(sender).toContain("columns: { id: true, status: true, title: true }");
    expect(sender).toContain(".from(gloGuideArticleProducts)");
    expect(sender).toContain("productCount: links.length");
    expect(sender).toContain('action: result.ok ? "gloGuide.reviewPushSent" : "gloGuide.reviewPushFailed"');
  });
});
