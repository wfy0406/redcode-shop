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
  GLO_GUIDE_SOCIAL_IMAGE_MAX_BYTES,
  GLO_GUIDE_SOCIAL_IMAGE_WIDTH,
  gloGuideSocialImagePath,
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
    expect(svg).toContain("GLO GLO · 精選穿搭指南");
    expect(svg).toContain("Noto Serif CJK TC");
  });

  it("新 canonical 路徑係 .jpg＋encoded updatedAt cache-buster", () => {
    expect(gloGuideSocialImagePath("office-look", "2026-11-16T01:00:00.000Z")).toBe(
      "/og/glo-guide/office-look.jpg?v=2026-11-16T01%3A00%3A00.000Z",
    );
  });

  it("特殊字元會 escape，唔會穿出 SVG 或注入新元素", () => {
    const svg = buildGloGuideSocialSvg(
      makeDetail({ title: '返工 & <script>alert("x")</script>', theme: "A&B" }),
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("返工 &amp; &lt;script&gt;");
    expect(svg).toContain("A&amp;B");
  });

  it("真輸出 JPEG 係 1200×630 且 ≤280KB；封面會合成而非沿用直圖硬當 OG", async () => {
    const detail = makeDetail();
    const cover = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#d6b600" },
    }).png().toBuffer();
    const jpeg = await renderGloGuideSocialImage(detail, cover, "jpg");
    const metadata = await sharp(jpeg).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(GLO_GUIDE_SOCIAL_IMAGE_WIDTH);
    expect(metadata.height).toBe(GLO_GUIDE_SOCIAL_IMAGE_HEIGHT);
    expect(jpeg.length).toBeLessThanOrEqual(GLO_GUIDE_SOCIAL_IMAGE_MAX_BYTES);
    expect(jpeg.length).toBeGreaterThan(5_000);
  });

  it("複雜封面（噪點相）都行 quality ladder 壓到 ≤280KB，唔會出超標巨圖", async () => {
    const detail = makeDetail();
    // 高頻噪點係 JPEG 最難壓嘅內容——用呢個驗證 ladder 真係收斂到上限內
    const noise = Buffer.alloc(1600 * 2400 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
    const cover = await sharp(noise, { raw: { width: 1600, height: 2400, channels: 3 } })
      .png()
      .toBuffer();
    const jpeg = await renderGloGuideSocialImage(detail, cover, "jpg");
    const metadata = await sharp(jpeg).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
    expect(jpeg.length).toBeLessThanOrEqual(GLO_GUIDE_SOCIAL_IMAGE_MAX_BYTES);
  });

  it("quality ladder 全盡都超標 → 明確 throw，唔靜默出巨圖", async () => {
    await expect(
      renderGloGuideSocialImage(makeDetail(), undefined, "jpg", { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100B budget/);
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

  it("published 文章 .jpg?v=… → 200 image/jpeg，1200×630 ≤280KB；只用公開查詢返嚟嘅 approved cover", async () => {
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(async () => makeDetail(), readCover);
    const res = await app.request(
      "/og/glo-guide/office-look.jpg?v=2026-11-16T01%3A00%3A00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("ETag")).toMatch(/^W\/"glo-guide-v2-jpg-/);
    const body = Buffer.from(await res.arrayBuffer());
    const metadata = await sharp(body).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
    expect(body.length).toBeLessThanOrEqual(GLO_GUIDE_SOCIAL_IMAGE_MAX_BYTES);
    expect(readCover).toHaveBeenCalledOnce();
  });

  it("舊 .png 分享連結繼續出 200 image/png，唔會斷鏈或錯 Content-Type", async () => {
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(async () => makeDetail(), readCover);
    const res = await app.request("/og/glo-guide/office-look.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
    expect(res.headers.get("ETag")).toMatch(/^W\/"glo-guide-v2-png-/);
    const metadata = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(630);
  });

  it("相同 published 內容 revalidate → 304，唔再讀封面或重畫；文章仍逐次查公開狀態", async () => {
    const loadDetail = vi.fn(async () => makeDetail());
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(loadDetail, readCover);
    const first = await app.request("/og/glo-guide/office-look.jpg?v=2026-11-16T01%3A00%3A00.000Z");
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(readCover).toHaveBeenCalledOnce();

    const second = await app.request("/og/glo-guide/office-look.jpg", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(second.headers.get("Cache-Control")).toContain("must-revalidate");
    expect(readCover).toHaveBeenCalledOnce();
    expect(loadDetail).toHaveBeenCalledTimes(2);
  });

  it("ETag 帶格式＋設計版本：舊 PNG ETag 唔會令新 JPEG 請求誤回 304", async () => {
    const app = makeApp(async () => makeDetail());
    const pngRes = await app.request("/og/glo-guide/office-look.png");
    const pngEtag = pngRes.headers.get("ETag")!;
    const jpgRes = await app.request("/og/glo-guide/office-look.jpg");
    const jpgEtag = jpgRes.headers.get("ETag")!;
    expect(pngEtag).not.toBe(jpgEtag);

    // 拎住 PNG ETag 去問 JPEG：validator 唔同 → 一定要 200 重出 JPEG，唔准 304
    const mismatch = await app.request("/og/glo-guide/office-look.jpg", {
      headers: { "If-None-Match": pngEtag },
    });
    expect(mismatch.status).toBe(200);
    expect(mismatch.headers.get("Content-Type")).toContain("image/jpeg");

    // 舊格式（v1 無版本／格式段）ETag 同樣唔得令新 JPEG 回 304
    const legacy = await app.request("/og/glo-guide/office-look.jpg", {
      headers: { "If-None-Match": 'W/"glo-guide-someolddigest"' },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("ETag")).toBe(jpgEtag);
  });

  it("未發布／唔存在 → 404＋no-store，唔讀任何圖片（.jpg／.png 一樣）", async () => {
    const readCover = vi.fn(async () => undefined);
    const app = makeApp(async () => null, readCover);
    for (const p of ["/og/glo-guide/not-published.jpg", "/og/glo-guide/not-published.png"]) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(readCover).not.toHaveBeenCalled();
  });

  it("slug 不一致或壞路徑 → 404，唔准借預覽 endpoint 攞其他文章", async () => {
    const app = makeApp(async () => makeDetail());
    expect((await app.request("/og/glo-guide/other-article.jpg")).status).toBe(404);
    expect((await app.request("/og/glo-guide/other-article.png")).status).toBe(404);
    expect((await app.request("/og/glo-guide/office-look.svg")).status).toBe(404);
    expect((await app.request("/og/glo-guide/office-look")).status).toBe(404);
  });

  it("公開查詢故障 fail-closed → 503＋no-store，唔出通用舊圖扮成功", async () => {
    const app = makeApp(async () => {
      throw new Error("db down");
    });
    for (const p of ["/og/glo-guide/office-look.jpg", "/og/glo-guide/office-look.png"]) {
      const res = await app.request(p);
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("封面檔案故障 → 503，唔會靜默改用通用品牌圖", async () => {
    const app = makeApp(async () => makeDetail(), async () => {
      throw new Error("missing file");
    });
    const res = await app.request("/og/glo-guide/office-look.jpg");
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("私人 modelImage／reference 相絕對唔會上卡：版式同讀檔只掂公開 coverImage", async () => {
    const detail = makeDetail({
      modelImage: { path: "/uploads/glo-guide-models/private-ref.png", prompt: "private" } as never,
    });
    const svg = buildGloGuideSocialSvg(detail);
    expect(svg).not.toContain("glo-guide-models");
    expect(svg).not.toContain("private-ref");
    // readPublishedCover 只讀 coverImage；就算 modelImage 指向真檔都唔會被呢度掂到
    const read = await readPublishedCover({ ...detail, coverImage: null }).catch(() => undefined);
    expect(read).toBeUndefined();
  });

  it("冇封面仍可出該篇專屬文字卡（JPEG 同 PNG），唔係空白或通用 logo", async () => {
    const detail = makeDetail({ coverImage: null });
    for (const format of ["jpg", "png"] as const) {
      const image = await renderGloGuideSocialImage(detail, undefined, format);
      const metadata = await sharp(image).metadata();
      expect(metadata.format).toBe(format === "jpg" ? "jpeg" : "png");
      expect(metadata.width).toBe(1200);
      expect(metadata.height).toBe(630);
      if (format === "jpg") expect(image.length).toBeLessThanOrEqual(GLO_GUIDE_SOCIAL_IMAGE_MAX_BYTES);
    }
  });
});
