/**
 * Glo Glo service 規則測試（唔掂 DB）：
 * ─ published 圖片 mutation 規則：published 指南唔准刪圖／改圖審批／加圖／重生圖
 *   （會即時破壞公開文）；draft/pending_review/rejected 先郁得；
 * ─ pickAutoProducts：本週可選 0/1 件 → 唔生成，2 件 → 2，≥3 → 3；
 * ─ source guard：service 真係喺 reviewImage/deleteImage/uploadImage/generateImages
 *   落 published 閘（防回歸）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gloGuidePublishedMutationError, isArticleEditable } from "./gloGuideValidation";
import { pickAutoProducts, type WeeklyProductDto } from "./gloGuideService";

describe("published 圖片 mutation 規則", () => {
  it("published 不可編輯；draft/pending_review/rejected/archived 可以", () => {
    expect(isArticleEditable("published")).toBe(false);
    for (const s of ["draft", "pending_review", "rejected", "archived"]) {
      expect(isArticleEditable(s)).toBe(true);
    }
  });

  it("review/delete/add/regenerate 四類 mutation 對 published 一律擋（純閘）", () => {
    for (const action of ["改圖片審批", "刪圖", "加圖", "重生圖"]) {
      expect(gloGuidePublishedMutationError(action, "published")).toContain("已發布");
      expect(gloGuidePublishedMutationError(action, "draft")).toBeNull();
      expect(gloGuidePublishedMutationError(action, "pending_review")).toBeNull();
      expect(gloGuidePublishedMutationError(action, "rejected")).toBeNull();
    }
  });

  it("service 每個圖片 mutator（review/delete/upload/generate/regenerate）都落咗 published 閘（source guard）", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    // M5：deleteImage／reviewImage 用 transaction 內 lockArticleForImageMutation（FOR UPDATE）擋 published
    for (const fn of ["deleteImage", "reviewImage"]) {
      const fnBody = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 1800);
      expect(fnBody).toContain("db.transaction");
      expect(fnBody).toContain("lockArticleForImageMutation");
    }
    // uploadImage／generateImages 都喺 transaction 內鎖文章再驗
    for (const fn of ["uploadImage", "generateImages"]) {
      const fnBody = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 2000);
      expect(fnBody).toContain("lockArticleForImageMutation");
    }
    // 共用鎖 helper：FOR UPDATE＋published 閘
    const helper = src.slice(src.indexOf("async function lockArticleForImageMutation"), src.indexOf("async function lockArticleForImageMutation") + 800);
    expect(helper).toContain("FOR UPDATE");
    expect(helper).toContain("gloGuidePublishedMutationError");
    // regenerateArticle 都擋 published
    const regen = src.slice(src.indexOf("export async function regenerateArticle"), src.indexOf("export async function regenerateArticle") + 900);
    expect(regen).toContain('"published"');
    expect(regen).toContain("唔可以直接重生");
  });

  it("H1/M4 source guard：generateImages 唔再寫文章 status；generateArticle 一個 transaction", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    const gen = src.slice(src.indexOf("export async function generateImages"), src.indexOf("export async function readImageForPreview"));
    // H1：唔准再用 stale bundle.status 寫文章 status
    expect(gen).not.toContain("bundle.article.status");
    expect(gen).toContain("db.transaction");
    expect(gen).toContain("lockArticleForImageMutation");
    const genArticle = src.slice(src.indexOf("export async function generateArticle"), src.indexOf("export async function recordFailedScheduledSlot"));
    // M4：文章＋links＋job 同一個 transaction；23505＋constraint 判定
    expect(genArticle).toContain("db.transaction");
    expect(genArticle).toContain("isUniqueViolation");
    expect(genArticle).toContain("gloguidejobs_idempotency");
    expect(genArticle).toContain("gloguidearticles_slug");
  });
});

describe("article update／regenerate 同 approve 嘅行鎖", () => {
  const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");

  it("update 喺 transaction 內 FOR UPDATE 重讀 status＋generationStatus，生成中唔准編輯", () => {
    const fn = src.slice(src.indexOf("export async function updateArticle"), src.indexOf("export async function submitArticle"));
    expect(fn).toContain("db.transaction(async (tx)");
    expect(fn).toContain('SELECT id, status, "generationStatus" FROM "gloGuideArticles"');
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain('["queued", "processing"].includes(existing.generationStatus)');
    expect(fn.indexOf("FOR UPDATE")).toBeLessThan(fn.indexOf("if (existing.status"));
  });

  it("regenerate 唔靠 tx 外舊 bundle；鎖內擋 published／生成中，再用鎖定 row 嘅 publicId 建 job", () => {
    const fn = src.slice(src.indexOf("export async function regenerateArticle"), src.indexOf("export async function updateArticle"));
    expect(fn).toContain("db.transaction(async (tx)");
    expect(fn).toContain('SELECT id, status, "generationStatus", "publicId" FROM "gloGuideArticles"');
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain('["queued", "processing"].includes(row.generationStatus)');
    expect(fn).toContain("return row.publicId");
    expect(fn).toContain("regen:${publicId}");
    expect(fn).not.toContain("const bundle =");
  });
});

describe("article.archive 落架", () => {
  it("service source guard：transaction FOR UPDATE 重讀狀態、published→archived、audit", () => {
    const src = readFileSync(path.join(__dirname, "gloGuideService.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function archiveArticle"));
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("archiveArticleError");
    expect(fn).toContain('"archived"');
    expect(fn).toContain("gloGuide.articleArchive");
  });
  it("archive 後即時停止公開：公開 DTO／media 閘／sitemap 都只認 published（source guard）", () => {
    const pub = readFileSync(path.join(__dirname, "gloGuidePublic.ts"), "utf8");
    // list 同 bySlug 都只查 published
    expect(pub.match(/status,\s*"published"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const seo = readFileSync(path.join(__dirname, "gloGuideSeo.ts"), "utf8");
    expect(seo).toContain('status, "published"');
    const media = readFileSync(path.join(__dirname, "gloGuidePublicMedia.ts"), "utf8");
    expect(media).toContain("evaluatePublicMediaAccess"); // 閘內 status!=="published" → 404
  });
});

describe("pickAutoProducts（自動揀貨）", () => {
  const mk = (id: number): WeeklyProductDto => ({
    id,
    name: `商品${id}`,
    image: `/uploads/p${id}.jpg`,
    price: 100,
    discountPrice: null,
    aiTags: [],
    liveDate: "20261118",
    liveSession: null,
    category: "top",
    stock: 1,
  });
  it("0／1 件 → 唔生成（最少 2 件）；2 件 → 2；≥3 → 3（最新優先）", () => {
    expect(pickAutoProducts([])).toEqual([]);
    expect(pickAutoProducts([mk(1)])).toEqual([]);
    expect(pickAutoProducts([mk(1), mk(2)]).map((p) => p.id)).toEqual([1, 2]);
    expect(pickAutoProducts([mk(1), mk(2), mk(3), mk(4)]).map((p) => p.id)).toEqual([1, 2, 3]);
  });
});
