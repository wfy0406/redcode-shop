export const WEB_DESIGN_PLANS = ["front_only", "full_stack"] as const;
export type WebDesignPlan = (typeof WEB_DESIGN_PLANS)[number];
export type WebDesignBilling = "one_off" | "monthly" | "at_cost";
export type WebDesignCategory = "seo" | "feature" | "service";

export interface WebDesignCatalogItem {
  key: string;
  name: string;
  description: string;
  category: WebDesignCategory;
  price: number;
  marketPrice: number;
  requiredPlan: WebDesignPlan;
  billing: WebDesignBilling;
  selectable: boolean;
  active: boolean;
  sortOrder: number;
  priceNote: string;
}

export interface WebDesignCatalog {
  frontOnlyPrice: number;
  frontOnlyMarketPrice: number;
  fullStackPrice: number;
  fullStackMarketPrice: number;
  items: WebDesignCatalogItem[];
}

export const WEB_DESIGN_CATALOG_SETTING_KEY = "web_design_catalog";

/**
 * 舊版六個逐項 SEO key（v2026.11.09 前）：已合併做單一 seo_package 套票。
 * mergeCatalogWithDefaults 會將佢哋正規化做套票；validateCatalog／priceOrder 一律拒絕。
 * 舊訂單 items snapshot 唔會改（嗰啲係成交紀錄，唔經 catalog）。
 */
export const LEGACY_SEO_ITEM_KEYS = [
  "seo_meta",
  "seo_index",
  "seo_share",
  "seo_schema",
  "seo_semantic",
  "seo_report",
] as const;

export const DEFAULT_WEB_DESIGN_CATALOG: WebDesignCatalog = {
  frontOnlyPrice: 1668,
  frontOnlyMarketPrice: 5179,
  fullStackPrice: 4428,
  fullStackMarketPrice: 13750,
  items: [
    { key: "seo_package", name: "SEO 技術優化套票", description: "一次過做晒：逐頁 title 同 description、canonical／robots／sitemap、Open Graph 分享預覽、同內容一致嘅 Service／Organization 結構化資料、H1–H3 層級同圖片 alt、效能檢查，並出逐項驗證報告。做實事，唔承諾搜尋排名。", category: "seo", price: 1240, marketPrice: 4429, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 10, priceNote: "一次性｜完整套票" },
    { key: "catalog_admin", name: "服務／產品內容管理", description: "同事喺後台新增、修改、停用服務或產品內容。", category: "feature", price: 1127, marketPrice: 3500, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 110, priceNote: "一次性｜需要前台＋後台" },
    { key: "enquiry_admin", name: "預約／留言資料管理", description: "表格資料落入專用後台，可搜尋、分類同跟進，唔使代客申請第三方帳號。", category: "feature", price: 1012, marketPrice: 3143, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 120, priceNote: "一次性｜需要前台＋後台" },
    { key: "staff_audit", name: "員工權限及操作日誌", description: "後端按角色擋越權操作，並保留重要更改紀錄。", category: "feature", price: 1472, marketPrice: 4571, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 130, priceNote: "一次性｜需要前台＋後台" },
    { key: "ecard", name: "電子名片 e-Card", description: "專屬名片頁列晒聯絡方法、WhatsApp 同社交連結，一撳儲存聯絡人；資料由自己後台改，唔使代客申請第三方 API。", category: "feature", price: 690, marketPrice: 3500, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 140, priceNote: "一次性｜需要前台＋後台" },
    { key: "multilingual", name: "全網多語言版本", description: "全網頁面加語言切換同各語種文案，hreflang 等收錄設定一併執好，內容自己後台更新。", category: "feature", price: 1840, marketPrice: 8000, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 150, priceNote: "一次性" },
    { key: "social_embed", name: "Facebook／Instagram 動態嵌入", description: "喺網站指定位置嵌入你提供嘅 Facebook 專頁或 Instagram 公開內容，社交平台有新帖會喺嵌入位置同步顯示；包括桌面及手機排版，唔需要代你申請第三方 API。", category: "feature", price: 800, marketPrice: 0, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 155, priceNote: "一次性" },
    { key: "progress_lookup", name: "客戶進度查詢專區", description: "客人用單號同電話自己查訂單／服務進度，唔使次次打嚟問；進度由同事後台更新。", category: "feature", price: 3450, marketPrice: 9000, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 160, priceNote: "一次性｜需要前台＋後台" },
    { key: "followup_reminders", name: "跟進提醒系統", description: "後台為每位客設定跟進日期同備註，到期提醒同事跟客，唔再靠腦記。", category: "feature", price: 2760, marketPrice: 3500, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 170, priceNote: "一次性｜需要前台＋後台" },
    { key: "hosting_monthly", name: "網站架設、雲端託管及維護", description: "網站成品需要地方存放，好似畀間屋佢住。月費包括雲端服務商收費，以及系統有問題時由我方維修。", category: "service", price: 633, marketPrice: 1964, requiredPlan: "front_only", billing: "monthly", selectable: true, active: true, sortOrder: 200, priceNote: "每月｜今次連首月計，其後按月安排" },
    { key: "domain_at_cost", name: "網域名稱 Domain", description: "一般約 HK$100–300／年，按供應商實報實銷；唔需要我哋代客申請其他第三方 API。", category: "service", price: 0, marketPrice: 0, requiredPlan: "front_only", billing: "at_cost", selectable: false, active: true, sortOrder: 210, priceNote: "約 HK$100–300／年｜實報實銷" },
  ],
};

export function planLabel(plan: WebDesignPlan): string {
  return plan === "full_stack" ? "前台＋後台" : "只要前台";
}

export function planAllows(plan: WebDesignPlan, requiredPlan: WebDesignPlan): boolean {
  return plan === "full_stack" || requiredPlan === "front_only";
}

export function discountPercent(price: number, marketPrice: number): number {
  return marketPrice > 0 ? Math.round((price / marketPrice) * 100) : 0;
}
