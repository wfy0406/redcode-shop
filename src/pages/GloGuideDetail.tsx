/**
 * /glo-guide/:slug —— Glo Glo 指南詳情（editorial split-screen）。
 *
 * 資料：凍結合同 trpc.gloGuide.bySlug.useQuery({ slug })；非 published 由 server 回
 * NOT_FOUND，呢度顯示 404 態＋noindex（見 seo hook）。
 * 排版：左邊 sticky 2:3 配搭圖（每張標註對應商品），右邊正文欄（CJK 襯線大標、
 * 香港發文時間、hairline 分段、正文 ≥16px/1.7、Glo Glo 簽名署名），
 * 下面「文中單品」editorial 商品行（加車／去商品頁揀尺寸）。
 */

import { Link, useParams } from 'react-router';
import { trpc } from '@/providers/trpc';
import GuideProductCard from '@/components/glo-guide/GuideProductCard';
import GloSignature from '@/components/glo-guide/GloSignature';
import GloGuideRichText from '@/components/GloGuideRichText';
import { parseGloGuideRichText } from '@contracts/gloGuideRichText';
import { useGloGuideDetailSeo } from '@/components/glo-guide/seo';
import {
  formatGuideDateHK,
  guideDateTimeAttr,
  productForImage,
  sortGuideImages,
} from '@/components/glo-guide/guideUtils';

export default function GloGuideDetail() {
  const { slug = '' } = useParams();
  const query = trpc.gloGuide.bySlug.useQuery({ slug }, { staleTime: 300_000 });
  const notFound = query.isError && query.error.data?.code === 'NOT_FOUND';
  const detail = query.data ?? (notFound ? null : undefined);
  useGloGuideDetailSeo(detail);

  // 錯誤要排喺 loading 之前：非 NOT_FOUND 錯誤時 data 係 undefined，
  // 唔好誤落「永遠載入中」分支
  if (query.isError) {
    return (
      <main className="gg-page">
        <div className="gg-grain" aria-hidden="true" />
        <div className="gg-state" role={notFound ? undefined : 'alert'}>
          <p className="gg-state-title">
            {notFound ? '搵唔到呢篇指南' : '文章暫時載入唔到'}
          </p>
          <p>
            {notFound
              ? '呢篇指南可能未發布或已下架。'
              : '請檢查網絡後再試。'}
          </p>
          {!notFound && (
            <button type="button" className="gg-retry" onClick={() => void query.refetch()}>
              重新載入
            </button>
          )}
          <Link to="/glo-guide" className="gg-read-link">
            返回指南總覽
          </Link>
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="gg-page">
        <div className="gg-grain" aria-hidden="true" />
        <div className="gg-state" role="status" aria-label="文章載入中">
          <p>載入緊 Glo Glo 嘅文章…</p>
        </div>
      </main>
    );
  }

  const images = sortGuideImages(detail.images);
  const highlights = parseGloGuideRichText(detail.body).highlights;

  return (
    <main className="gg-page">
      <div className="gg-grain" aria-hidden="true" />
      <nav className="gg-breadcrumb" aria-label="麵包屑">
        <Link to="/">首頁</Link>
        <span aria-hidden="true">／</span>
        <Link to="/glo-guide">Glo Glo 指南</Link>
        <span aria-hidden="true">／</span>
        <span aria-current="page">{detail.title}</span>
      </nav>

      <div className="gg-detail">
        {/* 左：2:3 配搭圖（desktop sticky；手機由 CSS 排喺正文之後） */}
        <section className="gg-gallery" id="guide-gallery" aria-label="配搭圖">
          <p className="gg-disclosure">
            配搭圖只供配搭參考；商品外觀以商品頁原圖為準。
          </p>
          {images.map((img, i) => {
            const product = productForImage(img, detail.products);
            return (
              <figure key={img.id} className="gg-figure">
                <img
                  src={img.path}
                  alt={img.alt || (product ? `${product.name} 配搭圖` : detail.title)}
                  width={img.width}
                  height={img.height}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  fetchPriority={i === 0 ? 'high' : undefined}
                  decoding="async"
                  className="gg-figure-img"
                />
                {product && (
                  <figcaption className="gg-figure-cap">
                    配搭單品：<Link to={`/products/${product.id}`}>{product.name}</Link>
                  </figcaption>
                )}
              </figure>
            );
          })}
        </section>

        {/* 右：正文欄 */}
        <article className="gg-article">
          <p className="gg-eyebrow">{detail.theme}</p>
          <h1 className="gg-article-title">{detail.title}</h1>
          <p className="gg-date">
            香港時間{' '}
            <time dateTime={guideDateTimeAttr(detail.publishedAt) || undefined}>
              {formatGuideDateHK(detail.publishedAt)}
            </time>
          </p>
          <nav className="gg-article-nav" aria-label="呢篇指南內容">
            <a href="#guide-body">睇正文</a>
            <a href="#guide-gallery">睇配搭圖</a>
            {detail.products.length > 0 && <a href="#guide-products">睇文中單品</a>}
          </nav>
          {highlights.length > 0 && (
            <ul className="gg-highlight-list" aria-label="本篇重點標籤">
              {highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          )}
          <hr className="gg-hairline" />
          <GloGuideRichText body={detail.body} />
          <GloSignature />
        </article>
      </div>

      {detail.products.length > 0 && (
        <section className="gg-products" id="guide-products" aria-labelledby="gg-products-heading">
          <hr className="gg-hairline" />
          <h2 id="gg-products-heading" className="gg-products-title">
            文中單品
          </h2>
          <ol className="gg-products-list">
            {detail.products.map((product, i) => (
              <GuideProductCard key={product.id} product={product} index={i} />
            ))}
          </ol>
          <p className="gg-products-note">品名、價錢同庫存以商品頁為準。</p>
        </section>
      )}
    </main>
  );
}
