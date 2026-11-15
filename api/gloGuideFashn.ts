/**
 * Glo Glo 精選配搭指南——Fashn 虛擬試穿 server-only provider。
 *
 * SPEC v1 生成流程第 5–6 步：
 * ─ 衣物主幹：POST https://api.fashn.ai/v1/run（model_name tryon-max）＋ poll /v1/status/<id>；
 * ─ 飾品／多品（input.experimental=true）：POST /v1/agent/images/run，屬 experimental 路線；
 * ─ model_image 只准 https 或站內真實授權 /gloglo-3.jpg（GLO_GUIDE_MODEL_IMAGE_URLS 可覆寫）；
 *   絕對唔用 AI 合成模特兒做參考原圖；
 * ─ 4xx／OutOfCredits 唔 retry；network／5xx 最多 2 次有 backoff；
 * ─ 完成後立即經 gloGuideMedia 下載轉存 /uploads/glo-guide/<uuid>.png；短期 CDN URL 唔出喺結果；
 * ─ 絕唔回 mock 圖或假成功；所有失敗 throw GloGuideProviderError。
 *
 * 對 orchestrator 嘅接合契約（見 ./gloGuideProviders.ts）：
 *   generateGloGuideImage(input): Promise<GloGuideImageGenResult>
 *   resumeGloGuideImage(providerJobId, input): Promise<GloGuideImageGenResult | null>（null＝仲行緊）
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  GloGuideProviderError,
  type GloGuideImageGenInput,
  type GloGuideImageGenResult,
} from "./gloGuideProviders";
import { downloadGloGuideProviderImage } from "./gloGuideMedia";

export const FASHN_BASE_URL = "https://api.fashn.ai/v1";
export const GLO_GUIDE_FASHN_TIMEOUT_MS = 25_000;
export const GLO_GUIDE_FASHN_MAX_RETRIES = 2;
export const GLO_GUIDE_FASHN_POLL_INTERVAL_MS = 2_000;
export const GLO_GUIDE_FASHN_MAX_POLLS = 60;
const MAX_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

// ──────────────────────────── 輸入影像解析 ────────────────────────────

/**
 * 模特兒參考圖白名單：
 * ─ https 絕對 URL（唔准帶 userinfo）→ 直接用；
 * ─ 站內絕對路徑 → 只准 /gloglo-3.jpg 或 GLO_GUIDE_MODEL_IMAGE_URLS（逗號分隔）列明嘅路徑，
 *   再用 PUBLIC_BASE_URL（必須 https）轉成絕對 URL；
 * ─ 其他一律拒絕（唔准 AI 合成模特兒、唔准任意站內檔）。
 */
export function resolveGloGuideModelImage(
  modelImage: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = typeof modelImage === "string" ? modelImage.trim() : "";
  if (!value) {
    throw new GloGuideProviderError("FASHN_MODEL_IMAGE", "缺少模特兒參考圖");
  }
  const overrides = (env.GLO_GUIDE_MODEL_IMAGE_URLS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new GloGuideProviderError("FASHN_MODEL_IMAGE", "模特兒參考圖網址無效");
    }
    return url.toString();
  }
  if (value.startsWith("/") && !value.includes("..") && /^\/[\w./-]+$/.test(value)) {
    const allowed = value === "/gloglo-3.jpg" || overrides.includes(value);
    if (!allowed) {
      throw new GloGuideProviderError(
        "FASHN_MODEL_IMAGE",
        "模特兒參考圖只可以用站內已授權照片（/gloglo-3.jpg 或 GLO_GUIDE_MODEL_IMAGE_URLS）",
      );
    }
    const base = (env.PUBLIC_BASE_URL || "https://redcode.red").trim();
    const url = new URL(value, base);
    if (url.protocol !== "https:") {
      throw new GloGuideProviderError("FASHN_MODEL_IMAGE", "PUBLIC_BASE_URL 必須係 https");
    }
    return url.toString();
  }
  throw new GloGuideProviderError(
    "FASHN_MODEL_IMAGE",
    "模特兒參考圖只支援 https 或站內已授權路徑",
  );
}

const DATA_URI_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;

function detectImageMime(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" {
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
  throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "商品圖格式無效；只支援 JPEG／PNG／WebP");
}

