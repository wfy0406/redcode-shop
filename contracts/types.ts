export * from "./errors";

/**
 * 商品分類（固定 8 類）—— 前後台共用
 * value 係 DB 儲存值（products.category varchar(32)），label 係界面顯示
 */
export const PRODUCT_CATEGORIES = [
  { value: "top", label: "上衣" },
  { value: "pants", label: "褲" },
  { value: "dress", label: "裙" },
  { value: "shoes", label: "鞋" },
  { value: "accessory", label: "飾物" },
  { value: "lifestyle", label: "生活用品" },
  { value: "skincare", label: "護膚品" },
  { value: "other", label: "其他" },
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]["value"];

export const PRODUCT_CATEGORY_VALUES = PRODUCT_CATEGORIES.map(
  (c) => c.value,
) as ProductCategory[];

const CATEGORY_LABEL_MAP = Object.fromEntries(
  PRODUCT_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<ProductCategory, string>;

/** 類別 value → 中文 label；未知值當「其他」 */
export function productCategoryLabel(value: string | null | undefined): string {
  return CATEGORY_LABEL_MAP[(value ?? "other") as ProductCategory] ?? "其他";
}

/** 商品 SEO 用到嘅公開事實；前後端共用，避免首口 HTML 同 React 載入後各寫一套描述。 */
export interface ProductSeoFacts {
  name: string;
  description?: string | null;
  sku?: string | null;
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  stock: number;
  /**
   * 已批准公開嘅 AI 重點標籤（caller 一定要過完批准閘先傳入：
   * server 用 publicAiTags(aiTags, aiTagsEnabled)，client DTO 已係批准後嘅 string[]）。
   * 未批准／壞資料一律當冇，絕對唔會喺度解 raw JSON。
   */
  aiTags?: readonly string[] | null;
  /** 直播場次事實（products 表真欄位）：liveDate＝YYYYMMDD，liveSession＝'1','2'… */
  liveDate?: string | null;
  liveSession?: string | null;
}

/** 描述入面嘅 HTML、控制碼同 emoji 剝走；meta／JSON-LD 只用純文字。 */
export function plainProductSeoText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateProductSeoText(value: string, limit = 120): string {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 120;
  if (value.length <= cap) return value;
  return cap === 1 ? "…" : `${value.slice(0, cap - 1)}…`;
}

/**
 * 真實售價：discountPrice 真係平過原價先算數；壞資料（折扣仲貴過原價）當冇折扣，
 * 同 api/lib/productPublicFacts.productEffectivePrice 同一口徑。
 */
export function productSeoEffectivePrice(product: Pick<ProductSeoFacts, "price" | "discountPrice">): number {
  return product.discountPrice != null && product.discountPrice < product.price
    ? product.discountPrice
    : product.price;
}

/** YYYYMMDD 且係真實日曆日期先出場次標籤（20230229／20261301 唔過；同 liveSeo.isValidLiveDate 一致） */
function isRealCalendarYmd(d: string): boolean {
  if (!/^\d{8}$/.test(d)) return false;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

/** 場次事實標籤：「2026年10月28日 第2場」／「2026年10月28日」；壞資料回 null（唔反射 raw input） */
export function productLiveSessionLabel(
  liveDate: string | null | undefined,
  liveSession: string | null | undefined,
): string | null {
  if (liveDate == null || !isRealCalendarYmd(liveDate)) return null;
  const date = `${liveDate.slice(0, 4)}年${Number(liveDate.slice(4, 6))}月${Number(liveDate.slice(6, 8))}日`;
  const session =
    liveSession != null && /^[1-9]\d{0,2}$/.test(liveSession) ? ` 第${liveSession}場` : "";
  return `${date}${session}`;
}

/**
 * 商品公開事實段（描述過短時用嚟補強；次序固定，方便前後端一致及測試）。
 * 全部係 products 表已核實欄位或已批准 AI 標籤：類別、貨號、實價、庫存、
 * 批准重點、場次——唔虛構材質、產地、評價或「必買」呢類宣稱。
 */
export function productSeoFactsSegments(product: ProductSeoFacts): string[] {
  const segments: string[] = [productCategoryLabel(product.category)];
  const sku = product.sku?.trim();
  if (sku) segments.push(`貨號 ${sku}`);
  segments.push(`HK$${productSeoEffectivePrice(product)}`);
  segments.push(product.stock > 0 ? `現貨 ${product.stock} 件` : "暫時缺貨");
  const tags = (product.aiTags ?? [])
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  if (tags.length > 0) segments.push(`重點：${tags.join("、")}`);
  const live = productLiveSessionLabel(product.liveDate, product.liveSession);
  if (live) segments.push(`直播場次 ${live}`);
  return segments;
}

/** 真描述短過呢個長度就用事實段補強（meta description 太短會被搜尋引擎當薄內容） */
export const PRODUCT_SEO_DESC_SHORT = 60;

/**
 * 有真描述就用真描述；過短就用真名、類別、貨號、售價、庫存、已批准重點標籤
 * 同直播場次補強；冇描述就靠同一份事實段兜底。唔虛構材質、尺碼、折扣或評價，
 * 亦唔再用每個商品都一樣嘅空泛句式。前後端共用：server 首口 meta／OG／JSON-LD
 * 同 React ProductDetail 載入後嘅 meta 一字唔差。
 */
export function productSeoDescription(product: ProductSeoFacts, limit = 120): string {
  const plain = plainProductSeoText(product.description);
  const segments = productSeoFactsSegments(product);
  if (plain) {
    // 真描述夠長 → 照舊保留已批准原文，唔畫蛇添足
    if (plain.length >= PRODUCT_SEO_DESC_SHORT) return truncateProductSeoText(plain, limit);
    // 過短 → 補真事實；描述本身冇商品名就先補名（搜尋結果先認到件貨）
    const head = product.name && !plain.includes(product.name) ? `${product.name}｜${plain}` : plain;
    let out = head;
    for (const segment of segments) {
      if (out.includes(segment)) continue;
      const next = `${out}｜${segment}`;
      if (next.length > limit) break;
      out = next;
    }
    return out;
  }
  const fallback = `${product.name}｜${segments.join("｜")}。RedCode 香港直播精選，商品頁可睇相片、尺寸同最新購買資料。`;
  return truncateProductSeoText(fallback, limit);
}

/** 商品名太短時（例如純貨號「067」），title 補真分類，唔會得個編號做搜尋標題。 */
export const PRODUCT_SEO_TITLE_SHORT = 30;

/**
 * 商品頁 title：server 首口（og.ts）同 React ProductDetail document.title 共用。
 * 名過短先加類別擴充；全部嚟自已核實欄位，唔加宣稱字眼。
 */
export function productSeoTitle(product: Pick<ProductSeoFacts, "name" | "category">): string {
  const base = `${product.name}｜RedCode Fashion Design`;
  if (base.length >= PRODUCT_SEO_TITLE_SHORT) return base;
  return `${product.name}｜${productCategoryLabel(product.category)}｜RedCode Fashion Design`;
}
