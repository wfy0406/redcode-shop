import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BYTES = 30 * 1024 * 1024;

export type TryOnMediaKind = "input" | "output";

export class TryOnMediaError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TryOnMediaError";
    this.code = code;
  }
}

function publicUploadDir(): string {
  return process.env.UPLOADS_DIR || "uploads";
}

export function tryOnPrivateDir(): string {
  return process.env.TRYON_PRIVATE_DIR || path.join(publicUploadDir(), "tryon-private");
}

export function tryOnMediaRelativePath(publicId: string, kind: TryOnMediaKind): string {
  if (!UUID_RE.test(publicId)) throw new TryOnMediaError("BAD_JOB_ID", "工作編號格式無效");
  return `${publicId}/${kind === "input" ? "input.jpg" : "output.png"}`;
}

export function tryOnMediaAbsolutePath(publicId: string, kind: TryOnMediaKind): string {
  return path.join(tryOnPrivateDir(), tryOnMediaRelativePath(publicId, kind));
}

export async function writeTryOnMedia(
  publicId: string,
  kind: TryOnMediaKind,
  bytes: Buffer,
): Promise<string> {
  const absolute = tryOnMediaAbsolutePath(publicId, kind);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, bytes, { mode: 0o600 });
  return tryOnMediaRelativePath(publicId, kind);
}

export async function readTryOnMedia(publicId: string, kind: TryOnMediaKind): Promise<Buffer> {
  return readFile(tryOnMediaAbsolutePath(publicId, kind));
}

export async function deleteTryOnMedia(publicId: string): Promise<void> {
  if (!UUID_RE.test(publicId)) return;
  await rm(path.join(tryOnPrivateDir(), publicId), { recursive: true, force: true });
}

export type TryOnImageMime = "image/jpeg" | "image/png" | "image/webp";

export function bufferToDataUri(bytes: Buffer, mime: TryOnImageMime): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** 以 magic bytes 辨認真格式；混搭第二步係 PNG，唔可以因內部檔名而誤標 JPEG。 */
export function detectTryOnImageMime(bytes: Buffer): TryOnImageMime {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  throw new TryOnMediaError("BAD_IMAGE", "圖片格式無效；請用 jpg／png／webp");
}

/** 手機原相：伺服器驗真檔頭、跟 EXIF 轉正、等比縮細，絕不裁走頭腳或改變身形。 */
export async function normalizeTryOnModelImage(dataUri: string): Promise<Buffer> {
  const match = DATA_URI_RE.exec(dataUri);
  if (!match || dataUri.length > 14_500_000) {
    throw new TryOnMediaError("BAD_IMAGE", "請上傳 10MB 以內嘅 jpg／png／webp 全身相");
  }
  const raw = Buffer.from(match[2], "base64");
  if (!raw.length || raw.length > MAX_INPUT_BYTES) {
    throw new TryOnMediaError("BAD_IMAGE_SIZE", "圖片超過 10MB，請先縮細再試");
  }
  try {
    const sharp = (await import("sharp")).default;
    const source = sharp(raw, { limitInputPixels: 25_000_000 });
    const metadata = await source.metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
      throw new Error("unsupported");
    }
    if (!metadata.width || !metadata.height || metadata.width < 300 || metadata.height < 300) {
      throw new TryOnMediaError("IMAGE_TOO_SMALL", "圖片太細；請用最少 300 × 300，全身清晰會更好");
    }
    return await source
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (error) {
    if (error instanceof TryOnMediaError) throw error;
    throw new TryOnMediaError("BAD_IMAGE", "讀唔到呢張圖；iPhone HEIC 請先轉做 jpg，或直接影一張");
  }
}

