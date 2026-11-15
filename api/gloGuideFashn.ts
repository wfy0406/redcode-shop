/**
 * Glo Glo 精選配搭指南——Fashn 虛擬試穿 server-only provider。
 *
 * SPEC v1 生成流程第 5–6 步：
 * ─ 衣物主幹（冇文章場景 context）：POST https://api.fashn.ai/v1/run（model_name tryon-max）＋ poll /v1/status/<id>；
 * ─ 飾品／多品（input.experimental=true）：POST /v1/agent/images/run（flat body：prompt＋images[]），
 *   poll GET /v1/agent/status/<id>（predictions[].results[]），屬 experimental 路線；
 * ─ 有文章場景 context（articleTheme/articleBody 任一非空）：一律行同一條 agent/images/run 場景路線——
 *   場景跟文章主題／正文（office 等關鍵詞映射）、每張按 variation 換 pose／構圖、
 *   商品外觀以原商品圖硬參考（見 buildGloGuideScenePrompt）；prompt 唔保證一致性，
 *   最終閘仍係人工逐圖審批（唔會因為 prompt 就當自動合格）；
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
import { GLO_GUIDE_MODEL_IMAGE_PREFIX, isGloGuideModelImagePath } from "./gloGuideValidation";

export const FASHN_BASE_URL = "https://api.fashn.ai/v1";
export const GLO_GUIDE_FASHN_TIMEOUT_MS = 25_000;
export const GLO_GUIDE_FASHN_MAX_RETRIES = 2;
export const GLO_GUIDE_FASHN_POLL_INTERVAL_MS = 2_000;
export const GLO_GUIDE_FASHN_MAX_POLLS = 60;
const MAX_PRODUCT_IMAGE_BYTES = 30 * 1024 * 1024;
/** Agent Images 文件上限：每張 base64／data-URI 輸入圖 ≤10MB（超限會俾 400 BadRequest 打回頭） */
const FASHN_AGENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Agent prompt 文件上限 10,000 chars（超限會 400 BadRequest） */
const FASHN_AGENT_PROMPT_MAX_CHARS = 10_000;

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

const MAX_MODEL_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * 模特兒參考圖 → Fashn 可讀輸入（generateGloGuideImage 用呢個；sync 版保留俾直接 URL 場景）：
 * ─ /uploads/glo-guide-models/<uuid>.<ext>（後台上傳嘅真實授權原圖，**唔公開**）：
 *   server 由 UPLOADS_DIR 讀 disk → data URI 俾 Fashn，唔會轉公開 URL（轉咗都 404）；
 *   路徑必須過 isGloGuideModelImagePath（uuid 檔名，唔准 traversal／其他站內目錄）；
 * ─ 其他輸入照舊行 resolveGloGuideModelImage（https 直用；/gloglo-3.jpg／ENV 白名單轉絕對 URL）。
 * 讀唔到檔／超 30MB → 真錯誤 throw，絕唔 mock。
 */
