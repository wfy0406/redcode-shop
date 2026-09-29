/**
 * v2.1.0（VIP+免運，2026-09-29）：VIP 會員制度引擎 ＋ 免運／結帳報價共用邏輯。
 *
 * 業務規則（後台全部改得，存 siteSettings，見下面兩個 SETTING_KEY）：
 * ─ VIP：本年度（calendar year，香港時區 UTC+8）已付款訂單總額達門檻即升級——
 *    滿 silverThresholdCents（預設 $3000）→ 銀會員（全年 92 折，silverDiscountBps=9200）；
 *    滿 goldThresholdCents（預設 $5000）→ 金會員（全年 9 折，goldDiscountBps=9000 ＋
 *    全年免運，僅限順豐站及自提點，一件都免）。
 *    期限＝生效日起 durationMonths 個月（預設 12）；金蓋銀重新計期；期限內唔准降級；
 *    過期後按當年消費重新判定。每次訂單轉「已確認 approved」後重算（ordersRouter／wmsSync hook）。
 * ─ 免運判定順序（checkoutQuote／落單共用，唔准信前端金額）：
 *    ① region ≠ HK → 不包郵到付（MO「澳門單・不包郵・順豐到付」、OVERSEAS「國外單・不包郵」）
 *    ② method = HOME（送貨上門）→ 永遠到付「送貨上門・運費到付」
 *    ③ method ∈ goldVipFreeMethods 且 VIP 金 → 免運「VIP金會員全年免運」
 *    ④ method ∈ freeMethods 且小計 ≥ freeThresholdCents（預設 $350）→ 免運「消費滿$350・順豐站免運」
 *    ⑤ 其餘 → 順豐到付
 * ─ 折扣疊加次序：商品小計 → 先 VIP 折扣 → 再優惠碼（優惠碼以 VIP 折後價做基數計）。
 *
 * 金額單位注意：新 API（settings／VIP／報價）全部用整數仙（cents）、折扣率用 bps；
 * 但 orders.total／discountAmount 呢啲**舊欄係整數港元**（全鏈——email／WMS／報表都係），
 * 所以 VIP 折扣會四捨五入到「港元個位」先落單（vipDiscountCents 永遠係 100 嘅倍數），
 * 報價同落單用同一條數，唔會有差。
 */
import { z } from "zod";
import { and, eq, gte, lt, sql, notInArray } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { cartItems, orders, sfStations, siteSettings, users } from "@db/schema";
import { resolvePromoDiscount } from "./promoRouter";
import { sendVipUpgradeEmail } from "./email";

// ───────────────────────────── 地區／取貨方式正規化 ─────────────────────────────

/** 收件地區：'HK' 香港｜'MO' 澳門｜'OVERSEAS' 國外 */
export const REGION_VALUES = ["HK", "MO", "OVERSEAS"] as const;
export type Region = (typeof REGION_VALUES)[number];

/**
 * 取貨方式 DB 值沿用舊有（'address' 送貨上門｜'sf_station' 順豐站｜'sf_locker' 智能櫃）；
 * 技術契約嘅 'HOME'|'SF_STATION'|'SF_LOCKER' 會喺 API 邊界正規化落 DB 值，舊數據唔使遷移。
 */
export const DELIVERY_METHOD_VALUES = ["address", "sf_station", "sf_locker"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHOD_VALUES)[number];
/** 契約（大寫）叫法，免運規則（freeMethods 等）用呢套嚟對 */
export type ContractMethod = "HOME" | "SF_STATION" | "SF_LOCKER";

export const regionInputSchema = z
  .enum(["HK", "MO", "OVERSEAS", "hk", "mo", "overseas"])
  .optional();

export function normalizeRegion(input?: string | null): Region {
  const v = (input ?? "HK").toUpperCase();
  return v === "MO" ? "MO" : v === "OVERSEAS" ? "OVERSEAS" : "HK";
}

/** 接受契約大寫值＋舊有細楷值，統一返 DB 值 */
export const deliveryMethodInputSchema = z
  .enum(["HOME", "SF_STATION", "SF_LOCKER", "address", "sf_station", "sf_locker"])
  .optional();

export function normalizeDeliveryMethod(input?: string | null): DeliveryMethod {
  const v = (input ?? "address").toUpperCase();
  if (v === "SF_STATION") return "sf_station";
  if (v === "SF_LOCKER") return "sf_locker";
  return "address";
}

