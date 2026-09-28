import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { siteSettings } from "@db/schema";

/**
 * Airwallex 網上付款（2026-09 F5）：Hosted Payment Page 整合。
 * 同 Glo 內部系統嘅 Airwallex 出單一致：後台開 PaymentIntent → 開 HPP payment_session →
 * 客人跳去 Airwallex 安全付款頁（信用卡 / AlipayHK / FPS / PayMe 由 Airwallex 嗰邊提供），
 * 卡資料全程唔經我哋伺服器。收款確認靠 POST /api/airwallex/webhook（見 boot.ts）。
 *
 * 官方文件核實紀錄（2026-09 寫碼時逐項對過）：
 * - 認證：POST /api/v1/authentication/login，headers x-client-id / x-api-key，
 *   回 { token, expires_at }，token 有效期約 30 分鐘。
 *   來源：https://www.airwallex.com/docs/api/getting_started
 * - 開單：POST /api/v1/pa/payment_intents/create，欄位 request_id / amount / currency /
 *   merchant_order_id / descriptor / return_url / metadata。
 *   來源：https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api
 * - 金額單位：amount 係「主單位」（major unit，HKD 即港元「元」，100 = HK$100；
 *   Payment Links 文件例子 165.15 = €165.15），唔係 cents。
 *   來源：https://www.airwallex.com/docs/api/payments/payment_links ＋ 上面 PaymentIntents 文件
 * - HPP session：POST /api/v1/pa/payment_session/create，欄位 payment_intent_id /
 *   client_secret / currency / return_url，回應入面 url 就係要跳轉嘅託管付款頁。
 *   來源：https://www.airwallex.com/docs/api （Payments Acceptance > PaymentSession >
 *   POST /api/v1/pa/payment_session/create）
 * - Webhook 簽名：每個請求帶 x-timestamp（毫秒 Unix timestamp）同 x-signature
 *   （HMAC-SHA256 hex）；value_to_digest = x-timestamp 字串 ＋ 原始 request body，
 *   key 用 webhook 訂閱嘅 secret；驗證必須用未經 parse 嘅 raw body。
 *   來源：https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events
 * - 事件結構：{ id, name, data: { object } }，payment_intent.* 事件嘅 data.object
 *   等同 Retrieve a PaymentIntent 嘅回應（有 merchant_order_id / id / status / amount）。
 *   來源：同上 listen-for-webhook-events
 */

export type AirwallexConfig = {
  clientId: string;
  apiKey: string;
  webhookSecret: string;
  baseUrl: string;
  publicBaseUrl: string;
};

// ─── 設定來源：siteSettings（後台可改）＋ env 後備 ──────────────────────────

/** siteSettings 入面存 Airwallex 配置嘅 key（後台管理員頁填寫，見 settingsRouter.setAirwallexConfig） */
export const AIRWALLEX_CONFIG_SETTING_KEY = "airwallex_config";

/** 存落 siteSettings 嘅 JSON 結構（全部欄位 optional，唔齊嘅欄位會用 env 補） */
export type AirwallexStoredConfig = {
  clientId?: string;
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
};

const DEFAULT_BASE_URL = "https://api-demo.airwallex.com";

/**
 * 讀 siteSettings 嘅 airwallex_config JSON。
 * 冇列／JSON.parse 壞咗／DB 讀唔到都當 null（之後照跌落 env 後備，網站唔會冧）。
 */
