/**
 * 網站設計服務（v2026.11.09）共用純函數——唔掂 DB／唔掂 filesystem，
 * 等 vitest 可以直踩核心規則（catalog 驗證／方案依賴／server 計價／電話 normalize／
 * 狀態 mapping／WMS payload／私隱查詢輸入）。
 */
import { randomInt } from "node:crypto";
import {
  DEFAULT_WEB_DESIGN_CATALOG,
  LEGACY_SEO_ITEM_KEYS,
  RETIRED_ITEM_KEYS,
  WEB_DESIGN_PLANS,
  planAllows,
  planLabel,
  type WebDesignCatalog,
  type WebDesignCatalogItem,
  type WebDesignPlan,
  type WebDesignPlanCopy,
} from "@contracts/webDesign";
import { normalizeGuestPhone } from "./guestUtils";

/** 訂單狀態（凍結）：received 已收單｜in_production 製作中｜completed 網站已完成｜cancelled 已取消 */
export const WEB_DESIGN_ORDER_STATUSES = ["received", "in_production", "completed", "cancelled"] as const;
export type WebDesignOrderStatus = (typeof WEB_DESIGN_ORDER_STATUSES)[number];

/** 付款狀態（獨立於訂單狀態）：pending｜review（已傳截圖待核實）｜paid｜rejected */
export const WEB_DESIGN_PAYMENT_STATUSES = ["pending", "review", "paid", "rejected"] as const;
export type WebDesignPaymentStatus = (typeof WEB_DESIGN_PAYMENT_STATUSES)[number];

/** WMS 同步狀態欄取值（null＝未送出） */
export type WebDesignWmsStatus = "sent" | "failed" | "disabled";

export const WD_ORDER_NO_PREFIX = "WD";

/** 專屬查單／三欄核實嘅統一錯誤訊息（唔好分開話邊欄錯，防枚舉偷睇） */
export const WEB_DESIGN_LOOKUP_FAIL_MESSAGE = "搵唔到相關訂單，請核對完整姓名同電話號碼";

export function isWebDesignOrderNo(orderNo: string): boolean {
  return orderNo.startsWith(WD_ORDER_NO_PREFIX);
}

/** 單號：WD + YYYYMMDD + 隨機 4 位（同 generateOrderNo 一款；unique constraint 做跨 process 冪等鎖） */
export function generateWebDesignOrderNo(
  now: Date = new Date(),
  rand: (max: number) => number = (max) => randomInt(0, max),
): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `${WD_ORDER_NO_PREFIX}${ymd}${String(rand(10000)).padStart(4, "0")}`;
}

/** 電話 normalize：同訪客購物一套規則（8 位數字，可帶 +852／852 前綴）；唔啱回 null */
export function normalizeWebDesignPhone(raw: string): string | null {
  return normalizeGuestPhone(raw);
}

/** 私隱查詢輸入檢查：完整姓名（trim 後非空）＋合法電話；唔啱回 null（caller 統一錯誤） */
export function validateLookupInput(
  name: unknown,
  phone: unknown,
): { name: string; phone: string } | null {
  if (typeof name !== "string" || typeof phone !== "string") return null;
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 64) return null;
  const normalizedPhone = normalizeWebDesignPhone(phone);
  if (!normalizedPhone) return null;
  return { name: trimmedName, phone: normalizedPhone };
}

// ─── Catalog 驗證／合併 ────────────────────────────────────────────────────

const CATEGORIES = new Set(["seo", "feature", "service"]);
const BILLINGS = new Set(["one_off", "monthly", "at_cost"]);

/** 舊六項 seo_* 已併入 seo_package 套票（契約常量的 Set 版，內部用） */
const LEGACY_SEO_KEY_SET = new Set<string>(LEGACY_SEO_ITEM_KEYS);

/** 已退役項目（followup_reminders）：merge 過濾／strict 拒收／priceOrder 拒絕 */
const RETIRED_KEY_SET = new Set<string>(RETIRED_ITEM_KEYS);

/** 永遠只供參考／查詢報價：唔信 stored JSON 嘅 selectable、billing 或價錢。 */
const QUOTE_ONLY_KEY_SET = new Set<string>(["domain_at_cost", "website_customization"]);