/** DB 值 → 契約大寫值（免運規則對照用） */
export function toContractMethod(method: DeliveryMethod): ContractMethod {
  if (method === "sf_station") return "SF_STATION";
  if (method === "sf_locker") return "SF_LOCKER";
  return "HOME";
}

// ───────────────────────────── 規則設定（siteSettings，有 cache） ─────────────────────────────

export const VIP_RULES_SETTING_KEY = "vip_rules";
export const SHIPPING_RULES_SETTING_KEY = "shipping_rules";

export interface VipRules {
  /** 銀會員年度消費門檻（仙）＝ $3000 */
  silverThresholdCents: number;
  /** 金會員年度消費門檻（仙）＝ $5000 */
  goldThresholdCents: number;
  /** 銀會員付款比率 bps：9200 ＝ 俾 92%（即 92 折） */
  silverDiscountBps: number;
  /** 金會員付款比率 bps：9000 ＝ 俾 90%（即 9 折） */
  goldDiscountBps: number;
  /** 會籍期限（月），由生效日起計 */
  durationMonths: number;
}

export interface ShippingRules {
  /** 免運門檻（仙）＝ $350 */
  freeThresholdCents: number;
  /** 滿額免運適用嘅取貨方式（契約大寫值） */
  freeMethods: ContractMethod[];
  /** VIP 金會員全年免運適用嘅取貨方式（一件都免） */
  goldVipFreeMethods: ContractMethod[];
}

export const DEFAULT_VIP_RULES: VipRules = {
  silverThresholdCents: 300000,
  goldThresholdCents: 500000,
  silverDiscountBps: 9200,
  goldDiscountBps: 9000,
  durationMonths: 12,
};

export const DEFAULT_SHIPPING_RULES: ShippingRules = {
  freeThresholdCents: 35000,
  freeMethods: ["SF_STATION"],
  goldVipFreeMethods: ["SF_STATION", "SF_LOCKER"],
};

const contractMethodSchema = z.enum(["HOME", "SF_STATION", "SF_LOCKER"]);

/** 後台 setVipRules 嘅輸入校验（全欄必填，整體替換） */
export const vipRulesSchema = z.object({
  silverThresholdCents: z.number().int().nonnegative(),
  goldThresholdCents: z.number().int().nonnegative(),
  silverDiscountBps: z.number().int().min(0).max(10000),
  goldDiscountBps: z.number().int().min(0).max(10000),
  durationMonths: z.number().int().min(1).max(120),
});

export const shippingRulesSchema = z.object({
  freeThresholdCents: z.number().int().nonnegative(),
  freeMethods: z.array(contractMethodSchema).max(3),
  goldVipFreeMethods: z.array(contractMethodSchema).max(3),
});

// 60 秒 cache（同 airwallex 設定嘅玩法一致）：讀多寫少，後台改完會即時 reset
const CACHE_TTL_MS = 60_000;
let vipRulesCache: { at: number; rules: VipRules } | null = null;
let shippingRulesCache: { at: number; rules: ShippingRules } | null = null;

export function resetVipRulesCache(): void {
  vipRulesCache = null;
}
export function resetShippingRulesCache(): void {
  shippingRulesCache = null;
}

async function readSettingJson(key: string): Promise<unknown | null> {
  const db = getDb();
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.key, key),
  });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

/** 讀 VIP 規則：DB 冇存／JSON 壞咗就回預設值；逐欄校验，壞欄用預設補 */
export async function getVipRules(): Promise<VipRules> {
  if (vipRulesCache && Date.now() - vipRulesCache.at < CACHE_TTL_MS) {
    return vipRulesCache.rules;
  }
  const raw = await readSettingJson(VIP_RULES_SETTING_KEY);
  const parsed = vipRulesSchema.partial().safeParse(raw ?? {});
  const rules: VipRules = { ...DEFAULT_VIP_RULES, ...(parsed.success ? parsed.data : {}) };
  vipRulesCache = { at: Date.now(), rules };
  return rules;
}

