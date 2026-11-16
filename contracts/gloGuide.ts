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
