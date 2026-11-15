/**
 * Glo Glo 精選配搭指南——圖片持久化 server-only provider。
 *
 * SPEC v1 生成流程第 6 步＋image.upload 合約：
 * ─ provider 完成後立即由 https 下載，只許 Fashn host（預設 fashn.ai 及子域，env 可加白名單）；
 * ─ 限制 redirect 次數／回應大小／格式；content-type 只作參考，真格式由 sharp 驗；
 * ─ 轉存 UPLOADS_DIR/glo-guide/<uuid>.png；公開 path 只係 /uploads/glo-guide/...；
 * ─ 人工上傳 JPEG/PNG/WebP ≤10MB，同樣 sharp 驗真圖再 re-encode；
 * ─ 短期 CDN URL 絕唔入庫／唔入 DTO；失敗清理半成品檔案。
 *
 * 對 orchestrator 嘅接合契約（見 ./gloGuideProviders.ts）：
 *   saveGloGuideUpload({filename, mime, data}): Promise<GloGuideStoredImage>
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GloGuideProviderError,
  type GloGuideStoredImage,
} from "./gloGuideProviders";
import {
  GLO_GUIDE_MODEL_IMAGE_PREFIX,
  GLO_GUIDE_PATH_PREFIX,
  isGloGuideImagePath,
  isGloGuideModelImagePath,
} from "./gloGuideValidation";

export const GLO_GUIDE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const GLO_GUIDE_MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
export const GLO_GUIDE_MEDIA_MAX_REDIRECTS = 3;
export const GLO_GUIDE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** 預設只信 Fashn；GLO_GUIDE_MEDIA_ALLOWED_HOSTS（逗號分隔）可以追加 CDN 域 */
const DEFAULT_ALLOWED_HOSTS = ["fashn.ai"];

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function uploadsRoot(override?: string): string {
  return override || process.env.UPLOADS_DIR || "uploads";
}

/** 白名單 host 檢查：精確等於或係其子域（cdn.fashn.ai 得，fashn.ai.evil.com 唔得） */
export function isAllowedGloGuideMediaHost(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}

function envAllowedHosts(extra?: readonly string[]): string[] {
  const fromEnv = (process.env.GLO_GUIDE_MEDIA_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...fromEnv, ...(extra ?? [])])];
}

/**
 * 驗證下載 URL：只許 https、白名單 host、唔准 userinfo、唔准非預設 port 花招。
 * 合法 → 返 normalized URL 字串；唔合法 → throw（唔會靜默跳過）。
 */
export function assertGloGuideDownloadUrl(
  url: string,
  allowedHosts: readonly string[],
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GloGuideProviderError("MEDIA_URL", "圖片下載網址無效");
  }
  if (parsed.protocol !== "https:") {
    throw new GloGuideProviderError("MEDIA_URL", "圖片下載只支援 https");
  }
  if (parsed.username || parsed.password) {
    throw new GloGuideProviderError("MEDIA_URL", "圖片下載網址唔准帶登入資料");
  }
  if (!isAllowedGloGuideMediaHost(parsed.hostname, allowedHosts)) {
    throw new GloGuideProviderError("MEDIA_HOST", `圖片下載網址主機唔喺白名單：${parsed.hostname}`);
  }
  return parsed.toString();
}

// ──────────────────────────── sharp 驗證＋re-encode ────────────────────────────

const ACCEPTED_SHARP_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * 以 sharp 讀真格式（唔信 content-type／副檔名），合格 → re-encode 做 PNG bytes 同尺寸。
 * 失敗一律 throw GloGuideProviderError，唔會照收原 bytes。
 */
