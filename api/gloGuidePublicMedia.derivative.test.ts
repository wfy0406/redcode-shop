/**
 * Glo Glo 公開 media derivative 真刀真槍測試（R05）：
 * 真 sharp＋真 tmp dir（唔 mock fs／sharp），只 mock DB 閘。
 * 證明：
 * ─ 合法 ?w＋fmt 由真 PNG 原圖衍生出真 WebP／AVIF bytes（sharp 讀得返、寬度正確、唔放大）；
 * ─ 衍生檔落 UPLOADS_DIR/glo-guide/.deriv/，第二次請求行 disk cache；
 * ─ 原圖請求（無 query）唔郁；
 * ─ 撤稿（article archived）後，就算衍生檔已喺 disk cache，都照 404＋no-store。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let articleStatus = "published";

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    query: {
      gloGuideImages: {
        findFirst: async () => ({
          status: "completed",
          reviewStatus: "approved",
          deletedAt: null,
        }),
      },
      gloGuideArticles: {
        findFirst: async () => ({ id: 1, status: articleStatus }),
      },
    },
  }),
}));

import { gloGuidePublicMedia } from "./gloGuidePublicMedia";

const app = new Hono();
app.get("/uploads/glo-guide/:file", gloGuidePublicMedia);

let uploadsDir = "";
const FILE = "11111111-2222-3333-4444-555555555555.png";
const ORIGINAL_WIDTH = 900;
const ORIGINAL_HEIGHT = 1200;

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), "glo-guide-media-"));
  process.env.UPLOADS_DIR = uploadsDir;
  // 真 PNG 原圖（900×1200 純色）：經真 sharp 產生，等同 upload pipeline 嘅產物
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: {
      width: ORIGINAL_WIDTH,
      height: ORIGINAL_HEIGHT,
      channels: 3,
      background: { r: 180, g: 120, b: 90 },
    },
  })
    .png()
    .toBuffer();
  const dir = path.join(uploadsDir, "glo-guide");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(dir, FILE), png));
});

afterAll(async () => {
  delete process.env.UPLOADS_DIR;
  await rm(uploadsDir, { recursive: true, force: true });
});

describe("公開 media derivative（真 sharp＋tmp dir）", () => {
  it("?w=320&fmt=webp → 真 WebP、寬 320、高按比例，衍生檔落 .deriv", async () => {
    const res = await app.request(`/uploads/glo-guide/${FILE}?w=320&fmt=webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/webp");
    const bytes = Buffer.from(await res.arrayBuffer());
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(Math.round((ORIGINAL_HEIGHT * 320) / ORIGINAL_WIDTH));
    const derivPath = path.join(uploadsDir, "glo-guide", ".deriv", `${path.parse(FILE).name}-w320.webp`);
    await expect(import("node:fs/promises").then((fs) => fs.stat(derivPath))).resolves.toBeTruthy();
  });

  it("?w=1600&fmt=avif → 唔放大（原寬 900），真 AVIF", async () => {
    const res = await app.request(`/uploads/glo-guide/${FILE}?w=1600&fmt=avif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/avif");
    const bytes = Buffer.from(await res.arrayBuffer());
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    // sharp 將 AVIF 報做 heif 容器＋av1 壓縮
    expect(meta.format).toBe("heif");
    expect(meta.compression).toBe("av1");
    expect(meta.width).toBe(ORIGINAL_WIDTH); // withoutEnlargement
  });

  it("無 query → 原圖 PNG 照舊（向後相容）", async () => {
    const res = await app.request(`/uploads/glo-guide/${FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    const sharp = (await import("sharp")).default;
    expect((await sharp(bytes).metadata()).width).toBe(ORIGINAL_WIDTH);
  });

  it("撤稿後衍生檔雖已喺 disk，一律 404＋no-store", async () => {
    // 先確保衍生檔已生成
    expect((await app.request(`/uploads/glo-guide/${FILE}?w=480&fmt=webp`)).status).toBe(200);
    articleStatus = "archived";
    const res = await app.request(`/uploads/glo-guide/${FILE}?w=480&fmt=webp`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    articleStatus = "published";
  });
});