const ITEM_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** 預設 catalog 入面嘅 seo_package 套票定義（legacy 正規化時照用呢份） */
function defaultSeoPackage(): WebDesignCatalogItem {
  const pkg = DEFAULT_WEB_DESIGN_CATALOG.items.find((i) => i.key === "seo_package");
  if (!pkg) throw new Error("預設 catalog 缺 seo_package");
  return { ...pkg };
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function validateItem(raw: unknown): WebDesignCatalogItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || !ITEM_KEY_RE.test(r.key)) return null;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  if (!CATEGORIES.has(String(r.category))) return null;
  if (!isNonNegInt(r.price) || !isNonNegInt(r.marketPrice)) return null;
  if (!WEB_DESIGN_PLANS.includes(r.requiredPlan as WebDesignPlan)) return null;
  if (!BILLINGS.has(String(r.billing))) return null;
  return {
    key: r.key,
    name: r.name.trim().slice(0, 255),
    description: typeof r.description === "string" ? r.description.slice(0, 1000) : "",
    category: r.category as WebDesignCatalogItem["category"],
    price: r.price,
    marketPrice: r.marketPrice,
    requiredPlan: r.requiredPlan as WebDesignPlan,
    billing: r.billing as WebDesignCatalogItem["billing"],
    selectable: r.selectable !== false,
    active: r.active !== false,
    sortOrder: isNonNegInt(r.sortOrder) ? r.sortOrder : 0,
    priceNote: typeof r.priceNote === "string" ? r.priceNote.slice(0, 255) : "",
  };
}

function normalizeQuoteOnlyItem(item: WebDesignCatalogItem): WebDesignCatalogItem {
  if (!QUOTE_ONLY_KEY_SET.has(item.key)) return item;
  return { ...item, price: 0, marketPrice: 0, billing: "at_cost", selectable: false };
}

function hasValidQuoteOnlySemantics(item: WebDesignCatalogItem): boolean {
  return !QUOTE_ONLY_KEY_SET.has(item.key)
    || (item.price === 0 && item.marketPrice === 0 && item.billing === "at_cost" && !item.selectable);
}

/** 方案文案驗證：name 非空；points 係非空字串陣列（0–20 條）；description 可空字串 */
function validatePlanCopy(raw: unknown): WebDesignPlanCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  if (!Array.isArray(r.points) || r.points.length > 20) return null;
  const points: string[] = [];
  for (const p of r.points) {
    if (typeof p !== "string" || !p.trim()) return null;
    points.push(p.trim().slice(0, 255));
  }
  return {
    name: r.name.trim().slice(0, 255),
    description: typeof r.description === "string" ? r.description.slice(0, 1000) : "",
    points,
  };
}

/** 墓碑 key 列表（lenient 版）：壞值逐個 drop、去重；merge 用呢個 */
function sanitizeDeletedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !ITEM_KEY_RE.test(k) || out.includes(k)) continue;
    out.push(k);
  }
  return out;
}

/**
 * siteSettings JSON → 完整 catalog（合併預設）：
 * 四個方案價逐個驗，唔啱／缺就落預設；items 逐項驗，壞項 drop（唔好成個 catalog 報廢）；
 * 完全 parse 唔到 → 成個預設 catalog。
 * 舊六項 seo_* 正規化：冇 seo_package → 自動補預設套票；有 seo_package → 保留後台自訂
 * 內容同價錢；無論如何舊 seo_* 項一律 drop（舊訂單 items snapshot 係成交紀錄，唔經呢度）。
 * 舊 catalog 冇 social_embed／website_customization 時補官方新服務；已存在時保留後台自訂內容同價錢。
 * 已退役項目（followup_reminders）一律過濾；deletedItemKeys 墓碑內嘅 key 一律唔放行，
 * legacy 自動補項（seo_package／social_embed／website_customization）都唔會復活已刪項目。
 * 舊 stored JSON 冇方案文案／墓碑欄 → 落預設；文案壞咗都落預設（lenient 讀取）。
 */