/**
 * 商品圖 → Fashn 可讀嘅輸入：
 * ─ https 絕對 URL（唔准 userinfo）→ 直接俾 provider 讀；
 * ─ data URI（jpeg/png/webp，≤30MB）→ 直接用；
 * ─ 站內 /uploads/<file> → server 讀 disk 轉 data URI（本站唔做任意 URL fetch）。
 */
export async function resolveGloGuideProductImage(productImage: string): Promise<string> {
  const value = typeof productImage === "string" ? productImage.trim() : "";
  if (!value) {
    throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "缺少商品原圖");
  }
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "商品圖網址無效");
    }
    return url.toString();
  }
  const dataUri = DATA_URI_RE.exec(value);
  if (dataUri) {
    const bytes = Buffer.from(dataUri[2]!, "base64");
    if (!bytes.length || bytes.length > MAX_PRODUCT_IMAGE_BYTES) {
      throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "商品圖太大或內容無效");
    }
    return value;
  }
  const local = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(value);
  if (local) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(process.env.UPLOADS_DIR || "uploads", local[1]!));
    } catch {
      throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "商品原圖已不存在");
    }
    if (!bytes.length || bytes.length > MAX_PRODUCT_IMAGE_BYTES) {
      throw new GloGuideProviderError("FASHN_PRODUCT_IMAGE", "商品圖太大或內容無效");
    }
    return `data:${detectImageMime(bytes)};base64,${bytes.toString("base64")}`;
  }
  throw new GloGuideProviderError(
    "FASHN_PRODUCT_IMAGE",
    "商品原圖只支援 https／站內 /uploads/ 路徑",
  );
}

// ──────────────────────────── prompt ────────────────────────────

const PLACEMENT: Record<string, string> = {
  top: "on the original person's upper body as the replacement upper-body garment",
  pants: "on the original person's lower body as the replacement lower-body garment",
  dress: "on the original person as the replacement dress",
  shoes: "on the original person's feet as the replacement shoes",
  accessory: "as a natural accessory on the original person, matching the visible styling",
};

function tryOnPrompt(category: string): string {
  const placement =
    PLACEMENT[category] ??
    "as a natural accessory on the original person, matching the visible styling";
  return `Edit model_image itself while keeping the same person, face, hair, body shape, pose, framing, camera angle, lighting and original background. Place product_image ${placement}, preserving its design, color, pattern, material appearance, logos and details. Keep all other clothing, accessories and scene elements unchanged.`;
}

// ──────────────────────────── HTTP＋retry ────────────────────────────

interface FashnConfig {
  apiKey: string;
  baseUrl: string;
}

function resolveConfig(options: GloGuideFashnOptions): FashnConfig {
  const apiKey = (options.apiKey ?? process.env.FASHN_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new GloGuideProviderError("FASHN_CONFIG", "Fashn 服務未配置（要 FASHN_API_KEY）");
  }
  const baseUrl = (options.baseUrl ?? FASHN_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new GloGuideProviderError("FASHN_CONFIG", "Fashn base URL 必須係 https");
  }
  return { apiKey, baseUrl };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function errorCodeForStatus(status: number): { code: string; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "FASHN_AUTH", retryable: false };
  if (status === 402) return { code: "FASHN_CREDITS", retryable: false };
  if (status === 429) return { code: "FASHN_RATE_LIMIT", retryable: true };
  if (status === 400 || status === 404 || status === 422) {
    return { code: "FASHN_INPUT", retryable: false };
  }
  return { code: `FASHN_HTTP_${status}`, retryable: status >= 500 };
}

/** provider 回報嘅失敗 code 入面，OutOfCredits 類一律唔 retry */
function isOutOfCredits(code: string, message: string): boolean {
  return /outofcredits|out_of_credits|insufficient.?credit/i.test(`${code} ${message}`);
}

async function fashnRequest(
  config: FashnConfig,
  fetchImpl: FetchLike,
  pathName: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLO_GUIDE_FASHN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${pathName}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new GloGuideProviderError(
      "FASHN_NETWORK",
      error instanceof Error && error.name === "AbortError"
        ? "Fashn 服務回應逾時"
        : "暫時連唔到 Fashn 服務",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const { code, retryable } = errorCodeForStatus(response.status);
    const message =
      code === "FASHN_AUTH"
        ? "Fashn 服務授權失敗，請管理員檢查伺服器設定"
        : code === "FASHN_CREDITS"
          ? "Fashn 服務額度不足"
          : code === "FASHN_RATE_LIMIT"
            ? "Fashn 服務繁忙，請稍後再試"
            : `Fashn 服務未能完成請求（HTTP ${response.status}）`;
    throw new GloGuideProviderError(code, message, retryable);
  }
  return record(body);
}

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 有限 retry：只對 retryable（network／429／5xx）補試，最多 maxRetries 次，backoff 遞增。
 * 4xx／OutOfCredits 等 retryable=false 嘅錯即刻拋出。
 */
