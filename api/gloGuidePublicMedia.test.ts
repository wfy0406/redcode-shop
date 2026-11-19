/**
 * Glo Glo 公開圖片閘 route 測試（DB／檔案全部 mock，唔掂真 DB/disk）：
 * ─ published＋completed＋approved＋未刪＋合法 path → 200 出圖＋no-cache＋弱 ETag；
 * ─ If-None-Match 命中 → 304（權限閘照舊先行）；
 * ─ 未發布（draft/pending/rejected/archived）／未批／未完成／已刪／唔存在 → 一律 404
 *   ＋noindex＋no-store（唔分「唔存在」同「未批」）；就算帶住啱 ETag 都照 404；
 * ─ CDN／traversal／壞副檔名 → 404；DB 故障 fail-closed → 404。
 * ─ R05 derivative：合法 ?w＋fmt → 行衍生路徑出對應 MIME；非法 w／fmt → 404；
 *   撤稿（archived）後 derivative URL 一樣 404＋no-store（fail-closed）。
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
// stat 替身：檔案永遠存在，size/mtime 固定 → ETag 可預測
const FAKE_STAT = { size: 1234, mtimeMs: 1700000000000, isFile: () => true };

vi.mock("node:fs/promises", () => ({
  readFile: async () => PNG_BYTES,
  stat: async () => FAKE_STAT,
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  rename: async () => undefined,
  rm: async () => undefined,
}));

// derivative 生成唔掂真 sharp：回固定 bytes 嘅假 pipeline
vi.mock("sharp", () => {
  const pipeline = {
    rotate: () => pipeline,
    resize: () => pipeline,
    avif: () => pipeline,
    webp: () => pipeline,
    toBuffer: async () => Buffer.from([0x00, 0x01, 0x02]),
  };
  return { default: () => pipeline };
});

import { gloGuidePublicMedia } from "./gloGuidePublicMedia";

const app = new Hono();
app.get("/uploads/glo-guide/:file", gloGuidePublicMedia);

const okPath = "/uploads/glo-guide/abc123.png";
const okImage = { status: "completed", reviewStatus: "approved", deletedAt: null };
const EXPECTED_ETAG = `W/"${FAKE_STAT.size}-${Math.trunc(FAKE_STAT.mtimeMs)}"`;

describe("公開 media 閘", () => {
  beforeEach(() => {
    fakeImage = { ...okImage };
    fakeArticle = { status: "published" };
    dbShouldThrow = false;
  });

  it("published＋approved＋合法 path → 200＋image/png＋no-cache,must-revalidate＋弱 ETag", async () => {
    const res = await app.request(okPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Cache-Control")).toContain("must-revalidate");
    expect(res.headers.get("ETag")).toBe(EXPECTED_ETAG);
  });

  it("If-None-Match 命中 → 304（慳頻寬，權限閘仍然先行）", async () => {
    const res = await app.request(okPath, { headers: { "If-None-Match": EXPECTED_ETAG } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(EXPECTED_ETAG);
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
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

  it("撤稿後帶住啱 ETag 都照 404（validator 唔會繞過權限閘）", async () => {
    fakeArticle = { status: "archived" };
    const res = await app.request(okPath, { headers: { "If-None-Match": EXPECTED_ETAG } });
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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

  it("R05：合法 derivative ?w=320&fmt=webp → 200 image/webp；fmt=avif → image/avif", async () => {
    const webp = await app.request(`${okPath}?w=320&fmt=webp`);
    expect(webp.status).toBe(200);
    expect(webp.headers.get("Content-Type")).toContain("image/webp");
    expect(webp.headers.get("Cache-Control")).toContain("no-cache");
    expect(webp.headers.get("ETag")).toBe(EXPECTED_ETAG);
    const avif = await app.request(`${okPath}?w=1600&fmt=avif`);
    expect(avif.status).toBe(200);
    expect(avif.headers.get("Content-Type")).toContain("image/avif");
  });

  it("R05：非法 derivative 參數一律 404（唔分參數錯定唔存在）", async () => {
    for (const query of [
      "w=999&fmt=webp", // 非白名單寬度
      "w=320&fmt=gif", // 非白名單格式
      "w=320", // 缺 fmt
      "fmt=webp", // 缺 w
      "w=abc&fmt=webp", // 非整數
    ]) {
      const res = await app.request(`${okPath}?${query}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("R05：撤稿後 derivative URL 一樣 404＋no-store（fail-closed）", async () => {
    fakeArticle = { status: "archived" };
    const res = await app.request(`${okPath}?w=480&fmt=avif`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