export function mergeCatalogWithDefaults(raw: unknown): WebDesignCatalog {
  const d = DEFAULT_WEB_DESIGN_CATALOG;
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const deletedItemKeys = sanitizeDeletedKeys(r.deletedItemKeys);
  const tombstones = new Set(deletedItemKeys);
  const itemsRaw = Array.isArray(r.items) ? r.items : [];
  const seen = new Set<string>();
  const items: WebDesignCatalogItem[] = [];
  let sawLegacySeo = false;
  let sawSeoPackage = false;
  let sawSocialEmbed = false;
  let sawWebsiteCustomization = false;
  for (const it of itemsRaw) {
    const validated = validateItem(it);
    if (!validated || items.length >= 200) continue;
    const v = normalizeQuoteOnlyItem(validated);
    if (LEGACY_SEO_KEY_SET.has(v.key)) {
      sawLegacySeo = true; // 舊逐項 SEO：唔再放行，落喺單一套票
      continue;
    }
    if (RETIRED_KEY_SET.has(v.key)) continue; // 退役項（followup_reminders）：一律過濾
    if (tombstones.has(v.key)) continue; // 後台刪除咗：唔復活
    if (seen.has(v.key)) continue; // key 重複：留第一個
    seen.add(v.key);
    if (v.key === "seo_package") sawSeoPackage = true;
    if (v.key === "social_embed") sawSocialEmbed = true;
    if (v.key === "website_customization") sawWebsiteCustomization = true;
    items.push(v);
  }
  if (sawLegacySeo && !sawSeoPackage && !tombstones.has("seo_package") && items.length < 200) {
    items.push(defaultSeoPackage()); // 舊 catalog 升級：補返官方套票定義（已刪就唔補）
  }
  if (!sawSocialEmbed && !tombstones.has("social_embed") && items.length < 200) {
    const socialEmbed = d.items.find((item) => item.key === "social_embed");
    if (socialEmbed) items.push({ ...socialEmbed }); // 舊 catalog 自動補新服務（已刪就唔補）
  }
  if (!sawWebsiteCustomization && !tombstones.has("website_customization") && items.length < 200) {
    const customization = d.items.find((item) => item.key === "website_customization");
    if (customization) items.push({ ...customization }); // 舊 catalog 自動補客製化報價項（已刪就唔補）
  }
  items.sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    frontOnlyPrice: isNonNegInt(r.frontOnlyPrice) ? r.frontOnlyPrice : d.frontOnlyPrice,
    frontOnlyMarketPrice: isNonNegInt(r.frontOnlyMarketPrice)
      ? r.frontOnlyMarketPrice
      : d.frontOnlyMarketPrice,
    fullStackPrice: isNonNegInt(r.fullStackPrice) ? r.fullStackPrice : d.fullStackPrice,
    fullStackMarketPrice: isNonNegInt(r.fullStackMarketPrice)
      ? r.fullStackMarketPrice
      : d.fullStackMarketPrice,
    frontOnlyCopy: validatePlanCopy(r.frontOnlyCopy) ?? { ...d.frontOnlyCopy, points: [...d.frontOnlyCopy.points] },
    fullStackCopy: validatePlanCopy(r.fullStackCopy) ?? { ...d.fullStackCopy, points: [...d.fullStackCopy.points] },
    items,
    deletedItemKeys,
  };
}

/**
 * adminCatalog/setCatalog 用：完整結構驗證（setCatalog 唔接受壞 payload 落 DB；
 * 舊 seo_* 逐項 key 一律拒收，要用 seo_package 套票；退役項 followup_reminders 一律拒收）。
 * 方案文案／deletedItemKeys：缺咗落預設（舊 payload 兼容）；有但壞 → 成個拒收。
 */