async function verifyAndReencode(
  bytes: Buffer,
  errorCode: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  if (!bytes.length) {
    throw new GloGuideProviderError(errorCode, "圖片內容為空");
  }
  try {
    const sharp = (await import("sharp")).default;
    const source = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await source.metadata();
    if (!metadata.format || !ACCEPTED_SHARP_FORMATS.has(metadata.format)) {
      throw new GloGuideProviderError(errorCode, "圖片格式無效；只支援 JPEG／PNG／WebP");
    }
    if (!metadata.width || !metadata.height || metadata.width < 2 || metadata.height < 2) {
      throw new GloGuideProviderError(errorCode, "圖片尺寸無效");
    }
    const png = await source.png({ compressionLevel: 8 }).toBuffer();
    return { png, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof GloGuideProviderError) throw error;
    throw new GloGuideProviderError(errorCode, "讀唔到呢張圖；請確認係有效 JPEG／PNG／WebP");
  }
}

// ──────────────────────────── 落盤 ────────────────────────────

/**
 * 將 PNG bytes 寫入 UPLOADS_DIR/glo-guide/<uuid>.png。
 * 檔名由 server 產生（uuid），唔接外部檔名——由根本杜絕 path traversal。
 * 失敗會清理半成品；返嚟嘅公開 path 保證過 isGloGuideImagePath。
 */
async function persistPng(
  png: Buffer,
  width: number,
  height: number,
  uploadsDirOverride?: string,
): Promise<GloGuideStoredImage> {
  const dir = path.resolve(uploadsRoot(uploadsDirOverride), "glo-guide");
  const filename = `${randomUUID()}.png`;
  const absolute = path.resolve(dir, filename);
  // 雙重保險：就算邏輯將來改動，落盤位置都唔准溢出 glo-guide 目錄
  if (path.dirname(absolute) !== dir) {
    throw new GloGuideProviderError("MEDIA_PATH", "圖片存放路徑無效");
  }
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(absolute, png, { mode: 0o644 });
  } catch (error) {
    await rm(absolute, { force: true }).catch(() => {});
    throw new GloGuideProviderError(
      "MEDIA_WRITE",
      error instanceof Error ? `圖片寫入失敗：${error.message}` : "圖片寫入失敗",
    );
  }
  const publicPath = `${GLO_GUIDE_PATH_PREFIX}${filename}`;
  if (!isGloGuideImagePath(publicPath)) {
    await rm(absolute, { force: true }).catch(() => {});
    throw new GloGuideProviderError("MEDIA_PATH", "圖片公開路徑唔符合 /uploads/glo-guide/ 規格");
  }
  return { path: publicPath, width, height };
}

// ──────────────────────────── provider 完成圖下載 ────────────────────────────

export interface GloGuideDownloadOptions {
  fetchImpl?: FetchLike;
  /** 覆寫 UPLOADS_DIR（測試用） */
  uploadsDir?: string;
  /** 額外白名單 host（測試用；正式環境用 GLO_GUIDE_MEDIA_ALLOWED_HOSTS） */
  allowedHosts?: readonly string[];
  maxRedirects?: number;
  maxBytes?: number;
}

/**
 * 由 Fashn 短期 CDN URL 下載完成圖，驗證＋re-encode＋落盤。
 * ─ 每個 redirect hop 都重新驗證 https＋host 白名單；
 * ─ Content-Length 超上限即拒；實際 bytes 再計一次；
 * ─ content-type 只作參考，最終由 sharp 定生死；
 * ─ 失敗清理半成品，絕唔會留低殘缺檔或回傳 CDN URL。
 */