export async function normalizeTryOnProviderOutput(dataUri: string): Promise<Buffer> {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUri);
  if (!match) throw new TryOnMediaError("BAD_PROVIDER_OUTPUT", "生成結果格式無效");
  const raw = Buffer.from(match[2], "base64");
  if (!raw.length || raw.length > MAX_PROVIDER_IMAGE_BYTES) {
    throw new TryOnMediaError("BAD_PROVIDER_OUTPUT", "生成結果大小無效");
  }
  try {
    const sharp = (await import("sharp")).default;
    const source = sharp(raw, { limitInputPixels: 40_000_000 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("bad dimensions");
    return await source.png({ compressionLevel: 8 }).toBuffer();
  } catch {
    throw new TryOnMediaError("BAD_PROVIDER_OUTPUT", "生成結果唔係有效圖片");
  }
}

/**
 * 商品 URL 只由 DB snapshot 傳入，絕不接前端自由 URL。
 * 私有上传商品圖直接讀 disk 轉 base64；其他公开 https 圖由供應商讀，本站唔做任意 URL fetch。
 */
export async function tryOnProductImageInput(productImagePath: string): Promise<string> {
  const local = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(productImagePath);
  if (local) {
    const ext = path.extname(local[1]).toLowerCase();
    if (![".png", ".webp", ".jpg", ".jpeg"].includes(ext)) {
      throw new TryOnMediaError("BAD_PRODUCT_IMAGE", "商品圖格式唔支援");
    }
    const bytes = await readFile(path.join(publicUploadDir(), local[1]));
    if (!bytes.length || bytes.length > MAX_PROVIDER_IMAGE_BYTES) {
      throw new TryOnMediaError("BAD_PRODUCT_IMAGE", "商品圖太大或已不存在");
    }
    return bufferToDataUri(bytes, detectTryOnImageMime(bytes));
  }
  if (/^https:\/\//i.test(productImagePath)) {
    const url = new URL(productImagePath);
    if (url.username || url.password) throw new TryOnMediaError("BAD_PRODUCT_IMAGE", "商品圖網址無效");
    return url.toString();
  }
  if (/^\/[A-Za-z0-9/_.,-]+$/.test(productImagePath) && !productImagePath.includes("..")) {
    const base = process.env.PUBLIC_BASE_URL || "https://redcode.red";
    const url = new URL(productImagePath, base);
    if (url.protocol !== "https:") throw new TryOnMediaError("BAD_PRODUCT_IMAGE", "商品圖網址無效");
    return url.toString();
  }
  throw new TryOnMediaError("BAD_PRODUCT_IMAGE", "商品原圖已不存在或格式唔支援");
}

export function assertTryOnMediaSecret(secret: string): void {
  if (!secret.trim()) {
    throw new TryOnMediaError("MEDIA_SECRET_MISSING", "私人圖片保護尚未配置，已停止建立試穿工作");
  }
}

function signature(publicId: string, kind: TryOnMediaKind, userId: number, expires: number, secret: string): string {
  assertTryOnMediaSecret(secret);
  return createHmac("sha256", secret)
    .update(`${publicId}.${kind}.${userId}.${expires}`)
    .digest("base64url");
}

export function signTryOnMediaUrl(args: {
  publicId: string;
  kind: TryOnMediaKind;
  userId: number;
  secret: string;
  now?: number;
  ttlMs?: number;
}): string {
  if (!UUID_RE.test(args.publicId) || !Number.isInteger(args.userId) || args.userId <= 0) {
    throw new TryOnMediaError("BAD_MEDIA_REQUEST", "私人圖片連結資料無效");
  }
  const expires = (args.now ?? Date.now()) + (args.ttlMs ?? 10 * 60 * 1000);
  const sig = signature(args.publicId, args.kind, args.userId, expires, args.secret);
  return `/api/tryon/media/${args.publicId}/${args.kind}?u=${args.userId}&e=${expires}&s=${encodeURIComponent(sig)}`;
}

export function verifyTryOnMediaSignature(args: {
  publicId: string;
  kind: TryOnMediaKind;
  userId: number;
  expires: number;
  supplied: string;
  secret: string;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (
    !args.secret.trim() ||
    !UUID_RE.test(args.publicId) ||
    !Number.isInteger(args.userId) ||
    args.userId <= 0 ||
    !Number.isInteger(args.expires) ||
    args.expires <= now
  ) {
    return false;
  }
  if (args.expires > now + 15 * 60 * 1000) return false;
  const expected = signature(args.publicId, args.kind, args.userId, args.expires, args.secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(args.supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