export async function getShippingRules(): Promise<ShippingRules> {
  if (shippingRulesCache && Date.now() - shippingRulesCache.at < CACHE_TTL_MS) {
    return shippingRulesCache.rules;
  }
  const raw = await readSettingJson(SHIPPING_RULES_SETTING_KEY);
  const parsed = shippingRulesSchema.partial().safeParse(raw ?? {});
  const rules: ShippingRules = {
    ...DEFAULT_SHIPPING_RULES,
    ...(parsed.success ? parsed.data : {}),
  };
  shippingRulesCache = { at: Date.now(), rules };
  return rules;
}

// ───────────────────────────── VIP 引擎 ─────────────────────────────

export type VipTier = "NONE" | "SILVER" | "GOLD";

/**
 * 香港時區（UTC+8）本年度嘅起訖（回傳 UTC Date，直接落 SQL 比較 createdAt）。
 * DB timestamp 冇時區，呢個項目全鏈當 UTC 存（見 wmsSync hktDate 嘅做法）。
 */
export function hktCalendarYearBounds(now: Date = new Date()): { start: Date; end: Date } {
  const hktNow = new Date(now.getTime() + 8 * 3600_000);
  const year = hktNow.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 0, 1) - 8 * 3600_000),
    end: new Date(Date.UTC(year + 1, 0, 1) - 8 * 3600_000),
  };
}

/**
 * 某會員本年度（calendar year，香港時區）已付款訂單總額（仙）。
 * 口徑：status ∈ approved／shipped／completed（已付款確認嘅單）；
 * **有退款結果嘅單唔計**（refundStatus ∈ refunded／manual——錢已經退返，唔應該計落年度消費；
 * pending／rejected／failed 嘅退款申請仲未完，照計）。
 * 注意 orders.total 係整數港元，呢度 ×100 轉仙。
 */
export async function yearSpendCents(userId: number): Promise<number> {
  const db = getDb();
  const { start, end } = hktCalendarYearBounds();
  const [{ cents }] = await db
    .select({
      cents: sql<number>`coalesce(sum(${orders.total}), 0)::int * 100`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        // 跟 purchaseStats 同款寫法（enum 欄用 sql in 最穩陣）
        sql`${orders.status} in ('approved', 'shipped', 'completed')`,
        notInArray(orders.refundStatus, ["refunded", "manual"]),
        gte(orders.createdAt, start),
        lt(orders.createdAt, end),
      ),
    );
  return cents;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setMonth(r.getMonth() + months);
  return r;
}

/** 會員而家「有效」嘅 VIP 級別（過期即當 NONE；唔會寫 DB，純讀時判定用） */
export function effectiveVipTier(user: {
  vipTier: string;
  vipExpiresAt: Date | null;
}): VipTier {
  const tier = user.vipTier === "GOLD" || user.vipTier === "SILVER" ? user.vipTier : "NONE";
  if (tier === "NONE") return "NONE";
  if (user.vipExpiresAt && user.vipExpiresAt.getTime() > Date.now()) return tier;
  return "NONE"; // 已過期：等下次 recomputeVipTier 按當年消費正式重判
}

/**
 * 按本年度已付款消費重算會員 VIP 級別（訂單轉 approved 後 hook 入嚟）。
 * 規則：
 * ─ 達金門檻 → GOLD；否則達銀 → SILVER；否則 NONE
 * ─ 升級（或金蓋銀）：vipEffectiveAt = 而家、vipExpiresAt = ＋durationMonths 個月（重新計期）
 * ─ 已經係同一級而且未過期：唔好重置期限（照原樣）
 * ─ 金 → 銀唔准降（期限內保留金）；期限內達唔到標都唔會降
 * ─ 過期後按當年消費重判（唔夠標就落返 NONE）
 * 回傳 { tier, changed } 畀 caller 寫日誌用。
 */
