/**
 * Glo Glo 精選配搭指南——OpenAI-compatible 文案生成 server-only provider。
 *
 * SPEC v1 生成流程第 3–4 步：
 * ─ env：GLO_GUIDE_AI_BASE_URL／GLO_GUIDE_AI_API_KEY／GLO_GUIDE_AI_MODEL 優先，
 *   直接 fallback 現有 DEEPSEEK_API_KEY／DEEPSEEK_BASE／DEEPSEEK_MODEL，再 fallback OPENAI_*；
 * ─ prompt 要求：香港口語廣東話、Glo Glo 第一人稱、400–800 字（空白唔計 code points）、
 *   SEO 搜尋意圖＋GEO 可引用答案結構、最少三種穿搭／著法、生活場景、自然導購、避開近 8 主題；
 * ─ 只可用輸入商品嘅真 name／category／已批准 aiTags／price／直播場次；品牌／材質無核實欄位就直接略過，
 *   商品名或標籤字眼唔當材質證明；禁止估產地、功能；
 * ─ 嚴格 JSON {title,body,theme}；NFC＋控制字元清理＋硬閘 validate（gloGuideValidation）；
 * ─ 有限重試（預設總共 3 次），重試時附返上次失敗原因；仍失敗 throw 真錯，絕唔 mock。
 *
 * 對 orchestrator 嘅接合契約（見 ./gloGuideProviders.ts）：
 *   generateGloGuideText(input: GloGuideTextInput): Promise<GloGuideTextOutput>
 */

import {
  GloGuideProviderError,
  type GloGuideTextInput,
  type GloGuideTextOutput,
} from "./gloGuideProviders";
import { parseGloGuideRichText } from "@contracts/gloGuideRichText";
import {
  sanitizeGloGuideBody,
  sanitizeGloGuideLine,
  validateGloGuideBody,
  validateGloGuideTheme,
  validateGloGuideTitle,
  countBodyCodePoints,
} from "./gloGuideValidation";

export const GLO_GUIDE_TEXT_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const GLO_GUIDE_TEXT_TIMEOUT_MS = 60_000;
export const GLO_GUIDE_TEXT_MAX_ATTEMPTS = 3;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;

export interface GloGuideAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type EnvLike = Record<string, string | undefined>;

