import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  assertGloGuideDownloadUrl,
  downloadGloGuideProviderImage,
  isAllowedGloGuideMediaHost,
  saveGloGuideModelImage,
  saveGloGuideUpload,
} from "./gloGuideMedia";
import { isGloGuideImagePath, isGloGuideModelImagePath } from "./gloGuideValidation";

let uploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), "glo-guide-media-"));
});

afterEach(async () => {
  await rm(uploadsDir, { recursive: true, force: true });
});

async function makePng(width = 40, height = 60): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .png()
    .toBuffer();
}

function binaryResponse(bytes: Buffer, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), { status, headers });
}

describe("gloGuideMedia（下載＋上傳持久化）", () => {
  it("host 白名單：fashn.ai 及子域得，近似域名唔得", () => {
    const allowed = ["fashn.ai"];
    expect(isAllowedGloGuideMediaHost("fashn.ai", allowed)).toBe(true);
    expect(isAllowedGloGuideMediaHost("cdn.fashn.ai", allowed)).toBe(true);
    expect(isAllowedGloGuideMediaHost("fashn.ai.evil.com", allowed)).toBe(false);
    expect(isAllowedGloGuideMediaHost("notfashn.ai", allowed)).toBe(false);
  });

  it("下載只許 https＋白名單 host；http／其他 host／userinfo 全部 throw", () => {
    const allowed = ["cdn.example.com"];
    expect(assertGloGuideDownloadUrl("https://cdn.example.com/a.png", allowed)).toContain(
      "cdn.example.com",
    );
    expect(() => assertGloGuideDownloadUrl("http://cdn.example.com/a.png", allowed)).toThrowError(
      /https/,
    );
    expect(() => assertGloGuideDownloadUrl("https://evil.com/a.png", allowed)).toThrowError(
      /白名單/,
    );
    expect(() =>
      assertGloGuideDownloadUrl("https://u:p@cdn.example.com/a.png", allowed),
    ).toThrowError(/登入資料/);
  });

  it("成功下載：sharp 驗真圖 → re-encode PNG → /uploads/glo-guide/<uuid>.png", async () => {
    const png = await makePng(40, 60);
    const fetchImpl = vi.fn(async () => binaryResponse(png, 200, { "content-type": "image/png" }));
    const result = await downloadGloGuideProviderImage("https://cdn.example.com/result.png", {
      fetchImpl,
      uploadsDir,
      allowedHosts: ["cdn.example.com"],
    });

    expect(isGloGuideImagePath(result.path)).toBe(true);
    expect(result.path.startsWith("/uploads/glo-guide/")).toBe(true);
    expect(result.path.endsWith(".png")).toBe(true);
    expect(result.width).toBe(40);
    expect(result.height).toBe(60);
    // 真係落咗盤，而且係真 PNG
    const stored = sharp(path.join(uploadsDir, "glo-guide", path.basename(result.path)));
    const meta = await stored.metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(60);
    // 回傳嘅係站內 path，絕對唔係 CDN URL
    expect(result.path).not.toContain("cdn.example.com");
  });

  it("下載內容超過上限（content-length 申報）→ throw MEDIA_SIZE，唔會落盤", async () => {
    const fetchImpl = vi.fn(async () =>
      binaryResponse(Buffer.from("x"), 200, {
        "content-length": String(31 * 1024 * 1024),
      }),
    );
    await expect(
      downloadGloGuideProviderImage("https://cdn.example.com/big.png", {
        fetchImpl,
        uploadsDir,
        allowedHosts: ["cdn.example.com"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_SIZE" });
  });

  it("下載內容唔係圖（content-type 呃人）→ throw MEDIA_FORMAT", async () => {
    const fetchImpl = vi.fn(async () =>
      binaryResponse(Buffer.from("<html>not an image</html>"), 200, {
        "content-type": "image/png",
      }),
    );
    await expect(
      downloadGloGuideProviderImage("https://cdn.example.com/fake.png", {
        fetchImpl,
        uploadsDir,
        allowedHosts: ["cdn.example.com"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_FORMAT" });
  });

  it("redirect 目標去咗非白名單 host → throw，唔會跟", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("cdn.example.com")) {
        return new Response(null, { status: 302, headers: { location: "https://evil.com/x.png" } });
      }
      return binaryResponse(await makePng());
    });
    await expect(
      downloadGloGuideProviderImage("https://cdn.example.com/r.png", {
        fetchImpl,
        uploadsDir,
        allowedHosts: ["cdn.example.com"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_HOST" });
    // 只打過一次（redirect 目標未驗證前唔會 fetch）
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("上傳：JPEG magic bytes（申報 mime 呃人）→ sharp 照驗真格式，成功轉 PNG", async () => {
    const jpeg = await sharp({
      create: { width: 30, height: 45, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const result = await saveGloGuideUpload(
      { filename: "fake.png", mime: "image/png", data: jpeg },
      { uploadsDir },
    );
    expect(isGloGuideImagePath(result.path)).toBe(true);
    expect(result.width).toBe(30);
    expect(result.height).toBe(45);
    const meta = await sharp(
      path.join(uploadsDir, "glo-guide", path.basename(result.path)),
    ).metadata();
    expect(meta.format).toBe("png");
  });

  it("上傳：超過 10MB → throw UPLOAD_SIZE", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    await expect(
      saveGloGuideUpload({ filename: "big.png", mime: "image/png", data: big }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_SIZE" });
  });

  it("上傳：唔係 JPEG/PNG/WebP（GIF）→ throw UPLOAD_FORMAT", async () => {
    const gif = Buffer.from("GIF89a" + "x".repeat(100), "latin1");
    await expect(
      saveGloGuideUpload({ filename: "a.gif", mime: "image/gif", data: gif }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_FORMAT" });
  });

  it("上傳：假 PNG bytes → sharp 讀唔到 → throw UPLOAD_FORMAT，目錄冇半成品", async () => {
    const fake = Buffer.from("not-a-real-image-bytes");
    await expect(
      saveGloGuideUpload({ filename: "a.png", mime: "image/png", data: fake }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_FORMAT" });
    const { readdir } = await import("node:fs/promises");
    // glo-guide 目錄可能根本未建立；建立咗都一定要係空
    const dir = path.join(uploadsDir, "glo-guide");
    const entries = await readdir(dir).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });
});

describe("saveGloGuideModelImage（後台模特兒原圖：sharp 驗證＋同格式 re-encode）", () => {
  it("PNG 上傳 → /uploads/glo-guide-models/<uuid>.png，真落盤兼過路徑閘", async () => {
    const png = await makePng(64, 96);
    const result = await saveGloGuideModelImage(
      { filename: "model.png", mime: "image/png", data: png },
      { uploadsDir },
    );
    expect(isGloGuideModelImagePath(result.path)).toBe(true);
    expect(result.path.startsWith("/uploads/glo-guide-models/")).toBe(true);
    expect(result.path.endsWith(".png")).toBe(true);
    expect(result.width).toBe(64);
    expect(result.height).toBe(96);
    const meta = await sharp(
      path.join(uploadsDir, "glo-guide-models", path.basename(result.path)),
    ).metadata();
    expect(meta.format).toBe("png");
  });

  it("JPEG 上傳 → 保持 JPEG（.jpg），唔會膨脹做 PNG", async () => {
    const jpeg = await sharp({
      create: { width: 30, height: 45, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const result = await saveGloGuideModelImage(
      { filename: "model.jpg", mime: "image/jpeg", data: jpeg },
      { uploadsDir },
    );
    expect(isGloGuideModelImagePath(result.path)).toBe(true);
    expect(result.path.endsWith(".jpg")).toBe(true);
    const meta = await sharp(
      path.join(uploadsDir, "glo-guide-models", path.basename(result.path)),
    ).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(45);
  });

  it("聲明 mime 呃人唔緊要——sharp 實測為準（話係 png 實係 jpeg → 存 .jpg）", async () => {
    const jpeg = await sharp({
      create: { width: 30, height: 45, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();
    const result = await saveGloGuideModelImage(
      { filename: "fake.png", mime: "image/png", data: jpeg },
      { uploadsDir },
    );
    expect(result.path.endsWith(".jpg")).toBe(true);
  });

  it("SVG 一律拒收（sharp 讀到都唔收），目錄冇半成品", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await expect(
      saveGloGuideModelImage({ filename: "a.svg", mime: "image/svg+xml", data: svg }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_FORMAT" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(uploadsDir, "glo-guide-models")).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });

  it("GIF／假圖 → UPLOAD_FORMAT", async () => {
    const gif = Buffer.from("GIF89a" + "x".repeat(100), "latin1");
    await expect(
      saveGloGuideModelImage({ filename: "a.gif", mime: "image/gif", data: gif }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_FORMAT" });
    await expect(
      saveGloGuideModelImage(
        { filename: "a.png", mime: "image/png", data: Buffer.from("not-real") },
        { uploadsDir },
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_FORMAT" });
  });

  it("超過 10MB → UPLOAD_SIZE；空內容／壞檔名 → UPLOAD_INPUT", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    await expect(
      saveGloGuideModelImage({ filename: "big.png", mime: "image/png", data: big }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_SIZE" });
    await expect(
      saveGloGuideModelImage({ filename: "", mime: "image/png", data: Buffer.from("x") }, { uploadsDir }),
    ).rejects.toMatchObject({ code: "UPLOAD_INPUT" });
  });
});