async function withFashnRetry<T>(
  fn: () => Promise<T>,
  sleep: SleepLike,
  maxRetries: number,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const providerError =
        error instanceof GloGuideProviderError
          ? error
          : new GloGuideProviderError(
              "FASHN_UNKNOWN",
              error instanceof Error ? error.message : "Fashn 服務調用失敗",
              false,
            );
      if (!providerError.retryable || attempt >= maxRetries) throw providerError;
      await sleep(500 * (attempt + 1));
    }
  }
}

// ──────────────────────────── submit／poll ────────────────────────────

function parseSubmittedId(body: Record<string, unknown>): string {
  const id = body.id;
  if (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)) {
    throw new GloGuideProviderError("FASHN_BAD_RESPONSE", "Fashn 服務沒有返回工作編號", true);
  }
  return id;
}

type FashnStatus =
  | { state: "processing" }
  | { state: "completed"; imageUrl: string }
  | { state: "failed"; code: string; message: string };

function parseStatus(body: Record<string, unknown>): FashnStatus {
  const status = typeof body.status === "string" ? body.status : "";
  if (["starting", "in_queue", "processing"].includes(status)) return { state: "processing" };
  if (status === "completed") {
    const output = Array.isArray(body.output) ? body.output[0] : null;
    if (typeof output !== "string" || !/^https:\/\//i.test(output)) {
      throw new GloGuideProviderError(
        "FASHN_BAD_OUTPUT",
        "Fashn 服務沒有返回可下載嘅圖片網址",
        false,
      );
    }
    return { state: "completed", imageUrl: output };
  }
  const error = record(body.error);
  const code =
    typeof error.code === "string" && error.code.trim()
      ? error.code.slice(0, 64)
      : "PROVIDER_FAILED";
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.slice(0, 300)
      : "Fashn 服務未能完成生成";
  return { state: "failed", code, message };
}

function failedStatusError(status: { code: string; message: string }): GloGuideProviderError {
  if (isOutOfCredits(status.code, status.message)) {
    return new GloGuideProviderError("FASHN_CREDITS", "Fashn 服務額度不足，生成失敗", false);
  }
  return new GloGuideProviderError(
    "FASHN_FAILED",
    `Fashn 生成失敗（${status.code}）：${status.message}`,
    false,
  );
}

async function fetchStatusOnce(
  config: FashnConfig,
  fetchImpl: FetchLike,
  providerJobId: string,
): Promise<FashnStatus> {
  if (!/^[\w-]{1,160}$/.test(providerJobId)) {
    throw new GloGuideProviderError("FASHN_BAD_ID", "Fashn 工作編號格式無效");
  }
  const body = await fashnRequest(config, fetchImpl, `/status/${encodeURIComponent(providerJobId)}`, {
    method: "GET",
  });
  return parseStatus(body);
}

export interface GloGuideFashnOptions {
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  /** 測試注入；預設 process.env.FASHN_API_KEY */
  apiKey?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** 轉存用（傳俾 gloGuideMedia；測試可指去 tmp dir） */
  uploadsDir?: string;
  mediaAllowedHosts?: readonly string[];
  env?: Record<string, string | undefined>;
}

function validateInput(input: GloGuideImageGenInput): void {
  if (!input || typeof input !== "object") {
    throw new GloGuideProviderError("FASHN_INPUT", "圖片生成輸入無效");
  }
  for (const key of ["articleId", "imageId", "productId"] as const) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1) {
      throw new GloGuideProviderError("FASHN_INPUT", `圖片生成輸入 ${key} 無效`);
    }
  }
}