export async function recomputeVipTier(
  userId: number,
): Promise<{ tier: VipTier; changed: boolean }> {
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { tier: "NONE", changed: false };
  const rules = await getVipRules();
  const spend = await yearSpendCents(userId);
  const target: VipTier =
    spend >= rules.goldThresholdCents
      ? "GOLD"
      : spend >= rules.silverThresholdCents
        ? "SILVER"
        : "NONE";

  const now = new Date();
  const current: VipTier =
    user.vipTier === "GOLD" || user.vipTier === "SILVER" ? user.vipTier : "NONE";
  const stillValid = user.vipExpiresAt !== null && user.vipExpiresAt.getTime() > now.getTime();

  // 期限內唔准降級（金→銀／任何級→NONE 都唔郁）
  const rank = (t: VipTier) => (t === "GOLD" ? 2 : t === "SILVER" ? 1 : 0);
  if (stillValid && rank(target) <= rank(current)) {
    return { tier: current, changed: false };
  }

  const next: VipTier = stillValid ? (rank(target) > rank(current) ? target : current) : target;
  if (next === current && stillValid) {
    return { tier: current, changed: false };
  }
  if (next === "NONE") {
    // 過期又唔夠標：落返普通會員（生效／到期時間留底做紀錄）
    if (current === "NONE") return { tier: "NONE", changed: false };
    await db.update(users).set({ vipTier: "NONE" }).where(eq(users.id, userId));
    return { tier: "NONE", changed: true };
  }
  const expiresAt = addMonths(now, rules.durationMonths);
  await db
    .update(users)
    .set({
      vipTier: next,
      vipEffectiveAt: now,
      vipExpiresAt: expiresAt,
    })
    .where(eq(users.id, userId));
  // v2.1.1（Wave 2）：真・升級（級別 rank 升：NONE→SILVER/GOLD、SILVER→GOLD）先寄恭賀信；
  // 同級續期（過期後重判返同級）唔准再寄；降級唔寄。DB commit 完先 void 寄，寄信失敗唔影響級別。
  if (rank(next) > rank(current) && user.email) {
    void sendVipUpgradeEmail({
      to: user.email,
      name: user.name,
      tier: next,
      effectiveAt: now,
      expiresAt,
    }).then((r) => {
      if (!r.ok) console.error(`[vip] 晉升恭賀信寄唔出（會員 #${userId} → ${next}）：`, r.error);
    }).catch((e) => console.error("[vip] 晉升恭賀信寄送錯誤:", e));
  }
  return { tier: next, changed: true };
}

/** 訂單轉「已確認 approved」後背景重算 VIP（fire-and-forget，失敗淨係 log，唔阻主流程） */
export function recomputeVipTierInBackground(userId: number, orderNo: string): void {
  void recomputeVipTier(userId)
    .then((r) => {
      if (r.changed) {
        console.log(`[vip] 訂單 ${orderNo} 確認後，會員 #${userId} 級別重判 → ${r.tier}`);
      }
    })
    .catch((e) => console.error("[vip] recompute error:", e));
}

// ───────────────────────────── 結帳報價（checkoutQuote／落單共用） ─────────────────────────────

export interface CheckoutQuoteInput {
  region?: string | null;
  deliveryMethod?: string | null;
  stationId?: string | null;
  couponCode?: string | null;
}

export interface CheckoutQuote {
  // 契約欄位（全部整數仙）
  subtotalCents: number;
  vipDiscountCents: number;
  couponDiscountCents: number;
  totalCents: number;
  shippingFree: boolean;
  shippingLabel: "免運" | "順豐到付" | "不包郵・到付";
  remarks: string[];
  // 落單要用嘅內部欄位（正規化後）
  region: Region;
  deliveryMethod: DeliveryMethod; // DB 值（address/sf_station/sf_locker）
  stationId: string | null;
  stationName: string | null;
  vipTier: VipTier;
  /** 購物車小計（整數港元，落單／優惠碼用——舊欄位係港元） */
  subtotalDollars: number;
}

/**
 * 結帳報價核心：server 側由購物車重算（唔准信前端金額），checkoutQuote API 同 orders.create 共用。
 * 次序：小計（港元整數 ×100 轉仙）→ VIP 折扣（四捨五入到港元個位，見檔頭金額單位註解）→
 * 優惠碼（以 VIP 折後價做基數，同 resolvePromoDiscount 嘅港元口徑）→ 免運判定（順序見檔頭）。
 * 優惠碼無效會 throw BAD_REQUEST（同 promo.validate 一致）。
 */
