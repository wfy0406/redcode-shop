/**
 * ProductGuideLinks —— 商品詳情頁「呢件商品嘅精選配搭」（2026-11-19 v2.5.13）
 *
 * 資料全部嚟自 trpc gloGuide.byProduct（server 只回 published 指南嘅精簡 DTO，
 * 封面已過 toGuideImage 公開閘）。caller（ProductDetail）喺 error／loading／empty
 * 時唔 mount 呢個區，呢度再守多手：items 空 → 回 null，絕對唔出示範內容。
 *
 * 視覺：雜誌式橫排清單（01/02 編號＋真實已批准封面＋標題＋香港日期＋主題＋摘要＋
 * 明確「閱讀全文」直達 Link），沿用深色 space/pink/gold tokens（product-story.css
 * pd-guides 系列）；每張卡只係一個 <Link>，唔會有 nested <a>。
 * 圖片用 GuidePicture（純 <picture>，無 .gg-page 依賴），固定比例裁切，尺寸穩定。
 */
import { Link } from 'react-router';
import { ArrowUpRight } from 'lucide-react';
import type { GuideProductReference } from '@contracts/gloGuide';
import GuidePicture from '@/components/glo-guide/GuidePicture';
import { guideDateTimeAttr, guidePath } from '@/components/glo-guide/guideUtils';
import './product-story.css';

/** 香港發文日期「2026年11月15日」（唔帶時間）；無效輸入回原字串，唔好炸版。 */
export function formatGuideDateOnlyHK(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return iso;
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(time);
}

export default function ProductGuideLinks({ items }: { items: GuideProductReference[] }) {
  if (!items.length) return null;
  return (
    <section className="pd-guides" aria-labelledby="pd-guides-title">
      <p className="pd-guides-kicker">Glo Glo 精選配搭指南</p>
      <h2 id="pd-guides-title" className="pd-guides-title">
        呢件商品嘅精選配搭
      </h2>
      <ol className="pd-guides-list">
        {items.map((guide, index) => (
          <li key={guide.slug} className="pd-guides-item">
            <Link
              to={guidePath(guide.slug)}
              className={`pd-guides-card${guide.coverImage ? '' : ' pd-guides-card-no-cover'}`}
              aria-label={`閱讀指南：${guide.title}`}
            >
              <span className="pd-guides-num" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              {guide.coverImage && (
                <span className="pd-guides-thumb">
                  <GuidePicture
                    path={guide.coverImage.path}
                    alt={guide.coverImage.alt}
                    width={guide.coverImage.width}
                    height={guide.coverImage.height}
                    sizes="(min-width: 768px) 180px, 100vw"
                    className="pd-guides-img"
                  />
                </span>
              )}
              <span className="pd-guides-body">
                <span className="pd-guides-meta">
                  <time dateTime={guideDateTimeAttr(guide.publishedAt) || undefined}>
                    {formatGuideDateOnlyHK(guide.publishedAt)}
                  </time>
                  {guide.theme.trim() !== '' && (
                    <span className="pd-guides-theme">{guide.theme}</span>
                  )}
                </span>
                <span className="pd-guides-name">{guide.title}</span>
                {guide.excerpt.trim() !== '' && (
                  <span className="pd-guides-excerpt">{guide.excerpt}</span>
                )}
                <span className="pd-guides-cta">
                  閱讀全文
                  <ArrowUpRight size={14} aria-hidden="true" />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