async function readStoredConfig(): Promise<AirwallexStoredConfig | null> {
  try {
    const db = getDb();
    const row = await db.query.siteSettings.findFirst({
      where: eq(siteSettings.key, AIRWALLEX_CONFIG_SETTING_KEY),
    });
    if (!row) return null;
    const parsed = JSON.parse(row.value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AirwallexStoredConfig;
  } catch {
    return null;
  }
}

// ─── Config cache（TTL 60 秒，避免每個 request 都打 DB）────────────────────

const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { value: AirwallexConfig | null; expiresAtMs: number } | null = null;
let pendingConfigLoad: Promise<AirwallexConfig | null> | null = null;

/** 後台改完設定即時生效用（settingsRouter.setAirwallexConfig 會叫）；測試亦可用 */
export function resetAirwallexConfigCache(): void {
  configCache = null;
  pendingConfigLoad = null;
}

async function loadAirwallexConfig(): Promise<AirwallexConfig | null> {
  const stored = await readStoredConfig();
  // DB 優先；逐欄睇，DB 冇／唔齊嘅欄位先跌落 process.env 後備（保留原有 env 部署方式）
  const clientId = stored?.clientId?.trim() || process.env.AIRWALLEX_CLIENT_ID?.trim() || "";
  const apiKey = stored?.apiKey?.trim() || process.env.AIRWALLEX_API_KEY?.trim() || "";
  const webhookSecret =
    stored?.webhookSecret?.trim() || process.env.AIRWALLEX_WEBHOOK_SECRET?.trim() || "";
  if (!clientId || !apiKey || !webhookSecret) return null;
  const baseUrl = (
    stored?.baseUrl?.trim() ||
    process.env.AIRWALLEX_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "https://redcode.red").replace(
    /\/+$/,
    "",
  );
  return { clientId, apiKey, webhookSecret, baseUrl, publicBaseUrl };
}

/**
 * 讀 Airwallex 配置（**async**，先查 siteSettings 再跌落 env，60 秒 in-memory cache）；
 * client id / api key / webhook secret 三樣未齊 → 回 null（功能視為「未啟用」，
 * tRPC 回 { enabled:false }，webhook 回 503，網站照舊用截圖流程，唔會冧）。
 * webhook secret 缺咗都當未配置（收唔到款確認嘅 HPP 冇意義）。
 */
export function getAirwallexConfig(): Promise<AirwallexConfig | null> {
  if (configCache && configCache.expiresAtMs > Date.now()) {
    return Promise.resolve(configCache.value);
  }
  // concurrent 請求共用同一個 load promise，唔會一齊打 DB
  if (!pendingConfigLoad) {
    pendingConfigLoad = loadAirwallexConfig()
      .then((value) => {
        configCache = { value, expiresAtMs: Date.now() + CONFIG_CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        pendingConfigLoad = null;
      });
  }
  return pendingConfigLoad;
}

// ─── Access token cache ────────────────────────────────────────────────────
// token 有效期約 30 分鐘（官方：access token 30 minutes），in-memory cache 兼
// 喺到期前 60 秒提早換新；concurrent 請求共用同一個 login promise，唔會打爆 login API。

let cachedToken: { token: string; expiresAtMs: number } | null = null;
let pendingLogin: Promise<string> | null = null;

/** Airwallex expires_at 格式係 "2026-05-12T00:00:00+0000"，補返個冒號先保證 Date 喺各 runtime 都 parse 到 */
function parseExpiresAt(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) return null;
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

async function login(cfg: AirwallexConfig): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/api/v1/authentication/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": cfg.clientId,
      "x-api-key": cfg.apiKey,
    },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Airwallex login 失敗（HTTP ${res.status}）：${detail}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: string };
  if (!json.token) throw new Error("Airwallex login 回應冇 token");
  const expiresAtMs =
    parseExpiresAt(json.expires_at) ?? Date.now() + 25 * 60 * 1000; // parse 唔到就保守當 25 分鐘
  cachedToken = { token: json.token, expiresAtMs };
  return json.token;
}

function getAccessToken(cfg: AirwallexConfig): Promise<string> {
  // 到期前 60 秒已當過期，避免用緊嗰刻啱啱好過期
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > Date.now()) {
    return Promise.resolve(cachedToken.token);
  }
  if (!pendingLogin) {
    pendingLogin = login(cfg).finally(() => {
      pendingLogin = null;
    });
  }
  return pendingLogin;
}

// ─── Hosted Payment Page 開單 ──────────────────────────────────────────────

