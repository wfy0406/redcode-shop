import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import sharp from "sharp";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GuideDetail } from "@contracts/gloGuide";
import {
  buildGloGuideSocialSvg,
  createGloGuideSocialImageHandler,
  GLO_GUIDE_SOCIAL_IMAGE_HEIGHT,
  GLO_GUIDE_SOCIAL_IMAGE_WIDTH,
  readPublishedCover,
  renderGloGuideSocialImage,
} from "./gloGuideSocialImage";

function makeDetail(overrides: Partial<GuideDetail> = {}): GuideDetail {
  return {
    id: 1,
    slug: "office-look",
    title: "黃色外套返工咁襯",
    excerpt: "用米色高腰闊腳褲同白鞋，襯出乾淨利落嘅香港返工造型。",
    theme: "香港辦公室穿搭",
    publishedAt: "2026-11-16T01:00:00.000Z",
    updatedAt: "2026-11-16T01:00:00.000Z",
    coverImage: {
      id: 1,
      path: "/uploads/glo-guide/approved.png",
      alt: "黃色外套配搭圖",
      width: 800,
      height: 1200,
      position: 0,
      productId: 1,
    },
    products: [],
    body: "正文",
    images: [],
    modelImage: null,
    ...overrides,
  };
}

function makeApp(loadDetail: (slug: string) => Promise<GuideDetail | null>, readCover?: (detail: GuideDetail) => Promise<Buffer | undefined>) {
  const app = new Hono();
  app.get(
    "/og/glo-guide/:slug",
    createGloGuideSocialImageHandler({
      loadDetail,
      readCover: readCover ?? (async () => undefined),
    }),
  );
  return app;
}

describe("Glo Guide 專屬社交預覽圖", () => {
  it("SVG 有文章標題、主題、摘要及 1200×630 品牌版式，唔係通用 logo", () => {
    const svg = buildGloGuideSocialSvg(makeDetail());
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("黃色外套返工咁襯");
    expect(svg).toContain("香港辦公室穿搭");
    expect(svg).toContain("米色高腰闊腳褲");
    expect(svg).toContain("Glo Glo 撰寫");
    expect(svg).toContain("Noto Serif CJK TC");
  });

  it("特殊字元會 escape，唔會穿出 SVG 或注入新元素", () => {
    const svg = buildGloGuideSocialSvg(
      makeDetail({ title: '返工 & <script>alert("x")</script>', theme: "A&B" }),
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("返工 &amp; &lt;script&gt;");
    expect(svg).toContain("A&amp;B");
  });

  it("真輸出係 1200×630 PNG；封面會合成而非沿用直圖硬當 OG", async () => {
    const detail = makeDetail();
    const cover = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#d6b600" },
    }).png().toBuffer();
    const png = await renderGloGuideSocialImage(detail, cover);
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(GLO_GUIDE_SOCIAL_IMAGE_WIDTH);
    expect(metadata.height).toBe(GLO_GUIDE_SOCIAL_IMAGE_HEIGHT);
    expect(png.length).toBeGreaterThan(10_000);
  });

  it("真實封面讀檔只入 UPLOADS_DIR/glo-guide 單層合法檔名", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "glo-guide-social-"));
    const oldUploads = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = root;
    try {
      const dir = path.join(root, "glo-guide");
      await mkdir(dir, { recursive: true });
      const bytes = Buffer.from("approved-cover");
      await writeFile(path.join(dir, "approved.png"), bytes);
      await expect(readPublishedCover(makeDetail())).resolves.toEqual(bytes);
    } finally {
      if (oldUploads === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = oldUploads;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("真實封面讀檔拒絕 traversal、其他目錄、子目錄及前綴不符，唔會碰檔案", async () => {
    const badPaths = [
      "/uploads/glo-guide/../secret.png",
      "/uploads/other/approved.png",
      "/uploads/glo-guide/nested/approved.png",
      "/uploads/glo-guide/approved.png/extra",
      "https://example.com/approved.png",
    ];
    for (const coverPath of badPaths) {
      const detail = makeDetail({
        coverImage: { ...makeDetail().coverImage!, path: coverPath },
      });
      await expect(readPublishedCover(detail)).rejects.toThrow("Invalid public guide cover");
    }
  });

  it("published 文章 → 200 image/png；只用公開查詢返嚟嘅 approved cover", async () => {
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(async () => makeDetail(), readCover);
    const res = await app.request("/og/glo-guide/office-look.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("ETag")).toMatch(/^W\/"glo-guide-/);
    const metadata = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
    expect(readCover).toHaveBeenCalledOnce();
  });

  it("相同 published 內容 revalidate → 304，唔再讀封面或重畫；文章仍逐次查公開狀態", async () => {
    const loadDetail = vi.fn(async () => makeDetail());
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(loadDetail, readCover);
    const first = await app.request("/og/glo-guide/office-look.png");
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(readCover).toHaveBeenCalledOnce();

    const second = await app.request("/og/glo-guide/office-look.png", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(second.headers.get("Cache-Control")).toContain("must-revalidate");
    expect(readCover).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  it("未發布／唔存在 → 404＋no-store，唔讀任何圖片", async () => {
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(async () => null, readCover);
    const res = await app.request("/og/glo-guide/not-published.png");
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(readCover).not.toHaveBeenCalled();
  });

  it("slug 不一致或壞路徑 → 404，唔准借預覽 endpoint 攞其他文章", async () => {
    const app = makeApp(async () => makeDetail());
    expect((await app.request("/og/glo-guide/other-article.png")).status).toBe(404);
    expect((await app.request("/og/glo-guide/office-look.svg")).status).toBe(404);
  });

  it("公開查詢故障 fail-closed → 503＋no-store，唔出通用舊圖扮成功", async () => {
    const app = makeApp(async () => {
      throw new Error("db down");
    });
    const res = await app.request("/og/glo-guide/office-look.png");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("封面檔案故障 → 503，唔會靜默改用通用品牌圖", async () => {
    const app = makeApp(async () => makeDetail(), async () => {
      throw new Error("missing file");
    });
    const res = await app.request("/og/glo-guide/office-look.png");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("冇封面仍可出該篇專屬文字卡，唔係空白或通用 logo", async () => {
    const png = await renderGloGuideSocialImage(makeDetail({ coverImage: null }));
    const metadata = await sharp(png).metadata();
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });
});
