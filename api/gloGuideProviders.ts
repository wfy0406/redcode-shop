/**
 * Glo Glo 指南——外部 provider 介面層（orchestrator 嘅唯一依賴口）。
 *
 * 實作分散喺三個專屬模組（另一線擁有，呢度只做介面＋lazy 接合）：
 * ─ api/gloGuideWeather.ts：HKO 明日起 7 日＋stale 快取＋季節 fallback
 * ─ api/gloGuideText.ts：OpenAI-compatible 文生成（嚴格 JSON、有限重試）
 * ─ api/gloGuideFashn.ts：Fashn /v1/run tryon-max＋poll＋下載轉存（飾品 agent experimental）
 * ─ api/gloGuideMedia.ts：上傳驗證（sharp）＋持久化
 *
 * 接合方式：defaultProviders() lazy import 佢哋嘅約定 export（下面逐個註明）；
 * 測試／其他 caller 可以直接注入 mock，唔使掂真服務。
 * 所有失敗必須 throw GloGuideProviderError（或普通 Error）——絕對唔准 mock 成功。
 */

/** provider 統一錯誤：code 落 job.error／generationError；retryable 畀上層決定要唔要補試 */
export class GloGuideProviderError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "GloGuideProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ──────────────────────────── 天氣 ────────────────────────────

export interface GloGuideWeatherResult {
  /** hko＝新鮮 HKO｜hko-stale＝舊快取（仍標明日期）｜seasonal＝季節提示（唔作具體天氣斷言） */
  source: "hko" | "hko-stale" | "seasonal";
  /** 明日起 7 日逐日一句（hko），或季節籠統提示（seasonal） */
  lines: string[];
  /** 資料取得時間（ISO；seasonal 係而家） */
  fetchedAt: string;
}

// ──────────────────────────── 文案生成 ────────────────────────────

export interface GloGuideTextProductInput {
  name: string;
  category: string;
  categoryLabel: string;
  aiTags: string[];
  price: number;
  discountPrice: number | null;
  liveDate: string | null;
  liveSession: string | null;
}

export interface GloGuideTextInput {
  products: GloGuideTextProductInput[];
  /** 近 8 篇非 archived 主題（去重用，唔准撞） */
  recentThemes: string[];
  /** 近 8 篇內容開頭（避免換字重用） */
  recentIntros: string[];
  weatherLines: string[];
  themeHint?: string;
}

/** 已清理兼通過硬閘（title 4–80／body 250–550 code points 空白唔計／theme 2–80） */
export interface GloGuideTextOutput {
  title: string;
  body: string;
  theme: string;
}

// ──────────────────────────── 圖片生成 ────────────────────────────

export interface GloGuideImageGenInput {
  articleId: number;
  imageId: number;
  productId: number;
  /** 商品類別（top/pants/dress/shoes → tryon-max；accessory 或多品 → agent experimental） */
  category: string;
  /** 真實授權模特兒參考圖（預設 PUBLIC_BASE_URL/gloglo-3.jpg；絕唔係 AI 合成） */
  modelImage: string;
  /** 商品原圖（站內 path 或 https 絕對 URL） */
  productImage: string;
  /** true＝行 /v1/agent/images/run experimental 路線 */
  experimental: boolean;
  /**
   * 文章主題（可選）。theme/body 任一非空＝scene context：provider 行 agent-images
   * 場景路線（可以改背景／pose 配合文章）；兩樣都冇 → 舊 tryon-max 原 pose/背景路線。
   */
  articleTheme?: string;
  /** 文章正文（場景線索；provider 層只會截取／掃關鍵詞，唔會全段落 prompt） */
  articleBody?: string;
  /** 商品名（prompt 內硬參考，配合商品原圖鎖死外觀） */
  productName?: string;
  /** 第幾張圖（0-based）：pose／構圖按佢輪換，同一篇每張唔同 */
  variation?: number;
  /** Fashn submit 成功後即刻回傳 provider id；上層必須即時落 DB，重啟先可以 resume poll。 */
  onProviderJobId?: (providerJobId: string) => Promise<void>;
}

export interface GloGuideImageGenResult {
  providerJobId: string;
  /** 已下載轉存嘅站內持久路徑（/uploads/glo-guide/<uuid>.png；CDN URL 唔會出現喺度） */
  path: string;
  width: number;
  height: number;
}

// ──────────────────────────── 上傳持久化 ────────────────────────────

export interface GloGuideStoredImage {
  path: string;
  width: number;
  height: number;
}

// ──────────────────────────── 介面 ────────────────────────────

export interface GloGuideProviders {
  /** HKO 明日起 7 日；失敗落 stale 快取／季節 fallback（呢個唔會 throw，source 已標狀態） */
  getWeather(): Promise<GloGuideWeatherResult>;
  /** 文生成：內部已做嚴格 JSON＋硬閘驗證＋有限重試；仍失敗 throw */
  generateText(input: GloGuideTextInput): Promise<GloGuideTextOutput>;
  /** 圖生成：提交＋poll＋下載轉存一次過；4xx/OutOfCredits 唔 retry，network/5xx 最多 2 次；失敗 throw */
  generateImage(input: GloGuideImageGenInput): Promise<GloGuideImageGenResult>;
  /** job recovery：憑 providerJobId 繼續 poll＋轉存；仲行緊返 null，失敗 throw */
  resumeImage(providerJobId: string, input: GloGuideImageGenInput): Promise<GloGuideImageGenResult | null>;
  /** 人工上傳：sharp 驗真圖（JPEG/PNG/WebP ≤10MB）＋re-encode 持久化；唔合格 throw */
  saveUpload(input: { filename: string; mime: string; data: Buffer }): Promise<GloGuideStoredImage>;
}

/**
 * 預設接合（production）：lazy import 另一線嘅模組。
 * 約定 export（接合契約，改名要同主線講）：
 * ─ gloGuideWeather.ts：`getGloGuideWeather(): Promise<GloGuideWeatherResult>`
 * ─ gloGuideText.ts：`generateGloGuideText(input): Promise<GloGuideTextOutput>`
 * ─ gloGuideFashn.ts：`generateGloGuideImage(input)` ＋ `resumeGloGuideImage(providerJobId, input)`
 * ─ gloGuideMedia.ts：`saveGloGuideUpload({filename, mime, data})`
 * 未配置（例如冇 FASHN_API_KEY）會喺真調用時 throw 真錯誤，唔會假成功。
 */
export function defaultGloGuideProviders(): GloGuideProviders {
  return {
    getWeather: async () => (await import("./gloGuideWeather")).getGloGuideWeather(),
    generateText: async (input) => (await import("./gloGuideText")).generateGloGuideText(input),
    generateImage: async (input) => (await import("./gloGuideFashn")).generateGloGuideImage(input),
    resumeImage: async (providerJobId, input) =>
      (await import("./gloGuideFashn")).resumeGloGuideImage(providerJobId, input),
    saveUpload: async (input) => (await import("./gloGuideMedia")).saveGloGuideUpload(input),
  };
}