export async function downloadGloGuideProviderImage(
  url: string,
  options: GloGuideDownloadOptions = {},
): Promise<GloGuideStoredImage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowedHosts = envAllowedHosts(options.allowedHosts);
  const maxRedirects = options.maxRedirects ?? GLO_GUIDE_MEDIA_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? GLO_GUIDE_MAX_DOWNLOAD_BYTES;

  let current = assertGloGuideDownloadUrl(url, allowedHosts);
  let response: Response | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GLO_GUIDE_DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(current, { method: "GET", redirect: "manual", signal: controller.signal });
    } catch (error) {
      throw new GloGuideProviderError(
        "MEDIA_NETWORK",
        error instanceof Error && error.name === "AbortError"
          ? "下載生成圖逾時"
          : "下載生成圖失敗",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new GloGuideProviderError("MEDIA_REDIRECT", "圖片下載 redirect 冇目標");
      }
      if (hop === maxRedirects) {
        throw new GloGuideProviderError("MEDIA_REDIRECT", "圖片下載 redirect 太多次");
      }
      // redirect 目標都要過同一套白名單
      current = assertGloGuideDownloadUrl(new URL(location, current).toString(), allowedHosts);
      continue;
    }
    response = res;
    break;
  }

  if (!response) {
    throw new GloGuideProviderError("MEDIA_REDIRECT", "圖片下載 redirect 太多次");
  }
  if (!response.ok) {
    throw new GloGuideProviderError(
      "MEDIA_HTTP",
      `下載生成圖失敗（HTTP ${response.status}）`,
      response.status >= 500,
    );
  }

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new GloGuideProviderError("MEDIA_SIZE", "生成圖超過大小上限");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new GloGuideProviderError("MEDIA_NETWORK", "讀取生成圖內容失敗", true);
  }
  if (!bytes.length || bytes.length > maxBytes) {
    throw new GloGuideProviderError("MEDIA_SIZE", "生成圖大小無效或超過上限");
  }

  // content-type 只作 sanity 參考；真格式由 sharp 驗
  const { png, width, height } = await verifyAndReencode(bytes, "MEDIA_FORMAT");
  return persistPng(png, width, height, options.uploadsDir);
}

// ──────────────────────────── 人工上傳 ────────────────────────────

export interface GloGuideUploadOptions {
  uploadsDir?: string;
  maxBytes?: number;
}

/**
 * 人工上傳（WMS image.upload）：JPEG/PNG/WebP ≤10MB。
 * ─ 聲明嘅 filename／mime 只做記錄同粗篩，**唔作為格式依據**；
 * ─ data 先計大小，再由 sharp 驗真格式＋re-encode PNG 落盤。
 */
export async function saveGloGuideUpload(
  input: { filename: string; mime: string; data: Buffer },
  options: GloGuideUploadOptions = {},
): Promise<GloGuideStoredImage> {
  if (!input || typeof input !== "object") {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳資料無效");
  }
  const filename = typeof input.filename === "string" ? input.filename.trim() : "";
  const mime = typeof input.mime === "string" ? input.mime.trim().toLowerCase() : "";
  const data = input.data;
  if (!filename || filename.length > 200) {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳檔名無效");
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳內容為空");
  }
  const maxBytes = options.maxBytes ?? GLO_GUIDE_MAX_UPLOAD_BYTES;
  if (data.length > maxBytes) {
    throw new GloGuideProviderError("UPLOAD_SIZE", "圖片超過 10MB，請先縮細再試");
  }
  // 聲明 mime 若帶嚟就要合理（但最終唔信佢）
  if (mime && !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new GloGuideProviderError("UPLOAD_FORMAT", "只支援 JPEG／PNG／WebP 上傳");
  }
  const { png, width, height } = await verifyAndReencode(data, "UPLOAD_FORMAT");
  return persistPng(png, width, height, options.uploadsDir);
}

// ──────────────────────────── 模特兒原圖上傳（後台管理）────────────────────────────

const MODEL_EXT_BY_FORMAT: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

/**
 * 模特兒原圖用嘅格式保持 re-encode：sharp 驗真格式（JPEG/PNG/WebP；SVG 等一律拒），
 * 然後**同格式**重編碼——相親照片保持 JPEG（質量 90）唔會像 PNG 咁膨脹到幾十 MB
 * （呢啲相之後要做 data URI 俾 Fashn）；剝晒 EXIF／嵌入 payload。
 * 失敗一律 throw GloGuideProviderError，唔會照收原 bytes。
 */
