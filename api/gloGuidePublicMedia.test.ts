/**
 * Glo Glo 公開圖片閘 route 測試（DB／檔案全部 mock，唔掂真 DB/disk）：
 * ─ published＋completed＋approved＋未刪＋合法 path → 200 出圖＋no-cache；
 * ─ 未發布（draft/pending/rejected/archived）／未批／未完成／已刪／唔存在 → 一律 404
 *   ＋noindex＋no-store（唔分「唔存在」同「未批」）；
 * ─ CDN／traversal／壞副檔名 → 404；DB 故障 fail-closed → 404。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// DB 替身：依 path 返預設 image/article（每個 test 設置）
let fakeImage: { status: string; reviewStatus: string; deletedAt: Date | null } | null = null;
let fakeArticle: { status: string } | null = null;
let dbShouldThrow = false;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    query: {
      gloGuideImages: {
        findFirst: async () => {
          if (dbShouldThrow) throw new Error("db down");
          return fakeImage;
        },
      },
      gloGuideArticles: {
        findFirst: async () => {
          if (dbShouldThrow) throw new Error("db down");
          return fakeArticle;
        },
      },
    },
  }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
}));

import { gloGuidePublicMedia } from "./gloGuidePublicMedia";

const app = new Hono();
app.get("/uploads/glo-guide/:file", gloGuidePublicMedia);

const okPath = "/uploads/glo-guide/abc123.png";
const okImage = { status: "completed", reviewStatus: "approved", deletedAt: null };

describe("公開 media 閘", () => {
  beforeEach(() => {
    fakeImage = { ...okImage };
    fakeArticle = { status: "published" };
    dbShouldThrow = false;
  });

  it("published＋approved＋合法 path → 200＋image/png＋no-cache,must-revalidate", async () => {
    const res = await app.request(okPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Cache-Control")).toContain("must-revalidate");
  });

  it("未發布文章（draft/pending_review/rejected/archived）→ 404＋noindex＋no-store", async () => {
    for (const status of ["draft", "pending_review", "rejected", "archived"]) {
      fakeArticle = { status };
      const res = await app.request(okPath);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("未批／未完成／已刪圖 → 404（同唔存在一樣）", async () => {
    for (const img of [
      { ...okImage, reviewStatus: "pending" },
      { ...okImage, reviewStatus: "rejected" },
      { ...okImage, status: "processing" },
      { ...okImage, status: "failed" },
      { ...okImage, deletedAt: new Date() },
    ]) {
      fakeImage = img;
      expect((await app.request(okPath)).status).toBe(404);
    }
    fakeImage = null; // 唔存在
    expect((await app.request(okPath)).status).toBe(404);
  });

  it("壞副檔名／traversal → 404", async () => {
    expect((await app.request("/uploads/glo-guide/x.txt")).status).toBe(404);
    expect((await app.request("/uploads/glo-guide/..%2F..%2Fetc.png")).status).toBe(404);
  });

  it("DB 故障 fail-closed → 404（唔會因查唔到而放行未批內容）", async () => {
    dbShouldThrow = true;
    expect((await app.request(okPath)).status).toBe(404);
  });
});