export type HostedPaymentResult = {
  /** PaymentIntent id（int_xxx），前端 redirectToCheckout＋webhook 對單用 */
  intentId: string;
  /**
   * intent 嘅 client_secret——官方設計本身就係交畀前端（客人瀏覽器）用嚟開付款頁
   * （Airwallex.js redirectToCheckout 必填欄位），唔係 server 機密。
   */
  clientSecret: string;
  /** Airwallex.js SDK 環境（由 baseUrl 推斷）：api-demo.* → demo；其餘 → prod */
  env: "demo" | "prod";
  /** 付款完跳返嚟嘅 URL（同 intent return_url 一致，前端 successUrl 用同一個） */
  returnUrl: string;
  currency: string;
};

/**
 * 開 PaymentIntent，回傳 intent id＋client_secret 畀前端用官方 Airwallex.js
 * redirectToCheckout 跳去託管付款頁（2026-09-29 hotfix）。
 *
 * 背景：舊版 Step 2 打 server-side `POST /api/v1/pa/payment_session/create` 攞付款頁
 * URL，實測 Airwallex gateway 回 openresty HTML 錯誤頁（endpoint 唔可用），客人見到
 * 「開網上付款單失敗」，但 intent 已建（後台見「已創建」）。官方現行 HPP 做法係：
 * 後端淨建 intent → 前端 SDK `payments.redirectToCheckout({ intent_id, client_secret,
 * currency, successUrl })`——唔再需要 server 打第二個 API，成個失敗點直接消失。
 * amount 單位係港元「元」（major unit，見檔頭核實紀錄）——本站 orders.total 本身就係
 * integer 港元，直接傳入，唔使乘 100。
 */