async function submitJob(
  config: FashnConfig,
  fetchImpl: FetchLike,
  input: GloGuideImageGenInput,
  modelImageUrl: string,
  productImageInput: string,
): Promise<string> {
  const pathName = input.experimental ? "/agent/images/run" : "/run";
  const payload = input.experimental
    ? {
        // experimental 路線：飾品／多品場景；結果同樣要過下載白名單＋人工審批
        model_name: "agent-images",
        inputs: {
          model_image: modelImageUrl,
          images: [productImageInput],
          prompt: tryOnPrompt(input.category),
          output_format: "png",
        },
      }
    : {
        model_name: "tryon-max",
        inputs: {
          model_image: modelImageUrl,
          product_image: productImageInput,
          prompt: tryOnPrompt(input.category),
          generation_mode: "quality",
          resolution: "1k",
          num_images: 1,
          output_format: "png",
        },
      };
  const body = await fashnRequest(config, fetchImpl, pathName, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return parseSubmittedId(body);
}

async function persistCompleted(
  imageUrl: string,
  options: GloGuideFashnOptions,
  providerJobId: string,
): Promise<GloGuideImageGenResult> {
  // 下載只許 Fashn hosts；失敗誠實 throw（MEDIA_* code），唔會留 CDN URL 喺結果
  const stored = await downloadGloGuideProviderImage(imageUrl, {
    fetchImpl: options.fetchImpl,
    uploadsDir: options.uploadsDir,
    allowedHosts: options.mediaAllowedHosts,
  });
  return { providerJobId, path: stored.path, width: stored.width, height: stored.height };
}

/**
 * 提交＋poll＋下載轉存一次過（接合契約 export）。
 * 4xx／OutOfCredits 唔 retry；network／5xx 每個 HTTP 調用最多補試 2 次（有 backoff）。
 * poll 超出 maxPolls 仍未完成 → throw FASHN_TIMEOUT（上層可以用 resumeGloGuideImage 補收）。
 */
export async function generateGloGuideImage(
  input: GloGuideImageGenInput,
  options: GloGuideFashnOptions = {},
): Promise<GloGuideImageGenResult> {
  validateInput(input);
  const config = resolveConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = GLO_GUIDE_FASHN_MAX_RETRIES;
  const maxPolls = Math.max(1, options.maxPolls ?? GLO_GUIDE_FASHN_MAX_POLLS);
  const pollInterval = Math.max(50, options.pollIntervalMs ?? GLO_GUIDE_FASHN_POLL_INTERVAL_MS);

  const modelImageUrl = resolveGloGuideModelImage(input.modelImage, options.env ?? process.env);
  const productImageInput = await resolveGloGuideProductImage(input.productImage);

  const providerJobId = await withFashnRetry(
    () => submitJob(config, fetchImpl, input, modelImageUrl, productImageInput),
    sleep,
    maxRetries,
  );
  // 一攞到 id 就即刻俾上層持久化；如果 poll 中途重啟，recovery 先有得憑 id 補收。
  await input.onProviderJobId?.(providerJobId);

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollInterval);
    const status = await withFashnRetry(
      () => fetchStatusOnce(config, fetchImpl, providerJobId),
      sleep,
      maxRetries,
    );
    if (status.state === "processing") continue;
    if (status.state === "failed") throw failedStatusError(status);
    return persistCompleted(status.imageUrl, options, providerJobId);
  }
  throw new GloGuideProviderError(
    "FASHN_TIMEOUT",
    "Fashn 生成逾時未完成；可稍後用 providerJobId 補收",
    true,
  );
}

/**
 * Job recovery（接合契約 export）：憑 providerJobId 查一次狀態。
 * ─ 仲行緊 → null（上層稍後再問）；
 * ─ 完成 → 立即下載轉存並回結果；
 * ─ 失敗 → throw（OutOfCredits／4xx 唔 retry）。
 * 單次狀態查詢嘅 network／5xx 最多補試 2 次；仍失敗誠實 throw，由上層決定幾時再 resume。
 */
export async function resumeGloGuideImage(
  providerJobId: string,
  input: GloGuideImageGenInput,
  options: GloGuideFashnOptions = {},
): Promise<GloGuideImageGenResult | null> {
  validateInput(input);
  const config = resolveConfig(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  const status = await withFashnRetry(
    () => fetchStatusOnce(config, fetchImpl, providerJobId),
    sleep,
    GLO_GUIDE_FASHN_MAX_RETRIES,
  );
  if (status.state === "processing") return null;
  if (status.state === "failed") throw failedStatusError(status);
  return persistCompleted(status.imageUrl, options, providerJobId);
}
