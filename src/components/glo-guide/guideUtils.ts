/**
 * Glo Glo 指南純邏輯（無 DOM / 無 React / 無 tRPC 依賴，node 環境可直接測）。
 *
 * 涵蓋：香港發文時間格式、價錢、加車尺寸邊界（鐵律：sizeEnabled＋多尺寸
 * 一定要導去商品頁揀尺寸，唔准偷偷塞預設尺寸）、正文分段、圖片排序、
 * 圖片 ↔ 商品對應（caption 用返真商品名）。
 */

import { productCategoryLabel } from '@contracts/types';
import { formatLiveDateLabel } from '@/lib/liveShare';
import type { GuideImage, GuideListItem, GuideProduct } from './types';

/** 文章公開網址段 */
export function guidePath(slug: string): string {
  return `/glo-guide/${slug}`;
}

/** 商品詳情頁網址（站內真連結，無 JS 都 work） */
export function guideProductPath(productId: number): string {
  return `/products/${productId}`;
}

/**
 * ISO 時間 → 香港發文時間「2026年11月15日 00:30」。
 * hourCycle h23：子夜顯示 00:xx（zh-HK 預設 h24 會出「24:xx」，客人會睇唔明）。
 * 無效輸入回原字串，唔好炸咗成版。
 */
export function formatGuideDateHK(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return iso;
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(time);
}

/** `<time dateTime>` 用嘅機讀值：原 ISO 無效就回空字串（唔出 dateTime 屬性）。 */
export function guideDateTimeAttr(iso: string): string {
  return Number.isFinite(new Date(iso).getTime()) ? iso : '';
}

/** 現價：有平過原價嘅折扣價先用折扣價，否則原價（同 ProductCard 邏輯一致） */
export function guideEffectivePrice(product: Pick<GuideProduct, 'price' | 'discountPrice'>): number {
  return product.discountPrice != null && product.discountPrice < product.price
    ? product.discountPrice
    : product.price;
}

export function guideHasDiscount(product: Pick<GuideProduct, 'price' | 'discountPrice'>): boolean {
  return product.discountPrice != null && product.discountPrice < product.price;
}

/**
 * 加車行為（SPEC 鐵律，主線審核收緊版）：
 * - sizeEnabled ＋有效尺寸唔係啱啱好一個（0 個或多個）→ 唔加車，導去商品頁
 *   由客人自己揀（冇尺寸資料都唔准假設「唔使尺寸」）；
 * - sizeEnabled ＋啱啱好一個尺寸 → 嗰個係唯一合法選項，直接帶埋佢加車；
 * - 冇開尺寸（sizeEnabled=false）→ size null 加車。
 */
export type GuideCartAction =
  | { kind: 'navigate'; to: string }
  | { kind: 'add'; size: string | null };

export function resolveGuideCartAction(
  product: Pick<GuideProduct, 'id' | 'sizeEnabled' | 'sizes'>,
): GuideCartAction {
  if (product.sizeEnabled) {
    const sizes = Array.isArray(product.sizes) ? product.sizes.filter((s) => s.trim() !== '') : [];
    if (sizes.length === 1) return { kind: 'add', size: sizes[0] };
    return { kind: 'navigate', to: guideProductPath(product.id) };
  }
  return { kind: 'add', size: null };
}

/** 正文 → 段落（後端以換行分段；連續空白行合併，去首尾空白） */
export function splitGuideBody(body: string): string[] {
  return body
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 相集按 position 升冪（唔相信 server 回嘅順序，自己排一次） */
export function sortGuideImages(images: readonly GuideImage[]): GuideImage[] {
  return [...images].sort((a, b) => a.position - b.position);
}

/** 搵出某張相對應嘅商品（「配搭單品」標註用）；productId null 或搵唔到都回 null */
export function productForImage(
  image: Pick<GuideImage, 'productId'>,
  products: readonly GuideProduct[],
): GuideProduct | null {
  if (image.productId === null) return null;
  return products.find((p) => p.id === image.productId) ?? null;
}

/** 商品類別中文 label（重用 contracts 單一來源） */
export function guideCategoryLabel(category: string): string {
  return productCategoryLabel(category);
}

/** 直播日期 label「2026年9月12日」（liveDate 係 YYYYMMDD；無效回 null 唔顯示） */
export function guideLiveDateLabel(liveDate: string | null): string | null {
  if (!liveDate || !/^\d{8}$/.test(liveDate)) return null;
  return formatLiveDateLabel(liveDate);
}

/** 重點標籤：最多 3 個、去空白、去重複（後端只會出已批准標籤，呢度淨係防衛式修剪） */
export function guideHighlightTags(aiTags: readonly string[], max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aiTags) {
    const tag = raw.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** 列表 meta description：有真 excerpt 用 excerpt，否則用主題組句（唔虛構內容、唔扮真人撰文） */
export function guideDescription(item: Pick<GuideListItem, 'excerpt' | 'theme' | 'title'>): string {
  const excerpt = item.excerpt.trim();
  if (excerpt !== '') return excerpt;
  const theme = item.theme.trim();
  return theme !== ''
    ? `Glo Glo 精選配搭指南「${item.title}」——${theme}主題直播單品配搭，附 AI 配搭效果圖。`
    : `Glo Glo 精選配搭指南「${item.title}」——直播單品配搭，附 AI 配搭效果圖。`;
}
