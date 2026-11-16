/**
 * /glo-guide/:slug —— Glo Glo 指南詳情（潮牌雜誌風 v3，SPEC 凍結口徑）。
 *
 * 資料：凍結合同 trpc.gloGuide.bySlug.useQuery({ slug })；非 published 由 server 回
 * NOT_FOUND，呢度顯示 404 態＋noindex（見 seo hook）。
 *
 * 期刊式結構：麵包屑 → 非對稱 editorial lead（左：主題＋大標＋內容捷徑；
 * 右：期刊 metadata——香港發文時間、Glo Glo 撰寫、單品數、重點標籤）→
 * 全寬主配搭圖舞台（真圖片 selector：切換配搭圖即時同步對應單品資訊，
 * aria-live 讀得出）→ 正文（CJK 襯線大標、≥16px/1.7、Glo Glo 簽名署名）→
 * 「文中單品」editorial 商品行（加車／去商品頁揀尺寸）。
 * 色板／字體跟 SPEC（#151515・#fef1e8・#988575・#d69900；Marcellus＋
 * Noto Serif TC／PingFang HK，中文唔 italic）；樣式喺 src/index.css gg- 區，
 * 配色全部 scope 落 .gg-page，後台預覽嘅 .ggp-preview 自成一套唔受影響。
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Link2, Share2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { formatPrice } from '@/data/products';
import GuideProductCard from '@/components/glo-guide/GuideProductCard';
import GuideImageGallery from '@/components/glo-guide/GuideImageGallery';
import GloSignature from '@/components/glo-guide/GloSignature';
import GloGuideRichText from '@/components/GloGuideRichText';
import { parseGloGuideRichText } from '@contracts/gloGuideRichText';
import { useGloGuideDetailSeo } from '@/components/glo-guide/seo';
import {
  formatGuideDateHK,
  guideCategoryLabel,
  guideDateTimeAttr,
  guideEffectivePrice,
  guideHasDiscount,
  guidePath,
  guideProductPath,
  productForImage,
  sortGuideImages,
} from '@/components/glo-guide/guideUtils';
import type { GuideImage, GuideProduct } from '@/components/glo-guide/types';

/**
 * 全寬主配搭圖舞台：大圖 gallery（上一張／下一張制＋滑動＋箭咀鍵）＋
 * 同步單品欄＋thumbnail selector。
 * 切換配搭圖（nav 制／thumbnail click・hover・focus／Arrow 鍵／swipe）
 * 即時同步「呢張配搭圖嘅單品」資訊——動態有真資訊用途（圖 ↔ 商品關係），
 * 唔係裝飾。首張 eager＋fetchPriority=high（LCP）；其餘 slides 同
 * thumbnails 全部 lazy；所有圖喺 SSR 已可見。主圖原比例完整顯示唔裁切
 * （.gg-stage-img：width:100%＋height:auto＋object-fit:contain）。
 */