/** env 解析：GLO_GUIDE_AI_* 優先，直接重用現有 DEEPSEEK_*，再以 OPENAI_* fallback。 */
export function resolveGloGuideAiConfig(env: EnvLike = process.env): GloGuideAiConfig {
  const baseUrl = (
    env.GLO_GUIDE_AI_BASE_URL ||
    env.DEEPSEEK_BASE ||
    env.OPENAI_BASE_URL ||
    GLO_GUIDE_TEXT_DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const apiKey = (
    env.GLO_GUIDE_AI_API_KEY ||
    env.DEEPSEEK_API_KEY ||
    env.OPENAI_API_KEY ||
    ""
  ).trim();
  const model = (
    env.GLO_GUIDE_AI_MODEL ||
    env.DEEPSEEK_MODEL ||
    env.OPENAI_MODEL ||
    "gpt-4o-mini"
  ).trim();
  if (!apiKey) {
    throw new GloGuideProviderError(
      "AI_CONFIG_MISSING",
      "AI 文案服務未配置（要 GLO_GUIDE_AI_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY）",
    );
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new GloGuideProviderError("AI_CONFIG_MISSING", "AI 文案服務 base URL 必須係 https");
  }
  return { baseUrl, apiKey, model };
}

// ──────────────────────────── prompt ────────────────────────────

const CATEGORY_LABEL_FALLBACK: Record<string, string> = {
  top: "上衣",
  pants: "褲",
  dress: "連身裙",
  shoes: "鞋",
  accessory: "飾物",
};

function productFacts(input: GloGuideTextInput): string {
  return input.products
    .map((p, index) => {
      const label =
        p.categoryLabel || CATEGORY_LABEL_FALLBACK[p.category] || p.category || "單品";
      const price =
        p.discountPrice !== null && p.discountPrice !== undefined && p.discountPrice < p.price
          ? `HK$${p.discountPrice}（原價 HK$${p.price}）`
          : `HK$${p.price}`;
      const tags = p.aiTags.length > 0 ? `；已批准重點標籤：${p.aiTags.join("、")}` : "";
      const live = p.liveDate
        ? `；直播場次：${p.liveDate}${p.liveSession ? ` ${p.liveSession}` : ""}`
        : "";
      return `${index + 1}. 名稱「${p.name}」；類別：${label}${tags}；價錢：${price}${live}`;
    })
    .join("\n");
}

function longTailFactSeeds(input: GloGuideTextInput): string[] {
  return input.products.flatMap((product) => {
    const label =
      product.categoryLabel || CATEGORY_LABEL_FALLBACK[product.category] || product.category || "單品";
    return [
      `${product.name}點襯`,
      `${product.name}返工配搭`,
      `香港${label}場合穿搭`,
    ];
  });
}

function buildSystemPrompt(): string {
  return [
    "你係香港網店 Glo Glo 嘅主筆，用第一人稱（「我哋」／「Glo Glo」）寫每日精選文章，同時兼顧 SEO 搜尋意圖、GEO 可引用內容同真實導購。",
    "硬性要求：",
    "- 用香港口語廣東話書寫，自然、親切，唔好書面語，唔好抄內地用語。",
    "- body 內文 400–800 字（空白唔計，以 Unicode code points 計），title 4–80 字，theme 2–80 字。",
    "- title 自然帶出真實商品類別或生活場景搜尋意圖；唔好堆關鍵字、重複同義詞、誇張承諾或 clickbait。",
    "- 自然使用 2–4 個長尾搜尋句：只可由商品全名、真實類別、已批准標籤同生活場景組成，例如「商品全名＋點襯／返工配搭」；最少一個放 title 或副標題，其餘融入相應段落。唔好當種子係實際搜尋量、熱門程度或排名保證。",
    "- body 開頭第一段直接回答今次主題：邊件已選商品適合邊個生活場景、核心襯法係咩；唔好用空泛打招呼或口號開場。",
    "- 開頭之後用 2–4 個獨立 [h2]副標題[/h2] 分成清楚段落（每個 2–60 字純文字，唔准巢狀其他標記），分清楚商品事實、配搭方法同場合；最少寫 3 種明顯唔同嘅穿搭或著法，每件已選商品最少準確點名一次。", 
    "- 每種穿搭要具體講邊件商品配邊類基本單品，再按已知顏色、剪裁、圖案或場景解釋；可寫攝衫、疊穿、摺褲腳、外套披開或全扣、鞋款及飾物轉換等技巧，但要適用於該商品。",
    "- 可建議外加常見白T、恤衫、牛仔褲、半身裙、波鞋或樂福鞋等，但只能寫成配搭方向；唔好暗示外加單品屬套裝內容、隨貨附送或本店有售。",
    "- GEO 內容要易被 AI 摘錄：用完整短句直接答「邊件襯邊件」、「適合咩場合」、「點樣轉換造型」，每段集中一個重點，唔好寫空泛形容詞或虛構問答。",
    "- 導購要自然：可使用輸入有提供嘅真實價錢、直播日期及場次；結尾用一句行動提示引導讀者睇已連結商品詳情或相關場次。",
    "- 唔准虛構銷量、評價、庫存、折扣期限、最後一件、熱賣或保證效果；唔准寫內部貨號、審核狀態、未知資料或『以實物為準』等旁白。",
    "- 唔好保證顯瘦、增高、修腿、舒適等主觀或穿著效果；即使標籤有類似字眼，都只可以當商品線索，唔可以寫成效果承諾。",
    "- 要落地香港生活場景：返工、放假行街、約會、天氣轉變等；可以帶少少幽默，間中用一兩個 emoji，但唔好濫用。",
    "- body 用 2–4 組 [tag]…[/tag] 包住簡短、具體嘅配搭重點（例如 [tag]雨天通勤[/tag]），供公開重點標籤使用；唔好成段包住。",
    "- 需要強調時只可用 [b]…[/b]、[gold]…[/gold]、[pink]…[/pink]；標記要正確巢狀、唔可以跨段落，唔准輸出 HTML 或 Markdown。標記唔計入 400–800 字。",
    "- 會提供香港明日起 7 日天氣（或註明天氣資料暫缺），配搭建議要配合；若註明暫缺，絕對唔好斷言具體天氣。",
    "- 只可以使用輸入商品嘅真實資料：名稱、類別、已批准重點標籤、價錢、直播日期及場次。",
    "- 輸入冇已核實品牌或材質欄位：品牌同材質一律直接略過，唔准斷言，亦唔准寫『品牌不明』、『品牌未知』、『材質不明』、『材質未知』、『未提供』或『以實物為準』等旁白。",
    "- 商品名或標籤即使出現棉、雪紡、皮革等字眼，都只可以喺完整準確引用商品名時保留；唔可以當成材質證明、拆出嚟描述或再作推論。",
    "- 同樣禁止憑空斷言產地、功能（如防水、防曬、保暖）等輸入冇講嘅嘢。",
    "- 會提供最近 8 篇指南嘅主題同內容開頭：theme 唔准同佢哋重複，內容開頭唔准換字重用。",
    "輸出格式：只可以輸出一個 JSON 物件，唔准包 markdown code fence，格式如下：",
    '{"title":"…","body":"…","theme":"…"}',
  ].join("\n");
}

function buildUserPrompt(input: GloGuideTextInput): string {
  const sections: string[] = [];
  sections.push(`【今次商品（只准用呢啲真實資料）】\n${productFacts(input)}`);
  sections.push(
    `【長尾字事實種子（只係寫作線索，唔代表搜尋量或排名）】\n${longTailFactSeeds(input).join("\n")}`,
  );
  if (input.weatherLines.length > 0) {
    sections.push(`【香港明日起 7 日天氣】\n${input.weatherLines.join("\n")}`);
  } else {
    sections.push("【天氣】天氣資料暫缺；唔好斷言任何具體天氣。");
  }
  if (input.recentThemes.length > 0) {
    sections.push(`【最近 8 篇主題（今次 theme 唔准重複）】\n${input.recentThemes.join("\n")}`);
  }
  if (input.recentIntros.length > 0) {
    sections.push(
      `【最近 8 篇內容開頭（今次開頭唔准換字重用）】\n${input.recentIntros.join("\n")}`,
    );
  }
  if (input.themeHint?.trim()) {
    sections.push(`【主題方向建議】${input.themeHint.trim()}`);
  }
  sections.push("請輸出嚴格 JSON：{\"title\":\"…\",\"body\":\"…\",\"theme\":\"…\"}");
  return sections.join("\n\n");
}

// ──────────────────────────── 無依據事實檢查 ────────────────────────────

/**
 * 高風險斷言字眼（材質／產地／功能）。
 * 輸入冇已核實材質欄位，所以名稱或標籤出現相關字眼都唔構成材質證明；
 * 只有完整準確引用商品名可以先剔除，其餘內容一出現相關斷言就擋。
 * 名單係保守下限；重試時會將違規字眼回饋俾模型改正。
 */
const RISKY_FACT_TERMS: readonly string[] = [
  // 材質
  "純棉", "全棉", "棉質", "羊毛", "羊絨", "cashmere", "真絲", "絲質", "silk",
  "亞麻", "麻質", "linen", "皮革", "真皮", "leather", "雪紡", "chiffon",
  "緞面", "satin", "天絲", "tencel", "莫代爾", "modal", "denim",
  "蕾絲", "lace", "羽絨", "天鵝絨", "velvet", "針織",
  // 產地／來源
  "意大利", "法國製", "日本製", "韓國製", "韓國直送", "歐洲入口", "歐洲進口",
  "台灣製", "原裝入口", "原裝進口", "海外直送",
  // 功能
  "防水", "防風", "防曬", "防紫外線", "uv", "抗菌", "速乾", "快乾", "保暖", "透氣", "防皺",
];

const UNVERIFIED_FACT_COMMENTARY: readonly string[] = [
  "品牌未知", "品牌不明", "未知品牌", "品牌未提供", "未有品牌資料", "唔知品牌",
  "材質未知", "材質不明", "未知材質", "材質未提供", "未有材質資料", "唔知材質",
  "以實物為準",
];

function withoutExactProductNames(text: string, input: GloGuideTextInput): string {
  let result = text.toLowerCase();
  for (const product of input.products) {
    const exactName = product.name.trim().toLowerCase();
    if (exactName) result = result.split(exactName).join(" ");
  }
  return result;
}

/** 返違規字眼清單（空 array＝合格）。只係啟發式擋無依據斷言及未知資料旁白，唔係事實保證。 */
export function detectUnsafeFacts(
  output: GloGuideTextOutput,
  input: GloGuideTextInput,
): string[] {
  const original = `${output.title} ${output.body} ${output.theme}`.toLowerCase();
  const haystack = withoutExactProductNames(original, input);
  const violations: string[] = [];
  for (const term of RISKY_FACT_TERMS) {
    if (haystack.includes(term.toLowerCase())) violations.push(term);
  }
  for (const term of UNVERIFIED_FACT_COMMENTARY) {
    if (original.includes(term.toLowerCase())) violations.push(term);
  }
  return violations;
}

/** 最少一個副標題／段落要將商品全名同明確穿搭搜尋意圖放埋一齊，唔准齋堆通用關鍵字。 */
function hasEvidenceLedLongTail(output: GloGuideTextOutput, input: GloGuideTextInput): boolean {
  const blocks = parseGloGuideRichText(output.body).plainText.split(/\n{2,}|\n/);
  return blocks.some((block) =>
    input.products.some((product) =>
      block.includes(product.name) && /點襯|點著|配搭|穿搭|著法|襯法/u.test(block),
    ),
  );
}

// ──────────────────────────── 回應 parse＋硬閘 ────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function extractContent(payload: unknown): string {
  const choices = record(payload).choices;
  const first = Array.isArray(choices) ? record(choices[0]) : {};
  const message = record(first.message);
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  throw new GloGuideProviderError("AI_BAD_RESPONSE", "AI 文案服務回應冇內容", true);
}

