/**
 * /glo-guide —— Glo Glo 精選配搭指南總覽（editorial 雜誌風）。
 *
 * 資料：凍結合同 trpc.gloGuide.list.useQuery({ limit })，server 只回 published。
 * 排版：第一篇做非對稱 split-screen 頭版（文左相右、金色 hairline 錯位相框），
 * 其餘用 CSS multi-column masonry，唔係一式一樣嘅卡片牆。
 * LCP：頭版封面 eager＋fetchPriority=high；其餘全部 lazy。
 */

import { Link } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useGloGuideListSeo } from '@/components/glo-guide/seo';
import {
  formatGuideDateHK,
  guideDateTimeAttr,
  guidePath,
} from '@/components/glo-guide/guideUtils';
import type { GuideListItem } from '@/components/glo-guide/types';

const LIST_LIMIT = 24;

function FeaturedArticle({ item }: { item: GuideListItem }) {
  return (
    <article className="gg-featured">
      <div className="gg-featured-text">
        <p className="gg-eyebrow">{item.theme}</p>
        <h2 className="gg-featured-title">
          <Link to={guidePath(item.slug)}>{item.title}</Link>
        </h2>
        <p className="gg-featured-excerpt">{item.excerpt}</p>
        <p className="gg-date">
          <time dateTime={guideDateTimeAttr(item.publishedAt) || undefined}>
            {formatGuideDateHK(item.publishedAt)}
          </time>
          ・{item.products.length} 件文中單品
        </p>
        <Link to={guidePath(item.slug)} className="gg-read-link">
          閱讀全文
        </Link>
      </div>
      {item.coverImage && (
        <Link to={guidePath(item.slug)} className="gg-featured-frame" tabIndex={-1} aria-hidden="true">
          <img
            src={item.coverImage.path}
            alt=""
            width={item.coverImage.width}
            height={item.coverImage.height}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="gg-featured-img"
          />
        </Link>
      )}
    </article>
  );
}

function MasonryItem({ item }: { item: GuideListItem }) {
  return (
    <article className="gg-masonry-item">
      {item.coverImage && (
        <Link to={guidePath(item.slug)} className="gg-masonry-frame" tabIndex={-1} aria-hidden="true">
          <img
            src={item.coverImage.path}
            alt=""
            width={item.coverImage.width}
            height={item.coverImage.height}
            loading="lazy"
            decoding="async"
            className="gg-masonry-img"
          />
        </Link>
      )}
      <p className="gg-eyebrow">{item.theme}</p>
      <h3 className="gg-masonry-title">
        <Link to={guidePath(item.slug)}>{item.title}</Link>
      </h3>
      <p className="gg-masonry-excerpt">{item.excerpt}</p>
      <p className="gg-date">
        <time dateTime={guideDateTimeAttr(item.publishedAt) || undefined}>
          {formatGuideDateHK(item.publishedAt)}
        </time>
      </p>
    </article>
  );
}

export default function GloGuideList() {
  useGloGuideListSeo();
  const query = trpc.gloGuide.list.useQuery({ limit: LIST_LIMIT }, { staleTime: 300_000 });

  return (
    <main className="gg-page">
      <div className="gg-grain" aria-hidden="true" />
      <header className="gg-header">
        <p className="gg-eyebrow">RedCode Editorial</p>
        <h1 className="gg-page-title">Glo Glo 精選配搭指南</h1>
        <p className="gg-page-intro">
          Glo Glo 按香港天氣同生活場景揀選直播單品，每篇附主題配搭文同 AI 配搭效果圖；商品外觀以商品頁原圖為準。
        </p>
      </header>

      {query.isPending && (
        <div className="gg-state" role="status" aria-label="指南載入中">
          <p>Glo Glo 整理緊最新配搭…</p>
        </div>
      )}

      {query.isError && (
        <div className="gg-state" role="alert">
          <p>指南暫時載入唔到，請檢查網絡後再試。</p>
          <button type="button" className="gg-retry" onClick={() => void query.refetch()}>
            重新載入
          </button>
        </div>
      )}

      {query.isSuccess && query.data.items.length === 0 && (
        <div className="gg-state">
          <p className="gg-state-title">暫時未有已發布指南</p>
          <p>新文章完成生成同人工審核後會喺呢度刊登。不妨先去睇最新直播商品。</p>
          <Link to="/products" className="gg-read-link">
            去全部貨品
          </Link>
        </div>
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <>
          <FeaturedArticle item={query.data.items[0]} />
          {query.data.items.length > 1 && (
            <div className="gg-masonry">
              {query.data.items.slice(1).map((item) => (
                <MasonryItem key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
