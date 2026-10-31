import type { TryOnProductKind } from "@contracts/tryon";

/** Server-only FASHN adapter。API key 永遠唔進入 tRPC 回應或前端 bundle。 */
export interface TryOnSubmitInput {
  modelImage: string;
  productImage: string;
  productKind: TryOnProductKind;
}

const PLACEMENT: Record<TryOnProductKind, string> = {
  top: "on the original person's upper body as the replacement upper-body garment",
  pants: "on the original person's lower body as the replacement lower-body garment",
  dress: "on the original person as the replacement dress",
  shoes: "on the original person's feet as the replacement shoes",
  ring: "on a suitable visible finger of the original person's hand",
  necklace: "around the original person's neck, following the existing neckline",
  earrings: "at the original person's natural ear positions",
  bracelet: "around a suitable visible wrist of the original person",
};

/**
 * 簡短、正面嘅局部修改指示：原圖人物、場景及商品細節優先。
 * 唔用否定式或疊加 generic quality 字眼，避免生成服務將請求理解成重新設計成張相。
 */
function fixedPrompt(kind: TryOnProductKind): string {
  return `Edit model_image itself while keeping the same person, face, hair, body shape, pose, framing, camera angle, lighting and original background. Place product_image ${PLACEMENT[kind]}, preserving its design, color, pattern, material appearance, logos and details. Keep all other clothing, accessories and scene elements unchanged.`;
}

export interface TryOnProvider {
  submit(input: TryOnSubmitInput): Promise<{ id: string }>;
  status(id: string): Promise<TryOnProviderStatus>;
}

export type TryOnProviderStatus =
  | { state: "processing" }
  | { state: "completed"; imageDataUri: string }
  | { state: "failed"; code: string; message: string };

export class TryOnProviderError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "TryOnProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeProviderCode(status: number): string {
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (status === 400 || status === 422) return "PROVIDER_INPUT";
  return `PROVIDER_HTTP_${status}`;
}

export class FashnTryOnProvider implements TryOnProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    apiKey: string,
    options: { baseUrl?: string; fetchImpl?: FetchLike } = {},
  ) {
    if (!apiKey.trim()) throw new Error("FASHN_API_KEY is required");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.fashn.ai/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new TryOnProviderError(
        "PROVIDER_NETWORK",
        error instanceof Error && error.name === "AbortError"
          ? "試穿服務回應逾時"
          : "暫時連唔到試穿服務",
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
      const retryable = response.status === 429 || response.status >= 500;
      throw new TryOnProviderError(
        safeProviderCode(response.status),
        response.status === 401 || response.status === 403
          ? "試穿服務授權失敗，請管理員檢查伺服器設定"
          : response.status === 429
            ? "試穿服務繁忙，請稍後再試"
            : "試穿服務未能完成請求",
        retryable,
      );
    }
    return record(body);
  }

  async submit(input: TryOnSubmitInput): Promise<{ id: string }> {
    const body = await this.request("/run", {
      method: "POST",
      body: JSON.stringify({
        model_name: "tryon-max",
        inputs: {
          product_image: input.productImage,
          model_image: input.modelImage,
          prompt: fixedPrompt(input.productKind),
          generation_mode: "quality",
          resolution: "1k",
          num_images: 1,
          output_format: "png",
          return_base64: true,
          seed: 42,
        },
      }),
    });
    if (typeof body.id !== "string" || !body.id.trim()) {
      throw new TryOnProviderError("PROVIDER_BAD_RESPONSE", "試穿服務沒有返回工作編號", true);
    }
    return { id: body.id };
  }

  async status(id: string): Promise<TryOnProviderStatus> {
    if (!/^[\w-]{1,160}$/.test(id)) {
      throw new TryOnProviderError("PROVIDER_BAD_ID", "試穿工作編號格式無效");
    }
    const body = await this.request(`/status/${encodeURIComponent(id)}`, { method: "GET" });
    const status = typeof body.status === "string" ? body.status : "";
    if (["starting", "in_queue", "processing"].includes(status)) {
      return { state: "processing" };
    }
    if (status === "completed") {
      const output = Array.isArray(body.output) ? body.output[0] : null;
      if (
        typeof output !== "string" ||
        !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/.test(output) ||
        output.length > 42_000_000
      ) {
        throw new TryOnProviderError(
          "PROVIDER_BAD_OUTPUT",
          "試穿服務沒有返回可用嘅私人圖像",
          false,
        );
      }
      return { state: "completed", imageDataUri: output };
    }
    const error = record(body.error);
    return {
      state: "failed",
      code: typeof error.code === "string" ? error.code.slice(0, 64) : "PROVIDER_FAILED",
      message: "試穿服務未能生成；今次唔會扣除你嘅每日額度",
    };
  }
}

export function configuredTryOnProvider(): TryOnProvider | null {
  const key = process.env.FASHN_API_KEY?.trim();
  return key ? new FashnTryOnProvider(key) : null;
}
