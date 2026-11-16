/**
 * Glo Glo 指南——公開 DTO mapper（純函數，唔掂 DB）。
 *
 * 公開 tRPC（gloGuidePublic.ts）同首口 SEO（gloGuideSeo.ts）共用同一份映射：
 * ─ 圖片 path 唔係 /uploads/glo-guide/ 持久路徑 → 成張剔走（Fashn CDN 短期 URL 絕對出唔到街）；
 * ─ modelImage 永遠 null（真實模特兒參考圖唔公開）；
 * ─ 日期一律 ISO string；excerpt 由 body 即場截（單一事實來源）。
 * ─ 商品 aiTags 已係 caller 過咗批准閘嘅 string[]（publicAiTags）。
 */
import type {
  GuideDetail,
  GuideImage,
  GuideListItem,
  GuideProduct,
} from "@contracts/gloGuide";
import { gloGuideExcerpt, isGloGuideImagePath } from "./gloGuideValidation";

/** DB products 行嘅最小欄位（mapper 需要嘅全部） */
export interface DtoProductRow {
  id: number;
  name: string;
  image: string;
  photos: string[] | null;
  price: number;
  discountPrice: number | null;
  category: string;
  stock: number;
  sizeEnabled: boolean;
  sizes: string | null;
  isActive: boolean;
  liveDate: string | null;
  liveSession: string | null;
  /** caller 已過批准閘嘅 tags（aiTagsEnabled=false → []） */
  aiTags: string[];
}

/** DB gloGuideImages 行嘅最小欄位 */
export interface DtoImageRow {
  id: number;
  productId: number | null;
  path: string | null;
  width: number | null;
  height: number | null;
  position: number;
  status: string;
  reviewStatus: string;
  deletedAt: Date | null;
}

/** DB gloGuideArticles 行嘅最小欄位 */
export interface DtoArticleRow {
  id: number;
  slug: string;
  title: string;
  body: string;
  theme: string;
  status: string;
  publishedAt: Date | null;
  updatedAt: Date;
}

export function toGuideProduct(p: DtoProductRow): GuideProduct {
  return {
    id: p.id,
    name: p.name,
    image: p.image,
    photos: p.photos && p.photos.length > 0 ? [...p.photos] : [p.image],
    price: p.price,
    discountPrice: p.discountPrice,
    category: p.category,
    stock: p.stock,
    sizeEnabled: p.sizeEnabled,
    sizes: (p.sizes ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    aiTags: [...p.aiTags],
    isActive: p.isActive,
    liveDate: p.liveDate,
    liveSession: p.liveSession,
  };
}

/**
 * 圖片 DTO：同公開 media 閘一致——只收未刪、completed、**reviewStatus=approved**、
 * path 合法（/uploads/glo-guide/ 單層檔名）、有實測正尺寸嘅行；
 * 其餘（包括任何 http(s):// CDN URL、未批圖）一律剔走，返 null。
 * alt 由 caller 俾商品名（對應商品描述），冇就用文章標題。
 */
export function toGuideImage(img: DtoImageRow, alt: string): GuideImage | null {
  if (img.deletedAt) return null;
  if (img.status !== "completed") return null;
  if (img.reviewStatus !== "approved") return null;
  if (!isGloGuideImagePath(img.path)) return null;
  if (!img.width || !img.height || img.width <= 0 || img.height <= 0) return null;
  return {
    id: img.id,
    path: img.path as string,
    alt,
    width: img.width,
    height: img.height,
    position: img.position,
    productId: img.productId,
  };
}

function iso(d: Date | null): string {
  return (d ?? new Date(0)).toISOString();
}

/** 列表 item：images＝全部合法圖（position 升冪）；coverImage＝position 最細嗰張（冇就 null） */
export function toGuideListItem(
  article: DtoArticleRow,
  productRows: readonly DtoProductRow[],
  imageRows: readonly { row: DtoImageRow; alt: string }[],
): GuideListItem {
  const images = imageRows
    .map(({ row, alt }) => toGuideImage(row, alt))
    .filter((x): x is GuideImage => x !== null)
    .sort((a, b) => a.position - b.position);
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    excerpt: gloGuideExcerpt(article.body),
    theme: article.theme,
    publishedAt: iso(article.publishedAt),
    updatedAt: article.updatedAt.toISOString(),
    coverImage: images[0] ?? null,
    images,
    products: productRows.map(toGuideProduct),
  };
}

/** 詳情：list item（已含全部合法圖 images）＋body；modelImage 永遠 null */
export function toGuideDetail(
  article: DtoArticleRow,
  productRows: readonly DtoProductRow[],
  imageRows: readonly { row: DtoImageRow; alt: string }[],
): GuideDetail {
  const item = toGuideListItem(article, productRows, imageRows);
  return { ...item, body: article.body, modelImage: null };
}