export function validateCatalog(raw: unknown): WebDesignCatalog | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r.frontOnlyPrice) || !isNonNegInt(r.frontOnlyMarketPrice)) return null;
  if (!isNonNegInt(r.fullStackPrice) || !isNonNegInt(r.fullStackMarketPrice)) return null;
  if (!Array.isArray(r.items)) return null;
  if (r.items.length > 200) return null;
  const d = DEFAULT_WEB_DESIGN_CATALOG;
  let frontOnlyCopy: WebDesignPlanCopy;
  let fullStackCopy: WebDesignPlanCopy;
  if (r.frontOnlyCopy === undefined) {
    frontOnlyCopy = { ...d.frontOnlyCopy, points: [...d.frontOnlyCopy.points] };
  } else {
    const v = validatePlanCopy(r.frontOnlyCopy);
    if (!v) return null;
    frontOnlyCopy = v;
  }
  if (r.fullStackCopy === undefined) {
    fullStackCopy = { ...d.fullStackCopy, points: [...d.fullStackCopy.points] };
  } else {
    const v = validatePlanCopy(r.fullStackCopy);
    if (!v) return null;
    fullStackCopy = v;
  }
  let deletedItemKeys: string[];
  if (r.deletedItemKeys === undefined) {
    deletedItemKeys = [];
  } else {
    if (!Array.isArray(r.deletedItemKeys)) return null;
    deletedItemKeys = [];
    for (const k of r.deletedItemKeys) {
      if (typeof k !== "string" || !ITEM_KEY_RE.test(k)) return null;
      if (!deletedItemKeys.includes(k)) deletedItemKeys.push(k);
    }
  }
  const seen = new Set<string>();
  const items: WebDesignCatalogItem[] = [];
  for (const it of r.items) {
    const v = validateItem(it);
    if (!v) return null; // 後台落貨要嚴：任何一項壞都成個拒收
    if (LEGACY_SEO_KEY_SET.has(v.key)) return null; // 舊逐項 SEO key 已廢，唔准再落 DB
    if (RETIRED_KEY_SET.has(v.key)) return null; // 退役項（followup_reminders）唔准再落 DB
    if (!hasValidQuoteOnlySemantics(v)) return null; // 查詢報價項唔可以改成收費／可加入購物車
    if (seen.has(v.key)) return null;
    seen.add(v.key);
    items.push(v);
  }
  return {
    frontOnlyPrice: r.frontOnlyPrice,
    frontOnlyMarketPrice: r.frontOnlyMarketPrice,
    fullStackPrice: r.fullStackPrice,
    fullStackMarketPrice: r.fullStackMarketPrice,
    frontOnlyCopy,
    fullStackCopy,
    items,
    deletedItemKeys,
  };
}

// ─── Server 計價（唔信 browser 金額）────────────────────────────────────────

export interface WebDesignPricedItem {
  itemKey: string;
  name: string;
  category: WebDesignCatalogItem["category"];
  /** 快照：呢項要求嘅最低方案；方案基本價行＝訂單方案本身 */
  plan: WebDesignPlan;
  billing: WebDesignCatalogItem["billing"];
  price: number;
  marketPrice: number;
  priceNote: string;
  sortOrder: number;
}

export type PriceOrderResult =
  | {
      ok: true;
      items: WebDesignPricedItem[];
      oneOffTotal: number;
      monthlyTotal: number;
      /** 今次應收＝一次性＋首月月費 */
      total: number;
    }
  | { ok: false; error: string };

/**
 * server 重新計價：方案基本價行（永遠第一行）＋揀咗嘅功能快照。
 * 擋：未知 key／已下架／唔揀得（at_cost 展示項）／方案依賴（front_only 揀 full_stack 功能）。
 * at_cost 項就算俾揀都唔計入金額（實報實銷）。
 */
