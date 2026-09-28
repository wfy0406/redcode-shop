import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

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

/**
 * 讀 env 配置；client id / api key 未齊 → 回 null（功能視為「未啟用」，
 * tRPC 回 { enabled:false }，webhook 回 503，網站照舊用截圖流程，唔會冧）。
 * webhook secret 缺咗都當未配置（收唔到款確認嘅 HPP 冇意義）。
 */
export function getAirwallexConfig(): AirwallexConfig | null {
  const clientId = process.env.AIRWALLEX_CLIENT_ID?.trim();
  const apiKey = process.env.AIRWALLEX_API_KEY?.trim();
  const webhookSecret = process.env.AIRWALLEX_WEBHOOK_SECRET?.trim();
  if (!clientId || !apiKey || !webhookSecret) return null;
  const baseUrl = (
    process.env.AIRWALLEX_BASE_URL || "https://api-demo.airwallex.com"
  ).replace(/\/+$/, "");
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "https://redcode.red").replace(
    /\/+$/,
    "",
  );
  return { clientId, apiKey, webhookSecret, baseUrl, publicBaseUrl };
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
  /** 客人要跳轉去嘅 Airwallex 託管付款頁 URL */
  url: string;
  /** PaymentIntent id（int_xxx），webhook 對單／寫落訂單用 */
  intentId: string;
};

/**
 * 開 PaymentIntent ＋ HPP payment_session，回傳付款頁 URL。
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
  const token = await getAccessToken(cfg);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Step 1：開 PaymentIntent（merchant_order_id 用訂單編號，webhook 同內部系統靠佢對單）
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
    throw new Error(`Airwallex 開 PaymentIntent 失敗（HTTP ${intentRes.status}）：${detail}`);
  }
  const intent = (await intentRes.json()) as { id?: string; client_secret?: string };
  if (!intent.id || !intent.client_secret) {
    throw new Error("Airwallex PaymentIntent 回應缺 id / client_secret");
  }

  // Step 2：開 HPP payment_session，拎託管付款頁 URL
  const sessionRes = await fetch(`${cfg.baseUrl}/api/v1/pa/payment_session/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      request_id: randomUUID(),
      payment_intent_id: intent.id,
      client_secret: intent.client_secret,
      currency: "HKD",
      return_url: args.returnUrl,
    }),
  });
  if (!sessionRes.ok) {
    const detail = (await sessionRes.text().catch(() => "")).slice(0, 300);
    throw new Error(`Airwallex 開 payment_session 失敗（HTTP ${sessionRes.status}）：${detail}`);
  }
  const session = (await sessionRes.json()) as { url?: string };
  if (!session.url) {
    throw new Error("Airwallex payment_session 回應冇付款頁 url");
  }
  return { url: session.url, intentId: intent.id };
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
