/**
 * 收款方式（全網統一來源，2026-08-08 Glo 要求）：
 * 後台「業務分析 → 收款方式」編輯（**淨係管理員**改得，後端 adminProcedure 把關），
 * 存 siteSettings key="payment_methods"（JSON 字串）。
 * 前台 /payment 頁＋結帳步驟② 都讀呢個 key —— 改一個位全網同步，唔會改一頁漏一頁。
 * 冇設定／JSON 壞咗 → 用 DEFAULT_PAYMENT_METHODS（＝2026-08-08 之前 hardcode 嗰 set 真資料）。
 */

export interface PaymentMethodEntry {
  /** 固定 4 個 id：boc 中銀／payme／alipay／fps（前台 icon＋色按 id 映射） */
  id: string;
  /** 大卡標題，例：中銀香港 */
  label: string;
  /** 標題下嘅小字，例：銀行轉帳 */
  subtitle: string;
  /** 主帳號行嘅 label，例：戶口號碼／PayMe 號碼／FPS 識別碼 */
  accountLabel: string;
  /** 主帳號（一撳複製嘅就係佢） */
  account: string;
  /** 第二行資料（選填，唔可以複製），例：戶口名稱＝RED CODE HK LIMITED */
  extraLabel?: string;
  extraValue?: string;
}

export const PAYMENT_METHODS_SETTING_KEY = "payment_methods";

/** 固定順序（後台編輯器、儲存、前台顯示都跟呢個序） */
export const PAYMENT_METHOD_IDS = ["boc", "payme", "alipay", "fps"] as const;

export const DEFAULT_PAYMENT_METHODS: PaymentMethodEntry[] = [
  {
    id: "boc",
    label: "中銀香港",
    subtitle: "銀行轉帳",
    accountLabel: "戶口號碼",
    account: "012-586-2-113136-9",
    extraLabel: "戶口名稱",
    extraValue: "RED CODE HK LIMITED",
  },
  {
    id: "payme",
    label: "PayMe",
    subtitle: "HSBC PayMe 過數",
    accountLabel: "PayMe 號碼",
    account: "97083811",
  },
  {
    id: "alipay",
    label: "Alipay 支付寶",
    subtitle: "支付寶香港",
    accountLabel: "支付寶號碼",
    account: "97083811",
  },
  {
    id: "fps",
    label: "FPS 轉數快",
    subtitle: "識別碼過數，即時到賬",
    accountLabel: "FPS 識別碼",
    account: "120070784",
    extraLabel: "收款名稱",
    extraValue: "RED CODE HK LIMITED",
  },
];

/** siteSettings 攞出嚟嘅 JSON → 齊 4 個收款方式；壞 JSON／缺欄位／唔齊 id 就回預設（唔會顯示到半殘資料） */
export function parsePaymentMethods(raw: string | null | undefined): PaymentMethodEntry[] {
  if (!raw) return DEFAULT_PAYMENT_METHODS;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return DEFAULT_PAYMENT_METHODS;
    const out: PaymentMethodEntry[] = [];
    for (const id of PAYMENT_METHOD_IDS) {
      const m = data.find(
        (x): x is Record<string, unknown> =>
          !!x && typeof x === "object" && (x as Record<string, unknown>).id === id,
      );
      if (!m) return DEFAULT_PAYMENT_METHODS;
      const label = typeof m.label === "string" ? m.label.trim() : "";
      const accountLabel = typeof m.accountLabel === "string" ? m.accountLabel.trim() : "";
      const account = typeof m.account === "string" ? m.account.trim() : "";
      if (!label || !accountLabel || !account) return DEFAULT_PAYMENT_METHODS;
      const subtitle = typeof m.subtitle === "string" ? m.subtitle.trim() : "";
      const extraLabel = typeof m.extraLabel === "string" ? m.extraLabel.trim() : "";
      const extraValue = typeof m.extraValue === "string" ? m.extraValue.trim() : "";
      out.push({
        id,
        label,
        subtitle,
        accountLabel,
        account,
        ...(extraLabel && extraValue ? { extraLabel, extraValue } : {}),
      });
    }
    return out;
  } catch {
    return DEFAULT_PAYMENT_METHODS;
  }
}
