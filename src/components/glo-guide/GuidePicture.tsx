/**
 * Glo Guide 配搭圖 <picture>（2026-11-19 R05）：
 * 多尺寸 AVIF＋WebP derivative（白名單寬度，URL 同 server 閘 query 契約由
 * @contracts/gloGuide 單一來源出）；<img src> 只放中檔 WebP 兜底，
 * 卡片／舞台／thumbnail 一律唔再直載成 MB 嘅原 PNG。
 *
 * 權限唔受影響：derivative 行同一條 /uploads/glo-guide/:file 閘，
 * 撤稿／未批一律 404（onError 由 caller 決定點收科）。
 */

import { gloGuideDerivativeSrcSet, gloGuideDerivativeUrl, GLO_GUIDE_DERIVATIVE_FALLBACK_WIDTH } from '@contracts/gloGuide';

export interface GuidePictureProps {
  /** 站內持久路徑 /uploads/glo-guide/<uuid>.<ext>（DTO 已閘） */
  path: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  /** LCP 候選／首張先 true（loading=eager）；其餘 lazy */
  eager?: boolean;
  /**
   * 只有全頁真正 LCP 候選先 true（fetchPriority=high）——同 eager 分開：
   * 列表頁頭版首張 slide 要 eager 但唔准搶 hero 嘅 high；詳情頁首張大圖先兩樣都要。
   */
  priority?: boolean;
  /** sizes 提示（唔填就 100vw——舞台全寬圖合理；thumbnail 要自行俾實寬） */
  sizes?: string;
}

export default function GuidePicture({
  path,
  alt,
  width,
  height,
  className,
  eager = false,
  priority = false,
  sizes,
}: GuidePictureProps) {
  return (
    <picture>
      <source
        type="image/avif"
        srcSet={gloGuideDerivativeSrcSet(path, 'avif', width)}
        sizes={sizes}
      />
      <source
        type="image/webp"
        srcSet={gloGuideDerivativeSrcSet(path, 'webp', width)}
        sizes={sizes}
      />
      <img
        src={gloGuideDerivativeUrl(path, GLO_GUIDE_DERIVATIVE_FALLBACK_WIDTH, 'webp')}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding="async"
        className={className}
      />
    </picture>
  );
}
