/**
 * Airwallex Hosted Payment Page 前端跳轉（官方 Airwallex.js SDK，2026-09-29 hotfix）
 *
 * 背景：舊契約係後端回 { url } → window.location.href 直跳。但後端攞 url 要打
 * `POST /api/v1/pa/payment_session/create`，Airwallex gateway 實測回 openresty HTML
 * 錯誤頁（endpoint 唔可用）→ 全部即時付款失敗。官方現行做法（quickstart）：
 * 後端淨建 PaymentIntent 回 { intentId, clientSecret, env, currency, returnUrl }，
 * 前端 load 官方 SDK `https://static.airwallex.com/components/sdk/v1/index.js`，
 * `payments.redirectToCheckout({ intent_id, client_secret, currency, successUrl })`
 * 由 SDK 跳去託管付款頁。demo／prod 環境都係呢一套，唔再經 payment_session。
 *
 * 用法（三個支付位共用：Checkout 付款步驟 / Payment 頁 / 我的訂單 OrderCard）：
 *   const result = await createPayment.mutateAsync({ orderId });
 *   if (result.enabled) await redirectToAirwallexCheckout(result);
 * redirectToCheckout 會即刻 full-page 跳轉；成功之後嘅 promise 正常唔會再行落去。
 */

declare global {
  interface Window {
    AirwallexComponentsSDK?: {
      init: (opts: {
        env: string;
        enabledElements: string[];
      }) => Promise<{
        payments: {
          redirectToCheckout: (opts: Record<string, unknown>) => void;
        };
      }>;
    };
  }
}

/** 官方 SDK CDN（Airwallex 文檔 quickstart 指定嘅固定網址） */
const SDK_URL = 'https://static.airwallex.com/components/sdk/v1/index.js';

export type AirwallexCheckoutParams = {
  intentId: string;
  clientSecret: string;
  env: 'demo' | 'prod';
  currency: string;
  returnUrl: string;
};

type PaymentsHandle = {
  redirectToCheckout: (opts: Record<string, unknown>) => void;
};

let sdkScriptPromise: Promise<NonNullable<Window['AirwallexComponentsSDK']>> | null = null;
let paymentsPromise: Promise<PaymentsHandle> | null = null;
/** init 用咗邊個 env——demo/prod 中途切換要重新 init，否則 SDK 會指去舊環境 */
let paymentsEnv: string | null = null;

/** 動態插入 SDK <script>（singleton；失敗會清 cache 等下次可以重試） */
function loadSdk(): Promise<NonNullable<Window['AirwallexComponentsSDK']>> {
  if (window.AirwallexComponentsSDK) {
    return Promise.resolve(window.AirwallexComponentsSDK);
  }
  if (!sdkScriptPromise) {
    sdkScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => {
        if (window.AirwallexComponentsSDK) {
          resolve(window.AirwallexComponentsSDK);
        } else {
          sdkScriptPromise = null;
          reject(new Error('付款元件載入異常，請再試一次'));
        }
      };
      script.onerror = () => {
        sdkScriptPromise = null;
        reject(new Error('付款元件載入失敗，請檢查網絡後再試'));
      };
      document.head.appendChild(script);
    });
  }
  return sdkScriptPromise;
}

async function getPayments(env: string): Promise<PaymentsHandle> {
  const sdk = await loadSdk();
  if (!paymentsPromise || paymentsEnv !== env) {
    paymentsEnv = env;
    paymentsPromise = sdk
      .init({ env, enabledElements: ['payments'] })
      .then(({ payments }) => payments)
      .catch((err: unknown) => {
        // init 失敗（例如網絡／環境配置問題）：清 cache 等下次撳可以重試
        paymentsPromise = null;
        throw err instanceof Error ? err : new Error('付款元件初始化失敗，請再試一次');
      });
  }
  return paymentsPromise;
}

/**
 * 跳去 Airwallex 託管付款頁。成功會即刻跳轉（成個頁面離開），
 * 失敗（SDK 載入／初始化問題）會 throw，caller 負責顯示錯誤訊息。
 */
export async function redirectToAirwallexCheckout(
  params: AirwallexCheckoutParams,
): Promise<void> {
  const payments = await getPayments(params.env);
  payments.redirectToCheckout({
    env: params.env,
    mode: 'payment',
    intent_id: params.intentId,
    client_secret: params.clientSecret,
    currency: params.currency,
    successUrl: params.returnUrl,
  });
}