/** 容忍模型包咗 ```json fence；但 parse 出嚟一定要係單一物件。 */
function parseStrictJson(content: string): Record<string, unknown> {
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GloGuideProviderError("AI_BAD_JSON", "AI 回應唔係有效 JSON", true);
  }
  const obj = record(parsed);
  if (typeof obj.title !== "string" || typeof obj.body !== "string" || typeof obj.theme !== "string") {
    throw new GloGuideProviderError(
      "AI_BAD_JSON",
      "AI 回應 JSON 必須有字串欄位 title／body／theme",
      true,
    );
  }
  return obj;
}

/** NFC＋控制字元清理 → 硬閘（title 4–80／body 400–800 code points 空白唔計／theme 2–80）→ 無依據事實檢查 */
function validateOutput(raw: Record<string, unknown>, input: GloGuideTextInput): GloGuideTextOutput {
  const output: GloGuideTextOutput = {
    title: sanitizeGloGuideLine(raw.title as string),
    body: sanitizeGloGuideBody(raw.body as string),
    theme: sanitizeGloGuideLine(raw.theme as string),
  };
  const errors: string[] = [];
  const titleErr = validateGloGuideTitle(output.title);
  if (titleErr) errors.push(titleErr);
  const bodyErr = validateGloGuideBody(output.body);
  if (bodyErr) errors.push(bodyErr);
  const highlights = parseGloGuideRichText(output.body).highlights;
  if (highlights.length < 1) errors.push("內文最少要有一個 [tag]…[/tag] 重點標籤");
  if (!hasEvidenceLedLongTail(output, input)) {
    errors.push("最少一個長尾句要將商品全名同點襯／配搭／穿搭意圖放埋同一個副標題或段落");
  }
  const themeErr = validateGloGuideTheme(output.theme);
  if (themeErr) errors.push(themeErr);
  const unsafe = detectUnsafeFacts(output, input);
  if (unsafe.length > 0) {
    errors.push(`唔准寫無依據資料或未知資料旁白：${unsafe.join("、")}`);
  }
  if (errors.length > 0) {
    throw new GloGuideProviderError("AI_VALIDATION", errors.join("；"), true);
  }
  return output;
}