export async function resolveGloGuideModelImageInput(
  modelImage: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const value = typeof modelImage === "string" ? modelImage.trim() : "";
  if (isGloGuideModelImagePath(value)) {
    const filename = value.slice(GLO_GUIDE_MODEL_IMAGE_PREFIX.length);
    let bytes: Buffer;
    try {
      bytes = await readFile(
        path.join(env.UPLOADS_DIR || process.env.UPLOADS_DIR || "uploads", "glo-guide-models", filename),
      );
    } catch {
      throw new GloGuideProviderError("FASHN_MODEL_IMAGE", "模特兒原圖檔案已不存在");
    }
    if (!bytes.length || bytes.length > MAX_MODEL_IMAGE_BYTES) {
      throw new GloGuideProviderError("FASHN_MODEL_IMAGE", "模特兒原圖太大或內容無效");
    }
    return `data:${detectImageMime(bytes)};base64,${bytes.toString("base64")}`;
  }
  return resolveGloGuideModelImage(value, env);
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

/**
 * tryon-max 用 positional=false（沿用 model_image/product_image 欄位稱呼）；
 * agent-images flat body 冇命名欄位，改用位置稱呼（第一張＝模特兒、第二張＝商品）。
 */
function tryOnPrompt(category: string, positional = false): string {
  const placement =
    PLACEMENT[category] ??
    "as a natural accessory on the original person, matching the visible styling";
  const modelRef = positional ? "the first image itself" : "model_image itself";
  const productRef = positional ? "the product in the second image" : "product_image";
  return `Edit ${modelRef} while keeping the same person, face, hair, body shape, pose, framing, camera angle, lighting and original background. Place ${productRef} ${placement}, preserving its design, color, pattern, material appearance, logos and details. Keep all other clothing, accessories and scene elements unchanged.`;
}

// ──────────────────────────── 場景感知 prompt（有文章 context 時用 agent-images 路線）────────────────────────────

/** 文章 theme/body 有冇 scene context（有 → agent-images 場景路線，可以改背景／pose） */
export function hasGloGuideSceneContext(
  input: Pick<GloGuideImageGenInput, "articleTheme" | "articleBody">,
): boolean {
  return Boolean(input.articleTheme?.trim() || input.articleBody?.trim());
}

/**
 * 場景關鍵詞映射（主題／正文 → 明文場景）。第一個命中嘅關鍵詞組生效；
 * 冇命中 → 籠統跟主題嘅 lifestyle 場景（照樣明文要求場景跟文章）。
 */
const SCENE_KEYWORDS: ReadonlyArray<{ re: RegExp; scene: string }> = [
  {
    re: /辦公室|寫字樓|返工|上班|通勤|商務|OL|\boffice\b/i,
    scene: "a bright modern office workspace (desk, laptop, office chairs, soft office lighting)",
  },
  { re: /海灘|沙灘|海邊|\bbeach\b/i, scene: "a sunny beach with sea view" },
  { re: /咖啡|咖啡廳|下午茶|\bcaf[eé]\b/i, scene: "a cozy café interior" },
  {
    re: /戶外|郊遊|行山|遠足|公園|野餐|\boutdoor\b|\bpicnic\b|\bhiking\b/i,
    scene: "an outdoor park on a pleasant day",
  },
  {
    re: /約會|晚餐|晚裝|派對|\bdinner\b|\bparty\b|\bdate\b/i,
    scene: "an elegant evening restaurant setting",
  },
  {
    re: /旅行|旅遊|機場|度假|\btravel\b|\btrip\b|\bvacation\b/i,
    scene: "a stylish travel setting (airport terminal / city street while travelling)",
  },
  { re: /屋企|家居|宅|\bhome\b/i, scene: "a warm, tidy home living room" },
  { re: /街頭|街拍|城市|\bstreet\b/i, scene: "a clean urban street" },
];

/**
 * pose／構圖輪換表：同一篇文章每張圖按 variation（image position）揀唔同嘅，
 * 明文要求同系列其他圖有明顯分別。
 * fullBody 標記：pants/dress/shoes 嗰啲商品喺 mid-shot／close-up 會根本睇唔到，
 * 所以嗰啲類別只准用 full-body pool（見 poseForVariation）。
 */
const POSE_VARIATIONS: ReadonlyArray<{ text: string; fullBody: boolean }> = [
  { text: "standing full-body shot, front three-quarter view, relaxed natural posture", fullBody: true },
  { text: "seated mid-shot, candid pose on a chair or bench", fullBody: false },
  { text: "walking in motion, side-profile angle, full-body framing", fullBody: true },
  { text: "upper-body close-up, slight over-the-shoulder camera angle", fullBody: false },
  { text: "leaning casually against a surface, wide full-body environmental composition", fullBody: true },
];

/** 商品一定要全身先睇得清楚嘅類別（褲／裙／鞋）：禁用 mid-shot／close-up pose */
const FULL_BODY_CATEGORIES = new Set(["pants", "dress", "shoes"]);

/** 按類別＋variation 揀 pose：下半身類別只准 full-body pose，仍然逐張輪換有變化 */
export function poseForVariation(category: string, variation: number): string {
  const pool = FULL_BODY_CATEGORIES.has(category)
    ? POSE_VARIATIONS.filter((p) => p.fullBody)
    : [...POSE_VARIATIONS];
  const idx = ((Math.trunc(variation) % pool.length) + pool.length) % pool.length;
  return pool[idx]!.text;
}

export interface GloGuideScenePromptInput {
  category: string;
  articleTheme: string;
  articleBody: string;
  productName: string;
  variation: number;
}

/**
 * 場景感知配搭圖 prompt（agent-images 路線專用）。明文要求：
 * ─ 場景跟文章主題／正文（office 等關鍵詞映射；冇命中就跟主題籠統 lifestyle 場景）；
 * ─ 呢張圖嘅 pose／構圖按 variation 輪換，同系列每張唔同；
 * ─ framing 硬要求：指定商品必須清楚可見；pants/dress/shoes 必須 full-body
 *   （mid-shot／close-up 會令商品根本睇唔到）；
 * ─ 保留第一張圖（模特兒原圖）真人身分（face/hair/body shape 唔變），**pose／背景可以改**；
 * ─ 商品外觀以第二張圖（原商品圖）硬參考：design/color/pattern/material/logos/details 唔准改，
 *   唔准添加其他商品。
 * 注意：prompt 只係指令，**唔保證** provider 次次一致——最終閘仍係人工逐圖審批。
 */
export function buildGloGuideScenePrompt(input: GloGuideScenePromptInput): string {
  const theme = input.articleTheme.trim().slice(0, 120);
  const haystack = `${input.articleTheme}\n${input.articleBody}`;
  const matched = SCENE_KEYWORDS.find((k) => k.re.test(haystack));
  const scene =
    matched?.scene ??
    `a lifestyle setting that clearly matches the article theme "${theme || "daily styling"}"`;
  const pose = poseForVariation(input.category, input.variation);
  const fullBodyRequired = FULL_BODY_CATEGORIES.has(input.category);
  const placement =
    PLACEMENT[input.category] ??
    "as a natural accessory on the original person, matching the visible styling";
  const product = input.productName.trim().slice(0, 120);
  // Agent flat body 冇 model_image／product_image 命名欄位：按 images[] 位置稱呼
  // （第一張＝模特兒原圖、第二張＝商品原圖，順序見 submitJob）。
  return [
    `You are given two images: the first image is the real person (model) reference, and the second image is the product reference.`,
    `Edit the first image: keep the exact same real person — identity, face, hair and body shape must stay recognizable and unchanged.`,
    `This time you may change the pose, framing, camera angle and background to fit the article scene.`,
    `Scene: place the person in ${scene}, matching the article theme "${theme}".`,
    `Pose/composition for THIS image: ${pose}. It must be visibly different from the other images in this series.`,
    fullBodyRequired
      ? `Framing hard requirement: use full-body framing so the featured ${input.category} product is fully and clearly visible; do not crop it out of the frame.`
      : `Framing hard requirement: the featured product must be clearly visible in the frame.`,
    `Dress the person in the first image with the product "${product}" from the second image ${placement}.`,
    `Preserve the product's design, color, pattern, material appearance, logos and details exactly as shown in the second image — do not redesign or restyle it.`,
    `Do not add any other products or extra branded items.`,
  ].join(" ");
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

/**
 * 淨化 provider 錯誤文字：唔准帶出請求 body／base64 圖／auth token／secret。
 * 只保留短嘅人讀描述，截斷＋壓空白。
 */
function sanitizeProviderDetail(value: unknown, maxLen = 240): string {
  if (typeof value !== "string") return "";
  let text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  // 順序要紧：先遮 auth，再遮 data URI（base64 字元集唔包含空白，唔會吞埋後面嘅字）
  text = text.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  text = text.replace(/api[_-]?key["'\s:=]+\S+/gi, "api_key [redacted]");
  text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi, "[image]");
  // 長 base64／token 樣字串（譬如 echo 返請求入面嘅圖）一律遮蓋
  text = text.replace(/[A-Za-z0-9+/=_-]{120,}/g, "[redacted]");
  return text.slice(0, maxLen).trim();
}

/** 由 error response body 抽 provider 嘅 name/code＋message（agent 用 name、tryon 用 code），已淨化 */
function providerErrorDetail(body: unknown): string {
  const error = record(body).error;
  if (typeof error === "string") return sanitizeProviderDetail(error);
  const errObj = record(error);
  const name =
    typeof errObj.name === "string" && errObj.name.trim()
      ? errObj.name.trim().slice(0, 64)
      : typeof errObj.code === "string" && errObj.code.trim()
        ? errObj.code.trim().slice(0, 64)
        : "";
  const message = sanitizeProviderDetail(errObj.message, 200);
  return [name, message].filter(Boolean).join(": ");
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
    let { code, retryable } = errorCodeForStatus(response.status);
    // auth／credits／rate-limit 用固定訊息（唔帶出 provider 內部細節）；
    // FASHN_INPUT／其他 HTTP 錯附上已淨化嘅 provider error name/message，方便排查。
    const detail = providerErrorDetail(body);
    // Agent 文件將 OutOfCredits 都列做 HTTP 429；呢類冇得 retry，唔好當一般 rate limit 重試。
    if (code === "FASHN_RATE_LIMIT" && isOutOfCredits("", detail)) {
      code = "FASHN_CREDITS";
      retryable = false;
    }
    const suffix = detail ? `：${detail}` : "";
    const message =
      code === "FASHN_AUTH"
        ? "Fashn 服務授權失敗，請管理員檢查伺服器設定"
        : code === "FASHN_CREDITS"
          ? "Fashn 服務額度不足"
          : code === "FASHN_RATE_LIMIT"
            ? "Fashn 服務繁忙，請稍後再試"
            : code === "FASHN_INPUT"
              ? `Fashn 服務拒絕咗請求（HTTP ${response.status}）${suffix}`
              : `Fashn 服務未能完成請求（HTTP ${response.status}）${suffix}`;
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

/** 揾 predictions[] 入面第一個 completed 步驟嘅第一條 https 結果（Agent 路線嘅完成輸出位置） */
function agentCompletedImageUrl(body: Record<string, unknown>): string | null {
  const predictions = Array.isArray(body.predictions) ? body.predictions : [];
  for (const prediction of predictions) {
    const entry = record(prediction);
    if (entry.status !== "completed") continue;
    const results = Array.isArray(entry.results) ? entry.results : [];
    for (const result of results) {
      if (typeof result === "string" && /^https:\/\//i.test(result)) return result;
    }
  }
  return null;
}

/**
 * 狀態解析：
 * ─ 普通 tryon-max：completed → output[0]（https URL）；
 * ─ agent-images：completed → predictions[].results[] 第一條 https URL；
 * ─ 兩條路線嘅 failed error 形狀唔同（tryon 用 code、agent 用 name），統一抽 name/code＋message。
 */
function parseStatus(body: Record<string, unknown>, agentRoute: boolean): FashnStatus {
  const status = typeof body.status === "string" ? body.status : "";
  if (["starting", "in_queue", "processing"].includes(status)) return { state: "processing" };
  if (status === "completed") {
    const output = agentRoute
      ? agentCompletedImageUrl(body)
      : Array.isArray(body.output)
        ? body.output[0]
        : null;
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
  const rawCode =
    typeof error.name === "string" && error.name.trim()
      ? error.name
      : typeof error.code === "string" && error.code.trim()
        ? error.code
        : "";
  const code = rawCode ? rawCode.slice(0, 64) : "PROVIDER_FAILED";
  const message =
    sanitizeProviderDetail(error.message, 300) || "Fashn 服務未能完成生成";
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
  agentRoute: boolean,
): Promise<FashnStatus> {
  if (!/^[\w-]{1,160}$/.test(providerJobId)) {
    throw new GloGuideProviderError("FASHN_BAD_ID", "Fashn 工作編號格式無效");
  }
  // Agent 路線狀態喺 /agent/status/<id>（predictions[].results[]）；tryon-max 照舊 /status/<id>（output[]）
  const statusPath = agentRoute
    ? `/agent/status/${encodeURIComponent(providerJobId)}`
    : `/status/${encodeURIComponent(providerJobId)}`;
  const body = await fashnRequest(config, fetchImpl, statusPath, {
    method: "GET",
  });
  return parseStatus(body, agentRoute);
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

/** 同一路由決策：submit 同 poll／resume 必須一致（experimental 或有 scene context → Agent 路線） */
function useAgentRoute(input: GloGuideImageGenInput): boolean {
  return Boolean(input.experimental) || hasGloGuideSceneContext(input);
}

/**
 * Agent 路線每張 base64／data-URI 輸入圖文件上限 10MB（URL 輸入唔受呢條限制，
 * 因為係 Fashn 自己拉取）。超限喺呢度誠實 throw，避免已知會 400 BadRequest 嘅請求照寄。
 */
function assertAgentImageSize(imageInput: string, code: string, label: string): void {
  const dataUri = DATA_URI_RE.exec(imageInput);
  if (!dataUri) return;
  const base64Length = dataUri[2]!.replace(/[\r\n]/g, "").length;
  const approxBytes = Math.floor((base64Length * 3) / 4);
  if (approxBytes > FASHN_AGENT_IMAGE_MAX_BYTES) {
    throw new GloGuideProviderError(
      code,
      `${label}超過 Fashn Agent 路線每張圖 10MB 上限，請改用較細嘅圖或 https URL`,
    );
  }
}

async function submitJob(
  config: FashnConfig,
  fetchImpl: FetchLike,
  input: GloGuideImageGenInput,
  modelImageUrl: string,
  productImageInput: string,
  agentRoute: boolean,
): Promise<string> {
  // 路由：有 scene context（文章 theme/body）→ 行 agent-images 場景路線（可改背景／pose）；
  // 冇 context 就保持舊路線——飾品 experimental 行 agent-images，其餘 tryon-max。
  const scene = hasGloGuideSceneContext(input);
  const prompt = (
    scene
      ? buildGloGuideScenePrompt({
          category: input.category,
          articleTheme: input.articleTheme ?? "",
          articleBody: input.articleBody ?? "",
          productName: input.productName ?? "",
          variation: input.variation ?? 0,
        })
      : tryOnPrompt(input.category, agentRoute)
  ).slice(0, FASHN_AGENT_PROMPT_MAX_CHARS);
  let pathName: string;
  let payload: Record<string, unknown>;
  if (agentRoute) {
    // Agent Images flat contract（文件：POST /v1/agent/images/run）：
    // 頂層 prompt＋images[]（model 先、product 後，prompt 按位置稱呼）；
    // 冇 model_name／inputs／model_image／output_format。
    assertAgentImageSize(modelImageUrl, "FASHN_MODEL_IMAGE", "模特兒原圖");
    assertAgentImageSize(productImageInput, "FASHN_PRODUCT_IMAGE", "商品圖");
    pathName = "/agent/images/run";
    payload = {
      prompt,
      images: [modelImageUrl, productImageInput],
      aspect_ratio: "3:4",
      resolution: "1k",
      generation_mode: "quality",
    };
  } else {
    pathName = "/run";
    payload = {
      model_name: "tryon-max",
      inputs: {
        model_image: modelImageUrl,
        product_image: productImageInput,
        prompt,
        generation_mode: "quality",
        resolution: "1k",
        num_images: 1,
        output_format: "png",
      },
    };
  }
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

  const modelImageUrl = await resolveGloGuideModelImageInput(input.modelImage, options.env ?? process.env);
  const productImageInput = await resolveGloGuideProductImage(input.productImage);
  const agentRoute = useAgentRoute(input);

  const providerJobId = await withFashnRetry(
    () => submitJob(config, fetchImpl, input, modelImageUrl, productImageInput, agentRoute),
    sleep,
    maxRetries,
  );
  // 一攞到 id 就即刻俾上層持久化；如果 poll 中途重啟，recovery 先有得憑 id 補收。
  await input.onProviderJobId?.(providerJobId);

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollInterval);
    const status = await withFashnRetry(
      () => fetchStatusOnce(config, fetchImpl, providerJobId, agentRoute),
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
  // resume 用同一份 input 嘅同一路由決策（experimental／scene）揀 poll endpoint，
  // 否則 agent job 會打錯去 /status/<id> 永遠 404。
  const agentRoute = useAgentRoute(input);

  const status = await withFashnRetry(
    () => fetchStatusOnce(config, fetchImpl, providerJobId, agentRoute),
    sleep,
    GLO_GUIDE_FASHN_MAX_RETRIES,
  );
  if (status.state === "processing") return null;
  if (status.state === "failed") throw failedStatusError(status);
  return persistCompleted(status.imageUrl, options, providerJobId);
}
