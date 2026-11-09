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

export const DEFAULT_WEB_DESIGN_CATALOG: WebDesignCatalog = {
  frontOnlyPrice: 1450,
  frontOnlyMarketPrice: 5179,
  fullStackPrice: 3850,
  fullStackMarketPrice: 13750,
  items: [
    { key: "seo_meta", name: "頁面標題及搜尋描述", description: "為公開頁設定獨立 title 同 description，完成後逐頁核對。", category: "seo", price: 180, marketPrice: 643, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 10, priceNote: "一次性" },
    { key: "seo_index", name: "Canonical、robots 及 sitemap", description: "整理正式網址、收錄規則同網站地圖，減少重複頁面。", category: "seo", price: 220, marketPrice: 786, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 20, priceNote: "一次性" },
    { key: "seo_share", name: "Open Graph 分享預覽", description: "設定分享標題、描述同預覽圖，實測連結分享顯示。", category: "seo", price: 180, marketPrice: 643, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 30, priceNote: "一次性" },
    { key: "seo_schema", name: "結構化資料", description: "加入同真實內容一致嘅 Service／Organization 結構化資料並驗證。", category: "seo", price: 220, marketPrice: 786, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 40, priceNote: "一次性" },
    { key: "seo_semantic", name: "語義標題及圖片替代文字", description: "整理 H1–H3 層級、圖片 alt 同基本可讀性。", category: "seo", price: 160, marketPrice: 571, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 50, priceNote: "一次性" },
    { key: "seo_report", name: "效能檢查及 SEO 驗證報告", description: "逐項記錄已通過、未通過同修正建議；唔承諾搜尋排名。", category: "seo", price: 280, marketPrice: 1000, requiredPlan: "front_only", billing: "one_off", selectable: true, active: true, sortOrder: 60, priceNote: "一次性" },
    { key: "catalog_admin", name: "服務／產品內容管理", description: "同事喺後台新增、修改、停用服務或產品內容。", category: "feature", price: 980, marketPrice: 3500, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 110, priceNote: "一次性｜需要前台＋後台" },
    { key: "enquiry_admin", name: "預約／留言資料管理", description: "表格資料落入專用後台，可搜尋、分類同跟進，唔使代客申請第三方帳號。", category: "feature", price: 880, marketPrice: 3143, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 120, priceNote: "一次性｜需要前台＋後台" },
    { key: "staff_audit", name: "員工權限及操作日誌", description: "後端按角色擋越權操作，並保留重要更改紀錄。", category: "feature", price: 1280, marketPrice: 4571, requiredPlan: "full_stack", billing: "one_off", selectable: true, active: true, sortOrder: 130, priceNote: "一次性｜需要前台＋後台" },
    { key: "hosting_monthly", name: "網站架設、雲端託管及維護", description: "網站成品需要地方存放，好似畀間屋佢住。月費包括雲端服務商收費，以及系統有問題時由我方維修。", category: "service", price: 550, marketPrice: 1964, requiredPlan: "front_only", billing: "monthly", selectable: true, active: true, sortOrder: 200, priceNote: "每月｜今次連首月計，其後按月安排" },
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