// ──────────────────────────── HTTP ────────────────────────────

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function callAi(
  config: GloGuideAiConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLO_GUIDE_TEXT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new GloGuideProviderError(
      "AI_NETWORK",
      error instanceof Error && error.name === "AbortError"
        ? "AI 文案服務回應逾時"
        : "暫時連唔到 AI 文案服務",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GloGuideProviderError("AI_AUTH", "AI 文案服務授權失敗，請檢查伺服器設定");
    }
    throw new GloGuideProviderError(
      "AI_HTTP",
      `AI 文案服務回應 HTTP ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return extractContent(payload);
}

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ──────────────────────────── 主流程 ────────────────────────────

export interface GloGuideTextOptions {
  fetchImpl?: FetchLike;
  /** 測試注入 env；預設 process.env */
  env?: EnvLike;
  /** 總嘗試次數（1＝唔 retry）；預設 3 */
  maxAttempts?: number;
  sleep?: SleepLike;
}

/**
 * 生成指南文案（接合契約 export）。
 * 嚴格 JSON＋NFC／控制字元清理＋硬閘驗證＋無依據事實檢查，有限重試；
 * 用盡次數仍唔合格 → throw GloGuideProviderError（code／retryable 齊），絕唔回 mock 內容。
 */
export async function generateGloGuideText(
  input: GloGuideTextInput,
  options: GloGuideTextOptions = {},
): Promise<GloGuideTextOutput> {
  if (!Array.isArray(input.products) || input.products.length === 0) {
    throw new GloGuideProviderError("AI_INPUT", "生成文案需要最少一件商品");
  }
  const config = resolveGloGuideAiConfig(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? GLO_GUIDE_TEXT_MAX_ATTEMPTS);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input) },
  ];

  let lastError: GloGuideProviderError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callAi(config, messages, fetchImpl);
      const parsed = parseStrictJson(content);
      return validateOutput(parsed, input);
    } catch (error) {
      const providerError =
        error instanceof GloGuideProviderError
          ? error
          : new GloGuideProviderError(
              "AI_UNKNOWN",
              error instanceof Error ? error.message : "AI 文案生成失敗",
              true,
            );
      lastError = providerError;
      // 授權錯／唔可重試錯 → 即刻停，唔好浪費配額
      if (!providerError.retryable || attempt === maxAttempts) break;
      // 有限重試：將上次失敗原因回饋俾模型改正（validation／JSON 錯最有用）
      messages.push({
        role: "user",
        content:
          `上次輸出唔合格：${providerError.message}。` +
          `請嚴格跟返格式同限制重新輸出一次 JSON（body 而家要有 400–800 字，空白唔計）。`,
      });
      await sleep(300 * attempt);
    }
  }
  throw lastError ?? new GloGuideProviderError("AI_UNKNOWN", "AI 文案生成失敗");
}

/** 測試／除錯用：對最終輸出再覆核字數（code points，空白唔計）。 */
export function gloGuideBodyLength(body: string): number {
  return countBodyCodePoints(body);
}