export async function createHostedPayment(args: {
  cfg: AirwallexConfig;
  orderId: number;
  orderNo: string;
  amount: number;
  returnUrl: string;
}): Promise<HostedPaymentResult> {
  const { cfg } = args;
  const env: "demo" | "prod" = cfg.baseUrl.includes("demo") ? "demo" : "prod";
  // 逐步日誌（Glo 要求每步有日誌）：唔記 token／apiKey／client_secret，只記對單用嘅欄位
  console.log(
    `[airwallex] 開網上付款單：訂單 ${args.orderNo}（id ${args.orderId}），金額 HK$${args.amount}，環境 ${env}`,
  );
  const token = await getAccessToken(cfg);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // 開 PaymentIntent（merchant_order_id 用訂單編號，webhook 同內部系統靠佢對單）
  const intentRes = await fetch(`${cfg.baseUrl}/api/v1/pa/payment_intents/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      request_id: randomUUID(),
      amount: args.amount,
      currency: "HKD",
      merchant_order_id: args.orderNo,
      descriptor: "RED CODE HK",
      return_url: args.returnUrl,
      metadata: { order_id: String(args.orderId), order_no: args.orderNo },
    }),
  });
  if (!intentRes.ok) {
    const detail = (await intentRes.text().catch(() => "")).slice(0, 300);
    console.error(
      `[airwallex] 開 intent 失敗：訂單 ${args.orderNo}，HTTP ${intentRes.status}：${detail}`,
    );
    throw new Error(`Airwallex 開 PaymentIntent 失敗（HTTP ${intentRes.status}）：${detail}`);
  }
  const intent = (await intentRes.json()) as { id?: string; client_secret?: string };
  if (!intent.id || !intent.client_secret) {
    console.error(`[airwallex] intent 回應缺欄位：訂單 ${args.orderNo}`, intent);
    throw new Error("Airwallex PaymentIntent 回應缺 id / client_secret");
  }
  console.log(`[airwallex] intent 已建立：${intent.id}（訂單 ${args.orderNo}），等待客人跳轉付款頁`);
  return {
    intentId: intent.id,
    clientSecret: intent.client_secret,
    env,
    returnUrl: args.returnUrl,
    currency: "HKD",
  };
}

// ─── 查 PaymentIntent 狀態（return 回跳主動查證用，2026-09-29 三 bug hotfix）────────────

export type RetrievedIntent = {
  id: string;
  /** Airwallex intent 狀態字串：SUCCEEDED / REQUIRES_PAYMENT_METHOD / CANCELLED 等 */
  status: string;
  merchantOrderId: string | null;
};

/**
 * GET /api/v1/pa/payment_intents/{id}——server-to-server 查 intent 最新狀態。
 * 用途：客人俾完錢跳返 /api/airwallex/return 嗰陣，webhook 可能遲到／漏咗
 * （Airwallex 後台未開 webhook、設定錯咗、網絡抖下），呢度主動查一次補狀態。
 * 官方文件：Payments Acceptance > PaymentIntents > Retrieve a PaymentIntent。
 */
export async function retrievePaymentIntent(
  cfg: AirwallexConfig,
  intentId: string,
): Promise<RetrievedIntent> {
  const token = await getAccessToken(cfg);
  const res = await fetch(
    `${cfg.baseUrl}/api/v1/pa/payment_intents/${encodeURIComponent(intentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Airwallex 查 intent 失敗（HTTP ${res.status}）：${detail}`);
  }
  const json = (await res.json()) as {
    id?: string;
    status?: string;
    merchant_order_id?: unknown;
  };
  if (!json.id || !json.status) {
    throw new Error("Airwallex 查 intent 回應缺 id / status");
  }
  return {
    id: json.id,
    status: json.status,
    merchantOrderId:
      typeof json.merchant_order_id === "string" ? json.merchant_order_id : null,
  };
}

// ─── 退款（原路退回，2026-09 F7 WMS↔官網退款）────────────────────────────

/**
 * 經 Airwallex 原路退款（欄位名跟足 WMS 已驗證嘅 createRefund 實作，
 * wfy0406/red-code-wms api/airwallex.ts）：POST /api/v1/pa/refunds/create，
 * body { request_id, payment_intent_id, amount, reason? }，回應攞 id ＋ status。
 * - amount 係整數港元（major unit，同本站 orders.total 一個單位），直接傳，唔乘除 100。
 * - requestId 係 idempotency key：調用方用 `refund-order-${orderId}`（deterministic），
 *   retry／重複批准唔會退兩次。
 * token 用返本檔嘅 cache 機制（getAirwallexConfig 係 async，記得 await）。
 * 失敗會 throw（Error message 截咗 300 字）——調用方（wmsRefund.ts）負責 catch
 * 兼將 refundStatus 標做 'failed'。
 */
export async function createAirwallexRefund(opts: {
  paymentIntentId: string;
  amount: number;
  requestId: string;
  reason?: string;
}): Promise<{ id: string; status: string }> {
  const cfg = await getAirwallexConfig();
  if (!cfg) {
    throw new Error("Airwallex 未配置，唔可以原路退款");
  }
  const token = await getAccessToken(cfg);
  const res = await fetch(`${cfg.baseUrl}/api/v1/pa/refunds/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      request_id: opts.requestId,
      payment_intent_id: opts.paymentIntentId,
      amount: opts.amount,
      ...(opts.reason ? { reason: opts.reason } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Airwallex 退款失敗（HTTP ${res.status}）：${detail}`);
  }
  const json = (await res.json()) as { id?: string; status?: string };
  if (!json.id) {
    throw new Error("Airwallex 退款回應缺 refund id");
  }
  return { id: json.id, status: json.status ?? "" };
}

// ─── Webhook 簽名驗證 ──────────────────────────────────────────────────────

/**
 * 驗證 Airwallex webhook 簽名（官方算法，見檔頭核實紀錄）：
 * value_to_digest = x-timestamp（原樣字串，唔准轉格式）＋ raw body，
 * HMAC-SHA256（key = webhook secret）→ hex，同 x-signature 做 constant-time 比對。
 * 必須傳入**未經 JSON.parse / 重排**嘅原始 body，否則 bytes 唔同簽名會夾唔到。
 * 唔設時間窗（timestamp tolerance）：Airwallex 失敗會 retry，retry 嘅 timestamp 可能
 * 好舊；簽名本身已經防偽造，重複事件交由業務層冪等處理（conditional update）。
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  signature: string,
  rawBody: string,
): boolean {
  if (!secret || !timestamp || !signature) return false;
  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