export async function computeCheckoutQuote(
  userId: number,
  input: CheckoutQuoteInput,
): Promise<CheckoutQuote> {
  const db = getDb();
  const region = normalizeRegion(input.region);
  const method = normalizeDeliveryMethod(input.deliveryMethod);
  const contractMethod = toContractMethod(method);

  const cart = await db.query.cartItems.findMany({
    where: eq(cartItems.userId, userId),
    with: { product: true },
  });
  if (cart.length === 0) {
    throw new Error("CART_EMPTY"); // caller 轉做 TRPCError BAD_REQUEST「購物車係空嘅」
  }
  const subtotalDollars = cart.reduce(
    (sum, item) => sum + (item.product.discountPrice ?? item.product.price) * item.quantity,
    0,
  );
  const subtotalCents = subtotalDollars * 100;

  // 站點：揀咗自取先有；要存在＋active＋同地區匹配（名稱做快照，日後改名唔影響歷史單）
  let stationId: string | null = null;
  let stationName: string | null = null;
  if (method !== "address" && input.stationId?.trim()) {
    const station = await db.query.sfStations.findFirst({
      where: eq(sfStations.id, input.stationId.trim()),
    });
    if (!station || !station.active) {
      throw new Error("STATION_INVALID");
    }
    if (station.region !== region) {
      throw new Error("STATION_REGION_MISMATCH");
    }
    stationId = station.id;
    stationName = station.name;
  }

  // VIP 折扣：按而家有效級別（過期當 NONE）；折扣四捨五入到港元個位（訂單全鏈係整數港元）
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("USER_NOT_FOUND");
  const vipTier = effectiveVipTier(user);
  const vipRules = await getVipRules();
  const payBps =
    vipTier === "GOLD"
      ? vipRules.goldDiscountBps
      : vipTier === "SILVER"
        ? vipRules.silverDiscountBps
        : 10000;
  const rawVipDiscountCents = Math.round((subtotalCents * (10000 - payBps)) / 10000);
  const vipDiscountCents = Math.round(rawVipDiscountCents / 100) * 100;
  const vipDiscountDollars = vipDiscountCents / 100;

  // 優惠碼：以 VIP 折後價做基數（先 VIP 後優惠碼，疊加）；
  // 每人限用次數由 caller（落單）數好先可以保證同事務，報價呢度唔計每人限用（純預覽）
  let couponDiscountCents = 0;
  if (input.couponCode?.trim()) {
    const couponBaseDollars = subtotalDollars - vipDiscountDollars;
    const resolved = await resolvePromoDiscount(db, input.couponCode, couponBaseDollars);
    couponDiscountCents = Math.min(resolved.discountAmount, couponBaseDollars) * 100;
  }

  const totalCents = subtotalCents - vipDiscountCents - couponDiscountCents;

  // 免運判定（順序跟技術契約，唔准調亂）
  const shipping = await getShippingRules();
  let shippingFree = false;
  let shippingLabel: CheckoutQuote["shippingLabel"] = "順豐到付";
  const remarks: string[] = [];
  if (region !== "HK") {
    // ① 澳門／國外：不包郵（到付）
    shippingLabel = "不包郵・到付";
    remarks.push(region === "MO" ? "澳門單・不包郵・順豐到付" : "國外單・不包郵");
  } else if (contractMethod === "HOME") {
    // ② 送貨上門：永遠到付
    remarks.push("送貨上門・運費到付");
  } else if (vipTier === "GOLD" && shipping.goldVipFreeMethods.includes(contractMethod)) {
    // ③ VIP 金：全年免運（順豐站／自提點，一件都免）
    shippingFree = true;
    shippingLabel = "免運";
    remarks.push("VIP金會員全年免運（順豐站/自提點）");
  } else if (
    shipping.freeMethods.includes(contractMethod) &&
    subtotalCents >= shipping.freeThresholdCents
  ) {
    // ④ 滿額免運（按商品小計，未扣折扣）
    shippingFree = true;
    shippingLabel = "免運";
    const thresholdDollars = shipping.freeThresholdCents / 100;
    const methodLabel = contractMethod === "SF_STATION" ? "順豐站" : "智能櫃";
    remarks.push(`消費滿$${thresholdDollars}・${methodLabel}免運`);
  } else {
    // ⑤ 其餘：順豐到付
    remarks.push("順豐到付");
  }

  return {
    subtotalCents,
    vipDiscountCents,
    couponDiscountCents,
    totalCents,
    shippingFree,
    shippingLabel,
    remarks,
    region,
    deliveryMethod: method,
    stationId,
    stationName,
    vipTier,
    subtotalDollars,
  };
}