function PairingStage({
  images,
  products,
  title,
}: {
  images: GuideImage[];
  products: GuideProduct[];
  title: string;
}) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, images.length - 1);
  const img = images[index];
  const product = productForImage(img, products);

  const onIndexKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
    const current = buttons.indexOf(e.target as HTMLButtonElement);
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % buttons.length;
    if (e.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = buttons.length - 1;
    buttons[next].focus(); // onFocus 會同步切換大圖同單品欄
  };

  return (
    <section className="gg-stage" id="guide-gallery" aria-label="配搭圖">
      <p className="gg-disclosure">
        配搭圖只供配搭參考；商品外觀以商品頁原圖為準。
      </p>

      <figure className="gg-stage-figure">
        <GuideImageGallery
          images={images}
          active={index}
          onActiveChange={setActive}
          ariaLabel={`${title} 配搭圖`}
          showStatus={false}
          renderSlide={(image, i) => {
            const slideProduct = productForImage(image, products);
            return (
              <img
                src={image.path}
                alt={image.alt || (slideProduct ? `${slideProduct.name} 配搭圖` : title)}
                width={image.width}
                height={image.height}
                loading={i === 0 ? 'eager' : 'lazy'}
                fetchPriority={i === 0 ? 'high' : undefined}
                decoding="async"
                className="gg-stage-img"
              />
            );
          }}
        />
        <figcaption className="gg-figure-cap" aria-live="polite">
          第 {index + 1} 張，共 {images.length} 張
          {product ? `｜配搭單品：${product.name}` : ''}
        </figcaption>
      </figure>

      {/* 同步單品欄：揀邊張圖，就講邊件單品（螢幕閱讀器經 aria-live 收到） */}
      <div className="gg-stage-panel" aria-live="polite">
        {product ? (
          <>
            <p className="gg-eyebrow gg-stage-panel-eyebrow">呢張配搭圖嘅單品</p>
            <p className="gg-stage-product-name">
              <Link to={guideProductPath(product.id)}>{product.name}</Link>
            </p>
            <p className="gg-stage-product-meta">
              {guideCategoryLabel(product.category)}
              <span aria-hidden="true">｜</span>
              <strong>{formatPrice(guideEffectivePrice(product))}</strong>
              {guideHasDiscount(product) && <s>{formatPrice(product.price)}</s>}
            </p>
            <Link to={guideProductPath(product.id)} className="gg-stage-product-link">
              去商品頁睇原圖<span aria-hidden="true">　→</span>
            </Link>
          </>
        ) : (
          <p className="gg-stage-product-note">
            呢張配搭圖示範整體造型方向；想睇單品原圖、尺碼同價錢，可以去下面「文中單品」。
          </p>
        )}
      </div>

      {images.length > 1 && (
        <ol className="gg-stage-index" aria-label="切換配搭圖" onKeyDown={onIndexKeyDown}>
          {images.map((it, i) => {
            const p = productForImage(it, products);
            return (
              <li key={it.id} className="gg-stage-index-item">
                <button
                  type="button"
                  className={
                    i === index ? 'gg-stage-thumb is-active' : 'gg-stage-thumb'
                  }
                  aria-pressed={i === index}
                  aria-label={`顯示第 ${i + 1} 張配搭圖${p ? `：${p.name}` : ''}`}
                  onClick={() => setActive(i)}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                >
                  <img
                    src={it.path}
                    alt=""
                    width={it.width}
                    height={it.height}
                    loading="lazy"
                    decoding="async"
                    className="gg-stage-thumb-img"
                  />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** 成功訊息自動消退時間（SPEC：2–3 秒）；失敗訊息唔自動收，等客人睇到 */
const SHARE_FEEDBACK_DISMISS_MS = 2500;

type ShareFeedback = { kind: 'success' | 'error'; message: string } | null;

/**
 * Lead 分享列：「分享」＋「複製網址」兩個真按鈕。
 *
 * - 分享用正式網址 window.location.origin + guidePath(slug)；navigator.share
 *   可用時淨傳 { url }（唔附 title／text）。用戶自己取消（AbortError）靜默；
 *   其他失敗明確回報並建議改用「複製網址」——唔准假成功。瀏覽器冇
 *   navigator.share 就直接行同一個真複製流程，唔會出死按鈕。
 * - 複製優先 navigator.clipboard.writeText；失敗用隱藏 textarea +
 *   execCommand 真 fallback；再失敗顯示完整網址 readOnly input（可全選，
 *   手機撳住即複製），無 dead control。
 * - 回饋：成功 role=status（2.5 秒自動消退，unmount cleanup timer），
 *   失敗 role=alert 常駐。
 * - 所有瀏覽器 API 只喺事件 handler 觸碰，SSR（renderToString）零 window。
 */
function GuideShareActions({ slug }: { slug: string }) {
  const [feedback, setFeedback] = useState<ShareFeedback>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // unmount 清走未響嘅消退 timer，避免 setState on unmounted component
  useEffect(
    () => () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    },
    [],
  );

  const showFeedback = (next: NonNullable<ShareFeedback>, autoDismiss: boolean) => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    setFeedback(next);
    if (autoDismiss) {
      dismissTimer.current = setTimeout(() => {
        dismissTimer.current = null;
        setFeedback(null);
      }, SHARE_FEEDBACK_DISMISS_MS);
    }
  };

  const guideUrl = () => `${window.location.origin}${guidePath(slug)}`;

  /** 舊瀏覽器／非 secure context 嘅真 fallback；如實回傳成功與否 */
  const execCommandCopy = (url: string): boolean => {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    // 唔移出畫面（iOS Safari 會拒絕 select 畫面外元素），只釘角落＋透明
    ta.style.position = 'fixed';
    ta.style.left = '0';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, url.length); // iOS Safari 需要
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  };

  const onCopy = async () => {
    const url = guideUrl();
    try {
      await navigator.clipboard.writeText(url);
      setManualUrl(null);
      showFeedback({ kind: 'success', message: '已複製文章網址，可以貼俾朋友。' }, true);
      return;
    } catch {
      // clipboard API 唔可用／被擋：落真 fallback
    }
    if (execCommandCopy(url)) {
      setManualUrl(null);
      showFeedback({ kind: 'success', message: '已複製文章網址，可以貼俾朋友。' }, true);
      return;
    }
    // 兩條路都唔通：攞出完整網址俾人手複製（手機撳住全選即可）
    setManualUrl(url);
    showFeedback(
      { kind: 'error', message: '複製唔成功，請撳住下面網址手動複製。' },
      false,
    );
  };

  const onShare = async () => {
    const url = guideUrl();
    if (typeof navigator.share !== 'function') {
      // 桌面／舊瀏覽器冇系統分享 sheet：撳「分享」即轉真複製，唔出死按鈕。
      await onCopy();
      return;
    }
    try {
      await navigator.share({ url });
      setManualUrl(null);
      showFeedback({ kind: 'success', message: '已分享呢篇指南。' }, true);
    } catch (err) {
      // 用戶自己取消分享 sheet：靜默，唔當失敗
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      showFeedback(
        { kind: 'error', message: '分享失敗，可以改用「複製網址」send 俾朋友。' },
        false,
      );
    }
  };

  return (
    <div className="gg-share">
      <div className="gg-share-actions">
        <button type="button" className="gg-share-btn" onClick={() => void onShare()}>
          <Share2 size={18} aria-hidden="true" />
          分享
        </button>
        <button type="button" className="gg-share-btn" onClick={() => void onCopy()}>
          <Link2 size={18} aria-hidden="true" />
          複製網址
        </button>
      </div>
      {feedback && (
        <p
          className={`gg-share-feedback gg-share-feedback--${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
      {manualUrl && (
        <label className="gg-share-manual">
          <span>文章網址（撳住全選複製）：</span>
          <input
            type="text"
            className="gg-share-manual-input"
            readOnly
            value={manualUrl}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}

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
      <main className="gg-page gg-page--status">
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
      <main className="gg-page gg-page--status">
        <div className="gg-state" role="status" aria-label="文章載入中">
          <p>載入緊 Glo Glo 嘅文章…</p>
        </div>
      </main>
    );
  }

  const images = sortGuideImages(detail.images);
  const highlights = parseGloGuideRichText(detail.body).highlights;
  const articlePath = guidePath(detail.slug);

  /**
   * 內容捷徑：root index.html 有 <base href="/">，純 href="#id" 會解去首頁
   * 而唔係呢篇文。所以 href 用足「文章路徑＋hash」（無 JS／新分頁開都係
   * 同一篇文嘅錨）；有 JS 就 preventDefault＋scrollIntoView，唔郁 pathname。
   * 動效跟 prefers-reduced-motion：reduce → 即跳（auto），否則平滑捲動。
   * 目標元素唔存在就交返俾原生錨行為（href 本身合法）。
   */
  const onArticleNavClick = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <main className="gg-page">
      {/* 站內已載入 Noto Serif TC / Noto Sans TC，淨補 Marcellus（拉丁 display 用） */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Marcellus&display=swap"
      />
      <nav className="gg-breadcrumb" aria-label="麵包屑">
        <Link to="/">首頁</Link>
        <span aria-hidden="true">／</span>
        <Link to="/glo-guide">Glo Glo 精選指南</Link>
        <span aria-hidden="true">／</span>
        <span aria-current="page">{detail.title}</span>
      </nav>

      {/* 非對稱 editorial lead：左大標（7 格）／右期刊 metadata（5 格） */}
      <header className="gg-lead">
        <div className="gg-lead-main">
          <p className="gg-eyebrow">{detail.theme}</p>
          <h1 className="gg-article-title">{detail.title}</h1>
          <nav className="gg-article-nav" aria-label="呢篇指南內容">
            <a href={`${articlePath}#guide-body`} onClick={onArticleNavClick('guide-body')}>
              睇正文
            </a>
            {images.length > 0 && (
              <a
                href={`${articlePath}#guide-gallery`}
                onClick={onArticleNavClick('guide-gallery')}
              >
                睇配搭圖
              </a>
            )}
            {detail.products.length > 0 && (
              <a
                href={`${articlePath}#guide-products`}
                onClick={onArticleNavClick('guide-products')}
              >
                睇文中單品
              </a>
            )}
          </nav>
          <GuideShareActions slug={detail.slug} />
        </div>
        <aside className="gg-lead-meta" aria-label="出版資料">
          <p className="gg-lead-meta-kicker">Glo Glo 精選指南</p>
          <p className="gg-date">
            香港時間{' '}
            <time dateTime={guideDateTimeAttr(detail.publishedAt) || undefined}>
              {formatGuideDateHK(detail.publishedAt)}
            </time>
          </p>
          <p className="gg-lead-meta-line">Glo Glo 撰寫</p>
          <p className="gg-lead-meta-line">{`${detail.products.length} 件文中單品`}</p>
          {highlights.length > 0 && (
            <ul className="gg-highlight-list" aria-label="本篇重點標籤">
              {highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          )}
        </aside>
      </header>

      {/* 全寬主配搭圖（真 selector，切換同步單品資訊） */}
      {images.length > 0 && (
        <PairingStage images={images} products={detail.products} title={detail.title} />
      )}

      {/* 正文欄 */}
      <article className="gg-article">
        <GloGuideRichText body={detail.body} />
        <GloSignature />
      </article>

      {detail.products.length > 0 && (
        <section className="gg-products" id="guide-products" aria-labelledby="gg-products-heading">
          <hr className="gg-hairline" />
          <h2 id="gg-products-heading" className="gg-products-title">
            文中單品
          </h2>
          <ol className="gg-products-list">
            {detail.products.map((product, i) => (
              <GuideProductCard key={product.id} product={product} index={i} guideSlug={detail.slug} />
            ))}
          </ol>
          <p className="gg-products-note">品名、價錢同庫存以商品頁為準。</p>
        </section>
      )}
    </main>
  );
}