async function verifyAndReencodeModel(
  bytes: Buffer,
): Promise<{ data: Buffer; ext: string; width: number; height: number }> {
  if (!bytes.length) {
    throw new GloGuideProviderError("UPLOAD_INPUT", "圖片內容為空");
  }
  try {
    const sharp = (await import("sharp")).default;
    const source = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await source.metadata();
    if (!metadata.format || !ACCEPTED_SHARP_FORMATS.has(metadata.format)) {
      throw new GloGuideProviderError("UPLOAD_FORMAT", "圖片格式無效；只支援 JPEG／PNG／WebP");
    }
    if (!metadata.width || !metadata.height || metadata.width < 2 || metadata.height < 2) {
      throw new GloGuideProviderError("UPLOAD_FORMAT", "圖片尺寸無效");
    }
    // rotate() 食 EXIF orientation 先好重編碼——唔係直倒相片會橫咗
    const pipeline = source.rotate();
    const data =
      metadata.format === "jpeg"
        ? await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
        : metadata.format === "webp"
          ? await pipeline.webp({ quality: 90 }).toBuffer()
          : await pipeline.png({ compressionLevel: 8 }).toBuffer();
    return { data, ext: MODEL_EXT_BY_FORMAT[metadata.format]!, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof GloGuideProviderError) throw error;
    throw new GloGuideProviderError("UPLOAD_FORMAT", "讀唔到呢張圖；請確認係有效 JPEG／PNG／WebP");
  }
}

/**
 * 模特兒原圖上傳（官網 /admin 後台）：JPEG/PNG/WebP ≤10MB。
 * ─ 聲明嘅 filename／mime 只做記錄同粗篩，**唔作為格式依據**（SVG 會被 sharp 格式閘擋）；
 * ─ sharp 驗真圖＋同格式 re-encode，落 UPLOADS_DIR/glo-guide-models/<uuid>.<ext>；
 * ─ 檔名由 server 產生（uuid），唔接外部檔名；公開 path 過 isGloGuideModelImagePath 先回。
 * 注意：呢個目錄**唔公開**（冇公開路由放行 glo-guide-models/*）；Fashn 嗰邊係經
 * gloGuideFashn resolveGloGuideModelImageInput 讀 disk 轉 data URI。
 */
export async function saveGloGuideModelImage(
  input: { filename: string; mime: string; data: Buffer },
  options: GloGuideUploadOptions = {},
): Promise<GloGuideStoredImage> {
  if (!input || typeof input !== "object") {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳資料無效");
  }
  const filename = typeof input.filename === "string" ? input.filename.trim() : "";
  const mime = typeof input.mime === "string" ? input.mime.trim().toLowerCase() : "";
  const data = input.data;
  if (!filename || filename.length > 200) {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳檔名無效");
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    throw new GloGuideProviderError("UPLOAD_INPUT", "上傳內容為空");
  }
  const maxBytes = options.maxBytes ?? GLO_GUIDE_MAX_UPLOAD_BYTES;
  if (data.length > maxBytes) {
    throw new GloGuideProviderError("UPLOAD_SIZE", "圖片超過 10MB，請先縮細再試");
  }
  if (mime && !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new GloGuideProviderError("UPLOAD_FORMAT", "只支援 JPEG／PNG／WebP 上傳");
  }
  const verified = await verifyAndReencodeModel(data);

  const dir = path.resolve(uploadsRoot(options.uploadsDir), "glo-guide-models");
  const storedName = `${randomUUID()}.${verified.ext}`;
  const absolute = path.resolve(dir, storedName);
  // 雙重保險：落盤位置唔准溢出 glo-guide-models 目錄
  if (path.dirname(absolute) !== dir) {
    throw new GloGuideProviderError("MEDIA_PATH", "圖片存放路徑無效");
  }
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(absolute, verified.data, { mode: 0o644 });
  } catch (error) {
    await rm(absolute, { force: true }).catch(() => {});
    throw new GloGuideProviderError(
      "MEDIA_WRITE",
      error instanceof Error ? `圖片寫入失敗：${error.message}` : "圖片寫入失敗",
    );
  }
  const publicPath = `${GLO_GUIDE_MODEL_IMAGE_PREFIX}${storedName}`;
  if (!isGloGuideModelImagePath(publicPath)) {
    await rm(absolute, { force: true }).catch(() => {});
    throw new GloGuideProviderError("MEDIA_PATH", "圖片路徑唔符合 /uploads/glo-guide-models/ 規格");
  }
  return { path: publicPath, width: verified.width, height: verified.height };
}