export function priceOrder(
  catalog: WebDesignCatalog,
  plan: WebDesignPlan,
  itemKeys: string[],
): PriceOrderResult {
  if (!WEB_DESIGN_PLANS.includes(plan)) {
    return { ok: false, error: "方案唔啱" };
  }
  const basePrice = plan === "full_stack" ? catalog.fullStackPrice : catalog.frontOnlyPrice;
  const baseMarket = plan === "full_stack" ? catalog.fullStackMarketPrice : catalog.frontOnlyMarketPrice;
  const items: WebDesignPricedItem[] = [
    {
      itemKey: `plan_${plan}`,
      name: `網站設計服務（${planLabel(plan)}）`,
      category: "service",
      plan,
      billing: "one_off",
      price: basePrice,
      marketPrice: baseMarket,
      priceNote: "一次性｜方案基本價",
      sortOrder: 0,
    },
  ];
  let oneOffTotal = basePrice;
  let monthlyTotal = 0;
  const byKey = new Map(catalog.items.map((i) => [i.key, i]));
  const seen = new Set<string>();
  for (const rawKey of itemKeys) {
    const key = String(rawKey);
    if (seen.has(key)) continue; // 重複 key 當一次
    seen.add(key);
    // 舊六項 seo_* 已併入套票：就算傳入嘅 catalog 未正規化都唔准用舊 key 落新單
    if (LEGACY_SEO_KEY_SET.has(key)) {
      return { ok: false, error: `功能「${key}」已併入「SEO 技術優化套票」，請揀 seo_package` };
    }
    // 退役項（followup_reminders）：就算傳入嘅 catalog 未正規化都唔准落新單
    if (RETIRED_KEY_SET.has(key)) {
      return { ok: false, error: `功能「${key}」已退役，唔可以再加入訂單` };
    }
    // 指定報價項以 key 硬性拒絕：即使舊 JSON／管理員 payload 將 selectable 改成 true 都唔放行。
    if (QUOTE_ONLY_KEY_SET.has(key)) {
      return { ok: false, error: `功能「${key}」只供查詢報價，唔係自選項，唔可以加入訂單` };
    }
    const item = byKey.get(key);
    if (!item) return { ok: false, error: `功能「${key}」唔存在` };
    if (!item.active) return { ok: false, error: `功能「${item.name}」已下架` };
    if (!item.selectable) {
      return { ok: false, error: `功能「${item.name}」唔係自選項（${item.priceNote || "實報實銷"}）` };
    }
    // 方案依賴再擋（前端擋完 server 再擋）
    if (!planAllows(plan, item.requiredPlan)) {
      return { ok: false, error: `功能「${item.name}」需要「前台＋後台」方案` };
    }
    items.push({
      itemKey: item.key,
      name: item.name,
      category: item.category,
      plan: item.requiredPlan,
      billing: item.billing,
      price: item.price,
      marketPrice: item.marketPrice,
      priceNote: item.priceNote,
      sortOrder: item.sortOrder,
    });
    if (item.billing === "one_off") oneOffTotal += item.price;
    else if (item.billing === "monthly") monthlyTotal += item.price;
    // at_cost：實報實銷，唔計入今次金額
  }
  return { ok: true, items, oneOffTotal, monthlyTotal, total: oneOffTotal + monthlyTotal };
}

// ─── Airwallex 收款核對（純函數；webhook／return-verify 共用）─────────────────

export interface WebDesignPaidIntentInfo {
  /** intent id（int_xxx）；webhook data.object.id，可能缺 */
  id: string | null;
  /** intent merchant_order_id（＝我哋 orderNo） */
  merchantOrderId: string | null;
  /** intent 金額（major unit 港元）；缺／非數字 → null（未能核實） */
  amount: number | null;
  /** intent 幣種；預期 HKD */
  currency: string | null;
}

export type WebDesignPaymentCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 收款確認前嘅核對（code review 2026-11-09）：淨核 orderNo 唔夠——
 *   ① intent.id 必須非空（無條件；缺 id＝未能核實收款來源，唔准放行）；
 *   ② merchantOrderId 要同訂單號一致（防對錯單）；
 *   ③ 訂單有 stored intentId 嘅話，intent.id 必須完全一致（防有人攞第個 intent 嚟嘟）；
 *   ④ intent.amount 必須 === 訂單 total（少付／多付都唔准自動轉 paid）；
 *   ⑤ currency 必須係 HKD。
 * 任何一項唔符 → { ok:false, reason }，caller 唔准轉 paid（loud 記錄，等人手對數）。
 */
export function verifyWebDesignPaymentIntent(args: {
  orderNo: string;
  orderTotal: number;
  storedIntentId: string | null;
  intent: WebDesignPaidIntentInfo;
}): WebDesignPaymentCheck {
  const { intent } = args;
  if (!intent.id) {
    return { ok: false, reason: "intent 回應缺 id，未能核實收款來源" };
  }
  if (!intent.merchantOrderId || intent.merchantOrderId !== args.orderNo) {
    return { ok: false, reason: `merchant_order_id 唔啱（${intent.merchantOrderId ?? "缺"} ≠ ${args.orderNo}）` };
  }
  if (args.storedIntentId && intent.id !== args.storedIntentId) {
    return { ok: false, reason: `intent id 唔啱（${intent.id} ≠ 訂單記錄 ${args.storedIntentId}）` };
  }
  if (intent.amount === null || intent.amount !== args.orderTotal) {
    return { ok: false, reason: `金額唔啱（intent ${intent.amount ?? "缺"} ≠ 訂單 HK$${args.orderTotal}）` };
  }
  if (intent.currency !== "HKD") {
    return { ok: false, reason: `幣種唔啱（${intent.currency ?? "缺"} ≠ HKD）` };
  }
  return { ok: true };
}

