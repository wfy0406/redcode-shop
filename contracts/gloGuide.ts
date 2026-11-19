/**
 * Glo Glo 精選配搭指南——公開 DTO 合約（SPEC v1「公開官網」段凍結形狀）。
 *
 * server（api/gloGuidePublic.ts）同 client（/glo-guide 頁）共用呢份類型；
 * 日期一律 ISO string；圖片 path 只准站內 /uploads/glo-guide/ 持久路徑
 * （server DTO mapper 會過濾，短期 Fashn CDN URL 永遠唔會出現）。
 * modelImage 永遠 null——真實模特兒參考圖唔公開。
 */

export interface GuideProduct {
  id: number;
  name: string;
  image: string;
  photos: string[];
  price: number;
  discountPrice: number | null;
  category: string;
  stock: number;
  sizeEnabled: boolean;
  sizes: string[];
  aiTags: string[];
  isActive: boolean;
  liveDate: string | null;
  liveSession: string | null;
}

export interface GuideImage {
  id: number;
  /** 站內持久路徑 /uploads/glo-guide/<uuid>.<ext> */
  path: string;
  alt: string;
  width: number;
  height: number;
  position: number;
  productId: number | null;
}

export interface GuideListItem {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  theme: string;
  publishedAt: string;
  updatedAt: string;
  coverImage: GuideImage | null;
  /** 呢期全部公開配搭圖（position 升冪，已過公開 media 閘）；冇就空 array */
  images: GuideImage[];
  products: GuideProduct[];
}

export interface GuideDetail extends GuideListItem {
  body: string;
  /** 永遠 null：模特兒真實參考圖唔公開 */
  modelImage: null;
}

/**
 * 商品詳情頁「呢件商品嘅精選配搭」用嘅精簡公開 DTO：
 * ─ 只有反向導航需要嘅欄位；body、modelImage、status、reviewer 等內部欄永遠唔出現；
 * ─ 封面沿用 GuideImage（同公開 media 閘一致：completed＋approved＋未刪＋合法站內 path＋正尺寸）；
 * ─ 日期一律 ISO string；excerpt 由 body 即場截（同列表同一來源）。
 */
export interface GuideProductReference {
  slug: string;
  title: string;
  excerpt: string;
  theme: string;
  publishedAt: string;
  coverImage: GuideImage | null;
}

// ──────────────────────────── 公開圖片 derivative（R05）────────────────────────────
//
// 可撤回媒體嘅多尺寸 AVIF/WebP 方案（server 同 client 共用呢一份事實）：
// ─ derivative URL = 原閘道路徑＋query：`/uploads/glo-guide/<uuid>.png?w=<寬>&fmt=<avif|webp>`；
//   原圖路徑不變，DB 權限閘逐 request 照舊先行（未 published／未批一律 404＋no-store）。
// ─ 檔名 uuid 係內容版本：圖片重生＝新 uuid＝新 URL，唔使額外 cache-buster。
// ─ 寬度白名單收口，唔准任意 w 洗衍生運算；fmt 只准 avif/webp。
// ─ server 衍生檔落 UPLOADS_DIR/glo-guide/.deriv/（單層檔名閘唔會公開該目錄）。

export const GLO_GUIDE_DERIVATIVE_WIDTHS = [320, 480, 768, 1080, 1600] as const;
export type GloGuideDerivativeWidth = (typeof GLO_GUIDE_DERIVATIVE_WIDTHS)[number];
export const GLO_GUIDE_DERIVATIVE_FORMATS = ["avif", "webp"] as const;
export type GloGuideDerivativeFormat = (typeof GLO_GUIDE_DERIVATIVE_FORMATS)[number];

export interface GloGuideDerivativeSpec {
  width: GloGuideDerivativeWidth;
  format: GloGuideDerivativeFormat;
}

export function isGloGuideDerivativeFormat(value: string): value is GloGuideDerivativeFormat {
  return (GLO_GUIDE_DERIVATIVE_FORMATS as readonly string[]).includes(value);
}

/**
 * 解析 derivative query（純函數，server 閘用）：
 * ─ 冇 w 冇 fmt → undefined（出原圖，向後相容舊連結）；
 * ─ w 係白名單寬度＋fmt 係 avif/webp → spec；
 * ─ 其他任何組合（w 非白名單／缺 fmt／fmt 唔啱／w 唔係整數）→ null（caller 當 404，
 *   同「唔存在」唔區分，唔透漏邊個參數錯）。
 */
export function parseGloGuideDerivativeQuery(
  w: string | undefined,
  fmt: string | undefined,
): GloGuideDerivativeSpec | null | undefined {
  if (w === undefined && fmt === undefined) return undefined;
  if (w === undefined || fmt === undefined) return null;
  if (!/^\d{1,5}$/.test(w)) return null;
  const width = Number(w);
  if (!(GLO_GUIDE_DERIVATIVE_WIDTHS as readonly number[]).includes(width)) return null;
  if (!isGloGuideDerivativeFormat(fmt)) return null;
  return { width: width as GloGuideDerivativeWidth, format: fmt };
}

/** 單一尺寸 derivative URL（caller 只准傳白名單值；非白名單原樣返原 path，唔會砌出非法請求） */
export function gloGuideDerivativeUrl(
  path: string,
  width: number,
  format: GloGuideDerivativeFormat,
): string {
  if (!(GLO_GUIDE_DERIVATIVE_WIDTHS as readonly number[]).includes(width)) return path;
  return `${path}?w=${width}&fmt=${format}`;
}

/**
 * 按原圖實寬收口 srcset 寬度清單：
 * ─ 知原寬 → 全部細過原寬嘅白名單檔＋第一檔 ≥原寬（server withoutEnlargement 會輸出原寬，
 *   畀高 DPR 用到接近原圖質素）；原圖 ≤320 就只出 320。
 * ─ 唔知原寬 → 全部五檔（server 照樣 withoutEnlargement，唔會放大）。
 */
export function gloGuideDerivativeWidths(intrinsicWidth?: number): GloGuideDerivativeWidth[] {
  if (!intrinsicWidth || intrinsicWidth <= 0) return [...GLO_GUIDE_DERIVATIVE_WIDTHS];
  const smaller = GLO_GUIDE_DERIVATIVE_WIDTHS.filter((w) => w < intrinsicWidth);
  const cover = GLO_GUIDE_DERIVATIVE_WIDTHS.find((w) => w >= intrinsicWidth);
  const picked = cover !== undefined ? [...smaller, cover] : [...smaller];
  return picked.length > 0 ? picked : [GLO_GUIDE_DERIVATIVE_WIDTHS[0]];
}

/** srcset 字串：「URL 寬度w」逐檔空格分隔（順序由細到大） */
export function gloGuideDerivativeSrcSet(
  path: string,
  format: GloGuideDerivativeFormat,
  intrinsicWidth?: number,
  absolutize?: (path: string) => string,
): string {
  const toUrl = absolutize ?? ((p: string) => p);
  return gloGuideDerivativeWidths(intrinsicWidth)
    .map((w) => `${toUrl(gloGuideDerivativeUrl(path, w, format))} ${w}w`)
    .join(", ");
}

/** <img src> 兜底檔（舊瀏覽器／無 srcset）：中等尺寸 WebP，唔再係成 MB 嘅原 PNG。 */
export const GLO_GUIDE_DERIVATIVE_FALLBACK_WIDTH: GloGuideDerivativeWidth = 768;
