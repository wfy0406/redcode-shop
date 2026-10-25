import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertTryOnMediaSecret,
  detectTryOnImageMime,
  normalizeTryOnModelImage,
  readTryOnMedia,
  signTryOnMediaUrl,
  tryOnMediaAbsolutePath,
  tryOnProductImageInput,
  verifyTryOnMediaSignature,
  writeTryOnMedia,
} from "./tryonMedia";

const PUBLIC_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = "unit-test-media-secret";
const NOW = 1_700_000_000_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);

let tempDir = "";
let oldPrivateDir: string | undefined;
let oldUploadsDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "redcode-tryon-test-"));
  oldPrivateDir = process.env.TRYON_PRIVATE_DIR;
  oldUploadsDir = process.env.UPLOADS_DIR;
  process.env.TRYON_PRIVATE_DIR = path.join(tempDir, "private");
  process.env.UPLOADS_DIR = path.join(tempDir, "uploads");
});

afterEach(async () => {
  if (oldPrivateDir === undefined) delete process.env.TRYON_PRIVATE_DIR;
  else process.env.TRYON_PRIVATE_DIR = oldPrivateDir;
  if (oldUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = oldUploadsDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe("私人圖片格式及存取", () => {
  it("以 magic bytes 分辨 PNG／JPEG／WEBP，混搭第二步唔會誤標 JPEG", () => {
    expect(detectTryOnImageMime(PNG)).toBe("image/png");
    expect(detectTryOnImageMime(JPEG)).toBe("image/jpeg");
    expect(detectTryOnImageMime(WEBP)).toBe("image/webp");
    expect(() => detectTryOnImageMime(Buffer.from("not an image"))).toThrow();
  });

  it("私人檔案只喺隔離目錄，權限係 0700／0600，可按 publicId 刪除", async () => {
    await writeTryOnMedia(PUBLIC_ID, "output", PNG);
    const absolute = tryOnMediaAbsolutePath(PUBLIC_ID, "output");
    expect(absolute.startsWith(path.join(tempDir, "private"))).toBe(true);
    expect((await stat(absolute)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(absolute))).mode & 0o777).toBe(0o700);
    await expect(readTryOnMedia(PUBLIC_ID, "output")).resolves.toEqual(PNG);
  });

  it("原相等比縮放及轉正，唔裁頭腳；輸出以真 JPEG magic bytes 保存", async () => {
    const source = await sharp({
      create: { width: 400, height: 800, channels: 3, background: "#c8a27a" },
    }).png().toBuffer();
    const normalized = await normalizeTryOnModelImage(`data:image/png;base64,${source.toString("base64")}`);
    const metadata = await sharp(normalized).metadata();
    expect(detectTryOnImageMime(normalized)).toBe("image/jpeg");
    expect(metadata).toMatchObject({ width: 400, height: 800, format: "jpeg" });
  });

  it("私有上傳商品圖按真格式轉 data URI；路徑穿越及含認證網址拒絕", async () => {
    await mkdir(process.env.UPLOADS_DIR!, { recursive: true });
    await writeFile(path.join(process.env.UPLOADS_DIR!, "product.png"), PNG);
    await expect(tryOnProductImageInput("/uploads/product.png")).resolves.toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
    await expect(tryOnProductImageInput("/uploads/../secret.png")).rejects.toThrow();
    await expect(tryOnProductImageInput("https://user:pass@example.com/product.png")).rejects.toThrow();
  });
});

describe("短期 HMAC signed URL", () => {
  function signed(now = NOW) {
    const url = signTryOnMediaUrl({ publicId: PUBLIC_ID, kind: "output", userId: 7, secret: SECRET, now });
    const parsed = new URL(url, "https://redcode.red");
    return {
      url,
      publicId: parsed.pathname.split("/")[4]!,
      kind: "output" as const,
      userId: Number(parsed.searchParams.get("u")),
      expires: Number(parsed.searchParams.get("e")),
      supplied: parsed.searchParams.get("s")!,
      secret: SECRET,
    };
  }

  it("正確 owner／kind／時效先通過；預設只有十分鐘", () => {
    const value = signed();
    expect(value.url).toContain("/api/tryon/media/");
    expect(value.expires - NOW).toBe(10 * 60 * 1000);
    expect(verifyTryOnMediaSignature({ ...value, now: NOW })).toBe(true);
  });

  it("錯用戶、錯 kind、過期及異常長未來時效全部拒絕", () => {
    const value = signed();
    expect(verifyTryOnMediaSignature({ ...value, userId: 8, now: NOW })).toBe(false);
    expect(verifyTryOnMediaSignature({ ...value, kind: "input", now: NOW })).toBe(false);
    expect(verifyTryOnMediaSignature({ ...value, now: value.expires })).toBe(false);
    expect(verifyTryOnMediaSignature({ ...value, expires: NOW + 16 * 60 * 1000, now: NOW })).toBe(false);
  });

  it("空 APP_SECRET 唔可以用嚟簽發或驗證私人圖片", () => {
    expect(() => assertTryOnMediaSecret(" ")).toThrow();
    expect(() => signTryOnMediaUrl({ publicId: PUBLIC_ID, kind: "input", userId: 7, secret: "" })).toThrow();
    expect(verifyTryOnMediaSignature({ ...signed(), secret: "", now: NOW })).toBe(false);
  });
});