/**
 * 網上收款可轉 paid 嘅來源狀態：pending（未付）｜review（客人傳咗截圖待核實，
 * 但其實佢同一個網上 intent 已成功——webhook 到嗰刻核對通過就應該轉 paid，唔准卡 review）。
 * rejected／paid／cancelled 唔准郁（rejected 要客人重傳或重新網上開單；paid 已完成；cancelled 終態）。
 */
export function canMarkWebDesignPaid(paymentStatus: string, orderStatus?: string): boolean {
  if (orderStatus === "cancelled") return false;
  return paymentStatus === "pending" || paymentStatus === "review";
}

/** pg unique violation（撞 orderNo）判定：只係佢先值得 retry，其他 DB 錯誤唔准當撞號重試 */
export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  if (code === "23505") return true;
  // drizzle/node-postgres 有時包多層
  const cause = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505") return true;
  const msg = e instanceof Error ? e.message : "";
  return msg.includes("duplicate key value violates unique constraint");
}

// ─── WMS callback 狀態 mapping（純函數，舊 handler 開頭 delegate 用）──────────

export type WdReviewAction = {
  status?: WebDesignOrderStatus;
  paymentStatus?: WebDesignPaymentStatus;
  auditAction: string;
  label: string;
};

/**
 * WMS review-callback → 網站設計單新狀態：
 *   approved                     → in_production＋paid（WMS 批＝付款確認＋開工）
 *   rejected + rejectType=reupload → payment rejected（等客人重傳截圖；訂單狀態留 received）
 *   rejected（cancel／舊格式）    → cancelled（終態）
 */
export function mapWmsReviewForWebDesign(
  decision: "approved" | "rejected",
  rejectType: "cancel" | "reupload",
): WdReviewAction {
  if (decision === "approved") {
    return { status: "in_production", paymentStatus: "paid", auditAction: "webDesign.wmsApprove", label: "批准（付款確認，開工製作）" };
  }
  if (rejectType === "reupload") {
    return { paymentStatus: "rejected", auditAction: "webDesign.wmsReupload", label: "要求重新上傳付款證明" };
  }
  return { status: "cancelled", auditAction: "webDesign.wmsCancel", label: "取消訂單" };
}

/**
 * WMS shipment-callback → 網站設計單新狀態（服務單：shipped＝網站交付完成）：
 *   shipped   → completed＋completedAt
 *   unshipped → in_production（交付撤回，返製作中）
 *   其他 action（item_* 等）唔適用 → null（caller 回 ignored）
 */
export function mapWmsShipmentForWebDesign(
  action: string,
): { status: WebDesignOrderStatus; setCompletedAt: boolean } | null {
  if (action === "shipped") return { status: "completed", setCompletedAt: true };
  if (action === "unshipped") return { status: "in_production", setCompletedAt: false };
  return null;
}

// ─── WMS forward payload 組裝 ──────────────────────────────────────────────

/** WMS 單項服務貨品名（契約：一項「網頁設計（前台／前台＋後台）」） */
export function wmsServiceItemName(plan: WebDesignPlan): string {
  return plan === "full_stack" ? "網頁設計（前台＋後台）" : "網頁設計（前台）";
}

/**
 * WMS remark：官方訂單號＋方案＋全部功能＋要求／風格＋月費（契約要求 remark 包含要求/風格/全部功能/月費）。
 * 服務單只用 URL、唔送 base64（paymentScreenshot 有 500k 字限制）——圖一律經 sourcePayload URL。
 */
export function buildWmsRemark(args: {
  orderNo: string;
  plan: WebDesignPlan;
  itemNames: string[];
  requirements: string;
  styleNotes: string;
  monthlyTotal: number;
  paymentNote?: string | null;
}): string {
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
  return [
    `官網網站設計訂單 ${args.orderNo}`,
    `方案：${planLabel(args.plan)}`,
    args.itemNames.length ? `功能：${args.itemNames.join("、")}` : null,
    args.requirements.trim() ? `要求：${clip(args.requirements.trim(), 300)}` : null,
    args.styleNotes.trim() ? `風格：${clip(args.styleNotes.trim(), 300)}` : null,
    args.monthlyTotal > 0 ? `月費：HK$${args.monthlyTotal}／月（首月已連同一次性收費）` : null,
    args.paymentNote ?? null,
  ]
    .filter(Boolean)
    .join("｜");
}
